#!/usr/bin/env node
/**
 * MFE Ratchet tier sweep for gex-flip-ivpct.
 *
 * Generates 28 tier configurations (9 single-tier + 16 two-tier + 3 three-tier),
 * runs each as a 16-month gex-flip-ivpct backtest in batches of 2 (per the
 * 2-parallel-backtest memory rule), parses performance.basic from each JSON,
 * and writes a sweep summary CSV + JSON to research/mfe-ratchet-gfi/.
 *
 * Engine flags held constant per CLAUDE.md gex-flip-ivpct gold-standard recipe:
 *   --strategy gex-flip-ivpct --timeframe 5m --raw-contracts
 *   --iv-resolution 1m --eod-cutoff-et 16:40
 *   --gfi-stop-pts 60 --gfi-target-pts 200 --gfi-blocked-hours 6,7,8
 * Notably: NO --gfi-breakeven-stop. The MFE ratchet REPLACES the BE rule.
 *
 * Output:
 *   research/mfe-ratchet-gfi/runs/<configId>.json   raw backtest results
 *   research/mfe-ratchet-gfi/runs/<configId>.log    stdout (tail-50)
 *   research/mfe-ratchet-gfi/sweep-summary.csv      per-config row
 *   research/mfe-ratchet-gfi/sweep-summary.json     same data, machine-readable
 *
 * Run from backtest-engine/ root:
 *   node scripts/sweep-mfe-ratchet-gfi.js
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

// --- Tier config generation ------------------------------------------------

function tierStr(tiers) {
  // CLI format: "minMFE:lockPct,..."   (engine sorts highest minMFE first)
  return tiers.map(t => `${t.minMFE}:${t.lockPct}`).join(',');
}

function configId(prefix, tiers) {
  return `${prefix}-` + tiers.map(t => `m${t.minMFE}l${Math.round(t.lockPct * 100)}`).join('-');
}

const configs = [];

// 1-tier: minMFE ∈ {50, 70, 100}, lockPct ∈ {0.40, 0.50, 0.60}
for (const minMFE of [50, 70, 100]) {
  for (const lockPct of [0.40, 0.50, 0.60]) {
    const tiers = [{ minMFE, lockPct }];
    configs.push({ id: configId('s1', tiers), tiers });
  }
}

// 2-tier: lo (minMFE ∈ {50, 70}, lockPct ∈ {0.40, 0.50}) × hi (minMFE ∈ {120, 150}, lockPct ∈ {0.60, 0.70})
for (const loMFE of [50, 70]) {
  for (const loLock of [0.40, 0.50]) {
    for (const hiMFE of [120, 150]) {
      for (const hiLock of [0.60, 0.70]) {
        const tiers = [
          { minMFE: hiMFE, lockPct: hiLock },
          { minMFE: loMFE, lockPct: loLock },
        ];
        configs.push({ id: configId('s2', tiers), tiers });
      }
    }
  }
}

// 3-tier hand-picked configs
const threeTier = [
  [ { minMFE: 150, lockPct: 0.65 }, { minMFE: 80,  lockPct: 0.50 }, { minMFE: 40, lockPct: 0.30 } ],
  [ { minMFE: 140, lockPct: 0.65 }, { minMFE: 90,  lockPct: 0.50 }, { minMFE: 50, lockPct: 0.35 } ],
  [ { minMFE: 160, lockPct: 0.70 }, { minMFE: 100, lockPct: 0.55 }, { minMFE: 60, lockPct: 0.40 } ],
];
for (const tiers of threeTier) {
  configs.push({ id: configId('s3', tiers), tiers });
}

console.log(`Generated ${configs.length} configs.`);

// --- Runner ----------------------------------------------------------------

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
      '--mfe-ratchet',
      '--mfe-ratchet-tiers', tierStr(cfg.tiers),
      '--output-json', jsonPath,
    ];

    const started = Date.now();
    console.log(`[start ${cfg.id}] ${tierStr(cfg.tiers)}`);
    const child = spawn('node', ['index.js', ...flags], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const logStream = fs.createWriteStream(logPath);
    let lastLines = [];
    const captureLine = (chunk) => {
      const s = chunk.toString();
      logStream.write(s);
      // Keep last ~50 lines for quick inspection
      for (const line of s.split(/\r?\n/)) {
        lastLines.push(line);
        if (lastLines.length > 50) lastLines.shift();
      }
    };
    child.stdout.on('data', captureLine);
    child.stderr.on('data', captureLine);

    child.on('close', (code) => {
      logStream.end();
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      if (code === 0 && fs.existsSync(jsonPath)) {
        console.log(`[done  ${cfg.id}] ${elapsed}s`);
        resolve({ cfg, jsonPath, ok: true, elapsed });
      } else {
        console.log(`[FAIL  ${cfg.id}] exit=${code} elapsed=${elapsed}s — see ${logPath}`);
        resolve({ cfg, jsonPath, ok: false, exitCode: code, elapsed });
      }
    });
  });
}

async function runBatches(items, batchSize) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(runOne));
    results.push(...batchResults);
  }
  return results;
}

// --- Summary extraction ----------------------------------------------------

function extractMetrics(jsonPath, cfg) {
  if (!fs.existsSync(jsonPath)) {
    return { id: cfg.id, ok: false };
  }
  const r = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const b = r.performance?.basic ?? {};
  const risk = r.performance?.risk ?? {};
  const dd = r.performance?.drawdown ?? {};
  return {
    id: cfg.id,
    tiers: tierStr(cfg.tiers),
    nTiers: cfg.tiers.length,
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
    ok: true,
  };
}

// --- Main ------------------------------------------------------------------

(async () => {
  const t0 = Date.now();
  await runBatches(configs, MAX_PARALLEL);
  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\nAll ${configs.length} runs completed in ${elapsedMin} min`);

  // Extract metrics
  const rows = configs.map(cfg => {
    const jsonPath = path.join(RUN_DIR, `${cfg.id}.json`);
    return extractMetrics(jsonPath, cfg);
  });

  // Write JSON summary
  const summaryJson = path.join(OUT_DIR, 'sweep-summary.json');
  fs.writeFileSync(summaryJson, JSON.stringify(rows, null, 2));
  console.log(`Summary JSON: ${summaryJson}`);

  // Write CSV
  const headers = [
    'id', 'tiers', 'nTiers', 'totalTrades', 'winRate', 'profitFactor', 'sharpeRatio',
    'maxDrawdownPct', 'totalPnL', 'avgWin', 'avgLoss', 'largestWin', 'largestLoss',
    'avgWinnerMFE', 'avgProfitGiveBack', 'winnerCaptureRatio',
    'beClipCount', 'beClipPct', 'bigBeClipCount',
    'mfeToSLCount', 'mfeToSLPct',
    'totalGivebackPtsWinners', 'givebackDollarsWinners',
  ];
  const csvLines = [headers.join(',')];
  for (const r of rows) {
    if (!r.ok) {
      csvLines.push(`${r.id},FAILED`);
      continue;
    }
    csvLines.push(headers.map(h => {
      const v = r[h];
      if (typeof v === 'string' && v.includes(',')) return `"${v}"`;
      return v ?? '';
    }).join(','));
  }
  const csvPath = path.join(OUT_DIR, 'sweep-summary.csv');
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log(`Summary CSV: ${csvPath}`);
})().catch(e => {
  console.error('Sweep failed:', e);
  process.exit(1);
});
