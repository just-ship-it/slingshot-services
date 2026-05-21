/**
 * Phase 8 — Additional feature exploration.
 *
 * Tests:
 *   A. Direction × Hour interaction (are some hours bad only for longs or only for shorts?)
 *   B. Day-of-week with hour filter (Sunday effect after noAsia?)
 *   C. cb_atr × range bucket (interaction)
 *   D. Per-month consistency check (rolling H1 vs H2 by month)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK_PATH = path.join(__dirname, 'output', '01-trades-walk.json');
const POINT_VALUE = 20, COMMISSION = 5, SLIP_PTS = 0.25;
const maxHoldMs = 60 * 60_000;

console.log(`Loading walks...`);
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));

// Use candidate A's exits: tgt=15 stp=8
const CFG = { target: 15, stop: 8, beTrig: null, beOff: 0, trTrig: null, trOff: null };

function simulate(e, cfg) {
  const tgt = cfg.target, stp = cfg.stop;
  let mfePeak = 0, mae = 0;
  for (let i = 0; i < e.walk.length; i++) {
    const s = e.walk[i]; const t = s[0] * 1000;
    const hi = s[1], lo = s[2], c = s[3];
    if (hi > mfePeak) mfePeak = hi;
    if (lo < 0 && -lo > mae) mae = -lo;
    if (mae >= stp) return { pnl: -(stp + SLIP_PTS) };
    if (mfePeak >= tgt) return { pnl: tgt };
    if (t > maxHoldMs) return { pnl: c };
  }
  if (e.terminal === 'eod' && e.eodPrice != null) {
    return { pnl: e.side === 'buy' ? (e.eodPrice - e.entry) : (e.entry - e.eodPrice) };
  }
  const last = e.walk[e.walk.length - 1];
  return { pnl: last ? last[3] : 0 };
}

const noAsia = new Set([0,1,2,3,4,6,7,8,9,10,11,12,13,14,15]);
const noAsiaRange3 = (w) => noAsia.has(w.hourEt) && (w.triggerBarRange == null || w.triggerBarRange >= 3);

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
  return { n: rs.length, pnl, wr, pf, maxDD };
}

const sims = walks.map(w => ({ w, pnl: simulate(w, CFG).pnl }));

// ====== A. Direction × Hour ======
console.log(`\n=== A. Direction × Hour (tgt=15 stp=8) ===`);
console.log(`  hour  long_n  long_pnl  long_wr  long_pf | short_n  short_pnl  short_wr  short_pf`);
const hours = [...new Set(sims.map(r => r.w.hourEt))].sort((a,b)=>a-b);
for (const h of hours) {
  const longs = sims.filter(r => r.w.hourEt === h && r.w.side === 'buy').map(r => ({ pnl: r.pnl }));
  const shorts = sims.filter(r => r.w.hourEt === h && r.w.side === 'sell').map(r => ({ pnl: r.pnl }));
  const sL = statsFor(longs); const sS = statsFor(shorts);
  console.log(`   ${String(h).padStart(2)}    ${String(sL.n).padStart(4)}    ${String(Math.round(sL.pnl)).padStart(6)}    ${sL.wr.toFixed(1).padStart(4)}     ${sL.pf.toFixed(2).padStart(4)} | ${String(sS.n).padStart(5)}    ${String(Math.round(sS.pnl)).padStart(6)}    ${sS.wr.toFixed(1).padStart(4)}     ${sS.pf.toFixed(2).padStart(4)}`);
}

// ====== B. Day of week within noAsia ======
console.log(`\n=== B. Day of week within noAsia (tgt=15 stp=8) ===`);
console.log(`  day    n     pnl     wr%   pf`);
const filtered = sims.filter(r => noAsia.has(r.w.hourEt));
const byDay = new Map();
for (const r of filtered) {
  const day = new Date(r.w.fillTs).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day).push({ pnl: r.pnl });
}
for (const [day, arr] of byDay.entries()) {
  const s = statsFor(arr);
  console.log(`  ${day.padEnd(5)}  ${String(s.n).padStart(4)}  ${String(Math.round(s.pnl)).padStart(7)}  ${s.wr.toFixed(1).padStart(4)}  ${s.pf.toFixed(2).padStart(4)}`);
}

// ====== C. cb_atr × range ======
console.log(`\n=== C. Range × cb_atr (within noAsia, tgt=15 stp=8) ===`);
console.log(`  range\\cb_atr   <0.5    0.5-1.0  1.0-1.5  1.5+`);
const rangeBuckets = [
  { label: '0-5',   test: r => r.triggerBarRange != null && r.triggerBarRange < 5 },
  { label: '5-10',  test: r => r.triggerBarRange != null && r.triggerBarRange >= 5 && r.triggerBarRange < 10 },
  { label: '10-15', test: r => r.triggerBarRange != null && r.triggerBarRange >= 10 && r.triggerBarRange < 15 },
  { label: '15+',   test: r => r.triggerBarRange != null && r.triggerBarRange >= 15 },
];
const cbBuckets = [
  { label: '<0.5',   test: r => r.cbAtr != null && r.cbAtr < 0.5 },
  { label: '0.5-1',  test: r => r.cbAtr != null && r.cbAtr >= 0.5 && r.cbAtr < 1.0 },
  { label: '1-1.5',  test: r => r.cbAtr != null && r.cbAtr >= 1.0 && r.cbAtr < 1.5 },
  { label: '1.5+',   test: r => r.cbAtr != null && r.cbAtr >= 1.5 },
];
for (const rb of rangeBuckets) {
  let row = `  ${rb.label.padEnd(12)}  `;
  for (const cb of cbBuckets) {
    const cell = filtered.filter(r => rb.test(r.w) && cb.test(r.w)).map(r => ({ pnl: r.pnl }));
    const s = statsFor(cell);
    row += `${(s.n ? (`$${Math.round(s.pnl)} (${s.n}, PF${s.pf.toFixed(1)})`) : '-').padEnd(28)} `;
  }
  console.log(row);
}

// ====== D. Per-month consistency ======
console.log(`\n=== D. Per-month consistency (within noAsia, tgt=15 stp=8) ===`);
console.log(`  month   n   pnl   wr%   pf   cum`);
const byMonth = new Map();
for (const r of filtered) {
  const dt = new Date(r.w.fillTs);
  const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
  if (!byMonth.has(key)) byMonth.set(key, []);
  byMonth.get(key).push({ pnl: r.pnl });
}
let cumPnl = 0;
const months = [...byMonth.keys()].sort();
for (const m of months) {
  const s = statsFor(byMonth.get(m));
  cumPnl += s.pnl;
  console.log(`  ${m}   ${String(s.n).padStart(4)}  ${String(Math.round(s.pnl)).padStart(6)}  ${s.wr.toFixed(1).padStart(4)}  ${s.pf.toFixed(2).padStart(4)}  ${String(Math.round(cumPnl)).padStart(7)}`);
}
