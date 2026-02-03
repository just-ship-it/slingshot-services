#!/usr/bin/env node

/**
 * Trailing Stop Parameter Matrix for GEX-Recoil-Enhanced Strategy
 *
 * Tests 64 combinations of trailing stop parameters (8 triggers × 8 offsets)
 * to find optimal configurations that:
 * 1. Capture more upside on winning trades beyond the 20-point target
 * 2. Stop out losing trades at breakeven/small profit
 * 3. Avoid stopping out winners before they reach 20-point target
 *
 * Usage:
 *   node scripts/trailing-stop-matrix-enhanced.js [options]
 *
 * Options:
 *   --dry-run         Show what would be run without executing
 *   --output-dir      Custom output directory
 *   --no-resume       Re-run all tests, don't skip completed ones
 *   --ticker          Ticker symbol (default: NQ)
 *   --start           Start date (default: 2025-01-13)
 *   --end             End date (default: 2025-12-24)
 *   --help            Show help message
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
  trailingTrigger: [5, 10, 15, 20, 25, 30, 35, 40],
  trailingOffset: [5, 10, 15, 20, 25, 30, 35, 40]
};

// Strategy configuration
const STRATEGY_CONFIG = {
  name: 'gex-recoil-enhanced',
  timeframe: '15m',
  targetPoints: 20  // Baseline target for comparison
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    dryRun: false,
    outputDir: path.join(projectRoot, 'results', 'trailing-matrix-enhanced'),
    resume: true,
    ticker: 'NQ',
    startDate: '2025-01-13',
    endDate: '2025-12-24'
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
Trailing Stop Parameter Matrix for GEX-Recoil-Enhanced

Tests trailing stop configurations to optimize trade exits.

Usage:
  node scripts/trailing-stop-matrix-enhanced.js [options]

Options:
  --dry-run           Show what would be run without executing
  --output-dir <path> Custom output directory
  --no-resume         Re-run all tests, don't skip completed ones
  --ticker <symbol>   Ticker symbol (default: NQ)
  --start <date>      Start date YYYY-MM-DD (default: 2025-01-13)
  --end <date>        End date YYYY-MM-DD (default: 2025-12-24)
  --help, -h          Show this help message

Parameter Ranges:
  Trailing Trigger: ${PARAMS.trailingTrigger.join(', ')} points
  Trailing Offset:  ${PARAMS.trailingOffset.join(', ')} points
  Total Tests:      ${PARAMS.trailingTrigger.length * PARAMS.trailingOffset.length}

Strategy: ${STRATEGY_CONFIG.name} (${STRATEGY_CONFIG.timeframe} timeframe)
Target:   ${STRATEGY_CONFIG.targetPoints} points (for comparison metrics)
`);
      process.exit(0);
    }
  }

  return config;
}

// Generate all test combinations
function generateCombinations() {
  const combinations = [];

  for (const trigger of PARAMS.trailingTrigger) {
    for (const offset of PARAMS.trailingOffset) {
      combinations.push({
        trigger,
        offset,
        id: `t${trigger}_o${offset}`
      });
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
      '--strategy', STRATEGY_CONFIG.name,
      '--timeframe', STRATEGY_CONFIG.timeframe,
      '--target-points', STRATEGY_CONFIG.targetPoints.toString(),
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

// Calculate custom trade quality metrics
function calculateTradeQualityMetrics(trades, targetPoints) {
  const trailingExits = trades.filter(t => t.exitReason === 'trailing_stop');
  const targetExits = trades.filter(t => t.exitReason === 'take_profit');
  const stopLossExits = trades.filter(t => t.exitReason === 'stop_loss');
  const marketCloseExits = trades.filter(t => t.exitReason === 'market_close');

  const trailingWinners = trailingExits.filter(t => t.netPnL > 0);
  const trailingLosers = trailingExits.filter(t => t.netPnL <= 0);
  const allWinners = trades.filter(t => t.netPnL > 0);

  // Winners stopped before reaching target
  // These are trades that were profitable but exited via trailing before hitting 20 points
  const winnersBeforeTarget = trailingExits.filter(t => {
    const exitPoints = t.pointsPnL || 0;
    return t.netPnL > 0 && exitPoints < targetPoints;
  });

  // Average points for trailing stop winners
  const avgPointsTrailingWinners = trailingWinners.length > 0
    ? trailingWinners.reduce((sum, t) => sum + (t.pointsPnL || 0), 0) / trailingWinners.length
    : 0;

  // Max points captured via trailing
  const maxPointsTrailing = trailingExits.length > 0
    ? Math.max(...trailingExits.map(t => t.pointsPnL || 0))
    : 0;

  // Average P&L by exit type
  const avgPnLTrailing = trailingExits.length > 0
    ? trailingExits.reduce((sum, t) => sum + t.netPnL, 0) / trailingExits.length
    : 0;

  const avgPnLTarget = targetExits.length > 0
    ? targetExits.reduce((sum, t) => sum + t.netPnL, 0) / targetExits.length
    : 0;

  return {
    // Exit counts
    trailingStopExits: trailingExits.length,
    takeProfitExits: targetExits.length,
    stopLossExits: stopLossExits.length,
    marketCloseExits: marketCloseExits.length,

    // Trailing stop quality metrics
    trailingWinners: trailingWinners.length,
    trailingLosers: trailingLosers.length,
    trailingWinRate: trailingExits.length > 0
      ? (trailingWinners.length / trailingExits.length * 100)
      : 0,

    // Critical metrics for user's goals
    winnersBeforeTarget: winnersBeforeTarget.length,
    pctWinnersBeforeTarget: allWinners.length > 0
      ? (winnersBeforeTarget.length / allWinners.length * 100)
      : 0,
    avgPointsTrailingWinners,
    maxPointsTrailing,

    // P&L by exit type
    avgPnLTrailing,
    avgPnLTarget,

    // Upside capture: for trailing winners, how much above target did they capture?
    avgUpsideCapture: trailingWinners.length > 0
      ? trailingWinners
          .filter(t => (t.pointsPnL || 0) > targetPoints)
          .reduce((sum, t) => sum + ((t.pointsPnL || 0) - targetPoints), 0) /
          Math.max(1, trailingWinners.filter(t => (t.pointsPnL || 0) > targetPoints).length)
      : 0
  };
}

// Extract metrics from results JSON
function extractMetrics(resultsPath, targetPoints) {
  try {
    const data = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
    const perf = data.performance;
    const trades = data.trades || [];

    // Calculate custom metrics from trades
    const tradeMetrics = calculateTradeQualityMetrics(trades, targetPoints);

    return {
      // Standard metrics
      trades: perf.summary?.totalTrades || perf.basic?.totalTrades || 0,
      winRate: perf.summary?.winRate || perf.basic?.winRate || 0,
      totalPnL: perf.summary?.totalPnL || perf.basic?.totalPnL || 0,
      avgTrade: perf.basic?.avgTrade || 0,
      avgWin: perf.basic?.avgWin || 0,
      avgLoss: perf.basic?.avgLoss || 0,
      profitFactor: perf.basic?.profitFactor || 0,
      maxDrawdown: perf.drawdown?.maxDrawdown || perf.summary?.maxDrawdown || 0,
      sharpe: perf.risk?.sharpeRatio || perf.summary?.sharpeRatio || 0,

      // Trade quality metrics
      ...tradeMetrics
    };
  } catch (err) {
    console.error(`Error extracting metrics from ${resultsPath}: ${err.message}`);
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

// Generate analysis report
function generateReport(results, config) {
  const sortedByPnL = [...results].sort((a, b) => (b.totalPnL || 0) - (a.totalPnL || 0));
  const sortedByWinRate = [...results].sort((a, b) => (b.winRate || 0) - (a.winRate || 0));
  const sortedByUpside = [...results].sort((a, b) => (b.avgPointsTrailingWinners || 0) - (a.avgPointsTrailingWinners || 0));
  const sortedByPremature = [...results].sort((a, b) => (a.pctWinnersBeforeTarget || 0) - (b.pctWinnersBeforeTarget || 0));

  const report = `# Trailing Stop Parameter Matrix Analysis
## GEX-Recoil-Enhanced Strategy

**Generated**: ${new Date().toISOString()}
**Date Range**: ${config.startDate} to ${config.endDate}
**Combinations Tested**: ${results.length}

---

## Key Findings

### Top 5 by Total P&L
| Trigger | Offset | Trades | Win% | Total P&L | PF | TS Exits | TP Exits | SL Exits |
|---------|--------|--------|------|-----------|-----|----------|----------|----------|
${sortedByPnL.slice(0, 5).map(r =>
  `| ${r.trigger} | ${r.offset} | ${r.trades} | ${r.winRate?.toFixed(1)}% | $${r.totalPnL?.toLocaleString()} | ${r.profitFactor?.toFixed(2)} | ${r.trailingStopExits} | ${r.takeProfitExits} | ${r.stopLossExits} |`
).join('\n')}

### Top 5 by Win Rate
| Trigger | Offset | Trades | Win% | Total P&L | PF | Avg Trade |
|---------|--------|--------|------|-----------|-----|-----------|
${sortedByWinRate.slice(0, 5).map(r =>
  `| ${r.trigger} | ${r.offset} | ${r.trades} | ${r.winRate?.toFixed(1)}% | $${r.totalPnL?.toLocaleString()} | ${r.profitFactor?.toFixed(2)} | $${r.avgTrade?.toFixed(0)} |`
).join('\n')}

### Best for Upside Capture (Avg Points on Trailing Winners)
| Trigger | Offset | Avg Pts TS Winners | Max Pts Captured | TS Winners | Upside vs Target |
|---------|--------|---------------------|------------------|------------|------------------|
${sortedByUpside.slice(0, 5).map(r =>
  `| ${r.trigger} | ${r.offset} | ${r.avgPointsTrailingWinners?.toFixed(1)} | ${r.maxPointsTrailing?.toFixed(0)} | ${r.trailingWinners} | +${r.avgUpsideCapture?.toFixed(1)} pts |`
).join('\n')}

### Safest (Lowest % Winners Stopped Before 20pt Target)
| Trigger | Offset | Winners < Target | % of All Winners | Trailing Win% | Total P&L |
|---------|--------|------------------|------------------|---------------|-----------|
${sortedByPremature.slice(0, 5).map(r =>
  `| ${r.trigger} | ${r.offset} | ${r.winnersBeforeTarget} | ${r.pctWinnersBeforeTarget?.toFixed(1)}% | ${r.trailingWinRate?.toFixed(1)}% | $${r.totalPnL?.toLocaleString()} |`
).join('\n')}

---

## Exit Distribution Summary

| Trigger | Offset | TS Exits | TP Exits | SL Exits | MC Exits | TS Win% |
|---------|--------|----------|----------|----------|----------|---------|
${results.slice(0, 20).map(r =>
  `| ${r.trigger} | ${r.offset} | ${r.trailingStopExits} | ${r.takeProfitExits} | ${r.stopLossExits} | ${r.marketCloseExits} | ${r.trailingWinRate?.toFixed(1)}% |`
).join('\n')}

---

## Recommendations

### Best Overall Configuration
${sortedByPnL[0] ? `**Trigger: ${sortedByPnL[0].trigger}, Offset: ${sortedByPnL[0].offset}**
- Total P&L: $${sortedByPnL[0].totalPnL?.toLocaleString()}
- Win Rate: ${sortedByPnL[0].winRate?.toFixed(1)}%
- Profit Factor: ${sortedByPnL[0].profitFactor?.toFixed(2)}
- Winners stopped early: ${sortedByPnL[0].winnersBeforeTarget} (${sortedByPnL[0].pctWinnersBeforeTarget?.toFixed(1)}%)` : 'N/A'}

### Best for Letting Winners Run
${sortedByUpside[0] ? `**Trigger: ${sortedByUpside[0].trigger}, Offset: ${sortedByUpside[0].offset}**
- Avg points on trailing winners: ${sortedByUpside[0].avgPointsTrailingWinners?.toFixed(1)}
- Max captured: ${sortedByUpside[0].maxPointsTrailing?.toFixed(0)} points` : 'N/A'}

### Configurations to Avoid (High Premature Stops)
${results.filter(r => r.pctWinnersBeforeTarget > 10).slice(0, 3).map(r =>
  `- Trigger ${r.trigger}, Offset ${r.offset}: ${r.pctWinnersBeforeTarget?.toFixed(1)}% of winners stopped early`
).join('\n') || 'None with >10% premature stops'}

---

*Analysis generated by trailing-stop-matrix-enhanced.js*
`;

  return report;
}

// Main execution
async function main() {
  const config = parseArgs();
  const combinations = generateCombinations();

  console.log('════════════════════════════════════════════════════════════');
  console.log(' TRAILING STOP PARAMETER MATRIX - GEX-RECOIL-ENHANCED');
  console.log('════════════════════════════════════════════════════════════\n');

  console.log(`Strategy:    ${STRATEGY_CONFIG.name}`);
  console.log(`Ticker:      ${config.ticker}`);
  console.log(`Date Range:  ${config.startDate} to ${config.endDate}`);
  console.log(`Target:      ${STRATEGY_CONFIG.targetPoints} points (baseline)`);
  console.log(`Output Dir:  ${config.outputDir}`);
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
      // Verify file has valid data
      try {
        const data = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
        if (data.performance && data.trades) {
          skipped++;
          continue;
        }
      } catch {
        // Re-run if file is invalid
      }
    }
    toRun.push(combo);
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
      console.log(`  Trigger=${combo.trigger}, Offset=${combo.offset}`);
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
      `T=${combo.trigger} O=${combo.offset}${eta}                    `
    );

    const result = await runBacktest(combo, config);

    if (result.success) {
      completed++;
      durations.push(result.duration);

      const metrics = extractMetrics(result.outputFile, STRATEGY_CONFIG.targetPoints);
      if (metrics) {
        results.push({
          ...combo,
          ...metrics,
          duration: result.duration
        });
      }
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
          const metrics = extractMetrics(outputFile, STRATEGY_CONFIG.targetPoints);
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
  const csvHeader = 'trigger,offset,trades,win_rate,total_pnl,avg_trade,profit_factor,max_dd,sharpe,ts_exits,tp_exits,sl_exits,mc_exits,ts_winners,ts_losers,ts_win_rate,winners_before_target,pct_winners_before_target,avg_pts_ts_winners,max_pts_trailing,avg_pnl_trailing,avg_pnl_target,avg_upside_capture\n';
  const csvRows = results.map(r =>
    `${r.trigger},${r.offset},${r.trades || 0},${(r.winRate || 0).toFixed(2)},${(r.totalPnL || 0).toFixed(2)},${(r.avgTrade || 0).toFixed(2)},${(r.profitFactor || 0).toFixed(2)},${(r.maxDrawdown || 0).toFixed(2)},${(r.sharpe || 0).toFixed(2)},${r.trailingStopExits || 0},${r.takeProfitExits || 0},${r.stopLossExits || 0},${r.marketCloseExits || 0},${r.trailingWinners || 0},${r.trailingLosers || 0},${(r.trailingWinRate || 0).toFixed(2)},${r.winnersBeforeTarget || 0},${(r.pctWinnersBeforeTarget || 0).toFixed(2)},${(r.avgPointsTrailingWinners || 0).toFixed(2)},${(r.maxPointsTrailing || 0).toFixed(2)},${(r.avgPnLTrailing || 0).toFixed(2)},${(r.avgPnLTarget || 0).toFixed(2)},${(r.avgUpsideCapture || 0).toFixed(2)}`
  ).join('\n');

  fs.writeFileSync(csvPath, csvHeader + csvRows);

  // Generate and save analysis report
  const reportPath = path.join(config.outputDir, 'analysis-report.md');
  const report = generateReport(results, config);
  fs.writeFileSync(reportPath, report);

  // Display summary
  console.log('════════════════════════════════════════════════════════════');
  console.log('                     RESULTS SUMMARY');
  console.log('════════════════════════════════════════════════════════════\n');

  console.log(`Tests Completed: ${completed + skipped}`);
  console.log(`Tests Failed:    ${failed}`);
  console.log(`Results saved to: ${csvPath}`);
  console.log(`Analysis report:  ${reportPath}\n`);

  // Top 10 by P&L
  console.log('TOP 10 BY TOTAL P&L:');
  console.log('─'.repeat(95));
  console.log('Rank | Trigger | Offset | Trades | Win%  | P&L       | PF   | TS Exits | TP Exits | Before Tgt');
  console.log('─'.repeat(95));

  results.slice(0, 10).forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(4)} | ${String(r.trigger).padStart(7)} | ${String(r.offset).padStart(6)} | ` +
      `${String(r.trades || 0).padStart(6)} | ${(r.winRate || 0).toFixed(1).padStart(5)}% | ` +
      `$${(r.totalPnL || 0).toFixed(0).padStart(8)} | ` +
      `${(r.profitFactor || 0).toFixed(2).padStart(4)} | ` +
      `${String(r.trailingStopExits || 0).padStart(8)} | ` +
      `${String(r.takeProfitExits || 0).padStart(8)} | ` +
      `${String(r.winnersBeforeTarget || 0).padStart(10)}`
    );
  });

  console.log('');

  // Best for upside capture
  const byUpside = [...results].sort((a, b) => (b.avgPointsTrailingWinners || 0) - (a.avgPointsTrailingWinners || 0));
  console.log('TOP 10 BY UPSIDE CAPTURE (Avg Points on Trailing Winners):');
  console.log('─'.repeat(95));
  console.log('Rank | Trigger | Offset | Avg Pts | Max Pts | TS Winners | TS Win% | Total P&L');
  console.log('─'.repeat(95));

  byUpside.slice(0, 10).forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(4)} | ${String(r.trigger).padStart(7)} | ${String(r.offset).padStart(6)} | ` +
      `${(r.avgPointsTrailingWinners || 0).toFixed(1).padStart(7)} | ` +
      `${(r.maxPointsTrailing || 0).toFixed(0).padStart(7)} | ` +
      `${String(r.trailingWinners || 0).padStart(10)} | ` +
      `${(r.trailingWinRate || 0).toFixed(1).padStart(7)}% | ` +
      `$${(r.totalPnL || 0).toFixed(0).padStart(8)}`
    );
  });

  console.log('');

  // Safest (lowest premature stops)
  const byPremature = [...results].sort((a, b) => (a.pctWinnersBeforeTarget || 0) - (b.pctWinnersBeforeTarget || 0));
  console.log('SAFEST (Lowest % Winners Stopped Before 20pt Target):');
  console.log('─'.repeat(95));
  console.log('Rank | Trigger | Offset | Before Tgt | % Winners | TS Win% | Total P&L');
  console.log('─'.repeat(95));

  byPremature.slice(0, 10).forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(4)} | ${String(r.trigger).padStart(7)} | ${String(r.offset).padStart(6)} | ` +
      `${String(r.winnersBeforeTarget || 0).padStart(10)} | ` +
      `${(r.pctWinnersBeforeTarget || 0).toFixed(1).padStart(9)}% | ` +
      `${(r.trailingWinRate || 0).toFixed(1).padStart(7)}% | ` +
      `$${(r.totalPnL || 0).toFixed(0).padStart(8)}`
    );
  });

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('                    MATRIX COMPLETE');
  console.log('════════════════════════════════════════════════════════════\n');

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
