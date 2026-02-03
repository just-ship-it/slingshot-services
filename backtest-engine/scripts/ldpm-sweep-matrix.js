#!/usr/bin/env node

/**
 * LDPM Level Sweep Parameter Matrix
 *
 * Runs backtests with different symmetric stop/target configurations
 * to find optimal exit parameters.
 *
 * Configurations tested: 10, 20, 30, 40, 50 points (symmetric)
 *
 * Usage:
 *   node scripts/ldpm-sweep-matrix.js --start 2024-01-01 --end 2025-12-31
 *   node scripts/ldpm-sweep-matrix.js --start 2024-01-01 --end 2025-12-31 --output results/ldpm-sweep-matrix.csv
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';

import { BacktestEngine } from '../src/backtest-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parameter configurations to test (symmetric stop/target)
const POINT_CONFIGS = [10, 20, 30, 40, 50];

// Parse command line arguments
async function parseArgs() {
  return yargs(hideBin(process.argv))
    .usage('Usage: $0 [options]')
    .example('$0 --start 2024-01-01 --end 2025-12-31', 'Run parameter sweep')

    .option('start', {
      alias: 's',
      type: 'string',
      description: 'Start date (YYYY-MM-DD)',
      demandOption: true
    })

    .option('end', {
      alias: 'e',
      type: 'string',
      description: 'End date (YYYY-MM-DD)',
      demandOption: true
    })

    .option('ticker', {
      alias: 't',
      type: 'string',
      description: 'Ticker symbol',
      default: 'NQ'
    })

    .option('timeframe', {
      type: 'string',
      description: 'Chart timeframe',
      default: '15m'
    })

    .option('output', {
      alias: 'o',
      type: 'string',
      description: 'Output CSV file path',
      default: 'results/ldpm-sweep-matrix.csv'
    })

    .option('data-dir', {
      type: 'string',
      description: 'Data directory path',
      default: join(__dirname, '..', 'data')
    })

    .option('verbose', {
      alias: 'v',
      type: 'boolean',
      description: 'Verbose output',
      default: false
    })

    .help('h')
    .alias('h', 'help')
    .parse();
}

/**
 * Run a single backtest configuration
 */
async function runBacktest(config) {
  const engine = new BacktestEngine(config);
  return await engine.run();
}

/**
 * Calculate MFE/MAE distribution from trades
 */
function calculateExcursionStats(trades) {
  if (!trades || trades.length === 0) {
    return {
      avgMFE: 0,
      avgMAE: 0,
      mfeDistribution: {},
      maeDistribution: {}
    };
  }

  const mfes = trades.map(t => t.maxFavorable || 0);
  const maes = trades.map(t => Math.abs(t.maxAdverse || 0));

  const avgMFE = mfes.reduce((a, b) => a + b, 0) / mfes.length;
  const avgMAE = maes.reduce((a, b) => a + b, 0) / maes.length;

  // Distribution buckets: 0-10, 10-20, 20-30, 30-40, 40-50, 50+
  const buckets = ['0-10', '10-20', '20-30', '30-40', '40-50', '50+'];

  const getBucket = (value) => {
    if (value < 10) return '0-10';
    if (value < 20) return '10-20';
    if (value < 30) return '20-30';
    if (value < 40) return '30-40';
    if (value < 50) return '40-50';
    return '50+';
  };

  const mfeDistribution = {};
  const maeDistribution = {};
  buckets.forEach(b => {
    mfeDistribution[b] = 0;
    maeDistribution[b] = 0;
  });

  mfes.forEach(mfe => mfeDistribution[getBucket(mfe)]++);
  maes.forEach(mae => maeDistribution[getBucket(mae)]++);

  return { avgMFE, avgMAE, mfeDistribution, maeDistribution };
}

/**
 * Calculate % of trades that hit target before stop
 */
function calculateTargetHitRate(trades, targetPoints, stopPoints) {
  if (!trades || trades.length === 0) return 0;

  let hitTargetFirst = 0;

  for (const trade of trades) {
    const mfe = trade.maxFavorable || 0;
    const mae = Math.abs(trade.maxAdverse || 0);

    // If MFE reached target points, consider it a target hit
    // (even if stopped later, we're measuring if it COULD have hit target)
    if (mfe >= targetPoints) {
      // Check if target was reachable before stop
      // This is approximate - ideally we'd have tick-by-tick data
      if (mae < stopPoints || mfe >= targetPoints) {
        hitTargetFirst++;
      }
    }
  }

  return (hitTargetFirst / trades.length) * 100;
}

/**
 * Main execution
 */
async function main() {
  const args = await parseArgs();

  console.log(chalk.blue.bold('\n🎯 LDPM Level Sweep Parameter Matrix'));
  console.log(chalk.gray('═'.repeat(60)));
  console.log(chalk.white(`📅 Period: ${args.start} → ${args.end}`));
  console.log(chalk.white(`📈 Ticker: ${args.ticker.toUpperCase()}`));
  console.log(chalk.white(`⏱️  Timeframe: ${args.timeframe}`));
  console.log(chalk.white(`📊 Configurations: ${POINT_CONFIGS.join(', ')} points`));
  console.log(chalk.gray('═'.repeat(60)));

  const results = [];
  const startDate = new Date(args.start);
  const endDate = new Date(args.end);

  for (const points of POINT_CONFIGS) {
    console.log(chalk.cyan(`\n🔄 Testing ${points}/${points} points configuration...`));

    const config = {
      ticker: args.ticker.toUpperCase(),
      startDate,
      endDate,
      timeframe: args.timeframe,
      strategy: 'ldpm-level-sweep',
      strategyParams: {
        targetPoints: points,
        stopPoints: points,
        tradingSymbol: args.ticker.toUpperCase(),
        ldpmLookbackPeriods: 4,
        ldpmSlopeThreshold: 3,
        sweepBuffer: 2,
        includeGexLevels: true,
        includeSessionLevels: true
      },
      commission: 4.50,
      initialCapital: 100000,
      dataDir: args.dataDir,
      verbose: args.verbose,
      quiet: !args.verbose,
      showTrades: false,
      useSecondResolution: true
    };

    try {
      const backtest = await runBacktest(config);
      const trades = backtest.trades || [];
      const perf = backtest.performance || {};

      // Calculate excursion statistics
      const excursion = calculateExcursionStats(trades);

      // Calculate target hit rate
      const targetHitRate = calculateTargetHitRate(trades, points, points);

      // Calculate win/loss stats from trades
      const wins = trades.filter(t => t.netPnL > 0);
      const losses = trades.filter(t => t.netPnL < 0);
      const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netPnL, 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netPnL, 0) / losses.length : 0;
      const grossProfit = wins.reduce((s, t) => s + t.netPnL, 0);
      const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnL, 0));
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

      // Store results
      const result = {
        points,
        targetPoints: points,
        stopPoints: points,
        totalTrades: trades.length,
        winRate: perf.summary?.winRate || 0,
        netPnL: perf.summary?.totalPnL || 0,
        avgWin,
        avgLoss,
        profitFactor,
        maxDrawdown: perf.drawdown?.maxDrawdown || 0,
        avgMFE: excursion.avgMFE,
        avgMAE: excursion.avgMAE,
        targetHitRate,
        mfeDistribution: excursion.mfeDistribution,
        maeDistribution: excursion.maeDistribution
      };

      results.push(result);

      // Print summary
      console.log(chalk.green(`   ✅ ${trades.length} trades | Win Rate: ${result.winRate.toFixed(1)}% | P&L: $${result.netPnL.toLocaleString()}`));
      console.log(chalk.white(`      Avg Win: $${avgWin.toFixed(0)} | Avg Loss: $${avgLoss.toFixed(0)} | PF: ${profitFactor.toFixed(2)}`));
      console.log(chalk.white(`      Max DD: ${result.maxDrawdown.toFixed(1)}%`));

    } catch (error) {
      console.error(chalk.red(`   ❌ Error: ${error.message}`));
      results.push({
        points,
        targetPoints: points,
        stopPoints: points,
        totalTrades: 0,
        error: error.message
      });
    }
  }

  // Generate summary report
  console.log(chalk.blue.bold('\n📊 Summary'));
  console.log(chalk.gray('═'.repeat(60)));

  // Print table header
  console.log(chalk.white.bold('Points | Trades | Win%  | P&L        | MFE  | MAE  | Hit%'));
  console.log(chalk.gray('-'.repeat(60)));

  for (const r of results) {
    if (r.error) {
      console.log(chalk.red(`${r.points.toString().padEnd(6)} | ERROR: ${r.error}`));
    } else {
      const pnlStr = r.netPnL >= 0 ? chalk.green(`$${r.netPnL.toLocaleString().padStart(8)}`) : chalk.red(`$${r.netPnL.toLocaleString().padStart(8)}`);
      console.log(
        `${r.points.toString().padEnd(6)} | ` +
        `${r.totalTrades.toString().padEnd(6)} | ` +
        `${r.winRate.toFixed(1).padStart(5)}% | ` +
        `${pnlStr} | ` +
        `${r.avgMFE.toFixed(1).padStart(4)} | ` +
        `${r.avgMAE.toFixed(1).padStart(4)} | ` +
        `${r.targetHitRate.toFixed(1).padStart(4)}%`
      );
    }
  }

  // Save to CSV
  const outputDir = path.dirname(args.output);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const csvHeaders = [
    'points', 'target_points', 'stop_points', 'total_trades', 'win_rate',
    'net_pnl', 'avg_win', 'avg_loss', 'profit_factor', 'max_drawdown',
    'avg_mfe', 'avg_mae', 'target_hit_rate',
    'mfe_0_10', 'mfe_10_20', 'mfe_20_30', 'mfe_30_40', 'mfe_40_50', 'mfe_50_plus',
    'mae_0_10', 'mae_10_20', 'mae_20_30', 'mae_30_40', 'mae_40_50', 'mae_50_plus'
  ];

  const csvRows = results.map(r => [
    r.points,
    r.targetPoints,
    r.stopPoints,
    r.totalTrades,
    r.winRate?.toFixed(2) || 0,
    r.netPnL?.toFixed(2) || 0,
    r.avgWin?.toFixed(2) || 0,
    r.avgLoss?.toFixed(2) || 0,
    r.profitFactor?.toFixed(2) || 0,
    r.maxDrawdown?.toFixed(2) || 0,
    r.avgMFE?.toFixed(2) || 0,
    r.avgMAE?.toFixed(2) || 0,
    r.targetHitRate?.toFixed(2) || 0,
    r.mfeDistribution?.['0-10'] || 0,
    r.mfeDistribution?.['10-20'] || 0,
    r.mfeDistribution?.['20-30'] || 0,
    r.mfeDistribution?.['30-40'] || 0,
    r.mfeDistribution?.['40-50'] || 0,
    r.mfeDistribution?.['50+'] || 0,
    r.maeDistribution?.['0-10'] || 0,
    r.maeDistribution?.['10-20'] || 0,
    r.maeDistribution?.['20-30'] || 0,
    r.maeDistribution?.['30-40'] || 0,
    r.maeDistribution?.['40-50'] || 0,
    r.maeDistribution?.['50+'] || 0
  ].join(','));

  const csvContent = [csvHeaders.join(','), ...csvRows].join('\n');
  fs.writeFileSync(args.output, csvContent);

  console.log(chalk.green(`\n📄 Results saved to ${args.output}`));

  // Find best configuration
  const validResults = results.filter(r => !r.error && r.totalTrades > 0);
  if (validResults.length > 0) {
    const bestByPnL = validResults.reduce((best, r) => r.netPnL > best.netPnL ? r : best);
    const bestByWinRate = validResults.reduce((best, r) => r.winRate > best.winRate ? r : best);
    const bestByTargetHit = validResults.reduce((best, r) => r.targetHitRate > best.targetHitRate ? r : best);

    console.log(chalk.blue.bold('\n🏆 Best Configurations:'));
    console.log(chalk.white(`   By P&L:        ${bestByPnL.points} pts ($${bestByPnL.netPnL.toLocaleString()})`));
    console.log(chalk.white(`   By Win Rate:   ${bestByWinRate.points} pts (${bestByWinRate.winRate.toFixed(1)}%)`));
    console.log(chalk.white(`   By Target Hit: ${bestByTargetHit.points} pts (${bestByTargetHit.targetHitRate.toFixed(1)}%)`));
  }

  console.log(chalk.gray('\n═'.repeat(60)));
  console.log(chalk.green('✅ Parameter matrix complete'));
}

main().catch(error => {
  console.error(chalk.red(`\n❌ Fatal error: ${error.message}`));
  console.error(error.stack);
  process.exit(1);
});
