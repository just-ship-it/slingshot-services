/**
 * Complementarity: does the ES breakout WIN on the days the NQ fade book LOSES?
 * Compares ES candidate #1 daily PnL vs the 4-strategy FCFS portfolio daily PnL over the overlap
 * window (2025-01-13 .. 2026-01-23). Fade series = daily-pnl-mnq-4strat.csv × 10 (MNQ→NQ equiv).
 * Per-strategy attribution from the gold-standard JSONs (netPnL = full NQ $20/pt).
 *
 * Usage: node 07-complementarity.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'output');
const ROOT = path.resolve(__dirname, '../..');
const GS = path.join(ROOT, 'data', 'gold-standard');
const OVL_START = '2025-01-13', OVL_END = '2026-01-23';
const PV = 50, STOP_SLIP = 1.5, MKT_SLIP = 1.0, COMMISSION = 5, RTH_MIN = 390, LOOKBACK = 14, MULT = 1.5, GRID = 30, FIRST_CP = 30;
const NEA_SEC = (15 * 60 + 30 - 570) * 60, EOD_SEC = (15 * 60 + 45 - 570) * 60;

// ---- ES breakout daily PnL (winning config) ----
const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'days.ES.json'), 'utf8'));
const DAYS = meta.days;
const bin = fs.readFileSync(path.join(OUT, 'rth1s.ES.bin'));
const ROW = 12, N = bin.length / ROW;
const mCloseArr = DAYS.map(d => Float64Array.from(d.mClose));
const openArr = DAYS.map(d => d.open), prevCloseArr = DAYS.map(d => isNaN(d.prevClose) ? d.open : d.prevClose);
const UB = new Array(DAYS.length), tradable = new Array(DAYS.length).fill(false);
for (let i = 0; i < DAYS.length; i++) {
  if (i < LOOKBACK || isNaN(openArr[i])) continue;
  const sig = new Float64Array(RTH_MIN); let v = 0;
  for (let k = i - LOOKBACK; k < i; k++) { const ok = openArr[k]; if (isNaN(ok) || ok <= 0) continue; v++; const mc = mCloseArr[k]; for (let m = 0; m < RTH_MIN; m++) sig[m] += Math.abs(mc[m] / ok - 1); }
  if (v < 7) continue;
  const O = openArr[i], hi = Math.max(O, prevCloseArr[i]); const ub = new Float32Array(RTH_MIN);
  for (let m = 0; m < RTH_MIN; m++) ub[m] = hi + (sig[m] / v) * MULT * O; UB[i] = ub; tradable[i] = true;
}
const esDaily = new Map();
{
  let curDay = -1, pos = null, lastCp = -1, dayClosed = false;
  for (let i = 0; i < N; i++) {
    const dayIdx = bin.readUInt16LE(i * ROW), sec = bin.readUInt16LE(i * ROW + 2), close = bin.readFloatLE(i * ROW + 4);
    if (dayIdx !== curDay) { curDay = dayIdx; pos = null; lastCp = -1; dayClosed = false; }
    const date = DAYS[dayIdx].date;
    if (dayClosed || !tradable[dayIdx] || date < OVL_START || date > OVL_END) continue;
    const m = (sec / 60) | 0; if (m >= RTH_MIN) continue;
    if (sec >= EOD_SEC) { if (pos) { const px = close - MKT_SLIP; esDaily.set(date, (esDaily.get(date) || 0) + ((px - pos.entryPx) * PV - COMMISSION)); pos = null; } dayClosed = true; continue; }
    if (!pos && sec < NEA_SEC && m >= FIRST_CP && m % GRID === 0 && m !== lastCp) { lastCp = m; if (close > UB[dayIdx][m]) pos = { entryPx: close + STOP_SLIP }; }
  }
}

// ---- fade book daily PnL (FCFS portfolio, MNQ×10 = NQ equiv) ----
const fadeDaily = new Map();
const csv = fs.readFileSync(path.join(ROOT, 'research', '4strategy-portfolio', 'output', 'daily-pnl-mnq-4strat.csv'), 'utf8').trim().split('\n').slice(1);
for (const line of csv) { const [date, pnl] = line.split(','); if (date >= OVL_START && date <= OVL_END) fadeDaily.set(date, (+pnl) * 10); }

// ---- per-strategy daily (full NQ $) for attribution ----
const stratFiles = { lstb: 'ls-flip-trigger-bar-v3.json', gfi: 'gex-flip-ivpct-v2.json', glx: 'gex-lt-3m-crossover-v3.json', glf: 'gex-level-fade-v2.json' };
const stratDaily = {};
for (const [k, f] of Object.entries(stratFiles)) {
  stratDaily[k] = new Map();
  const j = JSON.parse(fs.readFileSync(path.join(GS, f), 'utf8'));
  const trades = j.results?.trades || j.trades || [];
  for (const t of trades) { const d = new Date(t.entryTime).toISOString().slice(0, 10); if (d >= OVL_START && d <= OVL_END) stratDaily[k].set(d, (stratDaily[k].get(d) || 0) + (t.netPnL || 0)); }
}

// ---- union of dates, correlation ----
const allDates = Array.from(new Set([...fadeDaily.keys(), ...esDaily.keys()])).sort();
const es = allDates.map(d => esDaily.get(d) || 0);
const fade = allDates.map(d => fadeDaily.get(d) || 0);
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const mE = mean(es), mF = mean(fade);
let cov = 0, vE = 0, vF = 0;
for (let i = 0; i < es.length; i++) { cov += (es[i] - mE) * (fade[i] - mF); vE += (es[i] - mE) ** 2; vF += (fade[i] - mF) ** 2; }
const corr = cov / Math.sqrt(vE * vF);

console.log(`\n=== ES breakout vs 4-strategy NQ fade book — ${OVL_START}..${OVL_END} ===`);
console.log(`Overlap days: ${allDates.length} | ES traded ${es.filter(x => x !== 0).length} days | fade traded ${fade.filter(x => x !== 0).length} days`);
console.log(`ES total $${Math.round(es.reduce((s, v) => s + v, 0))} | fade total $${Math.round(fade.reduce((s, v) => s + v, 0))} (NQ-equiv)`);
console.log(`Daily PnL correlation (all days): ${corr.toFixed(3)}\n`);

// fade book's 10 WORST days — what did ES do?
const byFade = allDates.map((d, i) => ({ d, es: es[i], fade: fade[i] })).sort((a, b) => a.fade - b.fade);
console.log('Fade book WORST 10 days — ES PnL same day:');
console.log('date         fade$     ES$');
let esOnFadeWorst = 0;
for (const r of byFade.slice(0, 10)) { esOnFadeWorst += r.es; console.log(`${r.d}  ${String(Math.round(r.fade)).padStart(7)}  ${String(Math.round(r.es)).padStart(7)}${r.es > 0 ? '  ← ES hedged' : ''}`); }
console.log(`   ES sum on fade's 10 worst days: $${Math.round(esOnFadeWorst)}\n`);

// ES's 10 BEST days — what did fade do?
const byEs = allDates.map((d, i) => ({ d, es: es[i], fade: fade[i] })).sort((a, b) => b.es - a.es);
console.log('ES breakout BEST 10 days — fade PnL same day:');
console.log('date          ES$    fade$   | per-strategy (lstb/gfi/glx/glf)');
let fadeOnEsBest = 0;
for (const r of byEs.slice(0, 10)) {
  fadeOnEsBest += r.fade;
  const ps = ['lstb', 'gfi', 'glx', 'glf'].map(k => Math.round(stratDaily[k].get(r.d) || 0)).join('/');
  console.log(`${r.d}  ${String(Math.round(r.es)).padStart(7)}  ${String(Math.round(r.fade)).padStart(7)}  | ${ps}`);
}
console.log(`   Fade sum on ES's 10 best days: $${Math.round(fadeOnEsBest)}\n`);

// sign agreement
let bothPos = 0, bothNeg = 0, opp = 0;
for (let i = 0; i < es.length; i++) { if (es[i] === 0) continue; if (es[i] > 0 && fade[i] > 0) bothPos++; else if (es[i] < 0 && fade[i] < 0) bothNeg++; else opp++; }
console.log(`On ES-trade days: both up ${bothPos} | both down ${bothNeg} | opposite ${opp}`);
