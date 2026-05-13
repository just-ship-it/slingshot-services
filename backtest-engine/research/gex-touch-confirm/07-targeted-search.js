/**
 * Phase 7: Targeted filter search on the 1s-honest dataset.
 *
 * Phase 4's auto-generated triples have noise (e.g., "vwap_p80 AND vwap_p70"
 * which is redundant). This script runs a manually-curated set of HONEST
 * filter combinations across all stop tiers, ranks by Sharpe-per-trade
 * (penalizes tiny samples), and prints the Pareto frontier.
 *
 * Usage:
 *   node research/gex-touch-confirm/07-targeted-search.js \
 *     --in research/output/gex-touch-confirm-v3-base-<TS>.enriched.json
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
const MIN_N = Number(arg('min-n', 50));

const payload = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const { touches } = payload;
console.log(`\n=== Phase 7: Targeted filter search ===`);
console.log(`Input: ${inPath}`);
console.log(`Touches: ${touches.length.toLocaleString()}\n`);

const TARGET = 20;
const STOPS = [8, 10, 12, 15, 20];

function metrics(arr, stopPts) {
  let wins = 0, losses = 0, timeouts = 0, eod = 0, no_fill = 0, rollover = 0;
  for (const r of arr) {
    if (r.outcome === 'win') wins++;
    else if (r.outcome === 'loss') losses++;
    else if (r.outcome === 'timeout') timeouts++;
    else if (r.outcome === 'eod') eod++;
    else if (r.outcome === 'no_fill') no_fill++;
    else if (r.outcome === 'rollover' || r.outcome === 'rollover_pre_fill') rollover++;
  }
  const n_filled = wins + losses + timeouts + eod + rollover;
  const decided = wins + losses;
  const wr = decided > 0 ? wins / decided : null;
  const pf = losses * stopPts > 0 ? (wins * TARGET) / (losses * stopPts) : (wins > 0 ? Infinity : 0);
  const total_pts = wins * TARGET - losses * stopPts;
  const ev = n_filled > 0 ? total_pts / n_filled : 0;
  // Per-trade variance for Sharpe approx
  let var_sum = 0;
  if (n_filled > 0) {
    const pts_winning = TARGET, pts_losing = -stopPts;
    for (let i = 0; i < wins; i++) var_sum += (pts_winning - ev) ** 2;
    for (let i = 0; i < losses; i++) var_sum += (pts_losing - ev) ** 2;
    for (let i = 0; i < timeouts + eod + rollover; i++) var_sum += (0 - ev) ** 2;
  }
  const stdev = n_filled > 0 ? Math.sqrt(var_sum / n_filled) : 0;
  const sharpe = stdev > 0 ? ev / stdev : 0;
  return { n_filled, decided, wins, losses, wr, pf, total_pts, ev, sharpe };
}

// Flatten outcomes
function flatten(touches, stop) {
  const out = [];
  for (const t of touches) {
    for (const o of t.outcomes) {
      for (const s of o.stops) {
        if (s.stop !== stop) continue;
        out.push({
          outcome: s.outcome,
          features: t.features || {},
          level_type: t.level_type, approach: t.approach, regime: t.regime,
          tod: t.tod, min_dist_1m: t.min_dist_1m,
        });
      }
    }
  }
  return out;
}

function pctile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// Compute percentile cutpoints once
function getCuts() {
  const v = (name) => {
    const arr = [];
    for (const t of touches) {
      const x = t.features?.[name];
      if (x != null && !isNaN(x)) arr.push(x);
    }
    return arr;
  };
  const minDist1m = touches.map(t => t.min_dist_1m).filter(x => x != null);
  return {
    iv_skew_p10: pctile(v('qqq_iv_skew'), 0.10),
    iv_skew_p20: pctile(v('qqq_iv_skew'), 0.20),
    iv_skew_p30: pctile(v('qqq_iv_skew'), 0.30),
    iv_skew_p70: pctile(v('qqq_iv_skew'), 0.70),
    iv_skew_p90: pctile(v('qqq_iv_skew'), 0.90),
    iv_level_p10: pctile(v('qqq_iv_level'), 0.10),
    iv_level_p20: pctile(v('qqq_iv_level'), 0.20),
    iv_level_p80: pctile(v('qqq_iv_level'), 0.80),
    iv_level_p90: pctile(v('qqq_iv_level'), 0.90),
    atr_p20: pctile(v('atr14'), 0.20),
    atr_p10: pctile(v('atr14'), 0.10),
    atr_p80: pctile(v('atr14'), 0.80),
    atr_p90: pctile(v('atr14'), 0.90),
    vwap_p70: pctile(v('s1_vwap_close_diff'), 0.70),
    vwap_p80: pctile(v('s1_vwap_close_diff'), 0.80),
    vwap_p90: pctile(v('s1_vwap_close_diff'), 0.90),
    minDist_p50: pctile(minDist1m, 0.50),
    minDist_p60: pctile(minDist1m, 0.60),
    minDist_p70: pctile(minDist1m, 0.70),
    minDist_p80: pctile(minDist1m, 0.80),
    minDist_p90: pctile(minDist1m, 0.90),
    rejWick_p70: pctile(v('touch_rej_wick_pts'), 0.70),
    rejWick_p80: pctile(v('touch_rej_wick_pts'), 0.80),
    rejWick_p90: pctile(v('touch_rej_wick_pts'), 0.90),
    bodyRatio_p10: pctile(v('touch_body_range_ratio'), 0.10),
    bodyRatio_p20: pctile(v('touch_body_range_ratio'), 0.20),
    bodyRatio_p30: pctile(v('touch_body_range_ratio'), 0.30),
    range_p10: pctile(v('touch_range_pts'), 0.10),
    range_p20: pctile(v('touch_range_pts'), 0.20),
    body_p10: pctile(v('touch_body_pts'), 0.10),
    body_p20: pctile(v('touch_body_pts'), 0.20),
    vol5_p20: pctile(v('vol_ratio_5m'), 0.20),
    vol5_p80: pctile(v('vol_ratio_5m'), 0.80),
    compression_p20: pctile(v('prior_3bar_range_compression'), 0.20),
    compression_p10: pctile(v('prior_3bar_range_compression'), 0.10),
  };
}
const C = getCuts();
console.log('Percentile cuts:', Object.fromEntries(Object.entries(C).map(([k, v]) => [k, v?.toFixed(3)])));

// Manually curated, honest filter combinations.
const F = {
  // Pin bar / small body / doji — touch quality signals
  pinbar: (r) => r.features?.touch_pinbar === 1,
  doji: (r) => r.features?.touch_doji === 1,
  smallBody: (r) => r.features?.touch_body_range_ratio < C.bodyRatio_p20,
  tinyBody: (r) => r.features?.touch_body_range_ratio < C.bodyRatio_p10,
  smallRange: (r) => r.features?.touch_range_pts < C.range_p20,
  bigRejWick: (r) => r.features?.touch_rej_wick_pts >= C.rejWick_p90,

  // IV / regime
  lowIvSkew: (r) => r.features?.qqq_iv_skew < C.iv_skew_p10,
  lowIvSkew20: (r) => r.features?.qqq_iv_skew < C.iv_skew_p20,
  highIvSkew: (r) => r.features?.qqq_iv_skew > C.iv_skew_p90,
  lowIv: (r) => r.features?.qqq_iv_level < C.iv_level_p20,
  highIv: (r) => r.features?.qqq_iv_level > C.iv_level_p80,
  positiveRegime: (r) => r.regime === 'positive' || r.regime === 'strong_positive',
  negativeRegime: (r) => r.regime === 'negative' || r.regime === 'strong_negative',
  strongPos: (r) => r.regime === 'strong_positive',
  strongNeg: (r) => r.regime === 'strong_negative',

  // 1s VWAP rejection
  s1Strong: (r) => r.features?.s1_vwap_close_diff != null
    && (r.approach === 'from_above' ? r.features.s1_vwap_close_diff : -r.features.s1_vwap_close_diff) >= C.vwap_p70,
  s1Veryrong: (r) => r.features?.s1_vwap_close_diff != null
    && (r.approach === 'from_above' ? r.features.s1_vwap_close_diff : -r.features.s1_vwap_close_diff) >= C.vwap_p80,
  s1Extreme: (r) => r.features?.s1_vwap_close_diff != null
    && (r.approach === 'from_above' ? r.features.s1_vwap_close_diff : -r.features.s1_vwap_close_diff) >= C.vwap_p90,

  // min_dist (1m-based or 1s)
  edgeTouch1m: (r) => r.min_dist_1m >= C.minDist_p70,
  edgeTouch1m80: (r) => r.min_dist_1m >= C.minDist_p80,

  // Volume
  lowVol: (r) => r.features?.vol_ratio_5m < C.vol5_p20,
  highVol: (r) => r.features?.vol_ratio_5m > C.vol5_p80,

  // Compression
  compressed: (r) => r.features?.prior_3bar_range_compression < C.compression_p20,

  // Level type buckets
  isGammaFlip: (r) => r.level_type === 'gamma_flip',
  isWall: (r) => r.level_type === 'call_wall' || r.level_type === 'put_wall',
  isS1: (r) => r.level_type === 'S1',
  isSlow: (r) => /^S[3-5]$/.test(r.level_type),
  isSmid: (r) => /^S[1-3]$/.test(r.level_type),
  isS: (r) => /^S[1-5]$/.test(r.level_type),
  isR: (r) => /^R[1-5]$/.test(r.level_type),

  // TOD
  morning: (r) => r.tod === 'morning',
  afternoon: (r) => r.tod === 'afternoon',
  open30: (r) => r.tod === 'open_30',
  lunch: (r) => r.tod === 'lunch',

  // Approach
  fromAbove: (r) => r.approach === 'from_above',
  fromBelow: (r) => r.approach === 'from_below',
};

// Combinations to try
const combos = [
  // Singles (sanity check)
  ['pinbar', ['pinbar']],
  ['lowIvSkew', ['lowIvSkew']],
  ['lowIv', ['lowIv']],
  ['positiveRegime', ['positiveRegime']],
  ['negativeRegime', ['negativeRegime']],
  ['strongPos', ['strongPos']],
  ['isGammaFlip', ['isGammaFlip']],
  ['edgeTouch1m', ['edgeTouch1m']],
  ['smallBody', ['smallBody']],
  ['s1Strong', ['s1Strong']],
  ['compressed', ['compressed']],

  // Pairs
  ['pinbar+positive', ['pinbar', 'positiveRegime']],
  ['pinbar+lowSkew', ['pinbar', 'lowIvSkew']],
  ['pinbar+lowIv', ['pinbar', 'lowIv']],
  ['smallBody+lowSkew', ['smallBody', 'lowIvSkew']],
  ['smallBody+positive', ['smallBody', 'positiveRegime']],
  ['lowSkew+positive', ['lowIvSkew', 'positiveRegime']],
  ['lowSkew+gammaFlip', ['lowIvSkew', 'isGammaFlip']],
  ['pinbar+gammaFlip', ['pinbar', 'isGammaFlip']],
  ['edge+lowSkew', ['edgeTouch1m', 'lowIvSkew']],
  ['edge+positive', ['edgeTouch1m', 'positiveRegime']],
  ['edge+pinbar', ['edgeTouch1m', 'pinbar']],
  ['edge+gammaFlip', ['edgeTouch1m', 'isGammaFlip']],
  ['compressed+positive', ['compressed', 'positiveRegime']],
  ['compressed+lowSkew', ['compressed', 'lowIvSkew']],
  ['pinbar+S', ['pinbar', 'isS']],
  ['pinbar+R', ['pinbar', 'isR']],
  ['smallBody+gammaFlip', ['smallBody', 'isGammaFlip']],
  ['lowSkew+strongPos', ['lowIvSkew', 'strongPos']],
  ['lowSkew+afternoon', ['lowIvSkew', 'afternoon']],

  // Triples
  ['pinbar+lowSkew+positive', ['pinbar', 'lowIvSkew', 'positiveRegime']],
  ['smallBody+lowSkew+positive', ['smallBody', 'lowIvSkew', 'positiveRegime']],
  ['pinbar+lowSkew+gammaFlip', ['pinbar', 'lowIvSkew', 'isGammaFlip']],
  ['edge+lowSkew+positive', ['edgeTouch1m', 'lowIvSkew', 'positiveRegime']],
  ['edge+pinbar+positive', ['edgeTouch1m', 'pinbar', 'positiveRegime']],
  ['edge+pinbar+lowSkew', ['edgeTouch1m', 'pinbar', 'lowIvSkew']],
  ['pinbar+smallBody+lowSkew', ['pinbar', 'smallBody', 'lowIvSkew']],
  ['s1Strong+pinbar+positive', ['s1Strong', 'pinbar', 'positiveRegime']],
  ['s1Strong+lowSkew+positive', ['s1Strong', 'lowIvSkew', 'positiveRegime']],
  ['compressed+lowSkew+positive', ['compressed', 'lowIvSkew', 'positiveRegime']],
  ['s1Very+pinbar+positive', ['s1Veryrong', 'pinbar', 'positiveRegime']],
  ['edge+lowSkew+gammaFlip', ['edgeTouch1m', 'lowIvSkew', 'isGammaFlip']],
  ['pinbar+lowSkew+S', ['pinbar', 'lowIvSkew', 'isS']],
  ['pinbar+lowSkew+afternoon', ['pinbar', 'lowIvSkew', 'afternoon']],
  ['smallBody+lowSkew+isGammaFlip', ['smallBody', 'lowIvSkew', 'isGammaFlip']],
];

console.log('\n=== Ranked composite filters across stops ===');
console.log('config'.padEnd(36), 'stop'.padStart(5), 'n'.padStart(5), 'WR'.padStart(7),
  'PF'.padStart(6), 'EV'.padStart(7), 'Sharpe'.padStart(7), 'pts'.padStart(8));

const results = [];
for (const [name, predNames] of combos) {
  const preds = predNames.map(n => F[n]);
  const pred = r => preds.every(p => p(r));
  for (const stop of STOPS) {
    const filt = flatten(touches, stop).filter(pred);
    const m = metrics(filt, stop);
    if (m.n_filled < MIN_N) continue;
    results.push({ name, stop, ...m, predNames });
  }
}

// Sort by Sharpe descending, then by total_pts
results.sort((a, b) => {
  if (b.sharpe !== a.sharpe) return b.sharpe - a.sharpe;
  return b.total_pts - a.total_pts;
});

for (const r of results.slice(0, 50)) {
  console.log(
    r.name.padEnd(36),
    String(r.stop).padStart(5),
    String(r.n_filled).padStart(5),
    (r.wr != null ? (r.wr * 100).toFixed(1) + '%' : '-').padStart(7),
    (r.pf != null && isFinite(r.pf) ? r.pf.toFixed(2) : '-').padStart(6),
    r.ev.toFixed(2).padStart(7),
    r.sharpe.toFixed(3).padStart(7),
    String(Math.round(r.total_pts)).padStart(8),
  );
}

// Write JSON
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(ROOT, 'research', 'output', `gex-touch-confirm-targeted-${ts}.json`);
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\nWritten: ${outPath}`);
