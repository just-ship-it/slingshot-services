/**
 * Smoke test for the pre-fill-extreme cancel detection.
 *
 * Verifies that shouldCancelOnPreFillExtreme correctly identifies the four
 * cancel scenarios (BUY-TP, BUY-SL, SELL-TP, SELL-SL) and stays silent in
 * the non-trigger cases (price between stop and target, missing high/low,
 * etc.). Run from the trade-orchestrator/ directory:
 *
 *   node test/pre-fill-extreme-cancel.test.js
 *
 * If all checks pass, exits 0 with one summary line. Any failure prints the
 * failing scenario and exits 1.
 */

import { shouldCancelOnPreFillExtreme, effectivePreFillExtremes, shouldCancelOnAdverseLsFlip, shouldCancelPendingOnFlip } from '../src/pre-fill-cancel.js';

let passes = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passes++;
}

// --- BUY limit @ 100, SL 90, TP 110 ---
const buy = (high, low) => shouldCancelOnPreFillExtreme('buy', 90, 110, high, low);

ok(buy(105, 95) === null, 'BUY: bar inside SL/TP envelope should not cancel');
ok(buy(110, 100) !== null && /TP-first/.test(buy(110, 100)), 'BUY: high touches TP exactly should cancel as TP-first');
ok(buy(112, 100) !== null && /TP-first/.test(buy(112, 100)), 'BUY: high past TP should cancel as TP-first');
ok(buy(101, 90) !== null && /SL-first/.test(buy(101, 90)), 'BUY: low touches SL exactly should cancel as SL-first');
ok(buy(101, 88) !== null && /SL-first/.test(buy(101, 88)), 'BUY: low past SL should cancel as SL-first');
ok(buy(112, 88) !== null, 'BUY: bar straddles both (engulfing) should cancel — TP wins (checked first)');
ok(/TP-first/.test(buy(112, 88)), 'BUY: engulfing bar reports TP-first (deterministic ordering)');

// --- SELL limit @ 100, SL 110, TP 90 ---
const sell = (high, low) => shouldCancelOnPreFillExtreme('sell', 110, 90, high, low);

ok(sell(105, 95) === null, 'SELL: bar inside SL/TP envelope should not cancel');
ok(sell(105, 90) !== null && /TP-first/.test(sell(105, 90)), 'SELL: low touches TP (below) exactly should cancel as TP-first');
ok(sell(105, 88) !== null && /TP-first/.test(sell(105, 88)), 'SELL: low past TP should cancel as TP-first');
ok(sell(110, 95) !== null && /SL-first/.test(sell(110, 95)), 'SELL: high touches SL (above) exactly should cancel as SL-first');
ok(sell(112, 95) !== null && /SL-first/.test(sell(112, 95)), 'SELL: high past SL should cancel as SL-first');
ok(sell(112, 88) !== null, 'SELL: bar straddles both should cancel — TP wins (checked first)');
ok(/TP-first/.test(sell(112, 88)), 'SELL: engulfing bar reports TP-first (deterministic ordering)');

// --- Null guard cases ---
ok(buy(null, null) === null, 'BUY: both high and low null should not cancel');
ok(sell(null, null) === null, 'SELL: both high and low null should not cancel');
ok(buy(null, 88) !== null && /SL-first/.test(buy(null, 88)), 'BUY: null high but low past SL should still cancel');
ok(buy(112, null) !== null && /TP-first/.test(buy(112, null)), 'BUY: null low but high past TP should still cancel');
ok(buy(105, null) === null, 'BUY: null low and high inside envelope should not cancel');

// --- 'long'/'short' vocabulary (the value the orchestrator actually stores
//      on pending.direction via normalizeDirection — must behave like buy/sell).
//      Regression: passing 'long'/'short' previously matched neither branch and
//      silently returned null, so the live cancel never fired. ---
const long = (high, low) => shouldCancelOnPreFillExtreme('long', 90, 110, high, low);
const short = (high, low) => shouldCancelOnPreFillExtreme('short', 110, 90, high, low);
ok(long(112, 100) !== null && /TP-first/.test(long(112, 100)), "'long': high past TP should cancel (treated as buy)");
ok(long(101, 88) !== null && /SL-first/.test(long(101, 88)), "'long': low past SL should cancel (treated as buy)");
ok(long(105, 95) === null, "'long': bar inside envelope should not cancel");
ok(short(105, 88) !== null && /TP-first/.test(short(105, 88)), "'short': low past TP should cancel (treated as sell)");
ok(short(112, 95) !== null && /SL-first/.test(short(112, 95)), "'short': high past SL should cancel (treated as sell)");
ok(short(105, 95) === null, "'short': bar inside envelope should not cancel");

// --- Unknown direction ---
ok(shouldCancelOnPreFillExtreme('unknown', 90, 110, 200, 0) === null, 'unknown direction should never cancel');

// --- Direction-asymmetry sanity ---
// A long-only test set must NOT trigger from short logic, and vice versa.
ok(buy(95, 92) === null, 'BUY: a normal pullback toward entry should NOT cancel');
ok(sell(108, 105) === null, 'SELL: a normal bounce toward entry should NOT cancel');

// --- effectivePreFillExtremes: only price SINCE placement counts ---
// A 1m bar that started at 10:05:00 (300000 ms) while the order was placed at
// 10:05:30 (330000 ms) is the in-progress placement bar — its high/low predate
// the order, so we must fall back to the live close.
const placedAt = 330_000;
const placementBar = { barStartMs: 300_000, placedAtMs: placedAt, high: 110, low: 80, close: 95 };
const eb1 = effectivePreFillExtremes(placementBar);
ok(eb1.high === 95 && eb1.low === 95, 'placement-bar (started before placement) → use live close, NOT bar high/low');

// A bar that started at/after placement is fully post-placement → use high/low.
const cleanBar = { barStartMs: 360_000, placedAtMs: placedAt, high: 112, low: 100, close: 105 };
const eb2 = effectivePreFillExtremes(cleanBar);
ok(eb2.high === 112 && eb2.low === 100, 'post-placement bar → use bar high/low');

// Unknown bar start (no candleTimestamp) → safe fallback to close.
const eb3 = effectivePreFillExtremes({ barStartMs: null, placedAtMs: placedAt, high: 999, low: 0, close: 95 });
ok(eb3.high === 95 && eb3.low === 95, 'unknown bar start → fall back to live close');

// Regression for the live incident: contaminated placement bar straddles the
// tight bracket (SL 90 / TP 110), but the live close (95) is inside it → a
// long limit must NOT be cancelled on arrival.
const e = effectivePreFillExtremes(placementBar);
ok(shouldCancelOnPreFillExtreme('long', 90, 110, e.high, e.low) === null,
   'REGRESSION: lstb long not cancelled on arrival when only the pre-placement bar range straddles the bracket');

// --- adverse-LS-flip cancel (sign-critical: long cancels on BEARISH, short on BULLISH) ---
// lstb enters long on a BULLISH flip and short on a BEARISH flip; a pending
// limit is invalidated only when the LS flips back the OPPOSITE way before fill.
ok(shouldCancelOnAdverseLsFlip('long', 'BEARISH') === true, 'long pending cancels on BEARISH flip');
ok(shouldCancelOnAdverseLsFlip('short', 'BULLISH') === true, 'short pending cancels on BULLISH flip');
ok(shouldCancelOnAdverseLsFlip('long', 'BULLISH') === false, 'long NOT cancelled by aligned/creating BULLISH flip');
ok(shouldCancelOnAdverseLsFlip('short', 'BEARISH') === false, 'short NOT cancelled by aligned/creating BEARISH flip');
ok(shouldCancelOnAdverseLsFlip('buy', 'BEARISH') === true, 'buy vocabulary also cancels on BEARISH');
ok(shouldCancelOnAdverseLsFlip('sell', 'BULLISH') === true, 'sell vocabulary also cancels on BULLISH');
ok(shouldCancelOnAdverseLsFlip('long', 'sideways') === false, 'unknown sentiment never cancels');
ok(shouldCancelOnAdverseLsFlip('na', 'BEARISH') === false, 'unknown direction never cancels');

// --- full per-order decision (shouldCancelPendingOnFlip): opt-in, shape,
// product match, stale-flip guard ---
const basePending = {
  cancelOnAdverseLsFlip: true,
  cancelRequested: false,
  action: 'place_limit',
  signalId: 'sig-1',
  direction: 'long',
  adverseFlipCreatedTs: 1_700_000_000_000,   // creating flip (ms)
  underlying: 'NQ',
};
const LATER = 1_700_000_060_000;   // +60s: a genuine subsequent flip
const CREATING = 1_700_000_000_000;

ok(shouldCancelPendingOnFlip(basePending, 'NQ', 'BEARISH', LATER) === true,
   'pending lstb long cancelled by later BEARISH flip');
ok(shouldCancelPendingOnFlip(basePending, 'NQ', 'BEARISH', CREATING) === false,
   'STALE GUARD: the creating flip itself (ts equal) must not self-cancel');
ok(shouldCancelPendingOnFlip(basePending, 'NQ', 'BEARISH', CREATING - 1000) === false,
   'STALE GUARD: an earlier/replayed flip must not cancel');
ok(shouldCancelPendingOnFlip(basePending, 'NQ', 'BEARISH', null) === true,
   'null flip ts (unknown) still cancels — fail toward the backtest behavior');
ok(shouldCancelPendingOnFlip({ ...basePending, adverseFlipCreatedTs: null }, 'NQ', 'BEARISH', LATER) === true,
   'missing creating-flip ts still cancels on a real adverse flip');
ok(shouldCancelPendingOnFlip(basePending, 'ES', 'BEARISH', LATER) === false,
   'product mismatch (ES flip vs NQ pending) never cancels');
ok(shouldCancelPendingOnFlip({ ...basePending, cancelOnAdverseLsFlip: false }, 'NQ', 'BEARISH', LATER) === false,
   'non-opted-in strategies are never cancelled');
ok(shouldCancelPendingOnFlip({ ...basePending, cancelOnAdverseLsFlip: undefined }, 'NQ', 'BEARISH', LATER) === false,
   'undefined opt-in (non-lstb signal) never cancels');
ok(shouldCancelPendingOnFlip({ ...basePending, cancelRequested: true }, 'NQ', 'BEARISH', LATER) === false,
   'already-requested cancel is not re-issued');
ok(shouldCancelPendingOnFlip({ ...basePending, action: 'place_market' }, 'NQ', 'BEARISH', LATER) === false,
   'only pending LIMITS are subject to the flip cancel');
ok(shouldCancelPendingOnFlip({ ...basePending, signalId: null }, 'NQ', 'BEARISH', LATER) === false,
   'no signalId → cannot address the cancel → skip');
ok(shouldCancelPendingOnFlip(basePending, 'NQ', 'BULLISH', LATER) === false,
   'aligned flip never cancels the long');
ok(shouldCancelPendingOnFlip({ ...basePending, direction: 'sell' }, 'NQ', 'BULLISH', LATER) === true,
   'sell-vocabulary pending cancelled by BULLISH flip');

console.log(`OK — ${passes} pre-fill-cancel scenarios passed`);
