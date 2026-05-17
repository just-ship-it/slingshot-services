/**
 * Reverse-engineer: take the touches that DID produce a clean 20pt win
 * (without first hitting an 8pt stop) and look at the marginal distribution
 * of features that distinguish winners from losers. This is a quick lift
 * analysis — finds features whose conditional distribution differs most
 * between winners and losers.
 */
import fs from 'fs';
const IN_PATH = process.argv[process.argv.indexOf('--in') + 1];
const data = JSON.parse(fs.readFileSync(IN_PATH, 'utf-8'));
const touches = data.touches;
function flat(t) { return { ...t.features, ...t.s1 }; }

const TARGET = 15, STOP = 8, HOLD = 15;

// Classify each touch as winner / loser / neither for BOUNCE direction
function classify(t) {
  const w = t.bounce;
  const tt = w.time_to_target_sec?.[TARGET];
  const ts = w.time_to_stop_sec?.[STOP];
  const hs = HOLD * 60;
  const tHit = tt != null && tt <= hs ? tt : null;
  const sHit = ts != null && ts <= hs ? ts : null;
  if (tHit != null && (sHit == null || tHit < sHit)) return 'win';
  if (sHit != null) return 'loss';
  return 'neither';
}
const winners = touches.filter(t => classify(t) === 'win');
const losers = touches.filter(t => classify(t) === 'loss');
const neither = touches.filter(t => classify(t) === 'neither');
console.log(`BOUNCE T${TARGET}/S${STOP}/H${HOLD}: winners=${winners.length} losers=${losers.length} neither=${neither.length}`);

// For each numeric feature, compute mean/std for winners vs losers, and the lift
const featureNames = Object.keys(flat(touches[0]));
function stats(vals) {
  const n = vals.length;
  if (n === 0) return { n: 0, mean: 0, std: 0, p25: 0, p50: 0, p75: 0 };
  const sum = vals.reduce((s, v) => s + v, 0);
  const mean = sum / n;
  const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const sorted = [...vals].sort((a, b) => a - b);
  return { n, mean, std, p25: sorted[Math.floor(n * 0.25)], p50: sorted[Math.floor(n * 0.5)], p75: sorted[Math.floor(n * 0.75)] };
}

console.log(`\nFeature distributions: winners vs losers`);
console.log(`feature                            winner_mean  loser_mean  effect_size  win_p50  loss_p50`);
const lifts = [];
for (const fname of featureNames) {
  const wVals = winners.map(t => flat(t)[fname]).filter(v => typeof v === 'number' && !isNaN(v));
  const lVals = losers.map(t => flat(t)[fname]).filter(v => typeof v === 'number' && !isNaN(v));
  if (wVals.length === 0 || lVals.length === 0) continue;
  const ws = stats(wVals), ls = stats(lVals);
  const pooledStd = Math.sqrt((ws.std ** 2 + ls.std ** 2) / 2);
  const effect = pooledStd > 0 ? (ws.mean - ls.mean) / pooledStd : 0;
  lifts.push({ feature: fname, winner: ws, loser: ls, effect });
}
lifts.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
for (const l of lifts.slice(0, 20)) {
  console.log(
    l.feature.padEnd(35),
    String(l.winner.mean.toFixed(2)).padStart(12),
    String(l.loser.mean.toFixed(2)).padStart(11),
    String(l.effect.toFixed(2)).padStart(13),
    String(l.winner.p50.toFixed(2)).padStart(8),
    String(l.loser.p50.toFixed(2)).padStart(10),
  );
}

// Categorical features — check WR by level type, regime, tod, dow, approach
console.log(`\nCategorical breakdown (WR over all touches):`);
function catBreak(field, getter) {
  const groups = new Map();
  for (const t of touches) {
    const v = getter(t);
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(classify(t));
  }
  console.log(`\n  ${field}:`);
  const rows = [...groups.entries()].map(([v, outs]) => {
    const w = outs.filter(o => o === 'win').length;
    const l = outs.filter(o => o === 'loss').length;
    return { v, n: outs.length, w, l, wr: outs.length > 0 ? w / outs.length : 0 };
  }).sort((a, b) => b.wr - a.wr);
  for (const r of rows) {
    console.log(`    ${String(r.v).padEnd(15)} n=${String(r.n).padStart(5)} W=${String(r.w).padStart(4)} L=${String(r.l).padStart(4)}  WR=${(r.wr*100).toFixed(1)}%`);
  }
}
catBreak('level_type', t => t.level_type);
catBreak('approach', t => t.approach);
catBreak('regime', t => t.features.regime);
catBreak('tod_bucket', t => t.features.tod_bucket);
catBreak('dow', t => t.features.dow);

// Cross-tab: level_type × approach
console.log(`\nCross-tab level_type × approach:`);
const ct = new Map();
for (const t of touches) {
  const k = `${t.level_type}/${t.approach}`;
  if (!ct.has(k)) ct.set(k, []);
  ct.get(k).push(classify(t));
}
const rows = [...ct.entries()].map(([k, outs]) => {
  const w = outs.filter(o => o === 'win').length;
  const l = outs.filter(o => o === 'loss').length;
  return { k, n: outs.length, w, l, wr: outs.length > 0 ? w / outs.length : 0 };
}).filter(r => r.n >= 100).sort((a, b) => b.wr - a.wr);
console.log(`    ${'cell'.padEnd(25)} n      W    L    WR`);
for (const r of rows) {
  console.log(`    ${r.k.padEnd(25)} ${String(r.n).padStart(5)} ${String(r.w).padStart(4)} ${String(r.l).padStart(4)}  ${(r.wr*100).toFixed(1)}%`);
}

// === Same analysis but for BREAK direction with the same target/stop ===
function classifyBreak(t) {
  const w = t.brk;
  const tt = w.time_to_target_sec?.[TARGET];
  const ts = w.time_to_stop_sec?.[STOP];
  const hs = HOLD * 60;
  const tHit = tt != null && tt <= hs ? tt : null;
  const sHit = ts != null && ts <= hs ? ts : null;
  if (tHit != null && (sHit == null || tHit < sHit)) return 'win';
  if (sHit != null) return 'loss';
  return 'neither';
}
console.log(`\n=== BREAK direction T${TARGET}/S${STOP}/H${HOLD} cross-tab level_type × approach ===`);
const ct2 = new Map();
for (const t of touches) {
  const k = `${t.level_type}/${t.approach}`;
  if (!ct2.has(k)) ct2.set(k, []);
  ct2.get(k).push(classifyBreak(t));
}
const rows2 = [...ct2.entries()].map(([k, outs]) => {
  const w = outs.filter(o => o === 'win').length;
  const l = outs.filter(o => o === 'loss').length;
  return { k, n: outs.length, w, l, wr: outs.length > 0 ? w / outs.length : 0 };
}).filter(r => r.n >= 100).sort((a, b) => b.wr - a.wr);
console.log(`    ${'cell'.padEnd(25)} n      W    L    WR`);
for (const r of rows2) {
  console.log(`    ${r.k.padEnd(25)} ${String(r.n).padStart(5)} ${String(r.w).padStart(4)} ${String(r.l).padStart(4)}  ${(r.wr*100).toFixed(1)}%`);
}
