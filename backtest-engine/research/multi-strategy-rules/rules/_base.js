// Shared event-driven Model-B simulator.
// Treats the merged trade timeline as a stream of {entry-signal, native-exit} events.
// Rule handlers decide whether to open / reject / flip / preempt on each event.
//
// Exit-attribution policy:
//   * If we hold a trade through its own native-exit, take its `netPnL` verbatim.
//   * If a rule synthesizes an early close (flip / preempt / confluence first-exit),
//     compute PnL from `actualEntry` → synthetic-exit-price using POINT_VALUE × pts
//     minus commission. These synthetic closes are counted (`syntheticExits`) so the
//     SUMMARY can weight conclusions by how much of a rule's PnL leans on estimates.

import { priorityFor, POINT_VALUE_NQ, COMMISSION_NQ } from '../lib/load-trades.js';

export function simulate(allTrades, ruleHandler) {
  const events = [];
  for (const t of allTrades) {
    events.push({ ts: t.entryTime, kind: 'entry-signal', trade: t });
    events.push({ ts: t.exitTime,  kind: 'native-exit',  trade: t });
  }
  // Ordering at exact-equal ts:
  //   1) For events belonging to the SAME trade (zero-duration entry+exit): entry must
  //      come before exit so the trade opens and closes in sequence.
  //   2) For events belonging to DIFFERENT trades at the same ts: native-exit before
  //      entry-signal (frees the slot so the new entry can be accepted).
  //   3) Among entry-signals at same ts: higher priority first (lower priority number).
  events.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.trade.id === b.trade.id) {
      // Same trade: entry-signal before native-exit.
      return a.kind === 'entry-signal' ? -1 : 1;
    }
    if (a.kind !== b.kind) return a.kind === 'native-exit' ? -1 : 1;
    if (a.kind === 'entry-signal') {
      return priorityFor(a.trade.strategyKey) - priorityFor(b.trade.strategyKey);
    }
    return 0;
  });

  const state = {
    position: null,                 // { trade, openedAt, clusterIds? }
    activeByStrategy: new Map(),    // strategyKey → trade (latest native-active per strategy)
    realizedTrades: [],
    accepted: 0,
    rejected: 0,
    syntheticExits: 0,
  };

  if (ruleHandler.init) ruleHandler.init(state);

  for (const ev of events) {
    if (ev.kind === 'entry-signal') {
      state.activeByStrategy.set(ev.trade.strategyKey, ev.trade);
      ruleHandler.onSignal(state, ev.trade);
    } else {
      // native-exit always clears it from activeByStrategy first
      const curr = state.activeByStrategy.get(ev.trade.strategyKey);
      if (curr && curr.id === ev.trade.id) state.activeByStrategy.delete(ev.trade.strategyKey);
      ruleHandler.onNativeExit(state, ev.trade);
    }
    invariantCheck(state, ruleHandler.name);
  }

  // If something is still open at the end of the stream (no native exit seen due to
  // boundary truncation), close it at its own actualExit/netPnL.
  if (state.position) {
    realizeNativeClose(state, state.position.trade);
  }

  return state;
}

function invariantCheck(state, ruleName) {
  if (state.position && Array.isArray(state.position)) {
    throw new Error(`[${ruleName}] Model B invariant violated: position is an array, expected single object or null`);
  }
}

// ── Helpers exposed to rules ────────────────────────────────────────────────

export function open(state, trade, extras = {}) {
  if (state.position) {
    throw new Error(`open() called while position is not null: ${state.position.trade.id} -> ${trade.id}`);
  }
  state.position = { trade, openedAt: trade.entryTime, ...extras };
  state.accepted += 1;
}

export function reject(state) {
  state.rejected += 1;
}

// Close at the trade's own native exit price/PnL (no synthesis).
export function realizeNativeClose(state, trade) {
  state.realizedTrades.push({
    portfolioId: state.realizedTrades.length + 1,
    strategyKey: trade.strategyKey,
    nativeId: trade.nativeId,
    side: trade.side,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    actualEntry: trade.actualEntry,
    actualExit: trade.actualExit,
    netPnL: trade.netPnL,
    pointsPnL: trade.pointsPnL,
    exitReason: trade.exitReason,
    duration: trade.duration,
    synthetic: false,
  });
  state.position = null;
}

// Close the currently-held position at an arbitrary timestamp and price.
// Used for flip-on-conflict / preempt / confluence-first-exit.
export function realizeSyntheticClose(state, atTs, atPx, reason) {
  if (!state.position) return;
  const t = state.position.trade;
  const ptsDelta = t.side === 'long' ? (atPx - t.actualEntry) : (t.actualEntry - atPx);
  const grossPnL = ptsDelta * POINT_VALUE_NQ;
  const netPnL = grossPnL - COMMISSION_NQ;
  state.realizedTrades.push({
    portfolioId: state.realizedTrades.length + 1,
    strategyKey: t.strategyKey,
    nativeId: t.nativeId,
    side: t.side,
    entryTime: t.entryTime,
    exitTime: atTs,
    actualEntry: t.actualEntry,
    actualExit: atPx,
    netPnL,
    pointsPnL: ptsDelta,
    exitReason: reason,
    duration: atTs - t.entryTime,
    synthetic: true,
  });
  state.position = null;
  state.syntheticExits += 1;
}
