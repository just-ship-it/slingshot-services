/**
 * Test the "fake-out reversal" hypothesis:
 *   - First 30s of minute: drift one direction (e.g., selling — netFlow < 0)
 *   - Last 10-20s of minute: AGGRESSIVE OPPOSITE flow with volume spike
 *   - Trade in the reversal direction, entering at t+60s (minute close)
 *
 * Walks from t+60s already in the dataset.
 */
import fs from 'fs';
const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const data = JSON.parse(fs.readFileSync(`${ROOT}/research/output/touches-with-s1ofi.json`));
const touches = data;
console.log(`Loaded ${touches.length.toLocaleString()} touches (${touches.filter(t => t.s1ofi).length.toLocaleString()} with s1ofi)`);

function labelWalk(walk, target, stop, holdMin) {
  if (!walk) return 'no_data';
  const tt = walk.time_to_target_sec?.[target];
  const ts = walk.time_to_stop_sec?.[stop];
  const hs = holdMin * 60;
  if (tt != null && tt <= hs && (ts == null || ts > hs || tt < ts)) return 'win';
  if (ts != null && ts <= hs) return 'loss';
  return 'timeout';
}

function evaluate(arr, dir, target, stop, holdMin) {
  let w = 0, l = 0, to = 0;
  for (const t of arr) {
    const walk = dir === 'bounce' ? t.bounce : t.brk;
    const o = labelWalk(walk, target, stop, holdMin);
    if (o === 'win') w++;
    else if (o === 'loss') l++;
    else if (o === 'timeout') to++;
  }
  const n = w + l + to;
  return { n, w, l, to, wr: n > 0 ? w / n : 0, ev: n > 0 ? (w * target - l * stop) / n : 0 };
}
function p(label, arr, dir, t, s, h) {
  if (arr.length < 30) return null;
  const r = evaluate(arr, dir, t, s, h);
  console.log(`  ${label.padEnd(80)} n=${String(r.n).padStart(4)} W=${String(r.w).padStart(3)} L=${String(r.l).padStart(3)} TO=${String(r.to).padStart(3)} WR=${(r.wr*100).toFixed(1).padStart(5)}% EV=${r.ev.toFixed(2).padStart(6)}`);
  return r;
}

const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall']);

// Determine bounce dir per touch
for (const t of touches) {
  const isSupp = SUPPORT_TYPES.has(t.level_type);
  const isRes = RESIST_TYPES.has(t.level_type);
  const isFlip = t.level_type === 'gamma_flip';
  if (isSupp || (isFlip && t.approach === 'from_above')) t.bounceDir = 'long';
  else if (isRes || (isFlip && t.approach === 'from_below')) t.bounceDir = 'short';
}

// =========================================================================
// Test 1: baseline WRs
// =========================================================================
console.log(`\n=== BASELINE (T10/S5/H15, bounce direction) ===`);
const longs = touches.filter(t => t.bounceDir === 'long' && t.s1ofi);
const shorts = touches.filter(t => t.bounceDir === 'short' && t.s1ofi);
p('All longs (support touch from_above)', longs, 'bounce', 10, 5, 15);
p('All shorts (resistance touch from_below)', shorts, 'bounce', 10, 5, 15);

// =========================================================================
// Test 2: simple sub-minute features (LONG side)
// =========================================================================
console.log(`\n=== LONG (support bounces) — sub-minute features ===`);
// LONG fake-out: 1m bar looked bearish (selling first half) but ended bullish (buying last 15s)
p('firstHalfFlow < 0 (selling in first 30s)', longs.filter(t => t.s1ofi.firstHalfFlow < 0), 'bounce', 10, 5, 15);
p('secondHalfFlow > 0 (buying in last 30s)', longs.filter(t => t.s1ofi.secondHalfFlow > 0), 'bounce', 10, 5, 15);
p('reversalFlag (signs differ)', longs.filter(t => t.s1ofi.reversalFlag), 'bounce', 10, 5, 15);
p('firstHalf<0 AND secondHalf>0 (classic fake-out)', longs.filter(t => t.s1ofi.firstHalfFlow < 0 && t.s1ofi.secondHalfFlow > 0), 'bounce', 10, 5, 15);
p('classic fake-out + last15 > 0', longs.filter(t => t.s1ofi.firstHalfFlow < 0 && t.s1ofi.secondHalfFlow > 0 && t.s1ofi.last15Flow > 0), 'bounce', 10, 5, 15);
p('classic fake-out + last10 > 0', longs.filter(t => t.s1ofi.firstHalfFlow < 0 && t.s1ofi.secondHalfFlow > 0 && t.s1ofi.last10Flow > 0), 'bounce', 10, 5, 15);
p('classic fake-out + last5 > 0', longs.filter(t => t.s1ofi.firstHalfFlow < 0 && t.s1ofi.secondHalfFlow > 0 && t.s1ofi.last5Flow > 0), 'bounce', 10, 5, 15);

console.log(`\nWith volume spike in last 10-15s:`);
p('fake-out + last15VolPct > 0.25', longs.filter(t => t.s1ofi.firstHalfFlow < 0 && t.s1ofi.last15Flow > 0 && t.s1ofi.last15VolPct > 0.25), 'bounce', 10, 5, 15);
p('fake-out + last10VolPct > 0.20', longs.filter(t => t.s1ofi.firstHalfFlow < 0 && t.s1ofi.last10Flow > 0 && t.s1ofi.last10VolPct > 0.20), 'bounce', 10, 5, 15);
p('fake-out + last10VolPct > 0.25', longs.filter(t => t.s1ofi.firstHalfFlow < 0 && t.s1ofi.last10Flow > 0 && t.s1ofi.last10VolPct > 0.25), 'bounce', 10, 5, 15);
p('fake-out + last10VolPct > 0.30', longs.filter(t => t.s1ofi.firstHalfFlow < 0 && t.s1ofi.last10Flow > 0 && t.s1ofi.last10VolPct > 0.30), 'bounce', 10, 5, 15);

console.log(`\nVolume acceleration (vol in last 30s > first 30s):`);
p('volAccelRatio > 1', longs.filter(t => t.s1ofi.volAccelRatio > 1), 'bounce', 10, 5, 15);
p('volAccelRatio > 1.5', longs.filter(t => t.s1ofi.volAccelRatio > 1.5), 'bounce', 10, 5, 15);
p('volAccelRatio > 2', longs.filter(t => t.s1ofi.volAccelRatio > 2), 'bounce', 10, 5, 15);
p('fake-out + volAccelRatio > 1.5', longs.filter(t => t.s1ofi.firstHalfFlow < 0 && t.s1ofi.last15Flow > 0 && t.s1ofi.volAccelRatio > 1.5), 'bounce', 10, 5, 15);
p('fake-out + volAccelRatio > 2', longs.filter(t => t.s1ofi.firstHalfFlow < 0 && t.s1ofi.last15Flow > 0 && t.s1ofi.volAccelRatio > 2), 'bounce', 10, 5, 15);

console.log(`\nLargest 1s spike location matters:`);
p('maxAbsFlowAt >= 45 (spike in last 15s)', longs.filter(t => t.s1ofi.maxAbsFlowAt >= 45), 'bounce', 10, 5, 15);
p('maxAbsFlowAt >= 50 (spike in last 10s)', longs.filter(t => t.s1ofi.maxAbsFlowAt >= 50), 'bounce', 10, 5, 15);
p('maxAbsFlowAt >= 45 + maxAbsFlowSign > 0 (positive spike in last 15s)', longs.filter(t => t.s1ofi.maxAbsFlowAt >= 45 && t.s1ofi.maxAbsFlowSign > 0), 'bounce', 10, 5, 15);
p('maxAbsFlowAt >= 50 + maxAbsFlowSign > 0', longs.filter(t => t.s1ofi.maxAbsFlowAt >= 50 && t.s1ofi.maxAbsFlowSign > 0), 'bounce', 10, 5, 15);

console.log(`\nMaximum-strength fake-out filters:`);
p('fakeOut + maxSpike@>=45 + sign>0 + last10VolPct>0.20', longs.filter(t =>
  t.s1ofi.firstHalfFlow < 0 && t.s1ofi.maxAbsFlowAt >= 45 && t.s1ofi.maxAbsFlowSign > 0 && t.s1ofi.last10VolPct > 0.2), 'bounce', 10, 5, 15);
p('fakeOut + maxSpike@>=50 + sign>0 + last10VolPct>0.25', longs.filter(t =>
  t.s1ofi.firstHalfFlow < 0 && t.s1ofi.maxAbsFlowAt >= 50 && t.s1ofi.maxAbsFlowSign > 0 && t.s1ofi.last10VolPct > 0.25), 'bounce', 10, 5, 15);
p('fakeOut + maxSpike@>=50 + sign>0 + last10VolPct>0.30', longs.filter(t =>
  t.s1ofi.firstHalfFlow < 0 && t.s1ofi.maxAbsFlowAt >= 50 && t.s1ofi.maxAbsFlowSign > 0 && t.s1ofi.last10VolPct > 0.3), 'bounce', 10, 5, 15);

// =========================================================================
// Test 3: SHORT side mirror
// =========================================================================
console.log(`\n=== SHORT (resistance fades) — sub-minute features ===`);
p('All shorts (baseline)', shorts, 'bounce', 10, 5, 15);
p('firstHalfFlow > 0 + last15Flow < 0 (mirror fake-out)', shorts.filter(t => t.s1ofi.firstHalfFlow > 0 && t.s1ofi.last15Flow < 0), 'bounce', 10, 5, 15);
p('mirror fake-out + maxSpike@>=45 + sign<0', shorts.filter(t =>
  t.s1ofi.firstHalfFlow > 0 && t.s1ofi.last15Flow < 0 && t.s1ofi.maxAbsFlowAt >= 45 && t.s1ofi.maxAbsFlowSign < 0), 'bounce', 10, 5, 15);
p('mirror fake-out + maxSpike@>=50 + sign<0 + last10VolPct>0.25', shorts.filter(t =>
  t.s1ofi.firstHalfFlow > 0 && t.s1ofi.last15Flow < 0 && t.s1ofi.maxAbsFlowAt >= 50 && t.s1ofi.maxAbsFlowSign < 0 && t.s1ofi.last10VolPct > 0.25), 'bounce', 10, 5, 15);

// =========================================================================
// Test 4: target/stop sweep on the best LONG cell
// =========================================================================
console.log(`\n=== Sweep target/stop on STRONGEST LONG FAKE-OUT cell ===`);
const fakeoutBase = longs.filter(t =>
  t.s1ofi.firstHalfFlow < 0 && t.s1ofi.last15Flow > 0 && t.s1ofi.volAccelRatio > 1.5);
console.log(`Sample: ${fakeoutBase.length}`);
for (const [tgt, stp, hld] of [[5,3,5],[7,4,5],[7,4,10],[8,5,10],[10,5,10],[10,5,15],[12,6,15],[15,8,15],[20,10,15]]) {
  p(`T=${tgt}/S=${stp}/H=${hld}min`, fakeoutBase, 'bounce', tgt, stp, hld);
}

// =========================================================================
// Test 5: drill into FAKE-OUT cell — TOD, level type, current vs stale
// =========================================================================
console.log(`\n=== Drill into LONG FAKE-OUT cell ===`);
const FAKE_LONG = t => t.bounceDir === 'long' && t.s1ofi && t.s1ofi.firstHalfFlow < 0 && t.s1ofi.last15Flow > 0;
console.log(`Setup: long bounce + first half selling + last 15s buying\n`);
const fakeLongs = touches.filter(FAKE_LONG);

// by level type
const byLevelType = new Map();
for (const t of fakeLongs) {
  if (!byLevelType.has(t.level_type)) byLevelType.set(t.level_type, []);
  byLevelType.get(t.level_type).push(t);
}
console.log(`By level type:`);
for (const [lt, arr] of [...byLevelType.entries()].sort()) {
  p(`  level=${lt}`, arr, 'bounce', 10, 5, 15);
}

// by TOD
function todBucket(t) {
  const [h, m] = t.time_et.split(':').map(Number);
  const min = h * 60 + m;
  if (min < 540) return 'pre_rth_early';
  if (min < 570) return 'pre_rth_late';
  if (min < 600) return 'rth_open';
  if (min < 720) return 'rth_morn';
  if (min < 780) return 'rth_lunch';
  if (min < 930) return 'rth_aft';
  if (min < 960) return 'rth_close';
  return 'after_rth';
}
console.log(`\nBy TOD:`);
const byTod = new Map();
for (const t of fakeLongs) {
  const tb = todBucket(t);
  if (!byTod.has(tb)) byTod.set(tb, []);
  byTod.get(tb).push(t);
}
for (const [tb, arr] of [...byTod.entries()].sort()) {
  p(`  tod=${tb}`, arr, 'bounce', 10, 5, 15);
}

// =========================================================================
// Test 6: BY MONTH stability
// =========================================================================
console.log(`\n=== Stability by month (LONG fake-out, T10/S5/H15) ===`);
const byMonth = new Map();
for (const t of fakeoutBase) {
  const m = t.date.slice(0, 7);
  if (!byMonth.has(m)) byMonth.set(m, []);
  const w = labelWalk(t.bounce, 10, 5, 15);
  byMonth.get(m).push(w);
}
for (const [m, outs] of [...byMonth.entries()].sort()) {
  const w = outs.filter(o => o === 'win').length;
  const l = outs.filter(o => o === 'loss').length;
  console.log(`  ${m}: n=${outs.length} W=${w} L=${l}  WR=${(w/Math.max(1,outs.length)*100).toFixed(1)}%`);
}

// =========================================================================
// Test 7: Concurrency-aware simulation of best fake-out cell
// =========================================================================
console.log(`\n=== Concurrency-aware sim ===`);
function simulate(events, target, stop, holdMin) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const trades = [];
  let cursor = -Infinity;
  for (const t of sorted) {
    const entryTs = t.ts + 60_000;  // entry at t+60s (minute close)
    if (entryTs < cursor) continue;
    const o = labelWalk(t.bounce, target, stop, holdMin);
    let exitSec;
    if (o === 'win') exitSec = t.bounce.time_to_target_sec[target];
    else if (o === 'loss') exitSec = t.bounce.time_to_stop_sec[stop];
    else exitSec = holdMin * 60;
    const exitTs = entryTs + exitSec * 1000;
    trades.push({ ts: t.ts, outcome: o, target, stop });
    cursor = exitTs;
  }
  const w = trades.filter(t => t.outcome === 'win').length;
  const l = trades.filter(t => t.outcome === 'loss').length;
  const to = trades.filter(t => t.outcome === 'timeout').length;
  const n = w + l + to;
  return { n, w, l, to, wr: w/Math.max(1,n), ev: n > 0 ? (w*target - l*stop) / n : 0 };
}

const rules = [
  { name: 'LONG fake-out (firstHalf<0, secondHalf>0)', f: t => t.bounceDir === 'long' && t.s1ofi && t.s1ofi.firstHalfFlow < 0 && t.s1ofi.secondHalfFlow > 0, tgt: 10, stp: 5, hld: 15 },
  { name: 'LONG fake-out + last15>0 (tighter)', f: t => t.bounceDir === 'long' && t.s1ofi && t.s1ofi.firstHalfFlow < 0 && t.s1ofi.last15Flow > 0, tgt: 10, stp: 5, hld: 15 },
  { name: 'LONG fake-out + last10>0', f: t => t.bounceDir === 'long' && t.s1ofi && t.s1ofi.firstHalfFlow < 0 && t.s1ofi.last10Flow > 0, tgt: 10, stp: 5, hld: 15 },
  { name: 'LONG fake-out + maxSpikeAt>=45 + sign>0', f: t => t.bounceDir === 'long' && t.s1ofi && t.s1ofi.firstHalfFlow < 0 && t.s1ofi.maxAbsFlowAt >= 45 && t.s1ofi.maxAbsFlowSign > 0, tgt: 10, stp: 5, hld: 15 },
  { name: 'LONG fake-out + maxSpike@>=50 + sign>0 + last10VolPct>0.25', f: t => t.bounceDir === 'long' && t.s1ofi && t.s1ofi.firstHalfFlow < 0 && t.s1ofi.maxAbsFlowAt >= 50 && t.s1ofi.maxAbsFlowSign > 0 && t.s1ofi.last10VolPct > 0.25, tgt: 10, stp: 5, hld: 15 },
  { name: 'SHORT mirror fake-out (firstHalf>0, secondHalf<0)', f: t => t.bounceDir === 'short' && t.s1ofi && t.s1ofi.firstHalfFlow > 0 && t.s1ofi.secondHalfFlow < 0, tgt: 10, stp: 5, hld: 15 },
];
const yrFrac = 12.5 / 12;
for (const r of rules) {
  const matched = touches.filter(r.f);
  const sim = simulate(matched, r.tgt, r.stp, r.hld);
  console.log(`  ${r.name.padEnd(70)} matched=${matched.length} after_conc=${sim.n} W=${sim.w} L=${sim.l} TO=${sim.to} WR=${(sim.wr*100).toFixed(1)}% EV=${sim.ev.toFixed(2)}pt  ~${(sim.n/yrFrac).toFixed(0)}/yr  gross=$${(sim.ev * sim.n * 20 / yrFrac).toFixed(0)}/yr/contract`);
}

console.log(`\nDone.`);
