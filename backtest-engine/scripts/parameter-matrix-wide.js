#!/usr/bin/env node

/**
 * Wide Parameter Matrix Test Runner
 *
 * Tests wider stop/target configurations that match a swing trading style:
 * - Tolerates 20-50 point drawdowns
 * - Targets 60-70%+ win rate
 * - Lets trades sit through whipsaw to capture the eventual move
 *
 * Usage:
 *   node scripts/parameter-matrix-wide.js [options]
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Wide parameter ranges
const PARAMS = {
  stopLoss: [15, 20, 25, 30, 40],
  target: [15, 20, 25, 30, 40],
  // Also test without trailing stops (fixed stop/target only)
  trailingConfigs: [
    { useTrailing: false, trigger: null, offset: null, label: 'fixed' },
    { useTrailing: true, trigger: 10, offset: 3, label: 't10o3' },
    { useTrailing: true, trigger: 15, offset: 5, label: 't15o5' },
    { useTrailing: true, trigger: 20, offset: 7, label: 't20o7' }
  ]
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    dryRun: false,
    outputDir: path.join(projectRoot, 'results', 'matrix-wide'),
    resume: true,
    ticker: 'NQ',
    startDate: '2025-01-01',
    endDate: '2025-12-31'
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') config.dryRun = true;
    else if (args[i] === '--output-dir' && args[i + 1]) config.outputDir = args[++i];
    else if (args[i] === '--no-resume') config.resume = false;
    else if (args[i] === '--ticker' && args[i + 1]) config.ticker = args[++i];
    else if (args[i] === '--start' && args[i + 1]) config.startDate = args[++i];
    else if (args[i] === '--end' && args[i + 1]) config.endDate = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      const totalTests = PARAMS.stopLoss.length * PARAMS.target.length * PARAMS.trailingConfigs.length;
      console.log(`
Wide Parameter Matrix Test Runner

Tests configurations suited for swing trading with larger stops.

Usage:
  node scripts/parameter-matrix-wide.js [options]

Options:
  --dry-run           Show what would be run without executing
  --output-dir <path> Custom output directory (default: results/matrix-wide)
  --no-resume         Re-run all tests
  --ticker <symbol>   Ticker symbol (default: NQ)
  --start <date>      Start date (default: 2025-01-01)
  --end <date>        End date (default: 2025-12-31)

Parameter Ranges:
  Stop Loss:  ${PARAMS.stopLoss.join(', ')} points
  Target:     ${PARAMS.target.join(', ')} points
  Trailing:   ${PARAMS.trailingConfigs.map(c => c.label).join(', ')}
  Total Tests: ${totalTests}
`);
      process.exit(0);
    }
  }

  return config;
}

function generateCombinations() {
  const combinations = [];

  for (const stopLoss of PARAMS.stopLoss) {
    for (const target of PARAMS.target) {
      for (const trailing of PARAMS.trailingConfigs) {
        combinations.push({
          stopLoss,
          target,
          useTrailing: trailing.useTrailing,
          trailingTrigger: trailing.trigger,
          trailingOffset: trailing.offset,
          id: `sl${stopLoss}_tp${target}_${trailing.label}`
        });
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
      '--stop-loss-points', combo.stopLoss.toString(),
      '--target-points', combo.target.toString(),
      '--output', outputFile,
      '--quiet'
    ];

    if (combo.useTrailing) {
      args.push('--use-trailing-stop');
      args.push('--trailing-trigger', combo.trailingTrigger.toString());
      args.push('--trailing-offset', combo.trailingOffset.toString());
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
    return {
      trades: perf.basic.totalTrades,
      winRate: perf.basic.winRate,
      totalPnL: perf.basic.totalPnL,
      profitFactor: perf.basic.profitFactor,
      maxDrawdown: perf.basic.maxDrawdown,
      sharpe: perf.basic.sharpeRatio,
      stopLossExits: perf.exitAnalysis?.stopLoss || 0,
      takeProfitExits: perf.exitAnalysis?.takeProfit || 0,
      trailingStopExits: perf.exitAnalysis?.trailingStop || 0,
      timeoutExits: perf.exitAnalysis?.timeout || 0
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
  const combinations = generateCombinations();

  console.log('════════════════════════════════════════════════════════════════════');
  console.log(' WIDE PARAMETER MATRIX TEST RUNNER');
  console.log(' (Swing Trading Style: Larger Stops, Higher Win Rate Target)');
  console.log('════════════════════════════════════════════════════════════════════\n');

  console.log(`Ticker:      ${config.ticker}`);
  console.log(`Date Range:  ${config.startDate} to ${config.endDate}`);
  console.log(`Output Dir:  ${config.outputDir}`);
  console.log(`Total Tests: ${combinations.length}`);
  console.log(`Resume Mode: ${config.resume ? 'Yes (skip completed)' : 'No (run all)'}`);
  console.log('');
  console.log('Parameter Ranges:');
  console.log(`  Stop Loss: ${PARAMS.stopLoss.join(', ')} points`);
  console.log(`  Target:    ${PARAMS.target.join(', ')} points`);
  console.log(`  Trailing:  ${PARAMS.trailingConfigs.map(c => c.label).join(', ')}`);
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
    for (const combo of toRun) {
      console.log(`  Stop=${combo.stopLoss}, Target=${combo.target}, Trailing=${combo.useTrailing ? `${combo.trailingTrigger}/${combo.trailingOffset}` : 'none'}`);
    }
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
      `SL=${combo.stopLoss} TP=${combo.target} ${trailStr}${eta}          `
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
  const csvHeader = 'stop_loss,target,trailing,trades,win_rate,total_pnl,profit_factor,max_dd,sl_exits,tp_exits,ts_exits,timeout_exits\n';
  const csvRows = results.map(r => {
    const trailStr = r.useTrailing ? `${r.trailingTrigger}/${r.trailingOffset}` : 'fixed';
    return `${r.stopLoss},${r.target},${trailStr},${r.trades || 0},${(r.winRate || 0).toFixed(2)},${(r.totalPnL || 0).toFixed(2)},${(r.profitFactor || 0).toFixed(2)},${(r.maxDrawdown || 0).toFixed(2)},${r.stopLossExits || 0},${r.takeProfitExits || 0},${r.trailingStopExits || 0},${r.timeoutExits || 0}`;
  }).join('\n');

  fs.writeFileSync(csvPath, csvHeader + csvRows);

  // Display summary
  console.log('════════════════════════════════════════════════════════════════════');
  console.log('                      RESULTS SUMMARY');
  console.log('════════════════════════════════════════════════════════════════════\n');

  console.log(`Tests Completed: ${completed + skipped}`);
  console.log(`Tests Failed:    ${failed}`);
  console.log(`Results saved:   ${csvPath}\n`);

  // Top 15 by P&L
  console.log('TOP 15 BY TOTAL P&L:');
  console.log('─'.repeat(85));
  console.log('Rank │ Stop │ Target │ Trailing  │ Trades │ Win%  │ P&L        │ PF   │ MaxDD');
  console.log('─'.repeat(85));

  results.slice(0, 15).forEach((r, i) => {
    const trailStr = r.useTrailing ? `${r.trailingTrigger}/${r.trailingOffset}`.padEnd(9) : 'fixed    ';
    console.log(
      `${(i + 1).toString().padStart(4)} │ ${r.stopLoss.toString().padStart(4)} │ ${r.target.toString().padStart(6)} │ ${trailStr} │ ` +
      `${(r.trades || 0).toString().padStart(6)} │ ${(r.winRate || 0).toFixed(1).padStart(5)}% │ ` +
      `$${(r.totalPnL || 0).toFixed(0).padStart(9)} │ ${(r.profitFactor || 0).toFixed(2).padStart(4)} │ ` +
      `${(r.maxDrawdown || 0).toFixed(1)}%`
    );
  });

  console.log('');

  // Top 15 by Win Rate (for configs with positive P&L)
  const profitableByWinRate = results.filter(r => (r.totalPnL || 0) > 0).sort((a, b) => (b.winRate || 0) - (a.winRate || 0));

  if (profitableByWinRate.length > 0) {
    console.log('TOP 15 PROFITABLE CONFIGS BY WIN RATE:');
    console.log('─'.repeat(85));
    console.log('Rank │ Stop │ Target │ Trailing  │ Trades │ Win%  │ P&L        │ PF   │ MaxDD');
    console.log('─'.repeat(85));

    profitableByWinRate.slice(0, 15).forEach((r, i) => {
      const trailStr = r.useTrailing ? `${r.trailingTrigger}/${r.trailingOffset}`.padEnd(9) : 'fixed    ';
      console.log(
        `${(i + 1).toString().padStart(4)} │ ${r.stopLoss.toString().padStart(4)} │ ${r.target.toString().padStart(6)} │ ${trailStr} │ ` +
        `${(r.trades || 0).toString().padStart(6)} │ ${(r.winRate || 0).toFixed(1).padStart(5)}% │ ` +
        `$${(r.totalPnL || 0).toFixed(0).padStart(9)} │ ${(r.profitFactor || 0).toFixed(2).padStart(4)} │ ` +
        `${(r.maxDrawdown || 0).toFixed(1)}%`
      );
    });
  }

  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('                      MATRIX COMPLETE');
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
