/**
 * Phase 6 — Fine-grained sweeps within winning filter sets.
 *
 * Two passes:
 *   A. Hour leave-one-out: dropping each hour separately, vs baseline.
 *   B. BE+trail fine grid within best filter (noAsia + range_ge3).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK_PATH = path.join(__dirname, 'output', '01-trades-walk.json');
const POINT_VALUE = 20, COMMISSION = 5, SLIP_PTS = 0.25;
const maxHoldMs = 60 * 60_000;

console.log(`Loading ${WALK_PATH}...`);
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));

function simulate(e, cfg) {
  const origTgt = e.side === 'buy' ? (e.tp - e.entry) : (e.entry - e.tp);
  const origStp = e.side === 'buy' ? (e.entry - e.sl) : (e.sl - e.entry);
  const tgt = cfg.target == null ? origTgt : cfg.target;
  const stp = cfg.stop == null ? origStp : cfg.stop;
  let mfePeak = 0, mae = 0, beActive = false, trActive = false;
  const walk = e.walk;
  for (let i = 0; i < walk.length; i++) {
    const s = walk[i]; const t = s[0] * 1000;
    const hi = s[1], lo = s[2], c = s[3];
    if (hi > mfePeak) mfePeak = hi;
    if (lo < 0 && -lo > mae) mae = -lo;
    if (cfg.beTrig != null && !beActive && mfePeak >= cfg.beTrig) beActive = true;
    if (cfg.trTrig != null && !trActive && mfePeak >= cfg.trTrig) trActive = true;
    if (mae >= stp) return { exit: 'stop', pnl: -(stp + SLIP_PTS) };
    if (mfePeak >= tgt) return { exit: 'target', pnl: tgt };
    if (beActive && lo <= cfg.beOff) return { exit: 'be', pnl: cfg.beOff };
    if (trActive) { const lvl = mfePeak - cfg.trOff; if (lo <= lvl) return { exit: 'trail', pnl: lvl - SLIP_PTS }; }
    if (t > maxHoldMs) return { exit: 'maxhold', pnl: c };
  }
  if (e.terminal === 'eod' && e.eodPrice != null) {
    return { pnl: e.side === 'buy' ? (e.eodPrice - e.entry) : (e.entry - e.eodPrice) };
  }
  const last = walk[walk.length - 1];
  return { pnl: last ? last[3] : 0 };
}

function statsFor(arr) {
  let pnl = 0, w = 0, l = 0, sW = 0, sL = 0;
  const eq = []; let cum = 0;
  for (const r of arr) {
    const d = r.pnl * POINT_VALUE - COMMISSION;
    pnl += d; cum += d; eq.push(cum);
    if (d > 0) { w++; sW += d; } else if (d < 0) { l++; sL += d; }
  }
  const wr = (w+l) ? w/(w+l)*100 : 0;
  const pf = sL ? Math.abs(sW/sL) : (sW>0?Infinity:0);
  let peak = -Infinity, maxDD = 0;
  for (const v of eq) { if (v > peak) peak = v; if (peak - v > maxDD) maxDD = peak - v; }
  const mean = pnl / arr.length;
  let varSum = 0;
  for (const r of arr) { const d = r.pnl * POINT_VALUE - COMMISSION; varSum += (d - mean) ** 2; }
  const sd = Math.sqrt(varSum / arr.length);
  const perT = sd > 0 ? mean / sd : 0;
  return { pnl, wins: w, losses: l, wr, pf, maxDD, sharpe: perT * Math.sqrt(arr.length / (16/12)), n: arr.length };
}

// ====== A. Hour leave-one-out / leave-one-set-out on tgt15_stp8 baseline ======
const cfgA = { target: 15, stop: 8, beTrig: null, beOff: 0, trTrig: null, trOff: null };
const allResults = walks.map(w => ({ pnl: simulate(w, cfgA).pnl, hourEt: w.hourEt }));
const baseline = statsFor(allResults);
console.log(`\nBaseline tgt=15 stp=8 (no filter): PnL=$${baseline.pnl.toFixed(0)}  PF=${baseline.pf.toFixed(2)}  Sharpe=${baseline.sharpe.toFixed(2)}  DD=$${baseline.maxDD.toFixed(0)}  n=${baseline.n}`);

console.log(`\nA. Drop one ET hour at a time (tgt=15, stp=8):`);
console.log(`  hour   pnlAfter   delta    PF     Sharpe   DD     n      | n@hour pnl@hour`);
const hours = [...new Set(allResults.map(r => r.hourEt))].sort((a,b)=>a-b);
for (const h of hours) {
  const kept = allResults.filter(r => r.hourEt !== h);
  const dropped = allResults.filter(r => r.hourEt === h);
  const sK = statsFor(kept);
  const sD = statsFor(dropped);
  const delta = sK.pnl - baseline.pnl;
  console.log(`   ${String(h).padStart(2)}    ${String(Math.round(sK.pnl)).padStart(7)}  ${String(Math.round(delta)).padStart(6)}  ${sK.pf.toFixed(2).padStart(4)}  ${sK.sharpe.toFixed(2).padStart(6)}  ${String(Math.round(sK.maxDD)).padStart(6)}  ${String(sK.n).padStart(5)}  | ${String(sD.n).padStart(4)} $${Math.round(sD.pnl).toString().padStart(6)}`);
}

// ====== B. Within noAsia, fine BE/trail sweep over best exit cfgs ======
console.log(`\nB. Fine BE/trail sweep within noAsia + range_ge3:`);
console.log(`     PnL($)    PF   Sharpe  DD     WR%   n      | cfg`);
const filter = (w) => {
  const noAsia = [0,1,2,3,4,6,7,8,9,10,11,12,13,14,15];
  if (!noAsia.includes(w.hourEt)) return false;
  if (w.triggerBarRange != null && w.triggerBarRange < 3) return false;
  return true;
};
const filteredWalks = walks.filter(filter);
console.log(`Filtered set: ${filteredWalks.length} trades`);
const targets = [10, 12, 15, 20, 30, null]; // null=orig
const stops = [6, 8, null];
const beVariants = [
  { trig: null, off: 0 },
  { trig: 4, off: 1 }, { trig: 4, off: 2 },
  { trig: 6, off: 2 }, { trig: 6, off: 3 },
  { trig: 8, off: 3 }, { trig: 8, off: 4 },
  { trig: 10, off: 4 },
];
const trVariants = [
  { trig: null, off: null },
  { trig: 4, off: 2 }, { trig: 6, off: 3 },
  { trig: 8, off: 4 }, { trig: 10, off: 4 },
  { trig: 12, off: 5 }, { trig: 15, off: 7 },
];

const fineRows = [];
for (const tgt of targets) {
  for (const stp of stops) {
    if (tgt != null && stp != null && tgt <= stp) continue;
    for (const be of beVariants) {
      for (const tr of trVariants) {
        if (tgt != null && be.trig != null && be.trig >= tgt) continue;
        if (tgt != null && tr.trig != null && tr.trig >= tgt) continue;
        const cfg = { target: tgt, stop: stp, beTrig: be.trig, beOff: be.off, trTrig: tr.trig, trOff: tr.off };
        const res = filteredWalks.map(w => ({ pnl: simulate(w, cfg).pnl }));
        const st = statsFor(res);
        fineRows.push({ ...st, cfg: `tgt=${tgt ?? 'orig'} stp=${stp ?? 'orig'} be=${be.trig ?? '-'}/${be.off} tr=${tr.trig ?? '-'}/${tr.off ?? '-'}` });
      }
    }
  }
}
fineRows.sort((a,b)=>b.pnl-a.pnl);
console.log(`\nTop 25 by PnL within noAsia+range_ge3:`);
for (let i = 0; i < 25; i++) {
  const r = fineRows[i];
  console.log(`     ${String(Math.round(r.pnl)).padStart(8)}  ${r.pf.toFixed(2).padStart(4)}  ${r.sharpe.toFixed(2).padStart(6)}  ${String(Math.round(r.maxDD)).padStart(6)}  ${r.wr.toFixed(1).padStart(5)}  ${String(r.n).padStart(5)}  | ${r.cfg}`);
}
console.log(`\nTop 15 by Sharpe (min n=2000):`);
const byS = [...fineRows].filter(r => r.n >= 2000).sort((a,b)=>b.sharpe-a.sharpe);
for (let i = 0; i < 15 && i < byS.length; i++) {
  const r = byS[i];
  console.log(`     ${String(Math.round(r.pnl)).padStart(8)}  ${r.pf.toFixed(2).padStart(4)}  ${r.sharpe.toFixed(2).padStart(6)}  ${String(Math.round(r.maxDD)).padStart(6)}  ${r.wr.toFixed(1).padStart(5)}  ${String(r.n).padStart(5)}  | ${r.cfg}`);
}

// Save
const outPath = path.join(__dirname, 'output', '06-fine-sweep.csv');
const lines = ['pnl,pf,sharpe,maxDD,wr,n,cfg'];
for (const r of fineRows) lines.push(`${r.pnl.toFixed(0)},${r.pf.toFixed(3)},${r.sharpe.toFixed(3)},${r.maxDD.toFixed(0)},${r.wr.toFixed(2)},${r.n},"${r.cfg}"`);
fs.writeFileSync(outPath, lines.join('\n'));
console.log(`\nWrote ${outPath}`);
