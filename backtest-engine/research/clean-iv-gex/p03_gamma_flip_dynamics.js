/**
 * p03 — gamma flip distance & rate of change → forward NQ direction.
 *
 * Two distinct features explored separately:
 *  (a) flip_dist = (spot - gamma_flip) / atr20
 *      — positive = above flip (positive gamma regime, mean-rev expected)
 *      — negative = below flip (negative gamma regime, momentum expected)
 *  (b) flip_drift_4 = (gamma_flip[T] - gamma_flip[T-4 snapshots]) / atr20
 *      — positive = flip rising over last hour (regime drifting bullish)
 *      — negative = flip falling
 *
 * Response: fwd_ret_60m
 *
 * Hypothesis variants tested:
 *  (a) Distance to flip — if positive gamma supresses moves, then the further
 *      above flip, the *less* directional drift expected (mean-rev to flip).
 *  (b) Drift of flip — if the flip is moving toward price ("toward you"),
 *      reversion is more likely.  Combined sign tested.
 */

import { buildAlignedSample, loadNqOhlcv1m, spearman, decileAnalysis, trainTestSplit, appendMasterCsv, promotionGate } from './_lib.js';

async function main() {
  console.log('[p03] gamma flip dynamics → fwd_ret_60m');
  const { atr20ByDate } = await loadNqOhlcv1m();
  const { samples } = await buildAlignedSample();

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const atr = atr20ByDate.get(s.date);
    const flip = s.snapshot.gamma_flip;
    const spot = s.snapshot.nq_spot;
    if (atr == null || atr === 0 || !Number.isFinite(flip) || !Number.isFinite(spot)) {
      s.flip_dist = null; s.flip_drift_4 = null; continue;
    }
    s.flip_dist = (spot - flip) / atr;

    // 4 prior snapshots (≈ 1 hour)
    if (i >= 4) {
      const flipPrev = samples[i - 4].snapshot.gamma_flip;
      if (Number.isFinite(flipPrev)) {
        s.flip_drift_4 = (flip - flipPrev) / atr;
      } else {
        s.flip_drift_4 = null;
      }
    } else {
      s.flip_drift_4 = null;
    }
  }

  const spot = 22000;

  for (const feat of ['flip_dist', 'flip_drift_4']) {
    const valid = samples.filter(s => s[feat] != null && Math.abs(s[feat]) < 20 && Number.isFinite(s.fwd_ret_60m));
    const xs = valid.map(s => s[feat]);
    const ys = valid.map(s => s.fwd_ret_60m);
    const { r, p, n } = spearman(xs, ys);
    const dec = decileAnalysis(xs, ys);
    const { train, test } = trainTestSplit(valid);
    const decTrain = decileAnalysis(train.map(s => s[feat]), train.map(s => s.fwd_ret_60m));
    const decTest = decileAnalysis(test.map(s => s[feat]), test.map(s => s.fwd_ret_60m));
    const effectPts = (dec.top - dec.bottom) * spot;
    const trainEffPts = (decTrain.top - decTrain.bottom) * spot;
    const testEffPts = (decTest.top - decTest.bottom) * spot;
    console.log(`[p03][${feat}] n=${n} r=${r.toFixed(3)} p=${p?.toExponential(2)} effectPts=${effectPts.toFixed(2)} train=${trainEffPts.toFixed(2)} test=${testEffPts.toFixed(2)}`);
    for (const d of dec.deciles) {
      console.log(`           decile ${d.d}: x ∈ [${d.x_lo.toFixed(2)},${d.x_hi.toFixed(2)}]  ret=${(d.mean*spot).toFixed(2)}pts  hit=${(d.hit_rate*100).toFixed(1)}%  n=${d.n}`);
    }

    const gate = promotionGate({ n, r, effectPts, trainEffect: trainEffPts, testEffect: testEffPts });
    appendMasterCsv({
      predictor_id: `p03_${feat}`,
      predictor_description: feat === 'flip_dist'
        ? '(spot - gamma_flip) / ATR20'
        : 'Δ gamma_flip over last 4 snapshots / ATR20',
      response: 'fwd_ret_60m',
      n, spearman_r: r, p_value: p,
      top_decile_effect: dec.top, bottom_decile_effect: dec.bottom, decile_diff: dec.diff,
      hit_rate_top: dec.hitRateTop, hit_rate_bot: dec.hitRateBot,
      train_diff: decTrain.diff, test_diff: decTest.diff,
      promotable: gate.promotable,
      notes: gate.failedBars.join('; ') + ` | effectPts=${effectPts.toFixed(2)}`,
    });
  }

  // Combined feature: flip_dist × sign(flip_drift_4) — does the flip moving
  // *toward* spot accelerate reversion?
  const valid2 = samples.filter(s =>
    s.flip_dist != null && s.flip_drift_4 != null &&
    Math.abs(s.flip_dist) < 20 && Math.abs(s.flip_drift_4) < 20 &&
    Number.isFinite(s.fwd_ret_60m));

  // Bucket: above-flip + flip-rising (toward spot from below); above-flip + flip-falling; etc.
  const buckets = { abv_rising: [], abv_falling: [], blw_rising: [], blw_falling: [] };
  for (const s of valid2) {
    const above = s.flip_dist > 0;
    const rising = s.flip_drift_4 > 0;
    const k = (above ? 'abv' : 'blw') + '_' + (rising ? 'rising' : 'falling');
    buckets[k].push(s.fwd_ret_60m);
  }
  console.log('[p03] interaction buckets:');
  for (const [k, arr] of Object.entries(buckets)) {
    if (arr.length === 0) continue;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const hitRate = arr.filter(v => v > 0).length / arr.length;
    console.log(`        ${k}: n=${arr.length}  mean=${(mean*spot).toFixed(2)}pts  hit=${(hitRate*100).toFixed(1)}%`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
