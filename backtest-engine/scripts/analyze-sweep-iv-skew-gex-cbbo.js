#!/usr/bin/env node
/**
 * Post-sweep analysis for iv-skew-gex on cbbo GEX.
 *
 * Aggregates all per-combo result JSONs into ranked tables. Writes:
 *   - data/sweep-results/iv-skew-gex-cbbo/_aggregated.csv
 *   - prints multiple top-N tables to stdout (PF, Sharpe, PnL, Sharpe/MaxDD)
 *
 * Use the various rankings together: a single metric rarely tells the whole story.
 * PF and Sharpe weight risk/reward differently; Sharpe/MaxDD highlights consistency.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', 'data', 'sweep-results', 'iv-skew-gex-cbbo');

const BASELINE = {
  trades: 278, pnl: 144021, pf: 2.46, sharpe: 5.55, maxDD: 8.90, winRate: 58.27,
  label: 'CBBO baseline (prox=25, sl=80, tp=120)'
};

function loadAll() {
  const rows = [];
  for (const fname of fs.readdirSync(RESULTS_DIR)) {
    if (!fname.endsWith('.json') || fname === '_aggregated.csv') continue;
    const m = /^prox(\d+)_sl(\d+)_tp(\d+)\.json$/.exec(fname);
    if (!m) continue;
    const [, prox, sl, tp] = m.map(Number);
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, fname), 'utf8')); }
    catch { continue; }
    const perf = r.performance || {};
    const basic = perf.basic || {};
    const risk = perf.risk || {};
    const dd = perf.drawdown || {};
    const sim = r.simulation || {};
    rows.push({
      prox, sl, tp,
      rr: tp / sl,
      signals: sim.totalSignals ?? 0,
      rejected: sim.rejectedSignals ?? 0,
      trades: basic.totalTrades ?? 0,
      winRate: basic.winRate ?? 0,
      pf: basic.profitFactor ?? 0,
      pnl: basic.totalPnL ?? 0,
      sharpe: risk.sharpeRatio ?? 0,
      sortino: risk.sortinoRatio ?? 0,
      maxDD: dd.maxDrawdown ?? 0,
      avgWin: basic.avgWin ?? 0,
      avgLoss: basic.avgLoss ?? 0,
      expectancy: basic.expectancy ?? 0,
    });
  }
  return rows;
}

function fmtRow(r, idx) {
  return (
    `${String(idx).padStart(3)}  ` +
    `${String(r.prox).padStart(4)}  ${String(r.sl).padStart(3)}  ${String(r.tp).padStart(3)}  ` +
    `${r.rr.toFixed(2).padStart(4)}  ` +
    `${String(r.signals).padStart(4)}  ${String(r.trades).padStart(4)}  ` +
    `${r.winRate.toFixed(1).padStart(5)}  ` +
    `${r.pf.toFixed(2).padStart(5)}  ` +
    `${r.sharpe.toFixed(2).padStart(6)}  ` +
    `${r.maxDD.toFixed(2).padStart(6)}%  ` +
    `$${r.pnl.toFixed(0).padStart(7)}`
  );
}

const HEADER =
  'rank  prox   sl   tp   r:r   sig   tr     wr%     pf  sharpe   maxDD%       pnl';

function printSection(label, rows, count = 10) {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`  ${label}`);
  console.log('═'.repeat(78));
  console.log(HEADER);
  console.log('-'.repeat(78));
  rows.slice(0, count).forEach((r, i) => console.log(fmtRow(r, i + 1)));
}

function vsBaseline(r) {
  const pnlDelta = ((r.pnl - BASELINE.pnl) / BASELINE.pnl * 100);
  const pfDelta = ((r.pf - BASELINE.pf) / BASELINE.pf * 100);
  const sharpeDelta = ((r.sharpe - BASELINE.sharpe) / BASELINE.sharpe * 100);
  const ddDelta = (r.maxDD - BASELINE.maxDD);
  return { pnlDelta, pfDelta, sharpeDelta, ddDelta };
}

function main() {
  if (!fs.existsSync(RESULTS_DIR)) {
    console.error(`Results dir not found: ${RESULTS_DIR}`);
    process.exit(1);
  }
  const rows = loadAll();
  console.log(`\n=== iv-skew-gex × cbbo sweep aggregation ===`);
  console.log(`Combos completed: ${rows.length}`);
  console.log(`Baseline: ${BASELINE.label}`);
  console.log(`  PnL $${BASELINE.pnl.toLocaleString()}  PF ${BASELINE.pf}  Sharpe ${BASELINE.sharpe}  MaxDD ${BASELINE.maxDD}%  Trades ${BASELINE.trades}`);

  // CSV
  const csvPath = path.join(RESULTS_DIR, '_aggregated.csv');
  const header = ['prox', 'sl', 'tp', 'rr', 'signals', 'trades', 'winRate', 'pf', 'sharpe', 'maxDD', 'pnl'];
  const csvRows = rows
    .slice()
    .sort((a, b) => b.pf - a.pf)
    .map(r => header.map(k => k === 'rr' ? r.rr.toFixed(2) : r[k]).join(','));
  fs.writeFileSync(csvPath, [header.join(','), ...csvRows].join('\n'));
  console.log(`\nCSV: ${csvPath}`);

  // Filter to "viable" — beats baseline PnL with bounded drawdown
  const viable = rows.filter(r => r.pnl > BASELINE.pnl && r.maxDD < 12.0);
  const dominates = rows.filter(r =>
    r.pnl > BASELINE.pnl && r.pf > BASELINE.pf && r.sharpe > BASELINE.sharpe && r.maxDD < BASELINE.maxDD
  );

  console.log(`\nCombos beating baseline PnL (Max DD < 12%): ${viable.length} of ${rows.length}`);
  console.log(`Combos DOMINATING baseline (better PnL, PF, Sharpe, AND MaxDD): ${dominates.length}`);

  // Top by PF (Max DD < 10%)
  const byPF = rows.filter(r => r.maxDD < 10).sort((a, b) => b.pf - a.pf);
  printSection('TOP 15 by PF (filtered Max DD < 10%)', byPF, 15);

  // Top by Sharpe (Max DD < 10%)
  const bySharpe = rows.filter(r => r.maxDD < 10).sort((a, b) => b.sharpe - a.sharpe);
  printSection('TOP 15 by Sharpe (filtered Max DD < 10%)', bySharpe, 15);

  // Top by PnL (Max DD < 10%)
  const byPnL = rows.filter(r => r.maxDD < 10).sort((a, b) => b.pnl - a.pnl);
  printSection('TOP 15 by PnL (filtered Max DD < 10%)', byPnL, 15);

  // Top by Sharpe / Max DD ratio
  const byRiskAdj = rows.filter(r => r.maxDD > 0).sort((a, b) => (b.sharpe / b.maxDD) - (a.sharpe / a.maxDD));
  printSection('TOP 15 by Sharpe/MaxDD (consistency)', byRiskAdj, 15);

  // Domination set
  if (dominates.length > 0) {
    const sorted = dominates.slice().sort((a, b) => b.pnl - a.pnl);
    printSection('FULL DOMINATION (better PnL+PF+Sharpe+MaxDD than baseline)', sorted, sorted.length);
  }

  // Per-proximity best
  console.log(`\n${'═'.repeat(78)}`);
  console.log('  BEST PER PROXIMITY (top by PF)');
  console.log('═'.repeat(78));
  console.log(HEADER);
  const byProx = {};
  for (const r of rows) {
    if (!byProx[r.prox] || byProx[r.prox].pf < r.pf) byProx[r.prox] = r;
  }
  Object.values(byProx).sort((a, b) => a.prox - b.prox).forEach((r, i) => console.log(fmtRow(r, i + 1)));

  // Signal count by proximity (interesting in itself)
  console.log(`\n${'═'.repeat(78)}`);
  console.log('  SIGNAL COUNT × PROXIMITY (median across sl/tp combos)');
  console.log('═'.repeat(78));
  const proxBuckets = {};
  for (const r of rows) {
    if (!proxBuckets[r.prox]) proxBuckets[r.prox] = [];
    proxBuckets[r.prox].push(r.signals);
  }
  console.log('  prox   median_signals   max_signals');
  Object.keys(proxBuckets).map(Number).sort((a, b) => a - b).forEach(p => {
    const sigs = proxBuckets[p].slice().sort((a, b) => a - b);
    const med = sigs[Math.floor(sigs.length / 2)];
    const mx = sigs[sigs.length - 1];
    console.log(`  ${String(p).padStart(4)}   ${String(med).padStart(14)}   ${String(mx).padStart(11)}`);
  });
}

main();
