#!/usr/bin/env node
/**
 * Univariate analysis on the per-trade option-chain evolution table.
 *
 * For each numeric feature: split trades into terciles, report P(win),
 * mean PnL pts, and sample size. Sort by absolute P(win) spread.
 *
 * Usage:
 *   node research/option-chain-univariate.js
 *   node research/option-chain-univariate.js --max-hold-only   (only max_hold_time exits — the stalled-trade slice)
 *
 * Reads:
 *   research/output/option-chain-evolution-trades.csv
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.join(__dirname, 'output/option-chain-evolution-trades.csv');

const args = process.argv.slice(2);
const MAX_HOLD_ONLY = args.includes('--max-hold-only');

const lines = fs.readFileSync(CSV_PATH, 'utf8').trim().split('\n');
const headers = lines[0].split(',');
const rows = lines.slice(1).map((l) => {
  const cols = l.split(',');
  const r = {};
  for (let i = 0; i < headers.length; i++) {
    const v = cols[i];
    const n = parseFloat(v);
    r[headers[i]] = (v === '' || isNaN(n)) ? v : n;
  }
  return r;
});

let trades = rows;
if (MAX_HOLD_ONLY) {
  trades = trades.filter((r) => r.exitReason === 'max_hold_time');
  console.log(`Filtered to ${trades.length} max_hold_time trades`);
}
console.log(`Total trades: ${trades.length}`);
console.log(`Overall win rate: ${(trades.filter((t) => t.won === 1).length / trades.length * 100).toFixed(1)}%`);
console.log();

const FEATURES = [
  // Entry state
  'entry_gamma_flip_dist_raw',
  'entry_in_dir_wall_dist',
  'entry_opp_wall_dist',
  'entry_in_dir_wall_strength',
  'entry_opp_wall_strength',
  'entry_total_gex',
  'entry_gamma_imbalance',
  'entry_iv',
  'entry_skew',
  // Mid-trade evolution
  'snapshots_during_trade',
  'gamma_flip_drift_raw',
  'gamma_flip_drift_signed_dir',
  'in_dir_wall_strength_pct_change',
  'opp_wall_strength_pct_change',
  'in_dir_wall_move_raw',
  'opp_wall_move_raw',
  'total_gex_change_pct',
  'gamma_imbalance_change',
  'iv_change',
  'skew_change',
];

function tercileEdges(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return [sorted[Math.floor(n / 3)], sorted[Math.floor(2 * n / 3)]];
}

function bucket(v, [e1, e2]) {
  if (v <= e1) return 0; // low
  if (v <= e2) return 1; // mid
  return 2;              // high
}

const results = [];
for (const f of FEATURES) {
  const valid = trades.filter((t) => typeof t[f] === 'number' && isFinite(t[f]));
  if (valid.length < 30) continue;
  const values = valid.map((t) => t[f]);
  const edges = tercileEdges(values);
  const buckets = [[], [], []];
  for (const t of valid) buckets[bucket(t[f], edges)].push(t);

  const stats = buckets.map((bk) => ({
    n: bk.length,
    wr: bk.length ? bk.filter((t) => t.won === 1).length / bk.length : null,
    avgPnl: bk.length ? bk.reduce((a, t) => a + (typeof t.pnl_pts === 'number' ? t.pnl_pts : 0), 0) / bk.length : null,
  }));

  const wrs = stats.map((s) => s.wr).filter((v) => v != null);
  const wrSpread = Math.max(...wrs) - Math.min(...wrs);

  results.push({ feature: f, edges, stats, wrSpread, valid: valid.length });
}

results.sort((a, b) => b.wrSpread - a.wrSpread);

console.log(`${'feature'.padEnd(38)}${'tercile-edges'.padStart(28)}  | ${'low (n,wr,pnl)'.padEnd(22)}| ${'mid (n,wr,pnl)'.padEnd(22)}| ${'high (n,wr,pnl)'.padEnd(22)}| spread`);
console.log('-'.repeat(160));
for (const r of results) {
  const e = `[${r.edges[0].toFixed(2)}, ${r.edges[1].toFixed(2)}]`;
  const fmtBucket = (s) => `${String(s.n).padStart(3)}/${(s.wr * 100).toFixed(1).padStart(5)}%/${(s.avgPnl >= 0 ? '+' : '') + s.avgPnl.toFixed(0)}`.padEnd(22);
  const sp = `${(r.wrSpread * 100).toFixed(1)}pp`;
  console.log(`${r.feature.padEnd(38)}${e.padStart(28)}  | ${fmtBucket(r.stats[0])}| ${fmtBucket(r.stats[1])}| ${fmtBucket(r.stats[2])}| ${sp}`);
}

// Categorical features
console.log();
console.log('Categorical features:');
const catFeatures = ['side', 'levelType', 'exitReason', 'entry_regime', 'exit_regime', 'regime_changed'];
for (const f of catFeatures) {
  const groups = new Map();
  for (const t of trades) {
    const v = String(t[f]);
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(t);
  }
  const sortedKeys = [...groups.keys()].sort();
  console.log(`\n  ${f}:`);
  for (const k of sortedKeys) {
    const bk = groups.get(k);
    if (bk.length < 10) continue;
    const wr = bk.filter((t) => t.won === 1).length / bk.length;
    const pnl = bk.reduce((a, t) => a + (typeof t.pnl_pts === 'number' ? t.pnl_pts : 0), 0) / bk.length;
    console.log(`    ${String(k).padEnd(20)} n=${String(bk.length).padStart(4)}  WR=${(wr * 100).toFixed(1)}%  avgPnL=${(pnl >= 0 ? '+' : '') + pnl.toFixed(1)}pt`);
  }
}
