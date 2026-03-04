#!/usr/bin/env node

/**
 * DC-MSTGAM Optimization Campaign Runner
 *
 * Automates multi-phase parameter sweeps for finding profitable MSTGAM
 * configurations on NQ 2025 data.
 *
 * Phases:
 *   1. baseline  — Single run with paper defaults
 *   2. sweep     — SL/TP grid search
 *   3. entry     — Entry/duration multiplier sweep (top configs from phase 2)
 *   4. timeframe — Compare 1m, 5m, 15m
 *   5. heavy     — Large pop/gen on top configs
 *   6. walk-forward — Quarterly expanding-window validation
 *   7. points    — Points-mode contingency
 *
 * Usage:
 *   node scripts/dc-mstgam-campaign.js --phase baseline
 *   node scripts/dc-mstgam-campaign.js --phase sweep
 *   node scripts/dc-mstgam-campaign.js --phase all
 *   node scripts/dc-mstgam-campaign.js --phase heavy --top 5
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RESULTS_BASE = path.join(__dirname, '..', 'results', 'mstgam');
const OPTIMIZER_SCRIPT = path.join(__dirname, 'dc-ga-optimize.js');

// ─── CLI ──────────────────────────────────────────────────────────────────

const args = yargs(hideBin(process.argv))
  .usage('Usage: $0 --phase <phase> [options]')
  .option('phase', {
    type: 'string',
    description: 'Campaign phase to run',
    demandOption: true,
    choices: ['baseline', 'sweep', 'entry', 'timeframe', 'heavy', 'walk-forward', 'points', 'all',
              'v2-baseline', 'v2-sweep', 'v2-timeframe', 'v2-votes', 'v2-heavy', 'v2-walk-forward', 'v2-window', 'v2-all']
  })
  .option('ticker', {
    type: 'string',
    description: 'Ticker symbol',
    default: 'NQ'
  })
  .option('start', {
    type: 'string',
    description: 'Start date',
    default: '2025-01-01'
  })
  .option('end', {
    type: 'string',
    description: 'End date',
    default: '2025-12-24'
  })
  .option('top', {
    type: 'number',
    description: 'Number of top configs to carry forward between phases',
    default: 3
  })
  .option('dry-run', {
    type: 'boolean',
    description: 'Print commands without executing',
    default: false
  })
  .help()
  .parse();

// ─── Helpers ──────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function resultPath(phase, name) {
  const dir = path.join(RESULTS_BASE, phase);
  ensureDir(dir);
  return path.join(dir, `${name}.json`);
}

function resultExists(phase, name) {
  return fs.existsSync(resultPath(phase, name));
}

function loadResult(phase, name) {
  const p = resultPath(phase, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadAllResults(phase) {
  const dir = path.join(RESULTS_BASE, phase);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'phase-summary.json');
  return files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    data._filename = f.replace('.json', '');
    return data;
  });
}

function rankResults(results) {
  return results
    .filter(r => r.testResults && r.testResults.sharpeRatio !== undefined)
    .sort((a, b) => (b.testResults.sharpeRatio || -Infinity) - (a.testResults.sharpeRatio || -Infinity));
}

function writePhaseSummary(phase, ranked) {
  const summary = {
    phase,
    timestamp: new Date().toISOString(),
    totalRuns: ranked.length,
    bestTestSharpe: ranked[0]?.testResults?.sharpeRatio ?? null,
    topConfigs: ranked.slice(0, 10).map(r => ({
      name: r._filename,
      testSharpe: r.testResults?.sharpeRatio,
      testPnL: r.testResults?.totalPnL,
      testTrades: r.testResults?.numTrades,
      testWinRate: r.testResults?.winRate,
      trainSharpe: r.trainResults?.sharpeRatio,
      config: {
        sl: r.config?.tradeParams?.stopLossPoints,
        tp: r.config?.tradeParams?.takeProfitPoints,
        sessions: r.config?.allowedSessions,
        timeframe: r.config?.timeframe,
        entryMult: r.config?.dcParams?.entryMultiplier,
        durationMult: r.config?.dcParams?.durationMultiplier,
        fitnessMode: r.config?.fitnessMode,
        cooldownCandles: r.config?.cooldownCandles ?? r.config?.tradeParams?.cooldownCandles,
        minNonHoldVotes: r.config?.minNonHoldVotes ?? r.config?.tradeParams?.minNonHoldVotes,
        maxTradesPerDay: r.config?.maxTradesPerDay ?? r.config?.tradeParams?.maxTradesPerDay
      }
    }))
  };

  const dir = path.join(RESULTS_BASE, phase);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'phase-summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

function runOptimizer(name, phase, extraArgs, overrides = {}) {
  const outputFile = resultPath(phase, name);

  if (fs.existsSync(outputFile)) {
    console.log(chalk.gray(`  [skip] ${name} — already exists`));
    return true;
  }

  const cmdArgs = [
    OPTIMIZER_SCRIPT,
    '--ticker', overrides.ticker || args.ticker,
    '--start', overrides.start || args.start,
    '--end', overrides.end || args.end,
    '--output', outputFile,
    ...extraArgs
  ];

  if (args.dryRun) {
    console.log(chalk.cyan(`  [dry-run] node ${cmdArgs.join(' ')}`));
    return true;
  }

  console.log(chalk.yellow(`  [run] ${name}`));
  const startTime = Date.now();

  try {
    execFileSync('node', cmdArgs, {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      timeout: 4 * 60 * 60 * 1000 // 4 hour timeout
    });
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(chalk.green(`  [done] ${name} in ${elapsed}m`));
    return true;
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.error(chalk.red(`  [fail] ${name} after ${elapsed}m: ${err.message}`));
    return false;
  }
}

function printRankedTable(ranked, limit = 10) {
  console.log(chalk.blue.bold('\n  Rank  Test Sharpe  Test PnL     Trades  WinRate  Config'));
  console.log(chalk.gray('  ' + '─'.repeat(75)));
  for (let i = 0; i < Math.min(ranked.length, limit); i++) {
    const r = ranked[i];
    const sharpe = (r.testResults?.sharpeRatio ?? 0).toFixed(4);
    const pnl = `$${(r.testResults?.totalPnL ?? 0).toFixed(0)}`;
    const trades = r.testResults?.numTrades ?? 0;
    const wr = `${((r.testResults?.winRate ?? 0) * 100).toFixed(1)}%`;
    const color = (r.testResults?.sharpeRatio ?? 0) > 0 ? chalk.green : chalk.red;
    console.log(color(`  #${(i + 1).toString().padStart(2)}   ${sharpe.padStart(10)}  ${pnl.padStart(10)}  ${trades.toString().padStart(7)}  ${wr.padStart(7)}  ${r._filename}`));
  }
}

// ─── Phase Implementations ───────────────────────────────────────────────

function phaseBaseline() {
  console.log(chalk.blue.bold('\n═══ Phase 1: Baseline ═══'));
  console.log(chalk.gray('Paper defaults: pop=150, gen=50, SL=15, TP=30, all sessions, 1m'));

  runOptimizer('baseline', 'baseline', [
    '--pop', '150', '--gen', '50',
    '--stop-loss', '15', '--take-profit', '30',
    '--fitness-mode', 'sharpe', '--min-trades', '20'
  ]);

  const results = loadAllResults('baseline');
  if (results.length > 0) {
    const ranked = rankResults(results);
    const summary = writePhaseSummary('baseline', ranked);
    printRankedTable(ranked);
    return summary;
  }
}

function phaseSweep() {
  console.log(chalk.blue.bold('\n═══ Phase 2: SL/TP Sweep ═══'));

  const stopLosses = [15, 20, 25, 30];
  const takeProfits = [30, 40, 50, 60];
  const sessionConfigs = [
    { name: 'all', args: [] },
    { name: 'rth', args: ['--sessions', 'rth'] }
  ];

  const total = stopLosses.length * takeProfits.length * sessionConfigs.length;
  let completed = 0;

  for (const sl of stopLosses) {
    for (const tp of takeProfits) {
      for (const sess of sessionConfigs) {
        completed++;
        const name = `sl${sl}_tp${tp}_${sess.name}`;
        console.log(chalk.gray(`\n  [${completed}/${total}]`));
        runOptimizer(name, 'sweep', [
          '--pop', '150', '--gen', '50',
          '--stop-loss', sl.toString(), '--take-profit', tp.toString(),
          '--fitness-mode', 'sharpe', '--min-trades', '20',
          ...sess.args
        ]);
      }
    }
  }

  const results = loadAllResults('sweep');
  const ranked = rankResults(results);
  const summary = writePhaseSummary('sweep', ranked);
  printRankedTable(ranked);
  return summary;
}

function phaseEntry() {
  console.log(chalk.blue.bold('\n═══ Phase 3: Entry Multiplier Sweep ═══'));

  // Load top configs from sweep phase
  const sweepSummaryPath = path.join(RESULTS_BASE, 'sweep', 'phase-summary.json');
  if (!fs.existsSync(sweepSummaryPath)) {
    console.log(chalk.red('  Phase 2 (sweep) must complete first. Run --phase sweep'));
    return null;
  }

  const sweepSummary = JSON.parse(fs.readFileSync(sweepSummaryPath, 'utf8'));
  const topConfigs = sweepSummary.topConfigs.slice(0, args.top);

  if (topConfigs.length === 0) {
    console.log(chalk.red('  No configs from sweep phase'));
    return null;
  }

  console.log(chalk.gray(`  Using top ${topConfigs.length} configs from sweep phase`));

  const entryMults = [1.0, 1.5, 2.0, 2.5, 3.0];
  const durationMults = [1.5, 2.0, 3.0];

  let completed = 0;
  const total = topConfigs.length * entryMults.length * durationMults.length;

  for (const cfg of topConfigs) {
    for (const em of entryMults) {
      for (const dm of durationMults) {
        completed++;
        const sessFlag = cfg.config.sessions ? ['--sessions', cfg.config.sessions.join(',')] : [];
        const name = `sl${cfg.config.sl}_tp${cfg.config.tp}_em${em}_dm${dm}_${cfg.config.sessions ? 'rth' : 'all'}`;
        console.log(chalk.gray(`\n  [${completed}/${total}]`));
        runOptimizer(name, 'entry', [
          '--pop', '150', '--gen', '50',
          '--stop-loss', cfg.config.sl.toString(),
          '--take-profit', cfg.config.tp.toString(),
          '--entry-mult', em.toString(),
          '--duration-mult', dm.toString(),
          '--fitness-mode', 'sharpe', '--min-trades', '20',
          ...sessFlag
        ]);
      }
    }
  }

  const results = loadAllResults('entry');
  const ranked = rankResults(results);
  const summary = writePhaseSummary('entry', ranked);
  printRankedTable(ranked);
  return summary;
}

function phaseTimeframe() {
  console.log(chalk.blue.bold('\n═══ Phase 4: Timeframe Comparison ═══'));

  // Find best configs from entry or sweep phase
  let sourcePhase = 'entry';
  let summaryPath = path.join(RESULTS_BASE, 'entry', 'phase-summary.json');
  if (!fs.existsSync(summaryPath)) {
    sourcePhase = 'sweep';
    summaryPath = path.join(RESULTS_BASE, 'sweep', 'phase-summary.json');
  }
  if (!fs.existsSync(summaryPath)) {
    console.log(chalk.red('  Phase 2 or 3 must complete first'));
    return null;
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const topConfigs = summary.topConfigs.slice(0, args.top);

  console.log(chalk.gray(`  Using top ${topConfigs.length} configs from ${sourcePhase} phase`));

  const timeframes = ['1m', '5m', '15m'];

  let completed = 0;
  const total = topConfigs.length * timeframes.length;

  for (const cfg of topConfigs) {
    for (const tf of timeframes) {
      completed++;
      const sessFlag = cfg.config.sessions ? ['--sessions', cfg.config.sessions.join(',')] : [];
      const emFlag = cfg.config.entryMult ? ['--entry-mult', cfg.config.entryMult.toString()] : [];
      const dmFlag = cfg.config.durationMult ? ['--duration-mult', cfg.config.durationMult.toString()] : [];
      const name = `sl${cfg.config.sl}_tp${cfg.config.tp}_${tf}_${cfg.config.sessions ? 'rth' : 'all'}`;
      console.log(chalk.gray(`\n  [${completed}/${total}]`));
      runOptimizer(name, 'timeframe', [
        '--pop', '150', '--gen', '50',
        '--stop-loss', cfg.config.sl.toString(),
        '--take-profit', cfg.config.tp.toString(),
        '--timeframe', tf,
        '--fitness-mode', 'sharpe', '--min-trades', '20',
        ...emFlag, ...dmFlag, ...sessFlag
      ]);
    }
  }

  const results = loadAllResults('timeframe');
  const ranked = rankResults(results);
  const phaseSummary = writePhaseSummary('timeframe', ranked);
  printRankedTable(ranked);
  return phaseSummary;
}

function phaseHeavy() {
  console.log(chalk.blue.bold('\n═══ Phase 5: Heavy Optimization ═══'));

  // Find best configs from latest completed phase
  let sourcePhase = null;
  for (const p of ['timeframe', 'entry', 'sweep']) {
    if (fs.existsSync(path.join(RESULTS_BASE, p, 'phase-summary.json'))) {
      sourcePhase = p;
      break;
    }
  }

  if (!sourcePhase) {
    console.log(chalk.red('  At least phase 2 must complete first'));
    return null;
  }

  const summary = JSON.parse(fs.readFileSync(path.join(RESULTS_BASE, sourcePhase, 'phase-summary.json'), 'utf8'));
  const topConfigs = summary.topConfigs.slice(0, args.top);

  console.log(chalk.gray(`  Using top ${topConfigs.length} configs from ${sourcePhase} phase`));
  console.log(chalk.gray('  Heavy params: pop=300, gen=100, runs=3 (best of 3 seeds)'));

  let completed = 0;
  const total = topConfigs.length;

  for (const cfg of topConfigs) {
    completed++;
    const sessFlag = cfg.config.sessions ? ['--sessions', cfg.config.sessions.join(',')] : [];
    const emFlag = cfg.config.entryMult ? ['--entry-mult', cfg.config.entryMult.toString()] : [];
    const dmFlag = cfg.config.durationMult ? ['--duration-mult', cfg.config.durationMult.toString()] : [];
    const tfFlag = cfg.config.timeframe ? ['--timeframe', cfg.config.timeframe] : [];
    const name = `heavy_sl${cfg.config.sl}_tp${cfg.config.tp}_${cfg.config.timeframe || '1m'}_${cfg.config.sessions ? 'rth' : 'all'}`;
    console.log(chalk.gray(`\n  [${completed}/${total}]`));
    runOptimizer(name, 'heavy', [
      '--pop', '300', '--gen', '100', '--runs', '3',
      '--stop-loss', cfg.config.sl.toString(),
      '--take-profit', cfg.config.tp.toString(),
      '--fitness-mode', 'sharpe', '--min-trades', '20',
      ...emFlag, ...dmFlag, ...tfFlag, ...sessFlag
    ]);
  }

  const results = loadAllResults('heavy');
  const ranked = rankResults(results);
  const phaseSummary = writePhaseSummary('heavy', ranked);
  printRankedTable(ranked);
  return phaseSummary;
}

function phaseWalkForward() {
  console.log(chalk.blue.bold('\n═══ Phase 6: Walk-Forward Validation ═══'));

  // Find best configs from heavy or latest phase
  let sourcePhase = null;
  for (const p of ['heavy', 'timeframe', 'entry', 'sweep']) {
    if (fs.existsSync(path.join(RESULTS_BASE, p, 'phase-summary.json'))) {
      sourcePhase = p;
      break;
    }
  }

  if (!sourcePhase) {
    console.log(chalk.red('  At least phase 2 must complete first'));
    return null;
  }

  const summary = JSON.parse(fs.readFileSync(path.join(RESULTS_BASE, sourcePhase, 'phase-summary.json'), 'utf8'));
  const topConfigs = summary.topConfigs.slice(0, args.top);

  console.log(chalk.gray(`  Using top ${topConfigs.length} configs from ${sourcePhase} phase`));

  let completed = 0;
  const total = topConfigs.length;

  for (const cfg of topConfigs) {
    completed++;
    const sessFlag = cfg.config.sessions ? ['--sessions', cfg.config.sessions.join(',')] : [];
    const emFlag = cfg.config.entryMult ? ['--entry-mult', cfg.config.entryMult.toString()] : [];
    const dmFlag = cfg.config.durationMult ? ['--duration-mult', cfg.config.durationMult.toString()] : [];
    const tfFlag = cfg.config.timeframe ? ['--timeframe', cfg.config.timeframe] : [];
    const name = `wf_sl${cfg.config.sl}_tp${cfg.config.tp}_${cfg.config.timeframe || '1m'}_${cfg.config.sessions ? 'rth' : 'all'}`;
    console.log(chalk.gray(`\n  [${completed}/${total}]`));
    runOptimizer(name, 'walk-forward', [
      '--pop', '150', '--gen', '50',
      '--stop-loss', cfg.config.sl.toString(),
      '--take-profit', cfg.config.tp.toString(),
      '--fitness-mode', 'sharpe', '--min-trades', '20',
      '--walk-forward',
      ...emFlag, ...dmFlag, ...tfFlag, ...sessFlag
    ]);
  }

  const results = loadAllResults('walk-forward');

  // Summarize walk-forward go/no-go
  console.log(chalk.blue.bold('\n  Walk-Forward Go/No-Go Assessment:'));
  for (const r of results) {
    const wf = r.walkForwardResults;
    if (!wf) {
      console.log(chalk.gray(`    ${r._filename}: no walk-forward data`));
      continue;
    }
    const positive = wf.positiveSplits;
    const total = wf.totalSplits;
    const verdict = positive >= 2 ? chalk.green.bold('GO') : chalk.red.bold('NO-GO');
    console.log(`    ${r._filename}: ${positive}/${total} positive splits — ${verdict}`);

    if (wf.splits) {
      for (const split of wf.splits) {
        const color = split.testSharpe > 0 ? chalk.green : chalk.red;
        console.log(color(`      ${split.name}: Sharpe=${split.testSharpe.toFixed(4)}, PnL=$${split.testPnL.toFixed(0)}, Trades=${split.testTrades}`));
      }
    }
  }

  const ranked = rankResults(results);
  const phaseSummary = writePhaseSummary('walk-forward', ranked);
  return phaseSummary;
}

function phasePoints() {
  console.log(chalk.blue.bold('\n═══ Phase 7: Points Mode Contingency ═══'));
  console.log(chalk.gray('  Using absolute point thresholds instead of percentages'));

  const thresholds = '5,10,15,20,30,40,50,75,100,150';
  const thresholdsSt78 = '5,10,15,20,30';
  const stopLosses = [15, 20, 25];
  const takeProfits = [30, 40, 50];

  let completed = 0;
  const total = stopLosses.length * takeProfits.length;

  for (const sl of stopLosses) {
    for (const tp of takeProfits) {
      completed++;
      const name = `pts_sl${sl}_tp${tp}`;
      console.log(chalk.gray(`\n  [${completed}/${total}]`));
      runOptimizer(name, 'points', [
        '--pop', '150', '--gen', '50',
        '--stop-loss', sl.toString(), '--take-profit', tp.toString(),
        '--dc-use-points',
        '--thresholds', thresholds,
        '--thresholds-st78', thresholdsSt78,
        '--fitness-mode', 'sharpe', '--min-trades', '20'
      ]);
    }
  }

  const results = loadAllResults('points');
  const ranked = rankResults(results);
  const phaseSummary = writePhaseSummary('points', ranked);
  printRankedTable(ranked);
  return phaseSummary;
}

// ─── V2 Phase Implementations (Structural Fixes for Futures) ─────────────

function phaseV2Baseline() {
  console.log(chalk.blue.bold('\n═══ V2 Phase: Baseline (Futures Preset) ═══'));
  console.log(chalk.gray('Futures preset + SL=20, TP=40. Quick sanity check.'));

  runOptimizer('v2-baseline', 'v2-baseline', [
    '--pop', '150', '--gen', '50',
    '--stop-loss', '20', '--take-profit', '40',
    '--futures-preset',
    '--fitness-mode', 'sharpe', '--min-trades', '10'
  ]);

  const results = loadAllResults('v2-baseline');
  if (results.length > 0) {
    const ranked = rankResults(results);
    const summary = writePhaseSummary('v2-baseline', ranked);
    printRankedTable(ranked);
    return summary;
  }
}

function phaseV2Sweep() {
  console.log(chalk.blue.bold('\n═══ V2 Phase: Structural Sweep ═══'));
  console.log(chalk.gray('Grid: SL × TP × cooldown × minVotes × sessions, all with --futures-preset'));

  const stopLosses = [20, 30];
  const takeProfits = [40, 60];
  const cooldowns = [5, 10, 20];
  const minVotesList = [3, 5, 7];
  const sessionConfigs = [
    { name: 'all', args: [] },
    { name: 'rth', args: ['--sessions', 'rth'] }
  ];

  const total = stopLosses.length * takeProfits.length * cooldowns.length * minVotesList.length * sessionConfigs.length;
  let completed = 0;

  for (const sl of stopLosses) {
    for (const tp of takeProfits) {
      for (const cd of cooldowns) {
        for (const mv of minVotesList) {
          for (const sess of sessionConfigs) {
            completed++;
            const name = `sl${sl}_tp${tp}_cd${cd}_mv${mv}_${sess.name}`;
            console.log(chalk.gray(`\n  [${completed}/${total}]`));
            runOptimizer(name, 'v2-sweep', [
              '--pop', '150', '--gen', '50',
              '--stop-loss', sl.toString(), '--take-profit', tp.toString(),
              '--cooldown', cd.toString(), '--min-votes', mv.toString(),
              '--futures-preset',
              '--fitness-mode', 'sharpe', '--min-trades', '10',
              ...sess.args
            ]);
          }
        }
      }
    }
  }

  const results = loadAllResults('v2-sweep');
  const ranked = rankResults(results);
  const summary = writePhaseSummary('v2-sweep', ranked);
  printRankedTable(ranked);
  return summary;
}

function phaseV2Timeframe() {
  console.log(chalk.blue.bold('\n═══ V2 Phase: Timeframe Comparison ═══'));

  const summaryPath = path.join(RESULTS_BASE, 'v2-sweep', 'phase-summary.json');
  if (!fs.existsSync(summaryPath)) {
    console.log(chalk.red('  v2-sweep must complete first. Run --phase v2-sweep'));
    return null;
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const topConfigs = summary.topConfigs.slice(0, args.top);

  if (topConfigs.length === 0) {
    console.log(chalk.red('  No configs from v2-sweep phase'));
    return null;
  }

  console.log(chalk.gray(`  Using top ${topConfigs.length} configs from v2-sweep phase`));

  const timeframes = ['1m', '5m', '15m'];
  let completed = 0;
  const total = topConfigs.length * timeframes.length;

  for (const cfg of topConfigs) {
    for (const tf of timeframes) {
      completed++;
      const sessFlag = cfg.config.sessions ? ['--sessions', cfg.config.sessions.join(',')] : [];
      const sl = cfg.config.sl || 20;
      const tp = cfg.config.tp || 40;
      const cd = cfg.config.cooldownCandles || 10;
      const mv = cfg.config.minNonHoldVotes || 5;
      const name = `sl${sl}_tp${tp}_cd${cd}_mv${mv}_${tf}_${cfg.config.sessions ? 'rth' : 'all'}`;
      console.log(chalk.gray(`\n  [${completed}/${total}]`));
      runOptimizer(name, 'v2-timeframe', [
        '--pop', '150', '--gen', '50',
        '--stop-loss', sl.toString(), '--take-profit', tp.toString(),
        '--cooldown', cd.toString(), '--min-votes', mv.toString(),
        '--timeframe', tf,
        '--futures-preset',
        '--fitness-mode', 'sharpe', '--min-trades', '10',
        ...sessFlag
      ]);
    }
  }

  const results = loadAllResults('v2-timeframe');
  const ranked = rankResults(results);
  const phaseSummary = writePhaseSummary('v2-timeframe', ranked);
  printRankedTable(ranked);
  return phaseSummary;
}

function phaseV2Votes() {
  console.log(chalk.blue.bold('\n═══ V2 Phase: Min Votes Sweep ═══'));
  console.log(chalk.gray('Dedicated minVotes sweep: [3, 5, 7, 10] × SL [20, 30] × TP [40, 60]'));

  const minVotesList = [3, 5, 7, 10];
  const stopLosses = [20, 30];
  const takeProfits = [40, 60];

  const total = minVotesList.length * stopLosses.length * takeProfits.length;
  let completed = 0;

  for (const mv of minVotesList) {
    for (const sl of stopLosses) {
      for (const tp of takeProfits) {
        completed++;
        const name = `mv${mv}_sl${sl}_tp${tp}`;
        console.log(chalk.gray(`\n  [${completed}/${total}]`));
        runOptimizer(name, 'v2-votes', [
          '--pop', '150', '--gen', '50',
          '--stop-loss', sl.toString(), '--take-profit', tp.toString(),
          '--min-votes', mv.toString(),
          '--futures-preset',
          '--fitness-mode', 'sharpe', '--min-trades', '10'
        ]);
      }
    }
  }

  const results = loadAllResults('v2-votes');
  const ranked = rankResults(results);
  const summary = writePhaseSummary('v2-votes', ranked);
  printRankedTable(ranked);
  return summary;
}

function phaseV2Heavy() {
  console.log(chalk.blue.bold('\n═══ V2 Phase: Heavy Optimization ═══'));

  let sourcePhase = null;
  for (const p of ['v2-timeframe', 'v2-sweep']) {
    if (fs.existsSync(path.join(RESULTS_BASE, p, 'phase-summary.json'))) {
      sourcePhase = p;
      break;
    }
  }

  if (!sourcePhase) {
    console.log(chalk.red('  v2-sweep or v2-timeframe must complete first'));
    return null;
  }

  const summary = JSON.parse(fs.readFileSync(path.join(RESULTS_BASE, sourcePhase, 'phase-summary.json'), 'utf8'));
  const topConfigs = summary.topConfigs.slice(0, args.top);

  console.log(chalk.gray(`  Using top ${topConfigs.length} configs from ${sourcePhase} phase`));
  console.log(chalk.gray('  Heavy params: pop=300, gen=100, runs=3'));

  let completed = 0;
  const total = topConfigs.length;

  for (const cfg of topConfigs) {
    completed++;
    const sessFlag = cfg.config.sessions ? ['--sessions', cfg.config.sessions.join(',')] : [];
    const sl = cfg.config.sl || 20;
    const tp = cfg.config.tp || 40;
    const cd = cfg.config.cooldownCandles || 10;
    const mv = cfg.config.minNonHoldVotes || 5;
    const tf = cfg.config.timeframe || '5m';
    const name = `heavy_sl${sl}_tp${tp}_cd${cd}_mv${mv}_${tf}_${cfg.config.sessions ? 'rth' : 'all'}`;
    console.log(chalk.gray(`\n  [${completed}/${total}]`));
    runOptimizer(name, 'v2-heavy', [
      '--pop', '300', '--gen', '100', '--runs', '3',
      '--stop-loss', sl.toString(), '--take-profit', tp.toString(),
      '--cooldown', cd.toString(), '--min-votes', mv.toString(),
      '--timeframe', tf,
      '--futures-preset',
      '--fitness-mode', 'sharpe', '--min-trades', '10',
      ...sessFlag
    ]);
  }

  const results = loadAllResults('v2-heavy');
  const ranked = rankResults(results);
  const phaseSummary = writePhaseSummary('v2-heavy', ranked);
  printRankedTable(ranked);
  return phaseSummary;
}

function phaseV2WalkForward() {
  console.log(chalk.blue.bold('\n═══ V2 Phase: Walk-Forward Validation ═══'));

  let sourcePhase = null;
  for (const p of ['v2-heavy', 'v2-timeframe', 'v2-sweep']) {
    if (fs.existsSync(path.join(RESULTS_BASE, p, 'phase-summary.json'))) {
      sourcePhase = p;
      break;
    }
  }

  if (!sourcePhase) {
    console.log(chalk.red('  At least v2-sweep must complete first'));
    return null;
  }

  const summary = JSON.parse(fs.readFileSync(path.join(RESULTS_BASE, sourcePhase, 'phase-summary.json'), 'utf8'));
  const topConfigs = summary.topConfigs.slice(0, args.top);

  console.log(chalk.gray(`  Using top ${topConfigs.length} configs from ${sourcePhase} phase`));

  let completed = 0;
  const total = topConfigs.length;

  for (const cfg of topConfigs) {
    completed++;
    const sessFlag = cfg.config.sessions ? ['--sessions', cfg.config.sessions.join(',')] : [];
    const sl = cfg.config.sl || 20;
    const tp = cfg.config.tp || 40;
    const cd = cfg.config.cooldownCandles || 10;
    const mv = cfg.config.minNonHoldVotes || 5;
    const tf = cfg.config.timeframe || '5m';
    const name = `wf_sl${sl}_tp${tp}_cd${cd}_mv${mv}_${tf}_${cfg.config.sessions ? 'rth' : 'all'}`;
    console.log(chalk.gray(`\n  [${completed}/${total}]`));
    runOptimizer(name, 'v2-walk-forward', [
      '--pop', '150', '--gen', '50',
      '--stop-loss', sl.toString(), '--take-profit', tp.toString(),
      '--cooldown', cd.toString(), '--min-votes', mv.toString(),
      '--timeframe', tf,
      '--futures-preset',
      '--fitness-mode', 'sharpe', '--min-trades', '10',
      '--walk-forward',
      ...sessFlag
    ]);
  }

  const results = loadAllResults('v2-walk-forward');

  // Summarize walk-forward go/no-go
  console.log(chalk.blue.bold('\n  Walk-Forward Go/No-Go Assessment:'));
  for (const r of results) {
    const wf = r.walkForwardResults;
    if (!wf) {
      console.log(chalk.gray(`    ${r._filename}: no walk-forward data`));
      continue;
    }
    const positive = wf.positiveSplits;
    const wfTotal = wf.totalSplits;
    const verdict = positive >= 2 ? chalk.green.bold('GO') : chalk.red.bold('NO-GO');
    console.log(`    ${r._filename}: ${positive}/${wfTotal} positive splits — ${verdict}`);

    if (wf.splits) {
      for (const split of wf.splits) {
        const color = split.testSharpe > 0 ? chalk.green : chalk.red;
        console.log(color(`      ${split.name}: Sharpe=${split.testSharpe.toFixed(4)}, PnL=$${split.testPnL.toFixed(0)}, Trades=${split.testTrades}`));
      }
    }
  }

  const ranked = rankResults(results);
  const phaseSummary = writePhaseSummary('v2-walk-forward', ranked);
  return phaseSummary;
}

function phaseV2Window() {
  console.log(chalk.blue.bold('\n═══ V2 Phase: Training Window Length ═══'));
  console.log(chalk.gray('Same config, same test period (2025-H2), different training start dates'));
  console.log(chalk.gray('Tests both GO configs from walk-forward: cd10/mv7 and cd20/mv7'));

  // Fixed test period: 2025-07-01 to 2025-12-24
  // train-pct is calculated so split falls at ~2025-07-01
  const testEnd = '2025-12-24';
  const windows = [
    { name: '6m',  start: '2025-01-01', trainPct: 0.50,  months: 6 },
    { name: '12m', start: '2024-07-01', trainPct: 0.667, months: 12 },
    { name: '18m', start: '2024-01-01', trainPct: 0.75,  months: 18 },
    { name: '30m', start: '2023-01-01', trainPct: 0.833, months: 30 },
    { name: '42m', start: '2022-01-01', trainPct: 0.875, months: 42 },
  ];

  const configs = [
    { name: 'cd10_mv7', cooldown: '10', minVotes: '7' },
    { name: 'cd20_mv7', cooldown: '20', minVotes: '7' },
  ];

  const total = windows.length * configs.length;
  let completed = 0;

  for (const win of windows) {
    for (const cfg of configs) {
      completed++;
      const name = `win${win.name}_${cfg.name}`;
      console.log(chalk.gray(`\n  [${completed}/${total}] ${win.months}mo training (${win.start} → 2025-07-01), test 2025-07-01 → ${testEnd}`));
      runOptimizer(name, 'v2-window', [
        '--pop', '150', '--gen', '50',
        '--stop-loss', '30', '--take-profit', '60',
        '--cooldown', cfg.cooldown, '--min-votes', cfg.minVotes,
        '--futures-preset',
        '--train-pct', win.trainPct.toString(),
        '--fitness-mode', 'sharpe', '--min-trades', '10'
      ], { start: win.start, end: testEnd });
    }
  }

  // Custom summary with window-specific analysis
  const results = loadAllResults('v2-window');

  console.log(chalk.blue.bold('\n  Training Window Analysis:'));
  console.log(chalk.blue('  Window   Config      Train Sharpe   Test Sharpe   Test PnL    Trades  WinRate'));
  console.log(chalk.gray('  ' + '─'.repeat(80)));

  for (const win of windows) {
    for (const cfg of configs) {
      const name = `win${win.name}_${cfg.name}`;
      const r = results.find(r => r._filename === name);
      if (!r) { console.log(chalk.gray(`  ${win.name.padEnd(7)} ${cfg.name.padEnd(10)}  — no data`)); continue; }

      const trainSharpe = (r.trainResults?.sharpeRatio ?? 0).toFixed(4);
      const testSharpe = (r.testResults?.sharpeRatio ?? 0).toFixed(4);
      const testPnL = `$${(r.testResults?.totalPnL ?? 0).toFixed(0)}`;
      const trades = (r.testResults?.numTrades ?? 0).toString();
      const wr = `${((r.testResults?.winRate ?? 0) * 100).toFixed(1)}%`;
      const color = (r.testResults?.sharpeRatio ?? 0) > 0 ? chalk.green : chalk.red;
      console.log(color(`  ${win.name.padEnd(7)} ${cfg.name.padEnd(10)}  ${trainSharpe.padStart(12)}  ${testSharpe.padStart(11)}  ${testPnL.padStart(9)}  ${trades.padStart(7)}  ${wr.padStart(7)}`));
    }
  }

  const ranked = rankResults(results);
  const phaseSummary = writePhaseSummary('v2-window', ranked);
  return phaseSummary;
}

// ─── Campaign Summary ─────────────────────────────────────────────────────

function writeCampaignSummary() {
  const phases = ['baseline', 'sweep', 'entry', 'timeframe', 'heavy', 'walk-forward', 'points',
                   'v2-baseline', 'v2-sweep', 'v2-timeframe', 'v2-votes', 'v2-heavy', 'v2-walk-forward', 'v2-window'];
  const summary = { timestamp: new Date().toISOString(), phases: {} };

  for (const phase of phases) {
    const summaryPath = path.join(RESULTS_BASE, phase, 'phase-summary.json');
    if (fs.existsSync(summaryPath)) {
      summary.phases[phase] = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    }
  }

  fs.writeFileSync(path.join(RESULTS_BASE, 'campaign-summary.json'), JSON.stringify(summary, null, 2));
  console.log(chalk.green(`\nCampaign summary written to ${path.join(RESULTS_BASE, 'campaign-summary.json')}`));
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(chalk.blue.bold('\nMSTGAM Optimization Campaign'));
  console.log(chalk.gray('─'.repeat(55)));
  console.log(chalk.white(`Ticker:  ${args.ticker}`));
  console.log(chalk.white(`Period:  ${args.start} to ${args.end}`));
  console.log(chalk.white(`Phase:   ${args.phase}`));
  console.log(chalk.white(`Top N:   ${args.top}`));
  if (args.dryRun) console.log(chalk.cyan('DRY RUN — no commands will be executed'));
  console.log(chalk.gray('─'.repeat(55)));

  const startTime = Date.now();

  if (args.phase === 'all' || args.phase === 'baseline') {
    phaseBaseline();
  }
  if (args.phase === 'all' || args.phase === 'sweep') {
    phaseSweep();
  }
  if (args.phase === 'all' || args.phase === 'entry') {
    phaseEntry();
  }
  if (args.phase === 'all' || args.phase === 'timeframe') {
    phaseTimeframe();
  }
  if (args.phase === 'all' || args.phase === 'heavy') {
    phaseHeavy();
  }
  if (args.phase === 'all' || args.phase === 'walk-forward') {
    phaseWalkForward();
  }
  if (args.phase === 'points') {
    phasePoints();
  }

  // V2 phases
  if (args.phase === 'v2-all' || args.phase === 'v2-baseline') {
    phaseV2Baseline();
  }
  if (args.phase === 'v2-all' || args.phase === 'v2-sweep') {
    phaseV2Sweep();
  }
  if (args.phase === 'v2-all' || args.phase === 'v2-timeframe') {
    phaseV2Timeframe();
  }
  if (args.phase === 'v2-all' || args.phase === 'v2-votes') {
    phaseV2Votes();
  }
  if (args.phase === 'v2-all' || args.phase === 'v2-heavy') {
    phaseV2Heavy();
  }
  if (args.phase === 'v2-all' || args.phase === 'v2-walk-forward') {
    phaseV2WalkForward();
  }
  if (args.phase === 'v2-all' || args.phase === 'v2-window') {
    phaseV2Window();
  }

  writeCampaignSummary();

  const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(chalk.green.bold(`\nCampaign ${args.phase} completed in ${totalElapsed} minutes`));
}

main().catch(err => {
  console.error(chalk.red('\nFatal error:'), err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
