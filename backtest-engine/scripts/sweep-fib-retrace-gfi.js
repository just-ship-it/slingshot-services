#!/usr/bin/env node
/**
 * Fib-retrace exit sweep for gex-flip-ivpct.
 *
 *   retracePct ∈ {0.50, 0.618, 0.706, 0.786, 0.886}
 *   activationMFE ∈ {30, 40, 50, 70}
 *   = 20 configs
 *
 * Same engine-flag harness as sweep-mfe-ratchet-gfi.js: 5m timeframe, raw
 * contracts, 1m IV, 16:40 EOD, SL=60/TP=200, no BE (fib REPLACES BE).
 *
 * Honors max-2-parallel rule (per memory/feedback_max_2_backtests_parallel.md).
 *
 * Run from backtest-engine/ root:
 *   node scripts/sweep-fib-retrace-gfi.js
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'research', 'mfe-ratchet-gfi');
const RUN_DIR = path.join(OUT_DIR, 'runs');
fs.mkdirSync(RUN_DIR, { recursive: true });

const START = '2025-01-13';
const END = '2026-04-20';
const MAX_PARALLEL = 2;

const BASE_FLAGS = [
  '--ticker', 'NQ',
  '--strategy', 'gex-flip-ivpct',
  '--timeframe', '5m',
  '--raw-contracts',
  '--start', START,
  '--end', END,
  '--iv-resolution', '1m',
  '--eod-cutoff-et', '16:40',
  '--gfi-stop-pts', '60',
  '--gfi-target-pts', '200',
  '--gfi-blocked-hours', '6,7,8',
  '--quiet',
];

const RETRACE_PCTS = [0.50, 0.618, 0.706, 0.786, 0.886];
const ACTIVATION_MFES = [30, 40, 50, 70];

const configs = [];
for (const rp of RETRACE_PCTS) {
  for (const am of ACTIVATION_MFES) {
    const rpId = `r${Math.round(rp * 1000)}`;     // r500, r618, r706, r786, r886
    const amId = `a${am}`;
    configs.push({
      id: `fib-${rpId}-${amId}`,
      retracePct: rp,
      activationMFE: am,
    });
  }
}

function runOne(cfg) {
  return new Promise((resolve) => {
    const jsonPath = path.join(RUN_DIR, `${cfg.id}.json`);
    const logPath = path.join(RUN_DIR, `${cfg.id}.log`);

    if (fs.existsSync(jsonPath)) {
      console.log(`[skip ${cfg.id}] cached`);
      return resolve({ cfg, jsonPath, skipped: true });
    }

    const flags = [
      ...BASE_FLAGS,
      '--gfi-fib-retrace',
      '--gfi-fib-retrace-pct', String(cfg.retracePct),
      '--gfi-fib-activation-mfe', String(cfg.activationMFE),
      '--output-json', jsonPath,
    ];

    const started = Date.now();
    console.log(`[start ${cfg.id}] retracePct=${cfg.retracePct} activationMFE=${cfg.activationMFE}`);
    const child = spawn('node', ['index.js', ...flags], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const logStream = fs.createWriteStream(logPath);
    child.stdout.on('data', (c) => logStream.write(c));
    child.stderr.on('data', (c) => logStream.write(c));

    child.on('close', (code) => {
      logStream.end();
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      if (code === 0 && fs.existsSync(jsonPath)) {
        console.log(`[done  ${cfg.id}] ${elapsed}s`);
        resolve({ cfg, jsonPath, ok: true, elapsed });
      } else {
        console.log(`[FAIL  ${cfg.id}] exit=${code} elapsed=${elapsed}s`);
        resolve({ cfg, jsonPath, ok: false, exitCode: code, elapsed });
      }
    });
  });
}

async function runBatches(items, batchSize) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(runOne));
  }
}

function extractMetrics(jsonPath, cfg) {
  if (!fs.existsSync(jsonPath)) return { id: cfg.id, ok: false };
  const r = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const b = r.performance?.basic ?? {};
  const risk = r.performance?.risk ?? {};
  const dd = r.performance?.drawdown ?? {};
  const exitCounts = {};
  for (const t of r.trades || []) {
    exitCounts[t.exitReason] = (exitCounts[t.exitReason] || 0) + 1;
  }
  return {
    id: cfg.id,
    retracePct: cfg.retracePct,
    activationMFE: cfg.activationMFE,
    totalTrades: b.totalTrades,
    winRate: b.winRate,
    profitFactor: b.profitFactor,
    sharpeRatio: risk.sharpeRatio,
    maxDrawdownPct: dd.maxDrawdown,
    totalPnL: b.totalPnL,
    avgWin: b.avgWin,
    avgLoss: b.avgLoss,
    largestWin: b.largestWin,
    largestLoss: b.largestLoss,
    avgWinnerMFE: b.avgWinnerMFE,
    avgProfitGiveBack: b.avgProfitGiveBack,
    winnerCaptureRatio: b.winnerCaptureRatio,
    beClipCount: b.beClipCount,
    beClipPct: b.beClipPct,
    bigBeClipCount: b.bigBeClipCount,
    mfeToSLCount: b.mfeToSLCount,
    mfeToSLPct: b.mfeToSLPct,
    totalGivebackPtsWinners: b.totalGivebackPtsWinners,
    givebackDollarsWinners: b.givebackDollarsWinners,
    fibRetraceExits: exitCounts.fib_retrace || 0,
    tpExits: exitCounts.take_profit || 0,
    slExits: exitCounts.stop_loss || 0,
    marketCloseExits: exitCounts.market_close || 0,
    maxHoldExits: exitCounts.max_hold_time || 0,
    ok: true,
  };
}

(async () => {
  const t0 = Date.now();
  console.log(`Sweeping ${configs.length} fib-retrace configs (max ${MAX_PARALLEL} parallel)`);
  await runBatches(configs, MAX_PARALLEL);
  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\nAll ${configs.length} runs completed in ${elapsedMin} min`);

  const rows = configs.map((cfg) => extractMetrics(path.join(RUN_DIR, `${cfg.id}.json`), cfg));

  const summaryJson = path.join(OUT_DIR, 'sweep-fib-summary.json');
  fs.writeFileSync(summaryJson, JSON.stringify(rows, null, 2));
  console.log(`Summary JSON: ${summaryJson}`);

  const headers = [
    'id', 'retracePct', 'activationMFE',
    'totalTrades', 'winRate', 'profitFactor', 'sharpeRatio',
    'maxDrawdownPct', 'totalPnL', 'avgWin', 'avgLoss',
    'largestWin', 'largestLoss',
    'avgWinnerMFE', 'avgProfitGiveBack', 'winnerCaptureRatio',
    'beClipCount', 'beClipPct', 'bigBeClipCount',
    'mfeToSLCount', 'mfeToSLPct',
    'totalGivebackPtsWinners', 'givebackDollarsWinners',
    'fibRetraceExits', 'tpExits', 'slExits', 'marketCloseExits', 'maxHoldExits',
  ];
  const csvLines = [headers.join(',')];
  for (const r of rows) {
    if (!r.ok) {
      csvLines.push(`${r.id},FAILED`);
      continue;
    }
    csvLines.push(headers.map((h) => {
      const v = r[h];
      if (typeof v === 'string' && v.includes(',')) return `"${v}"`;
      return v ?? '';
    }).join(','));
  }
  const csvPath = path.join(OUT_DIR, 'sweep-fib-summary.csv');
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log(`Summary CSV: ${csvPath}`);

  const ranked = rows
    .filter(r => r.ok)
    .sort((a, b) => b.profitFactor - a.profitFactor);
  console.log('\nTop 8 by PF:');
  console.log('id              retr   act  trades   WR%   PF   Sharpe  DD%   PnL$    avgWin  giveback  fibExits');
  for (const r of ranked.slice(0, 8)) {
    console.log(
      `${r.id.padEnd(16)}${String(r.retracePct).padEnd(7)}${String(r.activationMFE).padEnd(5)}` +
      `${String(r.totalTrades).padStart(5)}${String((r.winRate || 0).toFixed(1)).padStart(7)}${String((r.profitFactor || 0).toFixed(2)).padStart(6)}` +
      `${String((r.sharpeRatio || 0).toFixed(2)).padStart(7)}${String((r.maxDrawdownPct || 0).toFixed(2)).padStart(7)}` +
      `${String(r.totalPnL).padStart(8)}${String((r.avgWin || 0).toFixed(0)).padStart(8)}` +
      `${String((r.avgProfitGiveBack || 0).toFixed(1)).padStart(9)}${String(r.fibRetraceExits).padStart(8)}`
    );
  }
})().catch((e) => {
  console.error('Sweep failed:', e);
  process.exit(1);
});
