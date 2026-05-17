/**
 * Trade Orchestrator
 *
 * Single responsibility: take a `trade.signal` from signal-generator,
 * figure out which accounts it should go to, gate it, and emit one
 * `order.request` per account that passes the gate chain.
 *
 * NOT the orchestrator's job:
 *   - Order state, bracket correlation, structural stops  (broker service)
 *   - Fill detection, reconciliation with the broker       (broker service)
 *   - Breakeven / trailing stop mechanics                  (broker service)
 *   - Market data evaluation                               (signal-generator)
 *   - Account credentials or connector lifecycle           (broker service)
 *
 * See ARCHITECTURE.md for the full contract.
 */

import express from 'express';
import cors from 'cors';
import {
  messageBus,
  CHANNELS,
  createLogger,
  healthCheck
} from '../shared/index.js';
import { createAccountStore, ACCOUNT_CHANNEL } from '../shared/utils/account-store.js';
import { createRoutesStore, ROUTES_CHANNEL } from '../shared/utils/routes-store.js';
import { evaluateCrossStrategyRules, evaluateStrategyAlerts } from './cross-strategy-filter.js';
import { createExitRuleManager, captureRuleFromSignal } from './src/exit-rule-manager.js';

const SERVICE_NAME = 'trade-orchestrator';
const logger = createLogger(SERVICE_NAME);

// Redis keys owned by this service
const KILL_SWITCH_KEY = 'trading:kill_switch';
const OPEN_POSITIONS_KEY = 'orchestrator:open_positions';
const CONTRACTS_MAPPINGS_KEY = 'contracts:mappings';
const SIGNAL_DEDUP_PREFIX = 'signal:dedup:';
const SIGNAL_DEDUP_TTL_SEC = 60;

const PORT = Number(process.env.PORT || process.env.TRADE_ORCHESTRATOR_PORT || 3013);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const POSITION_SIZING_KEY = 'config:position-sizing';
const TB_RULES_KEY = 'config:tb-rules';

// EOD force-flat: close all open positions at this ET wall-clock time on
// weekdays. Default 16:40 ET — 5 min cushion before the broker's 16:45 ET
// auto-liquidation, so our market-close fills land before they yank the rug.
// Set EOD_CUTOFF_ET="" (empty) to disable.
const EOD_CUTOFF_ET = process.env.EOD_CUTOFF_ET ?? '16:40';
const EOD_FIRED_DATES = new Set();

// ---------- State ----------

const state = {
  tradingEnabled: true,
  contractMappings: {},
  positionSizing: { method: 'fixed', fixedQuantity: 1, contractType: 'micro', maxContracts: 5 },
  tbRules: {},

  // Map<posKey, { accountId, strategy, symbol, side, netPos, entryPrice, signalId, openedAt }>
  openPositions: new Map(),

  // Map<pendingKey, { accountId, strategy, symbol, direction, signalId, requestedAt }>
  pendingOrders: new Map(),

  // Cached view of account-store — refreshed on account.changed
  accountsById: new Map()
};

const stores = { routes: null, accounts: null, redis: null };

function posKey(accountId, strategy, symbol) { return `${accountId}|${strategy}|${symbol}`; }
function pendingKey(accountId, strategy, symbol) { return `${accountId}|${strategy}|${symbol}`; }

// ---------- Helpers ----------

const FUTURES_ROOT_REGEX = /^([A-Z]{1,4})[FGHJKMNQUVXZ]\d{1,2}$/;

function extractUnderlying(symbol) {
  if (!symbol) return null;
  const upper = String(symbol).toUpperCase();
  const m = upper.match(FUTURES_ROOT_REGEX);
  if (!m) return upper;
  const root = m[1];
  // Collapse micros to parent for cross-strategy comparisons
  if (root.startsWith('M') && root.length > 1) {
    const remainder = root.slice(1);
    if (['NQ', 'ES', 'YM'].includes(remainder)) return remainder;
    if (remainder === '2K') return 'RTY';
  }
  return root;
}

// Full-size → micro root mapping. Signals come as NQ/ES; we trade MNQ/MES.
const MICRO_ROOT_MAP = { NQ: 'MNQ', ES: 'MES', YM: 'MYM', RTY: 'M2K' };

function applyContractMapping(symbol) {
  if (!symbol) return symbol;
  const upper = String(symbol).toUpperCase();
  const m = upper.match(FUTURES_ROOT_REGEX);
  if (!m) return upper;
  const root = m[1];
  const suffix = upper.slice(root.length); // e.g. "M6" from "NQM6"
  const microRoot = MICRO_ROOT_MAP[root];
  if (microRoot) return `${microRoot}${suffix}`;
  // If already micro or unknown root, use currentContracts to verify
  const current = state.contractMappings[root];
  if (current) return current; // returns e.g. "MNQM6" for root "MNQ"
  return upper;
}

function normalizeDirection(side) {
  const s = String(side || '').toLowerCase();
  if (s === 'long' || s === 'buy') return 'long';
  if (s === 'short' || s === 'sell') return 'short';
  return null;
}

function directionToAction(direction) {
  return direction === 'long' ? 'Buy' : direction === 'short' ? 'Sell' : null;
}

function normalizeOrderType(action) {
  const a = String(action || '').toLowerCase();
  if (a === 'place_market') return 'Market';
  if (a === 'place_limit') return 'Limit';
  return null;
}

function generateSignalIdIfMissing(signal) {
  if (signal.signalId) return signal.signalId;
  const strategy = signal.strategy || 'UNKNOWN';
  const direction = normalizeDirection(signal.side) || 'na';
  const price = signal.price ?? 'mkt';
  return `${strategy}-${direction}-${price}-${Date.now()}`;
}

function buildUnderlyingPositionView() {
  // Projects openPositions → Map<underlying, { position, source, accountId }>
  // for cross-strategy-filter. First-seen wins if multiple accounts differ.
  const view = new Map();
  for (const pos of state.openPositions.values()) {
    if (pos.side === 'flat' || pos.netPos === 0) continue;
    const underlying = extractUnderlying(pos.symbol);
    if (!underlying) continue;
    if (!view.has(underlying)) {
      view.set(underlying, { position: pos.side, source: pos.strategy, accountId: pos.accountId });
    }
  }
  return view;
}

// ---------- Redis-backed state ----------

async function loadKillSwitch(redis) {
  try {
    const v = await redis.get(KILL_SWITCH_KEY);
    if (v === null) {
      state.tradingEnabled = true;
    } else {
      state.tradingEnabled = v === 'true';
    }
    logger.info(`Kill switch loaded: tradingEnabled=${state.tradingEnabled}`);
  } catch (err) {
    logger.warn(`Failed to load kill switch: ${err.message} — defaulting to enabled`);
  }
}

async function saveKillSwitch(redis) {
  try { await redis.set(KILL_SWITCH_KEY, String(state.tradingEnabled)); }
  catch (err) { logger.error(`Failed to persist kill switch: ${err.message}`); }
}

async function loadContractMappings(redis) {
  try {
    const raw = await redis.get(CONTRACTS_MAPPINGS_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      // Redis stores { currentContracts: { NQ: "NQM6", MNQ: "MNQM6", ... }, pointValues: {...}, ... }
      state.contractMappings = data.currentContracts || data;
      state.pointValues = data.pointValues || {};
      logger.info(`Contract mappings loaded: ${JSON.stringify(state.contractMappings)}`);
    }
  } catch (err) {
    logger.warn(`Failed to load contract mappings: ${err.message}`);
  }
}

async function checkpointOpenPositions(redis) {
  try {
    await redis.set(OPEN_POSITIONS_KEY, JSON.stringify({
      timestamp: new Date().toISOString(),
      entries: [...state.openPositions.entries()]
    }));
  } catch (err) {
    logger.warn(`Failed to checkpoint open positions: ${err.message}`);
  }
}

async function loadPositionSizing(redis) {
  try {
    const raw = await redis.get(POSITION_SIZING_KEY);
    if (raw) {
      state.positionSizing = JSON.parse(raw);
      logger.info(`Position sizing loaded: ${JSON.stringify(state.positionSizing)}`);
    }
  } catch (err) {
    logger.warn(`Failed to load position sizing: ${err.message}`);
  }
}

function parseTbRulesFromEnv() {
  if (process.env.TIME_BASED_TRAILING_ENABLED !== 'true') return null;
  const raw = process.env.TIME_BASED_TRAILING_RULES;
  if (!raw) return null;
  // Format: "15,50,breakeven|40,50,trail:10"
  try {
    const rules = raw.split('|').map(part => {
      const [afterMinutes, mfeThreshold, actionStr] = part.split(',');
      const rule = { afterMinutes: Number(afterMinutes), mfeThreshold: Number(mfeThreshold) };
      if (actionStr.startsWith('trail:')) {
        rule.action = 'trail';
        rule.trailOffset = Number(actionStr.split(':')[1]);
      } else {
        rule.action = actionStr; // 'breakeven'
      }
      return rule;
    });
    return rules;
  } catch (err) {
    logger.warn(`Failed to parse TIME_BASED_TRAILING_RULES: ${err.message}`);
    return null;
  }
}

async function loadTbRules(redis) {
  try {
    const raw = await redis.get(TB_RULES_KEY);
    if (raw) {
      state.tbRules = JSON.parse(raw);
      logger.info(`TB rules loaded from Redis: ${Object.keys(state.tbRules).join(', ')}`);
      return;
    }
  } catch (err) {
    logger.warn(`Failed to load TB rules from Redis: ${err.message}`);
  }
  // Fallback: parse from env vars (old format) and apply to IV_SKEW_GEX
  const envRules = parseTbRulesFromEnv();
  if (envRules) {
    state.tbRules = { IV_SKEW_GEX: envRules };
    logger.info(`TB rules loaded from env: ${envRules.length} rules for IV_SKEW_GEX`);
  }
}

async function restoreOpenPositions(redis) {
  try {
    const raw = await redis.get(OPEN_POSITIONS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.entries)) return;
    let registered = 0;
    for (const [k, v] of data.entries) {
      state.openPositions.set(k, v);
      // Restore exit-rule tracking for positions that carried rules when
      // they were checkpointed. Positions persisted before this feature
      // landed have no exit rules and just ride their original SL/TP.
      // Both legacy `exitRule` (single) and new `exitRules` (array) shapes
      // are accepted.
      const restoredRules = v?.exitRules
        ? v.exitRules
        : (v?.exitRule ? [v.exitRule] : []);
      if (restoredRules.length > 0 && Number.isFinite(v?.entryPrice)) {
        exitRuleManager.register({
          accountId: v.accountId,
          strategy: v.strategy,
          symbol: v.symbol,
          side: v.side,
          entryPrice: v.entryPrice,
          signalId: v.signalId || null,
          originalStop: v.originalStop ?? null,
          rules: restoredRules,
        });
        registered++;
      }
    }
    logger.info(`Restored ${state.openPositions.size} open positions from checkpoint (${registered} with exit rules)`);
  } catch (err) {
    logger.warn(`Failed to restore open positions checkpoint: ${err.message}`);
  }
}

async function refreshAccountsCache() {
  try {
    const accounts = await stores.accounts.list();
    state.accountsById.clear();
    for (const a of accounts) state.accountsById.set(a.id, a);
    logger.info(`Accounts cache refreshed: ${accounts.length} accounts [${accounts.map(a => `${a.id}:${a.enabled ? 'on' : 'off'}`).join(', ')}]`);
  } catch (err) {
    logger.error(`Failed to refresh accounts cache: ${err.message}`);
  }
}

// ---------- Gate chain ----------

async function passesDedup(redis, signal) {
  const key = `${SIGNAL_DEDUP_PREFIX}${signal.signalId}`;
  const result = await redis.set(key, '1', { NX: true, EX: SIGNAL_DEDUP_TTL_SEC });
  return result === 'OK';
}

function accountIsEnabled(accountId) {
  const account = state.accountsById.get(accountId);
  if (!account) return false;
  return account.enabled !== false;
}

function hasOpenOrPending(accountId, strategy, symbol) {
  // Brokers hold one NET position per (account, symbol) — they don't track
  // strategies. So we gate by (account, symbol) regardless of which strategy
  // the existing position is attributed to. Two strategies can't legitimately
  // each hold a short on MNQM6 in the same account; the broker would just
  // net them. If we keyed only on (account, strategy, symbol), a leftover
  // position attributed to strategy A would let strategy B stack on top.
  for (const v of state.pendingOrders.values()) {
    if (v.accountId === accountId && v.symbol === symbol) {
      return {
        blocked: true,
        why: v.strategy === strategy ? 'pending_order' : `pending_order_other_strategy:${v.strategy}`
      };
    }
  }
  for (const v of state.openPositions.values()) {
    if (v.accountId === accountId && v.symbol === symbol) {
      return {
        blocked: true,
        why: v.strategy === strategy ? 'open_position' : `open_position_other_strategy:${v.strategy}`
      };
    }
  }
  return { blocked: false };
}

// Build a compact signal payload for trade.rejected / strategy alerts.
// Preserves rule metadata (ruleId, ruleDescription, stop/target points) and
// the bracket levels (stop_loss, take_profit) so the dashboard can display
// what the trade WOULD have looked like even when trading is disabled.
function summarizeSignalForAlert(signal, overrides = {}) {
  if (!signal) return overrides;
  return {
    strategy: signal.strategy,
    symbol: overrides.symbol ?? signal.symbol,
    side: overrides.side ?? signal.side,
    action: signal.action,
    price: signal.price,
    stop_loss: signal.stop_loss ?? signal.stopLoss,
    take_profit: signal.take_profit ?? signal.takeProfit,
    ruleId: signal.ruleId,
    ruleDescription: signal.ruleDescription,
    rulePriority: signal.rulePriority,
    stopPoints: signal.stopPoints,
    targetPoints: signal.targetPoints,
  };
}

// ---------- Signal handling ----------

async function handleTradeSignal(raw) {
  const signal = raw || {};
  if (!signal.strategy) {
    logger.warn(`trade.signal missing strategy — dropping: ${JSON.stringify(signal).slice(0, 200)}`);
    return;
  }

  if (!state.tradingEnabled) {
    logger.warn(`[KILL-SWITCH] trade.signal ${signal.signalId || '(no id)'} [${signal.strategy}] rejected`);
    await messageBus.publish(CHANNELS.TRADE_REJECTED, {
      signalId: signal.signalId,
      signal: summarizeSignalForAlert(signal),
      reason: 'trading_disabled', timestamp: new Date().toISOString()
    });
    return;
  }

  const signalId = generateSignalIdIfMissing(signal);
  signal.signalId = signalId;

  const fresh = await passesDedup(stores.redis, signal);
  if (!fresh) {
    logger.info(`[DEDUP] ${signalId} [${signal.strategy}] — duplicate within ${SIGNAL_DEDUP_TTL_SEC}s, skipping`);
    return;
  }

  const direction = normalizeDirection(signal.side);
  if (!direction) {
    logger.warn(`[${signalId}] invalid side: ${signal.side}`);
    return;
  }
  const mappedOrderType = normalizeOrderType(signal.action);
  if (!mappedOrderType) {
    logger.warn(`[${signalId}] invalid action: ${signal.action}`);
    return;
  }

  const originalSymbol = signal.symbol;
  const tradedSymbol = applyContractMapping(originalSymbol);
  const underlying = extractUnderlying(tradedSymbol);

  // Cross-strategy filter (underlying-scoped, non-account-aware)
  const crossView = buildUnderlyingPositionView();
  const crossResult = evaluateCrossStrategyRules(
    { ...signal, action: signal.action },
    underlying, direction, crossView
  );
  if (!crossResult.allowed) {
    logger.warn(`[${signalId}] cross-strategy filter rejected: ${crossResult.reason}`);
    await messageBus.publish(CHANNELS.TRADE_REJECTED, {
      signalId,
      signal: summarizeSignalForAlert(signal, { symbol: originalSymbol, side: direction }),
      reason: crossResult.reason, rule: crossResult.ruleName, timestamp: new Date().toISOString()
    });
    return;
  }

  // Non-blocking informational alerts
  const alerts = evaluateStrategyAlerts?.(
    { ...signal, action: signal.action }, underlying, direction, crossView
  ) || [];
  for (const alert of alerts) {
    await messageBus.publish(CHANNELS.STRATEGY_ALERT, {
      signalId, strategy: signal.strategy, ...alert,
      timestamp: new Date().toISOString()
    });
  }

  // Resolve target accounts — explicit override or normal route resolution
  const accountIds = signal.targetAccountId
    ? [signal.targetAccountId]
    : await stores.routes.resolve(signal.strategy);
  if (!accountIds || accountIds.length === 0) {
    logger.warn(`[${signalId}] no accounts routed for strategy ${signal.strategy}`);
    return;
  }

  // Per-account gates (first-wins semantics on near-simultaneous signals via pending).
  // EOD force-flat signals bypass the open_position gate — they're trying to
  // CLOSE an open position, so the gate that prevents stacking entries would
  // otherwise block the very signal that's supposed to flatten.
  const accepted = [];
  const rejected = [];
  for (const accountId of accountIds) {
    if (!accountIsEnabled(accountId)) {
      rejected.push({ accountId, reason: 'account_disabled_or_missing' });
      continue;
    }
    if (!signal.eodForceFlat) {
      const gate = hasOpenOrPending(accountId, signal.strategy, tradedSymbol);
      if (gate.blocked) {
        rejected.push({ accountId, reason: gate.why });
        continue;
      }
    }
    accepted.push(accountId);
  }

  if (rejected.length > 0) {
    logger.info(`[${signalId}] per-account rejects: ${rejected.map(r => `${r.accountId}(${r.reason})`).join(', ')}`);
  }
  if (accepted.length === 0) {
    logger.warn(`[${signalId}] no accounts passed gate chain, dropping`);
    await messageBus.publish(CHANNELS.TRADE_REJECTED, {
      signalId,
      signal: summarizeSignalForAlert(signal, { symbol: tradedSymbol, side: direction }),
      reason: 'no_accounts_passed_gates',
      perAccount: rejected, timestamp: new Date().toISOString()
    });
    return;
  }

  logger.info(`[${signalId}] routing ${signal.strategy} ${direction} ${tradedSymbol} → [${accepted.join(', ')}]`);

  const now = new Date().toISOString();
  const action = directionToAction(direction);
  const quantity = Math.min(
    state.positionSizing.fixedQuantity ?? signal.quantity ?? 1,
    state.positionSizing.maxContracts ?? 10
  );

  for (const accountId of accepted) {
    const orderRequest = {
      signalId,
      accountId,
      strategy: signal.strategy,
      symbol: tradedSymbol,
      originalSymbol,
      underlying,
      action,
      orderType: mappedOrderType,
      price: mappedOrderType === 'Limit' ? signal.price : null,
      quantity,
      stopLoss: signal.stop_loss ?? null,
      takeProfit: signal.take_profit ?? null,
      trailingTrigger: signal.trailing_trigger ?? null,
      trailingOffset: signal.trailing_offset ?? null,
      tbRules: state.tbRules[signal.strategy] || null,
      direction,
      timestamp: now
    };

    // Mark pending BEFORE publishing so a second signal in flight is blocked.
    // Carry maxHoldBars / timeoutCandles forward so the polling loop can
    // enforce time-based exits (max hold) and stale-limit cancellation
    // for strategies that supply them (e.g. gex-lt-3m-crossover).
    // Capture any post-fill exit rules emitted by the strategy. Returns an
    // array — strategies can stack rules (e.g. gex-flip-ivpct's two-layer
    // BE+fib config). The rules ride on pendingOrders until the fill, then
    // transfer onto the open position where the exit-rule manager picks
    // them up on each price.update / candle.close.
    const exitRules = captureRuleFromSignal(signal);

    state.pendingOrders.set(pendingKey(accountId, signal.strategy, tradedSymbol), {
      accountId, strategy: signal.strategy, symbol: tradedSymbol,
      direction, signalId, requestedAt: now,
      action: signal.action,
      maxHoldBars: signal.maxHoldBars ?? null,
      timeoutCandles: signal.timeoutCandles ?? null,
      originalStop: signal.stop_loss ?? null,
      exitRules,
    });

    await messageBus.publish(CHANNELS.ORDER_REQUEST, orderRequest);
  }

  await messageBus.publish(CHANNELS.TRADE_VALIDATED, {
    signalId,
    signal: {
      strategy: signal.strategy,
      symbol: tradedSymbol,
      side: direction,
      action: signal.action,
      price: signal.price ?? null,
      stop_loss: signal.stop_loss ?? null,
      take_profit: signal.take_profit ?? null,
      quantity
    },
    acceptedAccounts: accepted,
    rejectedAccounts: rejected,
    timestamp: now
  });
}

// ---------- Broker event handlers (state updates for gate decisions) ----------

async function handleOrderPlaced(msg) {
  // Working order confirmed by broker — pending entry stays until fill or cancel
  const { signalId, accountId, strategy, symbol } = msg || {};
  if (!accountId || !strategy || !symbol) return;
  logger.debug?.(`[${signalId}] order.placed on ${accountId}`);
}

async function handleOrderRejected(msg) {
  const { signalId, accountId, strategy, symbol, reason } = msg || {};
  if (!accountId || !strategy || !symbol) return;
  if (state.pendingOrders.delete(pendingKey(accountId, strategy, symbol))) {
    logger.warn(`[${signalId}] order.rejected on ${accountId}: ${reason || 'no reason'} — pending cleared`);
  }
}

async function handleOrderCancelled(msg) {
  const { signalId, accountId, strategy, symbol } = msg || {};
  if (!accountId) return;

  // Preferred: direct key lookup when strategy+symbol are stamped
  if (strategy && symbol) {
    if (state.pendingOrders.delete(pendingKey(accountId, strategy, symbol))) {
      logger.info(`[${signalId || '?'}] order.cancelled on ${accountId} ${strategy} ${symbol} — pending cleared`);
    }
    return;
  }

  // Fallback: match by signalId across this account's pending entries.
  if (signalId) {
    for (const [key, pending] of state.pendingOrders.entries()) {
      if (key.startsWith(`${accountId}|`) && pending.signalId === signalId) {
        state.pendingOrders.delete(key);
        logger.info(`[${signalId}] order.cancelled on ${accountId} — cleared via signalId match (${key})`);
        return;
      }
    }
  }
  logger.warn(`order.cancelled on ${accountId} had insufficient fields (signalId=${signalId}, strategy=${strategy}, symbol=${symbol}) — nothing cleared`);
}

async function handlePositionOpened(msg) {
  const { signalId, accountId, strategy, symbol, side, netPos, entryPrice } = msg || {};
  if (!accountId || !strategy || !symbol) return;
  // Carry maxHoldBars from the matching pending order onto the open position
  // so checkMaxHold() can enforce a forced market close after that many
  // minutes (interpreting bars-since-entry as 1-minute bars, matching the
  // backtest engine convention).
  const pending = state.pendingOrders.get(pendingKey(accountId, strategy, symbol));
  const exitRules = pending?.exitRules ?? (pending?.exitRule ? [pending.exitRule] : []);
  state.openPositions.set(posKey(accountId, strategy, symbol), {
    accountId, strategy, symbol, side, netPos,
    entryPrice, signalId: signalId || null,
    openedAt: new Date().toISOString(),
    maxHoldBars: pending?.maxHoldBars ?? null,
    exitRules,
    originalStop: pending?.originalStop ?? null,
  });
  state.pendingOrders.delete(pendingKey(accountId, strategy, symbol));
  logger.info(`[${signalId || '?'}] position.opened ${accountId} ${strategy} ${symbol} ${side} @ ${entryPrice}`);

  // Hand any rules to the exit-rule manager so MFE/MAE-tracking and rule
  // firing can begin. The manager stays passive when rules is empty, so
  // positions with no exit rules (e.g., strategies that don't emit any)
  // just ride their original SL/TP — no behavior change for them.
  if (exitRules.length > 0) {
    exitRuleManager.register({
      accountId, strategy, symbol, side,
      entryPrice: Number(entryPrice),
      signalId: signalId || null,
      originalStop: pending?.originalStop ?? null,
      rules: exitRules,
    });
  }

  await checkpointOpenPositions(stores.redis);
}

async function handlePositionClosed(msg) {
  const { signalId, accountId, strategy, symbol, realizedPnl } = msg || {};
  if (!accountId || !strategy || !symbol) return;
  const pk = posKey(accountId, strategy, symbol);
  if (state.openPositions.delete(pk)) {
    logger.info(`[${signalId || '?'}] position.closed ${accountId} ${strategy} ${symbol} pnl=${realizedPnl ?? '?'}`);
  }
  state.pendingOrders.delete(pendingKey(accountId, strategy, symbol));
  exitRuleManager.unregister({ accountId, strategy, symbol });
  await checkpointOpenPositions(stores.redis);
}

async function handlePositionUpdate(msg) {
  const { accountId, strategy, symbol, side, netPos } = msg || {};
  if (!accountId || !strategy || !symbol) return;
  const pk = posKey(accountId, strategy, symbol);
  if (!netPos || side === 'flat') {
    if (state.openPositions.delete(pk)) {
      logger.info(`position.update → flat: ${accountId} ${strategy} ${symbol}`);
    }
    exitRuleManager.unregister({ accountId, strategy, symbol });
    return;
  }
  const existing = state.openPositions.get(pk);
  state.openPositions.set(pk, {
    ...(existing || {}),
    accountId, strategy, symbol, side, netPos,
    entryPrice: existing?.entryPrice ?? msg.entryPrice,
    signalId: existing?.signalId ?? msg.signalId ?? null,
    openedAt: existing?.openedAt ?? new Date().toISOString()
  });
}

async function handleOrdersSnapshot(msg) {
  const { accountId, orders } = msg || {};
  if (!accountId || !Array.isArray(orders)) return;

  // Wipe all known pending entries for this account, then rebuild from snapshot.
  for (const key of [...state.pendingOrders.keys()]) {
    if (key.startsWith(`${accountId}|`)) state.pendingOrders.delete(key);
  }

  let restored = 0;
  for (const o of orders) {
    if (!o.symbol) continue;
    // Only ENTRY orders populate pendingOrders — stop/target are bracket children.
    if (o.role === 'stop' || o.role === 'target') continue;
    const strategy = o.strategy || 'UNATTRIBUTED';
    const direction = o.action === 'Buy' ? 'long' : 'short';
    // If there's already an open position for this account+symbol, this is
    // likely a bracket child (stop/target), not a new entry order.
    const hasPosition = [...state.openPositions.values()].some(
      p => p.accountId === accountId && p.symbol === o.symbol
    );
    if (hasPosition) continue;
    state.pendingOrders.set(pendingKey(accountId, strategy, o.symbol), {
      accountId, strategy, symbol: o.symbol,
      direction,
      signalId: o.signalId || null,
      orderId: o.orderId,
      requestedAt: new Date().toISOString(),
      source: 'broker_snapshot'
    });
    restored++;
  }
  logger.info(`orders.snapshot from ${accountId}: ingested ${orders.length} orders, ${restored} pending entries restored`);
}

async function handlePositionSnapshot(msg) {
  const { accountId, positions } = msg || {};
  if (!accountId || !Array.isArray(positions)) return;

  for (const key of [...state.openPositions.keys()]) {
    if (key.startsWith(`${accountId}|`)) state.openPositions.delete(key);
  }

  for (const p of positions) {
    if (!p.symbol || !p.netPos) continue;
    const strategy = p.strategy || 'UNATTRIBUTED';
    const side = p.netPos > 0 ? 'long' : 'short';
    state.openPositions.set(posKey(accountId, strategy, p.symbol), {
      accountId, strategy, symbol: p.symbol, side, netPos: p.netPos,
      entryPrice: p.entryPrice, signalId: null,
      openedAt: new Date().toISOString()
    });
  }
  logger.info(`position.snapshot from ${accountId}: ingested ${positions.length} positions`);
  await checkpointOpenPositions(stores.redis);
}

async function handleAccountChanged() { await refreshAccountsCache(); }

// ---------- HTTP ----------

function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    const h = await healthCheck(SERVICE_NAME, {
      tradingEnabled: state.tradingEnabled,
      accounts: state.accountsById.size,
      openPositions: state.openPositions.size,
      pendingOrders: state.pendingOrders.size
    }, messageBus);
    res.json(h);
  });

  app.post('/trading/enable', async (_req, res) => {
    state.tradingEnabled = true;
    await saveKillSwitch(stores.redis);
    logger.warn('[KILL-SWITCH] trading ENABLED');
    res.json({ ok: true, tradingEnabled: true });
  });

  app.post('/trading/disable', async (_req, res) => {
    state.tradingEnabled = false;
    await saveKillSwitch(stores.redis);
    logger.warn('[KILL-SWITCH] trading DISABLED');
    res.json({ ok: true, tradingEnabled: false });
  });

  app.get('/trading/status', (_req, res) => {
    res.json({ tradingEnabled: state.tradingEnabled, timestamp: new Date().toISOString() });
  });

  app.get('/api/positions', (_req, res) => {
    res.json({ positions: [...state.openPositions.values()] });
  });

  app.get('/api/pending', (_req, res) => {
    res.json({ pending: [...state.pendingOrders.values()] });
  });

  app.get('/api/routes', async (_req, res) => {
    try { res.json(await stores.routes.get()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  return app;
}

// ---------- EOD force-flat (day-trade-margin liquidation safety) ----------

function getEtParts(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return {
    weekday: o.weekday,
    dateKey: `${o.year}-${o.month}-${o.day}`,
    hour: parseInt(o.hour, 10),
    minute: parseInt(o.minute, 10),
  };
}

function isPastEodCutoff(timestamp = Date.now()) {
  if (!EOD_CUTOFF_ET) return false;
  const [hStr, mStr] = EOD_CUTOFF_ET.split(':');
  const cutoffH = parseInt(hStr, 10);
  const cutoffM = parseInt(mStr || '0', 10);
  const et = getEtParts(timestamp);
  if (et.weekday === 'Sat' || et.weekday === 'Sun') return false;
  return et.hour > cutoffH || (et.hour === cutoffH && et.minute >= cutoffM);
}

async function checkEodForceFlat() {
  if (!EOD_CUTOFF_ET) return;
  if (!isPastEodCutoff()) return;
  const et = getEtParts();
  if (EOD_FIRED_DATES.has(et.dateKey)) return;
  EOD_FIRED_DATES.add(et.dateKey);

  const positions = [...state.openPositions.values()].filter(p => p.side !== 'flat' && p.netPos !== 0);
  if (positions.length === 0) {
    logger.info(`[EOD-FLAT] ${EOD_CUTOFF_ET} ET cutoff reached for ${et.dateKey} — no open positions`);
    return;
  }

  logger.warn(`[EOD-FLAT] ${EOD_CUTOFF_ET} ET cutoff for ${et.dateKey} — closing ${positions.length} open position(s)`);

  // Cancel orphan stop/target orders BEFORE firing market closes. The bracket
  // orders attached to the position would otherwise remain working after the
  // position closes, ready to fire as fresh entries on the next price tick.
  // We accept the brief unprotected-position window (~50-100ms between cancel
  // and close) because we're flattening imminently anyway. Cancellations are
  // de-duped per (accountId, symbol) so multi-position-same-account cases
  // only hit the broker once.
  const cancelKeys = new Set();
  await Promise.all(positions.map(async (pos) => {
    const key = `${pos.accountId}|${pos.symbol}`;
    if (cancelKeys.has(key)) return;
    cancelKeys.add(key);
    try {
      const url = `${TRADOVATE_SERVICE_URL}/accounts/${encodeURIComponent(pos.accountId)}/cancel-all/${encodeURIComponent(pos.symbol)}`;
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 501 = connector doesn't support symbol-level cancel-all (e.g. PMT).
        // That's fine; we still fire the market close below.
        if (res.status !== 501) {
          logger.error(`[EOD-FLAT] cancel-all HTTP ${res.status} for ${pos.accountId} ${pos.symbol}: ${body.slice(0, 200)}`);
        } else {
          logger.info(`[EOD-FLAT] cancel-all skipped for ${pos.accountId} (connector does not support symbol-level cancel-all)`);
        }
      } else {
        const result = await res.json().catch(() => ({}));
        const n = result.cancelledCount ?? 0;
        logger.warn(`[EOD-FLAT] cancelled ${n} working order(s) for ${pos.accountId} ${pos.symbol}`);
      }
    } catch (err) {
      logger.error(`[EOD-FLAT] cancel-all failed for ${pos.accountId} ${pos.symbol}: ${err.message}`);
    }
  }));

  for (const pos of positions) {
    const signal = {
      webhook_type: 'trade_signal',
      action: 'place_market',
      side: pos.side === 'long' ? 'sell' : 'buy',
      symbol: pos.symbol,
      quantity: Math.abs(pos.netPos) || 1,
      strategy: pos.strategy,
      signalId: `EOD-FLAT-${pos.accountId}-${pos.strategy}-${et.dateKey}`,
      reason: 'eod_force_flat',
      eodForceFlat: true,
      // Pin to the specific account that holds the position. Without this,
      // the signal fans out to all routed accounts and most reject as
      // "account_disabled_or_missing" or "open_position".
      targetAccountId: pos.accountId,
      timestamp: new Date().toISOString(),
    };
    logger.warn(`[EOD-FLAT] firing market close: ${pos.accountId} ${pos.strategy} ${pos.symbol} ${pos.side} ${pos.netPos}`);
    try {
      await messageBus.publish(CHANNELS.TRADE_SIGNAL, signal);
    } catch (err) {
      logger.error(`[EOD-FLAT] publish failed: ${err.message}`);
    }
  }
}

// Reset the fired-dates set every weekday morning so today's cutoff fires.
// Daily prune at midnight UTC keeps the set bounded.
function pruneEodFiredDates() {
  if (EOD_FIRED_DATES.size > 14) {
    EOD_FIRED_DATES.clear();
  }
}

// ---------- Max-hold force-flat ----------

// Fire a market close for any open position whose elapsed time since
// `openedAt` exceeds its `maxHoldBars` (interpreted as minutes, matching
// the backtest engine convention of 1 bar = 1 minute on a 1m timeframe).
// `closeRequested` is set on the entry to suppress repeat firings during
// the brief window between signal publish and position.closed event.
async function checkMaxHold() {
  const now = Date.now();
  for (const pos of state.openPositions.values()) {
    if (pos.closeRequested) continue;
    if (!pos.maxHoldBars || pos.maxHoldBars <= 0) continue;
    if (pos.side === 'flat' || pos.netPos === 0) continue;
    const openedMs = Date.parse(pos.openedAt);
    if (!openedMs) continue;
    const elapsedMin = (now - openedMs) / 60_000;
    if (elapsedMin < pos.maxHoldBars) continue;

    pos.closeRequested = true;
    const signalId = `MAX-HOLD-${pos.accountId}-${pos.strategy}-${pos.signalId || 'unknown'}`;
    const signal = {
      webhook_type: 'trade_signal',
      action: 'place_market',
      side: pos.side === 'long' ? 'sell' : 'buy',
      symbol: pos.symbol,
      quantity: Math.abs(pos.netPos) || 1,
      strategy: pos.strategy,
      signalId,
      reason: 'max_hold_exceeded',
      eodForceFlat: true, // bypass open_position gate (same exemption EOD uses)
      targetAccountId: pos.accountId,
      timestamp: new Date().toISOString(),
    };
    logger.warn(`[MAX-HOLD] ${pos.accountId} ${pos.strategy} ${pos.symbol} ${pos.side} ${pos.netPos} held ${elapsedMin.toFixed(1)}min >= ${pos.maxHoldBars}min — firing market close`);
    try {
      await messageBus.publish(CHANNELS.TRADE_SIGNAL, signal);
    } catch (err) {
      logger.error(`[MAX-HOLD] publish failed: ${err.message}`);
      pos.closeRequested = false; // allow retry on next poll
    }
  }
}

// ---------- Stale-limit cancellation ----------

const TRADOVATE_SERVICE_URL = process.env.TRADOVATE_SERVICE_URL || 'http://localhost:3011';

// ---------- Exit-rule manager (BE, fibRetrace, MFE ratchet) ----------
const exitRuleManager = createExitRuleManager({
  logger,
  extractUnderlying,
  publishModifyStop: async (payload) => {
    // POST to tradovate-service modify-stop endpoint. Used by BE and ratchet
    // rules to move the broker SL.
    const { accountId, signalId, newStopPrice, symbol } = payload;
    if (!signalId) {
      logger.warn(`[ExitRule] publishModifyStop ${accountId} ${symbol}: no signalId — cannot identify order; skipping`);
      return;
    }
    const url = `${TRADOVATE_SERVICE_URL}/accounts/${encodeURIComponent(accountId)}`
              + `/modify-stop/${encodeURIComponent(signalId)}`
              + `?symbol=${encodeURIComponent(symbol)}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newStopPrice, reason: payload.reason }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.error(`[ExitRule] modify-stop HTTP ${res.status}: ${body.slice(0, 200)}`);
      } else {
        logger.info(`[ExitRule] modify-stop posted: ${accountId} ${symbol} → ${newStopPrice} (${payload.reason})`);
      }
    } catch (err) {
      logger.error(`[ExitRule] modify-stop fetch failed: ${err.message}`);
    }
  },
  publishClosePosition: async (payload) => {
    // POST to tradovate-service close-position endpoint. Used by fibRetrace
    // when a bar close triggers an immediate market exit (and bracket cleanup).
    const { accountId, signalId, symbol } = payload;
    if (!signalId) {
      logger.warn(`[ExitRule] publishClosePosition ${accountId} ${symbol}: no signalId — skipping`);
      return;
    }
    const url = `${TRADOVATE_SERVICE_URL}/accounts/${encodeURIComponent(accountId)}`
              + `/close-position/${encodeURIComponent(signalId)}`
              + `?symbol=${encodeURIComponent(symbol)}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: payload.reason }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.error(`[ExitRule] close-position HTTP ${res.status}: ${body.slice(0, 200)}`);
      } else {
        logger.info(`[ExitRule] close-position posted: ${accountId} ${symbol} (${payload.reason})`);
      }
    } catch (err) {
      logger.error(`[ExitRule] close-position fetch failed: ${err.message}`);
    }
  },
});

// Cancel any pending limit order whose elapsed time since `requestedAt`
// exceeds its `timeoutCandles` (interpreted as minutes — the backtest engine
// uses 1m candles, so timeoutCandles=5 means cancel after 5 minutes).
//
// We call the tradovate-service's POST /accounts/:id/cancel/:signalId endpoint
// directly. The trade.signal action `cancel_limit` is not currently routable
// through handleTradeSignal (normalizeOrderType only maps place_market/place_limit),
// so going through the HTTP endpoint is the minimal change that gets the
// cancellation reliably to the broker.
async function checkStaleLimits() {
  const now = Date.now();
  for (const pending of state.pendingOrders.values()) {
    if (pending.cancelRequested) continue;
    if (!pending.timeoutCandles || pending.timeoutCandles <= 0) continue;
    if (pending.action !== 'place_limit') continue;
    if (!pending.signalId) continue; // can't cancel without an ID hint
    const elapsedMin = (now - pending.requestedAt) / 60_000;
    if (elapsedMin < pending.timeoutCandles) continue;

    pending.cancelRequested = true;
    logger.warn(`[STALE-LIMIT] ${pending.accountId} ${pending.strategy} ${pending.symbol} pending ${elapsedMin.toFixed(1)}min >= ${pending.timeoutCandles}min — cancelling`);
    try {
      const url = `${TRADOVATE_SERVICE_URL}/accounts/${encodeURIComponent(pending.accountId)}/cancel/${encodeURIComponent(pending.signalId)}?symbol=${encodeURIComponent(pending.symbol)}`;
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        logger.error(`[STALE-LIMIT] cancel HTTP ${res.status}: ${await res.text().catch(() => '')}`);
        pending.cancelRequested = false; // allow retry on next poll
      }
    } catch (err) {
      logger.error(`[STALE-LIMIT] cancel failed: ${err.message}`);
      pending.cancelRequested = false; // allow retry on next poll
    }
  }
}

// ---------- Bootstrap ----------

async function main() {
  await messageBus.connect();
  const redis = messageBus.publisher;

  stores.redis = redis;
  stores.accounts = createAccountStore({ redis, messageBus, logger });
  stores.routes = createRoutesStore({ redis, messageBus, logger });

  await loadKillSwitch(redis);
  await loadContractMappings(redis);
  await loadPositionSizing(redis);
  await loadTbRules(redis);
  await restoreOpenPositions(redis);
  await refreshAccountsCache();

  await messageBus.subscribe(CHANNELS.TRADE_SIGNAL, handleTradeSignal);
  await messageBus.subscribe(CHANNELS.ORDER_PLACED, handleOrderPlaced);
  await messageBus.subscribe(CHANNELS.ORDER_REJECTED, handleOrderRejected);
  await messageBus.subscribe(CHANNELS.ORDER_CANCELLED, handleOrderCancelled);
  // Drive the exit-rule manager from real-time ticks (BE, ratchet) and 1m
  // bar closes (fibRetrace). Handlers return immediately when no positions
  // are registered, so unconditional subscription costs nothing when the
  // strategies aren't using exit rules.
  await messageBus.subscribe(CHANNELS.PRICE_UPDATE, (msg) => {
    try { exitRuleManager.onPriceTick(msg); }
    catch (err) { logger.error(`[ExitRule] onPriceTick threw: ${err.message}`); }
  });
  await messageBus.subscribe(CHANNELS.CANDLE_CLOSE, (msg) => {
    try { exitRuleManager.onCandleClose(msg); }
    catch (err) { logger.error(`[ExitRule] onCandleClose threw: ${err.message}`); }
  });
  await messageBus.subscribe(CHANNELS.POSITION_OPENED, handlePositionOpened);
  await messageBus.subscribe(CHANNELS.POSITION_CLOSED, handlePositionClosed);
  await messageBus.subscribe(CHANNELS.POSITION_UPDATE, handlePositionUpdate);
  await messageBus.subscribe(CHANNELS.POSITION_SNAPSHOT, handlePositionSnapshot);
  await messageBus.subscribe(CHANNELS.ORDERS_SNAPSHOT, handleOrdersSnapshot);
  await messageBus.subscribe(ACCOUNT_CHANNEL, handleAccountChanged);
  await messageBus.subscribe(ROUTES_CHANNEL, () => logger.info('routes.changed — next signal picks up new config'));

  logger.info(`Subscribed to trade.signal, order.*, position.*, ${ACCOUNT_CHANNEL}, ${ROUTES_CHANNEL}`);

  const app = buildApp();
  app.listen(PORT, BIND_HOST, () => logger.info(`Orchestrator listening on ${BIND_HOST}:${PORT}`));

  setInterval(() => checkpointOpenPositions(redis), 30_000).unref();

  // EOD force-flat scheduler: poll every 30s, fire cutoff once per weekday at
  // EOD_CUTOFF_ET. Bootstrap the fired-dates set with today's date if we're
  // already past cutoff, so a service restart at 5 PM doesn't re-fire.
  if (EOD_CUTOFF_ET) {
    if (isPastEodCutoff()) {
      EOD_FIRED_DATES.add(getEtParts().dateKey);
    }
    setInterval(() => { checkEodForceFlat().catch(err => logger.error(`EOD check failed: ${err.message}`)); pruneEodFiredDates(); }, 30_000).unref();
    logger.info(`EOD force-flat enabled: cutoff ${EOD_CUTOFF_ET} ET on weekdays`);
  } else {
    logger.warn('EOD force-flat DISABLED (EOD_CUTOFF_ET unset). Day-trade-margin accounts will rely on broker auto-liquidation.');
  }

  // Max-hold and stale-limit polling: same 30s cadence as EOD. Strategies
  // that don't set maxHoldBars/timeoutCandles are unaffected.
  setInterval(() => {
    checkMaxHold().catch(err => logger.error(`Max-hold check failed: ${err.message}`));
    checkStaleLimits().catch(err => logger.error(`Stale-limit check failed: ${err.message}`));
  }, 30_000).unref();
  logger.info('Max-hold and stale-limit enforcement enabled (30s polling)');

  await messageBus.publish(CHANNELS.SERVICE_STARTED, {
    service: SERVICE_NAME, timestamp: new Date().toISOString()
  });
}

process.on('SIGTERM', async () => {
  logger.info('SIGTERM — shutting down');
  try { await messageBus.disconnect(); } catch {}
  process.exit(0);
});

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
