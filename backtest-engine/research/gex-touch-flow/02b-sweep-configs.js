/**
 * GEX-Touch Flow — Phase 2b: sweep (target, stop, hold) configurations to find
 * the strongest edges.
 *
 * For each config, computes:
 *   - Baseline WR (bounce, break)
 *   - Top single-feature filter (WR + sample size)
 *   - Top 2-feature pair filter (WR + sample size)
 *
 * Surfaces the most promising (config × filter) combinations.
 *
 * Usage:
 *   node research/gex-touch-flow/02b-sweep-configs.js --in <path>
 */
import fs from 'fs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const IN_PATH = arg('in', null);
if (!IN_PATH) { console.error('--in required'); process.exit(1); }
const MIN_N = Number(arg('min-n', 50));
const TOP_K = Number(arg('top-k', 5));

const data = JSON.parse(fs.readFileSync(IN_PATH, 'utf-8'));
const touches = data.touches;
console.log(`Loaded ${touches.length.toLocaleString()} touches\n`);

function flatten(t) {
  return { ...t.features, ...t.s1 };
}

function labelOutcome(walk, target, stop, holdMin) {
  if (!walk) return 'no_data';
  const tTarget = walk.time_to_target_sec?.[target];
  const tStop = walk.time_to_stop_sec?.[stop];
  const holdSec = holdMin * 60;
  const tHitTarget = tTarget != null && tTarget <= holdSec ? tTarget : null;
  const tHitStop = tStop != null && tStop <= holdSec ? tStop : null;
  if (tHitTarget != null && (tHitStop == null || tHitTarget < tHitStop)) return 'win';
  if (tHitStop != null) return 'loss';
  return 'timeout';
}

function summarize(outcomes) {
  const n = outcomes.length;
  const w = outcomes.filter(o => o === 'win').length;
  const l = outcomes.filter(o => o === 'loss').length;
  const t = outcomes.filter(o => o === 'timeout').length;
  return { n, w, l, t, wr: n > 0 ? w / n : 0 };
}

function getFeatureBuckets(name, values) {
  const nonNull = values.filter(v => v != null && !isNaN(v));
  if (nonNull.length === 0) return null;
  const uniq = [...new Set(nonNull)];
  if (uniq.length <= 8) {
    return { type: 'categorical', values: uniq.sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)))) };
  }
  if (typeof nonNull[0] === 'boolean') {
    return { type: 'categorical', values: [false, true] };
  }
  const sorted = [...nonNull].sort((a, b) => a - b);
  const deciles = [];
  for (let i = 1; i <= 9; i++) deciles.push(sorted[Math.floor(sorted.length * i / 10)]);
  return { type: 'numeric', deciles };
}
function bucketValue(v, buckets) {
  if (v == null || (typeof v === 'number' && isNaN(v))) return 'NULL';
  if (buckets.type === 'categorical') return String(v);
  for (let i = 0; i < buckets.deciles.length; i++) {
    if (v <= buckets.deciles[i]) return `d${i}`;
  }
  return `d${buckets.deciles.length}`;
}

const flatTouches = touches.map(t => flatten(t));
const featureNames = Object.keys(flatTouches[0]);
const featureBuckets = {};
for (const fname of featureNames) {
  const vals = flatTouches.map(f => f[fname]);
  featureBuckets[fname] = getFeatureBuckets(fname, vals);
}

const HIGH_VALUE_FEATURES = featureNames.filter(f =>
  /^vol_|s1_|approach_|touch_|regime|gamma_|level_type|tod_bucket|level_gex_rank|dist_next|tests_today|atr_/.test(f)
);

// Configs to try: (target, stop, hold)
const CONFIGS = [
  // tight stops, scalp targets
  [10, 5, 5], [10, 5, 10], [10, 5, 15],
  [12, 5, 5], [12, 5, 10], [12, 5, 15],
  [15, 5, 5], [15, 5, 10], [15, 5, 15],
  // 8pt stops
  [12, 8, 10], [12, 8, 15], [15, 8, 10], [15, 8, 15], [15, 8, 30],
  [18, 8, 15], [18, 8, 30], [20, 8, 15], [20, 8, 30],
  // 10pt stops
  [15, 10, 15], [15, 10, 30], [18, 10, 15], [18, 10, 30],
  [20, 10, 15], [20, 10, 30], [22, 10, 30], [25, 10, 30],
  // 12-15pt stops
  [15, 12, 15], [20, 12, 30], [25, 12, 30], [25, 15, 30],
];

console.log(`Sweeping ${CONFIGS.length} configs × 2 directions × ${HIGH_VALUE_FEATURES.length} features\n`);
console.log(`Header: target stop hold   baselineWR_b/k   topSingle_b   topSingle_k   topPair_b   topPair_k`);

const rows = [];
for (const [tgt, stp, hld] of CONFIGS) {
  const bOutcomes = touches.map(t => labelOutcome(t.bounce, tgt, stp, hld));
  const kOutcomes = touches.map(t => labelOutcome(t.brk, tgt, stp, hld));
  const bSum = summarize(bOutcomes), kSum = summarize(kOutcomes);

  // Top single-feature filter for each direction
  function topSingle(outcomes) {
    let best = { wr: 0, n: 0, feature: null, bucket: null };
    for (const fname of featureNames) {
      const buckets = featureBuckets[fname];
      if (!buckets) continue;
      const groups = new Map();
      for (let i = 0; i < touches.length; i++) {
        const v = flatTouches[i][fname];
        const b = bucketValue(v, buckets);
        if (!groups.has(b)) groups.set(b, []);
        groups.get(b).push(outcomes[i]);
      }
      for (const [b, outs] of groups.entries()) {
        const s = summarize(outs);
        if (s.n < MIN_N) continue;
        if (s.wr > best.wr) best = { wr: s.wr, n: s.n, w: s.w, l: s.l, t: s.t, feature: fname, bucket: b };
      }
    }
    return best;
  }

  function topPair(outcomes) {
    let best = { wr: 0, n: 0, feature_a: null, bucket_a: null, feature_b: null, bucket_b: null };
    for (let i = 0; i < HIGH_VALUE_FEATURES.length; i++) {
      const fa = HIGH_VALUE_FEATURES[i];
      const aBuckets = featureBuckets[fa];
      if (!aBuckets) continue;
      for (let j = i + 1; j < HIGH_VALUE_FEATURES.length; j++) {
        const fb = HIGH_VALUE_FEATURES[j];
        const bBuckets = featureBuckets[fb];
        if (!bBuckets) continue;
        const groups = new Map();
        for (let k = 0; k < touches.length; k++) {
          const fv = flatTouches[k];
          const ba = bucketValue(fv[fa], aBuckets);
          const bb = bucketValue(fv[fb], bBuckets);
          const key = `${ba}|${bb}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(outcomes[k]);
        }
        for (const [key, outs] of groups.entries()) {
          const s = summarize(outs);
          if (s.n < MIN_N) continue;
          if (s.wr > best.wr) {
            const [ba, bb] = key.split('|');
            best = { wr: s.wr, n: s.n, w: s.w, l: s.l, t: s.t, feature_a: fa, bucket_a: ba, feature_b: fb, bucket_b: bb };
          }
        }
      }
    }
    return best;
  }

  const tSingleB = topSingle(bOutcomes);
  const tSingleK = topSingle(kOutcomes);
  const tPairB = topPair(bOutcomes);
  const tPairK = topPair(kOutcomes);

  console.log(`t=${String(tgt).padStart(2)} s=${String(stp).padStart(2)} h=${String(hld).padStart(2)}min   `
    + `b/k WR=${(bSum.wr*100).toFixed(1)}/${(kSum.wr*100).toFixed(1)}%   `
    + `b: ${tSingleB.feature}=${tSingleB.bucket} WR=${(tSingleB.wr*100).toFixed(1)}% n=${tSingleB.n}   `
    + `k: ${tSingleK.feature}=${tSingleK.bucket} WR=${(tSingleK.wr*100).toFixed(1)}% n=${tSingleK.n}`);
  console.log(`         pair b: ${tPairB.feature_a}=${tPairB.bucket_a} & ${tPairB.feature_b}=${tPairB.bucket_b}  WR=${(tPairB.wr*100).toFixed(1)}% n=${tPairB.n}`);
  console.log(`         pair k: ${tPairK.feature_a}=${tPairK.bucket_a} & ${tPairK.feature_b}=${tPairK.bucket_b}  WR=${(tPairK.wr*100).toFixed(1)}% n=${tPairK.n}`);

  rows.push({
    target: tgt, stop: stp, hold: hld,
    bounce: { baseline: bSum, top_single: tSingleB, top_pair: tPairB },
    break: { baseline: kSum, top_single: tSingleK, top_pair: tPairK },
  });
}

const outPath = IN_PATH.replace(/\.json$/, `.sweep-configs.json`);
fs.writeFileSync(outPath, JSON.stringify({ configs: CONFIGS, rows }, null, 2));
console.log(`\nWritten: ${outPath}`);

// Surface the top WR pair filters across all configs
console.log(`\n=== Top 10 (config × pair) by WR (min_n=${MIN_N}) ===`);
const all = [];
for (const r of rows) {
  if (r.bounce.top_pair.feature_a) all.push({ ...r.bounce.top_pair, dir: 'bounce', t: r.target, s: r.stop, h: r.hold });
  if (r.break.top_pair.feature_a) all.push({ ...r.break.top_pair, dir: 'break', t: r.target, s: r.stop, h: r.hold });
}
all.sort((a, b) => b.wr - a.wr);
for (const r of all.slice(0, 10)) {
  console.log(`  T${r.t}/S${r.s}/H${r.h}min ${r.dir}: ${r.feature_a}=${r.bucket_a} & ${r.feature_b}=${r.bucket_b} → WR ${(r.wr*100).toFixed(1)}% (n=${r.n}, W=${r.w}/L=${r.l}/TO=${r.t})`);
}
