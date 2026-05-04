/**
 * p05 — IV crush events → forward absolute return.
 *
 * Hypothesis: when IV drops sharply over 30 min while NQ remains in tight
 * range, energy is being released from the option chain into eventual price
 * movement.  Test if the next 60 min sees larger-than-baseline absolute return.
 *
 * Predictor (binary event):
 *   iv_change_30 = atm_iv[T] - atm_iv[T-30m]
 *   iv_change_z  = (iv_change_30 - μ) / σ over rolling 30 days
 *   nq_range_30  = high(T-30m..T) - low(T-30m..T)
 *   atr20        = daily ATR (20-day)
 *   event = (iv_change_z ≤ -1.5) AND (nq_range_30 < 0.5 * atr20)
 *
 * Response: |fwd_ret_60m|  (mean of event vs non-event), Welch t-test
 *           and fwd_ret_60m sign-of-move imbalance
 */

import { buildAlignedSample, loadAtmIv1m, loadNqOhlcv1m, appendMasterCsv } from './_lib.js';

function welchT(a, b) {
  const ma = mean(a), mb = mean(b);
  const va = variance(a), vb = variance(b);
  const t = (ma - mb) / Math.sqrt(va / a.length + vb / b.length);
  return { t, ma, mb, na: a.length, nb: b.length };
}
function mean(arr) { return arr.reduce((x, y) => x + y, 0) / arr.length; }
function variance(arr) { const m = mean(arr); return arr.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(arr.length - 1, 1); }

async function main() {
  console.log('[p05] IV crush events → forward absolute return');
  const atm = await loadAtmIv1m();
  const { byMinute, atr20ByDate } = await loadNqOhlcv1m();
  const { samples } = await buildAlignedSample();

  // Pre-build a chronological list of IV minutes for rolling stats.
  // We compute iv_change_30m at each sample's snapshot minute.

  function isoMinusMinutes(iso, n) {
    const t = Date.parse(iso + ':00Z') - n * 60000;
    return new Date(t).toISOString().substring(0, 16);
  }

  for (const s of samples) {
    const iso = s.iso;
    const ivNow = atm.get(iso);
    const ivPrev = atm.get(isoMinusMinutes(iso, 30));
    if (!ivNow || !ivPrev) { s.iv_change_30 = null; continue; }
    s.iv_change_30 = ivNow.iv - ivPrev.iv;

    // NQ range over last 30 min (T-30 .. T-1)
    let hi = -Infinity, lo = Infinity;
    for (let m = 1; m <= 30; m++) {
      const c = byMinute.get(isoMinusMinutes(iso, m));
      if (!c) continue;
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
    }
    s.nq_range_30 = (hi > -Infinity && lo < Infinity) ? hi - lo : null;
    s.atr20 = atr20ByDate.get(s.date);
  }

  // Compute rolling Z-score of iv_change_30 (30 calendar days of prior samples)
  const MS_PER_DAY = 86_400_000;
  for (let i = 0; i < samples.length; i++) {
    const cutoff = samples[i].ts - 30 * MS_PER_DAY;
    let n = 0, sum = 0, sum2 = 0;
    for (let j = i - 1; j >= 0 && samples[j].ts >= cutoff; j--) {
      const v = samples[j].iv_change_30;
      if (v == null) continue;
      n++; sum += v; sum2 += v * v;
    }
    if (n < 100) { samples[i].iv_change_z = null; continue; }
    const m = sum / n;
    const sd = Math.sqrt(Math.max(sum2 / n - m * m, 0));
    samples[i].iv_change_z = sd > 0 ? (samples[i].iv_change_30 - m) / sd : 0;
  }

  // Event flag
  const valid = samples.filter(s =>
    s.iv_change_z != null && s.nq_range_30 != null && s.atr20 != null && Number.isFinite(s.fwd_ret_60m));

  for (const s of valid) {
    s.event = (s.iv_change_z <= -1.5) && (s.nq_range_30 < 0.5 * s.atr20);
  }

  const events = valid.filter(s => s.event);
  const nonEvents = valid.filter(s => !s.event);
  console.log(`[p05] valid: ${valid.length}, events: ${events.length}, non-events: ${nonEvents.length}`);

  if (events.length < 30) {
    console.log('[p05] too few events — relaxing threshold to z ≤ -1.0 + range < 0.7*atr20');
    for (const s of valid) s.event = (s.iv_change_z <= -1.0) && (s.nq_range_30 < 0.7 * s.atr20);
    events.length = 0; nonEvents.length = 0;
    valid.forEach(s => (s.event ? events : nonEvents).push(s));
    console.log(`[p05] relaxed: events=${events.length}, non-events=${nonEvents.length}`);
  }

  const spot = 22000;
  const ev_abs = events.map(s => Math.abs(s.fwd_ret_60m));
  const nv_abs = nonEvents.map(s => Math.abs(s.fwd_ret_60m));
  const ev_dir = events.map(s => s.fwd_ret_60m);
  const nv_dir = nonEvents.map(s => s.fwd_ret_60m);

  const tAbs = welchT(ev_abs, nv_abs);
  const tDir = welchT(ev_dir, nv_dir);
  const evHit = events.filter(s => s.fwd_ret_60m > 0).length / events.length;
  const nvHit = nonEvents.filter(s => s.fwd_ret_60m > 0).length / nonEvents.length;

  console.log(`[p05] |fwd_ret_60m|: event mean=${(tAbs.ma*spot).toFixed(2)}pts (n=${tAbs.na})  non-event mean=${(tAbs.mb*spot).toFixed(2)}pts (n=${tAbs.nb})  t=${tAbs.t.toFixed(2)}`);
  console.log(`[p05] fwd_ret_60m:  event mean=${(tDir.ma*spot).toFixed(2)}pts  non-event mean=${(tDir.mb*spot).toFixed(2)}pts  t=${tDir.t.toFixed(2)}`);
  console.log(`[p05] hit-rate event=${(evHit*100).toFixed(1)}%  non-event=${(nvHit*100).toFixed(1)}%  diff=${((evHit-nvHit)*100).toFixed(2)}pp`);

  // Train/test stability — sort events chronologically, split 70/30
  events.sort((a, b) => a.ts - b.ts);
  const k = Math.floor(events.length * 0.7);
  const evTrain = events.slice(0, k), evTest = events.slice(k);
  const tTrain = welchT(evTrain.map(s => Math.abs(s.fwd_ret_60m)), nv_abs);
  const tTest = welchT(evTest.map(s => Math.abs(s.fwd_ret_60m)), nv_abs);
  const trainEffPts = (tTrain.ma - tTrain.mb) * spot;
  const testEffPts = (tTest.ma - tTest.mb) * spot;
  console.log(`[p05] train abs effect ${trainEffPts.toFixed(2)}pts  test ${testEffPts.toFixed(2)}pts`);

  const effectPts = (tAbs.ma - tAbs.mb) * spot;
  const stable = trainEffPts !== 0 && Math.sign(testEffPts) === Math.sign(trainEffPts) && Math.abs(testEffPts / trainEffPts) >= 0.5;
  const promotable = events.length >= 30 && Math.abs(effectPts) >= 5 && stable;
  console.log(`[p05] event-effectPts=${effectPts.toFixed(2)} promotable=${promotable}`);

  appendMasterCsv({
    predictor_id: 'p05_iv_crush_event',
    predictor_description: 'binary: iv_change_30m_z ≤ -1.5 AND nq_range_30m < 0.5*ATR20',
    response: 'abs_fwd_ret_60m',
    n: tAbs.na + tAbs.nb,
    spearman_r: null,
    p_value: null,
    top_decile_effect: tAbs.ma,
    bottom_decile_effect: tAbs.mb,
    decile_diff: tAbs.ma - tAbs.mb,
    hit_rate_top: evHit,
    hit_rate_bot: nvHit,
    train_diff: trainEffPts / spot,
    test_diff: testEffPts / spot,
    promotable,
    notes: `event_n=${events.length}; effectPts=${effectPts.toFixed(2)}; t=${tAbs.t.toFixed(2)}; hit-diff=${((evHit-nvHit)*100).toFixed(2)}pp`,
  });
}

main().catch(e => { console.error(e); process.exit(1); });
