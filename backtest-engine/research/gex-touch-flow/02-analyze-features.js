/**
 * GEX-Touch Flow — Phase 2: feature analysis & filter mining.
 *
 * Reads the Phase-1 enriched dataset and:
 *   1. Labels each touch with outcome under a target/stop/hold config
 *   2. Reports baseline outcome rates (bounce vs break vs chop)
 *   3. For each feature: bucketed conditional WR with sample size
 *   4. Finds 2- and 3-feature combinations that yield WR ≥ threshold with sample size ≥ MIN_N
 *
 * Usage:
 *   node research/gex-touch-flow/02-analyze-features.js \
 *     --in research/output/gex-touch-flow-<TS>.json \
 *     --target 20 --stop 8 --hold 15 \
 *     --min-wr 0.70 --min-n 30
 */

import fs from 'fs';
import path from 'path';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}

const IN_PATH = arg('in', null);
if (!IN_PATH) { console.error('--in required'); process.exit(1); }
const TARGET = Number(arg('target', 20));
const STOP = Number(arg('stop', 8));
const HOLD_MIN = Number(arg('hold', 15));
const MIN_WR = Number(arg('min-wr', 0.70));
const MIN_N = Number(arg('min-n', 30));
const TOP_N = Number(arg('top-n', 30));

console.log(`\n=== GEX Touch Flow — Phase 2 (feature analysis) ===`);
console.log(`Input:        ${IN_PATH}`);
console.log(`Config:       target=${TARGET}pt  stop=${STOP}pt  hold=${HOLD_MIN}min`);
console.log(`Min WR:       ${MIN_WR}`);
console.log(`Min n:        ${MIN_N}\n`);

const data = JSON.parse(fs.readFileSync(IN_PATH, 'utf-8'));
const touches = data.touches;
console.log(`Loaded ${touches.length.toLocaleString()} touches\n`);

// ----- Label outcomes -----
// For a given direction's walk + config (target, stop, hold):
//   outcome ∈ { 'win', 'loss', 'timeout' }
function labelOutcome(walk, target, stop, holdMin) {
  if (!walk) return 'no_data';
  const tTarget = walk.time_to_target_sec?.[target];   // seconds, or null
  const tStop = walk.time_to_stop_sec?.[stop];          // seconds, or null
  const holdSec = holdMin * 60;
  const tHitTarget = tTarget != null && tTarget <= holdSec ? tTarget : null;
  const tHitStop = tStop != null && tStop <= holdSec ? tStop : null;
  if (tHitTarget != null && (tHitStop == null || tHitTarget < tHitStop)) return 'win';
  if (tHitStop != null) return 'loss';
  return 'timeout';
}

// Apply labels (both directions)
for (const t of touches) {
  t.bounce_outcome = labelOutcome(t.bounce, TARGET, STOP, HOLD_MIN);
  t.break_outcome = labelOutcome(t.brk, TARGET, STOP, HOLD_MIN);
}

// ----- Baseline outcome rates -----
function summarize(outcomes) {
  const n = outcomes.length;
  const w = outcomes.filter(o => o === 'win').length;
  const l = outcomes.filter(o => o === 'loss').length;
  const t = outcomes.filter(o => o === 'timeout').length;
  return { n, w, l, t, wr: n > 0 ? w / (w + l + t) : 0, wr_decided: (w + l) > 0 ? w / (w + l) : null };
}
const bounceSum = summarize(touches.map(t => t.bounce_outcome));
const breakSum = summarize(touches.map(t => t.break_outcome));
console.log(`Baseline outcome rates (all touches):`);
console.log(`  Bounce direction: n=${bounceSum.n} W=${bounceSum.w} L=${bounceSum.l} TO=${bounceSum.t}  WR=${(bounceSum.wr * 100).toFixed(1)}% (W/all)  WR=${bounceSum.wr_decided ? (bounceSum.wr_decided * 100).toFixed(1) + '%' : '-'} (W/decided)`);
console.log(`  Break direction:  n=${breakSum.n} W=${breakSum.w} L=${breakSum.l} TO=${breakSum.t}  WR=${(breakSum.wr * 100).toFixed(1)}% (W/all)  WR=${breakSum.wr_decided ? (breakSum.wr_decided * 100).toFixed(1) + '%' : '-'} (W/decided)`);

// For each direction, find what % of touches have win in only that direction (i.e., one-side winners)
const bounceOnly = touches.filter(t => t.bounce_outcome === 'win' && t.break_outcome !== 'win').length;
const breakOnly = touches.filter(t => t.break_outcome === 'win' && t.bounce_outcome !== 'win').length;
const both = touches.filter(t => t.bounce_outcome === 'win' && t.break_outcome === 'win').length;
console.log(`  Bounce-only winner: ${bounceOnly} (${(bounceOnly / touches.length * 100).toFixed(1)}%)`);
console.log(`  Break-only winner:  ${breakOnly} (${(breakOnly / touches.length * 100).toFixed(1)}%)`);
console.log(`  Both directions win: ${both} (${(both / touches.length * 100).toFixed(1)}%)`);
console.log(`  Neither wins (chop): ${touches.length - bounceOnly - breakOnly - both} (${((touches.length - bounceOnly - breakOnly - both) / touches.length * 100).toFixed(1)}%)\n`);

// ----- Feature value extraction -----
// Combine 1m features and 1s features into one flat record per touch
function flatten(t) {
  const f = {
    ...t.features,
    ...t.s1,
    // additional derived
    s1_minute_vol_ratio: t.s1.s1_total_vol && t.features.vol_touch_bar ? +(t.s1.s1_total_vol / t.features.vol_touch_bar).toFixed(2) : null,
  };
  return f;
}

// ----- Define buckets for numeric features -----
// For a numeric feature, bucket into deciles (or as configured). For boolean/categorical, use as-is.
function getFeatureBuckets(name, values) {
  const nonNull = values.filter(v => v != null && !isNaN(v));
  if (nonNull.length === 0) return null;
  // Detect categorical / boolean
  const uniq = [...new Set(nonNull)];
  if (uniq.length <= 8) {
    // categorical
    return { type: 'categorical', values: uniq.sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)))) };
  }
  if (typeof nonNull[0] === 'boolean') {
    return { type: 'categorical', values: [false, true] };
  }
  // numeric — use deciles
  const sorted = [...nonNull].sort((a, b) => a - b);
  const deciles = [];
  for (let i = 1; i <= 9; i++) {
    deciles.push(sorted[Math.floor(sorted.length * i / 10)]);
  }
  return { type: 'numeric', deciles };
}

function bucketValue(v, buckets) {
  if (v == null || (typeof v === 'number' && isNaN(v))) return 'NULL';
  if (buckets.type === 'categorical') return String(v);
  // numeric — find decile
  for (let i = 0; i < buckets.deciles.length; i++) {
    if (v <= buckets.deciles[i]) return `d${i}`;
  }
  return `d${buckets.deciles.length}`;
}

// ----- Per-feature single-filter analysis -----
const features = flatten(touches[0]);
const featureNames = Object.keys(features);
console.log(`Features (n=${featureNames.length}): ${featureNames.slice(0, 10).join(', ')}, ...\n`);

const featureBuckets = {};
for (const fname of featureNames) {
  const vals = touches.map(t => flatten(t)[fname]);
  featureBuckets[fname] = getFeatureBuckets(fname, vals);
}

// For each direction × feature × bucket, compute conditional WR & sample size
const results = { bounce: [], break: [] };
for (const dir of ['bounce', 'break']) {
  const outcomeField = dir === 'bounce' ? 'bounce_outcome' : 'break_outcome';
  for (const fname of featureNames) {
    const buckets = featureBuckets[fname];
    if (!buckets) continue;
    // Group touches by bucket
    const groups = new Map();
    for (const t of touches) {
      const v = flatten(t)[fname];
      const b = bucketValue(v, buckets);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push(t[outcomeField]);
    }
    for (const [bucketLabel, outs] of groups.entries()) {
      const s = summarize(outs);
      if (s.n < MIN_N) continue;
      results[dir].push({
        direction: dir, feature: fname, bucket: bucketLabel,
        n: s.n, w: s.w, l: s.l, t: s.t, wr: s.wr,
        wr_decided: s.wr_decided,
        bucket_def: buckets.type === 'numeric' ? buckets.deciles : buckets.values,
      });
    }
  }
}

// Sort by WR descending, filter by min-WR
for (const dir of ['bounce', 'break']) {
  results[dir].sort((a, b) => b.wr - a.wr);
}

console.log(`=== Top single-filter buckets (WR ≥ ${MIN_WR}, n ≥ ${MIN_N}) ===`);
for (const dir of ['bounce', 'break']) {
  console.log(`\n--- ${dir} direction ---`);
  console.log(`feature                          bucket          n     W    L   TO    WR     bucket_def`);
  const top = results[dir].filter(r => r.wr >= MIN_WR).slice(0, TOP_N);
  if (top.length === 0) {
    console.log(`  (no single filter meets WR ≥ ${MIN_WR} with n ≥ ${MIN_N}; showing top ${TOP_N} by WR)`);
    for (const r of results[dir].slice(0, TOP_N)) {
      console.log(`  ${r.feature.padEnd(32)} ${r.bucket.padEnd(15)} ${String(r.n).padStart(4)} ${String(r.w).padStart(4)} ${String(r.l).padStart(4)} ${String(r.t).padStart(4)}  ${(r.wr * 100).toFixed(1)}%   ${JSON.stringify(r.bucket_def).slice(0, 80)}`);
    }
  } else {
    for (const r of top) {
      console.log(`  ${r.feature.padEnd(32)} ${r.bucket.padEnd(15)} ${String(r.n).padStart(4)} ${String(r.w).padStart(4)} ${String(r.l).padStart(4)} ${String(r.t).padStart(4)}  ${(r.wr * 100).toFixed(1)}%   ${JSON.stringify(r.bucket_def).slice(0, 80)}`);
    }
  }
}

// ----- Pair-filter analysis: find feature pairs that AMPLIFY WR -----
console.log(`\n\n=== Pair-filter scan (filtering bucket-pairs by combined WR) ===`);

// Pick a smaller candidate set of features for pair-scan to keep it tractable
const HIGH_VALUE_FEATURES = featureNames.filter(f =>
  /^vol_|s1_|approach_|touch_|regime|gamma_|level_type|tod_bucket|level_gex_rank|dist_next|tests_today/.test(f)
);
console.log(`Pair scan on ${HIGH_VALUE_FEATURES.length} candidate features\n`);

const flatTouches = touches.map(t => ({ ...flatten(t), bounce_outcome: t.bounce_outcome, break_outcome: t.break_outcome }));

const pairResults = { bounce: [], break: [] };
for (const dir of ['bounce', 'break']) {
  const outcomeField = dir === 'bounce' ? 'bounce_outcome' : 'break_outcome';
  for (let i = 0; i < HIGH_VALUE_FEATURES.length; i++) {
    const fa = HIGH_VALUE_FEATURES[i];
    const aBuckets = featureBuckets[fa];
    if (!aBuckets) continue;
    for (let j = i + 1; j < HIGH_VALUE_FEATURES.length; j++) {
      const fb = HIGH_VALUE_FEATURES[j];
      const bBuckets = featureBuckets[fb];
      if (!bBuckets) continue;
      // For each pair of bucket values, compute conditional WR
      const groups = new Map();
      for (const t of flatTouches) {
        const ba = bucketValue(t[fa], aBuckets);
        const bb = bucketValue(t[fb], bBuckets);
        const k = `${ba}|${bb}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(t[outcomeField]);
      }
      for (const [k, outs] of groups.entries()) {
        const s = summarize(outs);
        if (s.n < MIN_N) continue;
        if (s.wr < MIN_WR) continue;
        const [ba, bb] = k.split('|');
        pairResults[dir].push({
          direction: dir, feature_a: fa, bucket_a: ba, feature_b: fb, bucket_b: bb,
          n: s.n, w: s.w, l: s.l, t: s.t, wr: s.wr,
        });
      }
    }
  }
}

for (const dir of ['bounce', 'break']) {
  pairResults[dir].sort((a, b) => b.wr - a.wr || b.n - a.n);
}

for (const dir of ['bounce', 'break']) {
  console.log(`--- ${dir} direction — top ${TOP_N} pair filters ---`);
  console.log(`feat_a                          bucket    feat_b                          bucket    n     W    L   TO    WR`);
  for (const r of pairResults[dir].slice(0, TOP_N)) {
    console.log(`  ${r.feature_a.padEnd(30)} ${r.bucket_a.padEnd(10)} ${r.feature_b.padEnd(30)} ${r.bucket_b.padEnd(10)} ${String(r.n).padStart(4)} ${String(r.w).padStart(4)} ${String(r.l).padStart(4)} ${String(r.t).padStart(4)}  ${(r.wr * 100).toFixed(1)}%`);
  }
  console.log();
}

// ----- Save full results -----
const outPath = IN_PATH.replace(/\.json$/, `.analysis-t${TARGET}-s${STOP}-h${HOLD_MIN}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  config: { TARGET, STOP, HOLD_MIN, MIN_WR, MIN_N },
  baseline: { bounce: bounceSum, break: breakSum, both, bounceOnly, breakOnly },
  single_filters: results,
  pair_filters: pairResults,
  feature_buckets: featureBuckets,
}, null, 2));
console.log(`Written: ${outPath}`);
