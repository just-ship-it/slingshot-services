#!/usr/bin/env node
/**
 * Comprehensive parameter sweep for iv-skew-gex strategy on cbbo-derived GEX.
 *
 * Drives the standard `node index.js` CLI per combination, writes one results
 * JSON per combo, and aggregates into a single ranked CSV at the end.
 *
 * Why the CLI route: simpler than reaching into the engine internals; the
 * 9-min per-backtest cost is acceptable given a 10-12 hour budget and the
 * single-data-load optimization isn't worth the complexity for one sweep.
 *
 * Resumable: skips any combo whose result JSON already exists.
 *
 * Usage:
 *   node scripts/sweep-iv-skew-gex-cbbo.js
 *   node scripts/sweep-iv-skew-gex-cbbo.js --concurrency 2 --resume
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKTEST_ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(BACKTEST_ROOT, 'data', 'sweep-results', 'iv-skew-gex-cbbo');

// ─── Sweep grid ─────────────────────────────────────────────────────
// Total: 6 × 4 × 5 = 120 combos. maxHold and TB rules held at gold-standard values.
const GRID = {
  levelProximity: [25, 50, 100, 150, 200, 250],   // 6 — distance from GEX wall
  stopLossPoints: [60, 80, 120, 160],              // 4
  takeProfitPoints: [100, 150, 200, 250, 300],     // 5
};

const FIXED = {
  ticker: 'NQ',
  strategy: 'iv-skew-gex',
  timeframe: '1m',
  start: '2025-01-13',
  end: '2026-04-23',
  ivResolution: '1m',
  gexDir: 'data/gex/nq-cbbo',
  maxHoldBars: 60,
  tbRule1: '15,50,breakeven',
  tbRule2: '40,50,trail:10',
};

const DEFAULT_CONCURRENCY = 2;

// ─── Combo enumeration ──────────────────────────────────────────────

function enumerateCombos() {
  const combos = [];
  let idx = 0;
  for (const lp of GRID.levelProximity) {
    for (const sl of GRID.stopLossPoints) {
      for (const tp of GRID.takeProfitPoints) {
        combos.push({
          idx: idx++,
          levelProximity: lp,
          stopLossPoints: sl,
          takeProfitPoints: tp,
        });
      }
    }
  }
  return combos;
}

function comboKey(c) {
  return `prox${c.levelProximity}_sl${c.stopLossPoints}_tp${c.takeProfitPoints}`;
}

function comboResultPath(c) {
  return path.join(RESULTS_DIR, `${comboKey(c)}.json`);
}

// ─── Backtest runner ────────────────────────────────────────────────

function buildArgs(combo) {
  return [
    'index.js',
    '--ticker', FIXED.ticker,
    '--strategy', FIXED.strategy,
    '--timeframe', FIXED.timeframe,
    '--raw-contracts',
    '--start', FIXED.start,
    '--end', FIXED.end,
    '--target-points', String(combo.takeProfitPoints),
    '--stop-loss-points', String(combo.stopLossPoints),
    '--max-hold-bars', String(FIXED.maxHoldBars),
    '--time-based-trailing',
    '--tb-rule-1', FIXED.tbRule1,
    '--tb-rule-2', FIXED.tbRule2,
    '--iv-resolution', FIXED.ivResolution,
    '--gex-dir', FIXED.gexDir,
    '--level-proximity', String(combo.levelProximity),
    '--output-json', comboResultPath(combo),
  ];
}

function runCombo(combo) {
  return new Promise((resolve) => {
    const args = buildArgs(combo);
    const t0 = Date.now();
    const child = spawn('node', args, {
      cwd: BACKTEST_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(0);
      resolve({ combo, code, elapsedSec, stderr });
    });
  });
}

// ─── Result extraction ──────────────────────────────────────────────

function extractMetrics(combo) {
  const p = comboResultPath(combo);
  if (!fs.existsSync(p)) return null;
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));

  // Schema: performance is split into summary/basic/returns/risk/drawdown/advanced.
  const perf = r.performance || {};
  const basic = perf.basic || {};
  const risk = perf.risk || {};
  const dd = perf.drawdown || {};
  const summary = perf.summary || {};

  return {
    levelProximity: combo.levelProximity,
    stopLossPoints: combo.stopLossPoints,
    takeProfitPoints: combo.takeProfitPoints,
    rrRatio: (combo.takeProfitPoints / combo.stopLossPoints).toFixed(2),
    trades: basic.totalTrades ?? summary.totalTrades ?? 0,
    winRate: basic.winRate ?? summary.winRate ?? 0,
    profitFactor: basic.profitFactor ?? 0,
    sharpe: risk.sharpeRatio ?? summary.sharpeRatio ?? 0,
    sortino: risk.sortinoRatio ?? 0,
    maxDrawdown: dd.maxDrawdown ?? summary.maxDrawdown ?? 0,
    totalPnL: basic.totalPnL ?? summary.totalPnL ?? 0,
    avgWin: basic.avgWin ?? 0,
    avgLoss: basic.avgLoss ?? 0,
    expectancy: basic.expectancy ?? 0,
  };
}

// ─── Driver ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const concurrency = parseInt(args[args.indexOf('--concurrency') + 1]) || DEFAULT_CONCURRENCY;

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const combos = enumerateCombos();
  const total = combos.length;

  // Resume: skip already-done combos
  const todo = combos.filter((c) => !fs.existsSync(comboResultPath(c)));
  const skipped = total - todo.length;

  console.log(`\n=== iv-skew-gex parameter sweep (cbbo GEX) ===`);
  console.log(`Period: ${FIXED.start} → ${FIXED.end}`);
  console.log(`GEX dir: ${FIXED.gexDir}`);
  console.log(`Total combos: ${total}`);
  console.log(`Already completed (resume): ${skipped}`);
  console.log(`To run: ${todo.length}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Results dir: ${RESULTS_DIR}\n`);

  if (todo.length === 0) {
    console.log('Nothing to do.');
    aggregate(combos);
    return;
  }

  let nextIdx = 0;
  let completed = 0;
  const t0 = Date.now();

  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (true) {
        const myIdx = nextIdx++;
        if (myIdx >= todo.length) return;
        const combo = todo[myIdx];

        const result = await runCombo(combo);
        completed++;

        const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
        const remaining = todo.length - completed;
        const ratePerMin = completed / Math.max(0.1, (Date.now() - t0) / 60000);
        const etaMin = ratePerMin > 0 ? (remaining / ratePerMin).toFixed(0) : '?';

        const status = result.code === 0 ? 'OK' : `FAIL(${result.code})`;
        console.log(
          `[${completed}/${todo.length}] ${comboKey(combo).padEnd(28)} ` +
          `${status.padEnd(10)} ${result.elapsedSec}s  ` +
          `(elapsed ${elapsed}m, eta ${etaMin}m)`
        );
        if (result.code !== 0) {
          console.log(`    stderr tail: ${result.stderr.slice(-300)}`);
        }
      }
    })());
  }

  await Promise.all(workers);

  console.log(`\nAll combos run in ${((Date.now() - t0) / 60000).toFixed(1)} min.`);
  aggregate(combos);
}

function aggregate(combos) {
  const rows = combos.map(extractMetrics).filter(Boolean);
  if (rows.length === 0) {
    console.log('\nNo result files to aggregate.');
    return;
  }

  // Sort by PF descending; secondary by Sharpe; tertiary by trades
  rows.sort((a, b) => {
    if ((b.profitFactor ?? 0) !== (a.profitFactor ?? 0)) return (b.profitFactor ?? 0) - (a.profitFactor ?? 0);
    if ((b.sharpe ?? 0) !== (a.sharpe ?? 0)) return (b.sharpe ?? 0) - (a.sharpe ?? 0);
    return (b.trades ?? 0) - (a.trades ?? 0);
  });

  const csvPath = path.join(RESULTS_DIR, '_aggregated.csv');
  const header = [
    'rank', 'levelProximity', 'stopLossPoints', 'takeProfitPoints', 'rrRatio',
    'trades', 'winRate', 'profitFactor', 'sharpe', 'sortino',
    'maxDrawdown', 'totalPnL', 'avgWin', 'avgLoss',
  ];
  const lines = [header.join(',')];
  rows.forEach((r, i) => {
    lines.push([
      i + 1,
      r.levelProximity, r.stopLossPoints, r.takeProfitPoints, r.rrRatio,
      r.trades, r.winRate, r.profitFactor, r.sharpe, r.sortino,
      r.maxDrawdown, r.totalPnL, r.avgWin, r.avgLoss,
    ].join(','));
  });
  fs.writeFileSync(csvPath, lines.join('\n'));
  console.log(`\nAggregated results: ${csvPath}`);

  // Print top 10
  console.log(`\n=== Top 10 by PF (Max DD < 10% filter) ===\n`);
  const filtered = rows.filter((r) => (r.maxDrawdown ?? 1) < 0.10);
  console.log('Rank  Prox  SL   TP   R:R   Trades  WR%    PF    Sharpe  MaxDD%   PnL');
  console.log('----  ----  ---  ---  ----  ------  -----  ----  ------  -------  --------');
  filtered.slice(0, 10).forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(4)}  ` +
      `${String(r.levelProximity).padStart(4)}  ` +
      `${String(r.stopLossPoints).padStart(3)}  ` +
      `${String(r.takeProfitPoints).padStart(3)}  ` +
      `${r.rrRatio.padStart(4)}  ` +
      `${String(r.trades).padStart(6)}  ` +
      `${(r.winRate * 100).toFixed(1).padStart(5)}  ` +
      `${(r.profitFactor ?? 0).toFixed(2).padStart(4)}  ` +
      `${(r.sharpe ?? 0).toFixed(2).padStart(6)}  ` +
      `${((r.maxDrawdown ?? 0) * 100).toFixed(2).padStart(7)}  ` +
      `$${(r.totalPnL ?? 0).toFixed(0).padStart(7)}`
    );
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
