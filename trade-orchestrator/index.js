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

const SERVICE_NAME = 'trade-orchestrator';
const logger = createLogger(SERVICE_NAME);

// Redis keys owned by this service
const KILL_SWITCH_KEY = 'trading:kill_switch';
const OPEN_POSITIONS_KEY = 'orchestrator:open_positions';
const CONTRACTS_MAPPINGS_KEY = 'contracts:mappings';
const SIGNAL_DEDUP_PREFIX = 'signal:dedup:';
const SIGNAL_DEDUP_TTL_SEC = 60;

const PORT = Number(process.env.TRADE_ORCHESTRATOR_PORT || 3013);
const BIND_HOST = process.env.BIND_HOST === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
const POSITION_SIZING_KEY = 'config:position-sizing';
const TB_RULES_KEY = 'config:tb-rules';

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

async function loadTbRules(redis) {
  try {
    const raw = await redis.get(TB_RULES_KEY);
    if (raw) {
      state.tbRules = JSON.parse(raw);
      logger.info(`TB rules loaded: ${Object.keys(state.tbRules).join(', ')}`);
    }
  } catch (err) {
    logger.warn(`Failed to load TB rules: ${err.message}`);
  }
}

async function restoreOpenPositions(redis) {
  try {
    const raw = await redis.get(OPEN_POSITIONS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.entries)) return;
    for (const [k, v] of data.entries) state.openPositions.set(k, v);
    logger.info(`Restored ${state.openPositions.size} open positions from checkpoint`);
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
  if (state.pendingOrders.has(pendingKey(accountId, strategy, symbol))) {
    return { blocked: true, why: 'pending_order' };
  }
  if (state.openPositions.has(posKey(accountId, strategy, symbol))) {
    return { blocked: true, why: 'open_position' };
  }
  return { blocked: false };
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
      signal: { strategy: signal.strategy, symbol: signal.symbol, side: signal.side, action: signal.action, price: signal.price },
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
      signal: { strategy: signal.strategy, symbol: originalSymbol, side: direction, action: signal.action, price: signal.price },
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

  // Per-account gates (first-wins semantics on near-simultaneous signals via pending)
  const accepted = [];
  const rejected = [];
  for (const accountId of accountIds) {
    if (!accountIsEnabled(accountId)) {
      rejected.push({ accountId, reason: 'account_disabled_or_missing' });
      continue;
    }
    const gate = hasOpenOrPending(accountId, signal.strategy, tradedSymbol);
    if (gate.blocked) {
      rejected.push({ accountId, reason: gate.why });
      continue;
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
      signal: { strategy: signal.strategy, symbol: tradedSymbol, side: direction, action: signal.action, price: signal.price },
      reason: 'no_accounts_passed_gates',
      perAccount: rejected, timestamp: new Date().toISOString()
    });
    return;
  }

  logger.info(`[${signalId}] routing ${signal.strategy} ${direction} ${tradedSymbol} → [${accepted.join(', ')}]`);

  const now = new Date().toISOString();
  const action = directionToAction(direction);
  const quantity = signal.quantity ?? state.positionSizing.fixedQuantity ?? 1;

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
    state.pendingOrders.set(pendingKey(accountId, signal.strategy, tradedSymbol), {
      accountId, strategy: signal.strategy, symbol: tradedSymbol,
      direction, signalId, requestedAt: now
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
  state.openPositions.set(posKey(accountId, strategy, symbol), {
    accountId, strategy, symbol, side, netPos,
    entryPrice, signalId: signalId || null,
    openedAt: new Date().toISOString()
  });
  state.pendingOrders.delete(pendingKey(accountId, strategy, symbol));
  logger.info(`[${signalId || '?'}] position.opened ${accountId} ${strategy} ${symbol} ${side} @ ${entryPrice}`);
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
