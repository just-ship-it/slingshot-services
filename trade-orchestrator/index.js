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
import { evaluateGammaFilter, readGammaFilterConfig, normRegime } from '../shared/filters/gamma-filter.js';
import { createExitRuleManager, captureRuleFromSignal } from './src/exit-rule-manager.js';
import { applyStrategyRuleProfile } from './src/strategy-rule-profile.js';
import { shouldCancelOnPreFillExtreme, effectivePreFillExtremes } from './src/pre-fill-cancel.js';
import { reconcileOrdersSnapshot, reconcilePositionSnapshot } from './src/snapshot-reconciler.js';

const SERVICE_NAME = 'trade-orchestrator';
const logger = createLogger(SERVICE_NAME);

// Redis keys owned by this service
const KILL_SWITCH_KEY = 'trading:kill_switch';
const GAMMA_FILTER_KEY = 'trading:gamma_filter_enabled';                       // runtime override of the env default
const GAMMA_MAX_STALE_MS = Number(process.env.GAMMA_FILTER_MAX_STALE_MS || 1800000); // 30min — older regime = unknown → fail-open
const GAMMA_DEGRADED_ALERT_THROTTLE_MS = 15 * 60000;                           // alert at most once / 15min while degraded
const OPEN_POSITIONS_KEY = 'orchestrator:open_positions';
const SIGNAL_DEFAULTS_KEY = 'orchestrator:signal_defaults';
const CONTRACTS_MAPPINGS_KEY = 'contracts:mappings';
const SIGNAL_DEFAULTS_MAX = 5000; // FIFO cap to bound memory + checkpoint size
const SIGNAL_DEFAULTS_TTL_MS = 24 * 3600 * 1000; // expire entries older than 24h
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

  // Optional gamma-regime trade filter (loser-reduction overlay; see shared/filters/gamma-filter.js).
  gammaFilterCfg: readGammaFilterConfig(),     // {enabled, blockShortsInPositive, blockFadeInNegative}; enabled overridable at runtime
  gammaRegime: new Map(),                      // product(NQ/ES) -> { regime, totalGex, ts } (ts = receipt time)
  gammaDegradedLastAlertTs: 0,
  gammaFilterStats: { blocked: 0, degradedSkips: 0 },

  // Map<posKey, { accountId, strategy, symbol, side, netPos, entryPrice, signalId, openedAt }>
  openPositions: new Map(),

  // Map<pendingKey, { accountId, strategy, symbol, direction, signalId, requestedAt }>
  pendingOrders: new Map(),

  // Cached view of account-store — refreshed on account.changed
  accountsById: new Map(),

  // Per-signal lifecycle metadata registry. Populated at signal routing time
  // (see recordSignalDefaults), consumed by the snapshot reconciler when it
  // adopts an orphan broker position whose POSITION_OPENED event was dropped.
  // Without this, adopted positions get maxHoldBars=null and silently skip
  // checkMaxHold + exit-rule enforcement. Map<signalId, { strategy, maxHoldBars,
  // exitRules, originalStop, recordedAt }>. Bounded by SIGNAL_DEFAULTS_MAX +
  // SIGNAL_DEFAULTS_TTL_MS. Insertion order is preserved by Map for FIFO evict.
  signalDefaults: new Map(),

  // Per-strategy fallback when adoption can't find a signalId match (e.g.
  // broker snapshot lost the bracket clOrdId text). Holds the most recently
  // recorded defaults per strategy. Lossy when a strategy emits different
  // maxHoldBars per rule (gex-lt-3m-crossover) but strictly safer than null.
  strategyDefaults: new Map(),

  // Canonical exit policy keyed by (strategy, ruleId). The exit rules
  // (break-even, max-hold, trailing) belong to the STRATEGY+RULE, not to a
  // particular inbound payload — so we cache them per rule from any signal that
  // carries them, and re-apply by attribution to signals that arrive WITHOUT
  // them. The motivating case: a manual dashboard "Resend" reconstructs the
  // signal from the alert payload, which omits breakeven_*/maxHoldBars, so the
  // replayed order would otherwise run with no BE and no max-hold. Unlike
  // strategyDefaults this is per-rule, so S_GF_SOLO ≠ S_CW for gex-lt-3m.
  // Map<`${strategy}|${ruleId}`, { maxHoldBars, exitRules, recordedAt }>.
  strategyRuleDefaults: new Map(),
};

const stores = { routes: null, accounts: null, redis: null };

function posKey(accountId, strategy, symbol) { return `${accountId}|${strategy}|${symbol}`; }
function pendingKey(accountId, strategy, symbol) { return `${accountId}|${strategy}|${symbol}`; }

// ---------- Signal-defaults registry ----------

// Record the lifecycle metadata for a routed signal so the snapshot reconciler
// can recover it later if the WS POSITION_OPENED event gets dropped and the
// 5-min reconciler has to adopt the position from the broker snapshot.
// Called from handleTradeSignal right after the pendingOrders entry is set.
function recordSignalDefaults(signalId, signal, exitRules) {
  if (!signalId || !signal?.strategy) return;
  const entry = {
    strategy: signal.strategy,
    maxHoldBars: signal.maxHoldBars ?? null,
    exitRules: Array.isArray(exitRules) ? exitRules : [],
    originalStop: signal.stop_loss ?? null,
    recordedAt: Date.now(),
  };
  // FIFO evict if at cap. Map preserves insertion order so delete-first works.
  if (state.signalDefaults.size >= SIGNAL_DEFAULTS_MAX) {
    const oldestKey = state.signalDefaults.keys().next().value;
    if (oldestKey) state.signalDefaults.delete(oldestKey);
  }
  state.signalDefaults.set(signalId, entry);
  state.strategyDefaults.set(signal.strategy, entry);
}

function pruneSignalDefaults() {
  const cutoff = Date.now() - SIGNAL_DEFAULTS_TTL_MS;
  for (const [k, v] of state.signalDefaults) {
    if (v.recordedAt < cutoff) state.signalDefaults.delete(k);
    else break; // Map iteration is insertion-ordered; once we hit a young one, the rest are younger
  }
}

// Resolve adoption defaults for a snapshot-discovered orphan position. Tries
// exact-match by signalId first (precise — same rule, same per-rule params),
// then falls back to per-strategy last-known (lossy but safer than null).
// Returns { maxHoldBars, exitRules, originalStop, source } | null.
function resolveAdoptionDefaults({ strategy, signalId }) {
  if (signalId) {
    const exact = state.signalDefaults.get(signalId);
    if (exact) {
      return {
        maxHoldBars: exact.maxHoldBars,
        exitRules: exact.exitRules,
        originalStop: exact.originalStop,
        source: 'signalId',
      };
    }
  }
  if (strategy && strategy !== 'UNATTRIBUTED') {
    const fallback = state.strategyDefaults.get(strategy);
    if (fallback) {
      return {
        maxHoldBars: fallback.maxHoldBars,
        exitRules: fallback.exitRules,
        originalStop: fallback.originalStop,
        source: 'strategy',
      };
    }
  }
  return null;
}


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

// ---------- Gamma filter (optional, runtime-toggleable) ----------
// `enabled` defaults from env (GAMMA_FILTER_ENABLED) but a Redis value overrides it so the
// live on/off survives restarts (mirrors the kill switch). Rule sub-toggles stay env-driven.
async function loadGammaFilterEnabled(redis) {
  try {
    const v = await redis.get(GAMMA_FILTER_KEY);
    if (v !== null) state.gammaFilterCfg.enabled = v === 'true';
    const c = state.gammaFilterCfg;
    logger.info(`Gamma filter loaded: enabled=${c.enabled} (shortsInPos=${c.blockShortsInPositive}, fadeInNeg=${c.blockFadeInNegative}, maxStale=${Math.round(GAMMA_MAX_STALE_MS/60000)}min)`);
  } catch (err) { logger.warn(`Failed to load gamma filter flag: ${err.message} — using env default ${state.gammaFilterCfg.enabled}`); }
}
async function saveGammaFilterEnabled(redis) {
  try { await redis.set(GAMMA_FILTER_KEY, String(state.gammaFilterCfg.enabled)); }
  catch (err) { logger.error(`Failed to persist gamma filter flag: ${err.message}`); }
}

// Cache net-gamma regime per product from data-service's gex.levels broadcasts.
function handleGexLevels(msg) {
  try {
    const product = String(msg?.product || '').toUpperCase();
    if (!product) return;
    let regime = normRegime(msg.regime);
    if (regime == null && Number.isFinite(msg.totalGex)) regime = msg.totalGex >= 0 ? 'positive' : 'negative';
    if (regime == null) return;
    state.gammaRegime.set(product, { regime, totalGex: Number.isFinite(msg.totalGex) ? msg.totalGex : null, ts: Date.now() });
  } catch (err) { logger.error(`[GAMMA] gex.levels handler threw: ${err.message}`); }
}
// Current regime for an underlying, or null if missing/stale (→ filter fails open).
function currentRegimeFor(underlying) {
  const e = state.gammaRegime.get(String(underlying || '').toUpperCase());
  if (!e) return null;
  if (Date.now() - e.ts > GAMMA_MAX_STALE_MS) return null;
  return e.regime;
}
// FAIL-OPEN is silent by default; this makes the "enabled but couldn't act" state LOUD (throttled).
async function notifyGammaDegraded(underlying) {
  const now = Date.now();
  if (now - state.gammaDegradedLastAlertTs < GAMMA_DEGRADED_ALERT_THROTTLE_MS) return;
  state.gammaDegradedLastAlertTs = now;
  const msg = `[GAMMA] filter ENABLED but ${underlying} gamma regime is unknown/stale (>${Math.round(GAMMA_MAX_STALE_MS/60000)}min) — FAILING OPEN (signals pass unfiltered). ${state.gammaFilterStats.degradedSkips} affected since boot. Check data-service GEX feed.`;
  logger.error(msg);
  try {
    await messageBus.publish(CHANNELS.STRATEGY_ALERT, {
      ruleName: 'gamma-filter-degraded', severity: 'warning', message: msg,
      signal: { strategy: null, symbol: underlying }, timestamp: new Date().toISOString(),
    });
  } catch (err) { logger.warn(`[GAMMA] degraded alert publish failed: ${err.message}`); }
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

// Persist the signalDefaults registry so a restart doesn't lose protection
// metadata for recently-routed signals. Without this, any orphan adopted via
// snapshot reconciliation after a restart would default to maxHoldBars=null
// until the next signal for that strategy fires.
async function checkpointSignalDefaults(redis) {
  try {
    pruneSignalDefaults();
    await redis.set(SIGNAL_DEFAULTS_KEY, JSON.stringify({
      timestamp: new Date().toISOString(),
      signalEntries: [...state.signalDefaults.entries()],
      strategyEntries: [...state.strategyDefaults.entries()],
      strategyRuleEntries: [...state.strategyRuleDefaults.entries()],
    }));
  } catch (err) {
    logger.warn(`Failed to checkpoint signal defaults: ${err.message}`);
  }
}

async function restoreSignalDefaults(redis) {
  try {
    const raw = await redis.get(SIGNAL_DEFAULTS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.signalEntries)) {
      for (const [k, v] of data.signalEntries) state.signalDefaults.set(k, v);
    }
    if (Array.isArray(data.strategyEntries)) {
      for (const [k, v] of data.strategyEntries) state.strategyDefaults.set(k, v);
    }
    if (Array.isArray(data.strategyRuleEntries)) {
      for (const [k, v] of data.strategyRuleEntries) state.strategyRuleDefaults.set(k, v);
    }
    pruneSignalDefaults();
    logger.info(`Restored ${state.signalDefaults.size} signal defaults + ${state.strategyDefaults.size} strategy defaults + ${state.strategyRuleDefaults.size} rule profiles from checkpoint`);
  } catch (err) {
    logger.warn(`Failed to restore signal defaults: ${err.message}`);
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
    // Stop-management metadata (breakeven / trailing engage + move-to) so the
    // dashboard can show where the stop ratchets even on rejected signals.
    breakevenStop: signal.breakevenStop,
    breakevenTrigger: signal.breakevenTrigger,
    breakevenOffset: signal.breakevenOffset,
    trailingTrigger: signal.trailingTrigger,
    trailingOffset: signal.trailingOffset,
    lsBeOnFlip: signal.lsBeOnFlip,
    lsBeOffset: signal.lsBeOffset,
  };
}

// Max time to wait on the broker position check before placing an order.
const GATE_BROKER_CHECK_TIMEOUT_MS = 8_000;

// Broker-authoritative position check. An open position is an open position —
// regardless of symbol, strategy, or when/how it was opened. This asks the ONE
// question that matters before placing an entry: does this account hold ANY net
// position at the broker right now? It works directly on the raw /position/list
// rows (every row carries `netPos`), so it needs no symbol resolution and cannot
// be fooled by a symbol/contract-format mismatch (the bug that let signals stack).
//
// Returns:
//   true   → account is fully FLAT (no row has a non-zero netPos)
//   false  → account holds at least one open position (block the signal)
//   null   → could not determine (broker unreachable / bad shape) — caller
//            treats this as fail-CLOSED (reject), never as "flat".
async function brokerAccountFlat(accountId) {
  const url = `${TRADOVATE_SERVICE_URL}/accounts/${encodeURIComponent(accountId)}/positions`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GATE_BROKER_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', signal: ac.signal });
    if (!res.ok) {
      logger.warn(`[BROKER-GATE] ${accountId}: positions HTTP ${res.status} — cannot confirm flat`);
      return null;
    }
    const body = await res.json();
    const positions = Array.isArray(body?.positions) ? body.positions : null;
    if (positions == null) {
      logger.warn(`[BROKER-GATE] ${accountId}: malformed positions response — cannot confirm flat`);
      return null;
    }
    return !positions.some(p => Number(p.netPos) !== 0);
  } catch (err) {
    logger.warn(`[BROKER-GATE] ${accountId}: check failed (${err.name === 'AbortError' ? `timeout ${GATE_BROKER_CHECK_TIMEOUT_MS}ms` : err.message}) — cannot confirm flat`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Broker confirmed this account FLAT → reconcile local state to match by tearing
// down every local open position for the account (any was stale). Returns the
// count cleared. Symbol/strategy-agnostic to mirror brokerAccountFlat.
async function clearStaleLocalsForAccount(accountId) {
  let cleared = 0;
  for (const pos of [...state.openPositions.values()]) {
    if (pos.accountId !== accountId) continue;
    logger.warn(`[BROKER-GATE] broker FLAT on ${accountId} but local held ${pos.strategy} ${pos.symbol} (netPos=${pos.netPos}) — dropping stale local position`);
    await handlePositionClosed({
      accountId, strategy: pos.strategy, symbol: pos.symbol,
      signalId: pos.signalId, realizedPnl: null,
    });
    cleared++;
  }
  return cleared;
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

  // Enforce the strategy's exit policy by ATTRIBUTION, independent of origin.
  // Capture the exit rules this signal carries, then backfill any missing
  // break-even / max-hold from the cached (strategy, ruleId) profile — so a
  // manual Resend (whose alert payload omits those fields) still runs the same
  // exits as a fresh signal. Done before the gate so the profile also stays
  // warm from signals that end up rejected. `exitRules` is reused below.
  const exitRules = applyStrategyRuleProfile(
    state.strategyRuleDefaults, signal, captureRuleFromSignal(signal), { logger, logId: signalId }
  );

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

  // Gamma-regime filter (optional loser-reduction overlay; underlying-scoped; FAIL-OPEN).
  {
    const regime = currentRegimeFor(underlying);
    const g = evaluateGammaFilter(
      { strategy: signal.strategy, side: direction, action: signal.action },
      regime, state.gammaFilterCfg
    );
    if (!g.allowed) {
      state.gammaFilterStats.blocked++;
      logger.warn(`[${signalId}] gamma filter rejected: ${g.reason} [${g.ruleName}] regime=${regime}`);
      await messageBus.publish(CHANNELS.TRADE_REJECTED, {
        signalId,
        signal: summarizeSignalForAlert(signal, { symbol: originalSymbol, side: direction }),
        reason: `gamma_filter:${g.ruleName}`, rule: g.ruleName, regime, timestamp: new Date().toISOString()
      });
      return;
    }
    if (g.degraded) {                 // enabled but regime unknown/stale → failed open; make it loud
      state.gammaFilterStats.degradedSkips++;
      await notifyGammaDegraded(underlying);
    }
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

  // Per-account gates. The BROKER is the authority on open positions: if an
  // account holds ANY net position (any symbol, any strategy, opened however/
  // whenever), a new entry is rejected — this is what prevents stacking. Local
  // state is only a hint; we confirm against the broker every time and reconcile
  // local state to match. EOD force-flat signals bypass position gating entirely
  // — they exist to CLOSE a position, not open one.
  const accepted = [];
  const rejected = [];
  for (const accountId of accountIds) {
    if (!accountIsEnabled(accountId)) {
      rejected.push({ accountId, reason: 'account_disabled_or_missing' });
      continue;
    }

    if (!signal.eodForceFlat) {
      const flat = await brokerAccountFlat(accountId);
      if (flat === false) {
        // Broker holds a position — never stack onto it.
        rejected.push({ accountId, reason: 'broker_position_open' });
        continue;
      }
      if (flat === null) {
        // Could not confirm flat → fail CLOSED. We never place an entry unless
        // the broker positively confirms the account is flat.
        rejected.push({ accountId, reason: 'broker_check_failed' });
        continue;
      }
      // Broker confirms flat → drop any stale local position for this account.
      await clearStaleLocalsForAccount(accountId);

      // A working limit (pending order) means an entry is already in flight for
      // this account+symbol; don't place a duplicate. (No position exists yet,
      // so the broker check above wouldn't catch it.)
      const gate = hasOpenOrPending(accountId, signal.strategy, tradedSymbol);
      if (gate.blocked && gate.why.startsWith('pending')) {
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
    // exitRules (captured + profile-backfilled above) ride on pendingOrders
    // until the fill, then transfer onto the open position where the exit-rule
    // manager picks them up on each price.update / candle.close.
    state.pendingOrders.set(pendingKey(accountId, signal.strategy, tradedSymbol), {
      accountId, strategy: signal.strategy, symbol: tradedSymbol,
      direction, signalId, requestedAt: Date.now(),
      action: signal.action,
      maxHoldBars: signal.maxHoldBars ?? null,
      timeoutCandles: signal.timeoutCandles ?? null,
      originalStop: signal.stop_loss ?? null,
      exitRules,
      // Pre-fill-extreme cancel: when set, the watcher (checkPreFillExtremes)
      // cancels this limit if price reaches either stop or target before the
      // fill confirms. Opt-in via signal.cancelOnPreFillExtreme; lstb sets
      // this, other strategies leave it undefined → watcher skips them.
      cancelOnPreFillExtreme: signal.cancelOnPreFillExtreme === true,
      preFillStopLoss: signal.stop_loss ?? null,
      preFillTakeProfit: signal.take_profit ?? null,
    });

    // Persist signal's protection metadata to the signalDefaults registry so
    // the snapshot reconciler can recover it later if the WS POSITION_OPENED
    // event for this fill never arrives and the position has to be adopted
    // from the broker snapshot. See resolveAdoptionDefaults + handlePositionSnapshot.
    recordSignalDefaults(signalId, signal, exitRules);

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
      quantity,
      // Rule + stop-management metadata so the dashboard alert can show the
      // rule, point distances, and where the breakeven/trailing stop engages.
      ruleId: signal.ruleId,
      ruleDescription: signal.ruleDescription,
      rulePriority: signal.rulePriority,
      stopPoints: signal.stopPoints,
      targetPoints: signal.targetPoints,
      breakevenStop: signal.breakevenStop,
      breakevenTrigger: signal.breakevenTrigger,
      breakevenOffset: signal.breakevenOffset,
      trailingTrigger: signal.trailingTrigger,
      trailingOffset: signal.trailingOffset,
      lsBeOnFlip: signal.lsBeOnFlip,
      lsBeOffset: signal.lsBeOffset,
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
  const openPos = state.openPositions.get(pk);
  if (state.openPositions.delete(pk)) {
    logger.info(`[${signalId || '?'}] position.closed ${accountId} ${strategy} ${symbol} pnl=${realizedPnl ?? '?'}`);
  }
  state.pendingOrders.delete(pendingKey(accountId, strategy, symbol));

  // Capture per-trade metrics BEFORE unregister tears them down. Publishes
  // a trade.metrics event with strategy + MFE/MAE + entry/exit so the
  // monitoring-service can enrich its pnl:trades (which only carry netPnl
  // and don't know strategy or excursion). Used by the account-tracker
  // dashboard module's MAE comparison panel.
  const metrics = exitRuleManager.getMetrics({ accountId, strategy, symbol });
  if (metrics) {
    try {
      await messageBus.publish(CHANNELS.TRADE_METRICS, {
        signalId: signalId || metrics.signalId || null,
        accountId,
        strategy,
        symbol,
        side: metrics.side,
        entryPrice: metrics.entryPrice,
        exitPrice: msg.exitPrice ?? msg.fillPrice ?? null,
        mfePoints: metrics.mfePoints,
        maePoints: metrics.maePoints,
        highWaterMark: metrics.highWaterMark,
        lowWaterMark: metrics.lowWaterMark,
        openedAt: metrics.openedAt,
        closedAt: Date.now(),
        realizedPnl: realizedPnl ?? null,
        openedAtIso: openPos?.openedAt || new Date(metrics.openedAt).toISOString(),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn(`[${signalId || '?'}] failed to publish trade.metrics: ${err.message}`);
    }
  }

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

  // Reconcile: merge broker reality with local state instead of wipe-and-rebuild.
  // Preserves strategy attribution, timeoutCandles, maxHoldBars, exitRules, and
  // requestedAt for known pending entries. See snapshot-reconciler.js.
  const { restored, preserved, dropped, orphaned } = reconcileOrdersSnapshot(
    state.pendingOrders, accountId, orders, state.openPositions, pendingKey
  );
  logger.info(
    `orders.snapshot from ${accountId}: ${orders.length} broker orders → ` +
    `${preserved} preserved, ${orphaned} orphaned, ${dropped} dropped (restored=${restored})`
  );
}

async function handlePositionSnapshot(msg) {
  const { accountId, positions } = msg || {};
  if (!accountId || !Array.isArray(positions)) return;

  // Reconcile: same merge semantics as orders. Preserves local strategy
  // attribution + maxHoldBars + exitRules + signalId when broker confirms
  // the same (account, symbol, side-sign) position. The resolveDefaults
  // callback lets the reconciler recover protection metadata from the
  // signalDefaults registry when adopting an orphan — without it, adopted
  // positions skip max-hold and exit-rule enforcement (silent safety hole).
  const { preserved, dropped, orphaned, adopted, droppedPositions } = reconcilePositionSnapshot(
    state.openPositions, accountId, positions, posKey,
    { resolveDefaults: resolveAdoptionDefaults }
  );
  logger.info(
    `position.snapshot from ${accountId}: ${positions.length} broker positions → ` +
    `${preserved} preserved, ${orphaned} orphaned, ${dropped} dropped`
  );

  // The reconciler removed these from state.openPositions but full teardown
  // (untrack exit rules, clear pending, recover trade.metrics) lives in
  // handlePositionClosed. Without this, a pruned position's exit rules keep
  // firing modify-stops on a broker that no longer holds the position.
  for (const pos of (droppedPositions || [])) {
    logger.warn(
      `[PRUNE] ${accountId} ${pos.strategy} ${pos.symbol} dropped from local state ` +
      `(reason=${pos._dropReason || 'unknown'}) — broker no longer holds it. ` +
      `Untracking exit rules + clearing slot.`
    );
    await handlePositionClosed({
      accountId, strategy: pos.strategy, symbol: pos.symbol,
      signalId: pos.signalId, realizedPnl: null,
    });
  }

  // Register exit rules for each adopted orphan and emit operator-visible
  // warnings. Missing maxHoldBars is logged at error severity because the
  // position will not get force-closed on time — operator action may be
  // required (manual close or tighten broker SL).
  for (const { entry } of adopted) {
    const tag = `[ADOPT ${entry.accountId} ${entry.strategy} ${entry.symbol} ${entry.side}]`;
    const meta = `signalId=${entry.signalId || 'none'} src=${entry.defaultsSource || 'none'} maxHold=${entry.maxHoldBars ?? 'NULL'}min rules=${entry.exitRules?.length || 0}`;

    if (entry.maxHoldBars && entry.maxHoldBars > 0) {
      logger.warn(`${tag} adopted orphan from broker snapshot — ${meta}. checkMaxHold will force-close at openedAt + ${entry.maxHoldBars}min.`);
    } else {
      logger.error(`${tag} adopted orphan WITHOUT max-hold metadata — ${meta}. Position has NO time-based exit; only broker SL/TP + EOD force-flat will close it. Manual action may be required.`);
    }

    if (Array.isArray(entry.exitRules) && entry.exitRules.length > 0 && Number.isFinite(entry.entryPrice)) {
      try {
        exitRuleManager.register({
          accountId: entry.accountId,
          strategy: entry.strategy,
          symbol: entry.symbol,
          side: entry.side,
          entryPrice: Number(entry.entryPrice),
          signalId: entry.signalId || null,
          originalStop: entry.originalStop ?? null,
          rules: entry.exitRules,
        });
        logger.info(`${tag} registered ${entry.exitRules.length} exit rule(s) on adoption`);
      } catch (err) {
        logger.error(`${tag} failed to register exit rules on adoption: ${err.message}`);
      }
    }
  }

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

  // Gamma filter: live status + on/off toggle (persisted to Redis, survives restart).
  app.get('/gamma-filter/status', (_req, res) => {
    const now = Date.now(); const regime = {};
    for (const [p, e] of state.gammaRegime) regime[p] = { regime: e.regime, totalGex: e.totalGex, ageSec: Math.round((now - e.ts) / 1000), stale: (now - e.ts) > GAMMA_MAX_STALE_MS };
    res.json({ ...state.gammaFilterCfg, maxStaleMin: Math.round(GAMMA_MAX_STALE_MS / 60000), regime, stats: state.gammaFilterStats, timestamp: new Date().toISOString() });
  });
  app.post('/gamma-filter/enable', async (_req, res) => {
    state.gammaFilterCfg.enabled = true; await saveGammaFilterEnabled(stores.redis);
    logger.warn('[GAMMA] filter ENABLED via API'); res.json({ ok: true, enabled: true });
  });
  app.post('/gamma-filter/disable', async (_req, res) => {
    state.gammaFilterCfg.enabled = false; await saveGammaFilterEnabled(stores.redis);
    logger.warn('[GAMMA] filter DISABLED via API'); res.json({ ok: true, enabled: false });
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

  // Operator tool: reconcile local open positions against broker truth. For each
  // account with local positions, ask the broker if it's flat; if so, drop the
  // stale locals (recovers from dropped POSITION_CLOSED WS events). Broker-
  // authoritative and symbol-agnostic — mirrors the gate. Optional JSON body
  // { accountId? } scopes to one account. Returns per-account outcome.
  app.post('/positions/resync', async (req, res) => {
    const { accountId: filterAccount = null } = req.body || {};
    const accountIds = [...new Set(
      [...state.openPositions.values()]
        .filter(p => !filterAccount || p.accountId === filterAccount)
        .map(p => p.accountId)
    )];
    const cleared = [];
    const heldOpen = [];
    const unknown = [];
    for (const accountId of accountIds) {
      const flat = await brokerAccountFlat(accountId);
      if (flat === true) {
        const n = await clearStaleLocalsForAccount(accountId);
        cleared.push({ accountId, dropped: n });
      } else if (flat === false) {
        heldOpen.push({ accountId });
      } else {
        unknown.push({ accountId });
      }
    }
    logger.warn(`[RESYNC] complete — cleared=${cleared.length} heldOpen=${heldOpen.length} unknown=${unknown.length} (scope: ${filterAccount || 'all'})`);
    res.json({ ok: unknown.length === 0, cleared, heldOpen, unknown });
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

// ---------- Hardened broker flatten (shared by max-hold + EOD) ----------

// Time budget for a flatten call. tradovate-service's liquidatePosition polls
// the broker up to ~30s (3 retries × 5s + slack) before it gives up, so allow
// headroom beyond that so we read its real verdict rather than aborting early.
const FLATTEN_FETCH_TIMEOUT_MS = 45_000;

// Flatten a position at the broker and confirm it actually went flat.
// POSTs to tradovate-service /accounts/:id/flatten/:symbol, which cancels all
// working orders AND liquidates the net position, polling the broker until it
// verifies net=0 with no working orders. Because the broker liquidation is
// direction/quantity-agnostic (it flattens whatever is actually held), this
// cannot leave an orphan bracket that later reopens the opposite side — the
// failure mode the old "synthesize a market order from pos.netPos" path had.
//
// Returns { flat: boolean, detail }. flat=true ONLY on broker-verified flat.
async function flattenAtBroker(accountId, symbol, { reason } = {}) {
  const url = `${TRADOVATE_SERVICE_URL}/accounts/${encodeURIComponent(accountId)}/flatten/${encodeURIComponent(symbol)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FLATTEN_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: reason || null }),
      signal: ac.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok !== true || body.verified !== true) {
      return { flat: false, detail: body.error || `HTTP ${res.status}` };
    }
    return { flat: true, detail: body.result || null };
  } catch (err) {
    return { flat: false, detail: err.name === 'AbortError' ? `timeout after ${FLATTEN_FETCH_TIMEOUT_MS}ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Direct critical-alert email + SMS via the Resend HTTP API (no SDK dep).
// Used for kill-switch events. Deliberately INDEPENDENT of the Redis →
// monitoring-service → Discord path, because trading gets auto-disabled
// precisely when infra may be degraded — so we don't want the only notification
// to depend on another service being healthy. Mirrors the Resend setup the
// tradovate-service already uses for liquidation alerts (same env vars).
// Sends to ALERT_SMS_EMAIL (carrier email→SMS gateway → text) and ALERT_EMAIL.
async function sendCriticalAlertEmail(subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_FROM_EMAIL;
  if (!apiKey || !from) {
    logger.warn('[ALERT] Resend not configured (RESEND_API_KEY / ALERT_FROM_EMAIL) — email alert skipped');
    return;
  }
  const recipients = [process.env.ALERT_SMS_EMAIL, process.env.ALERT_EMAIL].filter(Boolean);
  if (recipients.length === 0) {
    logger.warn('[ALERT] no ALERT_SMS_EMAIL / ALERT_EMAIL configured — email alert skipped');
    return;
  }
  await Promise.all(recipients.map(async (to) => {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject, text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.error(`[ALERT] Resend send to ${to} failed: HTTP ${res.status} ${body.slice(0, 150)}`);
      } else {
        logger.info(`[ALERT] critical alert emailed to ${to}`);
      }
    } catch (err) {
      logger.error(`[ALERT] Resend send to ${to} threw: ${err.message}`);
    }
  }));
}

// Escalation when a flatten cannot be verified flat at the broker: trip the
// kill switch so no new entries pile onto a stuck/naked position, and fire a
// critical alert for manual intervention via BOTH channels — the STRATEGY_ALERT
// (→ Discord, via monitoring) and a direct Resend email/SMS. (kind = 'max-hold'
// | 'eod'.)
async function haltTradingForFailedFlatten(context, detail) {
  const { accountId, strategy, symbol, side, netPos, kind } = context;
  state.tradingEnabled = false;
  await saveKillSwitch(stores.redis);
  const msg = `[HALT] Could not verify flat after ${kind} close: ${accountId} ${strategy || '?'} ${symbol} ${side || '?'} ${netPos ?? '?'} — ${detail}. Trading DISABLED; manual flatten required.`;
  logger.error(msg);
  try {
    await messageBus.publish(CHANNELS.STRATEGY_ALERT, {
      ruleName: `${kind}-flatten-failed`,
      severity: 'critical',
      message: msg,
      signal: { strategy: strategy || null, symbol },
      accountId,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error(`[HALT] critical alert publish failed: ${err.message}`);
  }
  await sendCriticalAlertEmail(`🚨 TRADING DISABLED — ${kind} flatten failed (${symbol})`, msg);
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

  // Flatten each distinct (accountId, symbol) at the broker via the hardened
  // liquidate+verify path. This cancels working orders AND closes the net
  // position, polling until the broker confirms flat — replacing the old
  // "cancel-all then synthesize a directional market order" sequence that
  // could leave an orphan bracket (or, on stale state, open the opposite side).
  const flattenKeys = new Set();
  for (const pos of positions) {
    const fk = `${pos.accountId}|${pos.symbol}`;
    if (flattenKeys.has(fk)) continue;
    flattenKeys.add(fk);

    logger.warn(`[EOD-FLAT] flattening at broker: ${pos.accountId} ${pos.symbol}`);
    const { flat, detail } = await flattenAtBroker(pos.accountId, pos.symbol, { reason: 'eod_force_flat' });
    if (flat) {
      // Broker verified flat for the whole contract — clear every local
      // position on this (accountId, symbol) regardless of strategy, rather
      // than waiting for position.closed WS events that may be dropped.
      // handlePositionClosed is idempotent, so a later real event is harmless.
      for (const p of positions.filter(p => p.accountId === pos.accountId && p.symbol === pos.symbol)) {
        await handlePositionClosed({
          accountId: p.accountId, strategy: p.strategy, symbol: p.symbol,
          signalId: p.signalId, realizedPnl: null,
        });
      }
      logger.warn(`[EOD-FLAT] ${pos.accountId} ${pos.symbol} verified flat`);
    } else {
      await haltTradingForFailedFlatten({ ...pos, kind: 'eod' }, detail);
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

// Flatten any open position whose elapsed time since `openedAt` exceeds its
// `maxHoldBars` (interpreted as minutes, matching the backtest engine's 1 bar
// = 1 minute convention). Uses the hardened broker liquidate+verify path so
// the close cancels the bracket AND confirms flat — the old path synthesized a
// directional market order without cancelling the bracket, so the leftover
// stop could later fire and reopen a naked position on the opposite side.
// `closeRequested` suppresses repeat firings while a flatten is in flight and
// after a failure (which trips the kill switch and needs manual recovery).
async function checkMaxHold() {
  const now = Date.now();
  // Snapshot: handlePositionClosed mutates state.openPositions during the loop.
  for (const pos of [...state.openPositions.values()]) {
    if (pos.closeRequested) continue;
    if (!pos.maxHoldBars || pos.maxHoldBars <= 0) continue;
    if (pos.side === 'flat' || pos.netPos === 0) continue;
    const openedMs = Date.parse(pos.openedAt);
    if (!openedMs) continue;
    const elapsedMin = (now - openedMs) / 60_000;
    if (elapsedMin < pos.maxHoldBars) continue;

    pos.closeRequested = true;
    logger.warn(`[MAX-HOLD] ${pos.accountId} ${pos.strategy} ${pos.symbol} ${pos.side} ${pos.netPos} held ${elapsedMin.toFixed(1)}min >= ${pos.maxHoldBars}min — flattening at broker`);

    const { flat, detail } = await flattenAtBroker(pos.accountId, pos.symbol, { reason: 'max_hold_exceeded' });
    if (flat) {
      // Broker verified flat + brackets cancelled. Clear local state now rather
      // than waiting for a position.closed WS event that may be dropped (the
      // desync that left the slot stuck). handlePositionClosed is idempotent.
      await handlePositionClosed({
        accountId: pos.accountId, strategy: pos.strategy, symbol: pos.symbol,
        signalId: pos.signalId, realizedPnl: null,
      });
      logger.warn(`[MAX-HOLD] ${pos.accountId} ${pos.strategy} ${pos.symbol} verified flat — slot released`);
    } else {
      // Leave closeRequested set so we don't hammer the broker every tick;
      // halting requires manual recovery anyway.
      await haltTradingForFailedFlatten({ ...pos, kind: 'max-hold' }, detail);
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
      return false;
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
      // Parse the connector result so we don't treat a broker-side failure
      // (e.g. OSO modify 404) as success just because the HTTP call returned.
      const body = await res.json().catch(() => ({}));
      const ok = res.ok && body?.ok !== false;
      if (!ok) {
        logger.error(`[ExitRule] modify-stop FAILED: ${accountId} ${symbol} → ${newStopPrice} | HTTP ${res.status} ok=${body?.ok} reason=${body?.reason || body?.error || ''} strategyId=${body?.strategyId ?? '?'}`);
        return false;
      }
      logger.info(`[ExitRule] modify-stop CONFIRMED: ${accountId} ${symbol} → ${newStopPrice} via strategyId=${body?.strategyId ?? '?'} (${payload.reason})`);
      return true;
    } catch (err) {
      logger.error(`[ExitRule] modify-stop fetch failed: ${err.message}`);
      return false;
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
    const url = `${TRADOVATE_SERVICE_URL}/accounts/${encodeURIComponent(pending.accountId)}/cancel/${encodeURIComponent(pending.signalId)}?symbol=${encodeURIComponent(pending.symbol)}`;
    try {
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        logger.error(`[STALE-LIMIT] cancel HTTP ${res.status} url=${url}: ${await res.text().catch(() => '')}`);
        pending.cancelRequested = false; // allow retry on next poll
      }
    } catch (err) {
      const cause = err.cause ? `cause=${err.cause.code || err.cause.name || ''} ${err.cause.message || err.cause}` : '';
      logger.error(`[STALE-LIMIT] cancel failed url=${url} msg="${err.message}" ${cause}`);
      pending.cancelRequested = false; // allow retry on next poll
    }
  }
}

// Pre-fill-extreme cancellation: for limit orders that have opted in via
// signal.cancelOnPreFillExtreme, cancel the pending limit if price reaches
// the stop or target BEFORE the limit fills. The trade thesis behind these
// signals (structural retrace setups, e.g. ls-flip-trigger-bar) requires
// the market to come back to the limit price; running past the bar's
// extremes invalidates the setup. Without this watcher, the limit just
// times out via timeoutCandles minutes later — by which point spot may be
// at the target with no entry, or already past the stop with no fill.
//
// Mirrors the backtest engine's `cancelOnPreFillExtreme` flag in
// trade-simulator.js. Opt-in per signal, so other strategies (which leave
// the flag undefined) are unaffected.
async function checkPreFillExtremes(priceMsg) {
  if (!priceMsg) return;
  const baseSymbol = priceMsg.baseSymbol;
  if (!baseSymbol) return;
  const high = Number.isFinite(priceMsg.high) ? priceMsg.high : null;
  const low = Number.isFinite(priceMsg.low) ? priceMsg.low : null;
  const close = Number.isFinite(priceMsg.close) ? priceMsg.close : null;
  if (high == null && low == null && close == null) return;
  // price.update.candleTimestamp is epoch SECONDS (bar start); pending.requestedAt
  // is ms. Convert so we can tell whether this bar is fully after placement.
  const barStartMs = Number.isFinite(priceMsg.candleTimestamp) ? priceMsg.candleTimestamp * 1000 : null;

  for (const pending of state.pendingOrders.values()) {
    if (!pending.cancelOnPreFillExtreme) continue;
    if (pending.cancelRequested) continue;
    if (pending.action !== 'place_limit') continue;
    if (!pending.signalId) continue;
    if (pending.preFillStopLoss == null || pending.preFillTakeProfit == null) continue;
    if (extractUnderlying(pending.symbol) !== baseSymbol) continue;

    // Only evaluate price SINCE this order was placed. Using the rolling bar's
    // high/low when the bar predates placement cancels every order on the first
    // tick (its range straddles the tight bracket). See effectivePreFillExtremes.
    const { high: evalHigh, low: evalLow } = effectivePreFillExtremes({
      barStartMs, placedAtMs: pending.requestedAt, high, low, close,
    });
    if (evalHigh == null && evalLow == null) continue;

    const crossed = shouldCancelOnPreFillExtreme(
      pending.direction,
      pending.preFillStopLoss,
      pending.preFillTakeProfit,
      evalHigh,
      evalLow,
    );
    if (!crossed) continue;

    pending.cancelRequested = true;
    logger.warn(`[PRE-FILL-CANCEL] ${pending.accountId} ${pending.strategy} ${pending.symbol} ${pending.direction} — ${crossed} — cancelling pending limit`);
    const url = `${TRADOVATE_SERVICE_URL}/accounts/${encodeURIComponent(pending.accountId)}/cancel/${encodeURIComponent(pending.signalId)}?symbol=${encodeURIComponent(pending.symbol)}`;
    try {
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        logger.error(`[PRE-FILL-CANCEL] cancel HTTP ${res.status} url=${url}: ${await res.text().catch(() => '')}`);
        pending.cancelRequested = false; // allow retry on next tick
      }
    } catch (err) {
      const cause = err.cause ? `cause=${err.cause.code || err.cause.name || ''} ${err.cause.message || err.cause}` : '';
      logger.error(`[PRE-FILL-CANCEL] cancel failed url=${url} msg="${err.message}" ${cause}`);
      pending.cancelRequested = false;
    }
  }
}

async function probeTradovateService() {
  const url = `${TRADOVATE_SERVICE_URL}/health`;
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { method: 'GET' });
    const body = await res.text().catch(() => '');
    const elapsedMs = Date.now() - startedAt;
    if (res.ok) {
      logger.info(`[PROBE] tradovate-service OK ${res.status} url=${url} elapsed=${elapsedMs}ms body=${body.slice(0, 200)}`);
    } else {
      logger.warn(`[PROBE] tradovate-service HTTP ${res.status} url=${url} elapsed=${elapsedMs}ms body=${body.slice(0, 200)}`);
    }
  } catch (err) {
    const cause = err.cause ? `cause=${err.cause.code || err.cause.name || ''} ${err.cause.message || err.cause}` : '';
    const elapsedMs = Date.now() - startedAt;
    logger.error(`[PROBE] tradovate-service UNREACHABLE url=${url} elapsed=${elapsedMs}ms msg="${err.message}" ${cause}`);
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
  await loadGammaFilterEnabled(redis);
  await loadContractMappings(redis);
  await loadPositionSizing(redis);
  await loadTbRules(redis);
  await restoreOpenPositions(redis);
  await restoreSignalDefaults(redis);
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
    // Pre-fill-extreme cancel watcher (opt-in per signal via
    // cancelOnPreFillExtreme). Fires fire-and-forget — errors are logged
    // inside, won't propagate.
    checkPreFillExtremes(msg).catch(err =>
      logger.error(`[PRE-FILL-CANCEL] watcher threw: ${err.message}`));
  });
  await messageBus.subscribe(CHANNELS.CANDLE_CLOSE, (msg) => {
    try { exitRuleManager.onCandleClose(msg); }
    catch (err) { logger.error(`[ExitRule] onCandleClose threw: ${err.message}`); }
  });
  await messageBus.subscribe(CHANNELS.LS_STATUS, (msg) => {
    try { exitRuleManager.onLsFlip(msg); }
    catch (err) { logger.error(`[ExitRule] onLsFlip threw: ${err.message}`); }
  });
  await messageBus.subscribe(CHANNELS.GEX_LEVELS, handleGexLevels);
  await messageBus.subscribe(CHANNELS.POSITION_OPENED, handlePositionOpened);
  await messageBus.subscribe(CHANNELS.POSITION_CLOSED, handlePositionClosed);
  await messageBus.subscribe(CHANNELS.POSITION_UPDATE, handlePositionUpdate);
  await messageBus.subscribe(CHANNELS.POSITION_SNAPSHOT, handlePositionSnapshot);
  await messageBus.subscribe(CHANNELS.ORDERS_SNAPSHOT, handleOrdersSnapshot);
  await messageBus.subscribe(ACCOUNT_CHANNEL, handleAccountChanged);
  await messageBus.subscribe(ROUTES_CHANNEL, () => logger.info('routes.changed — next signal picks up new config'));
  // Live-reload position sizing when changed via the dashboard. Previously the
  // orchestrator only read config:position-sizing at startup, so dashboard
  // changes (e.g. fixedQuantity 1→3) silently had no effect until a restart.
  await messageBus.subscribe(CHANNELS.CONFIG_POSITION_SIZING, async (settings) => {
    if (settings && typeof settings === 'object' && Number.isFinite(settings.fixedQuantity)) {
      state.positionSizing = settings;
      logger.info(`config.position-sizing.changed — reloaded live: ${JSON.stringify(state.positionSizing)}`);
    } else {
      // Malformed payload — re-read the authoritative Redis copy instead.
      await loadPositionSizing(redis);
    }
  });

  logger.info(`Subscribed to trade.signal, order.*, position.*, ${ACCOUNT_CHANNEL}, ${ROUTES_CHANNEL}, ${CHANNELS.CONFIG_POSITION_SIZING}`);

  const app = buildApp();
  app.listen(PORT, BIND_HOST, () => logger.info(`Orchestrator listening on ${BIND_HOST}:${PORT}`));

  setInterval(() => checkpointOpenPositions(redis), 30_000).unref();
  // Persist signalDefaults less frequently (it only grows on signal route,
  // and FIFO eviction + 24h TTL keep it bounded). Independent cadence so a
  // bursty signal day doesn't amplify Redis writes.
  setInterval(() => checkpointSignalDefaults(redis), 60_000).unref();

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

  // One-shot reachability probe: does the orchestrator pod actually have a
  // network path to TRADOVATE_SERVICE_URL? Logs the DNS/socket-level cause if
  // not, so we can tell DNS misconfig apart from per-endpoint bugs.
  probeTradovateService().catch(() => {});

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
