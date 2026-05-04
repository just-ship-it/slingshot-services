/**
 * p01 — total_gex Z-score (rolling 30 trading days) → forward realized vol.
 *
 * Hypothesis: when total GEX magnitude is in the bottom decile of its recent
 * distribution (i.e., dealers are NOT positioned with much stabilizing gamma),
 * forward 30-min realized volatility is higher.  The reverse for top decile.
 *
 * Predictor:  total_gex_z = (total_gex - μ_30d) / σ_30d
 * Response:   fwd_realized_vol_30m  (continuous, log-return stdev)
 *             also: |fwd_ret_15m|   (alternative response)
 *
 * No leakage check needed beyond the +1m lag in buildAlignedSample.
 */

import { buildAlignedSample, spearman, decileAnalysis, trainTestSplit, appendMasterCsv, promotionGate } from './_lib.js';

const ROLLING_DAYS = 30;
const MS_PER_DAY = 86_400_000;

async function main() {
  console.log('[p01] total_gex Z-score → forward realized vol');
  const { samples } = await buildAlignedSample();
  console.log(`[p01] aligned samples: ${samples.length}`);

  // Compute rolling Z-score using a per-snapshot window of 30 trading days.
  // We use the prior 30 calendar days of snapshots (look-back only — no leakage).
  for (let i = 0; i < samples.length; i++) {
    const cutoff = samples[i].ts - ROLLING_DAYS * MS_PER_DAY;
    let n = 0, s = 0, s2 = 0;
    for (let j = i - 1; j >= 0 && samples[j].ts >= cutoff; j--) {
      const v = samples[j].snapshot.total_gex;
      n++; s += v; s2 += v * v;
    }
    if (n < 100) { samples[i].total_gex_z = null; continue; }
    const mean = s / n;
    const variance = Math.max(s2 / n - mean * mean, 0);
    const sd = Math.sqrt(variance);
    samples[i].total_gex_z = sd > 0 ? (samples[i].snapshot.total_gex - mean) / sd : 0;
  }

  // Drop early samples without enough history
  const valid = samples.filter(s => s.total_gex_z != null && s.fwd_realized_vol_30m != null);
  console.log(`[p01] valid (with rolling window + realized vol): ${valid.length}`);

  // Primary response: forward realized vol over 30 min (log-return stdev)
  const xs = valid.map(s => s.total_gex_z);
  const ys = valid.map(s => s.fwd_realized_vol_30m);

  const { r, p, n } = spearman(xs, ys);
  const dec = decileAnalysis(xs, ys);
  console.log(`[p01] vs realized_vol_30m:  n=${n}  r=${r.toFixed(3)}  p=${p?.toExponential(2)}`);
  console.log(`[p01]   bottom decile mean vol = ${dec.bottom?.toFixed(5)}`);
  console.log(`[p01]   top    decile mean vol = ${dec.top?.toFixed(5)}`);
  console.log(`[p01]   diff = ${dec.diff?.toFixed(5)}`);
  for (const d of dec.deciles) {
    console.log(`           decile ${d.d}: x ∈ [${d.x_lo.toFixed(2)},${d.x_hi.toFixed(2)}]  vol=${d.mean.toFixed(5)}  n=${d.n}`);
  }

  // Train/test stability — chronological 70/30
  const { train, test } = trainTestSplit(valid);
  const decTrain = decileAnalysis(train.map(s => s.total_gex_z), train.map(s => s.fwd_realized_vol_30m));
  const decTest = decileAnalysis(test.map(s => s.total_gex_z), test.map(s => s.fwd_realized_vol_30m));
  console.log(`[p01] train n=${train.length} diff=${decTrain.diff?.toFixed(5)}`);
  console.log(`[p01] test  n=${test.length} diff=${decTest.diff?.toFixed(5)}`);

  // Effect in NQ-pt-equivalent: realized vol is a 1-min log return stdev.  Convert
  // the decile diff to NQ pts assumed avg spot 22000:
  // a stdev diff of Δ in log-return-per-minute over 30 min ≈ Δ * sqrt(30) * spot
  const spot = 22000;
  const effectPts = (dec.top - dec.bottom) * Math.sqrt(30) * spot;
  const trainEffectPts = (decTrain.top - decTrain.bottom) * Math.sqrt(30) * spot;
  const testEffectPts = (decTest.top - decTest.bottom) * Math.sqrt(30) * spot;
  console.log(`[p01] effect in pts (30m vol diff): ${effectPts.toFixed(2)}  train=${trainEffectPts.toFixed(2)}  test=${testEffectPts.toFixed(2)}`);

  const gate = promotionGate({
    n,
    r,
    effectPts,
    trainEffect: trainEffectPts,
    testEffect: testEffectPts,
  });
  console.log(`[p01] promotable = ${gate.promotable}.  Failed bars: ${gate.failedBars.join('; ')}`);

  appendMasterCsv({
    predictor_id: 'p01_total_gex_zscore',
    predictor_description: `total_gex Z-score over rolling ${ROLLING_DAYS}d`,
    response: 'fwd_realized_vol_30m',
    n,
    spearman_r: r,
    p_value: p,
    top_decile_effect: dec.top,
    bottom_decile_effect: dec.bottom,
    decile_diff: dec.diff,
    hit_rate_top: dec.hitRateTop,
    hit_rate_bot: dec.hitRateBot,
    train_diff: decTrain.diff,
    test_diff: decTest.diff,
    promotable: gate.promotable,
    notes: gate.failedBars.join('; ') + ` | effectPts(30m_vol)=${effectPts.toFixed(2)}`,
  });

  // Secondary response: |fwd_ret_15m|
  const ys2 = valid.map(s => Math.abs(s.fwd_ret_15m));
  const sp2 = spearman(xs, ys2);
  const dec2 = decileAnalysis(xs, ys2);
  const dec2_train = decileAnalysis(train.map(s => s.total_gex_z), train.map(s => Math.abs(s.fwd_ret_15m)));
  const dec2_test = decileAnalysis(test.map(s => s.total_gex_z), test.map(s => Math.abs(s.fwd_ret_15m)));
  const effectPts2 = (dec2.top - dec2.bottom) * spot;
  console.log(`[p01] secondary |fwd_ret_15m|:  n=${sp2.n}  r=${sp2.r.toFixed(3)}  effectPts=${effectPts2.toFixed(2)}`);

  const gate2 = promotionGate({
    n: sp2.n, r: sp2.r,
    effectPts: effectPts2,
    trainEffect: (dec2_train.top - dec2_train.bottom) * spot,
    testEffect: (dec2_test.top - dec2_test.bottom) * spot,
  });
  appendMasterCsv({
    predictor_id: 'p01_total_gex_zscore',
    predictor_description: `total_gex Z-score over rolling ${ROLLING_DAYS}d`,
    response: 'abs_fwd_ret_15m',
    n: sp2.n,
    spearman_r: sp2.r,
    p_value: sp2.p,
    top_decile_effect: dec2.top,
    bottom_decile_effect: dec2.bottom,
    decile_diff: dec2.diff,
    hit_rate_top: dec2.hitRateTop,
    hit_rate_bot: dec2.hitRateBot,
    train_diff: dec2_train.diff,
    test_diff: dec2_test.diff,
    promotable: gate2.promotable,
    notes: gate2.failedBars.join('; ') + ` | effectPts=${effectPts2.toFixed(2)}`,
  });

  return { samples: valid, dec, decTrain, decTest, gate, effectPts };
}

main().catch(e => { console.error(e); process.exit(1); });
