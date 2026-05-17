#!/usr/bin/env node
/**
 * Two combined sweeps for gex-flip-ivpct:
 *
 *   (#1) Fine-grid around fib-r618-a40 sweet spot:
 *        retracePct ∈ {0.55, 0.58, 0.618, 0.65, 0.68} × activationMFE ∈ {35, 40, 45, 50}
 *        (fib-r618-a40 is already in the cache, will skip)
 *
 *   (#3) Two-layer BE + fib: fib 0.618/40 plus BE at various trigger/offset:
 *        BE 80/+10, BE 100/+15, BE 120/+20
 *
 * Run from backtest-engine/ root:
 *   node scripts/sweep-fib-fine-and-two-layer.js
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

const configs = [];

// (#1) Fine grid
for (const rp of [0.55, 0.58, 0.618, 0.65, 0.68]) {
  for (const am of [35, 40, 45, 50]) {
    const id = `fib-r${Math.round(rp * 1000)}-a${am}`;
    configs.push({
      id, type: 'fine',
      flags: [
        '--gfi-fib-retrace',
        '--gfi-fib-retrace-pct', String(rp),
        '--gfi-fib-activation-mfe', String(am),
      ],
      retracePct: rp, activationMFE: am,
    });
  }
}

// (#3) Two-layer BE + fib (using best balanced fib config 0.618/40)
const FIB_RP = 0.618;
const FIB_AM = 40;
for (const [trigger, offset] of [[80, 10], [100, 15], [120, 20]]) {
  configs.push({
    id: `twolayer-be${trigger}p${offset}-fib618-a40`,
    type: 'twolayer',
    flags: [
      '--gfi-breakeven-stop',
      '--gfi-breakeven-trigger', String(trigger),
      '--gfi-breakeven-offset', String(offset),
      '--gfi-fib-retrace',
      '--gfi-fib-retrace-pct', String(FIB_RP),
      '--gfi-fib-activation-mfe', String(FIB_AM),
    ],
    beTrigger: trigger, beOffset: offset,
    retracePct: FIB_RP, activationMFE: FIB_AM,
  });
}

function runOne(cfg) {
  return new Promise((resolve) => {
    const jsonPath = path.join(RUN_DIR, `${cfg.id}.json`);
    const logPath = path.join(RUN_DIR, `${cfg.id}.log`);

    if (fs.existsSync(jsonPath)) {
      console.log(`[skip ${cfg.id}] cached`);
      return resolve({ cfg, jsonPath, skipped: true });
    }

    const flags = [...BASE_FLAGS, ...cfg.flags, '--output-json', jsonPath];
    const started = Date.now();
    console.log(`[start ${cfg.id}]`);
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
        console.log(`[FAIL  ${cfg.id}] exit=${code} ${elapsed}s`);
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
    id: cfg.id, type: cfg.type,
    retracePct: cfg.retracePct, activationMFE: cfg.activationMFE,
    beTrigger: cfg.beTrigger ?? '', beOffset: cfg.beOffset ?? '',
    totalTrades: b.totalTrades, winRate: b.winRate,
    profitFactor: b.profitFactor, sharpeRatio: risk.sharpeRatio,
    maxDrawdownPct: dd.maxDrawdown, totalPnL: b.totalPnL,
    avgWin: b.avgWin, avgLoss: b.avgLoss,
    largestWin: b.largestWin, largestLoss: b.largestLoss,
    avgWinnerMFE: b.avgWinnerMFE,
    avgProfitGiveBack: b.avgProfitGiveBack,
    winnerCaptureRatio: b.winnerCaptureRatio,
    beClipCount: b.beClipCount, beClipPct: b.beClipPct,
    bigBeClipCount: b.bigBeClipCount,
    mfeToSLCount: b.mfeToSLCount, mfeToSLPct: b.mfeToSLPct,
    fibRetraceExits: exitCounts.fib_retrace || 0,
    tpExits: exitCounts.take_profit || 0,
    slExits: exitCounts.stop_loss || 0,
    trailingExits: exitCounts.trailing_stop || 0,
    marketCloseExits: exitCounts.market_close || 0,
    maxHoldExits: exitCounts.max_hold_time || 0,
    ok: true,
  };
}

(async () => {
  const t0 = Date.now();
  console.log(`Sweeping ${configs.length} configs (${configs.filter(c=>c.type==='fine').length} fine-grid + ${configs.filter(c=>c.type==='twolayer').length} two-layer) at max ${MAX_PARALLEL} parallel`);
  await runBatches(configs, MAX_PARALLEL);
  console.log(`\nAll runs completed in ${((Date.now() - t0) / 60000).toFixed(1)} min`);

  const rows = configs.map((cfg) => extractMetrics(path.join(RUN_DIR, `${cfg.id}.json`), cfg));

  const summaryJson = path.join(OUT_DIR, 'sweep-fib-fine-twolayer-summary.json');
  fs.writeFileSync(summaryJson, JSON.stringify(rows, null, 2));
  console.log(`Summary JSON: ${summaryJson}`);

  const headers = [
    'id', 'type', 'retracePct', 'activationMFE', 'beTrigger', 'beOffset',
    'totalTrades', 'winRate', 'profitFactor', 'sharpeRatio', 'maxDrawdownPct', 'totalPnL',
    'avgWin', 'avgLoss', 'largestWin', 'largestLoss',
    'avgWinnerMFE', 'avgProfitGiveBack', 'winnerCaptureRatio',
    'beClipCount', 'beClipPct', 'bigBeClipCount', 'mfeToSLCount', 'mfeToSLPct',
    'fibRetraceExits', 'tpExits', 'slExits', 'trailingExits', 'marketCloseExits', 'maxHoldExits',
  ];
  const csvLines = [headers.join(',')];
  for (const r of rows) {
    if (!r.ok) { csvLines.push(`${r.id},FAILED`); continue; }
    csvLines.push(headers.map((h) => {
      const v = r[h];
      if (typeof v === 'string' && v.includes(',')) return `"${v}"`;
      return v ?? '';
    }).join(','));
  }
  const csvPath = path.join(OUT_DIR, 'sweep-fib-fine-twolayer-summary.csv');
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log(`Summary CSV: ${csvPath}`);

  // Print top 10 by PF
  const ranked = rows.filter(r => r.ok).sort((a, b) => b.profitFactor - a.profitFactor);
  console.log('\nTop 10 by PF:');
  console.log('id                              type      retr  act  beT/beO  trades  WR%   PF   Sharpe   DD%    PnL$    avgGB  fibExits');
  for (const r of ranked.slice(0, 10)) {
    console.log(
      r.id.padEnd(32) + r.type.padEnd(10) +
      String(r.retracePct).padEnd(7) + String(r.activationMFE).padEnd(5) +
      (r.beTrigger ? `${r.beTrigger}/${r.beOffset}` : '-/-').padEnd(9) +
      String(r.totalTrades).padStart(6) + String((r.winRate||0).toFixed(1)).padStart(6) +
      String((r.profitFactor||0).toFixed(2)).padStart(6) +
      String((r.sharpeRatio||0).toFixed(2)).padStart(8) +
      String((r.maxDrawdownPct||0).toFixed(2)).padStart(7) +
      String(r.totalPnL).padStart(9) +
      String((r.avgProfitGiveBack||0).toFixed(1)).padStart(8) +
      String(r.fibRetraceExits).padStart(9)
    );
  }
})().catch((e) => { console.error('Sweep failed:', e); process.exit(1); });
