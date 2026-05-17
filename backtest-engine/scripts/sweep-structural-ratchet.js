#!/usr/bin/env node
/**
 * Small sweep over structural-magnet ratchet parameters:
 *   - lockPct ∈ {0.55, 0.65, 0.75, 0.85, 0.95}
 *   - recencyHours ∈ {2, 4, 8}
 * = 15 configs. Runs in pairs (MAX_PARALLEL=2). Output to research/mfe-ratchet-gfi/runs/.
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
  '--gfi-magnet-ratchet',
  '--quiet',
];

const configs = [];
for (const lockPct of [0.55, 0.65, 0.75, 0.85, 0.95]) {
  for (const recencyHours of [2, 4, 8]) {
    configs.push({
      id: `struct-l${Math.round(lockPct*100)}-r${recencyHours}h`,
      lockPct, recencyHours,
    });
  }
}
console.log(`Generated ${configs.length} structural configs.`);

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
      '--gfi-magnet-lock-pct', String(cfg.lockPct),
      '--gfi-magnet-recency-hours', String(cfg.recencyHours),
      '--output-json', jsonPath,
    ];
    const started = Date.now();
    console.log(`[start ${cfg.id}] lock=${cfg.lockPct} recency=${cfg.recencyHours}h`);
    const child = spawn('node', ['index.js', ...flags], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const ws = fs.createWriteStream(logPath);
    child.stdout.on('data', d => ws.write(d));
    child.stderr.on('data', d => ws.write(d));
    child.on('close', code => {
      ws.end();
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      if (code === 0 && fs.existsSync(jsonPath)) {
        console.log(`[done  ${cfg.id}] ${elapsed}s`);
        resolve({ cfg, jsonPath, ok: true, elapsed });
      } else {
        console.log(`[FAIL  ${cfg.id}] exit=${code} elapsed=${elapsed}s`);
        resolve({ cfg, jsonPath, ok: false, exitCode: code });
      }
    });
  });
}

async function runBatches(items, n) {
  const results = [];
  for (let i = 0; i < items.length; i += n) {
    const batch = items.slice(i, i + n);
    const out = await Promise.all(batch.map(runOne));
    results.push(...out);
  }
  return results;
}

function extract(p, cfg) {
  if (!fs.existsSync(p)) return { id: cfg.id, ok: false };
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  const b = r.performance.basic;
  const risk = r.performance.risk;
  const dd = r.performance.drawdown;
  return {
    id: cfg.id, lockPct: cfg.lockPct, recencyHours: cfg.recencyHours,
    totalTrades: b.totalTrades, winRate: b.winRate,
    profitFactor: b.profitFactor, sharpeRatio: risk.sharpeRatio,
    maxDrawdownPct: dd.maxDrawdown, totalPnL: b.totalPnL,
    avgWinnerMFE: b.avgWinnerMFE, avgProfitGiveBack: b.avgProfitGiveBack,
    winnerCaptureRatio: b.winnerCaptureRatio,
    beClipCount: b.beClipCount, beClipPct: b.beClipPct,
    bigBeClipCount: b.bigBeClipCount,
    mfeToSLCount: b.mfeToSLCount, mfeToSLPct: b.mfeToSLPct,
    totalGivebackPtsWinners: b.totalGivebackPtsWinners,
    givebackDollarsWinners: b.givebackDollarsWinners,
    ok: true,
  };
}

(async () => {
  const t0 = Date.now();
  await runBatches(configs, MAX_PARALLEL);
  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`Sweep done in ${elapsedMin} min`);

  const rows = configs.map(c => extract(path.join(RUN_DIR, `${c.id}.json`), c));
  fs.writeFileSync(path.join(OUT_DIR, 'structural-sweep-summary.json'), JSON.stringify(rows, null, 2));

  const headers = ['id', 'lockPct', 'recencyHours', 'totalTrades', 'winRate', 'profitFactor',
    'sharpeRatio', 'maxDrawdownPct', 'totalPnL', 'avgWinnerMFE', 'avgProfitGiveBack',
    'winnerCaptureRatio', 'beClipCount', 'mfeToSLCount', 'givebackDollarsWinners'];
  const csv = [headers.join(',')];
  for (const r of rows) {
    if (!r.ok) { csv.push(`${r.id},FAILED`); continue; }
    csv.push(headers.map(h => r[h] ?? '').join(','));
  }
  fs.writeFileSync(path.join(OUT_DIR, 'structural-sweep-summary.csv'), csv.join('\n'));
  console.log(`Wrote structural-sweep-summary.csv + .json`);
})().catch(e => { console.error(e); process.exit(1); });
