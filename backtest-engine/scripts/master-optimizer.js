#!/usr/bin/env node

/**
 * Master Strategy Optimizer
 *
 * Runs exhaustive parameter sweeps across all trading strategies
 * with parallel execution, resume capability, and comprehensive result aggregation.
 *
 * Usage:
 *   node scripts/master-optimizer.js [options]
 *
 * Options:
 *   --strategy <name>   Run specific strategy only (or 'all')
 *   --concurrency <n>   Number of parallel tests (default: 4)
 *   --dry-run          Show what would be run without executing
 *   --resume           Skip already-completed tests (default: true)
 *   --quick            Run reduced parameter grid for quick testing
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// ========================================
// STRATEGY PARAMETER GRIDS
// ========================================

const STRATEGY_GRIDS = {
  'gex-recoil': {
    base: {
      strategy: 'gex-recoil',
      timeframe: '15m'
    },
    params: {
      targetPoints: [10, 15, 20, 25, 30, 40, 50],
      stopBuffer: [5, 8, 10, 12, 15],
      useTrailingStop: [true, false]
    },
    conditionalParams: {
      // Only apply these when useTrailingStop is true
      trailingStop: {
        condition: { useTrailingStop: true },
        params: {
          trailingTrigger: [8, 10, 12, 15],
          trailingOffset: [3, 5, 8]
        }
      }
    }
  },

  'gex-recoil-lt-filters': {
    base: {
      strategy: 'gex-recoil',
      timeframe: '15m',
      targetPoints: 25,
      stopBuffer: 10,
      useTrailingStop: true,
      trailingTrigger: 10,
      trailingOffset: 5,
      filterByLtConfig: true
    },
    params: {
      requiredLtSentiment: ['BULLISH', 'BEARISH', null],
      minLtSpacing: ['TIGHT', 'MEDIUM', 'WIDE', null],
      ltFilterProfile: ['conservative', 'aggressive']
    }
  },

  'gex-recoil-enhanced': {
    base: {
      strategy: 'gex-recoil-enhanced',
      timeframe: '15m',
      targetPoints: 25,
      stopBuffer: 10,
      useTrailingStop: true,
      trailingTrigger: 10,
      trailingOffset: 5
    },
    params: {
      useGexRegimeFilter: [true, false],
      blockedRegimes: ['', 'strong_negative', 'strong_negative,negative', 'positive,strong_positive'],
      useIvFilter: [true, false]
    }
  },

  'gex-ldpm-confluence': {
    base: {
      strategy: 'gex-ldpm-confluence',
      timeframe: '15m'
    },
    params: {
      confluenceThreshold: [5, 8, 10, 12, 15],
      entryDistance: [10, 15, 20, 25],
      stopLossPoints: [30, 40, 50],
      useLtOrderingFilter: [true, false],
      requireLt4BelowLt5: [true, false]
    }
  },

  'gex-ldpm-confluence-pullback': {
    base: {
      strategy: 'gex-ldpm-confluence-pullback',
      timeframe: '15m',
      confluenceThreshold: 10,
      entryDistance: 15
    },
    params: {
      stopLossPoints: [30, 40, 50],
      maxReclaimBars: [2, 3, 4],
      blockedLevelTypes: ['', 'resistance_2', 'resistance_2,resistance_3'],
      blockedRegimes: ['', 'strong_negative'],
      sellStartHourUtc: [0, 13, 15]
    }
  },

  'contrarian-bounce': {
    base: {
      strategy: 'contrarian-bounce',
      timeframe: '15m',
      useTrailingStop: true
    },
    params: {
      stopBuffer: [10, 12, 15],
      maxDistanceBelowFlip: [30, 35, 40, 45],
      trailingTrigger: [6, 8, 10],
      trailingOffset: [2, 3, 4]
    }
  },

  'gex-scalp': {
    base: {
      strategy: 'gex-scalp',
      timeframe: '1m',
      useTrailingStop: true
    },
    params: {
      touchThreshold: [2, 3, 4, 5],
      targetPoints: [5, 7, 10],
      stopLossPoints: [2, 3, 4],
      trailingTrigger: [2, 3, 4],
      trailingOffset: [1, 2],
      gexLevels: ['1', '1,2'],
      blockedSessions: ['', 'overnight', 'overnight,afterhours']
    }
  },

  'ict-smc': {
    base: {
      strategy: 'ict-smc',
      timeframe: '5m'
    },
    params: {
      signalTypes: ['M_PATTERN,W_PATTERN,OB_BOUNCE,MOMENTUM_CONTINUATION', 'OB_BOUNCE', 'M_PATTERN,W_PATTERN'],
      structureTimeframe: ['1h', '4h'],
      entryTimeframe: ['1m', '5m'],
      targetMethod: ['structure', 'rr_ratio'],
      defaultRr: [1.5, 2.0, 2.5, 3.0],
      gexProximityFilter: [true, false],
      ltfConfirmation: [true, false]
    }
  }
};

// Quick mode uses reduced parameter grids
const QUICK_GRIDS = {
  'gex-recoil': {
    base: { strategy: 'gex-recoil', timeframe: '15m' },
    params: {
      targetPoints: [20, 30],
      stopBuffer: [10, 15],
      useTrailingStop: [true, false]
    }
  },
  'gex-scalp': {
    base: { strategy: 'gex-scalp', timeframe: '1m', useTrailingStop: true },
    params: {
      targetPoints: [5, 7],
      stopLossPoints: [3, 4],
      trailingTrigger: [3],
      trailingOffset: [1]
    }
  },
  'contrarian-bounce': {
    base: { strategy: 'contrarian-bounce', timeframe: '15m', useTrailingStop: true },
    params: {
      stopBuffer: [12],
      maxDistanceBelowFlip: [35],
      trailingTrigger: [8],
      trailingOffset: [3]
    }
  }
};

// ========================================
// UTILITY FUNCTIONS
// ========================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    strategy: 'all',
    concurrency: 4,
    dryRun: false,
    resume: true,
    quick: false,
    ticker: 'NQ',
    startDate: '2025-01-01',
    endDate: '2025-12-25',
    outputDir: path.join(projectRoot, 'results', 'optimization-2025')
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--strategy':
        config.strategy = args[++i];
        break;
      case '--concurrency':
        config.concurrency = parseInt(args[++i], 10);
        break;
      case '--dry-run':
        config.dryRun = true;
        break;
      case '--no-resume':
        config.resume = false;
        break;
      case '--quick':
        config.quick = true;
        break;
      case '--ticker':
        config.ticker = args[++i];
        break;
      case '--start':
        config.startDate = args[++i];
        break;
      case '--end':
        config.endDate = args[++i];
        break;
      case '--output-dir':
        config.outputDir = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
Master Strategy Optimizer

Runs exhaustive parameter sweeps across all trading strategies.

Usage:
  node scripts/master-optimizer.js [options]

Options:
  --strategy <name>   Strategy to test: all, gex-recoil, gex-scalp, etc.
  --concurrency <n>   Parallel tests (default: 4)
  --dry-run          Preview tests without executing
  --no-resume        Re-run all tests
  --quick            Use reduced parameter grid
  --ticker <symbol>  Ticker symbol (default: NQ)
  --start <date>     Start date YYYY-MM-DD (default: 2025-01-01)
  --end <date>       End date YYYY-MM-DD (default: 2025-12-25)
  --output-dir <path> Output directory

Available Strategies:
  ${Object.keys(STRATEGY_GRIDS).join('\n  ')}
`);
        process.exit(0);
    }
  }

  return config;
}

function generateCombinations(grid) {
  const combinations = [];
  const paramNames = Object.keys(grid.params);

  function recurse(index, current) {
    if (index === paramNames.length) {
      // Check conditional params
      let combo = { ...grid.base, ...current };

      if (grid.conditionalParams) {
        for (const [key, conditional] of Object.entries(grid.conditionalParams)) {
          let conditionMet = true;
          for (const [condKey, condVal] of Object.entries(conditional.condition)) {
            if (current[condKey] !== condVal) {
              conditionMet = false;
              break;
            }
          }

          if (conditionMet) {
            // Generate sub-combinations for conditional params
            const subCombos = generateConditionalCombos(conditional.params);
            for (const subCombo of subCombos) {
              combinations.push({ ...combo, ...subCombo });
            }
            return; // Handled by conditional expansion
          }
        }
      }

      combinations.push(combo);
      return;
    }

    const paramName = paramNames[index];
    const values = grid.params[paramName];

    for (const value of values) {
      recurse(index + 1, { ...current, [paramName]: value });
    }
  }

  recurse(0, {});
  return combinations;
}

function generateConditionalCombos(params) {
  const combos = [];
  const names = Object.keys(params);

  function recurse(index, current) {
    if (index === names.length) {
      combos.push({ ...current });
      return;
    }
    for (const val of params[names[index]]) {
      recurse(index + 1, { ...current, [names[index]]: val });
    }
  }

  recurse(0, {});
  return combos;
}

function comboToId(combo) {
  const parts = [];
  const sortedKeys = Object.keys(combo).filter(k => k !== 'strategy' && k !== 'timeframe').sort();

  for (const key of sortedKeys) {
    let val = combo[key];
    if (val === null) val = 'null';
    if (val === true) val = 'T';
    if (val === false) val = 'F';
    if (typeof val === 'string' && val.includes(',')) {
      val = val.replace(/,/g, '+');
    }

    // Abbreviate key names
    const abbrev = key
      .replace('trailing', 'tr')
      .replace('Trigger', 'Trig')
      .replace('Offset', 'Off')
      .replace('Points', 'Pts')
      .replace('target', 'tgt')
      .replace('stop', 'stp')
      .replace('Buffer', 'Buf')
      .replace('useTrailingStop', 'trStop')
      .replace('confluence', 'conf')
      .replace('Threshold', 'Thr')
      .replace('Distance', 'Dist')
      .replace('Filter', 'Flt')
      .replace('Spacing', 'Spc')
      .replace('Sentiment', 'Sent')
      .replace('required', 'req')
      .replace('blocked', 'blk')
      .replace('Sessions', 'Sess')
      .replace('Regimes', 'Reg')
      .replace('Levels', 'Lvl');

    parts.push(`${abbrev}${val}`);
  }

  return parts.join('_');
}

function comboToArgs(combo, config) {
  const args = [
    'index.js',
    '--ticker', config.ticker,
    '--start', config.startDate,
    '--end', config.endDate,
    '--quiet'
  ];

  // Map combo params to CLI args
  const paramMap = {
    strategy: '--strategy',
    timeframe: '--timeframe',
    targetPoints: '--target-points',
    stopBuffer: '--stop-buffer',
    stopLossPoints: '--stop-loss-points',
    maxRisk: '--max-risk',
    useTrailingStop: '--use-trailing-stop',
    trailingTrigger: '--trailing-trigger',
    trailingOffset: '--trailing-offset',
    useLiquidityFilter: '--use-liquidity-filter',
    filterByLtConfig: '--filter-by-lt-config',
    ltFilterProfile: '--lt-filter-profile',
    requiredLtSentiment: '--required-lt-sentiment',
    minLtSpacing: '--min-lt-spacing',
    blockedLtOrderings: '--blocked-lt-orderings',
    useGexRegimeFilter: '--use-gex-regime-filter',
    blockedRegimes: '--blocked-regimes',
    useIvFilter: '--use-iv-filter',
    confluenceThreshold: '--confluence-threshold',
    entryDistance: '--entry-distance',
    useLtOrderingFilter: '--use-lt-ordering-filter',
    requireLt4BelowLt5: '--require-lt4-below-lt5',
    maxReclaimBars: '--max-reclaim-bars',
    blockedLevelTypes: '--blocked-level-types',
    sellStartHourUtc: '--sell-start-hour-utc',
    maxDistanceBelowFlip: '--max-distance-below-flip',
    touchThreshold: '--touch-threshold',
    gexLevels: '--gex-levels',
    blockedSessions: '--blocked-sessions',
    signalTypes: '--signal-types',
    structureTimeframe: '--structure-timeframe',
    entryTimeframe: '--entry-timeframe',
    targetMethod: '--target-method',
    defaultRr: '--default-rr',
    gexProximityFilter: '--gex-proximity-filter',
    gexProximityThreshold: '--gex-proximity-threshold',
    ltfConfirmation: '--ltf-confirmation'
  };

  for (const [param, value] of Object.entries(combo)) {
    if (value === null || value === undefined || value === '') continue;

    const cliArg = paramMap[param];
    if (!cliArg) continue;

    if (typeof value === 'boolean') {
      if (value) args.push(cliArg);
    } else {
      args.push(cliArg, String(value));
    }
  }

  return args;
}

function runBacktest(combo, outputFile, config) {
  return new Promise((resolve) => {
    const args = comboToArgs(combo, config);
    args.push('--output', outputFile);

    const startTime = Date.now();
    const proc = spawn('node', args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      const duration = (Date.now() - startTime) / 1000;
      if (code === 0) {
        resolve({ success: true, duration, outputFile });
      } else {
        resolve({ success: false, duration, error: stderr || `Exit code ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

function extractMetrics(resultsPath) {
  try {
    const data = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
    const perf = data.performance;

    return {
      trades: perf?.basic?.totalTrades || 0,
      winRate: perf?.basic?.winRate || 0,
      totalPnL: perf?.basic?.totalPnL || 0,
      avgWin: perf?.basic?.averageWin || 0,
      avgLoss: perf?.basic?.averageLoss || 0,
      profitFactor: perf?.basic?.profitFactor || 0,
      maxDrawdown: perf?.basic?.maxDrawdown || 0,
      sharpe: perf?.basic?.sharpeRatio || 0,
      sortino: perf?.risk?.sortinoRatio || 0,
      calmar: perf?.advanced?.calmarRatio || 0,
      expectancy: perf?.advanced?.expectancy || 0
    };
  } catch {
    return null;
  }
}

function calculateCompositeScore(metrics) {
  if (!metrics || metrics.trades < 20) return -Infinity;

  // Weighted composite score
  const score =
    (metrics.sharpe || 0) * 0.25 +
    (metrics.profitFactor || 0) * 0.20 +
    (metrics.winRate / 100 || 0) * 0.15 +
    (1 - Math.min(Math.abs(metrics.maxDrawdown) / 100, 1)) * 0.15 +
    (Math.min(metrics.totalPnL / 50000, 1)) * 0.10 +
    (Math.min(metrics.trades / 500, 1)) * 0.10 +
    (metrics.sortino || 0) * 0.05;

  return score;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

async function runParallel(tasks, concurrency) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const taskIndex = index++;
      const result = await tasks[taskIndex]();
      results[taskIndex] = result;
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

// ========================================
// MAIN EXECUTION
// ========================================

async function main() {
  const config = parseArgs();
  const grids = config.quick ? QUICK_GRIDS : STRATEGY_GRIDS;

  console.log('========================================');
  console.log(' MASTER STRATEGY OPTIMIZER');
  console.log('========================================\n');

  console.log(`Ticker:      ${config.ticker}`);
  console.log(`Date Range:  ${config.startDate} to ${config.endDate}`);
  console.log(`Concurrency: ${config.concurrency} parallel tests`);
  console.log(`Mode:        ${config.quick ? 'QUICK (reduced grid)' : 'FULL (exhaustive)'}`);
  console.log(`Resume:      ${config.resume ? 'Yes' : 'No'}`);
  console.log(`Output:      ${config.outputDir}`);
  console.log('');

  // Determine which strategies to run
  const strategiesToRun = config.strategy === 'all'
    ? Object.keys(grids)
    : [config.strategy];

  // Generate all combinations
  const allTests = [];

  for (const strategyKey of strategiesToRun) {
    const grid = grids[strategyKey];
    if (!grid) {
      console.log(`Warning: Unknown strategy '${strategyKey}', skipping`);
      continue;
    }

    const combos = generateCombinations(grid);
    console.log(`${strategyKey}: ${combos.length} combinations`);

    for (const combo of combos) {
      allTests.push({
        strategyKey,
        combo,
        id: comboToId(combo)
      });
    }
  }

  console.log(`\nTotal tests: ${allTests.length}\n`);

  if (config.dryRun) {
    console.log('DRY RUN - First 10 tests that would run:');
    for (const test of allTests.slice(0, 10)) {
      console.log(`  [${test.strategyKey}] ${test.id}`);
    }
    if (allTests.length > 10) {
      console.log(`  ... and ${allTests.length - 10} more`);
    }
    return;
  }

  // Create output directories
  for (const strategyKey of strategiesToRun) {
    const strategyDir = path.join(config.outputDir, 'strategies', strategyKey.replace(/[^a-z0-9-]/gi, '-'));
    fs.mkdirSync(strategyDir, { recursive: true });
  }
  fs.mkdirSync(path.join(config.outputDir, 'summaries'), { recursive: true });

  // Filter out completed tests if resuming
  let testsToRun = allTests;
  let skipped = 0;

  if (config.resume) {
    testsToRun = allTests.filter(test => {
      const strategyDir = path.join(config.outputDir, 'strategies', test.strategyKey.replace(/[^a-z0-9-]/gi, '-'));
      const outputFile = path.join(strategyDir, `${test.id}.json`);
      if (fs.existsSync(outputFile)) {
        skipped++;
        return false;
      }
      return true;
    });
  }

  if (skipped > 0) {
    console.log(`Skipping ${skipped} already-completed tests`);
  }
  console.log(`Running ${testsToRun.length} tests...\n`);

  if (testsToRun.length === 0) {
    console.log('All tests already completed!');
    await generateSummaries(config, strategiesToRun, allTests);
    return;
  }

  // Prepare tasks
  const durations = [];
  let completed = 0;
  let failed = 0;
  const startTime = Date.now();

  const tasks = testsToRun.map((test, testIndex) => async () => {
    const strategyDir = path.join(config.outputDir, 'strategies', test.strategyKey.replace(/[^a-z0-9-]/gi, '-'));
    const outputFile = path.join(strategyDir, `${test.id}.json`);

    const result = await runBacktest(test.combo, outputFile, config);

    if (result.success) {
      durations.push(result.duration);
      completed++;
    } else {
      failed++;
    }

    // Progress update
    const progress = ((completed + failed + skipped) / allTests.length * 100).toFixed(1);
    const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 60;
    const remaining = (testsToRun.length - completed - failed) * avgDuration;

    process.stdout.write(
      `\r[${completed + failed + skipped}/${allTests.length}] ${progress}% | ` +
      `${test.strategyKey} | ETA: ${formatDuration(remaining)}          `
    );

    return { test, result };
  });

  // Run with concurrency
  await runParallel(tasks, config.concurrency);

  const totalTime = (Date.now() - startTime) / 1000;
  console.log(`\n\nCompleted: ${completed} | Failed: ${failed} | Skipped: ${skipped}`);
  console.log(`Total time: ${formatDuration(totalTime)}`);

  // Generate summaries
  await generateSummaries(config, strategiesToRun, allTests);
}

async function generateSummaries(config, strategies, allTests) {
  console.log('\n========================================');
  console.log(' GENERATING SUMMARIES');
  console.log('========================================\n');

  const allResults = [];

  for (const strategyKey of strategies) {
    const strategyDir = path.join(config.outputDir, 'strategies', strategyKey.replace(/[^a-z0-9-]/gi, '-'));
    const strategyResults = [];

    const tests = allTests.filter(t => t.strategyKey === strategyKey);

    for (const test of tests) {
      const outputFile = path.join(strategyDir, `${test.id}.json`);
      if (!fs.existsSync(outputFile)) continue;

      const metrics = extractMetrics(outputFile);
      if (!metrics) continue;

      const score = calculateCompositeScore(metrics);
      strategyResults.push({
        strategyKey,
        id: test.id,
        combo: test.combo,
        ...metrics,
        compositeScore: score
      });
    }

    // Sort by composite score
    strategyResults.sort((a, b) => b.compositeScore - a.compositeScore);

    // Write strategy summary CSV
    const csvPath = path.join(config.outputDir, 'summaries', `${strategyKey}-summary.csv`);
    const header = 'rank,id,trades,win_rate,total_pnl,profit_factor,max_dd,sharpe,sortino,composite_score\n';
    const rows = strategyResults.map((r, i) =>
      `${i+1},${r.id},${r.trades},${r.winRate.toFixed(2)},${r.totalPnL.toFixed(2)},${r.profitFactor.toFixed(2)},${r.maxDrawdown.toFixed(2)},${r.sharpe.toFixed(3)},${r.sortino.toFixed(3)},${r.compositeScore.toFixed(4)}`
    ).join('\n');

    fs.writeFileSync(csvPath, header + rows);
    console.log(`${strategyKey}: ${strategyResults.length} results → ${csvPath}`);

    // Show top 5
    console.log(`  Top 5 configurations:`);
    strategyResults.slice(0, 5).forEach((r, i) => {
      console.log(`    ${i+1}. ${r.id} | P&L: $${r.totalPnL.toFixed(0)} | WR: ${r.winRate.toFixed(1)}% | Sharpe: ${r.sharpe.toFixed(2)} | Score: ${r.compositeScore.toFixed(3)}`);
    });
    console.log('');

    allResults.push(...strategyResults);
  }

  // Write combined ranking
  allResults.sort((a, b) => b.compositeScore - a.compositeScore);

  const combinedPath = path.join(config.outputDir, 'summaries', 'all-strategies-ranked.csv');
  const combinedHeader = 'rank,strategy,id,trades,win_rate,total_pnl,profit_factor,max_dd,sharpe,sortino,composite_score\n';
  const combinedRows = allResults.map((r, i) =>
    `${i+1},${r.strategyKey},${r.id},${r.trades},${r.winRate.toFixed(2)},${r.totalPnL.toFixed(2)},${r.profitFactor.toFixed(2)},${r.maxDrawdown.toFixed(2)},${r.sharpe.toFixed(3)},${r.sortino.toFixed(3)},${r.compositeScore.toFixed(4)}`
  ).join('\n');

  fs.writeFileSync(combinedPath, combinedHeader + combinedRows);
  console.log(`\nCombined ranking: ${combinedPath}`);

  // Write JSON summary of top configs
  const topConfigs = {};
  for (const strategyKey of strategies) {
    const strategyResults = allResults.filter(r => r.strategyKey === strategyKey);
    if (strategyResults.length > 0) {
      topConfigs[strategyKey] = {
        best: strategyResults[0],
        top5: strategyResults.slice(0, 5)
      };
    }
  }

  const topConfigsPath = path.join(config.outputDir, 'summaries', 'optimal-configs.json');
  fs.writeFileSync(topConfigsPath, JSON.stringify(topConfigs, null, 2));
  console.log(`Optimal configs: ${topConfigsPath}`);

  // Overall top 10
  console.log('\n========================================');
  console.log(' TOP 10 CONFIGURATIONS (ALL STRATEGIES)');
  console.log('========================================\n');

  console.log('Rank | Strategy                    | P&L      | Win%  | Sharpe | Score');
  console.log('─'.repeat(75));

  allResults.slice(0, 10).forEach((r, i) => {
    const strat = r.strategyKey.padEnd(27);
    const pnl = `$${r.totalPnL.toFixed(0)}`.padStart(8);
    const wr = `${r.winRate.toFixed(1)}%`.padStart(6);
    const sharpe = r.sharpe.toFixed(2).padStart(6);
    const score = r.compositeScore.toFixed(3).padStart(6);
    console.log(`${String(i+1).padStart(4)} | ${strat} | ${pnl} | ${wr} | ${sharpe} | ${score}`);
  });

  console.log('\n========================================');
  console.log('          OPTIMIZATION COMPLETE');
  console.log('========================================\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
