/**
 * Phase 10 — Fine-grained target/stop sweep around the winning region,
 * within best filter (noAsia + range_ge3).
 *
 * Hypothesis: the (15, 8) winner from the coarse sweep might not be the local peak.
 * Test target in {10..30, step 1} × stop in {4..12, step 1} = 21 × 9 = 189 combos.
 * Also explore (orig, stop) configurations more finely.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK = path.join(__dirname, 'output', '01-trades-walk.json');
const POINT_VALUE = 20, COMMISSION = 5, SLIP_PTS = 0.25;
const maxHoldMs = 60 * 60_000;

console.log('Loading walks...');
const walks = JSON.parse(fs.readFileSync(WALK, 'utf-8'));
const noAsia = new Set([0,1,2,3,4,6,7,8,9,10,11,12,13,14,15]);
const filtered = walks.filter(w => noAsia.has(w.hourEt) && (w.triggerBarRange == null || w.triggerBarRange >= 3));
console.log(`Filtered (noAsia + range≥3): ${filtered.length} trades`);

function simulate(e, cfg) {
  const origTgt = e.side === 'buy' ? (e.tp - e.entry) : (e.entry - e.tp);
  const origStp = e.side === 'buy' ? (e.entry - e.sl) : (e.sl - e.entry);
  const tgt = cfg.target == null ? origTgt : cfg.target;
  const stp = cfg.stop == null ? origStp : cfg.stop;
  let mfePeak = 0, mae = 0, beActive = false, trActive = false;
  for (let i = 0; i < e.walk.length; i++) {
    const s = e.walk[i]; const t = s[0] * 1000;
    const hi = s[1], lo = s[2], c = s[3];
    if (hi > mfePeak) mfePeak = hi;
    if (lo < 0 && -lo > mae) mae = -lo;
    if (cfg.beTrig != null && !beActive && mfePeak >= cfg.beTrig) beActive = true;
    if (cfg.trTrig != null && !trActive && mfePeak >= cfg.trTrig) trActive = true;
    if (mae >= stp) return { pnl: -(stp + SLIP_PTS) };
    if (mfePeak >= tgt) return { pnl: tgt };
    if (beActive && lo <= cfg.beOff) return { pnl: cfg.beOff };
    if (trActive) { const lvl = mfePeak - cfg.trOff; if (lo <= lvl) return { pnl: lvl - SLIP_PTS }; }
    if (t > maxHoldMs) return { pnl: c };
  }
  if (e.terminal === 'eod' && e.eodPrice != null) {
    return { pnl: e.side === 'buy' ? (e.eodPrice - e.entry) : (e.entry - e.eodPrice) };
  }
  const last = e.walk[e.walk.length - 1];
  return { pnl: last ? last[3] : 0 };
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

// Fine target/stop grid
console.log(`\n=== Fine target/stop grid (no BE/trail) ===`);
console.log(`target\\stop  4       5       6       7       8       9       10      12`);
const stps = [4, 5, 6, 7, 8, 9, 10, 12];
const tgts = [10, 12, 14, 15, 16, 18, 20, 22, 25, 28, 30];
for (const t of tgts) {
  let row = `  ${String(t).padStart(2)}  `;
  for (const s of stps) {
    if (t <= s) { row += `   -   `; continue; }
    const cfg = { target: t, stop: s, beTrig: null, beOff: 0, trTrig: null, trOff: null };
    const rs = filtered.map(w => ({ pnl: simulate(w, cfg).pnl }));
    const st = statsFor(rs);
    row += `${('$'+Math.round(st.pnl/1000)+'k').padStart(7)} `;
  }
  console.log(row);
}

// Now with BE
console.log(`\n=== With BE @ trigger=8, offset=3 (no trail) ===`);
console.log(`target\\stop  4       5       6       7       8       9       10      12`);
for (const t of tgts) {
  let row = `  ${String(t).padStart(2)}  `;
  for (const s of stps) {
    if (t <= s) { row += `   -   `; continue; }
    if (8 >= t) { row += `   -   `; continue; }  // BE trigger >= target = nonsense
    const cfg = { target: t, stop: s, beTrig: 8, beOff: 3, trTrig: null, trOff: null };
    const rs = filtered.map(w => ({ pnl: simulate(w, cfg).pnl }));
    const st = statsFor(rs);
    row += `${('$'+Math.round(st.pnl/1000)+'k').padStart(7)} `;
  }
  console.log(row);
}

// Best configs detail
console.log(`\n=== Top 30 in fine grid by PnL ===`);
const allRows = [];
for (const t of tgts) {
  for (const s of stps) {
    if (t <= s) continue;
    for (const be of [null, 5, 6, 7, 8, 9, 10, 12]) {
      for (const beOff of be == null ? [0] : [1, 2, 3, 4]) {
        if (be != null && be >= t) continue;
        for (const tr of [{trig:null,off:null}, {trig:8,off:3}, {trig:10,off:4}, {trig:12,off:5}, {trig:15,off:6}]) {
          if (t != null && tr.trig != null && tr.trig >= t) continue;
          const cfg = { target: t, stop: s, beTrig: be, beOff: beOff, trTrig: tr.trig, trOff: tr.off };
          const rs = filtered.map(w => ({ pnl: simulate(w, cfg).pnl }));
          const st = statsFor(rs);
          allRows.push({ ...st, cfg: `t=${t} s=${s} be=${be ?? '-'}/+${beOff} tr=${tr.trig ?? '-'}/${tr.off ?? '-'}` });
        }
      }
    }
  }
}
allRows.sort((a,b)=>b.pnl-a.pnl);
console.log(`  PnL($)    PF   Sharpe   DD($)   WR%    n     | cfg`);
for (let i = 0; i < 30 && i < allRows.length; i++) {
  const r = allRows[i];
  console.log(`  ${String(Math.round(r.pnl)).padStart(7)}  ${r.pf.toFixed(2).padStart(4)}  ${r.sharpe.toFixed(2).padStart(6)}  ${String(Math.round(r.maxDD)).padStart(5)}   ${r.wr.toFixed(1).padStart(5)}  ${String(r.n).padStart(4)}  | ${r.cfg}`);
}
console.log(`\nTop 15 by Sharpe (min n=2000):`);
const byS = [...allRows].filter(r => r.n >= 2000).sort((a,b)=>b.sharpe-a.sharpe);
for (let i = 0; i < 15 && i < byS.length; i++) {
  const r = byS[i];
  console.log(`  ${String(Math.round(r.pnl)).padStart(7)}  ${r.pf.toFixed(2).padStart(4)}  ${r.sharpe.toFixed(2).padStart(6)}  ${String(Math.round(r.maxDD)).padStart(5)}   ${r.wr.toFixed(1).padStart(5)}  ${String(r.n).padStart(4)}  | ${r.cfg}`);
}

// save
const out = path.join(__dirname, 'output', '10-fine-target-stop.csv');
const lines = ['pnl,pf,sharpe,maxDD,wr,n,cfg'];
for (const r of allRows) lines.push(`${r.pnl.toFixed(0)},${r.pf.toFixed(3)},${r.sharpe.toFixed(3)},${r.maxDD.toFixed(0)},${r.wr.toFixed(2)},${r.n},"${r.cfg}"`);
fs.writeFileSync(out, lines.join('\n'));
console.log(`\nWrote ${out}  (${allRows.length} rows)`);
