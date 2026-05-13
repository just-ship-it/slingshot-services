#!/usr/bin/env node
/**
 * Tight-stop / BE / filter sweep for gex-flip-ivpct.
 *
 * Goal: find a configuration with realistic risk (initial stop <=60pt) and
 * protected profit (breakeven move) that's defensible for a small account.
 * Headline gold-standard config has 100-184pt stops and 10.5% of trades
 * give back 50+ MFE then end negative — unacceptable.
 *
 * Phase-1 combos walk three knobs:
 *   - initial stop / target
 *   - BE trigger / offset
 *   - rule + hour filters (drop ET 06-08 because all 18 are MAE-ugly;
 *     drop S1 because clean-MAE rate is only 6.3%)
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKTEST_ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(BACKTEST_ROOT, 'data', 'sweep-results', 'gfi-tight-stops');

const FIXED = {
  ticker: 'NQ',
  strategy: 'gex-flip-ivpct',
  timeframe: '5m',
  start: '2025-01-13',
  end: '2026-04-20',
  ivResolution: '1m',
  eodCutoff: '16:40',
};

// Combos: [name, { stop, tgt, beTrigger, beOffset, trail?, trailOff?, blockedHours?, disableRules? }]
const COMBOS = [
  // Stage 1 (already run — skipped on re-run)
  { name: 's50_t120_noBE_noFilter',         stop: 50, tgt: 120 },
  { name: 's50_t120_BE25o5_noFilter',       stop: 50, tgt: 120, beTrigger: 25, beOffset: 5 },
  { name: 's50_t120_BE25o5_drop0608',       stop: 50, tgt: 120, beTrigger: 25, beOffset: 5, blockedHours: '6,7,8' },
  { name: 's50_t120_BE25o5_drop0608_noS1',  stop: 50, tgt: 120, beTrigger: 25, beOffset: 5, blockedHours: '6,7,8', disableRules: 'S1' },
  { name: 's40_t80_BE20o5_drop0608',        stop: 40, tgt: 80,  beTrigger: 20, beOffset: 5, blockedHours: '6,7,8' },
  { name: 's60_t120_BE30o5_drop0608',       stop: 60, tgt: 120, beTrigger: 30, beOffset: 5, blockedHours: '6,7,8' },
  { name: 's60_t150_BE30o10_drop0608_noS1', stop: 60, tgt: 150, beTrigger: 30, beOffset: 10, blockedHours: '6,7,8', disableRules: 'S1' },

  // Stage 2: higher BE triggers + bigger targets — give winners room to run
  { name: 's60_t150_BE50o5_drop0608',       stop: 60, tgt: 150, beTrigger: 50, beOffset: 5,  blockedHours: '6,7,8' },
  { name: 's60_t180_BE60o5_drop0608',       stop: 60, tgt: 180, beTrigger: 60, beOffset: 5,  blockedHours: '6,7,8' },
  { name: 's60_t200_BE75o10_drop0608',      stop: 60, tgt: 200, beTrigger: 75, beOffset: 10, blockedHours: '6,7,8' },
  { name: 's60_t200_BE100o15_drop0608',     stop: 60, tgt: 200, beTrigger: 100, beOffset: 15, blockedHours: '6,7,8' },

  // Stage 2: trailing stop instead of BE (let winners run further)
  { name: 's60_t200_trail50o30_drop0608',   stop: 60, tgt: 200, trail: 50, trailOff: 30, blockedHours: '6,7,8' },
  { name: 's60_t200_trail80o40_drop0608',   stop: 60, tgt: 200, trail: 80, trailOff: 40, blockedHours: '6,7,8' },

  // Stage 2: 50pt stop with high BE trigger / target
  { name: 's50_t180_BE60o5_drop0608',       stop: 50, tgt: 180, beTrigger: 60, beOffset: 5,  blockedHours: '6,7,8' },

  // Stage 3: refine around the BE@60-75 sweet spot + L3 removal
  { name: 's60_t180_BE65o5_drop0608',       stop: 60, tgt: 180, beTrigger: 65, beOffset: 5,  blockedHours: '6,7,8' },
  { name: 's60_t180_BE70o5_drop0608',       stop: 60, tgt: 180, beTrigger: 70, beOffset: 5,  blockedHours: '6,7,8' },
  { name: 's60_t200_BE65o5_drop0608',       stop: 60, tgt: 200, beTrigger: 65, beOffset: 5,  blockedHours: '6,7,8' },
  { name: 's60_t200_BE70o5_drop0608',       stop: 60, tgt: 200, beTrigger: 70, beOffset: 5,  blockedHours: '6,7,8' },
  // L3 has the widest natural MAE — try disabling it
  { name: 's60_t180_BE60o5_drop0608_noL3',  stop: 60, tgt: 180, beTrigger: 60, beOffset: 5,  blockedHours: '6,7,8', disableRules: 'L3' },
  { name: 's60_t200_BE75o10_drop0608_noL3', stop: 60, tgt: 200, beTrigger: 75, beOffset: 10, blockedHours: '6,7,8', disableRules: 'L3' },
];

const DEFAULT_CONCURRENCY = 3;

function comboResultPath(combo) {
  return path.join(RESULTS_DIR, `${combo.name}.json`);
}

function buildArgs(combo) {
  const args = [
    'index.js',
    '--ticker', FIXED.ticker,
    '--strategy', FIXED.strategy,
    '--timeframe', FIXED.timeframe,
    '--raw-contracts',
    '--start', FIXED.start,
    '--end', FIXED.end,
    '--iv-resolution', FIXED.ivResolution,
    '--eod-cutoff-et', FIXED.eodCutoff,
    '--gfi-stop-pts', String(combo.stop),
    '--gfi-target-pts', String(combo.tgt),
    '--output-json', comboResultPath(combo),
  ];
  if (combo.beTrigger != null) {
    args.push('--gfi-breakeven-stop');
    args.push('--gfi-breakeven-trigger', String(combo.beTrigger));
    args.push('--gfi-breakeven-offset', String(combo.beOffset ?? 0));
  }
  if (combo.trail != null) {
    args.push('--gfi-trailing-trigger', String(combo.trail));
    args.push('--gfi-trailing-offset', String(combo.trailOff ?? 20));
  }
  if (combo.blockedHours) args.push('--gfi-blocked-hours', combo.blockedHours);
  if (combo.disableRules) args.push('--gfi-disable-rules', combo.disableRules);
  return args;
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

  // Compute giveback stats from per-trade data
  const trades = (r.trades || []).filter(t => t.status === 'completed');
  const losers = trades.filter(t => t.pointsPnL <= 0);
  const painful = losers.filter(t => t.mfePoints > 50);
  const maxLoss = losers.length ? Math.min(...losers.map(t => t.pointsPnL)) : 0;
  const maxGiveback = losers.length ? Math.max(...losers.map(t => t.mfePoints - t.pointsPnL)) : 0;
  const avgWin = trades.filter(t => t.pointsPnL > 0).length
    ? trades.filter(t => t.pointsPnL > 0).reduce((a, t) => a + t.pointsPnL, 0)
      / trades.filter(t => t.pointsPnL > 0).length : 0;

  return {
    name: combo.name,
    config: { stop: combo.stop, tgt: combo.tgt, beTrigger: combo.beTrigger, beOffset: combo.beOffset, blockedHours: combo.blockedHours, disableRules: combo.disableRules },
    trades: basic.totalTrades ?? summary.totalTrades ?? 0,
    winRate: basic.winRate ?? summary.winRate ?? 0,
    profitFactor: basic.profitFactor ?? 0,
    sharpe: risk.sharpeRatio ?? summary.sharpeRatio ?? 0,
    maxDrawdown: dd.maxDrawdown ?? summary.maxDrawdown ?? 0,
    totalPnL: basic.totalPnL ?? summary.totalPnL ?? 0,
    avgWin: basic.avgWin ?? 0,
    avgLoss: basic.avgLoss ?? 0,
    expectancy: basic.expectancy ?? 0,
    // Giveback metrics
    painfulLoserCount: painful.length,
    maxLossPoints: maxLoss,
    maxGivebackPoints: maxGiveback,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const concurrency = parseInt(args[args.indexOf('--concurrency') + 1]) || DEFAULT_CONCURRENCY;

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const todo = COMBOS.filter((c) => !fs.existsSync(comboResultPath(c)));
  const skipped = COMBOS.length - todo.length;

  console.log('\n=== gex-flip-ivpct tight-stop/BE/filter sweep ===');
  console.log(`Period: ${FIXED.start} → ${FIXED.end}`);
  console.log(`Total combos: ${COMBOS.length}, todo: ${todo.length}, skipped: ${skipped}`);
  console.log(`Concurrency: ${concurrency}\n`);

  if (todo.length === 0) {
    aggregate(COMBOS);
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
        const summary = m ? `n=${m.trades} pf=${(m.profitFactor || 0).toFixed(2)} pnl=$${(m.totalPnL || 0).toFixed(0)} dd=${(m.maxDrawdown || 0).toFixed(2)}% painful=${m.painfulLoserCount} maxLoss=${m.maxLossPoints.toFixed(0)}pt` : 'no metrics';
        console.log(
          `[${completed}/${todo.length}] ${combo.name.padEnd(38)} ` +
          `${status.padEnd(8)} ${result.elapsedSec}s  ${summary}  (elapsed ${elapsed}m, eta ${eta}m)`
        );
        if (result.code !== 0) {
          console.log('STDERR:', result.stderr.slice(0, 500));
        }
      }
    })());
  }

  await Promise.all(workers);
  console.log(`\nAll combos run in ${((Date.now() - t0) / 60000).toFixed(1)} min.`);
  aggregate(COMBOS);
}

function aggregate(combos) {
  const rows = combos.map(extractMetrics).filter(Boolean);
  if (rows.length === 0) return;

  rows.sort((a, b) => {
    if ((b.profitFactor ?? 0) !== (a.profitFactor ?? 0)) return (b.profitFactor ?? 0) - (a.profitFactor ?? 0);
    return (a.maxDrawdown ?? 99) - (b.maxDrawdown ?? 99);
  });

  const csvPath = path.join(RESULTS_DIR, '_aggregated.csv');
  const header = ['rank', 'name', 'stop', 'tgt', 'beTrigger', 'beOffset', 'blockedHours', 'disableRules', 'trades', 'winRate', 'profitFactor', 'sharpe', 'maxDrawdown', 'totalPnL', 'avgWin', 'avgLoss', 'painfulLoserCount', 'maxLossPoints', 'maxGivebackPoints'];
  const lines = [header.join(',')];
  rows.forEach((r, i) => {
    lines.push([
      i + 1, r.name, r.config.stop, r.config.tgt,
      r.config.beTrigger ?? '', r.config.beOffset ?? '',
      r.config.blockedHours ?? '', r.config.disableRules ?? '',
      r.trades, r.winRate, r.profitFactor, r.sharpe,
      r.maxDrawdown, r.totalPnL, r.avgWin, r.avgLoss,
      r.painfulLoserCount, r.maxLossPoints.toFixed(1), r.maxGivebackPoints.toFixed(1)
    ].join(','));
  });
  fs.writeFileSync(csvPath, lines.join('\n'));

  console.log(`\nAggregated: ${csvPath}\n`);
  console.log(`=== Sorted by PF (then by lowest MaxDD) ===\n`);
  console.log('Rank  Combo                                   n     WR%    PF    Sharpe MaxDD%  PnL          AvgWin  AvgLoss  Painful  MaxLoss  MaxGiveback');
  console.log('----  --------------------------------------  ----  -----  ----  ------ -----   -----------  ------  -------  -------  -------  -----------');
  rows.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(4)}  ` +
      `${r.name.padEnd(38)}  ` +
      `${String(r.trades).padStart(4)}  ` +
      `${(r.winRate || 0).toFixed(1).padStart(5)}  ` +
      `${(r.profitFactor || 0).toFixed(2).padStart(4)}  ` +
      `${(r.sharpe || 0).toFixed(2).padStart(6)} ` +
      `${(r.maxDrawdown || 0).toFixed(2).padStart(5)}   ` +
      `$${(r.totalPnL || 0).toFixed(0).padStart(10)}  ` +
      `$${(r.avgWin || 0).toFixed(0).padStart(5)}  ` +
      `$${(r.avgLoss || 0).toFixed(0).padStart(6)}  ` +
      `${String(r.painfulLoserCount).padStart(7)}  ` +
      `${r.maxLossPoints.toFixed(0).padStart(7)}  ` +
      `${r.maxGivebackPoints.toFixed(0).padStart(11)}`
    );
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
