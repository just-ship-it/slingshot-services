/**
 * Test the OFI thesis on the 1s-honest t+120s dataset.
 *
 * Wide-net comparison:
 *   - Baseline: all touches → bounce direction → WR
 *   - Filter: post1 OFI confirmation in bounce direction
 *   - Compare lift across (current vs stale) × (long vs short)
 *
 * Then layer additional filters to narrow.
 */
import fs from 'fs';
const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const data = JSON.parse(fs.readFileSync(`${ROOT}/research/output/touches-t120-1s-honest.json`));
const touches = data.touches;
console.log(`Loaded ${touches.length.toLocaleString()} 1s-honest touches\n`);

// Enrich with post1 close vs level (need to fetch from OFI close map)
const ofiJoined = JSON.parse(fs.readFileSync(`${ROOT}/research/output/ofi-nq-joined.json`)).joined;
const closeByTs = new Map();
for (const r of ofiJoined) closeByTs.set(r.ts, r.close);
for (const t of touches) {
  const minTs = Math.floor(t.ts / 60000) * 60000;
  t.post1_close = closeByTs.get(minTs + 60_000);
  t.post1_above = t.post1_close != null && t.post1_close > t.level_price;
  t.post1_below = t.post1_close != null && t.post1_close < t.level_price;
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

function evaluate(touches, target, stop, holdMin) {
  let w = 0, l = 0, to = 0;
  for (const t of touches) {
    const o = labelWalk(t.walk, target, stop, holdMin);
    if (o === 'win') w++;
    else if (o === 'loss') l++;
    else if (o === 'timeout') to++;
  }
  const n = w + l + to;
  return { n, w, l, to, wr: n > 0 ? w / n : 0, ev: n > 0 ? (w * target - l * stop) / n : 0 };
}

function p(label, arr, target = 10, stop = 5, hold = 14) {
  if (arr.length < 20) return;
  const r = evaluate(arr, target, stop, hold);
  console.log(`  ${label.padEnd(72)} n=${String(r.n).padStart(5)} W=${String(r.w).padStart(4)} L=${String(r.l).padStart(4)} TO=${String(r.to).padStart(3)} WR=${(r.wr*100).toFixed(1).padStart(5)}% EV=${r.ev.toFixed(2).padStart(6)}`);
  return r;
}

const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall']);

// === BASELINE: all touches, no filter ===
console.log(`=== BASELINE: ALL touches → bounce direction (T10/S5/H14) ===`);
const longs = touches.filter(t => t.walk_dir === 'long');
const shorts = touches.filter(t => t.walk_dir === 'short');
p('All longs (bounce off support)', longs);
p('  Current levels', longs.filter(t => t.eventType === 'current'));
p('  Stale levels', longs.filter(t => t.eventType === 'stale'));
p('All shorts (bounce off resistance)', shorts);
p('  Current levels', shorts.filter(t => t.eventType === 'current'));
p('  Stale levels', shorts.filter(t => t.eventType === 'stale'));

// === OFI FILTER applied ===
console.log(`\n=== With POST1 OFI confirmation ===`);
const longConfirm = t => t.walk_dir === 'long' && t.post1_ofi != null && t.post1_ofi > 0 && t.post1_above;
const shortConfirm = t => t.walk_dir === 'short' && t.post1_ofi != null && t.post1_ofi < 0 && t.post1_below;

console.log(`\nLONG confirm (post1 OFI > 0 + close > level):`);
p('All longs + confirm', touches.filter(longConfirm));
p('  Current + confirm', touches.filter(t => t.eventType === 'current' && longConfirm(t)));
p('  Stale + confirm', touches.filter(t => t.eventType === 'stale' && longConfirm(t)));

console.log(`\nSHORT confirm (post1 OFI < 0 + close < level):`);
p('All shorts + confirm', touches.filter(shortConfirm));
p('  Current + confirm', touches.filter(t => t.eventType === 'current' && shortConfirm(t)));
p('  Stale + confirm', touches.filter(t => t.eventType === 'stale' && shortConfirm(t)));

console.log(`\n=== Tighter OFI thresholds (LONG only — strongest side) ===`);
for (const thresh of [10, 25, 50, 100, 200]) {
  const arr = touches.filter(t => t.walk_dir === 'long' && t.post1_ofi != null && t.post1_ofi > thresh && t.post1_above);
  p(`LONG + post1 OFI > ${thresh}`, arr);
}

console.log(`\n=== With multiple targets/stops (LONG OFI>50) ===`);
const base = touches.filter(t => t.walk_dir === 'long' && t.post1_ofi != null && t.post1_ofi > 50 && t.post1_above);
console.log(`  Setup: support touch + post1 OFI > 50 + post1 close > level + entry at t+120s`);
console.log(`  Sample size: ${base.length}\n`);
for (const [tgt, stp, hld] of [[5,3,10],[7,4,10],[8,5,10],[10,5,14],[10,6,14],[12,6,14],[12,8,14],[15,8,14],[15,10,14],[20,10,14]]) {
  p(`T=${tgt}/S=${stp}/H=${hld}`, base, tgt, stp, hld);
}

console.log(`\n=== Layered filters on top of LONG OFI>50 base ===`);
console.log(`Best target/stop applies (let's standardize on T10/S5/H14)`);
p('Baseline (LONG + OFI>50 + above)', base, 10, 5, 14);

// Level type
console.log(`\nBy level type:`);
for (const lt of ['put_wall', 'S1', 'S2', 'S3', 'S4', 'S5', 'gamma_flip']) {
  p(`  + level=${lt}`, base.filter(t => t.level_type_initial === lt), 10, 5, 14);
}

// Current vs stale
console.log(`\nBy eventType:`);
p('  + Current', base.filter(t => t.eventType === 'current'), 10, 5, 14);
p('  + Stale', base.filter(t => t.eventType === 'stale'), 10, 5, 14);

// Time of day
console.log(`\nBy time of day:`);
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
for (const tod of ['pre_rth_early','pre_rth_late','rth_open','rth_morn','rth_lunch','rth_aft','rth_close']) {
  p(`  + tod=${tod}`, base.filter(t => todBucket(t) === tod), 10, 5, 14);
}

// Stale level age (if relevant)
console.log(`\nStale longs only, by age:`);
const staleLongs = base.filter(t => t.eventType === 'stale');
for (const [a, b] of [[30,60],[60,90],[90,120],[120,180],[180,240]]) {
  const arr = staleLongs.filter(t => t.minutes_stale >= a && t.minutes_stale < b);
  p(`  stale age ${a}-${b}min`, arr, 10, 5, 14);
}

// Volume context
console.log(`\nWith volume signals:`);
for (const cond of [
  ['touch_vol > 1500 (active minute)', t => t.touch_vol > 1500],
  ['touch_vol > 2500', t => t.touch_vol > 2500],
  ['post1_vol > 1500', t => t.post1_vol > 1500],
  ['post1_vol > touch_vol (acceleration)', t => t.post1_vol > t.touch_vol],
  ['post1_vol > touch_vol * 1.5', t => t.post1_vol > t.touch_vol * 1.5],
]) {
  p(`  + ${cond[0]}`, base.filter(cond[1]), 10, 5, 14);
}

// By-month stability for the BASE filter
console.log(`\n=== By-month stability (LONG + OFI>50 + close>level + T10/S5/H14) ===`);
const byMonth = new Map();
for (const t of base) {
  const m = t.date.slice(0, 7);
  if (!byMonth.has(m)) byMonth.set(m, []);
  byMonth.get(m).push(labelWalk(t.walk, 10, 5, 14));
}
console.log(`Month   n     W    L   TO  WR`);
for (const [m, outs] of [...byMonth.entries()].sort()) {
  const w = outs.filter(o => o === 'win').length;
  const l = outs.filter(o => o === 'loss').length;
  const to = outs.filter(o => o === 'timeout').length;
  console.log(`${m}  ${String(outs.length).padStart(4)}  ${String(w).padStart(4)} ${String(l).padStart(3)} ${String(to).padStart(3)}  ${(w/Math.max(1,outs.length)*100).toFixed(1)}%`);
}

// === Concurrency-aware annualized projections ===
console.log(`\n=== Concurrency-aware backtest (1 position at a time) ===`);
function simulate(events, target, stop, holdMin) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const trades = [];
  let cursor = -Infinity;
  for (const t of sorted) {
    const entryTs = t.ts + 120_000;
    if (entryTs < cursor) continue;
    const labeled = labelWalk(t.walk, target, stop, holdMin);
    let exitSec;
    if (labeled === 'win') exitSec = t.walk.time_to_target_sec[target];
    else if (labeled === 'loss') exitSec = t.walk.time_to_stop_sec[stop];
    else exitSec = holdMin * 60;
    const exitTs = entryTs + exitSec * 1000;
    trades.push({ ts: t.ts, entryTs, exitTs, outcome: labeled, target, stop });
    cursor = exitTs;
  }
  const w = trades.filter(t => t.outcome === 'win').length;
  const l = trades.filter(t => t.outcome === 'loss').length;
  const to = trades.filter(t => t.outcome === 'timeout').length;
  return { n: trades.length, w, l, to, wr: w/Math.max(1,trades.length), ev: trades.length > 0 ? (w*target - l*stop) / trades.length : 0 };
}

// Multiple candidate combos
console.log(`\nCandidate rules (after concurrency):`);
const rules = [
  { name: 'LONG_OFI>0 + above', f: t => t.walk_dir === 'long' && t.post1_ofi != null && t.post1_ofi > 0 && t.post1_above, tgt: 10, stp: 5, hld: 14 },
  { name: 'LONG_OFI>50 + above', f: t => t.walk_dir === 'long' && t.post1_ofi != null && t.post1_ofi > 50 && t.post1_above, tgt: 10, stp: 5, hld: 14 },
  { name: 'LONG_OFI>100 + above', f: t => t.walk_dir === 'long' && t.post1_ofi != null && t.post1_ofi > 100 && t.post1_above, tgt: 10, stp: 5, hld: 14 },
  { name: 'SHORT_OFI<0 + below', f: t => t.walk_dir === 'short' && t.post1_ofi != null && t.post1_ofi < 0 && t.post1_below, tgt: 10, stp: 5, hld: 14 },
  { name: 'BOTH (long OFI>50 + above OR short OFI<-50 + below)', f: t => (t.walk_dir === 'long' && t.post1_ofi > 50 && t.post1_above) || (t.walk_dir === 'short' && t.post1_ofi < -50 && t.post1_below), tgt: 10, stp: 5, hld: 14 },
];
for (const r of rules) {
  const matched = touches.filter(r.f);
  const sim = simulate(matched, r.tgt, r.stp, r.hld);
  const yrFrac = 12 / 12.5;
  const trades_yr = sim.n / yrFrac;
  const ev_per_trade_net_dollar = sim.ev * 20 - 10 - 1.0 * 20 - (sim.l > 0 ? 1.5 * 20 * sim.l / sim.n : 0);  // rough net est
  const gross_yr = trades_yr * sim.ev * 20;
  console.log(`  ${r.name.padEnd(60)} matched=${matched.length} trades(after_concurrency)=${sim.n}  W=${sim.w} L=${sim.l} TO=${sim.to}  WR=${(sim.wr*100).toFixed(1)}% EV=${sim.ev.toFixed(2)}pt  trades/yr=${trades_yr.toFixed(0)}  gross/yr=$${gross_yr.toFixed(0)}/contract`);
}

console.log(`\nDone.`);
