/**
 * 08 — export the per-trade list for the PARKED recommended config so the
 * I4 conditioner study (TRIN/COR, greenfield/explore/I4-*) can join breadth
 * and stress features by date + entry time.
 *
 * Same replay kernel as 03-sweep.js (feature store: days.ES.json + rth1s.ES.bin),
 * config frozen to the 2026-06-15 recommendation: lookback14 / mult1.5 / long /
 * checkpoint grid30 firstCp30 / hold-to-EOD 15:45 / no-entry-after 12:00 / no stop.
 *
 * Output: output/trades-recommended.ES.csv  (date,entry_min,entry_hhmm_et,pnl)
 * entry_min = minutes from the 09:30 ET open at entry checkpoint.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'output');
const TICKER = 'ES';
const RTH_MIN = 390;
const POINT_VALUE = 50, COMMISSION = 5.0, STOP_SLIP = 1.5, MKT_SLIP = 1.0;
const toSec = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return ((h * 60 + m) - (9 * 60 + 30)) * 60; };

const daysMeta = JSON.parse(fs.readFileSync(path.join(OUT, `days.${TICKER}.json`), 'utf8'));
const DAYS = daysMeta.days;
const bin = fs.readFileSync(path.join(OUT, `rth1s.${TICKER}.bin`));
const ROW = 12, N = Math.floor(bin.length / ROW);
const u16 = new Uint16Array(N * 2), f32 = new Float32Array(N * 2);
for (let i = 0; i < N; i++) {
  u16[i * 2] = bin.readUInt16LE(i * ROW);
  u16[i * 2 + 1] = bin.readUInt16LE(i * ROW + 2);
  f32[i * 2] = bin.readFloatLE(i * ROW + 4);
  f32[i * 2 + 1] = bin.readFloatLE(i * ROW + 8);
}

const mCloseArr = DAYS.map(d => Float64Array.from(d.mClose));
const openArr = DAYS.map(d => d.open);
const prevCloseArr = DAYS.map(d => isNaN(d.prevClose) ? d.open : d.prevClose);

const LOOKBACK = 14, MULT = 1.5, GRID = 30, FIRST_CP = 30;
const NEA_SEC = toSec('12:00'), EOD_SEC = toSec('15:45');

// bands (identical to 03-sweep buildBands)
const UB = new Array(DAYS.length), LB = new Array(DAYS.length), tradable = new Array(DAYS.length).fill(false);
for (let i = 0; i < DAYS.length; i++) {
  if (i < LOOKBACK || isNaN(openArr[i])) continue;
  const sigma = new Float64Array(RTH_MIN); let valid = 0;
  for (let k = i - LOOKBACK; k < i; k++) {
    const ok = openArr[k]; if (isNaN(ok) || ok <= 0) continue; valid++;
    const mc = mCloseArr[k];
    for (let m = 0; m < RTH_MIN; m++) sigma[m] += Math.abs(mc[m] / ok - 1);
  }
  if (valid < Math.max(5, LOOKBACK >> 1)) continue;
  const O = openArr[i], pc = prevCloseArr[i];
  const hi = Math.max(O, pc), lo = Math.min(O, pc);
  const ub = new Float32Array(RTH_MIN), lb = new Float32Array(RTH_MIN);
  for (let m = 0; m < RTH_MIN; m++) { const mv = (sigma[m] / valid) * MULT * O; ub[m] = hi + mv; lb[m] = lo - mv; }
  UB[i] = ub; LB[i] = lb; tradable[i] = true;
}

const trades = [];
let curDay = -1, pos = null, lastCp = -1, dayClosed = false;
for (let i = 0; i < N; i++) {
  const dayIdx = u16[i * 2], sec = u16[i * 2 + 1];
  const close = f32[i * 2];
  if (dayIdx !== curDay) { curDay = dayIdx; pos = null; lastCp = -1; dayClosed = false; }
  if (dayClosed || !tradable[dayIdx]) continue;
  const m = (sec / 60) | 0;
  if (m >= RTH_MIN) continue;
  if (sec >= EOD_SEC) {
    if (pos) {
      const px = close - MKT_SLIP;
      trades.push({ dayIdx, entryMin: pos.entryMin, pnl: (px - pos.entryPrice) * POINT_VALUE - COMMISSION });
      pos = null;
    }
    dayClosed = true; continue;
  }
  const checkpointBar = (m % GRID === 0) && m !== lastCp;
  if (!pos && sec < NEA_SEC && m >= FIRST_CP && checkpointBar) {
    lastCp = m;
    const ub = UB[dayIdx];
    if (close > ub[m]) {
      pos = { entryMin: m, entryPrice: close + STOP_SLIP };
    }
  }
}

const lines = ['date,entry_min,entry_hhmm_et,pnl'];
for (const t of trades) {
  const totMin = 9 * 60 + 30 + t.entryMin;
  const hhmm = `${String((totMin / 60) | 0).padStart(2, '0')}:${String(totMin % 60).padStart(2, '0')}`;
  lines.push(`${DAYS[t.dayIdx].date},${t.entryMin},${hhmm},${t.pnl.toFixed(2)}`);
}
const outFile = path.join(OUT, 'trades-recommended.ES.csv');
fs.writeFileSync(outFile, lines.join('\n') + '\n');
const pnl = trades.reduce((s, t) => s + t.pnl, 0);
console.log(`wrote ${outFile}: ${trades.length} trades, net $${Math.round(pnl)} (must match 03-sweep --one: 135 / $50,538)`);
