#!/usr/bin/env node

/**
 * Trailing Stop Optimizer for GEX Scalp Strategy
 *
 * Based on probability matrix analysis showing:
 * - R1 Shorts have 60%+ edge at 30-50pt symmetric
 * - S1 Longs have ~55% edge at 20pt symmetric
 *
 * This script tests various trailing stop configurations to capture
 * profit when a trade achieves 20+ points of profitability.
 *
 * Usage:
 *   node scripts/trailing-stop-optimizer.js [options]
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Parameter configuration for trailing stop optimization
const PARAMS = {
  // Based on probability matrix: R1 shorts work best, S1 longs marginal
  directions: [
    { flag: '--shorts-only', label: 'R1_shorts' },
    { flag: '--longs-only', label: 'S1_longs' }
  ],

  // Stop losses: 25-50pt range based on MAE distribution (85-95% stay under these)
  stopLoss: [25, 30, 35, 40, 45, 50],

  // Targets: test both symmetric and asymmetric
  target: [20, 25, 30, 40],

  // Trailing configurations focused on 20pt profit capture
  trailingConfigs: [
    // No trailing (baseline)
    { useTrailing: false, trigger: null, offset: null, label: 'fixed' },

    // Early activation (15pt trigger)
    { useTrailing: true, trigger: 15, offset: 3, label: 't15o3' },
    { useTrailing: true, trigger: 15, offset: 5, label: 't15o5' },

    // Standard activation (20pt trigger) - main focus
    { useTrailing: true, trigger: 20, offset: 3, label: 't20o3' },
    { useTrailing: true, trigger: 20, offset: 5, label: 't20o5' },
    { useTrailing: true, trigger: 20, offset: 7, label: 't20o7' },
    { useTrailing: true, trigger: 20, offset: 10, label: 't20o10' },

    // Late activation (25pt trigger) - let winners run more
    { useTrailing: true, trigger: 25, offset: 5, label: 't25o5' },
    { useTrailing: true, trigger: 25, offset: 7, label: 't25o7' },
    { useTrailing: true, trigger: 25, offset: 10, label: 't25o10' },

    // Very late activation (30pt trigger)
    { useTrailing: true, trigger: 30, offset: 7, label: 't30o7' },
    { useTrailing: true, trigger: 30, offset: 10, label: 't30o10' }
  ]
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    dryRun: false,
    outputDir: path.join(projectRoot, 'results', 'trailing-optimizer'),
    resume: true,
    ticker: 'NQ',
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    shortsOnly: false,
    longsOnly: false
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') config.dryRun = true;
    else if (args[i] === '--output-dir' && args[i + 1]) config.outputDir = args[++i];
    else if (args[i] === '--no-resume') config.resume = false;
    else if (args[i] === '--ticker' && args[i + 1]) config.ticker = args[++i];
    else if (args[i] === '--start' && args[i + 1]) config.startDate = args[++i];
    else if (args[i] === '--end' && args[i + 1]) config.endDate = args[++i];
    else if (args[i] === '--shorts-only') config.shortsOnly = true;
    else if (args[i] === '--longs-only') config.longsOnly = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      const directions = config.shortsOnly || config.longsOnly ? 1 : PARAMS.directions.length;
      const totalTests = directions * PARAMS.stopLoss.length * PARAMS.target.length * PARAMS.trailingConfigs.length;
      console.log(`
Trailing Stop Optimizer for GEX Scalp Strategy

Tests trailing stop configurations focused on capturing 20pt+ profit.

Based on probability matrix analysis:
- R1 Shorts: 60%+ win rate at 30-50pt symmetric
- S1 Longs: ~55% win rate at 20pt symmetric

Usage:
  node scripts/trailing-stop-optimizer.js [options]

Options:
  --dry-run           Show what would be run without executing
  --output-dir <path> Custom output directory (default: results/trailing-optimizer)
  --no-resume         Re-run all tests
  --ticker <symbol>   Ticker symbol (default: NQ)
  --start <date>      Start date (default: 2025-01-01)
  --end <date>        End date (default: 2025-12-31)
  --shorts-only       Only test R1 shorts (recommended)
  --longs-only        Only test S1 longs

Parameter Ranges:
  Stop Loss:  ${PARAMS.stopLoss.join(', ')} points
  Target:     ${PARAMS.target.join(', ')} points
  Trailing:   ${PARAMS.trailingConfigs.map(c => c.label).join(', ')}
  Directions: ${config.shortsOnly ? 'R1 shorts only' : config.longsOnly ? 'S1 longs only' : 'Both R1 shorts and S1 longs'}
  Total Tests: ~${totalTests}
`);
      process.exit(0);
    }
  }

  return config;
}

function generateCombinations(config) {
  const combinations = [];

  let directions = PARAMS.directions;
  if (config.shortsOnly) directions = [{ flag: '--shorts-only', label: 'R1_shorts' }];
  if (config.longsOnly) directions = [{ flag: '--longs-only', label: 'S1_longs' }];

  for (const dir of directions) {
    for (const stopLoss of PARAMS.stopLoss) {
      for (const target of PARAMS.target) {
        for (const trailing of PARAMS.trailingConfigs) {
          combinations.push({
            direction: dir.label,
            directionFlag: dir.flag,
            stopLoss,
            target,
            useTrailing: trailing.useTrailing,
            trailingTrigger: trailing.trigger,
            trailingOffset: trailing.offset,
            id: `${dir.label}_sl${stopLoss}_tp${target}_${trailing.label}`
          });
        }
      }
    }
  }

  return combinations;
}

function runBacktest(combo, config) {
  return new Promise((resolve, reject) => {
    const outputFile = path.join(config.outputDir, `${combo.id}.json`);

    const args = [
      'index.js',
      '--ticker', config.ticker,
      '--start', config.startDate,
      '--end', config.endDate,
      '--strategy', 'gex-scalp',
      '--timeframe', '1m',
      combo.directionFlag,
      '--stop-loss-points', combo.stopLoss.toString(),
      '--target-points', combo.target.toString(),
      '--output', outputFile,
      '--quiet',
      '--no-second-resolution'  // Use 1-minute resolution for faster optimization
    ];

    if (combo.useTrailing) {
      args.push('--use-trailing-stop');
      args.push('--trailing-trigger', combo.trailingTrigger.toString());
      args.push('--trailing-offset', combo.trailingOffset.toString());
    } else {
      // Explicitly disable trailing stop (strategy defaults to enabled)
      args.push('--use-trailing-stop', 'false');
    }

    const startTime = Date.now();
    const proc = spawn('node', args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      const duration = (Date.now() - startTime) / 1000;
      if (code === 0) {
        resolve({ success: true, duration, outputFile });
      } else {
        resolve({ success: false, duration, error: stderr || stdout || `Exit code ${code}` });
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

    // Count exit reasons from trades
    let stopLossExits = 0;
    let takeProfitExits = 0;
    let trailingStopExits = 0;
    let timeoutExits = 0;
    let marketCloseExits = 0;

    if (data.trades) {
      data.trades.forEach(t => {
        if (t.exitReason === 'stop_loss') stopLossExits++;
        else if (t.exitReason === 'take_profit') takeProfitExits++;
        else if (t.exitReason === 'trailing_stop') trailingStopExits++;
        else if (t.exitReason === 'timeout' || t.exitReason === 'max_bars') timeoutExits++;
        else if (t.exitReason === 'market_close') marketCloseExits++;
      });
    }

    return {
      trades: perf.basic.totalTrades,
      winRate: perf.basic.winRate,
      totalPnL: perf.basic.totalPnL,
      avgTrade: perf.basic.avgTrade,
      profitFactor: perf.basic.profitFactor,
      maxDrawdown: perf.drawdown?.maxDrawdown || 0,
      sharpe: perf.risk?.sharpeRatio || 0,
      stopLossExits,
      takeProfitExits,
      trailingStopExits,
      timeoutExits,
      marketCloseExits
    };
  } catch (err) {
    return null;
  }
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function formatETA(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

async function main() {
  const config = parseArgs();
  const combinations = generateCombinations(config);

  console.log('════════════════════════════════════════════════════════════════════');
  console.log(' TRAILING STOP OPTIMIZER FOR GEX SCALP');
  console.log(' Focus: Capturing 20pt+ profit with optimal trailing configurations');
  console.log('════════════════════════════════════════════════════════════════════\n');

  console.log(`Ticker:      ${config.ticker}`);
  console.log(`Date Range:  ${config.startDate} to ${config.endDate}`);
  console.log(`Output Dir:  ${config.outputDir}`);
  console.log(`Total Tests: ${combinations.length}`);
  console.log(`Resume Mode: ${config.resume ? 'Yes (skip completed)' : 'No (run all)'}`);
  console.log('');
  console.log('Parameter Ranges:');
  console.log(`  Directions: ${config.shortsOnly ? 'R1 shorts only' : config.longsOnly ? 'S1 longs only' : 'R1 shorts, S1 longs'}`);
  console.log(`  Stop Loss:  ${PARAMS.stopLoss.join(', ')} points`);
  console.log(`  Target:     ${PARAMS.target.join(', ')} points`);
  console.log(`  Trailing:   ${PARAMS.trailingConfigs.map(c => c.label).join(', ')}`);
  console.log('');

  if (!config.dryRun) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }

  let skipped = 0;
  const toRun = [];

  for (const combo of combinations) {
    const outputFile = path.join(config.outputDir, `${combo.id}.json`);
    if (config.resume && fs.existsSync(outputFile)) {
      skipped++;
    } else {
      toRun.push(combo);
    }
  }

  if (skipped > 0) console.log(`Skipping ${skipped} already-completed tests`);
  if (toRun.length === 0) {
    console.log('All tests already completed!\n');
  } else {
    console.log(`Running ${toRun.length} tests...\n`);
  }

  if (config.dryRun) {
    console.log('DRY RUN - Would execute:');
    for (const combo of toRun.slice(0, 20)) {
      const trailStr = combo.useTrailing ? `${combo.trailingTrigger}/${combo.trailingOffset}` : 'fixed';
      console.log(`  ${combo.direction} | Stop=${combo.stopLoss}, Target=${combo.target}, Trail=${trailStr}`);
    }
    if (toRun.length > 20) console.log(`  ... and ${toRun.length - 20} more`);
    return;
  }

  const results = [];
  const durations = [];
  let completed = 0;
  let failed = 0;

  for (const combo of toRun) {
    const testNum = completed + skipped + 1;
    const progress = ((testNum / combinations.length) * 100).toFixed(1);

    let eta = '';
    if (durations.length > 0) {
      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      const remaining = (toRun.length - completed) * avgDuration;
      eta = ` | ETA: ${formatETA(remaining)}`;
    }

    const trailStr = combo.useTrailing ? `T=${combo.trailingTrigger}/${combo.trailingOffset}` : 'fixed';
    process.stdout.write(
      `\r[${testNum}/${combinations.length}] ${progress}% | ` +
      `${combo.direction} SL=${combo.stopLoss} TP=${combo.target} ${trailStr}${eta}          `
    );

    const result = await runBacktest(combo, config);

    if (result.success) {
      completed++;
      durations.push(result.duration);

      const metrics = extractMetrics(result.outputFile);
      results.push({ ...combo, ...metrics, duration: result.duration });
    } else {
      failed++;
      console.log(`\n  ERROR: ${result.error}`);
    }
  }

  console.log('\n');

  // Load skipped test results
  if (skipped > 0) {
    for (const combo of combinations) {
      const outputFile = path.join(config.outputDir, `${combo.id}.json`);
      if (fs.existsSync(outputFile) && !results.find(r => r.id === combo.id)) {
        const metrics = extractMetrics(outputFile);
        if (metrics) results.push({ ...combo, ...metrics });
      }
    }
  }

  // Sort by P&L
  results.sort((a, b) => (b.totalPnL || 0) - (a.totalPnL || 0));

  // Write summary CSV
  const csvPath = path.join(config.outputDir, 'summary.csv');
  const csvHeader = 'direction,stop_loss,target,trailing_trigger,trailing_offset,trades,win_rate,total_pnl,avg_trade,profit_factor,max_dd,sl_exits,tp_exits,ts_exits,timeout_exits,market_close\n';
  const csvRows = results.map(r => {
    return `${r.direction},${r.stopLoss},${r.target},${r.trailingTrigger || ''},${r.trailingOffset || ''},${r.trades || 0},${(r.winRate || 0).toFixed(2)},${(r.totalPnL || 0).toFixed(2)},${(r.avgTrade || 0).toFixed(2)},${(r.profitFactor || 0).toFixed(2)},${(r.maxDrawdown || 0).toFixed(2)},${r.stopLossExits || 0},${r.takeProfitExits || 0},${r.trailingStopExits || 0},${r.timeoutExits || 0},${r.marketCloseExits || 0}`;
  }).join('\n');

  fs.writeFileSync(csvPath, csvHeader + csvRows);

  // Display summary
  console.log('════════════════════════════════════════════════════════════════════');
  console.log('                      RESULTS SUMMARY');
  console.log('════════════════════════════════════════════════════════════════════\n');

  console.log(`Tests Completed: ${completed + skipped}`);
  console.log(`Tests Failed:    ${failed}`);
  console.log(`Results saved:   ${csvPath}\n`);

  // Separate results by direction
  const r1Results = results.filter(r => r.direction === 'R1_shorts');
  const s1Results = results.filter(r => r.direction === 'S1_longs');

  // R1 Shorts Top 15
  if (r1Results.length > 0) {
    console.log('TOP 15 R1 SHORTS BY P&L:');
    console.log('─'.repeat(100));
    console.log('Rank │ Stop │ Target │ Trailing  │ Trades │ Win%  │ P&L        │ AvgTrade │ TS Exits │ TP Exits');
    console.log('─'.repeat(100));

    r1Results.slice(0, 15).forEach((r, i) => {
      const trailStr = r.useTrailing ? `${r.trailingTrigger}/${r.trailingOffset}`.padEnd(9) : 'fixed    ';
      console.log(
        `${(i + 1).toString().padStart(4)} │ ${r.stopLoss.toString().padStart(4)} │ ${r.target.toString().padStart(6)} │ ${trailStr} │ ` +
        `${(r.trades || 0).toString().padStart(6)} │ ${(r.winRate || 0).toFixed(1).padStart(5)}% │ ` +
        `$${(r.totalPnL || 0).toFixed(0).padStart(9)} │ $${(r.avgTrade || 0).toFixed(2).padStart(7)} │ ` +
        `${(r.trailingStopExits || 0).toString().padStart(8)} │ ${(r.takeProfitExits || 0).toString().padStart(8)}`
      );
    });
    console.log('');
  }

  // S1 Longs Top 15
  if (s1Results.length > 0) {
    console.log('TOP 15 S1 LONGS BY P&L:');
    console.log('─'.repeat(100));
    console.log('Rank │ Stop │ Target │ Trailing  │ Trades │ Win%  │ P&L        │ AvgTrade │ TS Exits │ TP Exits');
    console.log('─'.repeat(100));

    s1Results.slice(0, 15).forEach((r, i) => {
      const trailStr = r.useTrailing ? `${r.trailingTrigger}/${r.trailingOffset}`.padEnd(9) : 'fixed    ';
      console.log(
        `${(i + 1).toString().padStart(4)} │ ${r.stopLoss.toString().padStart(4)} │ ${r.target.toString().padStart(6)} │ ${trailStr} │ ` +
        `${(r.trades || 0).toString().padStart(6)} │ ${(r.winRate || 0).toFixed(1).padStart(5)}% │ ` +
        `$${(r.totalPnL || 0).toFixed(0).padStart(9)} │ $${(r.avgTrade || 0).toFixed(2).padStart(7)} │ ` +
        `${(r.trailingStopExits || 0).toString().padStart(8)} │ ${(r.takeProfitExits || 0).toString().padStart(8)}`
      );
    });
    console.log('');
  }

  // Best trailing configurations
  const trailingResults = results.filter(r => r.useTrailing && (r.totalPnL || 0) > 0);
  if (trailingResults.length > 0) {
    console.log('BEST PROFITABLE TRAILING CONFIGURATIONS:');
    console.log('─'.repeat(100));
    console.log('Rank │ Direction  │ Stop │ Target │ Trigger/Offset │ Win%  │ P&L        │ TS/TP Ratio');
    console.log('─'.repeat(100));

    trailingResults
      .sort((a, b) => (b.trailingStopExits / Math.max(1, b.takeProfitExits)) - (a.trailingStopExits / Math.max(1, a.takeProfitExits)))
      .slice(0, 10)
      .forEach((r, i) => {
        const ratio = (r.trailingStopExits / Math.max(1, r.takeProfitExits)).toFixed(2);
        console.log(
          `${(i + 1).toString().padStart(4)} │ ${r.direction.padEnd(10)} │ ${r.stopLoss.toString().padStart(4)} │ ${r.target.toString().padStart(6)} │ ` +
          `${r.trailingTrigger}/${r.trailingOffset}`.padEnd(14) + ' │ ' +
          `${(r.winRate || 0).toFixed(1).padStart(5)}% │ $${(r.totalPnL || 0).toFixed(0).padStart(9)} │ ${ratio}`
        );
      });
  }

  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('                      OPTIMIZATION COMPLETE');
  console.log('════════════════════════════════════════════════════════════════════\n');

  if (durations.length > 0) {
    const totalTime = durations.reduce((a, b) => a + b, 0);
    console.log(`Total runtime: ${formatDuration(totalTime)}`);
    console.log(`Average per test: ${formatDuration(totalTime / durations.length)}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
