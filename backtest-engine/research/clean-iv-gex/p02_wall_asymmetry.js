/**
 * p02 — wall proximity asymmetry → forward NQ direction.
 *
 * Hypothesis: when call_wall is much closer to spot than put_wall,
 * dealer gamma absorbs upside → mean-reversion bias (negative forward ret).
 * Conversely when put_wall is much closer, mean-reversion to upside.
 *
 * Predictor:  wall_asym = ((call_wall - spot) - (spot - put_wall)) / atr20
 *           = (call_wall + put_wall - 2*spot) / atr20
 *   negative → call_wall is closer (resistance overhead near)
 *   positive → put_wall is closer (support nearby)
 *
 * Response:   fwd_ret_60m   (continuous, log return)
 *
 * Filter: drop samples with abs(asym) > 5 (extreme noise) and atr20 missing.
 */

import { buildAlignedSample, loadNqOhlcv1m, spearman, decileAnalysis, trainTestSplit, appendMasterCsv, promotionGate } from './_lib.js';

async function main() {
  console.log('[p02] wall asymmetry → fwd_ret_60m');
  const { atr20ByDate } = await loadNqOhlcv1m();
  const { samples } = await buildAlignedSample();

  for (const s of samples) {
    const atr = atr20ByDate.get(s.date);
    const cw = s.snapshot.call_wall, pw = s.snapshot.put_wall, spot = s.snapshot.nq_spot;
    if (atr == null || atr === 0 || !Number.isFinite(cw) || !Number.isFinite(pw) || !Number.isFinite(spot)) {
      s.wall_asym = null;
      continue;
    }
    s.wall_asym = ((cw - spot) - (spot - pw)) / atr;
  }

  // Filter to physically reasonable values — extreme outliers are noise
  const valid = samples.filter(s => s.wall_asym != null && Math.abs(s.wall_asym) < 10 && Number.isFinite(s.fwd_ret_60m));
  console.log(`[p02] valid: ${valid.length}`);

  const xs = valid.map(s => s.wall_asym);
  const ys = valid.map(s => s.fwd_ret_60m);

  const { r, p, n } = spearman(xs, ys);
  const dec = decileAnalysis(xs, ys);
  console.log(`[p02] vs fwd_ret_60m:  n=${n}  r=${r.toFixed(3)}  p=${p?.toExponential(2)}`);
  for (const d of dec.deciles) {
    console.log(`           decile ${d.d}: x ∈ [${d.x_lo.toFixed(2)},${d.x_hi.toFixed(2)}]  ret=${(d.mean*22000).toFixed(2)}pts  hit=${(d.hit_rate*100).toFixed(1)}%  n=${d.n}`);
  }

  const spot = 22000;
  const effectPts = (dec.top - dec.bottom) * spot;
  console.log(`[p02] decile spread = ${effectPts.toFixed(2)} NQ pts`);

  const { train, test } = trainTestSplit(valid);
  const decTrain = decileAnalysis(train.map(s => s.wall_asym), train.map(s => s.fwd_ret_60m));
  const decTest = decileAnalysis(test.map(s => s.wall_asym), test.map(s => s.fwd_ret_60m));
  const trainEffectPts = (decTrain.top - decTrain.bottom) * spot;
  const testEffectPts = (decTest.top - decTest.bottom) * spot;
  console.log(`[p02] train diff = ${trainEffectPts.toFixed(2)}pts  test diff = ${testEffectPts.toFixed(2)}pts`);

  const gate = promotionGate({ n, r, effectPts, trainEffect: trainEffectPts, testEffect: testEffectPts });
  console.log(`[p02] promotable = ${gate.promotable}.  Failed bars: ${gate.failedBars.join('; ')}`);

  appendMasterCsv({
    predictor_id: 'p02_wall_asymmetry',
    predictor_description: '(call_wall - 2*spot + put_wall) / ATR20',
    response: 'fwd_ret_60m',
    n, spearman_r: r, p_value: p,
    top_decile_effect: dec.top, bottom_decile_effect: dec.bottom, decile_diff: dec.diff,
    hit_rate_top: dec.hitRateTop, hit_rate_bot: dec.hitRateBot,
    train_diff: decTrain.diff, test_diff: decTest.diff,
    promotable: gate.promotable,
    notes: gate.failedBars.join('; ') + ` | effectPts=${effectPts.toFixed(2)}`,
  });

  // Secondary: hit-rate prediction (binary upside)
  const hitDiff = (dec.hitRateTop - dec.hitRateBot) * 100;
  console.log(`[p02] hit-rate spread = ${hitDiff.toFixed(2)}pp`);

  return { dec, gate };
}

main().catch(e => { console.error(e); process.exit(1); });
