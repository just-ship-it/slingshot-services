/**
 * p06 — Gamma flip crossover events → forward NQ direction.
 *
 * Hypothesis: when spot crosses the gamma flip in this snapshot (i.e., the
 * sign of (spot - gamma_flip) changed since the prior snapshot), it marks a
 * regime transition.
 *
 *   "cross_up"   = prior snapshot below flip, current above flip
 *   "cross_down" = prior snapshot above flip, current below flip
 *
 * Hypothesis A (mean-rev into positive gamma):  cross_up → negative fwd return
 *                                                cross_down → positive fwd return
 * Hypothesis B (momentum):                       cross_up → positive fwd return
 *                                                cross_down → negative fwd return
 *
 * Test all four bucket means + Welch t-test event-vs-non-event.
 */

import { buildAlignedSample, appendMasterCsv } from './_lib.js';

function welch(a, b) {
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  const va = a.reduce((x, y) => x + (y - ma) ** 2, 0) / Math.max(a.length - 1, 1);
  const vb = b.reduce((x, y) => x + (y - mb) ** 2, 0) / Math.max(b.length - 1, 1);
  const t = (ma - mb) / Math.sqrt(va / a.length + vb / b.length);
  return { ma, mb, t };
}

async function main() {
  console.log('[p06] gamma flip crossover → fwd_ret_60m');
  const { samples } = await buildAlignedSample();

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    s.cross = null;
    if (i === 0) continue;
    const prev = samples[i - 1];
    // Same-day adjacency only — cross within one snapshot
    if (prev.date !== s.date) continue;
    const flipNow = s.snapshot.gamma_flip;
    const flipPrev = prev.snapshot.gamma_flip;
    const spotNow = s.snapshot.nq_spot;
    const spotPrev = prev.snapshot.nq_spot;
    if (![flipNow, flipPrev, spotNow, spotPrev].every(Number.isFinite)) continue;
    const sideNow = spotNow > flipNow ? 1 : -1;
    const sidePrev = spotPrev > flipPrev ? 1 : -1;
    if (sideNow === sidePrev) s.cross = 'none';
    else if (sideNow > sidePrev) s.cross = 'cross_up';
    else s.cross = 'cross_down';
  }

  const valid = samples.filter(s => s.cross != null && Number.isFinite(s.fwd_ret_60m));
  const upEvents = valid.filter(s => s.cross === 'cross_up');
  const dnEvents = valid.filter(s => s.cross === 'cross_down');
  const noneEvents = valid.filter(s => s.cross === 'none');

  console.log(`[p06] valid=${valid.length} cross_up=${upEvents.length} cross_down=${dnEvents.length} none=${noneEvents.length}`);

  const spot = 22000;
  const ret = (arr) => arr.map(s => s.fwd_ret_60m);
  const hr = (arr) => arr.filter(s => s.fwd_ret_60m > 0).length / arr.length;

  for (const [label, evs] of [['cross_up', upEvents], ['cross_down', dnEvents]]) {
    if (evs.length < 30) { console.log(`[p06] ${label}: too few (n=${evs.length}) — skip`); continue; }
    const w = welch(ret(evs), ret(noneEvents));
    const evHit = hr(evs), nvHit = hr(noneEvents);
    const effectPts = (w.ma - w.mb) * spot;
    const hitPp = (evHit - nvHit) * 100;
    console.log(`[p06] ${label}: n=${evs.length}  mean=${(w.ma*spot).toFixed(2)}pts  vs none=${(w.mb*spot).toFixed(2)}pts  diff=${effectPts.toFixed(2)}pts  hit=${(evHit*100).toFixed(1)}% (vs ${(nvHit*100).toFixed(1)}%, Δ${hitPp.toFixed(2)}pp)  t=${w.t.toFixed(2)}`);

    // Train/test
    evs.sort((a, b) => a.ts - b.ts);
    const k = Math.floor(evs.length * 0.7);
    const evTrain = evs.slice(0, k), evTest = evs.slice(k);
    const wTr = welch(ret(evTrain), ret(noneEvents));
    const wTe = welch(ret(evTest), ret(noneEvents));
    const trEff = (wTr.ma - wTr.mb) * spot, teEff = (wTe.ma - wTe.mb) * spot;
    console.log(`[p06]    train=${trEff.toFixed(2)}pts (n=${evTrain.length})  test=${teEff.toFixed(2)}pts (n=${evTest.length})`);
    const stable = trEff !== 0 && Math.sign(trEff) === Math.sign(teEff) && Math.abs(teEff / trEff) >= 0.5;
    const promotable = evs.length >= 30 && (Math.abs(effectPts) >= 5 || Math.abs(hitPp) >= 5) && stable;
    console.log(`[p06]    promotable=${promotable}`);

    appendMasterCsv({
      predictor_id: `p06_${label}`,
      predictor_description: `binary: spot ${label === 'cross_up' ? 'crossed above' : 'crossed below'} gamma_flip in this 15-min snapshot`,
      response: 'fwd_ret_60m',
      n: evs.length + noneEvents.length,
      spearman_r: null, p_value: null,
      top_decile_effect: w.ma, bottom_decile_effect: w.mb, decile_diff: w.ma - w.mb,
      hit_rate_top: evHit, hit_rate_bot: nvHit,
      train_diff: trEff / spot, test_diff: teEff / spot,
      promotable,
      notes: `event_n=${evs.length}; effectPts=${effectPts.toFixed(2)}; hit-diff=${hitPp.toFixed(2)}pp; t=${w.t.toFixed(2)}`,
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
