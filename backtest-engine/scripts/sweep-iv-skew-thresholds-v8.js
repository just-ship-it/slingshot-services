#!/usr/bin/env node
/**
 * Skew-threshold sweep on the v8 IV CSV (regenerated 2026-05-01 via shared
 * calculator with parity-derived spot, byte-identical to live calculator).
 *
 * Distribution shifted dramatically: bulk near +1.74% (natural ATM put-call
 * structural skew). Both thresholds are now POSITIVE numbers.
 *   - LONG (calls relatively expensive): skew BELOW some threshold (e.g. +1.0%)
 *   - SHORT (puts unusually expensive): skew ABOVE some threshold (e.g. +2.0%)
 *
 * Sanity check at neg=+0.010 / pos=+0.020 → 32 trades, PF 2.83, DD 7.01%,
 * 68.75% WR, $17.6k. PF strong but trade count too low. Sweep aims to find
 * the volume/PF balance.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKTEST_ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(BACKTEST_ROOT, 'data', 'sweep-results', 'iv-skew-thresholds-v8');

const GRID = {
  // Expanded to push trade count toward 1-2/day. Distribution is so concentrated
  // around +0.0174 that small threshold changes have huge volume effects.
  negSkew: [0.014, 0.016, 0.0165, 0.017, 0.0173, 0.0175],
  posSkew: [0.018, 0.019, 0.020, 0.022, 0.025],
};

const FIXED = {
  ticker: 'NQ',
  strategy: 'iv-skew-gex',
  timeframe: '1m',
  start: '2025-01-13',
  end: '2026-04-23',
  ivResolution: '1m',
  gexDir: 'data/gex/nq-cbbo',
  targetPoints: 120,
  stopLossPoints: 80,
  maxHoldBars: 60,
  breakevenTrigger: 60,
  breakevenOffset: 5,
  blockedRegimes: 'strong_negative',
  levelProximity: 100,
};

const DEFAULT_CONCURRENCY = 3;

function enumerateCombos() {
  const combos = [];
  let idx = 0;
  for (const ns of GRID.negSkew) {
    for (const ps of GRID.posSkew) {
      combos.push({ idx: idx++, negSkew: ns, posSkew: ps });
    }
  }
  return combos;
}

function fmtThresh(t) {
  const sign = t < 0 ? 'n' : 'p';
  return sign + Math.round(Math.abs(t) * 10000).toString().padStart(4, '0');
}

function comboKey(c) {
  return `neg${fmtThresh(c.negSkew)}_pos${fmtThresh(c.posSkew)}`;
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
    '--target-points', String(FIXED.targetPoints),
    '--stop-loss-points', String(FIXED.stopLossPoints),
    '--max-hold-bars', String(FIXED.maxHoldBars),
    '--breakeven-stop',
    '--breakeven-trigger', String(FIXED.breakevenTrigger),
    '--breakeven-offset', String(FIXED.breakevenOffset),
    '--blocked-regimes', FIXED.blockedRegimes,
    '--iv-resolution', FIXED.ivResolution,
    '--gex-dir', FIXED.gexDir,
    '--level-proximity', String(FIXED.levelProximity),
    '--neg-skew-threshold', String(combo.negSkew),
    '--pos-skew-threshold', String(combo.posSkew),
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
    negSkew: combo.negSkew,
    posSkew: combo.posSkew,
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
  const skipped = combos.length - todo.length;

  console.log(`\n=== iv-skew-gex skew-threshold sweep (v8 — shared-calc IV) ===`);
  console.log(`Period: ${FIXED.start} → ${FIXED.end}`);
  console.log(`Total combos: ${combos.length}, todo: ${todo.length}, skipped: ${skipped}`);
  console.log(`Concurrency: ${concurrency}\n`);

  if (todo.length === 0) {
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
        const rate = completed / Math.max(0.1, (Date.now() - t0) / 60000);
        const eta = rate > 0 ? (remaining / rate).toFixed(0) : '?';

        const status = result.code === 0 ? 'OK' : `FAIL(${result.code})`;
        const m = extractMetrics(combo);
        const summary = m ? `n=${m.trades} pf=${(m.profitFactor || 0).toFixed(2)} pnl=$${(m.totalPnL || 0).toFixed(0)} dd=${(m.maxDrawdown || 0).toFixed(2)}%` : 'no metrics';
        console.log(
          `[${completed}/${todo.length}] ${comboKey(combo).padEnd(20)} ` +
          `${status.padEnd(8)} ${result.elapsedSec}s  ${summary}  (elapsed ${elapsed}m, eta ${eta}m)`
        );
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

  rows.sort((a, b) => {
    if ((b.profitFactor ?? 0) !== (a.profitFactor ?? 0)) return (b.profitFactor ?? 0) - (a.profitFactor ?? 0);
    if ((b.sharpe ?? 0) !== (a.sharpe ?? 0)) return (b.sharpe ?? 0) - (a.sharpe ?? 0);
    return (b.trades ?? 0) - (a.trades ?? 0);
  });

  const csvPath = path.join(RESULTS_DIR, '_aggregated.csv');
  const header = ['rank', 'negSkew', 'posSkew', 'trades', 'winRate', 'profitFactor', 'sharpe', 'sortino', 'maxDrawdown', 'totalPnL', 'avgWin', 'avgLoss', 'expectancy'];
  const lines = [header.join(',')];
  rows.forEach((r, i) => {
    lines.push([i + 1, r.negSkew, r.posSkew, r.trades, r.winRate, r.profitFactor, r.sharpe, r.sortino, r.maxDrawdown, r.totalPnL, r.avgWin, r.avgLoss, r.expectancy].join(','));
  });
  fs.writeFileSync(csvPath, lines.join('\n'));
  console.log(`\nAggregated results: ${csvPath}`);

  console.log(`\n=== All ${rows.length} combos by PF ===\n`);
  console.log('Rank  negSkew    posSkew   Trades  WR%    PF    Sharpe  MaxDD%   PnL');
  console.log('----  ---------  --------  ------  -----  ----  ------  -------  ----------');
  rows.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(4)}  ` +
      `${r.negSkew.toFixed(4).padStart(9)}  ` +
      `${r.posSkew.toFixed(4).padStart(8)}  ` +
      `${String(r.trades).padStart(6)}  ` +
      `${(r.winRate || 0).toFixed(1).padStart(5)}  ` +
      `${(r.profitFactor || 0).toFixed(2).padStart(4)}  ` +
      `${(r.sharpe || 0).toFixed(2).padStart(6)}  ` +
      `${(r.maxDrawdown || 0).toFixed(2).padStart(7)}  ` +
      `$${(r.totalPnL || 0).toFixed(0).padStart(9)}`
    );
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
