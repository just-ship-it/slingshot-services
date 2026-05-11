/**
 * Track A — Deep-dive on negative-regime support touches.
 *
 * Question: in the honest Track 1 sample, support touches (put_wall/S1..S5)
 * in negative-gamma regime approached from above showed +16 to +27 pt mean
 * forward 15m return on n=82-145 each. But MAE is high (~30pt). Is there a
 * filter that separates winners from losers cleanly enough to make this a
 * tradable setup?
 *
 * Inputs:  the most recent gex-touch-reactions-*.touches.json (must already
 *          be the honest run with snap_lag_min=16 OR fixed data).
 *
 * Output:  research/output/track-a-negative-support-deepdive-<ts>.md
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'research', 'output');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}
const INPUT = arg('input', null);

let touchesPath = INPUT;
if (!touchesPath) {
  // Find most recent touches file
  const files = fs.readdirSync(OUT_DIR)
    .filter(f => f.startsWith('gex-touch-reactions-') && f.endsWith('.touches.json'))
    .sort();
  if (!files.length) { console.error('No touch files found.'); process.exit(1); }
  touchesPath = path.join(OUT_DIR, files[files.length - 1]);
}
console.log(`Input: ${touchesPath}`);

const all = JSON.parse(fs.readFileSync(touchesPath, 'utf-8'));
console.log(`Total touches: ${all.length}`);

// Filter to the candidate setup: negative regime + support level + approach from_above
const SUPPORT_TYPES = new Set(['put_wall', 'S1', 'S2', 'S3', 'S4', 'S5']);
const sample = all.filter(t =>
  t.regime === 'negative' &&
  SUPPORT_TYPES.has(t.level_type) &&
  t.approach === 'from_above'
);
console.log(`Candidate sample (negative regime, support, from_above): ${sample.length}`);

// Note: put_wall and S1 are the same level on most days (the put_wall is
// always the strongest support). Don't double-count when stratifying.
// Filter dedupe: per (timestamp, level_price), keep one.
const seen = new Set();
const dedup = [];
for (const t of sample) {
  const k = `${t.timestamp}|${Math.round(t.level_price * 100)}`;
  if (seen.has(k)) continue;
  seen.add(k);
  dedup.push(t);
}
console.log(`After put_wall/S1 dedupe: ${dedup.length}\n`);

// --- helpers ---
function statsOf(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const n = arr.length;
  const sum = arr.reduce((s, v) => s + v, 0);
  const mean = sum / n;
  const wins = arr.filter(v => v > 0).length;
  return {
    n, mean, win: wins / n,
    median: sorted[Math.floor(n * 0.5)],
    p25: sorted[Math.floor(n * 0.25)],
    p75: sorted[Math.floor(n * 0.75)],
  };
}

function bucket(touches, keyFn) {
  const groups = {};
  for (const t of touches) {
    const k = keyFn(t);
    if (k == null) continue;
    if (!groups[k]) groups[k] = [];
    groups[k].push(t);
  }
  return groups;
}

function reportGroups(groups, title, horizon = 'fwd_15m') {
  const rows = [];
  for (const [key, items] of Object.entries(groups)) {
    const ret = items.map(t => t.forwards?.[horizon]?.return).filter(v => v != null);
    const mfe = items.map(t => t.forwards?.[horizon]?.mfe).filter(v => v != null);
    const mae = items.map(t => t.forwards?.[horizon]?.mae).filter(v => v != null);
    const r = statsOf(ret);
    const m = statsOf(mfe);
    const a = statsOf(mae);
    if (!r) continue;
    rows.push({
      key, n: r.n,
      ret_mean: r.mean, ret_median: r.median, win: r.win,
      mfe_mean: m?.mean ?? null, mae_mean: a?.mean ?? null,
      edge: (m?.mean ?? 0) - (a?.mean ?? 0),
    });
  }
  rows.sort((a, b) => b.edge - a.edge);
  return { title, horizon, rows };
}

// --- bucketing functions ---
function gexMagBucket(t) {
  // Use total_gex magnitude
  const mag = Math.abs(t.total_gex);
  if (mag < 1e9) return '<1B';
  if (mag < 3e9) return '1-3B';
  if (mag < 6e9) return '3-6B';
  if (mag < 1e10) return '6-10B';
  return '10B+';
}

function gammaImbalanceBucket(t) {
  // gamma_imbalance is in [-1, 1]. Negative regime should have negative imbalance.
  const v = t.gamma_imbalance;
  if (v == null) return null;
  if (v < -0.8) return 'q1: <-0.8';
  if (v < -0.6) return 'q2: -0.8 to -0.6';
  if (v < -0.4) return 'q3: -0.6 to -0.4';
  if (v < -0.2) return 'q4: -0.4 to -0.2';
  return 'q5: >-0.2';
}

function levelGexBucket(t) {
  const mag = Math.abs(t.level_gex);
  if (mag < 1e8) return '<100M';
  if (mag < 5e8) return '100-500M';
  if (mag < 1e9) return '500M-1B';
  if (mag < 2e9) return '1-2B';
  return '2B+';
}

function levelTypeBucket(t) {
  // Group put_wall/S1 together since they alias; keep S2-S5 separate
  if (t.level_type === 'put_wall' || t.level_type === 'S1') return 'put_wall/S1';
  return t.level_type;
}

function todBucket(t) {
  return t.tod;
}

// --- run all stratifications ---
const stratifications = [
  ['by level type', levelTypeBucket],
  ['by ToD', todBucket],
  ['by total_gex magnitude', gexMagBucket],
  ['by gamma_imbalance', gammaImbalanceBucket],
  ['by level_gex magnitude', levelGexBucket],
];

const reports = stratifications.map(([title, fn]) =>
  reportGroups(bucket(dedup, fn), title)
);

// Two-way: level type X gamma_imbalance
const reports2way = reportGroups(
  bucket(dedup, t => `${levelTypeBucket(t)} | ${gammaImbalanceBucket(t)}`),
  'level type X gamma_imbalance', 'fwd_15m'
);

// Two-way: ToD x level type
const reportsTod = reportGroups(
  bucket(dedup, t => `${levelTypeBucket(t)} | ${t.tod}`),
  'level type X ToD', 'fwd_15m'
);

// --- print ---
function print(report) {
  console.log(`\n=== ${report.title} (${report.horizon}, win = forward return > 0) ===`);
  console.log(['key'.padEnd(40), 'n'.padStart(5), 'win%'.padStart(6),
    'ret_mean'.padStart(10), 'ret_med'.padStart(8), 'mfe_mean'.padStart(10),
    'mae_mean'.padStart(10), 'edge'.padStart(8)].join(' '));
  for (const r of report.rows) {
    if (r.n < 10) continue;
    console.log([
      r.key.padEnd(40),
      String(r.n).padStart(5),
      (100 * r.win).toFixed(1).padStart(6),
      r.ret_mean.toFixed(2).padStart(10),
      r.ret_median.toFixed(2).padStart(8),
      r.mfe_mean.toFixed(2).padStart(10),
      r.mae_mean.toFixed(2).padStart(10),
      r.edge.toFixed(2).padStart(8),
    ].join(' '));
  }
}

console.log(`\n## Baseline (no filter): n=${dedup.length}`);
{
  const ret = dedup.map(t => t.forwards?.fwd_15m?.return).filter(v => v != null);
  const mfe = dedup.map(t => t.forwards?.fwd_15m?.mfe).filter(v => v != null);
  const mae = dedup.map(t => t.forwards?.fwd_15m?.mae).filter(v => v != null);
  const r = statsOf(ret), m = statsOf(mfe), a = statsOf(mae);
  console.log(`  ret_mean=${r.mean.toFixed(2)} win=${(100 * r.win).toFixed(1)}% mfe_mean=${m.mean.toFixed(2)} mae_mean=${a.mean.toFixed(2)} edge=${((m.mean) - (a.mean)).toFixed(2)}`);
}

for (const r of reports) print(r);
print(reports2way);
print(reportsTod);

// --- write markdown report ---
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(OUT_DIR, `track-a-negative-support-deepdive-${ts}.md`);
const lines = [];
lines.push('# Track A — Negative-regime support touch deep-dive\n');
lines.push(`- Sample: negative regime + support type + approach=from_above`);
lines.push(`- Touches (after put_wall/S1 dedupe): **${dedup.length}**`);
lines.push(`- Source: \`${path.basename(touchesPath)}\`\n`);

function tableMd(report) {
  const out = [`## ${report.title}\n`];
  out.push('| key | n | win% | ret_mean | ret_median | mfe_mean | mae_mean | edge |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of report.rows) {
    if (r.n < 10) continue;
    out.push(`| ${r.key} | ${r.n} | ${(100 * r.win).toFixed(1)}% | ${r.ret_mean.toFixed(2)} | ${r.ret_median.toFixed(2)} | ${r.mfe_mean?.toFixed(2) ?? ''} | ${r.mae_mean?.toFixed(2) ?? ''} | ${r.edge.toFixed(2)} |`);
  }
  return out.join('\n');
}

lines.push(tableMd({ title: 'Baseline (no filter)', rows: [{
  key: 'all', n: dedup.length,
  win: dedup.filter(t => (t.forwards?.fwd_15m?.return ?? 0) > 0).length / dedup.length,
  ret_mean: dedup.reduce((s, t) => s + (t.forwards?.fwd_15m?.return ?? 0), 0) / dedup.length,
  ret_median: 0,
  mfe_mean: dedup.reduce((s, t) => s + (t.forwards?.fwd_15m?.mfe ?? 0), 0) / dedup.length,
  mae_mean: dedup.reduce((s, t) => s + (t.forwards?.fwd_15m?.mae ?? 0), 0) / dedup.length,
  edge: 0,
}] }));
lines.push('');

for (const r of [...reports, reports2way, reportsTod]) {
  lines.push(tableMd(r));
  lines.push('');
}

fs.writeFileSync(outPath, lines.join('\n'));
console.log(`\nWrote ${outPath}`);
