/**
 * p07 — LT level + GEX wall confluence → forward NQ direction.
 *
 * Hypothesis: when a published LT level (level_1..level_5) sits within 25 NQ
 * pts of either call_wall or put_wall, that level carries extra weight —
 * dealers' gamma defense reinforces it.  Approaching such confluence levels
 * should produce stronger reversion than approaching either alone.
 *
 * Predictor (binary): conf_event = there is at least one LT level within 25 pts
 *                                  of call_wall AND/OR put_wall at this snapshot
 *
 * For directional response, condition on which side the confluence is:
 *  - confluence overhead (near call_wall, above spot): bearish reversion expected
 *  - confluence underneath (near put_wall, below spot): bullish reversion expected
 *
 * Response: fwd_ret_60m
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
  const map = new Map(); // unix_ts(ms) -> [levels...]
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
  console.log('[p07] LT-GEX confluence → fwd_ret_60m');
  const lt = loadLtLevels();
  const { samples } = await buildAlignedSample();

  console.log(`[p07] LT timestamps: ${lt.size}`);

  // For each snapshot, find the most recent LT level set ≤ snapshot time (no lookahead)
  // by binary-search-ish approach.  LT is updated every 15 min so just check the
  // exact 15-min boundary.
  for (const s of samples) {
    let levels = lt.get(s.ts);
    if (!levels) {
      // try fallback to most recent earlier time within 30 minutes
      const probeTs = s.ts - 15 * 60 * 1000;
      levels = lt.get(probeTs);
    }
    if (!levels) { s.conf_overhead = null; s.conf_underneath = null; continue; }

    const cw = s.snapshot.call_wall, pw = s.snapshot.put_wall, spot = s.snapshot.nq_spot;
    if (!Number.isFinite(cw) || !Number.isFinite(pw) || !Number.isFinite(spot)) {
      s.conf_overhead = null; s.conf_underneath = null; continue;
    }
    s.conf_overhead = false;
    s.conf_underneath = false;
    for (const lev of levels) {
      if (lev > spot && Math.abs(lev - cw) <= PROXIMITY_PTS) s.conf_overhead = true;
      if (lev < spot && Math.abs(lev - pw) <= PROXIMITY_PTS) s.conf_underneath = true;
    }
  }

  const valid = samples.filter(s => s.conf_overhead != null && s.conf_underneath != null && Number.isFinite(s.fwd_ret_60m));
  console.log(`[p07] valid: ${valid.length}`);

  const overhead = valid.filter(s => s.conf_overhead && !s.conf_underneath);
  const underneath = valid.filter(s => s.conf_underneath && !s.conf_overhead);
  const both = valid.filter(s => s.conf_overhead && s.conf_underneath);
  const neither = valid.filter(s => !s.conf_overhead && !s.conf_underneath);
  console.log(`[p07] overhead-only=${overhead.length} underneath-only=${underneath.length} both=${both.length} neither=${neither.length}`);

  const spot = 22000;
  const ret = (arr) => arr.map(s => s.fwd_ret_60m);
  const hr = (arr) => arr.filter(s => s.fwd_ret_60m > 0).length / arr.length;

  for (const [label, evs] of [['overhead', overhead], ['underneath', underneath]]) {
    if (evs.length < 30) { console.log(`[p07] ${label}: too few (n=${evs.length})`); continue; }
    const w = welch(ret(evs), ret(neither));
    const evHit = hr(evs), nvHit = hr(neither);
    const effectPts = (w.ma - w.mb) * spot;
    const hitPp = (evHit - nvHit) * 100;
    console.log(`[p07] ${label}: n=${evs.length} mean=${(w.ma*spot).toFixed(2)}pts vs neither=${(w.mb*spot).toFixed(2)}pts diff=${effectPts.toFixed(2)} hit=${(evHit*100).toFixed(1)}% (Δ${hitPp.toFixed(2)}pp) t=${w.t.toFixed(2)}`);

    evs.sort((a, b) => a.ts - b.ts);
    const k = Math.floor(evs.length * 0.7);
    const wTr = welch(ret(evs.slice(0, k)), ret(neither));
    const wTe = welch(ret(evs.slice(k)), ret(neither));
    const trEff = (wTr.ma - wTr.mb) * spot, teEff = (wTe.ma - wTe.mb) * spot;
    console.log(`[p07]   train=${trEff.toFixed(2)}pts test=${teEff.toFixed(2)}pts`);
    const stable = trEff !== 0 && Math.sign(trEff) === Math.sign(teEff) && Math.abs(teEff / trEff) >= 0.5;
    const promotable = evs.length >= 30 && (Math.abs(effectPts) >= 5 || Math.abs(hitPp) >= 5) && stable;
    console.log(`[p07]   promotable=${promotable}`);

    appendMasterCsv({
      predictor_id: `p07_conf_${label}`,
      predictor_description: `binary: at least one LT level within ${PROXIMITY_PTS} NQ pts of ${label === 'overhead' ? 'call_wall above' : 'put_wall below'} spot (excl. opposite side)`,
      response: 'fwd_ret_60m',
      n: evs.length + neither.length,
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
