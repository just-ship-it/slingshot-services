/**
 * Phase 7 — Side-by-side comparison of engine validation runs.
 *
 * Loads each preset JSON from data/gold-standard/, computes PnL/WR/PF/Sharpe/
 * MaxDD and prints a table.
 */
import fs from 'fs';
import path from 'path';

const GOLD_DIR = path.resolve('data/gold-standard');
const candidates = [
  ['gex-flip-ivpct-tight-s60t200be70.json', 'gold (tight-stop)'],
  ['gex-flip-ivpct-v2.json',                'v2 (recommended)'],
  ['gex-flip-ivpct-v2-max.json',            'v2-max'],
  ['gex-flip-ivpct-v2-low-dd.json',         'v2-low-dd'],
];

function ddFromTrades(trades) {
  const eq = [];
  let c = 0;
  for (const t of trades) {
    if (t.status !== 'completed') continue;
    c += t.netPnL || 0;
    eq.push(c);
  }
  let peak = -Infinity, dd = 0;
  for (const v of eq) { if (v > peak) peak = v; if (peak - v > dd) dd = peak - v; }
  return dd;
}

function compute(t) {
  const trades = t.filter(x => x.status === 'completed');
  let pnl = 0, wins = 0, losses = 0, sumW = 0, sumL = 0, worst = 0;
  for (const tr of trades) {
    const d = tr.netPnL || 0;
    pnl += d;
    if (d > 0) { wins++; sumW += d; }
    else if (d < 0) { losses++; sumL += d; if (d < worst) worst = d; }
  }
  const n = trades.length;
  const wr = (wins + losses) ? wins / (wins + losses) * 100 : 0;
  const pf = sumL !== 0 ? Math.abs(sumW / sumL) : Infinity;
  const dd = ddFromTrades(trades);
  const mean = n ? pnl / n : 0;
  let varSum = 0;
  for (const tr of trades) varSum += ((tr.netPnL || 0) - mean) ** 2;
  const sd = n ? Math.sqrt(varSum / n) : 0;
  const tradesPerYearDenom = 16 / 12;
  const tradesPerYear = n / tradesPerYearDenom;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(tradesPerYear) : 0;
  return { n, pnl, wr, pf, sharpe, dd, worst };
}

console.log('Variant            | n   PnL ($)   WR %  PF     Sharpe  MaxDD ($)  WorstLoss');
console.log('-------------------+----+---------+-----+------+-------+----------+----------');
for (const [fname, label] of candidates) {
  const fp = path.join(GOLD_DIR, fname);
  if (!fs.existsSync(fp)) {
    console.log(`${label.padEnd(18)} | (no file: ${fname})`);
    continue;
  }
  const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  const trades = j.trades || j;
  const s = compute(trades);
  console.log(`${label.padEnd(18)} | ${String(s.n).padStart(3)} ${s.pnl.toFixed(0).padStart(8)}  ${s.wr.toFixed(1).padStart(4)} ${s.pf.toFixed(2).padStart(5)}  ${s.sharpe.toFixed(2).padStart(5)}  ${s.dd.toFixed(0).padStart(8)}  ${s.worst.toFixed(0).padStart(8)}`);
}
