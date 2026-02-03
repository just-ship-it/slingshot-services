/**
 * Enhanced Strategy Validation Script
 *
 * Compares the original GEX Recoil strategy against the enhanced version
 * with negative GEX regime filtering.
 *
 * Based on correlation analysis findings:
 * - Support bounces in negative GEX: 57.1% win rate, +0.095% avg return
 * - Support bounces in positive GEX: 53.3% win rate, +0.015% avg return
 *
 * Usage: node research/validate-enhanced-strategy.js [--quick]
 */

import { BacktestEngine } from '../src/backtest-engine.js';
import { GexRecoilStrategy } from '../../shared/strategies/gex-recoil.js';
import { GexRecoilEnhancedStrategy } from '../../shared/strategies/gex-recoil-enhanced.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const config = {
  ticker: 'NQ',
  dataDir: path.join(__dirname, '..', 'data'),
  timeframe: '15m',
  commission: 5.0,
  initialCapital: 100000,
  verbose: false,
  quiet: true,
  showTrades: false,
  useSecondResolution: false  // Faster for validation
};

// Date ranges for testing
const dateRanges = {
  // Quick test - 3 months
  quick: {
    start: new Date('2025-01-01'),
    end: new Date('2025-03-31'),
    label: 'Q1 2025 (Quick Test)'
  },
  // Medium test - 6 months
  medium: {
    start: new Date('2025-01-01'),
    end: new Date('2025-06-30'),
    label: 'H1 2025'
  },
  // Full test - All 2025 data
  full: {
    start: new Date('2025-01-01'),
    end: new Date('2025-12-31'),
    label: 'Full Year 2025'
  },
  // Focused on GEX data availability (Mar 2023 - Dec 2025)
  gex_available: {
    start: new Date('2025-01-13'),
    end: new Date('2025-12-24'),
    label: '2025 GEX Data Range'
  }
};

async function runBacktest(strategyName, params, dateRange) {
  const backtestConfig = {
    ...config,
    strategy: strategyName,
    strategyParams: params,
    startDate: dateRange.start,
    endDate: dateRange.end
  };

  const engine = new BacktestEngine(backtestConfig);
  return await engine.run();
}

function formatNumber(num, decimals = 2) {
  if (num === null || num === undefined || isNaN(num)) return 'N/A';
  return num.toFixed(decimals);
}

function formatPercent(num) {
  if (num === null || num === undefined || isNaN(num)) return 'N/A';
  return (num * 100).toFixed(2) + '%';
}

function formatCurrency(num) {
  if (num === null || num === undefined || isNaN(num)) return 'N/A';
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printComparison(originalResults, enhancedResults, dateLabel) {
  // Performance data is nested under summary and basic
  const o = {
    totalTrades: originalResults.performance.summary.totalTrades,
    winningTrades: originalResults.performance.basic.winningTrades,
    losingTrades: originalResults.performance.basic.losingTrades,
    winRate: originalResults.performance.summary.winRate / 100,  // Convert to decimal
    netPnL: originalResults.performance.summary.totalPnL,
    averageTrade: originalResults.performance.basic.avgTrade,
    profitFactor: originalResults.performance.basic.profitFactor,
    sharpeRatio: originalResults.performance.summary.sharpeRatio,
    maxDrawdown: originalResults.performance.drawdown.maxDrawdown,
    maxDrawdownPercent: originalResults.performance.summary.maxDrawdown / 100,
    averageWin: originalResults.performance.basic.avgWin,
    averageLoss: originalResults.performance.basic.avgLoss,
    largestWin: originalResults.performance.basic.largestWin,
    largestLoss: originalResults.performance.basic.largestLoss
  };
  const e = {
    totalTrades: enhancedResults.performance.summary.totalTrades,
    winningTrades: enhancedResults.performance.basic.winningTrades,
    losingTrades: enhancedResults.performance.basic.losingTrades,
    winRate: enhancedResults.performance.summary.winRate / 100,
    netPnL: enhancedResults.performance.summary.totalPnL,
    averageTrade: enhancedResults.performance.basic.avgTrade,
    profitFactor: enhancedResults.performance.basic.profitFactor,
    sharpeRatio: enhancedResults.performance.summary.sharpeRatio,
    maxDrawdown: enhancedResults.performance.drawdown.maxDrawdown,
    maxDrawdownPercent: enhancedResults.performance.summary.maxDrawdown / 100,
    averageWin: enhancedResults.performance.basic.avgWin,
    averageLoss: enhancedResults.performance.basic.avgLoss,
    largestWin: enhancedResults.performance.basic.largestWin,
    largestLoss: enhancedResults.performance.basic.largestLoss
  };

  console.log('\n' + '='.repeat(80));
  console.log(`STRATEGY COMPARISON: ${dateLabel}`);
  console.log('='.repeat(80));

  console.log('\n┌────────────────────────────────────────────────────────────────────────────┐');
  console.log('│                            PERFORMANCE METRICS                              │');
  console.log('├─────────────────────────┬──────────────────────┬──────────────────────────┤');
  console.log('│ Metric                  │ Original (gex-recoil)│ Enhanced (regime filter) │');
  console.log('├─────────────────────────┼──────────────────────┼──────────────────────────┤');

  // Trade counts
  console.log(`│ Total Trades            │ ${String(o.totalTrades).padStart(20)} │ ${String(e.totalTrades).padStart(24)} │`);
  console.log(`│ Winning Trades          │ ${String(o.winningTrades).padStart(20)} │ ${String(e.winningTrades).padStart(24)} │`);
  console.log(`│ Losing Trades           │ ${String(o.losingTrades).padStart(20)} │ ${String(e.losingTrades).padStart(24)} │`);

  console.log('├─────────────────────────┼──────────────────────┼──────────────────────────┤');

  // Win rates
  const oWinRate = formatPercent(o.winRate);
  const eWinRate = formatPercent(e.winRate);
  const winRateDiff = e.winRate - o.winRate;
  const winRateIndicator = winRateDiff > 0 ? '↑' : winRateDiff < 0 ? '↓' : '─';
  console.log(`│ Win Rate                │ ${oWinRate.padStart(20)} │ ${eWinRate.padStart(24)} │`);

  // P&L
  const oNetPnL = formatCurrency(o.netPnL);
  const eNetPnL = formatCurrency(e.netPnL);
  console.log(`│ Net P&L                 │ ${oNetPnL.padStart(20)} │ ${eNetPnL.padStart(24)} │`);

  const oAvgTrade = formatCurrency(o.averageTrade);
  const eAvgTrade = formatCurrency(e.averageTrade);
  console.log(`│ Average Trade           │ ${oAvgTrade.padStart(20)} │ ${eAvgTrade.padStart(24)} │`);

  console.log('├─────────────────────────┼──────────────────────┼──────────────────────────┤');

  // Risk metrics
  const oProfitFactor = formatNumber(o.profitFactor);
  const eProfitFactor = formatNumber(e.profitFactor);
  console.log(`│ Profit Factor           │ ${oProfitFactor.padStart(20)} │ ${eProfitFactor.padStart(24)} │`);

  const oSharpe = formatNumber(o.sharpeRatio);
  const eSharpe = formatNumber(e.sharpeRatio);
  console.log(`│ Sharpe Ratio            │ ${oSharpe.padStart(20)} │ ${eSharpe.padStart(24)} │`);

  const oMaxDD = formatCurrency(o.maxDrawdown);
  const eMaxDD = formatCurrency(e.maxDrawdown);
  console.log(`│ Max Drawdown            │ ${oMaxDD.padStart(20)} │ ${eMaxDD.padStart(24)} │`);

  const oMaxDDPct = formatPercent(o.maxDrawdownPercent);
  const eMaxDDPct = formatPercent(e.maxDrawdownPercent);
  console.log(`│ Max Drawdown %          │ ${oMaxDDPct.padStart(20)} │ ${eMaxDDPct.padStart(24)} │`);

  console.log('├─────────────────────────┼──────────────────────┼──────────────────────────┤');

  // Win/loss analysis
  const oAvgWin = formatCurrency(o.averageWin);
  const eAvgWin = formatCurrency(e.averageWin);
  console.log(`│ Average Win             │ ${oAvgWin.padStart(20)} │ ${eAvgWin.padStart(24)} │`);

  const oAvgLoss = formatCurrency(o.averageLoss);
  const eAvgLoss = formatCurrency(e.averageLoss);
  console.log(`│ Average Loss            │ ${oAvgLoss.padStart(20)} │ ${eAvgLoss.padStart(24)} │`);

  const oLargestWin = formatCurrency(o.largestWin);
  const eLargestWin = formatCurrency(e.largestWin);
  console.log(`│ Largest Win             │ ${oLargestWin.padStart(20)} │ ${eLargestWin.padStart(24)} │`);

  const oLargestLoss = formatCurrency(o.largestLoss);
  const eLargestLoss = formatCurrency(e.largestLoss);
  console.log(`│ Largest Loss            │ ${oLargestLoss.padStart(20)} │ ${eLargestLoss.padStart(24)} │`);

  console.log('└─────────────────────────┴──────────────────────┴──────────────────────────┘');

  // Summary
  console.log('\n📊 COMPARISON SUMMARY:');
  console.log('─'.repeat(50));

  const tradeReduction = ((o.totalTrades - e.totalTrades) / o.totalTrades * 100);
  console.log(`   Trade Count Change: ${e.totalTrades - o.totalTrades} (${tradeReduction > 0 ? '-' : '+'}${Math.abs(tradeReduction).toFixed(1)}%)`);

  const winRateChange = (e.winRate - o.winRate) * 100;
  console.log(`   Win Rate Change: ${winRateChange >= 0 ? '+' : ''}${winRateChange.toFixed(2)}%`);

  const pnlChange = e.netPnL - o.netPnL;
  console.log(`   Net P&L Change: ${pnlChange >= 0 ? '+' : ''}${formatCurrency(pnlChange)}`);

  const pfChange = e.profitFactor - o.profitFactor;
  console.log(`   Profit Factor Change: ${pfChange >= 0 ? '+' : ''}${pfChange.toFixed(2)}`);

  // Verdict
  console.log('\n📋 VERDICT:');
  let score = 0;
  if (e.winRate > o.winRate) score++;
  if (e.netPnL > o.netPnL) score++;
  if (e.profitFactor > o.profitFactor) score++;
  if (e.sharpeRatio > o.sharpeRatio) score++;
  if (Math.abs(e.maxDrawdown) < Math.abs(o.maxDrawdown)) score++;

  if (score >= 4) {
    console.log('   ✅ Enhanced strategy shows SIGNIFICANT IMPROVEMENT');
  } else if (score >= 3) {
    console.log('   ✅ Enhanced strategy shows MODERATE IMPROVEMENT');
  } else if (score >= 2) {
    console.log('   ⚠️  Enhanced strategy shows MIXED RESULTS');
  } else {
    console.log('   ❌ Enhanced strategy shows WORSE PERFORMANCE');
  }

  return {
    original: o,
    enhanced: e,
    comparison: {
      tradeReduction,
      winRateChange,
      pnlChange,
      profitFactorChange: pfChange,
      score
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isQuick = args.includes('--quick');
  const isMedium = args.includes('--medium');
  const isFull = args.includes('--full');

  let selectedRange = dateRanges.gex_available;  // Default to GEX data range
  let rangeKey = 'gex_available';

  if (isQuick) {
    selectedRange = dateRanges.quick;
    rangeKey = 'quick';
  } else if (isMedium) {
    selectedRange = dateRanges.medium;
    rangeKey = 'medium';
  } else if (isFull) {
    selectedRange = dateRanges.full;
    rangeKey = 'full';
  }

  console.log('\n🚀 Enhanced GEX Recoil Strategy Validation');
  console.log('═'.repeat(60));
  console.log(`Date Range: ${selectedRange.label}`);
  console.log(`Period: ${selectedRange.start.toISOString().split('T')[0]} to ${selectedRange.end.toISOString().split('T')[0]}`);
  console.log('═'.repeat(60));

  console.log('\n⏳ Running original GEX Recoil strategy...');
  const startOriginal = Date.now();
  const originalResults = await runBacktest('gex-recoil', {}, selectedRange);
  const originalTime = ((Date.now() - startOriginal) / 1000).toFixed(1);
  console.log(`   ✅ Completed in ${originalTime}s (${originalResults.trades.length} trades)`);

  console.log('\n⏳ Running enhanced GEX Recoil strategy (with regime filter)...');
  const startEnhanced = Date.now();
  const enhancedResults = await runBacktest('gex-recoil-enhanced', {
    // All defaults are set in the strategy - no need to override
  }, selectedRange);
  const enhancedTime = ((Date.now() - startEnhanced) / 1000).toFixed(1);
  console.log(`   ✅ Completed in ${enhancedTime}s (${enhancedResults.trades.length} trades)`);

  // Print comparison
  const comparison = printComparison(originalResults, enhancedResults, selectedRange.label);

  // Save results to JSON
  const outputPath = path.join(__dirname, 'output', 'strategy_comparison_results.json');
  const outputData = {
    generated: new Date().toISOString(),
    dateRange: {
      key: rangeKey,
      label: selectedRange.label,
      start: selectedRange.start.toISOString(),
      end: selectedRange.end.toISOString()
    },
    original: {
      strategy: 'gex-recoil',
      trades: originalResults.trades.length,
      performance: originalResults.performance
    },
    enhanced: {
      strategy: 'gex-recoil-enhanced',
      trades: enhancedResults.trades.length,
      performance: enhancedResults.performance
    },
    comparison: comparison.comparison
  };

  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  console.log(`\n📄 Results saved to: ${outputPath}`);

  // Save detailed trade logs for both strategies
  const tradesDir = path.join(__dirname, 'output');

  const originalTradesPath = path.join(tradesDir, 'original_strategy_trades.json');
  fs.writeFileSync(originalTradesPath, JSON.stringify(originalResults.trades, null, 2));
  console.log(`📄 Original trades saved to: ${originalTradesPath}`);

  const enhancedTradesPath = path.join(tradesDir, 'enhanced_strategy_trades.json');
  fs.writeFileSync(enhancedTradesPath, JSON.stringify(enhancedResults.trades, null, 2));
  console.log(`📄 Enhanced trades saved to: ${enhancedTradesPath}`);

  console.log('\n✅ Validation complete!\n');
}

main().catch(console.error);
