#!/usr/bin/env node

/**
 * Trailing Stop Parameter Matrix - NO TARGET VERSION
 *
 * Tests 64 combinations of trailing stop parameters WITHOUT a take profit target.
 * Trades exit ONLY via:
 * 1. Trailing stop
 * 2. Stop loss
 * 3. Market close
 *
 * This reveals the true profit potential of each trailing stop configuration.
 *
 * Usage:
 *   node scripts/trailing-stop-matrix-no-target.js [options]
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

// Strategy configuration - NO TARGET (set to 1000 to effectively disable)
const STRATEGY_CONFIG = {
  name: 'gex-recoil-enhanced',
  timeframe: '15m',
  targetPoints: 1000  // Effectively disabled - trades exit via trailing/stop only
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    dryRun: false,
    outputDir: path.join(projectRoot, 'results', 'trailing-matrix-no-target'),
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
Trailing Stop Parameter Matrix - NO TARGET VERSION

Tests trailing stop configurations WITHOUT take profit target.
Trades exit only via trailing stop, stop loss, or market close.
This reveals the true profit potential of each configuration.

Usage:
  node scripts/trailing-stop-matrix-no-target.js [options]

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
Target:   DISABLED (${STRATEGY_CONFIG.targetPoints} points - effectively never hit)
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
function calculateTradeQualityMetrics(trades) {
  const trailingExits = trades.filter(t => t.exitReason === 'trailing_stop');
  const targetExits = trades.filter(t => t.exitReason === 'take_profit');
  const stopLossExits = trades.filter(t => t.exitReason === 'stop_loss');
  const marketCloseExits = trades.filter(t => t.exitReason === 'market_close');

  const trailingWinners = trailingExits.filter(t => t.netPnL > 0);
  const trailingLosers = trailingExits.filter(t => t.netPnL <= 0);
  const allWinners = trades.filter(t => t.netPnL > 0);

  // Calculate points captured distribution
  const allPoints = trailingExits.map(t => t.pointsPnL || 0);
  const winnerPoints = trailingWinners.map(t => t.pointsPnL || 0);

  // Percentile calculations for winner points
  const sortedWinnerPoints = [...winnerPoints].sort((a, b) => a - b);
  const p25 = sortedWinnerPoints[Math.floor(sortedWinnerPoints.length * 0.25)] || 0;
  const p50 = sortedWinnerPoints[Math.floor(sortedWinnerPoints.length * 0.50)] || 0;
  const p75 = sortedWinnerPoints[Math.floor(sortedWinnerPoints.length * 0.75)] || 0;
  const p90 = sortedWinnerPoints[Math.floor(sortedWinnerPoints.length * 0.90)] || 0;

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

  // Winners by points buckets
  const winnersUnder20 = trailingWinners.filter(t => (t.pointsPnL || 0) < 20).length;
  const winners20to30 = trailingWinners.filter(t => (t.pointsPnL || 0) >= 20 && (t.pointsPnL || 0) < 30).length;
  const winners30to40 = trailingWinners.filter(t => (t.pointsPnL || 0) >= 30 && (t.pointsPnL || 0) < 40).length;
  const winners40plus = trailingWinners.filter(t => (t.pointsPnL || 0) >= 40).length;

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

    // Points metrics
    avgPointsTrailingWinners,
    maxPointsTrailing,

    // Percentiles for trailing winners
    p25Points: p25,
    p50Points: p50,
    p75Points: p75,
    p90Points: p90,

    // Points buckets
    winnersUnder20,
    winners20to30,
    winners30to40,
    winners40plus,

    // P&L by exit type
    avgPnLTrailing,
    avgPnLTarget,

    // Total trailing P&L
    totalPnLTrailing: trailingExits.reduce((sum, t) => sum + t.netPnL, 0),
    totalPnLWinners: trailingWinners.reduce((sum, t) => sum + t.netPnL, 0),
    totalPnLLosers: trailingLosers.reduce((sum, t) => sum + t.netPnL, 0)
  };
}

// Extract metrics from results JSON
function extractMetrics(resultsPath) {
  try {
    const data = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
    const perf = data.performance;
    const trades = data.trades || [];

    // Calculate custom metrics from trades
    const tradeMetrics = calculateTradeQualityMetrics(trades);

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
  const sortedByAvgPoints = [...results].sort((a, b) => (b.avgPointsTrailingWinners || 0) - (a.avgPointsTrailingWinners || 0));
  const sortedByMaxPoints = [...results].sort((a, b) => (b.maxPointsTrailing || 0) - (a.maxPointsTrailing || 0));
  const sortedByTrailingWinRate = [...results].sort((a, b) => (b.trailingWinRate || 0) - (a.trailingWinRate || 0));

  const report = `# Trailing Stop Parameter Matrix Analysis - NO TARGET
## GEX-Recoil-Enhanced Strategy

**Generated**: ${new Date().toISOString()}
**Date Range**: ${config.startDate} to ${config.endDate}
**Combinations Tested**: ${results.length}
**Target**: DISABLED (trades exit only via trailing stop, stop loss, or market close)

---

## Key Findings

### Top 10 by Total P&L
| Trigger | Offset | Trades | Win% | Total P&L | PF | TS Exits | TS Win% | Avg Pts |
|---------|--------|--------|------|-----------|-----|----------|---------|---------|
${sortedByPnL.slice(0, 10).map(r =>
  `| ${r.trigger} | ${r.offset} | ${r.trades} | ${r.winRate?.toFixed(1)}% | $${r.totalPnL?.toLocaleString()} | ${r.profitFactor?.toFixed(2)} | ${r.trailingStopExits} | ${r.trailingWinRate?.toFixed(1)}% | ${r.avgPointsTrailingWinners?.toFixed(1)} |`
).join('\n')}

### Top 10 by Average Points Captured (Trailing Winners)
| Trigger | Offset | Avg Pts | Max Pts | P50 | P75 | P90 | TS Winners | Total P&L |
|---------|--------|---------|---------|-----|-----|-----|------------|-----------|
${sortedByAvgPoints.slice(0, 10).map(r =>
  `| ${r.trigger} | ${r.offset} | ${r.avgPointsTrailingWinners?.toFixed(1)} | ${r.maxPointsTrailing?.toFixed(0)} | ${r.p50Points?.toFixed(0)} | ${r.p75Points?.toFixed(0)} | ${r.p90Points?.toFixed(0)} | ${r.trailingWinners} | $${r.totalPnL?.toLocaleString()} |`
).join('\n')}

### Top 10 by Trailing Stop Win Rate
| Trigger | Offset | TS Win% | TS Winners | TS Losers | Total P&L | Avg Pts |
|---------|--------|---------|------------|-----------|-----------|---------|
${sortedByTrailingWinRate.slice(0, 10).map(r =>
  `| ${r.trigger} | ${r.offset} | ${r.trailingWinRate?.toFixed(1)}% | ${r.trailingWinners} | ${r.trailingLosers} | $${r.totalPnL?.toLocaleString()} | ${r.avgPointsTrailingWinners?.toFixed(1)} |`
).join('\n')}

### Winners Distribution by Points Captured
| Trigger | Offset | <20 pts | 20-30 pts | 30-40 pts | 40+ pts | Total Winners | Avg Pts |
|---------|--------|---------|-----------|-----------|---------|---------------|---------|
${sortedByPnL.slice(0, 15).map(r =>
  `| ${r.trigger} | ${r.offset} | ${r.winnersUnder20} | ${r.winners20to30} | ${r.winners30to40} | ${r.winners40plus} | ${r.trailingWinners} | ${r.avgPointsTrailingWinners?.toFixed(1)} |`
).join('\n')}

---

## Comparison Insights

### What These Results Tell Us About Optimal Target

Looking at the points distribution, we can identify:

1. **Median (P50) Points**: The most common winning exit point
2. **P75 Points**: 75% of winners exit at or below this
3. **P90 Points**: Only 10% of winners exceed this

This helps determine where to set a fixed target vs relying on trailing stop.

### Best Configuration Summary
${sortedByPnL[0] ? `
**Best by P&L: Trigger=${sortedByPnL[0].trigger}, Offset=${sortedByPnL[0].offset}**
- Total P&L: $${sortedByPnL[0].totalPnL?.toLocaleString()}
- Trailing Stop Win Rate: ${sortedByPnL[0].trailingWinRate?.toFixed(1)}%
- Avg Points on Winners: ${sortedByPnL[0].avgPointsTrailingWinners?.toFixed(1)}
- Max Points Captured: ${sortedByPnL[0].maxPointsTrailing?.toFixed(0)}
` : 'N/A'}

${sortedByAvgPoints[0] ? `
**Best for Upside Capture: Trigger=${sortedByAvgPoints[0].trigger}, Offset=${sortedByAvgPoints[0].offset}**
- Avg Points on Winners: ${sortedByAvgPoints[0].avgPointsTrailingWinners?.toFixed(1)}
- Max Points Captured: ${sortedByAvgPoints[0].maxPointsTrailing?.toFixed(0)}
- P75: ${sortedByAvgPoints[0].p75Points?.toFixed(0)} points
- P90: ${sortedByAvgPoints[0].p90Points?.toFixed(0)} points
` : 'N/A'}

---

*Analysis generated by trailing-stop-matrix-no-target.js*
`;

  return report;
}

// Main execution
async function main() {
  const config = parseArgs();
  const combinations = generateCombinations();

  console.log('════════════════════════════════════════════════════════════');
  console.log(' TRAILING STOP MATRIX - NO TARGET (Pure Trailing Stop Exit)');
  console.log('════════════════════════════════════════════════════════════\n');

  console.log(`Strategy:    ${STRATEGY_CONFIG.name}`);
  console.log(`Ticker:      ${config.ticker}`);
  console.log(`Date Range:  ${config.startDate} to ${config.endDate}`);
  console.log(`Target:      DISABLED (${STRATEGY_CONFIG.targetPoints} pts - effectively never hit)`);
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

      const metrics = extractMetrics(result.outputFile);
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
  const csvHeader = 'trigger,offset,trades,win_rate,total_pnl,avg_trade,profit_factor,max_dd,sharpe,ts_exits,tp_exits,sl_exits,mc_exits,ts_winners,ts_losers,ts_win_rate,avg_pts_winners,max_pts,p25_pts,p50_pts,p75_pts,p90_pts,winners_under20,winners_20to30,winners_30to40,winners_40plus,avg_pnl_trailing,total_pnl_trailing,total_pnl_winners,total_pnl_losers\n';
  const csvRows = results.map(r =>
    `${r.trigger},${r.offset},${r.trades || 0},${(r.winRate || 0).toFixed(2)},${(r.totalPnL || 0).toFixed(2)},${(r.avgTrade || 0).toFixed(2)},${(r.profitFactor || 0).toFixed(2)},${(r.maxDrawdown || 0).toFixed(2)},${(r.sharpe || 0).toFixed(2)},${r.trailingStopExits || 0},${r.takeProfitExits || 0},${r.stopLossExits || 0},${r.marketCloseExits || 0},${r.trailingWinners || 0},${r.trailingLosers || 0},${(r.trailingWinRate || 0).toFixed(2)},${(r.avgPointsTrailingWinners || 0).toFixed(2)},${(r.maxPointsTrailing || 0).toFixed(2)},${(r.p25Points || 0).toFixed(2)},${(r.p50Points || 0).toFixed(2)},${(r.p75Points || 0).toFixed(2)},${(r.p90Points || 0).toFixed(2)},${r.winnersUnder20 || 0},${r.winners20to30 || 0},${r.winners30to40 || 0},${r.winners40plus || 0},${(r.avgPnLTrailing || 0).toFixed(2)},${(r.totalPnLTrailing || 0).toFixed(2)},${(r.totalPnLWinners || 0).toFixed(2)},${(r.totalPnLLosers || 0).toFixed(2)}`
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
  console.log('─'.repeat(110));
  console.log('Rank | Trigger | Offset | Trades | Win%  | P&L       | PF   | TS Exits | TS Win% | Avg Pts | Max Pts');
  console.log('─'.repeat(110));

  results.slice(0, 10).forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(4)} | ${String(r.trigger).padStart(7)} | ${String(r.offset).padStart(6)} | ` +
      `${String(r.trades || 0).padStart(6)} | ${(r.winRate || 0).toFixed(1).padStart(5)}% | ` +
      `$${(r.totalPnL || 0).toFixed(0).padStart(8)} | ` +
      `${(r.profitFactor || 0).toFixed(2).padStart(4)} | ` +
      `${String(r.trailingStopExits || 0).padStart(8)} | ` +
      `${(r.trailingWinRate || 0).toFixed(1).padStart(7)}% | ` +
      `${(r.avgPointsTrailingWinners || 0).toFixed(1).padStart(7)} | ` +
      `${(r.maxPointsTrailing || 0).toFixed(0).padStart(7)}`
    );
  });

  console.log('');

  // Top 10 by Average Points
  const byAvgPts = [...results].sort((a, b) => (b.avgPointsTrailingWinners || 0) - (a.avgPointsTrailingWinners || 0));
  console.log('TOP 10 BY AVERAGE POINTS CAPTURED (Trailing Winners):');
  console.log('─'.repeat(110));
  console.log('Rank | Trigger | Offset | Avg Pts | Max Pts | P50   | P75   | P90   | TS Winners | Total P&L');
  console.log('─'.repeat(110));

  byAvgPts.slice(0, 10).forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(4)} | ${String(r.trigger).padStart(7)} | ${String(r.offset).padStart(6)} | ` +
      `${(r.avgPointsTrailingWinners || 0).toFixed(1).padStart(7)} | ` +
      `${(r.maxPointsTrailing || 0).toFixed(0).padStart(7)} | ` +
      `${(r.p50Points || 0).toFixed(0).padStart(5)} | ` +
      `${(r.p75Points || 0).toFixed(0).padStart(5)} | ` +
      `${(r.p90Points || 0).toFixed(0).padStart(5)} | ` +
      `${String(r.trailingWinners || 0).padStart(10)} | ` +
      `$${(r.totalPnL || 0).toFixed(0).padStart(8)}`
    );
  });

  console.log('');

  // Winners distribution for top configs
  console.log('WINNERS DISTRIBUTION BY POINTS (Top 10 by P&L):');
  console.log('─'.repeat(100));
  console.log('Rank | Trigger | Offset | <20 pts | 20-30   | 30-40   | 40+     | Total   | Avg Pts');
  console.log('─'.repeat(100));

  results.slice(0, 10).forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(4)} | ${String(r.trigger).padStart(7)} | ${String(r.offset).padStart(6)} | ` +
      `${String(r.winnersUnder20 || 0).padStart(7)} | ` +
      `${String(r.winners20to30 || 0).padStart(7)} | ` +
      `${String(r.winners30to40 || 0).padStart(7)} | ` +
      `${String(r.winners40plus || 0).padStart(7)} | ` +
      `${String(r.trailingWinners || 0).padStart(7)} | ` +
      `${(r.avgPointsTrailingWinners || 0).toFixed(1).padStart(7)}`
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
