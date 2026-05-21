/**
 * Phase 9 — final summary table comparing gold + all v3 candidates.
 *
 * Run after engine validation runs complete.
 * Usage: node 09-final-summary.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RUNS_DIR = path.join(__dirname, 'output');
const GOLD_PATH = path.resolve(__dirname, '../../data/gold-standard/gex-lt-3m-crossover.json');

const FILES = {
  'GOLD W12':       GOLD_PATH,
  'v3':             path.join(RUNS_DIR, 'engine-v3.json'),
  'v3-max':         path.join(RUNS_DIR, 'engine-v3-max.json'),
  'v3-balanced':    path.join(RUNS_DIR, 'engine-v3-balanced.json'),
  'v3-low-dd':      path.join(RUNS_DIR, 'engine-v3-low-dd.json'),
};

const SPLIT_TS = new Date('2025-09-01T00:00:00Z').getTime();

function compute(trades) {
  const completed = trades.filter(t => t.status === 'completed');
  let pnl = 0, wins = 0, losses = 0, sumW = 0, sumL = 0;
  const eq = []; let cum = 0;
  for (const t of completed) {
    const d = t.netPnL;
    pnl += d; cum += d; eq.push(cum);
    if (d > 0) { wins++; sumW += d; } else if (d < 0) { losses++; sumL += d; }
  }
  const n = completed.length;
  const wr = (wins + losses) ? wins / (wins + losses) * 100 : 0;
  const pf = sumL !== 0 ? Math.abs(sumW / sumL) : (sumW > 0 ? Infinity : 0);
  let peak = -Infinity, maxDD = 0;
  for (const v of eq) { if (v > peak) peak = v; if (peak - v > maxDD) maxDD = peak - v; }
  const mean = n ? pnl / n : 0;
  let varSum = 0;
  for (const t of completed) varSum += (t.netPnL - mean) ** 2;
  const sd = n ? Math.sqrt(varSum / n) : 0;
  const perT = sd > 0 ? mean / sd : 0;
  const tradesPerYear = n / (16 / 12);
  return { n, pnl, wins, losses, wr, pf, maxDD, sharpe: perT * Math.sqrt(tradesPerYear) };
}

function rowStr(label, s) {
  return `${label.padEnd(15)} ${String(s.n).padStart(5)}  $${s.pnl.toFixed(0).padStart(8)}  ${s.wr.toFixed(0).padStart(2)}%  ${s.pf.toFixed(2).padStart(5)}  ${s.sharpe.toFixed(2).padStart(6)}  $${s.maxDD.toFixed(0).padStart(7)}`;
}

console.log('\n=== Final Engine Validation Summary ===\n');
console.log('Variant            Trades       PnL    WR     PF   Sharpe     MaxDD');
console.log('-'.repeat(75));

for (const [label, p] of Object.entries(FILES)) {
  if (!fs.existsSync(p)) {
    console.log(`${label.padEnd(15)} (missing — engine run not yet complete)`);
    continue;
  }
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const all = compute(d.trades);
    const h1 = compute(d.trades.filter(t => t.entryTime < SPLIT_TS));
    const h2 = compute(d.trades.filter(t => t.entryTime >= SPLIT_TS));
    console.log(rowStr(label, all));
    console.log(rowStr('  H1', h1));
    console.log(rowStr('  H2', h2));
    console.log();
  } catch (e) {
    console.log(`${label.padEnd(15)} (err: ${e.message})`);
  }
}
