/**
 * Phase 9 — Compare engine output JSONs against gold standard.
 *
 * Inputs:
 *   data/gold-standard/ls-flip-trigger-bar-v2.json (baseline)
 *   research/ls-flip-improve/output/engine-runs/cand*.json (candidates)
 *
 * Outputs a side-by-side table of headline metrics.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

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
  // Use engine's own performance metrics (more accurate than reconstructed)
  const perf = j.performance?.summary || {};
  return {
    name: path.basename(jsonPath, '.json'),
    n: trades.length,
    pnl: perf.totalPnL ?? 0,
    wr: perf.winRate ?? 0,
    pf,
    maxDDpct: perf.maxDrawdown ?? 0,
    sharpe: perf.sharpeRatio ?? 0,
    exits,
  };
}

const paths = [
  path.join(ROOT, 'data/gold-standard/ls-flip-trigger-bar-v2.json'),
  ...fs.readdirSync(path.join(__dirname, 'output/engine-runs'))
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(__dirname, 'output/engine-runs', f)),
];

console.log(`\nVariant                                              | Trades  PnL($)   WR%    PF     Sharpe  MaxDD%`);
console.log(`-----------------------------------------------------+--------+--------+------+------+-------+-------`);
for (const p of paths) {
  if (!fs.existsSync(p)) continue;
  const s = summarize(p);
  console.log(`${s.name.padEnd(52)} | ${String(s.n).padStart(6)}  ${String(Math.round(s.pnl)).padStart(7)}  ${s.wr.toFixed(1).padStart(4)}  ${s.pf.toFixed(2).padStart(4)}  ${s.sharpe.toFixed(2).padStart(5)}  ${s.maxDDpct.toFixed(2).padStart(5)}%`);
}
console.log('');
for (const p of paths) {
  if (!fs.existsSync(p)) continue;
  const s = summarize(p);
  console.log(`${s.name}: exits = ${Object.entries(s.exits).map(([k,v])=>`${k}:${v}`).join(' ')}`);
}
