/**
 * Candidate #2 (Baltussen rROD) & #3 (Gao first-half-hour) — last-30-min market intraday
 * momentum. Once-a-day directional hold into the close; direction = sign of an earlier return.
 *
 *   Gao  r1   = mClose[30]/prevClose − 1   (prev close → 10:00 ET, incl. overnight gap)
 *   rROD       = mClose[360]/prevClose − 1  (prev close → 15:30 ET, "rest of day")
 *   entry = price at 15:30 (m=360), exit = price at close (m=389) or 15:45 (m=375).
 *   dir   = sign(predictor); long if >0 else short. No intraday stop → 1m-honest (no path dep).
 *
 * Pure market-in/market-out: round-trip slippage = 2× MKT_SLIP, plus commission. 1 contract.
 * Reads output/days.<ticker>.json (no 1s needed → instant).
 *
 * Usage: node 04-last30.js --ticker ES
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'output');
const argv = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const TICKER = argv('ticker', 'ES').toUpperCase();
const PV = TICKER === 'NQ' ? 20 : 50, COMMISSION = 5.0, MKT_SLIP = 1.0;
const RTH_MIN = 390;
const M_1000 = 30, M_1530 = 360, M_1545 = 375, M_CLOSE = RTH_MIN - 1; // minute indices

const meta = JSON.parse(fs.readFileSync(path.join(OUT, `days.${TICKER}.json`), 'utf8'));
const DAYS = meta.days;

function run(cfg) {
  const { predictor, side = 'both', exitM = M_CLOSE, minMovePts = 0, startDate = null, endDate = null } = cfg;
  const trades = [];
  for (let i = 1; i < DAYS.length; i++) {
    const d = DAYS[i];
    if (startDate && d.date < startDate) continue;
    if (endDate && d.date > endDate) continue;
    const prevClose = DAYS[i - 1].mClose[M_CLOSE];
    if (!(prevClose > 0) || !(d.mClose[M_1530] > 0)) continue;
    const pred = predictor === 'gao' ? (d.mClose[M_1000] / prevClose - 1) : (d.mClose[M_1530] / prevClose - 1);
    const predPts = pred * prevClose; // in points, for magnitude filter
    if (Math.abs(predPts) < minMovePts) continue;
    let dir = pred > 0 ? 1 : -1;
    if (side === 'long' && dir < 0) continue;
    if (side === 'short' && dir > 0) continue;
    const entry = d.mClose[M_1530], exit = d.mClose[exitM];
    const pnl = ((exit - dir * MKT_SLIP) - (entry + dir * MKT_SLIP) * 1) * dir * PV - COMMISSION;
    // simplify: pnl = ((exit-entry)*dir - 2*MKT_SLIP) * PV - COMM
    const pnl2 = (((exit - entry) * dir) - 2 * MKT_SLIP) * PV - COMMISSION;
    trades.push({ dayIdx: i, side: dir, pnl: pnl2 });
  }
  return metrics(trades, cfg);
}

function metrics(trades, cfg) {
  const n = trades.length;
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = -losses.reduce((s, t) => s + t.pnl, 0);
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const pf = gl > 0 ? gw / gl : Infinity, wr = n ? wins.length / n : 0;
  let eq = 0, peak = 0, mdd = 0; const byDay = new Map();
  for (const t of trades) { eq += t.pnl; if (eq > peak) peak = eq; if (peak - eq > mdd) mdd = peak - eq; byDay.set(t.dayIdx, t.pnl); }
  const dv = Array.from(byDay.values()); const mean = dv.reduce((s, v) => s + v, 0) / (dv.length || 1);
  const sd = Math.sqrt(dv.reduce((s, v) => s + (v - mean) ** 2, 0) / (dv.length || 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  const half = Math.floor(n / 2);
  const pfOf = a => { const w = a.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0); const l = -a.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0); return l > 0 ? w / l : Infinity; };
  return { cfg, n, pnl: Math.round(pnl), wr, pf, sharpe, mdd: Math.round(mdd), h1pf: pfOf(trades.slice(0, half)), h2pf: pfOf(trades.slice(half)) };
}

// ---- matrix ----
const windows = { 'full': {}, '2024-26': { startDate: '2024-01-01' }, 'gold_25-26': { startDate: '2025-01-01' } };
const rows = [];
for (const predictor of ['gao', 'rrod'])
  for (const side of ['both', 'long', 'short'])
    for (const exitM of [M_CLOSE, M_1545])
      for (const [wn, w] of Object.entries(windows))
        rows.push({ label: `${predictor} ${side} exit${exitM === M_CLOSE ? '16:00' : '15:45'} ${wn}`, ...run({ predictor, side, exitM, ...w }) });

console.log(`\n=== ${TICKER} last-30-min momentum ($${PV}/pt) ===`);
console.log('config                          n    PF   Sharpe   pnl$   DD$    WR    H1   H2');
for (const r of rows) {
  console.log(
    r.label.padEnd(30), String(r.n).padStart(4), r.pf.toFixed(2).padStart(6), r.sharpe.toFixed(2).padStart(6),
    String(r.pnl).padStart(7), String(r.mdd).padStart(6), (r.wr * 100).toFixed(1).padStart(5),
    r.h1pf.toFixed(2).padStart(5), r.h2pf.toFixed(2).padStart(5)
  );
}
fs.writeFileSync(path.join(OUT, `last30-${TICKER}.json`), JSON.stringify(rows, null, 2));
