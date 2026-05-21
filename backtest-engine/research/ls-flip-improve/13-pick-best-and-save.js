/**
 * Phase 13 — Identify the best candidate per metric and save winners as gold standards.
 *
 * Three winners are saved:
 *   - Max-PnL: highest absolute PnL
 *   - Balanced: best Sharpe with PnL >= 1.5× gold
 *   - Low-DD: lowest DD% (Pareto-best on risk-adjusted)
 *
 * Output: data/gold-standard/ls-flip-trigger-bar-v3-{max,balanced,low-dd}.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const RUNS_DIR = path.join(__dirname, 'output', 'engine-runs');
const GOLD_DIR = path.join(ROOT, 'data', 'gold-standard');
const GOLD_BASELINE = path.join(GOLD_DIR, 'ls-flip-trigger-bar-v2.json');
const BASELINE_PNL = 130500;

function summarize(jsonPath) {
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const trades = j.trades.filter(t => t.status === 'completed');
  const exits = {};
  let sumW = 0, sumL = 0;
  for (const t of trades) {
    if (t.netPnL > 0) sumW += t.netPnL;
    else if (t.netPnL < 0) sumL += t.netPnL;
    exits[t.exitReason] = (exits[t.exitReason] || 0) + 1;
  }
  const pf = sumL ? Math.abs(sumW / sumL) : (sumW > 0 ? Infinity : 0);
  const perf = j.performance?.summary || {};
  return {
    name: path.basename(jsonPath, '.json'),
    path: jsonPath,
    n: trades.length,
    pnl: perf.totalPnL ?? 0,
    wr: perf.winRate ?? 0,
    pf,
    maxDDpct: perf.maxDrawdown ?? 0,
    sharpe: perf.sharpeRatio ?? 0,
    exits,
  };
}

const files = fs.readdirSync(RUNS_DIR).filter(f => f.endsWith('.json')).map(f => path.join(RUNS_DIR, f));
const candidates = files.map(summarize);
console.log(`\nAll candidates (${candidates.length}):\n`);
console.log(`Name${' '.repeat(48)} | Trades  PnL($)   WR%    PF     Sharpe  MaxDD%`);
console.log(`-`.repeat(120));
candidates.sort((a, b) => b.pnl - a.pnl);
for (const c of candidates) {
  console.log(`${c.name.padEnd(52)} | ${String(c.n).padStart(6)}  ${String(Math.round(c.pnl)).padStart(7)}  ${c.wr.toFixed(1).padStart(4)}  ${c.pf.toFixed(2).padStart(4)}  ${c.sharpe.toFixed(2).padStart(5)}  ${c.maxDDpct.toFixed(2).padStart(5)}%`);
}

// Best by PnL
const maxPnl = candidates.slice().sort((a, b) => b.pnl - a.pnl)[0];
// Best by Sharpe with PnL >= 1.5 × baseline (= $195,750)
const balanced = candidates.filter(c => c.pnl >= 1.5 * BASELINE_PNL).sort((a, b) => b.sharpe - a.sharpe)[0];
// Lowest DD with PnL >= baseline
const lowDD = candidates.filter(c => c.pnl >= BASELINE_PNL).sort((a, b) => a.maxDDpct - b.maxDDpct)[0];

console.log('\n--- Selected winners ---');
console.log(`Max PnL  : ${maxPnl.name}  $${Math.round(maxPnl.pnl)}  PF=${maxPnl.pf.toFixed(2)}  Sh=${maxPnl.sharpe.toFixed(2)}  DD=${maxPnl.maxDDpct.toFixed(2)}%`);
console.log(`Balanced : ${balanced?.name || '(none)'}  $${Math.round(balanced?.pnl ?? 0)}  PF=${balanced?.pf.toFixed(2)}  Sh=${balanced?.sharpe.toFixed(2)}  DD=${balanced?.maxDDpct.toFixed(2)}%`);
console.log(`Low-DD   : ${lowDD?.name || '(none)'}  $${Math.round(lowDD?.pnl ?? 0)}  PF=${lowDD?.pf.toFixed(2)}  Sh=${lowDD?.sharpe.toFixed(2)}  DD=${lowDD?.maxDDpct.toFixed(2)}%`);

// Save as gold standards if --save flag passed
if (process.argv.includes('--save')) {
  const tag = (s) => path.join(GOLD_DIR, `ls-flip-trigger-bar-v3-${s}.json`);
  if (maxPnl) {
    fs.copyFileSync(maxPnl.path, tag('max'));
    console.log(`\nSaved max-PnL gold: ${tag('max')}`);
  }
  if (balanced) {
    fs.copyFileSync(balanced.path, tag('balanced'));
    console.log(`Saved balanced gold: ${tag('balanced')}`);
  }
  if (lowDD) {
    fs.copyFileSync(lowDD.path, tag('low-dd'));
    console.log(`Saved low-dd gold: ${tag('low-dd')}`);
  }
}
