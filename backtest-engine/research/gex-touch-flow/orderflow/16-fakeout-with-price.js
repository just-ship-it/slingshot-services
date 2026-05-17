/**
 * Refined fake-out: BAR LOOKS BEARISH but FINAL SECONDS are BUYING.
 *
 * Need to join the s1ofi data with the original gex-touch-flow features
 * (touch bar OHLC). The s1ofi dataset alone doesn't include touch bar features.
 */
import fs from 'fs';
const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';

console.log('Loading datasets...');
const s1ofiData = JSON.parse(fs.readFileSync(`${ROOT}/research/output/touches-with-s1ofi.json`));
const baseData = JSON.parse(fs.readFileSync(`${ROOT}/research/output/gex-touch-flow-2026-05-14T05-52-19-372Z.json`));
const baseTouches = baseData.touches;

// Join: both keyed by touch_id (sequential index)
const byId = new Map();
for (const t of baseTouches) byId.set(t.touch_id, t);
for (const o of s1ofiData) {
  const b = byId.get(o.touch_id);
  if (b) b.s1ofi = o.s1ofi;
}
const touches = baseTouches.filter(t => t.s1ofi);
console.log(`Joined: ${touches.length.toLocaleString()} touches with s1ofi + features`);

// === Add helpful derived fields ===
for (const t of touches) {
  const f = t.features;
  const o = t.s1ofi;
  // Bearish-looking bar (LONG fake-out setup)
  t.barRange = f.touch_range_pts;
  t.barIsRed = f.touch_close_relative != null ? f.touch_close_relative < f.touch_distance_pts : false;
  // Touch bar body position (where close sits in range, 0=at low, 1=at high)
  t.bodyPos = f.touch_body_pos;
  // For long fake-out: bar closed in lower half (looks bad) but last 10s was buying
  t.lowerBody = f.touch_body_pos < 0.4;
  t.upperBody = f.touch_body_pos > 0.6;
  // Lower wick rejection
  t.hasLowerWick = (f.touch_lower_wick / Math.max(0.1, f.touch_range_pts)) > 0.3;
  t.hasUpperWick = (f.touch_upper_wick / Math.max(0.1, f.touch_range_pts)) > 0.3;
}

function labelWalk(walk, target, stop, holdMin) {
  if (!walk) return 'no_data';
  const tt = walk.time_to_target_sec?.[target];
  const ts = walk.time_to_stop_sec?.[stop];
  const hs = holdMin * 60;
  if (tt != null && tt <= hs && (ts == null || ts > hs || tt < ts)) return 'win';
  if (ts != null && ts <= hs) return 'loss';
  return 'timeout';
}
function evaluate(arr, walkField, target, stop, holdMin) {
  let w = 0, l = 0, to = 0;
  for (const t of arr) {
    const o = labelWalk(t[walkField], target, stop, holdMin);
    if (o === 'win') w++;
    else if (o === 'loss') l++;
    else if (o === 'timeout') to++;
  }
  const n = w + l + to;
  return { n, w, l, to, wr: n > 0 ? w / n : 0, ev: n > 0 ? (w * target - l * stop) / n : 0 };
}
function p(label, arr, walkField, t, s, h) {
  if (arr.length < 30) return null;
  const r = evaluate(arr, walkField, t, s, h);
  console.log(`  ${label.padEnd(82)} n=${String(r.n).padStart(4)} W=${String(r.w).padStart(3)} L=${String(r.l).padStart(3)} TO=${String(r.to).padStart(3)} WR=${(r.wr*100).toFixed(1).padStart(5)}% EV=${r.ev.toFixed(2).padStart(6)}`);
  return r;
}

const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall']);
for (const t of touches) {
  const isSupp = SUPPORT_TYPES.has(t.level_type);
  const isRes = RESIST_TYPES.has(t.level_type);
  const isFlip = t.level_type === 'gamma_flip';
  if (isSupp || (isFlip && t.approach === 'from_above')) t.bounceDir = 'long';
  else if (isRes || (isFlip && t.approach === 'from_below')) t.bounceDir = 'short';
}

const longs = touches.filter(t => t.bounceDir === 'long');
const shorts = touches.filter(t => t.bounceDir === 'short');
console.log(`Longs (support): ${longs.length}  Shorts (resistance): ${shorts.length}`);

console.log(`\n=== Baseline ===`);
p('All longs (support touch from_above)', longs, 'bounce', 10, 5, 15);
p('All shorts (resistance touch from_below)', shorts, 'bounce', 10, 5, 15);

// =========================================================================
// The user's classic FAKE-OUT pattern for LONG:
//   - Touch bar looks bearish: close in lower half (bodyPos < 0.4)
//   - BUT touch bar has lower wick (price tried to bounce)
//   - Sub-minute: last 10-15s flow positive (buyers stepping in)
//   - Strongest if a big 1s spike of buying in last 15s
// =========================================================================
console.log(`\n=== LONG FAKE-OUT — touch bar bearish-looking + last seconds buying ===`);

// Building up the pattern incrementally
p('Long + bar lookbearish (bodyPos<0.4) (baseline lookbearish)', longs.filter(t => t.lowerBody), 'bounce', 10, 5, 15);
p('  + lower wick (hasLowerWick)', longs.filter(t => t.lowerBody && t.hasLowerWick), 'bounce', 10, 5, 15);
p('  + last10Flow > 0', longs.filter(t => t.lowerBody && t.hasLowerWick && t.s1ofi.last10Flow > 0), 'bounce', 10, 5, 15);
p('  + last15Flow > 0', longs.filter(t => t.lowerBody && t.hasLowerWick && t.s1ofi.last15Flow > 0), 'bounce', 10, 5, 15);
p('  + secondHalf > 0 (more lenient)', longs.filter(t => t.lowerBody && t.hasLowerWick && t.s1ofi.secondHalfFlow > 0), 'bounce', 10, 5, 15);

// Inverse: bar looks bullish but final seconds selling (contrarian for short)
console.log(`\n=== SHORT FAKE-OUT — touch bar bullish-looking + last seconds selling ===`);
p('Short + bar lookbullish (bodyPos>0.6)', shorts.filter(t => t.upperBody), 'bounce', 10, 5, 15);
p('  + upper wick', shorts.filter(t => t.upperBody && t.hasUpperWick), 'bounce', 10, 5, 15);
p('  + last10Flow < 0', shorts.filter(t => t.upperBody && t.hasUpperWick && t.s1ofi.last10Flow < 0), 'bounce', 10, 5, 15);
p('  + last15Flow < 0', shorts.filter(t => t.upperBody && t.hasUpperWick && t.s1ofi.last15Flow < 0), 'bounce', 10, 5, 15);
p('  + secondHalf < 0', shorts.filter(t => t.upperBody && t.hasUpperWick && t.s1ofi.secondHalfFlow < 0), 'bounce', 10, 5, 15);

// Try: bar that already RECOVERED (closed near high or above) with strong final flow
console.log(`\n=== LONG: bar already showing recovery + last-seconds confirmation ===`);
p('upperBody (closed near high) only', longs.filter(t => t.upperBody), 'bounce', 10, 5, 15);
p('upperBody + last15Flow > 0', longs.filter(t => t.upperBody && t.s1ofi.last15Flow > 0), 'bounce', 10, 5, 15);
p('upperBody + last10Flow > 0', longs.filter(t => t.upperBody && t.s1ofi.last10Flow > 0), 'bounce', 10, 5, 15);
p('upperBody + last10Flow > 0 + first half flow < 0 (fake-out + recovered)', longs.filter(t => t.upperBody && t.s1ofi.last10Flow > 0 && t.s1ofi.firstHalfFlow < 0), 'bounce', 10, 5, 15);
p('upperBody + last10Flow > 0 + secondHalf >> firstHalf (acceleration)', longs.filter(t => t.upperBody && t.s1ofi.last10Flow > 0 && t.s1ofi.secondHalfFlow > -t.s1ofi.firstHalfFlow), 'bounce', 10, 5, 15);

console.log(`\n=== SHORT: bar already showing rejection (upperBody for short → bearishly closed) ===`);
p('lowerBody (closed near low) only', shorts.filter(t => t.lowerBody), 'bounce', 10, 5, 15);
p('lowerBody + last15Flow < 0', shorts.filter(t => t.lowerBody && t.s1ofi.last15Flow < 0), 'bounce', 10, 5, 15);
p('lowerBody + last10Flow < 0', shorts.filter(t => t.lowerBody && t.s1ofi.last10Flow < 0), 'bounce', 10, 5, 15);

// Tightening with strong flow magnitudes
console.log(`\n=== LONG: strong buy momentum in final seconds ===`);
for (const thresh of [30, 50, 100, 150, 200]) {
  p(`upperBody + last10Flow > ${thresh}`, longs.filter(t => t.upperBody && t.s1ofi.last10Flow > thresh), 'bounce', 10, 5, 15);
}

console.log(`\n=== SHORT: strong sell momentum in final seconds ===`);
for (const thresh of [30, 50, 100, 150, 200]) {
  p(`lowerBody + last10Flow < -${thresh}`, shorts.filter(t => t.lowerBody && t.s1ofi.last10Flow < -thresh), 'bounce', 10, 5, 15);
}

// === Multi-signal layering on the best LONG candidate ===
console.log(`\n=== Combined LONG: upperBody + last10>50 + first half<0 + tighter ===`);
const longCore = longs.filter(t => t.upperBody && t.s1ofi.last10Flow > 50 && t.s1ofi.firstHalfFlow < 0);
console.log(`Sample: ${longCore.length}`);
for (const [tgt, stp, hld] of [[5,3,5],[7,4,5],[7,4,10],[8,5,10],[10,5,10],[10,5,15],[12,6,15],[15,8,15]]) {
  p(`T=${tgt}/S=${stp}/H=${hld}`, longCore, 'bounce', tgt, stp, hld);
}

console.log(`\n=== Combined SHORT: lowerBody + last10<-50 + first half>0 ===`);
const shortCore = shorts.filter(t => t.lowerBody && t.s1ofi.last10Flow < -50 && t.s1ofi.firstHalfFlow > 0);
console.log(`Sample: ${shortCore.length}`);
for (const [tgt, stp, hld] of [[5,3,5],[7,4,5],[7,4,10],[8,5,10],[10,5,10],[10,5,15],[12,6,15],[15,8,15]]) {
  p(`T=${tgt}/S=${stp}/H=${hld}`, shortCore, 'bounce', tgt, stp, hld);
}

// === By month stability for the best candidate ===
console.log(`\n=== By-month stability for LONG core ===`);
const byMonth = new Map();
for (const t of longCore) {
  const m = t.date.slice(0, 7);
  if (!byMonth.has(m)) byMonth.set(m, []);
  byMonth.get(m).push(labelWalk(t.bounce, 10, 5, 15));
}
for (const [m, outs] of [...byMonth.entries()].sort()) {
  const w = outs.filter(o => o === 'win').length;
  const l = outs.filter(o => o === 'loss').length;
  console.log(`  ${m}: n=${outs.length} W=${w} L=${l} WR=${(w/Math.max(1,outs.length)*100).toFixed(1)}%`);
}

// === Concurrency-aware sim of the best candidates ===
console.log(`\n=== Concurrency-aware backtest ===`);
function simulate(events, walkField, target, stop, holdMin) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const trades = [];
  let cursor = -Infinity;
  for (const t of sorted) {
    const entryTs = t.ts + 60_000;
    if (entryTs < cursor) continue;
    const o = labelWalk(t[walkField], target, stop, holdMin);
    let exitSec;
    if (o === 'win') exitSec = t[walkField].time_to_target_sec[target];
    else if (o === 'loss') exitSec = t[walkField].time_to_stop_sec[stop];
    else exitSec = holdMin * 60;
    const exitTs = entryTs + exitSec * 1000;
    trades.push({ outcome: o });
    cursor = exitTs;
  }
  const w = trades.filter(t => t.outcome === 'win').length;
  const l = trades.filter(t => t.outcome === 'loss').length;
  const to = trades.filter(t => t.outcome === 'timeout').length;
  const n = w + l + to;
  return { n, w, l, to, wr: w/Math.max(1,n), ev: n > 0 ? (w*target - l*stop) / n : 0 };
}
const rules = [
  { name: 'LONG: upperBody + last10>0 + firstHalf<0', f: t => t.bounceDir==='long' && t.upperBody && t.s1ofi.last10Flow > 0 && t.s1ofi.firstHalfFlow < 0, tgt: 10, stp: 5, hld: 15 },
  { name: 'LONG: upperBody + last10>50 + firstHalf<0', f: t => t.bounceDir==='long' && t.upperBody && t.s1ofi.last10Flow > 50 && t.s1ofi.firstHalfFlow < 0, tgt: 10, stp: 5, hld: 15 },
  { name: 'LONG: upperBody + last10>100 + firstHalf<0', f: t => t.bounceDir==='long' && t.upperBody && t.s1ofi.last10Flow > 100 && t.s1ofi.firstHalfFlow < 0, tgt: 10, stp: 5, hld: 15 },
  { name: 'LONG: upperBody + last10>0', f: t => t.bounceDir==='long' && t.upperBody && t.s1ofi.last10Flow > 0, tgt: 10, stp: 5, hld: 15 },
  { name: 'SHORT: lowerBody + last10<-50 + firstHalf>0', f: t => t.bounceDir==='short' && t.lowerBody && t.s1ofi.last10Flow < -50 && t.s1ofi.firstHalfFlow > 0, tgt: 10, stp: 5, hld: 15 },
  { name: 'SHORT: lowerBody + last10<-100 + firstHalf>0', f: t => t.bounceDir==='short' && t.lowerBody && t.s1ofi.last10Flow < -100 && t.s1ofi.firstHalfFlow > 0, tgt: 10, stp: 5, hld: 15 },
];
const yrFrac = 12.5 / 12;
for (const r of rules) {
  const matched = touches.filter(r.f);
  const sim = simulate(matched, 'bounce', r.tgt, r.stp, r.hld);
  console.log(`  ${r.name.padEnd(60)} matched=${matched.length} after_conc=${sim.n} W=${sim.w} L=${sim.l} TO=${sim.to} WR=${(sim.wr*100).toFixed(1)}% EV=${sim.ev.toFixed(2)}pt  ~${(sim.n/yrFrac).toFixed(0)}/yr gross=$${(sim.ev * sim.n * 20 / yrFrac).toFixed(0)}/yr/contract`);
}

// Combined long+short rule
console.log(`\n=== Long+Short combined ===`);
const combinedRule = t => (
  (t.bounceDir === 'long' && t.upperBody && t.s1ofi.last10Flow > 50 && t.s1ofi.firstHalfFlow < 0) ||
  (t.bounceDir === 'short' && t.lowerBody && t.s1ofi.last10Flow < -50 && t.s1ofi.firstHalfFlow > 0)
);
const combo = touches.filter(combinedRule);
const sim = simulate(combo, 'bounce', 10, 5, 15);
console.log(`  Combined: matched=${combo.length} after_conc=${sim.n} W=${sim.w} L=${sim.l} TO=${sim.to} WR=${(sim.wr*100).toFixed(1)}% EV=${sim.ev.toFixed(2)}pt  ~${(sim.n/yrFrac).toFixed(0)}/yr  gross=$${(sim.ev * sim.n * 20 / yrFrac).toFixed(0)}/yr/contract`);

console.log(`\nDone.`);
