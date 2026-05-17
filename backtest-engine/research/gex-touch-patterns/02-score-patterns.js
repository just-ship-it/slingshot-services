/**
 * GEX-Touch Patterns — Phase 2: pattern scoring + segmentation.
 *
 * Reads the trigger dataset from Phase 1 and produces:
 *   • Per-pattern overall: n, WR, PF, total_pts, avg MFE/MAE
 *   • Per-pattern × level-type, regime, IV bucket, TOD, gex-mag-bucket
 *   • Equity-curve drawdown estimate per pattern
 *   • Time-series stability: H1 vs H2 split
 *
 * Usage:
 *   node research/gex-touch-patterns/02-score-patterns.js \
 *     --in research/output/gex-touch-patterns-base-<TS>.json \
 *     [--min-n 30]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const IN = arg('in');
if (!IN) { console.error('Missing --in <path>'); process.exit(1); }
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);
const MIN_N = Number(arg('min-n', 30));

const data = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const { triggers, config } = data;
const TARGET_POINTS = config.TARGET_POINTS;

console.log(`\n=== Phase 2: Pattern scoring (input ${path.basename(inPath)}) ===`);
console.log(`Triggers: ${triggers.length.toLocaleString()}`);
console.log(`Touch range: ${config.START} → ${config.END}\n`);

function computeMetrics(arr) {
  let win = 0, loss = 0, timeout = 0, eod = 0, rollover = 0;
  let sumPts = 0, sumStop = 0, sumMfe = 0, sumMae = 0;
  let winsPts = 0, lossPts = 0;
  const pnlSequence = [];
  for (const t of arr) {
    const stop = t.stop_distance;
    sumStop += stop;
    sumMfe += t.mfe || 0;
    sumMae += t.mae || 0;
    let pts;
    if (t.outcome === 'win') { win++; pts = TARGET_POINTS; winsPts += TARGET_POINTS; }
    else if (t.outcome === 'loss') { loss++; pts = -stop; lossPts += stop; }
    else if (t.outcome === 'timeout') { timeout++; pts = 0; }
    else if (t.outcome === 'eod') { eod++; pts = 0; }
    else if (t.outcome === 'rollover') { rollover++; pts = 0; }
    else pts = 0;
    sumPts += pts;
    pnlSequence.push({ ts: t.trigger_ts, pts });
  }
  const n = arr.length;
  const decided = win + loss;
  const wr = decided > 0 ? win / decided : null;
  const pf = lossPts > 0 ? winsPts / lossPts : (winsPts > 0 ? Infinity : 0);
  const ev = n > 0 ? sumPts / n : 0;
  const avgStop = n > 0 ? sumStop / n : 0;
  const avgMfe = n > 0 ? sumMfe / n : 0;
  const avgMae = n > 0 ? sumMae / n : 0;

  // Max drawdown on equity curve (in pts; $20/pt for NQ)
  pnlSequence.sort((a, b) => a.ts - b.ts);
  let cum = 0, peak = 0, maxDD = 0;
  for (const e of pnlSequence) {
    cum += e.pts;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  // Sharpe approx: per-trade pts vs std
  if (n > 1) {
    const mean = sumPts / n;
    let varSum = 0;
    for (const e of pnlSequence) varSum += (e.pts - mean) ** 2;
    const sd = Math.sqrt(varSum / n);
    var sharpe = sd > 0 ? mean / sd : 0;
  } else var sharpe = 0;

  return { n, win, loss, timeout, eod, rollover, decided, wr, pf, sumPts, ev, avgStop, avgMfe, avgMae, maxDD, sharpe };
}

// Overall per-pattern
const byPattern = new Map();
for (const t of triggers) {
  if (!byPattern.has(t.pattern)) byPattern.set(t.pattern, []);
  byPattern.get(t.pattern).push(t);
}

function fmt(m) {
  return `n=${String(m.n).padStart(4)}  W=${String(m.win).padStart(3)} L=${String(m.loss).padStart(3)} TO=${String(m.timeout).padStart(2)} EOD=${String(m.eod).padStart(2)} ROv=${String(m.rollover).padStart(2)}  WR=${(m.wr == null ? '-' : (m.wr*100).toFixed(1)+'%').padStart(6)}  PF=${(isFinite(m.pf) ? m.pf.toFixed(2) : '∞').padStart(5)}  EV=${m.ev.toFixed(2).padStart(6)}  Sh=${m.sharpe.toFixed(2).padStart(5)}  avgStop=${m.avgStop.toFixed(1).padStart(5)}  pts=${String(Math.round(m.sumPts)).padStart(6)}  $=${String(Math.round(m.sumPts*20)).padStart(7)}  DD=${String(Math.round(m.maxDD*20)).padStart(6)}`;
}

console.log('=== Per-pattern overall ===');
console.log('pattern    n      W   L   TO  EOD ROv  WR      PF      EV     Sh     avgStop  pts    $        DD');
const patternList = Array.from(byPattern.keys()).sort();
for (const p of patternList) {
  const m = computeMetrics(byPattern.get(p));
  if (m.n < MIN_N) continue;
  console.log(p.padEnd(8) + ' ' + fmt(m));
}

// Per-pattern × level type
console.log('\n=== Per-pattern × level_type (n >= 20) ===');
for (const p of patternList) {
  const buckets = new Map();
  for (const t of byPattern.get(p)) {
    if (!buckets.has(t.level_type)) buckets.set(t.level_type, []);
    buckets.get(t.level_type).push(t);
  }
  console.log(`\n  pattern=${p}:`);
  for (const [lt, arr] of buckets.entries()) {
    if (arr.length < 20) continue;
    const m = computeMetrics(arr);
    console.log(`    ${lt.padEnd(10)} ` + fmt(m));
  }
}

// Per-pattern × regime
console.log('\n=== Per-pattern × regime (n >= 20) ===');
for (const p of patternList) {
  const buckets = new Map();
  for (const t of byPattern.get(p)) {
    if (!buckets.has(t.regime)) buckets.set(t.regime, []);
    buckets.get(t.regime).push(t);
  }
  console.log(`\n  pattern=${p}:`);
  for (const [r, arr] of buckets.entries()) {
    if (arr.length < 20) continue;
    const m = computeMetrics(arr);
    console.log(`    ${r.padEnd(18)} ` + fmt(m));
  }
}

// Per-pattern × time of day
console.log('\n=== Per-pattern × TOD ===');
for (const p of patternList) {
  const buckets = new Map();
  for (const t of byPattern.get(p)) {
    if (!buckets.has(t.tod)) buckets.set(t.tod, []);
    buckets.get(t.tod).push(t);
  }
  console.log(`\n  pattern=${p}:`);
  for (const [r, arr] of buckets.entries()) {
    if (arr.length < 15) continue;
    const m = computeMetrics(arr);
    console.log(`    ${r.padEnd(12)} ` + fmt(m));
  }
}

// IV skew buckets
console.log('\n=== Per-pattern × IV-skew bucket (low/med/high) ===');
// global IV skew percentiles
const skews = triggers.map(t => t.iv_skew_trigger).filter(x => x != null);
skews.sort((a, b) => a - b);
const ivP33 = skews[Math.floor(0.333 * skews.length)] ?? 0;
const ivP67 = skews[Math.floor(0.667 * skews.length)] ?? 0;
console.log(`(IV skew p33=${ivP33?.toFixed(4)}, p67=${ivP67?.toFixed(4)})`);
function ivBucket(t) {
  if (t.iv_skew_trigger == null) return null;
  if (t.iv_skew_trigger < ivP33) return 'low_skew';
  if (t.iv_skew_trigger < ivP67) return 'med_skew';
  return 'high_skew';
}
for (const p of patternList) {
  const buckets = new Map();
  for (const t of byPattern.get(p)) {
    const b = ivBucket(t);
    if (!b) continue;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(t);
  }
  console.log(`\n  pattern=${p}:`);
  for (const [r, arr] of buckets.entries()) {
    if (arr.length < 20) continue;
    const m = computeMetrics(arr);
    console.log(`    ${r.padEnd(12)} ` + fmt(m));
  }
}

// Direction breakdown
console.log('\n=== Per-pattern × direction ===');
for (const p of patternList) {
  const buckets = new Map();
  for (const t of byPattern.get(p)) {
    if (!buckets.has(t.direction)) buckets.set(t.direction, []);
    buckets.get(t.direction).push(t);
  }
  console.log(`\n  pattern=${p}:`);
  for (const [r, arr] of buckets.entries()) {
    if (arr.length < 15) continue;
    const m = computeMetrics(arr);
    console.log(`    ${r.padEnd(8)} ` + fmt(m));
  }
}

// H1 vs H2 stability
console.log('\n=== Per-pattern stability (H1 vs H2 split) ===');
const sorted = [...triggers].sort((a, b) => a.trigger_ts - b.trigger_ts);
const splitTs = sorted[Math.floor(sorted.length / 2)]?.trigger_ts;
console.log(`Split timestamp: ${new Date(splitTs).toISOString()}`);
for (const p of patternList) {
  const arr = byPattern.get(p);
  if (arr.length < 60) continue;
  const h1 = arr.filter(t => t.trigger_ts < splitTs);
  const h2 = arr.filter(t => t.trigger_ts >= splitTs);
  const m1 = computeMetrics(h1);
  const m2 = computeMetrics(h2);
  console.log(`\n  pattern=${p}:`);
  console.log(`    H1 ` + fmt(m1));
  console.log(`    H2 ` + fmt(m2));
}

// Combined patterns (union of two top performers, treated as a strategy)
console.log('\n=== Combined patterns (best subset, treat as a single strategy) ===');
// Identify top patterns by PF * sqrt(n)
const scored = [];
for (const p of patternList) {
  const m = computeMetrics(byPattern.get(p));
  if (m.n < MIN_N) continue;
  if (m.pf > 1.0 && m.sumPts > 0) scored.push({ p, ...m });
}
scored.sort((a, b) => b.pf * Math.sqrt(b.n) - a.pf * Math.sqrt(a.n));
console.log('Top patterns by PF × √n:');
for (const s of scored.slice(0, 7)) {
  console.log(`  ${s.p.padEnd(6)} ${fmt(s)}`);
}

// Combine top 2
if (scored.length >= 2) {
  const top2 = scored.slice(0, 2).map(s => s.p);
  const union = triggers.filter(t => top2.includes(t.pattern));
  const m = computeMetrics(union);
  console.log(`\nCombined ${top2.join('+')} (treated as one strategy):`);
  console.log('  ' + fmt(m));
}
// Combine top 3
if (scored.length >= 3) {
  const top3 = scored.slice(0, 3).map(s => s.p);
  const union = triggers.filter(t => top3.includes(t.pattern));
  const m = computeMetrics(union);
  console.log(`\nCombined ${top3.join('+')} (treated as one strategy):`);
  console.log('  ' + fmt(m));
}

// Output JSON summary
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(ROOT, 'research', 'output', `gex-touch-patterns-scored-${ts}.json`);
const result = {
  config,
  ivPctiles: { p33: ivP33, p67: ivP67 },
  perPattern: {},
};
for (const p of patternList) {
  result.perPattern[p] = computeMetrics(byPattern.get(p));
}
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`\nWritten: ${outPath}`);
