/**
 * Inspect candidate #1 signals — print the exact trigger context per trade so we can SEE how
 * each entry fires. Winning config: lookback14, mult1.5, long-only, checkpoint(30m, firstCp30),
 * hold-to-EOD 15:45, no-entry-after 15:30. Fills on strict-primary 1s close.
 *
 * Trigger logic recap: at each 30-min checkpoint (10:00,10:30,...,15:00 ET) while flat, if the
 * current 1s close is ABOVE the upper Concretum band UB(m) = max(open, prevClose) + move(m),
 * where move(m) = mult * open * σ(m) and σ(m) = mean over last 14 days of |price(m)/open − 1|
 * (the "normal" intraday move from the open to that time of day) → go long, hold to EOD.
 *
 * Usage: node 06-inspect-signals.js --ticker ES --start 2025-01-01 [--detail 8]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'output');
const argv = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const TICKER = argv('ticker', 'ES').toUpperCase();
const START = argv('start', '2025-01-01');
const DETAIL = +argv('detail', 8);
const PV = TICKER === 'NQ' ? 20 : 50, COMMISSION = 5, STOP_SLIP = 1.5, MKT_SLIP = 1.0;
const RTH_MIN = 390, LOOKBACK = 14, MULT = 1.5, GRID = 30, FIRST_CP = 30;
const NEA_SEC = (15 * 60 + 30 - 570) * 60, EOD_SEC = (15 * 60 + 45 - 570) * 60;
const etTime = (m) => { const t = 570 + m; return `${String((t / 60) | 0).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
const etTimeSec = (sec) => etTime((sec / 60) | 0);

const meta = JSON.parse(fs.readFileSync(path.join(OUT, `days.${TICKER}.json`), 'utf8'));
const DAYS = meta.days;
const bin = fs.readFileSync(path.join(OUT, `rth1s.${TICKER}.bin`));
const ROW = 12, N = bin.length / ROW;
const mCloseArr = DAYS.map(d => Float64Array.from(d.mClose));
const openArr = DAYS.map(d => d.open);
const prevCloseArr = DAYS.map(d => isNaN(d.prevClose) ? d.open : d.prevClose);

// bands + sigma
const UB = new Array(DAYS.length), SIG = new Array(DAYS.length), tradable = new Array(DAYS.length).fill(false);
for (let i = 0; i < DAYS.length; i++) {
  if (i < LOOKBACK || isNaN(openArr[i])) continue;
  const sigma = new Float64Array(RTH_MIN); let valid = 0;
  for (let k = i - LOOKBACK; k < i; k++) { const ok = openArr[k]; if (isNaN(ok) || ok <= 0) continue; valid++; const mc = mCloseArr[k]; for (let m = 0; m < RTH_MIN; m++) sigma[m] += Math.abs(mc[m] / ok - 1); }
  if (valid < 7) continue;
  const O = openArr[i], pc = prevCloseArr[i], hi = Math.max(O, pc);
  const ub = new Float32Array(RTH_MIN); for (let m = 0; m < RTH_MIN; m++) { sigma[m] /= valid; ub[m] = hi + sigma[m] * MULT * O; }
  UB[i] = ub; SIG[i] = sigma; tradable[i] = true;
}

// replay winner, capture trigger context
const trades = [];
let curDay = -1, pos = null, lastCp = -1, dayClosed = false;
for (let i = 0; i < N; i++) {
  const dayIdx = bin.readUInt16LE(i * ROW), sec = bin.readUInt16LE(i * ROW + 2), close = bin.readFloatLE(i * ROW + 4);
  if (dayIdx !== curDay) { curDay = dayIdx; pos = null; lastCp = -1; dayClosed = false; }
  if (dayClosed || !tradable[dayIdx] || DAYS[dayIdx].date < START) continue;
  const m = (sec / 60) | 0; if (m >= RTH_MIN) continue;
  if (sec >= EOD_SEC) {
    if (pos) { const px = close - MKT_SLIP; trades.push({ ...pos, exitSec: sec, exitClose: close, exitPx: px, pnl: ((px - pos.entryPx) - 0) * PV - COMMISSION, exitReason: 'eod' }); pos = null; }
    dayClosed = true; continue;
  }
  if (pos) { const fav = close - pos.entryPx; if (fav > pos.mfe) pos.mfe = fav; if (-fav > pos.mae) pos.mae = -fav; }
  if (!pos && sec < NEA_SEC && m >= FIRST_CP && m % GRID === 0 && m !== lastCp) {
    lastCp = m;
    const ub = UB[dayIdx][m];
    if (close > ub) {
      pos = { dayIdx, date: DAYS[dayIdx].date, entrySec: sec, m, entryClose: close, entryPx: close + STOP_SLIP,
        O: openArr[dayIdx], pc: prevCloseArr[dayIdx], ub, sigma: SIG[dayIdx][m], price1000: mCloseArr[dayIdx][30], mfe: 0, mae: 0 };
    }
  }
}

// summary
const pnl = trades.reduce((s, t) => s + t.pnl, 0), wins = trades.filter(t => t.pnl > 0).length;
console.log(`\n=== ${TICKER} candidate #1 signals from ${START} — ${trades.length} trades, $${Math.round(pnl)}, WR ${(100 * wins / trades.length).toFixed(0)}% ===\n`);

// concentration / fat-tail analysis
const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
const top3 = sorted.slice(0, 3).reduce((s, t) => s + t.pnl, 0);
const top1 = sorted[0]?.pnl || 0;
const exTop1 = pnl - top1;
console.log(`Fat-tail: top-1 trade $${Math.round(top1)} (${(100 * top1 / pnl).toFixed(0)}% of net), top-3 $${Math.round(top3)} (${(100 * top3 / pnl).toFixed(0)}%). Net WITHOUT top trade = $${Math.round(exTop1)} over ${trades.length - 1} trades.`);
console.log(`Biggest winners: ${sorted.slice(0, 3).map(t => `${t.date} $${Math.round(t.pnl)}`).join(' | ')}`);
console.log(`Biggest losers:  ${sorted.slice(-3).reverse().map(t => `${t.date} $${Math.round(t.pnl)}`).join(' | ')}`);
console.log(`# trades > $1000: ${trades.filter(t => t.pnl > 1000).length} | < -$1000: ${trades.filter(t => t.pnl < -1000).length} | small ±$1000: ${trades.filter(t => Math.abs(t.pnl) <= 1000).length}\n`);
console.log('date        entry  m    open    prevC   UB(band) trigPx  +past  σ(m)%  →exit  exitPx   pnl$   MFE/MAE');
console.log('-'.repeat(104));
for (const t of trades) {
  console.log(
    t.date, etTimeSec(t.entrySec).padStart(5), String(t.m).padStart(3),
    t.O.toFixed(1).padStart(8), t.pc.toFixed(1).padStart(8), t.ub.toFixed(1).padStart(8),
    t.entryClose.toFixed(1).padStart(7), (t.entryClose - t.ub).toFixed(1).padStart(5),
    (t.sigma * 100).toFixed(2).padStart(5), etTimeSec(t.exitSec).padStart(6),
    t.exitClose.toFixed(1).padStart(8), Math.round(t.pnl).toString().padStart(6),
    `  ${t.mfe.toFixed(1)}/${(-t.mae).toFixed(1)}`
  );
}

// detailed narrative for first DETAIL trades
console.log(`\n\n=== Detailed trigger walk-through (first ${Math.min(DETAIL, trades.length)}) ===`);
for (const t of trades.slice(0, DETAIL)) {
  const moveFromOpen = ((t.entryClose - t.O) / t.O * 100);
  const normalMove = (t.sigma * 100);
  const anchor = Math.max(t.O, t.pc);
  console.log(`\n${t.date}  —  ${t.pnl >= 0 ? 'WIN' : 'LOSS'} $${Math.round(t.pnl)}`);
  console.log(`  Open ${t.O.toFixed(2)} | PrevClose ${t.pc.toFixed(2)} | gap ${(t.O - t.pc >= 0 ? '+' : '')}${(t.O - t.pc).toFixed(2)} → band anchored to max(open,prevClose)=${anchor.toFixed(2)}`);
  console.log(`  By ${etTime(t.m)} the 14-day NORMAL move from open to this time = ±${normalMove.toFixed(2)}% (±${(t.sigma * MULT * t.O).toFixed(1)} pts at ${MULT}× mult)`);
  console.log(`  → Upper band UB(${etTime(t.m)}) = ${anchor.toFixed(2)} + ${(t.sigma * MULT * t.O).toFixed(1)} = ${t.ub.toFixed(2)}`);
  console.log(`  Price at ${etTime(t.m)} = ${t.entryClose.toFixed(2)} (+${moveFromOpen.toFixed(2)}% from open) — ABOVE band by ${(t.entryClose - t.ub).toFixed(1)} pts → BUY @ ${t.entryPx.toFixed(2)}`);
  console.log(`  Held to ${etTimeSec(t.exitSec)} EOD, exit ${t.exitClose.toFixed(2)} → $${Math.round(t.pnl)}  (MFE +${t.mfe.toFixed(1)} / MAE -${t.mae.toFixed(1)} pts)`);
}
