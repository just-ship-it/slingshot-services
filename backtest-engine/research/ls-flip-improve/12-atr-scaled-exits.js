/**
 * Phase 12 — ATR-scaled exits (alternative to fixed-point).
 *
 * Target = N × atr20 of trigger bar. Stop = M × atr20.
 * Each trade's stop/target adapts to volatility at signal time.
 *
 * Compares fixed-point vs ATR-scaled within noAsia + minR3 filter.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WALK = path.join(__dirname, 'output', '01-trades-walk.json');
const POINT_VALUE = 20, COMMISSION = 5, SLIP_PTS = 0.25;
const maxHoldMs = 60 * 60_000;

const walks = JSON.parse(fs.readFileSync(WALK, 'utf-8'));
const noAsia = new Set([0,1,2,3,4,6,7,8,9,10,11,12,13,14,15]);
const filtered = walks.filter(w => noAsia.has(w.hourEt) && (w.triggerBarRange == null || w.triggerBarRange >= 3));
console.log(`Filtered: ${filtered.length}\n`);

function simulate(e, cfg) {
  const atr = e.atr20 || 1;
  const tgt = cfg.atrTgtMult != null ? cfg.atrTgtMult * atr : (cfg.target ?? Infinity);
  const stp = cfg.atrStpMult != null ? cfg.atrStpMult * atr : (cfg.stop ?? Infinity);
  let mfePeak = 0, mae = 0, beActive = false, trActive = false;
  for (let i = 0; i < e.walk.length; i++) {
    const s = e.walk[i]; const t = s[0] * 1000;
    const hi = s[1], lo = s[2], c = s[3];
    if (hi > mfePeak) mfePeak = hi;
    if (lo < 0 && -lo > mae) mae = -lo;
    if (cfg.beTrig != null && !beActive && mfePeak >= cfg.beTrig) beActive = true;
    if (cfg.trTrig != null && !trActive && mfePeak >= cfg.trTrig) trActive = true;
    if (mae >= stp) return { pnl: -(stp + SLIP_PTS), exit: 'stop' };
    if (mfePeak >= tgt) return { pnl: tgt, exit: 'target' };
    if (beActive && lo <= cfg.beOff) return { pnl: cfg.beOff, exit: 'be' };
    if (trActive) { const lvl = mfePeak - cfg.trOff; if (lo <= lvl) return { pnl: lvl - SLIP_PTS, exit: 'trail' }; }
    if (t > maxHoldMs) return { pnl: c, exit: 'maxhold' };
  }
  if (e.terminal === 'eod' && e.eodPrice != null) {
    return { pnl: e.side === 'buy' ? (e.eodPrice - e.entry) : (e.entry - e.eodPrice), exit: 'eod' };
  }
  const last = e.walk[e.walk.length - 1];
  return { pnl: last ? last[3] : 0, exit: 'final' };
}

function statsFor(rs) {
  let pnl = 0, w = 0, l = 0, sW = 0, sL = 0;
  const eq = []; let cum = 0;
  for (const r of rs) {
    const d = r.pnl * POINT_VALUE - COMMISSION;
    pnl += d; cum += d; eq.push(cum);
    if (d > 0) { w++; sW += d; } else if (d < 0) { l++; sL += d; }
  }
  const wr = (w+l)?w/(w+l)*100:0;
  const pf = sL?Math.abs(sW/sL):(sW>0?Infinity:0);
  let peak = -Infinity, maxDD = 0;
  for (const v of eq) { if (v > peak) peak = v; if (peak - v > maxDD) maxDD = peak - v; }
  const mean = pnl / rs.length;
  let varSum = 0;
  for (const r of rs) { const d = r.pnl * POINT_VALUE - COMMISSION; varSum += (d - mean) ** 2; }
  const sd = Math.sqrt(varSum / rs.length);
  const perT = sd > 0 ? mean / sd : 0;
  return { n: rs.length, pnl, wr, pf, maxDD, sharpe: perT * Math.sqrt(rs.length / (16/12)) };
}

console.log(`=== ATR-scaled grid ===`);
console.log(`tMult/sMult  0.5     0.75    1.0     1.25    1.5     1.75    2.0`);
const stps = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
const tgts = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0];
for (const t of tgts) {
  let row = `  ${t.toFixed(1)}  `;
  for (const s of stps) {
    if (t <= s) { row += `   -   `; continue; }
    const cfg = { atrTgtMult: t, atrStpMult: s, beTrig: null, beOff: 0, trTrig: null, trOff: null };
    const rs = filtered.map(w => ({ pnl: simulate(w, cfg).pnl }));
    const st = statsFor(rs);
    row += `${('$'+Math.round(st.pnl/1000)+'k').padStart(7)} `;
  }
  console.log(row);
}

// Top configs
console.log(`\n=== Top 15 ATR-scaled configs by PnL ===`);
const all = [];
for (const t of [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]) {
  for (const s of [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]) {
    if (t <= s) continue;
    for (const beT of [null, 1, 1.5, 2]) {
      for (const beOff of beT == null ? [0] : [0.25, 0.5, 1]) {
        const cfg = { atrTgtMult: t, atrStpMult: s, beTrig: beT, beOff };
        const rs = filtered.map(w => ({ pnl: simulate(w, cfg).pnl }));
        const st = statsFor(rs);
        all.push({ ...st, cfg: `tMult=${t} sMult=${s} be=${beT ?? '-'}/+${beOff}` });
      }
    }
  }
}
all.sort((a,b)=>b.pnl-a.pnl);
console.log(`  PnL($)   PF    Sharpe   DD       WR%    n     | cfg`);
for (let i = 0; i < 15 && i < all.length; i++) {
  const r = all[i];
  console.log(`  ${String(Math.round(r.pnl)).padStart(7)}  ${r.pf.toFixed(2).padStart(4)}  ${r.sharpe.toFixed(2).padStart(6)}  ${String(Math.round(r.maxDD)).padStart(5)}    ${r.wr.toFixed(1).padStart(5)}  ${String(r.n).padStart(4)}  | ${r.cfg}`);
}

// Compare against fixed-point winning configs from earlier sweep
console.log(`\n=== Fixed-point references (within same filter) ===`);
const fix = [
  { target: 15, stop: 8, beTrig: null, beOff: 0, label: 't=15 s=8 (candA-style)' },
  { target: 15, stop: 8, beTrig: 8, beOff: 3, label: 't=15 s=8 BE 8/+3 (candB-config-with-real-BE)' },
  { target: 15, stop: 12, beTrig: null, beOff: 0, label: 't=15 s=12 (candE)' },
  { target: 15, stop: 12, beTrig: 10, beOff: 1, label: 't=15 s=12 BE 10/+1 (candF)' },
  { target: 15, stop: 12, beTrig: 8, beOff: 3, label: 't=15 s=12 BE 8/+3 (candI)' },
];
for (const c of fix) {
  const rs = filtered.map(w => ({ pnl: simulate(w, c).pnl }));
  const st = statsFor(rs);
  console.log(`  ${String(Math.round(st.pnl)).padStart(7)}  PF=${st.pf.toFixed(2)}  Sh=${st.sharpe.toFixed(2)}  DD=${Math.round(st.maxDD)}  WR=${st.wr.toFixed(1)}%  | ${c.label}`);
}
