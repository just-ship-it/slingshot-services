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

import { shouldCancelOnPreFillExtreme } from '../src/pre-fill-cancel.js';

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

// --- Unknown direction ---
ok(shouldCancelOnPreFillExtreme('unknown', 90, 110, 200, 0) === null, 'unknown direction should never cancel');

// --- Direction-asymmetry sanity ---
// A long-only test set must NOT trigger from short logic, and vice versa.
ok(buy(95, 92) === null, 'BUY: a normal pullback toward entry should NOT cancel');
ok(sell(108, 105) === null, 'SELL: a normal bounce toward entry should NOT cancel');

console.log(`OK — ${passes} pre-fill-cancel scenarios passed`);
