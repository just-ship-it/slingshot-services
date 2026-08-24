/**
 * Smoke test for the live-path additions for the pattern strategies:
 *
 *   1. normalizeOrderType — place_stop → 'Stop' (plus existing mappings and
 *      invalid-action rejection), isWorkingEntryAction.
 *   2. shouldCancelOnCloseBeyond / normalizeCancelOnCloseBeyond — the 1m
 *      candle.close cancel-on-close-beyond trigger logic (fvg-bear).
 *   3. computeSignalExpiry — exemptEodCutoff removes the EOD leg (24/7
 *      strategies); default behavior unchanged for everything else.
 *
 * No test framework — run from the trade-orchestrator/ directory:
 *   node test/live-path-additions.test.js
 *
 * All checks pass → exits 0 with a summary line. Any failure prints the
 * failing scenario and exits 1.
 */

import {
  normalizeOrderType,
  isWorkingEntryAction,
  computeSignalExpiry,
  nextEodCutoffTs,
} from '../src/signal-lifecycle.js';
import {
  shouldCancelOnCloseBeyond,
  normalizeCancelOnCloseBeyond,
} from '../src/pre-fill-cancel.js';

let passes = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passes++;
}

// ---------- 1. normalizeOrderType ----------

assert(normalizeOrderType('place_market') === 'Market', 'place_market → Market');
assert(normalizeOrderType('place_limit') === 'Limit', 'place_limit → Limit');
assert(normalizeOrderType('place_stop') === 'Stop', 'place_stop → Stop');
assert(normalizeOrderType('PLACE_STOP') === 'Stop', 'case-insensitive place_stop');
assert(normalizeOrderType('cancel_limit') === null, 'cancel_limit not routable');
assert(normalizeOrderType('position_closed') === null, 'position_closed not routable');
assert(normalizeOrderType(undefined) === null, 'undefined action → null');
assert(normalizeOrderType('') === null, 'empty action → null');

assert(isWorkingEntryAction('place_limit') === true, 'limit is working entry');
assert(isWorkingEntryAction('place_stop') === true, 'stop is working entry');
assert(isWorkingEntryAction('place_market') === false, 'market never rests');
assert(isWorkingEntryAction(undefined) === false, 'undefined not working entry');

// ---------- 2. cancel-on-close-beyond ----------

// Field sanitizer
assert(normalizeCancelOnCloseBeyond({ price: 23000, side: 'above' })?.price === 23000, 'valid cfg accepted');
assert(normalizeCancelOnCloseBeyond({ price: '23000', side: 'BELOW' })?.side === 'below', 'string price + uppercase side coerced');
assert(normalizeCancelOnCloseBeyond({ price: NaN, side: 'above' }) === null, 'NaN price rejected');
assert(normalizeCancelOnCloseBeyond({ price: 23000, side: 'up' }) === null, 'bad side rejected');
assert(normalizeCancelOnCloseBeyond(true) === null, 'boolean flag rejected');
assert(normalizeCancelOnCloseBeyond(null) === null, 'null rejected');
assert(normalizeCancelOnCloseBeyond(undefined) === null, 'undefined rejected');

const T = Date.parse('2026-08-18T14:00:00Z'); // order placed
const barAfter = Date.parse('2026-08-18T14:01:00Z');   // bar 14:01–14:02, closes 14:02 > T
const barBefore = Date.parse('2026-08-18T13:58:00Z');  // closes 13:59 <= T
const barTrigger = Date.parse('2026-08-18T13:59:00Z'); // trigger bar: closes exactly at T

function mkPending(over = {}) {
  return {
    cancelOnCloseBeyond: { price: 23000, side: 'above' },
    cancelRequested: false,
    action: 'place_limit',
    signalId: 'sig-1',
    underlying: 'NQ',
    requestedAt: T,
    ...over,
  };
}
const bar = (close, barStartMs = barAfter, product = 'NQ') => ({ product, close, barStartMs });

// Direction/threshold semantics — strictly beyond
assert(shouldCancelOnCloseBeyond(mkPending(), bar(23001)) === true, 'close above level cancels (side=above)');
assert(shouldCancelOnCloseBeyond(mkPending(), bar(23000)) === false, 'close AT level does not cancel (strict)');
assert(shouldCancelOnCloseBeyond(mkPending(), bar(22999)) === false, 'close below level does not cancel (side=above)');
const below = mkPending({ cancelOnCloseBeyond: { price: 22800, side: 'below' } });
assert(shouldCancelOnCloseBeyond(below, bar(22799)) === true, 'close below level cancels (side=below)');
assert(shouldCancelOnCloseBeyond(below, bar(22800)) === false, 'close AT level does not cancel (side=below)');
assert(shouldCancelOnCloseBeyond(below, bar(22801)) === false, 'close above level does not cancel (side=below)');

// Opt-in / shape gating
assert(shouldCancelOnCloseBeyond(mkPending({ cancelOnCloseBeyond: undefined }), bar(23500)) === false, 'no cfg → off');
assert(shouldCancelOnCloseBeyond(mkPending({ cancelOnCloseBeyond: true }), bar(23500)) === false, 'malformed cfg → off');
assert(shouldCancelOnCloseBeyond(mkPending({ cancelRequested: true }), bar(23500)) === false, 'already cancelling → skip');
assert(shouldCancelOnCloseBeyond(mkPending({ action: 'place_market' }), bar(23500)) === false, 'market entry never resting → skip');
assert(shouldCancelOnCloseBeyond(mkPending({ action: 'place_stop' }), bar(23500)) === true, 'stop entry is a working order → cancellable');
assert(shouldCancelOnCloseBeyond(mkPending({ signalId: null }), bar(23500)) === false, 'no signalId → cannot cancel');
assert(shouldCancelOnCloseBeyond(mkPending(), bar(23500, barAfter, 'ES')) === false, 'product mismatch → skip');
assert(shouldCancelOnCloseBeyond(mkPending(), bar(NaN)) === false, 'non-numeric close → skip');

// Trigger-bar guard: bars that closed at/before placement must not cancel
assert(shouldCancelOnCloseBeyond(mkPending(), bar(23500, barBefore)) === false, 'bar closed before placement → skip');
assert(shouldCancelOnCloseBeyond(mkPending(), bar(23500, barTrigger)) === false, 'signal trigger bar (closes exactly at placement) → skip');
assert(shouldCancelOnCloseBeyond(mkPending(), bar(23500, barAfter)) === true, 'first bar closing after placement → evaluated');
assert(shouldCancelOnCloseBeyond(mkPending(), bar(23500, null)) === true, 'missing bar ts → fail open (evaluate)');

// ---------- 3. computeSignalExpiry EOD exemption ----------

// Anchor: Tue 2026-08-18 10:00 ET (14:00 UTC, EDT). Cutoff 16:40 ET = 20:40 UTC.
const CUTOFF = '16:40';
const eodExpected = Date.parse('2026-08-18T20:40:00Z');
assert(nextEodCutoffTs(T, CUTOFF) === eodExpected, `nextEodCutoffTs anchors to 16:40 ET same day (got ${new Date(nextEodCutoffTs(T, CUTOFF)).toISOString()})`);
assert(nextEodCutoffTs(T, '') === null, 'empty cutoff disables EOD leg');

// Baseline behavior (no exemption flag) — unchanged
let r = computeSignalExpiry({ maxHoldBars: 30 }, T, CUTOFF);
assert(r.expiryReason === 'max_hold', 'short maxHold binds before EOD');
assert(r.expiresAt === new Date(T + 30 * 60_000).toISOString(), 'max_hold expiry = anchor+30min');
assert(r.eodCutoffEt === CUTOFF, 'eodCutoffEt reported for non-exempt');

r = computeSignalExpiry({ maxHoldBars: 480 }, T, CUTOFF); // 8h > 6h40m to cutoff
assert(r.expiryReason === 'eod', 'long maxHold: EOD binds first');
assert(r.expiresAt === new Date(eodExpected).toISOString(), 'eod expiry = cutoff ts');

r = computeSignalExpiry({}, T, CUTOFF);
assert(r.expiryReason === 'eod', 'no maxHold: EOD only');

r = computeSignalExpiry({}, T, '');
assert(r.expiresAt === null && r.expiryReason === null, 'no maxHold + no cutoff: no expiry');

// Exemption: expiry = max-hold only, EOD leg gone
r = computeSignalExpiry({ maxHoldBars: 480, exemptEodCutoff: true }, T, CUTOFF);
assert(r.expiryReason === 'max_hold', 'exempt: maxHold binds even past cutoff');
assert(r.expiresAt === new Date(T + 480 * 60_000).toISOString(), 'exempt: expiry = anchor+480min');
assert(r.eodCutoffEt === null, 'exempt: eodCutoffEt reported null');

r = computeSignalExpiry({ maxHoldBars: 30, exemptEodCutoff: true }, T, CUTOFF);
assert(r.expiryReason === 'max_hold' && r.expiresAt === new Date(T + 30 * 60_000).toISOString(), 'exempt + short maxHold unchanged');

r = computeSignalExpiry({ exemptEodCutoff: true }, T, CUTOFF);
assert(r.expiresAt === null && r.expiryReason === null, 'exempt + no maxHold: no expiry at all');

// Opt-in strictness: only boolean true exempts
r = computeSignalExpiry({ maxHoldBars: 480, exemptEodCutoff: 'true' }, T, CUTOFF);
assert(r.expiryReason === 'eod', "string 'true' does NOT exempt (strict === true)");
r = computeSignalExpiry({ maxHoldBars: 480, exemptEodCutoff: false }, T, CUTOFF);
assert(r.expiryReason === 'eod', 'exemptEodCutoff:false → default behavior');

// Position-level EOD filter semantics (mirror of checkEodForceFlat's split)
{
  const positions = [
    { strategy: 'fvg-bear', exemptEodCutoff: true, side: 'short', netPos: -1 },
    { strategy: 'gex-level-fade', side: 'long', netPos: 1 },
    { strategy: 'legacy-undefined-field', exemptEodCutoff: undefined, side: 'long', netPos: 2 },
  ];
  const toFlatten = positions.filter(p => p.exemptEodCutoff !== true);
  assert(toFlatten.length === 2, 'EOD flatten skips only exempt positions');
  assert(!toFlatten.some(p => p.strategy === 'fvg-bear'), 'exempt strategy survives EOD filter');
}

console.log(`live-path-additions: all ${passes} checks passed`);
