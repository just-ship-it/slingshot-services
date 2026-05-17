/**
 * Drill into the top pair filter: what does (gamma_imbalance d4, dist_next_break_level d6) actually mean?
 * Break down by level_type, tod_bucket, regime, and other contextual features.
 */
import fs from 'fs';

const IN_PATH = process.argv[process.argv.indexOf('--in') + 1];
const data = JSON.parse(fs.readFileSync(IN_PATH, 'utf-8'));
const touches = data.touches;

function flat(t) { return { ...t.features, ...t.s1 }; }
function labelBreak(t, target, stop, hold) {
  const w = t.brk;
  const tt = w.time_to_target_sec?.[target];
  const ts = w.time_to_stop_sec?.[stop];
  const hs = hold * 60;
  if (tt != null && tt <= hs && (ts == null || ts > hs || tt < ts)) return 'win';
  if (ts != null && ts <= hs) return 'loss';
  return 'timeout';
}

// Get distribution of dist_next_break_level
const allDist = touches.map(t => t.features.dist_next_break_level).filter(v => v != null);
allDist.sort((a, b) => a - b);
console.log(`dist_next_break_level distribution: min=${allDist[0]}, p10=${allDist[Math.floor(allDist.length*0.1)]}, p50=${allDist[Math.floor(allDist.length/2)]}, p90=${allDist[Math.floor(allDist.length*0.9)]}, max=${allDist[allDist.length-1]}`);
console.log(`Unique values around 200pt:`);
const cluster200 = allDist.filter(v => v >= 195 && v <= 215);
const counts = {};
for (const v of cluster200) counts[v.toFixed(2)] = (counts[v.toFixed(2)] || 0) + 1;
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
for (const [v, c] of sorted.slice(0, 20)) console.log(`  ${v}pt: ${c} touches`);

console.log(`\n--- Top filter (gamma_imbalance in (0.036, 0.264], dist_next_break_level in (207.1, 208.22]) ---`);
const target = 15, stop = 12, hold = 15;
const matched = touches.filter(t => {
  const gi = t.features.gamma_imbalance;
  const d = t.features.dist_next_break_level;
  return gi != null && gi > 0.036 && gi <= 0.264 && d != null && d > 207.1 && d <= 208.22;
});
console.log(`Matched: ${matched.length} touches`);

const labels = matched.map(t => labelBreak(t, target, stop, hold));
const w = labels.filter(l => l === 'win').length;
const l_ = labels.filter(l => l === 'loss').length;
const to = labels.filter(l => l === 'timeout').length;
console.log(`Break outcomes (T${target}/S${stop}/H${hold}): W=${w} L=${l_} TO=${to}  WR=${(w / matched.length * 100).toFixed(1)}%`);

// Break down by level_type
console.log(`\nBreakdown by level_type:`);
const byLevel = new Map();
matched.forEach((t, i) => {
  const lt = t.level_type;
  if (!byLevel.has(lt)) byLevel.set(lt, []);
  byLevel.get(lt).push(labels[i]);
});
for (const [lt, outs] of byLevel.entries()) {
  const w = outs.filter(o => o === 'win').length;
  const l = outs.filter(o => o === 'loss').length;
  const t = outs.filter(o => o === 'timeout').length;
  console.log(`  ${lt.padEnd(12)} n=${String(outs.length).padStart(4)}  W=${w} L=${l} TO=${t}  WR=${(w / outs.length * 100).toFixed(1)}%`);
}

// Breakdown by approach
console.log(`\nBreakdown by approach:`);
const byAppr = new Map();
matched.forEach((t, i) => {
  const a = t.approach;
  if (!byAppr.has(a)) byAppr.set(a, []);
  byAppr.get(a).push(labels[i]);
});
for (const [a, outs] of byAppr.entries()) {
  const w = outs.filter(o => o === 'win').length;
  const l = outs.filter(o => o === 'loss').length;
  console.log(`  ${a.padEnd(12)} n=${String(outs.length).padStart(4)}  W=${w} L=${l}  WR=${(w / outs.length * 100).toFixed(1)}%`);
}

// Breakdown by TOD
console.log(`\nBreakdown by tod_bucket:`);
const byTod = new Map();
matched.forEach((t, i) => {
  const tod = t.features.tod_bucket;
  if (!byTod.has(tod)) byTod.set(tod, []);
  byTod.get(tod).push(labels[i]);
});
for (const [tod, outs] of byTod.entries()) {
  const w = outs.filter(o => o === 'win').length;
  const l = outs.filter(o => o === 'loss').length;
  console.log(`  ${tod.padEnd(15)} n=${String(outs.length).padStart(4)}  W=${w} L=${l}  WR=${(w / outs.length * 100).toFixed(1)}%`);
}

// Time distribution of matched events
console.log(`\nDate range of matched events:`);
const dates = matched.map(t => t.date).sort();
console.log(`  First: ${dates[0]}`);
console.log(`  Last:  ${dates[dates.length - 1]}`);
const months = new Map();
for (const d of dates) {
  const m = d.slice(0, 7);
  months.set(m, (months.get(m) || 0) + 1);
}
console.log(`  By month:`);
[...months.entries()].sort().forEach(([m, c]) => console.log(`    ${m}: ${c}`));

// Now: relax dist_next_break_level constraint — does the gamma filter alone hold up?
console.log(`\n--- Relax dist_next_break_level: just gamma_imbalance in (0.036, 0.264] ---`);
const justGi = touches.filter(t => {
  const gi = t.features.gamma_imbalance;
  return gi != null && gi > 0.036 && gi <= 0.264;
});
const justGiLabels = justGi.map(t => labelBreak(t, target, stop, hold));
const wG = justGiLabels.filter(l => l === 'win').length;
const lG = justGiLabels.filter(l => l === 'loss').length;
console.log(`Matched: ${justGi.length}  W=${wG} L=${lG}  WR=${(wG / justGi.length * 100).toFixed(1)}%`);
