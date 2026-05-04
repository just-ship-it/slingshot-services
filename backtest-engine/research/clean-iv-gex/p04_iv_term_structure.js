/**
 * p04 — IV term structure → forward NQ direction.
 *
 * Hypothesis: when 0-DTE IV >> 7-DTE IV (steep backwardation), event risk is
 * concentrated in the immediate term — NQ tends to make a directional move
 * within the hour.  When 0-DTE IV << 7-DTE IV (contango), the front is calm
 * relative to the back — slow drift.
 *
 * Predictor: term_ratio = dte0_avg_iv / atm_iv_7dte
 *  > 1 = front-loaded vol expectation (backwardation)
 *  < 1 = back-loaded
 *
 * Response: fwd_ret_60m  AND  abs_fwd_ret_60m (vol expectation)
 *
 * Data: dte0 from short_dte_iv_15m.csv (15-min cadence — same as GEX boundaries)
 *       7-DTE from atm_iv_1m.csv (lookup at the snapshot minute)
 */

import { buildAlignedSample, loadAtmIv1m, loadShortDteIv15m, spearman, decileAnalysis, trainTestSplit, appendMasterCsv, promotionGate } from './_lib.js';

async function main() {
  console.log('[p04] IV term structure → fwd_ret_60m and abs_fwd_ret_60m');
  const atm = await loadAtmIv1m();
  const sdiv = await loadShortDteIv15m();
  const { samples } = await buildAlignedSample();

  for (const s of samples) {
    const iso = s.iso; // 'YYYY-MM-DDTHH:MM'
    const front = sdiv.get(iso);
    const back = atm.get(iso);
    if (!front || !back) { s.term_ratio = null; continue; }
    const dte0 = front.dte0_avg_iv, dte7 = back.iv;
    if (!Number.isFinite(dte0) || !Number.isFinite(dte7) || dte7 <= 0) { s.term_ratio = null; continue; }
    s.term_ratio = dte0 / dte7;
  }

  const valid = samples.filter(s => s.term_ratio != null && s.term_ratio > 0.1 && s.term_ratio < 5 && Number.isFinite(s.fwd_ret_60m));
  console.log(`[p04] valid: ${valid.length}`);

  const xs = valid.map(s => s.term_ratio);
  const spot = 22000;

  // Primary: directional fwd_ret_60m
  const ys1 = valid.map(s => s.fwd_ret_60m);
  const sp1 = spearman(xs, ys1);
  const dec1 = decileAnalysis(xs, ys1);
  console.log(`[p04] vs fwd_ret_60m:  n=${sp1.n}  r=${sp1.r.toFixed(3)}  p=${sp1.p?.toExponential(2)}`);
  for (const d of dec1.deciles) {
    console.log(`           decile ${d.d}: x ∈ [${d.x_lo.toFixed(2)},${d.x_hi.toFixed(2)}]  ret=${(d.mean*spot).toFixed(2)}pts  hit=${(d.hit_rate*100).toFixed(1)}%  n=${d.n}`);
  }
  const { train, test } = trainTestSplit(valid);
  const dec1_train = decileAnalysis(train.map(s => s.term_ratio), train.map(s => s.fwd_ret_60m));
  const dec1_test = decileAnalysis(test.map(s => s.term_ratio), test.map(s => s.fwd_ret_60m));
  const eff1 = (dec1.top - dec1.bottom) * spot;
  const eff1_train = (dec1_train.top - dec1_train.bottom) * spot;
  const eff1_test = (dec1_test.top - dec1_test.bottom) * spot;
  console.log(`[p04] effectPts=${eff1.toFixed(2)}  train=${eff1_train.toFixed(2)}  test=${eff1_test.toFixed(2)}`);

  const gate1 = promotionGate({ n: sp1.n, r: sp1.r, effectPts: eff1, trainEffect: eff1_train, testEffect: eff1_test });
  appendMasterCsv({
    predictor_id: 'p04_iv_term_ratio',
    predictor_description: 'dte0_avg_iv / 7dte_atm_iv',
    response: 'fwd_ret_60m',
    n: sp1.n, spearman_r: sp1.r, p_value: sp1.p,
    top_decile_effect: dec1.top, bottom_decile_effect: dec1.bottom, decile_diff: dec1.diff,
    hit_rate_top: dec1.hitRateTop, hit_rate_bot: dec1.hitRateBot,
    train_diff: dec1_train.diff, test_diff: dec1_test.diff,
    promotable: gate1.promotable,
    notes: gate1.failedBars.join('; ') + ` | effectPts=${eff1.toFixed(2)}`,
  });

  // Secondary: |fwd_ret_60m| (vol expectation — does steeper backwardation predict bigger moves?)
  const ys2 = valid.map(s => Math.abs(s.fwd_ret_60m));
  const sp2 = spearman(xs, ys2);
  const dec2 = decileAnalysis(xs, ys2);
  console.log(`[p04] vs abs_fwd_ret_60m:  n=${sp2.n}  r=${sp2.r.toFixed(3)}  p=${sp2.p?.toExponential(2)}`);
  for (const d of dec2.deciles) {
    console.log(`           decile ${d.d}: x ∈ [${d.x_lo.toFixed(2)},${d.x_hi.toFixed(2)}]  |ret|=${(d.mean*spot).toFixed(2)}pts  n=${d.n}`);
  }
  const dec2_train = decileAnalysis(train.map(s => s.term_ratio), train.map(s => Math.abs(s.fwd_ret_60m)));
  const dec2_test = decileAnalysis(test.map(s => s.term_ratio), test.map(s => Math.abs(s.fwd_ret_60m)));
  const eff2 = (dec2.top - dec2.bottom) * spot;
  const eff2_train = (dec2_train.top - dec2_train.bottom) * spot;
  const eff2_test = (dec2_test.top - dec2_test.bottom) * spot;
  console.log(`[p04] effectPts=${eff2.toFixed(2)}  train=${eff2_train.toFixed(2)}  test=${eff2_test.toFixed(2)}`);

  const gate2 = promotionGate({ n: sp2.n, r: sp2.r, effectPts: eff2, trainEffect: eff2_train, testEffect: eff2_test });
  appendMasterCsv({
    predictor_id: 'p04_iv_term_ratio',
    predictor_description: 'dte0_avg_iv / 7dte_atm_iv',
    response: 'abs_fwd_ret_60m',
    n: sp2.n, spearman_r: sp2.r, p_value: sp2.p,
    top_decile_effect: dec2.top, bottom_decile_effect: dec2.bottom, decile_diff: dec2.diff,
    hit_rate_top: dec2.hitRateTop, hit_rate_bot: dec2.hitRateBot,
    train_diff: dec2_train.diff, test_diff: dec2_test.diff,
    promotable: gate2.promotable,
    notes: gate2.failedBars.join('; ') + ` | effectPts=${eff2.toFixed(2)}`,
  });
}

main().catch(e => { console.error(e); process.exit(1); });
