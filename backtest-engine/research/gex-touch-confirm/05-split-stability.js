/**
 * Phase 5: Split-half stability check.
 *
 * Phase 4 surfaces top composite filters; with 50-200 trades over 16 months,
 * some "edge" could be random. This script splits the dataset chronologically
 * (first half vs second half) and reports each filter's WR and PF on each
 * half. Filters whose edge holds across BOTH halves are likely robust.
 *
 * Filters whose edge appears in only one half should be discarded as
 * regime-specific or overfit.
 *
 * Usage:
 *   node research/gex-touch-confirm/05-split-stability.js \
 *     --in research/output/gex-touch-confirm-v2-base-<TS>.enriched.json
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
if (!IN) { console.error('Missing --in'); process.exit(1); }
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);

const payload = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const { touches } = payload;
console.log(`\n=== Phase 5: Split-half stability check ===`);
console.log(`Touches: ${touches.length.toLocaleString()}`);

// Sort by timestamp and split at midpoint
const sortedTouches = [...touches].sort((a, b) => a.ts - b.ts);
const midIdx = Math.floor(sortedTouches.length / 2);
const firstHalf = sortedTouches.slice(0, midIdx);
const secondHalf = sortedTouches.slice(midIdx);
const splitTs = sortedTouches[midIdx].ts;
console.log(`Split at: ${new Date(splitTs).toISOString()} (idx ${midIdx})`);
console.log(`First half:  ${firstHalf.length.toLocaleString()} touches`);
console.log(`Second half: ${secondHalf.length.toLocaleString()} touches`);

function flatten(touches, setup, stop) {
  const out = [];
  for (const t of touches) {
    for (const o of t.outcomes) {
      if (o.setup !== setup) continue;
      for (const s of o.stops) {
        if (s.stop !== stop) continue;
        out.push({ outcome: s.outcome, features: t.features || {}, level_type: t.level_type, regime: t.regime, tod: t.tod, approach: t.approach });
      }
    }
  }
  return out;
}

function metrics(arr, stopPts, target = 20) {
  let wins = 0, losses = 0, no_fill = 0;
  for (const r of arr) {
    if (r.outcome === 'win') wins++;
    else if (r.outcome === 'loss') losses++;
    else if (r.outcome === 'no_fill') no_fill++;
  }
  const n_decided = wins + losses;
  const n_filled = arr.length - no_fill;
  const wr = n_decided > 0 ? wins / n_decided : null;
  const grossWin = wins * target;
  const grossLoss = losses * stopPts;
  const pf = grossLoss > 0 ? grossWin / grossLoss : (wins > 0 ? Infinity : null);
  const total = grossWin - grossLoss;
  return { n_filled, n_decided, wr, pf, total };
}

function pctileFromFull(name, q) {
  const vals = [];
  for (const t of touches) {
    const v = t.features?.[name];
    if (v != null && !isNaN(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return vals[Math.floor(q * vals.length)];
}

// Define top filters from Phase 4 results (manually curated based on prior runs).
// These are the strong triples for bounce stop=15 and stop=20.
const cuts = {
  vwap_p60: pctileFromFull('s1_vwap_close_diff', 0.60),
  vwap_p70: pctileFromFull('s1_vwap_close_diff', 0.70),
  vwap_p80: pctileFromFull('s1_vwap_close_diff', 0.80),
  vwap_p90: pctileFromFull('s1_vwap_close_diff', 0.90),
  minDist_p70: pctileFromFull('s1_min_dist_to_level', 0.70),
  minDist_p80: pctileFromFull('s1_min_dist_to_level', 0.80),
  minDist_p90: pctileFromFull('s1_min_dist_to_level', 0.90),
  rejWick_p90: pctileFromFull('touch_rej_wick_pts', 0.90),
  bodyRatio_p20: pctileFromFull('touch_body_range_ratio', 0.20),
  skew_p10: pctileFromFull('qqq_iv_skew', 0.10),
  skew_p20: pctileFromFull('qqq_iv_skew', 0.20),
  atr_p80: pctileFromFull('atr14', 0.80),
  atr_p90: pctileFromFull('atr14', 0.90),
};

console.log(`\nFeature percentile cuts (computed on full dataset):`);
for (const [k, v] of Object.entries(cuts)) {
  console.log(`  ${k.padEnd(20)} = ${v?.toFixed(4)}`);
}

const filters = [
  {
    name: 'vwap_p60 AND minDist_p80 AND atr_p90',
    pred: (t) => (t.features?.s1_vwap_close_diff ?? -Infinity) >= cuts.vwap_p60
      && (t.features?.s1_min_dist_to_level ?? -Infinity) >= cuts.minDist_p80
      && (t.features?.atr14 ?? -Infinity) >= cuts.atr_p90,
  },
  {
    name: 'vwap_p70 AND minDist_p80 AND atr_p80',
    pred: (t) => (t.features?.s1_vwap_close_diff ?? -Infinity) >= cuts.vwap_p70
      && (t.features?.s1_min_dist_to_level ?? -Infinity) >= cuts.minDist_p80
      && (t.features?.atr14 ?? -Infinity) >= cuts.atr_p80,
  },
  {
    name: 'vwap_p80 AND atr_p90',
    pred: (t) => (t.features?.s1_vwap_close_diff ?? -Infinity) >= cuts.vwap_p80
      && (t.features?.atr14 ?? -Infinity) >= cuts.atr_p90,
  },
  {
    name: 'vwap_p70 AND atr_p80',
    pred: (t) => (t.features?.s1_vwap_close_diff ?? -Infinity) >= cuts.vwap_p70
      && (t.features?.atr14 ?? -Infinity) >= cuts.atr_p80,
  },
  {
    name: 'vwap_p70 AND skew_p10 AND atr_p90',
    pred: (t) => (t.features?.s1_vwap_close_diff ?? -Infinity) >= cuts.vwap_p70
      && (t.features?.qqq_iv_skew ?? Infinity) < cuts.skew_p10
      && (t.features?.atr14 ?? -Infinity) >= cuts.atr_p90,
  },
  {
    name: 'rejWick_p90 AND bodyRatio_p20 AND skew_p10',
    pred: (t) => (t.features?.touch_rej_wick_pts ?? -Infinity) >= cuts.rejWick_p90
      && (t.features?.touch_body_range_ratio ?? Infinity) < cuts.bodyRatio_p20
      && (t.features?.qqq_iv_skew ?? Infinity) < cuts.skew_p10,
  },
  {
    name: 'vwap_p70 (single filter)',
    pred: (t) => (t.features?.s1_vwap_close_diff ?? -Infinity) >= cuts.vwap_p70,
  },
  {
    name: 'minDist_p80 (single filter)',
    pred: (t) => (t.features?.s1_min_dist_to_level ?? -Infinity) >= cuts.minDist_p80,
  },
];

console.log(`\n=== Stability of top filters across chronological halves ===\n`);

for (const stop of [10, 15, 20]) {
  console.log(`--- Bounce, stop=${stop}pts ---`);
  console.log('filter'.padEnd(45),
    'H1 n'.padStart(6), 'H1 WR'.padStart(7), 'H1 PF'.padStart(6),
    'H2 n'.padStart(6), 'H2 WR'.padStart(7), 'H2 PF'.padStart(6),
    'Δ WR'.padStart(7), 'verdict'.padStart(11));

  for (const f of filters) {
    const h1 = firstHalf.filter(f.pred);
    const h2 = secondHalf.filter(f.pred);
    const m1 = metrics(flatten(h1, 'bounce', stop), stop);
    const m2 = metrics(flatten(h2, 'bounce', stop), stop);

    const wrDelta = (m1.wr != null && m2.wr != null) ? m1.wr - m2.wr : null;
    let verdict = 'stable';
    if (m1.n_decided < 20 || m2.n_decided < 20) verdict = 'low_n';
    else if (Math.abs(wrDelta) > 0.15) verdict = 'UNSTABLE';
    else if (m1.pf < 1.5 || m2.pf < 1.5) verdict = 'weak';

    console.log(
      f.name.padEnd(45).slice(0, 45),
      String(m1.n_filled).padStart(6),
      (m1.wr != null ? (m1.wr * 100).toFixed(1) + '%' : '-').padStart(7),
      (m1.pf != null && isFinite(m1.pf) ? m1.pf.toFixed(2) : '-').padStart(6),
      String(m2.n_filled).padStart(6),
      (m2.wr != null ? (m2.wr * 100).toFixed(1) + '%' : '-').padStart(7),
      (m2.pf != null && isFinite(m2.pf) ? m2.pf.toFixed(2) : '-').padStart(6),
      (wrDelta != null ? (wrDelta * 100).toFixed(1) + 'pp' : '-').padStart(7),
      verdict.padStart(11),
    );
  }
  console.log();
}
