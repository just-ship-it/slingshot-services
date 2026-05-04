/**
 * p08 — regime × time-of-day → forward NQ direction.
 *
 * Hypothesis: gamma regime ('positive', 'negative', 'strong_*') interacts with
 * time-of-day differently.  E.g., positive gamma at the 14:00-15:00 UTC RTH
 * open behaves differently than at 19:00-20:00 UTC end-of-day.
 *
 * Predictor: regime × hour-of-day bucket
 * Response: fwd_ret_15m (15-min directional response — TOD-sensitive)
 *
 * For each (regime, hourUTC) cell, compute mean fwd_ret_15m and hit rate.
 * Test individual cells with sufficient n against the global baseline.
 *
 * Promotion candidate: any (regime, hour) cell with n ≥ 500, |effectPts| ≥ 5
 * or |hit-diff| ≥ 5pp, and train/test stable.
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
  console.log('[p08] regime × hour-of-day → fwd_ret_15m');
  const { samples } = await buildAlignedSample();

  for (const s of samples) {
    s.regime = s.snapshot.regime;
    s.hour_utc = +s.iso.substring(11, 13);
  }

  const valid = samples.filter(s =>
    s.regime != null && Number.isFinite(s.hour_utc) && Number.isFinite(s.fwd_ret_15m));

  const cells = new Map(); // 'regime|hour' -> array of fwd_ret_15m
  for (const s of valid) {
    const k = `${s.regime}|${s.hour_utc}`;
    let arr = cells.get(k);
    if (!arr) { arr = []; cells.set(k, arr); }
    arr.push(s);
  }

  const baseline = valid.map(s => s.fwd_ret_15m);
  const baseMean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const baseHit = baseline.filter(v => v > 0).length / baseline.length;
  console.log(`[p08] baseline: mean=${(baseMean*22000).toFixed(2)}pts hit=${(baseHit*100).toFixed(1)}%  n=${baseline.length}`);

  const spot = 22000;
  const interesting = [];
  for (const [k, arr] of [...cells.entries()].sort()) {
    if (arr.length < 200) continue;
    const w = welch(arr.map(s => s.fwd_ret_15m), baseline);
    const hit = arr.filter(s => s.fwd_ret_15m > 0).length / arr.length;
    const effectPts = (w.ma - baseMean) * spot;
    const hitPp = (hit - baseHit) * 100;
    if (Math.abs(w.t) >= 1.5 || Math.abs(hitPp) >= 3) {
      interesting.push({ k, n: arr.length, effectPts, hitPp, t: w.t });
      console.log(`[p08] ${k.padEnd(28)}  n=${String(arr.length).padStart(4)}  mean=${(w.ma*spot).toFixed(2)}pts (Δ${effectPts.toFixed(2)})  hit=${(hit*100).toFixed(1)}% (Δ${hitPp.toFixed(2)}pp)  t=${w.t.toFixed(2)}`);
    }
  }

  // For each interesting cell with n>=500, check train/test stability and write a row
  for (const info of interesting) {
    if (info.n < 500) continue;
    const arr = cells.get(info.k);
    arr.sort((a, b) => a.ts - b.ts);
    const k = Math.floor(arr.length * 0.7);
    const wTr = welch(arr.slice(0, k).map(s => s.fwd_ret_15m), baseline);
    const wTe = welch(arr.slice(k).map(s => s.fwd_ret_15m), baseline);
    const trEff = (wTr.ma - baseMean) * spot;
    const teEff = (wTe.ma - baseMean) * spot;
    console.log(`[p08]   ${info.k} train=${trEff.toFixed(2)} test=${teEff.toFixed(2)}`);

    const stable = trEff !== 0 && Math.sign(trEff) === Math.sign(teEff) && Math.abs(teEff / trEff) >= 0.5;
    const promotable = info.n >= 500 && (Math.abs(info.effectPts) >= 5 || Math.abs(info.hitPp) >= 5) && stable;

    appendMasterCsv({
      predictor_id: `p08_${info.k.replace('|', '_h')}`,
      predictor_description: `regime=${info.k.split('|')[0]} at hour-of-day=${info.k.split('|')[1]} UTC`,
      response: 'fwd_ret_15m',
      n: info.n,
      spearman_r: null, p_value: null,
      top_decile_effect: info.effectPts / spot + baseMean,
      bottom_decile_effect: baseMean,
      decile_diff: info.effectPts / spot,
      hit_rate_top: info.hitPp / 100 + baseHit,
      hit_rate_bot: baseHit,
      train_diff: trEff / spot, test_diff: teEff / spot,
      promotable,
      notes: `cell n=${info.n}; effectPts=${info.effectPts.toFixed(2)}; hit-diff=${info.hitPp.toFixed(2)}pp; t=${info.t.toFixed(2)}`,
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
