/**
 * Phase 8 — compare engine runs for all v3 candidates + gold.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RUNS_DIR = path.join(__dirname, 'output');
const GOLD_PATH = path.resolve(__dirname, '../../data/gold-standard/gex-lt-3m-crossover.json');

const FILES = {
  'GOLD (W12+SCW-PM)': GOLD_PATH,
  'engine-w12': path.join(RUNS_DIR, 'engine-w12.json'),
  'engine-v3-low-dd': path.join(RUNS_DIR, 'engine-v3-low-dd.json'),
  'engine-v3': path.join(RUNS_DIR, 'engine-v3.json'),
  'engine-v3-balanced': path.join(RUNS_DIR, 'engine-v3-balanced.json'),
  'engine-v3-max': path.join(RUNS_DIR, 'engine-v3-max.json'),
};

const fmt = (n) => `$${(n || 0).toFixed(0).padStart(7)}`;

const SPLIT_TS = new Date('2025-09-01T00:00:00Z').getTime();

function statTrade(t) {
  return { net: t.netPnL || 0, exit: t.exitReason, fillTs: t.entryTime, ruleId: t.signal?.ruleId };
}
function compute(trades) {
  const completed = trades.filter(t => t.status === 'completed');
  let pnl = 0, wins = 0, losses = 0, sumW = 0, sumL = 0;
  const eq = []; let cum = 0;
  for (const t of completed) {
    const d = t.netPnL;
    pnl += d; cum += d; eq.push(cum);
    if (d > 0) { wins++; sumW += d; } else if (d < 0) { losses++; sumL += d; }
  }
  const wr = (wins + losses) ? wins / (wins + losses) * 100 : 0;
  const pf = sumL !== 0 ? Math.abs(sumW / sumL) : (sumW > 0 ? Infinity : 0);
  let peak = -Infinity, maxDD = 0;
  for (const v of eq) { if (v > peak) peak = v; if (peak - v > maxDD) maxDD = peak - v; }
  const mean = completed.length ? pnl / completed.length : 0;
  let varSum = 0;
  for (const t of completed) varSum += (t.netPnL - mean) ** 2;
  const sd = completed.length ? Math.sqrt(varSum / completed.length) : 0;
  const perT = sd > 0 ? mean / sd : 0;
  const tradesPerYear = completed.length / (16 / 12);
  return { n: completed.length, pnl, wins, losses, wr, pf, maxDD, sharpe: perT * Math.sqrt(tradesPerYear) };
}

const rows = [];
for (const [label, p] of Object.entries(FILES)) {
  if (!fs.existsSync(p)) {
    rows.push({ label, status: '(missing)' });
    continue;
  }
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const all = compute(d.trades);
    const h1 = compute(d.trades.filter(t => t.entryTime < SPLIT_TS));
    const h2 = compute(d.trades.filter(t => t.entryTime >= SPLIT_TS));
    rows.push({ label, all, h1, h2 });
  } catch (e) {
    rows.push({ label, status: `(err: ${e.message})` });
  }
}

console.log('\n=== Engine validation summary ===\n');
const colW = { label: 25, n: 5, pnl: 9, wr: 5, pf: 6, sh: 6, dd: 9 };
console.log(
  'Variant'.padEnd(colW.label),
  'Phase'.padEnd(5),
  'Trades'.padStart(colW.n),
  'PnL'.padStart(colW.pnl),
  'WR'.padStart(colW.wr),
  'PF'.padStart(colW.pf),
  'Sharpe'.padStart(colW.sh),
  'MaxDD$'.padStart(colW.dd),
);
console.log('-'.repeat(80));
for (const r of rows) {
  if (r.status) { console.log(r.label.padEnd(colW.label), r.status); continue; }
  console.log(
    r.label.padEnd(colW.label), 'ALL  ',
    String(r.all.n).padStart(colW.n),
    fmt(r.all.pnl).padStart(colW.pnl),
    `${r.all.wr.toFixed(0)}%`.padStart(colW.wr),
    r.all.pf.toFixed(2).padStart(colW.pf),
    r.all.sharpe.toFixed(2).padStart(colW.sh),
    fmt(r.all.maxDD).padStart(colW.dd),
  );
  console.log(
    ''.padEnd(colW.label), 'H1   ',
    String(r.h1.n).padStart(colW.n),
    fmt(r.h1.pnl).padStart(colW.pnl),
    `${r.h1.wr.toFixed(0)}%`.padStart(colW.wr),
    r.h1.pf.toFixed(2).padStart(colW.pf),
    r.h1.sharpe.toFixed(2).padStart(colW.sh),
    fmt(r.h1.maxDD).padStart(colW.dd),
  );
  console.log(
    ''.padEnd(colW.label), 'H2   ',
    String(r.h2.n).padStart(colW.n),
    fmt(r.h2.pnl).padStart(colW.pnl),
    `${r.h2.wr.toFixed(0)}%`.padStart(colW.wr),
    r.h2.pf.toFixed(2).padStart(colW.pf),
    r.h2.sharpe.toFixed(2).padStart(colW.sh),
    fmt(r.h2.maxDD).padStart(colW.dd),
  );
  console.log();
}
