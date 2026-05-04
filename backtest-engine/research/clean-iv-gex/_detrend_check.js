/**
 * Drift-bias sanity check for p07 (conf_underneath) and p08 (positive_h15).
 *
 * Both promoted findings rely on signed forward returns over a 16-month sample
 * with ~+25% NQ drift.  Any setup that fires more often during *up* days will
 * inherit a positive bias just from drift.  This script re-runs the gates
 * against a DETRENDED response:
 *
 *     fwd_ret_detrended = fwd_ret − daily_mean_ret_for_that_day
 *
 * The "daily mean" is computed across all aligned samples on that calendar
 * date — the same drift everyone else got.  If the predictor's edge survives,
 * it is a real intraday level/regime effect.  If it collapses, it was bull
 * drift.
 */

import fs from 'fs';
import path from 'path';
import { buildAlignedSample, REPO_ROOT, appendMasterCsv } from './_lib.js';

const PROXIMITY_PTS = 25;

function welch(a, b) {
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  const va = a.reduce((x, y) => x + (y - ma) ** 2, 0) / Math.max(a.length - 1, 1);
  const vb = b.reduce((x, y) => x + (y - mb) ** 2, 0) / Math.max(b.length - 1, 1);
  const t = (ma - mb) / Math.sqrt(va / a.length + vb / b.length);
  return { ma, mb, t };
}

function loadLtLevels() {
  const fp = path.join(REPO_ROOT, 'data/liquidity/nq/NQ_liquidity_levels.csv');
  const text = fs.readFileSync(fp, 'utf8');
  const lines = text.trim().split('\n');
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const ts = +c[1];
    if (!Number.isFinite(ts)) continue;
    if (ts < Date.parse('2025-01-01')) continue;
    const levels = [+c[3], +c[4], +c[5], +c[6], +c[7]].filter(Number.isFinite);
    map.set(ts, levels);
  }
  return map;
}

async function main() {
  console.log('[detrend] drift-bias sanity check for p07 + p08');
  const lt = loadLtLevels();
  const { samples } = await buildAlignedSample();

  // Compute daily mean for fwd_ret_60m and fwd_ret_15m
  const dailyAggr = new Map(); // date -> {sum60, n60, sum15, n15}
  for (const s of samples) {
    let d = dailyAggr.get(s.date);
    if (!d) { d = { sum60: 0, n60: 0, sum15: 0, n15: 0 }; dailyAggr.set(s.date, d); }
    if (Number.isFinite(s.fwd_ret_60m)) { d.sum60 += s.fwd_ret_60m; d.n60++; }
    if (Number.isFinite(s.fwd_ret_15m)) { d.sum15 += s.fwd_ret_15m; d.n15++; }
  }
  for (const d of dailyAggr.values()) {
    d.mean60 = d.n60 > 0 ? d.sum60 / d.n60 : 0;
    d.mean15 = d.n15 > 0 ? d.sum15 / d.n15 : 0;
  }
  for (const s of samples) {
    const d = dailyAggr.get(s.date);
    s.fwd_ret_60m_detrended = s.fwd_ret_60m - d.mean60;
    s.fwd_ret_15m_detrended = s.fwd_ret_15m - d.mean15;
  }

  // ────────────────────────────────────────────────────────────────────────
  // p07 conf_underneath — recompute predictor and use detrended response
  // ────────────────────────────────────────────────────────────────────────
  for (const s of samples) {
    let levels = lt.get(s.ts);
    if (!levels) levels = lt.get(s.ts - 15 * 60 * 1000);
    const cw = s.snapshot.call_wall, pw = s.snapshot.put_wall, spot = s.snapshot.nq_spot;
    if (!levels || ![cw, pw, spot].every(Number.isFinite)) {
      s.conf_overhead = null; s.conf_underneath = null; continue;
    }
    s.conf_overhead = false;
    s.conf_underneath = false;
    for (const lev of levels) {
      if (lev > spot && Math.abs(lev - cw) <= PROXIMITY_PTS) s.conf_overhead = true;
      if (lev < spot && Math.abs(lev - pw) <= PROXIMITY_PTS) s.conf_underneath = true;
    }
  }

  const valid07 = samples.filter(s =>
    s.conf_overhead != null && s.conf_underneath != null && Number.isFinite(s.fwd_ret_60m));
  const underneath = valid07.filter(s => s.conf_underneath && !s.conf_overhead);
  const neither07 = valid07.filter(s => !s.conf_overhead && !s.conf_underneath);
  const overhead = valid07.filter(s => s.conf_overhead && !s.conf_underneath);

  console.log(`\n=== p07 conf_underneath ===`);
  for (const [label, ev, base] of [['underneath_RAW',  underneath, neither07],
                                    ['underneath_DET', underneath, neither07],
                                    ['overhead_RAW',   overhead,   neither07],
                                    ['overhead_DET',   overhead,   neither07]]) {
    const isDetrend = label.endsWith('DET');
    const evY = ev.map(s => isDetrend ? s.fwd_ret_60m_detrended : s.fwd_ret_60m);
    const baseY = base.map(s => isDetrend ? s.fwd_ret_60m_detrended : s.fwd_ret_60m);
    const w = welch(evY, baseY);
    const evHit = ev.filter(s => (isDetrend ? s.fwd_ret_60m_detrended : s.fwd_ret_60m) > 0).length / ev.length;
    const baseHit = base.filter(s => (isDetrend ? s.fwd_ret_60m_detrended : s.fwd_ret_60m) > 0).length / base.length;
    const effPts = (w.ma - w.mb) * 22000;
    const hitPp = (evHit - baseHit) * 100;
    console.log(`[p07][${label}] event_n=${ev.length}  effect=${effPts.toFixed(2)}pts  hit-Δ=${hitPp.toFixed(2)}pp  t=${w.t.toFixed(2)}`);

    // train/test stability
    ev.sort((a, b) => a.ts - b.ts);
    const k = Math.floor(ev.length * 0.7);
    const trEv = ev.slice(0, k), teEv = ev.slice(k);
    const trEvY = trEv.map(s => isDetrend ? s.fwd_ret_60m_detrended : s.fwd_ret_60m);
    const teEvY = teEv.map(s => isDetrend ? s.fwd_ret_60m_detrended : s.fwd_ret_60m);
    const wTr = welch(trEvY, baseY);
    const wTe = welch(teEvY, baseY);
    const trEff = (wTr.ma - wTr.mb) * 22000;
    const teEff = (wTe.ma - wTe.mb) * 22000;
    console.log(`              train=${trEff.toFixed(2)} test=${teEff.toFixed(2)} (n_tr=${trEv.length} n_te=${teEv.length})`);

    if (isDetrend) {
      const stable = trEff !== 0 && Math.sign(trEff) === Math.sign(teEff) && Math.abs(teEff / trEff) >= 0.5;
      const promotable = ev.length >= 30 && (Math.abs(effPts) >= 5 || Math.abs(hitPp) >= 5) && stable;
      appendMasterCsv({
        predictor_id: `p07_conf_${label.split('_')[0]}_DETRENDED`,
        predictor_description: `binary: LT-level within 25 pts of ${label.startsWith('underneath') ? 'put_wall below' : 'call_wall above'} spot — DETRENDED response (fwd_ret − daily_mean)`,
        response: 'fwd_ret_60m_detrended',
        n: ev.length + base.length,
        spearman_r: null, p_value: null,
        top_decile_effect: w.ma, bottom_decile_effect: w.mb, decile_diff: w.ma - w.mb,
        hit_rate_top: evHit, hit_rate_bot: baseHit,
        train_diff: trEff / 22000, test_diff: teEff / 22000,
        promotable,
        notes: `event_n=${ev.length}; effectPts=${effPts.toFixed(2)}; hit-diff=${hitPp.toFixed(2)}pp; t=${w.t.toFixed(2)}`,
      });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // p08 positive_h15 — detrended fwd_ret_15m
  // ────────────────────────────────────────────────────────────────────────
  for (const s of samples) {
    s.regime = s.snapshot.regime;
    s.hour_utc = +s.iso.substring(11, 13);
  }
  const valid08 = samples.filter(s => s.regime != null && Number.isFinite(s.hour_utc) && Number.isFinite(s.fwd_ret_15m));
  const baseAll = valid08.map(s => s.fwd_ret_15m);
  const baseAllDet = valid08.map(s => s.fwd_ret_15m_detrended);
  const baseAllMean = baseAll.reduce((a, b) => a + b, 0) / baseAll.length;
  const baseAllDetMean = baseAllDet.reduce((a, b) => a + b, 0) / baseAllDet.length;
  const baseAllHit = baseAll.filter(v => v > 0).length / baseAll.length;
  const baseAllDetHit = baseAllDet.filter(v => v > 0).length / baseAllDet.length;

  console.log(`\n=== p08 positive_h15 ===`);
  console.log(`baseline RAW: mean=${(baseAllMean*22000).toFixed(2)}pts hit=${(baseAllHit*100).toFixed(2)}% (n=${valid08.length})`);
  console.log(`baseline DET: mean=${(baseAllDetMean*22000).toFixed(4)}pts hit=${(baseAllDetHit*100).toFixed(2)}%`);

  // For each (regime, hour), compute mean and hit rate against detrended baseline
  const cells = new Map();
  for (const s of valid08) {
    const k = `${s.regime}|${s.hour_utc}`;
    let arr = cells.get(k);
    if (!arr) { arr = []; cells.set(k, arr); }
    arr.push(s);
  }

  for (const k of ['positive|15', 'positive|10', 'positive|11', 'positive|12', 'positive|16']) {
    const arr = cells.get(k);
    if (!arr) continue;
    for (const detrend of [false, true]) {
      const ys = arr.map(s => detrend ? s.fwd_ret_15m_detrended : s.fwd_ret_15m);
      const baseY = detrend ? baseAllDet : baseAll;
      const w = welch(ys, baseY);
      const hit = arr.filter(s => (detrend ? s.fwd_ret_15m_detrended : s.fwd_ret_15m) > 0).length / arr.length;
      const baseHit = detrend ? baseAllDetHit : baseAllHit;
      const effPts = (w.ma - w.mb) * 22000;
      const hitPp = (hit - baseHit) * 100;
      console.log(`[p08][${k} ${detrend ? 'DET' : 'RAW'}]  n=${arr.length}  effect=${effPts.toFixed(2)}pts  hit-Δ=${hitPp.toFixed(2)}pp  t=${w.t.toFixed(2)}`);

      if (detrend && k === 'positive|15') {
        arr.sort((a, b) => a.ts - b.ts);
        const kk = Math.floor(arr.length * 0.7);
        const trArr = arr.slice(0, kk), teArr = arr.slice(kk);
        const wTr = welch(trArr.map(s => s.fwd_ret_15m_detrended), baseY);
        const wTe = welch(teArr.map(s => s.fwd_ret_15m_detrended), baseY);
        const trEff = (wTr.ma - wTr.mb) * 22000;
        const teEff = (wTe.ma - wTe.mb) * 22000;
        console.log(`              train=${trEff.toFixed(2)} test=${teEff.toFixed(2)} (n_tr=${trArr.length} n_te=${teArr.length})`);

        const stable = trEff !== 0 && Math.sign(trEff) === Math.sign(teEff) && Math.abs(teEff / trEff) >= 0.5;
        const promotable = arr.length >= 500 && (Math.abs(effPts) >= 5 || Math.abs(hitPp) >= 5) && stable;
        appendMasterCsv({
          predictor_id: 'p08_positive_h15_DETRENDED',
          predictor_description: 'regime=positive at hour 15 UTC — DETRENDED response',
          response: 'fwd_ret_15m_detrended',
          n: arr.length,
          spearman_r: null, p_value: null,
          top_decile_effect: w.ma, bottom_decile_effect: w.mb, decile_diff: w.ma - w.mb,
          hit_rate_top: hit, hit_rate_bot: baseHit,
          train_diff: trEff / 22000, test_diff: teEff / 22000,
          promotable,
          notes: `cell n=${arr.length}; effectPts=${effPts.toFixed(2)}; hit-diff=${hitPp.toFixed(2)}pp; t=${w.t.toFixed(2)}`,
        });
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
