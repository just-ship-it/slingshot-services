#!/usr/bin/env node

/**
 * Parameter Matrix Test Runner
 *
 * Systematically tests different stop loss and trailing stop configurations
 * using 1-second resolution backtesting for accurate results.
 *
 * Usage:
 *   node scripts/parameter-matrix.js [options]
 *
 * Options:
 *   --dry-run         Show what would be run without executing
 *   --output-dir      Custom output directory (default: results/matrix)
 *   --resume          Skip already-completed tests
 *   --ticker          Ticker symbol (default: NQ)
 *   --start           Start date (default: 2025-01-01)
 *   --end             End date (default: 2025-12-31)
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Parameter ranges to test
const PARAMS = {
  stopLoss: [3, 5, 7, 10],
  trailingTrigger: [2, 3, 4, 5, 6],
  trailingOffset: [1, 2, 3]
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    dryRun: false,
    outputDir: path.join(projectRoot, 'results', 'matrix'),
    resume: true,
    ticker: 'NQ',
    startDate: '2025-01-01',
    endDate: '2025-12-31'
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') {
      config.dryRun = true;
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      config.outputDir = args[++i];
    } else if (args[i] === '--no-resume') {
      config.resume = false;
    } else if (args[i] === '--ticker' && args[i + 1]) {
      config.ticker = args[++i];
    } else if (args[i] === '--start' && args[i + 1]) {
      config.startDate = args[++i];
    } else if (args[i] === '--end' && args[i + 1]) {
      config.endDate = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Parameter Matrix Test Runner

Systematically tests stop loss and trailing stop configurations.

Usage:
  node scripts/parameter-matrix.js [options]

Options:
  --dry-run           Show what would be run without executing
  --output-dir <path> Custom output directory (default: results/matrix)
  --no-resume         Re-run all tests, don't skip completed ones
  --ticker <symbol>   Ticker symbol (default: NQ)
  --start <date>      Start date YYYY-MM-DD (default: 2025-01-01)
  --end <date>        End date YYYY-MM-DD (default: 2025-12-31)
  --help, -h          Show this help message

Parameter Ranges:
  Stop Loss:        ${PARAMS.stopLoss.join(', ')} points
  Trailing Trigger: ${PARAMS.trailingTrigger.join(', ')} points
  Trailing Offset:  ${PARAMS.trailingOffset.join(', ')} points
  Total Tests:      ${PARAMS.stopLoss.length * PARAMS.trailingTrigger.length * PARAMS.trailingOffset.length}
`);
      process.exit(0);
    }
  }

  return config;
}

// Generate all test combinations
function generateCombinations() {
  const combinations = [];

  for (const stopLoss of PARAMS.stopLoss) {
    for (const trigger of PARAMS.trailingTrigger) {
      for (const offset of PARAMS.trailingOffset) {
        combinations.push({
          stopLoss,
          trigger,
          offset,
          id: `sl${stopLoss}_t${trigger}_o${offset}`
        });
      }
    }
  }

  return combinations;
}

// Run a single backtest
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
      '--stop-loss-points', combo.stopLoss.toString(),
      '--use-trailing-stop',
      '--trailing-trigger', combo.trigger.toString(),
      '--trailing-offset', combo.offset.toString(),
      '--output', outputFile,
      '--quiet'
    ];

    const startTime = Date.now();
    const proc = spawn('node', args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      const duration = (Date.now() - startTime) / 1000;

      if (code === 0) {
        resolve({ success: true, duration, outputFile });
      } else {
        resolve({
          success: false,
          duration,
          error: stderr || stdout || `Exit code ${code}`
        });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

// Extract metrics from results JSON
function extractMetrics(resultsPath) {
  try {
    const data = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
    const perf = data.performance;

    return {
      trades: perf.basic.totalTrades,
      winRate: perf.basic.winRate,
      totalPnL: perf.basic.totalPnL,
      avgWin: perf.basic.averageWin,
      avgLoss: perf.basic.averageLoss,
      profitFactor: perf.basic.profitFactor,
      maxDrawdown: perf.basic.maxDrawdown,
      sharpe: perf.basic.sharpeRatio,
      // Exit breakdown
      stopLossExits: perf.exitAnalysis?.stopLoss || 0,
      takeProfitExits: perf.exitAnalysis?.takeProfit || 0,
      trailingStopExits: perf.exitAnalysis?.trailingStop || 0,
      timeoutExits: perf.exitAnalysis?.timeout || 0
    };
  } catch (err) {
    return null;
  }
}

// Format time duration
function formatDuration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

// Format ETA
function formatETA(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// Main execution
async function main() {
  const config = parseArgs();
  const combinations = generateCombinations();

  console.log('========================================');
  console.log(' PARAMETER MATRIX TEST RUNNER');
  console.log('========================================\n');

  console.log(`Ticker:     ${config.ticker}`);
  console.log(`Date Range: ${config.startDate} to ${config.endDate}`);
  console.log(`Output Dir: ${config.outputDir}`);
  console.log(`Total Tests: ${combinations.length}`);
  console.log(`Resume Mode: ${config.resume ? 'Yes (skip completed)' : 'No (run all)'}`);
  console.log('');

  // Create output directory
  if (!config.dryRun) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }

  // Check which tests are already completed
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

  if (skipped > 0) {
    console.log(`Skipping ${skipped} already-completed tests`);
  }

  if (toRun.length === 0) {
    console.log('All tests already completed!\n');
  } else {
    console.log(`Running ${toRun.length} tests...\n`);
  }

  // Dry run - just show what would be run
  if (config.dryRun) {
    console.log('DRY RUN - Would execute:');
    for (const combo of toRun) {
      console.log(`  Stop=${combo.stopLoss}, Trigger=${combo.trigger}, Offset=${combo.offset}`);
    }
    console.log('');
    return;
  }

  // Run tests
  const results = [];
  const durations = [];
  let completed = 0;
  let failed = 0;

  for (const combo of toRun) {
    const testNum = completed + skipped + 1;
    const progress = ((testNum / combinations.length) * 100).toFixed(1);

    // Calculate ETA based on average duration
    let eta = '';
    if (durations.length > 0) {
      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      const remaining = (toRun.length - completed) * avgDuration;
      eta = ` | ETA: ${formatETA(remaining)}`;
    }

    process.stdout.write(
      `\r[${testNum}/${combinations.length}] ${progress}% | ` +
      `SL=${combo.stopLoss} T=${combo.trigger} O=${combo.offset}${eta}          `
    );

    const result = await runBacktest(combo, config);

    if (result.success) {
      completed++;
      durations.push(result.duration);

      const metrics = extractMetrics(result.outputFile);
      results.push({
        ...combo,
        ...metrics,
        duration: result.duration
      });
    } else {
      failed++;
      console.log(`\n  ERROR: ${result.error}`);
    }
  }

  console.log('\n');

  // Load metrics from any skipped tests
  if (skipped > 0) {
    for (const combo of combinations) {
      const outputFile = path.join(config.outputDir, `${combo.id}.json`);
      if (fs.existsSync(outputFile)) {
        const existing = results.find(r => r.id === combo.id);
        if (!existing) {
          const metrics = extractMetrics(outputFile);
          if (metrics) {
            results.push({ ...combo, ...metrics });
          }
        }
      }
    }
  }

  // Sort results for summary
  results.sort((a, b) => (b.totalPnL || 0) - (a.totalPnL || 0));

  // Write summary CSV
  const csvPath = path.join(config.outputDir, 'summary.csv');
  const csvHeader = 'stop_loss,trigger,offset,trades,win_rate,total_pnl,avg_win,avg_loss,profit_factor,max_dd,sharpe,sl_exits,tp_exits,ts_exits,timeout_exits\n';
  const csvRows = results.map(r =>
    `${r.stopLoss},${r.trigger},${r.offset},${r.trades || 0},${(r.winRate || 0).toFixed(2)},${(r.totalPnL || 0).toFixed(2)},${(r.avgWin || 0).toFixed(2)},${(r.avgLoss || 0).toFixed(2)},${(r.profitFactor || 0).toFixed(2)},${(r.maxDrawdown || 0).toFixed(2)},${(r.sharpe || 0).toFixed(2)},${r.stopLossExits || 0},${r.takeProfitExits || 0},${r.trailingStopExits || 0},${r.timeoutExits || 0}`
  ).join('\n');

  fs.writeFileSync(csvPath, csvHeader + csvRows);

  // Display summary
  console.log('========================================');
  console.log('           RESULTS SUMMARY');
  console.log('========================================\n');

  console.log(`Tests Completed: ${completed + skipped}`);
  console.log(`Tests Failed:    ${failed}`);
  console.log(`Results saved to: ${csvPath}\n`);

  // Top 10 by P&L
  console.log('TOP 10 BY TOTAL P&L:');
  console.log('─'.repeat(80));
  console.log('Rank | SL | Trigger | Offset | Trades | Win%  | P&L       | PF   | Sharpe');
  console.log('─'.repeat(80));

  results.slice(0, 10).forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(4)} | ${String(r.stopLoss).padStart(2)} | ` +
      `${String(r.trigger).padStart(7)} | ${String(r.offset).padStart(6)} | ` +
      `${String(r.trades || 0).padStart(6)} | ${(r.winRate || 0).toFixed(1).padStart(5)}% | ` +
      `$${(r.totalPnL || 0).toFixed(0).padStart(8)} | ` +
      `${(r.profitFactor || 0).toFixed(2).padStart(4)} | ` +
      `${(r.sharpe || 0).toFixed(2)}`
    );
  });

  console.log('');

  // Top 10 by Sharpe
  const byShape = [...results].sort((a, b) => (b.sharpe || -999) - (a.sharpe || -999));
  console.log('TOP 10 BY SHARPE RATIO:');
  console.log('─'.repeat(80));
  console.log('Rank | SL | Trigger | Offset | Trades | Win%  | P&L       | PF   | Sharpe');
  console.log('─'.repeat(80));

  byShape.slice(0, 10).forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(4)} | ${String(r.stopLoss).padStart(2)} | ` +
      `${String(r.trigger).padStart(7)} | ${String(r.offset).padStart(6)} | ` +
      `${String(r.trades || 0).padStart(6)} | ${(r.winRate || 0).toFixed(1).padStart(5)}% | ` +
      `$${(r.totalPnL || 0).toFixed(0).padStart(8)} | ` +
      `${(r.profitFactor || 0).toFixed(2).padStart(4)} | ` +
      `${(r.sharpe || 0).toFixed(2)}`
    );
  });

  console.log('\n========================================');
  console.log('          MATRIX COMPLETE');
  console.log('========================================\n');

  // Calculate total runtime
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
