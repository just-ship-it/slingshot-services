/**
 * STRUCTURAL VALIDATION strategy.
 *
 * Premise (per user's screenshot example): GEX resistance held for 75min
 * with 5+ rejections before failing → 200pt selloff. We should be:
 *   1. Validating the level held N≥2 times within the past 30min
 *   2. Entering on the next rejection (price wicked above, closed below)
 *   3. Using STRUCTURAL stop (just past the highest wick of prior rejections)
 *   4. Targeting an EXTENDED move (50-100pt, or next structural level)
 *   5. Holding 30-120 min, not 15
 *
 * Reuses the existing 27k touch dataset which has bounce/brk walks from t+60s.
 * Need to ADD prior-rejection-count feature.
 *
 * Then build outcomes at LONGER horizons (60min, 90min, 120min) and BIGGER
 * targets (30, 50, 80, 100, 150pt) — but these aren't in the original
 * dataset which only tracked up to 30min hold and targets up to 25pt.
 *
 * So step 1: rebuild walks with extended targets/holds (one-time cost).
 * Step 2: layer structural validation filter.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const DATA_DIR = `${ROOT}/data`;

// Load original touches (which have bounce/brk walks from t+60s for tight targets)
console.log('Loading existing touch dataset...');
const base = JSON.parse(fs.readFileSync(`${ROOT}/research/output/gex-touch-flow-2026-05-14T05-52-19-372Z.json`));
const touches = base.touches;
console.log(`Loaded ${touches.length.toLocaleString()} touches`);

const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall']);

// === STEP 1: Build prior-rejection feature for every touch ===
console.log('\nComputing prior-rejection counts per touch...');
// Group touches by (date, level_type, level_price) so we can scan history of the same level
// On the user's chart, R1 at 29,780 was touched repeatedly. In our data, R1 might move slightly
// across snapshots. Use a level-key with 1pt tolerance.

// Index touches by (date, level_type, rounded_price)
const touchesByDate = new Map();
for (const t of touches) {
  if (!touchesByDate.has(t.date)) touchesByDate.set(t.date, []);
  touchesByDate.get(t.date).push(t);
}

// Sort within day by ts
for (const arr of touchesByDate.values()) arr.sort((a, b) => a.ts - b.ts);

// For each touch, count prior touches of same level type within K minutes BEFORE it
const PRIOR_WINDOW_MIN = 30;  // look back 30 min
for (const [date, arr] of touchesByDate.entries()) {
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i];
    const tType = t.level_type;
    const tPrice = t.level_price;
    let count = 0;
    let lastRejectionDist = 0;  // max wick distance past level from prior rejections
    for (let j = i - 1; j >= 0; j--) {
      const p = arr[j];
      if (t.ts - p.ts > PRIOR_WINDOW_MIN * 60_000) break;
      // Same level: same type AND price within 2pt
      if (p.level_type === tType && Math.abs(p.level_price - tPrice) <= 2) {
        // Did the prior touch get REJECTED? For a resistance level being tested from below,
        // rejection = touch bar's high went past level but closed below. The dataset's
        // s1_max_wick_past_pts gives the max wick PAST the level during the touch minute.
        count++;
        if (p.s1?.s1_max_wick_past_pts > lastRejectionDist) lastRejectionDist = p.s1.s1_max_wick_past_pts;
      }
    }
    t.prior_touches = count;
    t.max_prior_wick = lastRejectionDist;
  }
}

// Distribution of prior_touches
const dist = new Map();
for (const t of touches) dist.set(t.prior_touches, (dist.get(t.prior_touches) || 0) + 1);
console.log(`Distribution of prior_touches in past ${PRIOR_WINDOW_MIN}min:`);
for (const [k, v] of [...dist.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${k}: ${v.toLocaleString()}`);
}

// === STEP 2: Outcome labels at LONGER horizons / BIGGER targets ===
// The existing dataset has walks up to 30min. Need to extend.
// Build a fresh 1s-honest walker for the matched events at longer horizons.

// First, define candidates by structural validation
console.log('\n=== Conditional WR by prior_touches (existing walks, T10/S5/H15) ===');
function labelWalk(walk, target, stop, holdMin) {
  if (!walk) return 'no_data';
  const tt = walk.time_to_target_sec?.[target];
  const ts = walk.time_to_stop_sec?.[stop];
  const hs = holdMin * 60;
  if (tt != null && tt <= hs && (ts == null || ts > hs || tt < ts)) return 'win';
  if (ts != null && ts <= hs) return 'loss';
  return 'timeout';
}

function evalSet(arr, dirField, target, stop, holdMin) {
  let w = 0, l = 0, to = 0;
  for (const t of arr) {
    const walk = t[dirField];
    const o = labelWalk(walk, target, stop, holdMin);
    if (o === 'win') w++;
    else if (o === 'loss') l++;
    else if (o === 'timeout') to++;
  }
  const n = w + l + to;
  return { n, w, l, to, wr: n > 0 ? w / n : 0, ev: n > 0 ? (w * target - l * stop) / n : 0 };
}

// Set bounceDir
for (const t of touches) {
  const isS = SUPPORT_TYPES.has(t.level_type), isR = RESIST_TYPES.has(t.level_type), isF = t.level_type === 'gamma_flip';
  if (isS || (isF && t.approach === 'from_above')) t.bounceDir = 'long';
  else if (isR || (isF && t.approach === 'from_below')) t.bounceDir = 'short';
}

const supports = touches.filter(t => SUPPORT_TYPES.has(t.level_type) && t.approach === 'from_above');
const resists = touches.filter(t => RESIST_TYPES.has(t.level_type) && t.approach === 'from_below');

console.log('SUPPORT touches (bounce long):');
for (const k of [0, 1, 2, 3, 4, 5]) {
  const arr = supports.filter(t => t.prior_touches === k);
  if (arr.length < 30) continue;
  const r = evalSet(arr, 'bounce', 10, 5, 15);
  const r2 = evalSet(arr, 'bounce', 15, 10, 30);
  const r3 = evalSet(arr, 'bounce', 20, 12, 30);
  console.log(`  prior_touches=${k}: n=${String(arr.length).padStart(5)}   T10/S5/H15: WR=${(r.wr*100).toFixed(1)}% EV=${r.ev.toFixed(2)}   T15/S10/H30: WR=${(r2.wr*100).toFixed(1)}% EV=${r2.ev.toFixed(2)}   T20/S12/H30: WR=${(r3.wr*100).toFixed(1)}% EV=${r3.ev.toFixed(2)}`);
}

console.log('\nSUPPORT touches with prior_touches >= K:');
for (const k of [1, 2, 3]) {
  const arr = supports.filter(t => t.prior_touches >= k);
  if (arr.length < 30) continue;
  const r = evalSet(arr, 'bounce', 10, 5, 15);
  const r2 = evalSet(arr, 'bounce', 15, 10, 30);
  const r3 = evalSet(arr, 'bounce', 20, 12, 30);
  console.log(`  prior_touches >= ${k}: n=${String(arr.length).padStart(5)}   T10/S5/H15: WR=${(r.wr*100).toFixed(1)}% EV=${r.ev.toFixed(2)}   T15/S10/H30: WR=${(r2.wr*100).toFixed(1)}% EV=${r2.ev.toFixed(2)}   T20/S12/H30: WR=${(r3.wr*100).toFixed(1)}% EV=${r3.ev.toFixed(2)}`);
}

console.log('\nRESISTANCE touches (bounce short):');
for (const k of [0, 1, 2, 3, 4, 5]) {
  const arr = resists.filter(t => t.prior_touches === k);
  if (arr.length < 30) continue;
  const r = evalSet(arr, 'bounce', 10, 5, 15);
  const r2 = evalSet(arr, 'bounce', 15, 10, 30);
  const r3 = evalSet(arr, 'bounce', 20, 12, 30);
  console.log(`  prior_touches=${k}: n=${String(arr.length).padStart(5)}   T10/S5/H15: WR=${(r.wr*100).toFixed(1)}% EV=${r.ev.toFixed(2)}   T15/S10/H30: WR=${(r2.wr*100).toFixed(1)}% EV=${r2.ev.toFixed(2)}   T20/S12/H30: WR=${(r3.wr*100).toFixed(1)}% EV=${r3.ev.toFixed(2)}`);
}

console.log('\nRESISTANCE touches with prior_touches >= K:');
for (const k of [1, 2, 3]) {
  const arr = resists.filter(t => t.prior_touches >= k);
  if (arr.length < 30) continue;
  const r = evalSet(arr, 'bounce', 10, 5, 15);
  const r2 = evalSet(arr, 'bounce', 15, 10, 30);
  const r3 = evalSet(arr, 'bounce', 20, 12, 30);
  console.log(`  prior_touches >= ${k}: n=${String(arr.length).padStart(5)}   T10/S5/H15: WR=${(r.wr*100).toFixed(1)}% EV=${r.ev.toFixed(2)}   T15/S10/H30: WR=${(r2.wr*100).toFixed(1)}% EV=${r2.ev.toFixed(2)}   T20/S12/H30: WR=${(r3.wr*100).toFixed(1)}% EV=${r3.ev.toFixed(2)}`);
}

// Save for next stage (extended walk needed for bigger targets)
console.log(`\nSaving touches with prior_touches feature...`);
fs.writeFileSync(`${ROOT}/research/output/touches-with-structural.json`,
  JSON.stringify(touches.map(t => ({
    touch_id: t.touch_id, ts: t.ts, date: t.date, time_et: t.time_et,
    level_type: t.level_type, level_price: t.level_price, approach: t.approach,
    bounce: t.bounce, brk: t.brk, features: t.features, s1: t.s1,
    prior_touches: t.prior_touches, max_prior_wick: t.max_prior_wick, bounceDir: t.bounceDir,
  })))
);
console.log(`Saved. ${touches.filter(t => t.prior_touches >= 2).length} touches have prior_touches >= 2.`);
