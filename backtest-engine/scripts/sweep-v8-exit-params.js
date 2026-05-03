#!/usr/bin/env node
/**
 * Exit-parameter sweep against v8 balanced skew thresholds
 * (neg=+0.0165 / pos=+0.0250). Holds skew thresholds + breakeven config
 * fixed; varies target-points and stop-loss-points.
 *
 * Current v8 baseline: TP=120 / SL=80 → PF 1.90, DD 7.14%, $113k.
 * Looking for whether tighter or wider exits give better risk-adjusted PF.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKTEST_ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(BACKTEST_ROOT, 'data', 'sweep-results', 'iv-skew-thresholds-v8-exits');

const GRID = {
  targetPoints: [100, 120, 150, 200],
  stopLossPoints: [60, 80, 100],
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
  breakevenTrigger: 60,
  breakevenOffset: 5,
  blockedRegimes: 'strong_negative',
  levelProximity: 100,
  negSkewThreshold: 0.0165,
  posSkewThreshold: 0.0250,
};

const DEFAULT_CONCURRENCY = 3;

function enumerateCombos() {
  const combos = [];
  let idx = 0;
  for (const tp of GRID.targetPoints) {
    for (const sl of GRID.stopLossPoints) {
      combos.push({ idx: idx++, targetPoints: tp, stopLossPoints: sl });
    }
  }
  return combos;
}

function comboKey(c) {
  return `tp${c.targetPoints}_sl${c.stopLossPoints}`;
}

function comboResultPath(c) {
  return path.join(RESULTS_DIR, `${comboKey(c)}.json`);
}

function buildArgs(combo) {
  return [
    'index.js',
    '--ticker', FIXED.ticker,
    '--strategy', FIXED.strategy,
    '--timeframe', FIXED.timeframe,
    '--raw-contracts',
    '--start', FIXED.start,
    '--end', FIXED.end,
    '--target-points', String(combo.targetPoints),
    '--stop-loss-points', String(combo.stopLossPoints),
    '--max-hold-bars', String(FIXED.maxHoldBars),
    '--breakeven-stop',
    '--breakeven-trigger', String(FIXED.breakevenTrigger),
    '--breakeven-offset', String(FIXED.breakevenOffset),
    '--blocked-regimes', FIXED.blockedRegimes,
    '--iv-resolution', FIXED.ivResolution,
    '--gex-dir', FIXED.gexDir,
    '--level-proximity', String(FIXED.levelProximity),
    '--neg-skew-threshold', String(FIXED.negSkewThreshold),
    '--pos-skew-threshold', String(FIXED.posSkewThreshold),
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

function extractMetrics(combo) {
  const p = comboResultPath(combo);
  if (!fs.existsSync(p)) return null;
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  const perf = r.performance || {};
  const basic = perf.basic || {};
  const risk = perf.risk || {};
  const dd = perf.drawdown || {};
  const summary = perf.summary || {};
  return {
    targetPoints: combo.targetPoints,
    stopLossPoints: combo.stopLossPoints,
    rrRatio: (combo.targetPoints / combo.stopLossPoints).toFixed(2),
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

async function main() {
  const args = process.argv.slice(2);
  const concurrency = parseInt(args[args.indexOf('--concurrency') + 1]) || DEFAULT_CONCURRENCY;

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const combos = enumerateCombos();
  const todo = combos.filter((c) => !fs.existsSync(comboResultPath(c)));
  console.log(`\n=== v8 exit-param sweep ===`);
  console.log(`Holding skew=neg+0.0165/pos+0.0250, BE 60+5, regime block`);
  console.log(`Grid: TP × SL = ${combos.length} combos, todo=${todo.length}\n`);

  if (todo.length === 0) { aggregate(combos); return; }

  let nextIdx = 0, completed = 0;
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
        const rate = completed / Math.max(0.1, (Date.now() - t0) / 60000);
        const eta = rate > 0 ? (remaining / rate).toFixed(0) : '?';
        const status = result.code === 0 ? 'OK' : `FAIL(${result.code})`;
        const m = extractMetrics(combo);
        const summary = m ? `n=${m.trades} pf=${(m.profitFactor || 0).toFixed(2)} pnl=$${(m.totalPnL || 0).toFixed(0)} dd=${(m.maxDrawdown || 0).toFixed(2)}%` : 'no metrics';
        console.log(`[${completed}/${todo.length}] ${comboKey(combo).padEnd(14)} ${status.padEnd(8)} ${result.elapsedSec}s  ${summary}  (elapsed ${elapsed}m, eta ${eta}m)`);
      }
    })());
  }

  await Promise.all(workers);
  console.log(`\nAll combos run in ${((Date.now() - t0) / 60000).toFixed(1)} min.`);
  aggregate(combos);
}

function aggregate(combos) {
  const rows = combos.map(extractMetrics).filter(Boolean);
  if (rows.length === 0) return;
  rows.sort((a, b) => (b.profitFactor || 0) - (a.profitFactor || 0));

  const csvPath = path.join(RESULTS_DIR, '_aggregated.csv');
  const header = ['rank', 'targetPoints', 'stopLossPoints', 'rrRatio', 'trades', 'winRate', 'profitFactor', 'sharpe', 'sortino', 'maxDrawdown', 'totalPnL', 'avgWin', 'avgLoss', 'expectancy'];
  const lines = [header.join(',')];
  rows.forEach((r, i) => lines.push([i + 1, r.targetPoints, r.stopLossPoints, r.rrRatio, r.trades, r.winRate, r.profitFactor, r.sharpe, r.sortino, r.maxDrawdown, r.totalPnL, r.avgWin, r.avgLoss, r.expectancy].join(',')));
  fs.writeFileSync(csvPath, lines.join('\n'));
  console.log(`\nAggregated: ${csvPath}\n`);

  console.log('Rank  TP   SL   R:R    Trades  WR%    PF    Sharpe  MaxDD%   PnL');
  console.log('----  ---  ---  -----  ------  -----  ----  ------  -------  ----------');
  rows.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(4)}  ${String(r.targetPoints).padStart(3)}  ${String(r.stopLossPoints).padStart(3)}  ` +
      `${r.rrRatio.padStart(5)}  ${String(r.trades).padStart(6)}  ` +
      `${(r.winRate || 0).toFixed(1).padStart(5)}  ${(r.profitFactor || 0).toFixed(2).padStart(4)}  ` +
      `${(r.sharpe || 0).toFixed(2).padStart(6)}  ${(r.maxDrawdown || 0).toFixed(2).padStart(7)}  ` +
      `$${(r.totalPnL || 0).toFixed(0).padStart(9)}`
    );
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
