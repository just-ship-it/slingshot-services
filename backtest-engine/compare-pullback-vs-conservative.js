#!/usr/bin/env node

/**
 * Compare Pullback Strategy vs Conservative Strategy
 *
 * Runs both strategies on the same dataset to measure improvement
 * from the two-tier pullback entry system.
 */

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs/promises';
import path from 'path';

async function compareStrategies() {
  console.log('🔬 Comparing Pullback vs Conservative Strategy Performance');
  console.log('=' .repeat(80));
  console.log();

  // Test configuration - using the same timeframe as our sample losing trades
  const baseConfig = {
    ticker: 'NQ',
    startDate: new Date('2025-10-01'),
    endDate: new Date('2025-12-19'),  // Through the sample trades we examined
    timeframe: '15m',
    commission: 5,
    initialCapital: 100000,
    dataDir: 'data',
    verbose: false,
    quiet: true,
    showTrades: false,
    suppressFibonacciDebug: true  // Suppress the massive fibonacci level debug output
  };

  const results = {};

  // Strategy 1: Original Conservative Strategy
  console.log('📊 Running Original GEX-LDPM Conservative Strategy...');
  console.log(`📅 Period: ${baseConfig.startDate.toISOString().slice(0, 10)} to ${baseConfig.endDate.toISOString().slice(0, 10)}`);

  const conservativeConfig = {
    ...baseConfig,
    strategy: 'gex-ldpm-confluence',
    strategyParams: {
      confluenceThreshold: 5,
      entryDistance: 10,
      stopLossPoints: 50,
      targetAtCenter: true,
      tradingSymbol: 'NQ'
    }
  };

  try {
    const conservativeEngine = new BacktestEngine(conservativeConfig);
    results.conservative = await conservativeEngine.run();
    console.log('✅ Conservative strategy complete\n');
  } catch (error) {
    console.error('❌ Error running conservative strategy:', error.message);
    results.conservative = null;
  }

  // Strategy 2: Enhanced Pullback Strategy
  console.log('🎯 Running Enhanced Pullback Strategy...');

  const pullbackConfig = {
    ...baseConfig,
    strategy: 'gex-ldpm-confluence-pullback',
    strategyParams: {
      confluenceThreshold: 5,
      entryDistance: 10,
      stopLossPoints: 50,
      targetAtCenter: true,
      tradingSymbol: 'NQ',

      // Pullback system parameters - relaxed for more trades
      enablePullbackSystem: true,
      maxPullbackWait: 24,           // 24 hours to wait for pullback
      maxPullbackDistance: 100,      // Max 100 points from signal (increased)
      minPullbackDistance: 5,        // Min 5 points for valid pullback (decreased)
      requireMomentumAlignment: false,  // Disabled for more trades
      requireLevelRespect: false,       // Disabled for more trades

      // Level detector weights
      structuralLevelWeight: 1.0,
      sessionLevelWeight: 1.2,       // Previous day/overnight levels get higher weight
      fibonacciLevelWeight: 0.8
    }
  };

  try {
    const pullbackEngine = new BacktestEngine(pullbackConfig);
    results.pullback = await pullbackEngine.run();
    console.log('✅ Pullback strategy complete\n');
  } catch (error) {
    console.error('❌ Error running pullback strategy:', error.message);
    results.pullback = null;
  }

  // Display comparison results
  console.log('=' .repeat(80));
  console.log('📊 STRATEGY COMPARISON RESULTS');
  console.log('=' .repeat(80));
  console.log();

  const formatValue = (value, prefix = '', suffix = '', decimals = 2) => {
    if (value === null || value === undefined) return 'N/A';
    return prefix + value.toFixed(decimals) + suffix;
  };

  const getMetric = (result, path, defaultValue = 0) => {
    if (!result) return defaultValue;
    const keys = path.split('.');
    let value = result;
    for (const key of keys) {
      value = value?.[key];
      if (value === undefined) return defaultValue;
    }
    return value;
  };

  // Extract metrics for comparison
  const metrics = {
    conservative: {
      trades: getMetric(results.conservative, 'performance.summary.totalTrades', 0),
      winRate: getMetric(results.conservative, 'performance.summary.winRate', 0),
      netPnL: getMetric(results.conservative, 'performance.summary.totalPnL', 0),
      maxDrawdown: getMetric(results.conservative, 'performance.summary.maxDrawdown', 0),
      sharpe: getMetric(results.conservative, 'performance.summary.sharpeRatio', 0),
      profitFactor: getMetric(results.conservative, 'performance.advanced.profitFactor', 0),
      avgWin: getMetric(results.conservative, 'performance.basic.avgWinningTrade', 0),
      avgLoss: getMetric(results.conservative, 'performance.basic.avgLosingTrade', 0),
      winTrades: getMetric(results.conservative, 'performance.basic.winningTrades', 0),
      lossTrades: getMetric(results.conservative, 'performance.basic.losingTrades', 0)
    },
    pullback: {
      trades: getMetric(results.pullback, 'performance.summary.totalTrades', 0),
      winRate: getMetric(results.pullback, 'performance.summary.winRate', 0),
      netPnL: getMetric(results.pullback, 'performance.summary.totalPnL', 0),
      maxDrawdown: getMetric(results.pullback, 'performance.summary.maxDrawdown', 0),
      sharpe: getMetric(results.pullback, 'performance.summary.sharpeRatio', 0),
      profitFactor: getMetric(results.pullback, 'performance.advanced.profitFactor', 0),
      avgWin: getMetric(results.pullback, 'performance.basic.avgWinningTrade', 0),
      avgLoss: getMetric(results.pullback, 'performance.basic.avgLosingTrade', 0),
      winTrades: getMetric(results.pullback, 'performance.basic.winningTrades', 0),
      lossTrades: getMetric(results.pullback, 'performance.basic.losingTrades', 0)
    }
  };

  // Display side-by-side comparison
  console.log('                     CONSERVATIVE        PULLBACK          IMPROVEMENT');
  console.log('-'.repeat(75));

  // Trade Statistics
  console.log(`Total Trades:        ${metrics.conservative.trades.toString().padEnd(18)} ${metrics.pullback.trades.toString().padEnd(18)} ${((metrics.pullback.trades - metrics.conservative.trades)).toString()}${metrics.pullback.trades < metrics.conservative.trades ? ' (fewer trades)' : ''}`);
  console.log(`Winning Trades:      ${metrics.conservative.winTrades.toString().padEnd(18)} ${metrics.pullback.winTrades.toString().padEnd(18)} ${((metrics.pullback.winTrades - metrics.conservative.winTrades) >= 0 ? '+' : '')}${(metrics.pullback.winTrades - metrics.conservative.winTrades)}`);
  console.log(`Losing Trades:       ${metrics.conservative.lossTrades.toString().padEnd(18)} ${metrics.pullback.lossTrades.toString().padEnd(18)} ${((metrics.pullback.lossTrades - metrics.conservative.lossTrades) <= 0 ? '' : '+')}${(metrics.pullback.lossTrades - metrics.conservative.lossTrades)}`);
  console.log();

  // Performance Metrics
  const winRateImprovement = metrics.pullback.winRate - metrics.conservative.winRate;
  console.log(`Win Rate:            ${formatValue(metrics.conservative.winRate, '', '%').padEnd(18)} ${formatValue(metrics.pullback.winRate, '', '%').padEnd(18)} ${winRateImprovement >= 0 ? '+' : ''}${formatValue(winRateImprovement, '', '%')} ${winRateImprovement > 5 ? '✅' : winRateImprovement > 0 ? '👍' : '❌'}`);

  const pnlImprovement = metrics.pullback.netPnL - metrics.conservative.netPnL;
  const pnlImprovementPct = metrics.conservative.netPnL !== 0 ? (pnlImprovement / Math.abs(metrics.conservative.netPnL)) * 100 : 0;
  console.log(`Net P&L:             ${formatValue(metrics.conservative.netPnL, '$').padEnd(18)} ${formatValue(metrics.pullback.netPnL, '$').padEnd(18)} ${pnlImprovement >= 0 ? '+' : ''}${formatValue(pnlImprovement, '$')} (${pnlImprovement >= 0 ? '+' : ''}${formatValue(pnlImprovementPct, '', '%', 1)}) ${pnlImprovement > 0 ? '✅' : '❌'}`);

  const ddImprovement = metrics.pullback.maxDrawdown - metrics.conservative.maxDrawdown;
  console.log(`Max Drawdown:        ${formatValue(metrics.conservative.maxDrawdown, '', '%').padEnd(18)} ${formatValue(metrics.pullback.maxDrawdown, '', '%').padEnd(18)} ${ddImprovement <= 0 ? '' : '+'}${formatValue(ddImprovement, '', '%')} ${ddImprovement < -2 ? '✅' : ddImprovement < 0 ? '👍' : '❌'}`);

  const sharpeImprovement = metrics.pullback.sharpe - metrics.conservative.sharpe;
  console.log(`Sharpe Ratio:        ${formatValue(metrics.conservative.sharpe).padEnd(18)} ${formatValue(metrics.pullback.sharpe).padEnd(18)} ${sharpeImprovement >= 0 ? '+' : ''}${formatValue(sharpeImprovement)} ${sharpeImprovement > 0.2 ? '✅' : sharpeImprovement > 0 ? '👍' : '❌'}`);

  const pfImprovement = metrics.pullback.profitFactor - metrics.conservative.profitFactor;
  console.log(`Profit Factor:       ${formatValue(metrics.conservative.profitFactor).padEnd(18)} ${formatValue(metrics.pullback.profitFactor).padEnd(18)} ${pfImprovement >= 0 ? '+' : ''}${formatValue(pfImprovement)} ${pfImprovement > 0.1 ? '✅' : pfImprovement > 0 ? '👍' : '❌'}`);
  console.log();

  // Trade Quality
  console.log(`Avg Win:             ${formatValue(metrics.conservative.avgWin, '$').padEnd(18)} ${formatValue(metrics.pullback.avgWin, '$').padEnd(18)} ${(metrics.pullback.avgWin - metrics.conservative.avgWin) >= 0 ? '+' : ''}${formatValue(metrics.pullback.avgWin - metrics.conservative.avgWin, '$')}`);
  console.log(`Avg Loss:            ${formatValue(metrics.conservative.avgLoss, '$').padEnd(18)} ${formatValue(metrics.pullback.avgLoss, '$').padEnd(18)} ${formatValue(metrics.pullback.avgLoss - metrics.conservative.avgLoss, '$')} ${Math.abs(metrics.pullback.avgLoss) < Math.abs(metrics.conservative.avgLoss) ? '✅' : '❌'}`);
  console.log();

  // Summary Assessment
  console.log('=' .repeat(75));
  console.log('📈 IMPROVEMENT SUMMARY');
  console.log('-'.repeat(75));

  const improvements = [];
  const degradations = [];

  if (winRateImprovement > 0) improvements.push(`Win rate improved by ${formatValue(winRateImprovement, '', '%', 1)}`);
  else if (winRateImprovement < 0) degradations.push(`Win rate decreased by ${formatValue(Math.abs(winRateImprovement), '', '%', 1)}`);

  if (pnlImprovement > 0) improvements.push(`P&L increased by ${formatValue(pnlImprovement, '$')} (${formatValue(pnlImprovementPct, '+', '%', 1)})`);
  else if (pnlImprovement < 0) degradations.push(`P&L decreased by ${formatValue(Math.abs(pnlImprovement), '$')}`);

  if (ddImprovement < 0) improvements.push(`Drawdown reduced by ${formatValue(Math.abs(ddImprovement), '', '%', 1)}`);
  else if (ddImprovement > 0) degradations.push(`Drawdown increased by ${formatValue(ddImprovement, '', '%', 1)}`);

  if (sharpeImprovement > 0) improvements.push(`Sharpe ratio improved by ${formatValue(sharpeImprovement, '', '', 2)}`);
  if (pfImprovement > 0) improvements.push(`Profit factor improved by ${formatValue(pfImprovement, '', '', 2)}`);

  if (Math.abs(metrics.pullback.avgLoss) < Math.abs(metrics.conservative.avgLoss)) {
    const lossReduction = ((Math.abs(metrics.conservative.avgLoss) - Math.abs(metrics.pullback.avgLoss)) / Math.abs(metrics.conservative.avgLoss)) * 100;
    improvements.push(`Average loss reduced by ${formatValue(lossReduction, '', '%', 1)}`);
  }

  console.log('✅ Improvements:');
  if (improvements.length > 0) {
    improvements.forEach(imp => console.log(`   • ${imp}`));
  } else {
    console.log('   • None detected');
  }

  console.log();
  console.log('⚠️  Potential Issues:');
  if (degradations.length > 0) {
    degradations.forEach(deg => console.log(`   • ${deg}`));
  } else {
    console.log('   • None detected');
  }

  // Overall Assessment
  console.log();
  console.log('🎯 OVERALL ASSESSMENT:');

  const scoreImprovements =
    (winRateImprovement > 0 ? 1 : 0) +
    (pnlImprovement > 0 ? 2 : 0) +
    (ddImprovement < 0 ? 2 : 0) +
    (sharpeImprovement > 0 ? 1 : 0) +
    (pfImprovement > 0 ? 1 : 0);

  if (scoreImprovements >= 5) {
    console.log('🏆 EXCELLENT - The pullback strategy shows significant improvement across all key metrics!');
  } else if (scoreImprovements >= 3) {
    console.log('👍 GOOD - The pullback strategy shows meaningful improvement in important areas.');
  } else if (scoreImprovements >= 1) {
    console.log('🤔 MIXED - Some improvements but needs further optimization.');
  } else {
    console.log('❌ NEEDS WORK - The pullback strategy needs parameter tuning.');
  }

  // Save comparison results
  const comparisonReport = {
    testDate: new Date().toISOString(),
    period: {
      start: baseConfig.startDate.toISOString(),
      end: baseConfig.endDate.toISOString(),
      ticker: baseConfig.ticker
    },
    results: {
      conservative: metrics.conservative,
      pullback: metrics.pullback
    },
    improvements: {
      winRate: winRateImprovement,
      netPnL: pnlImprovement,
      netPnLPercent: pnlImprovementPct,
      maxDrawdown: ddImprovement,
      sharpeRatio: sharpeImprovement,
      profitFactor: pfImprovement
    },
    assessment: {
      score: scoreImprovements,
      improvements: improvements,
      issues: degradations
    }
  };

  const outputFile = `results/pullback_comparison_${new Date().toISOString().slice(0, 10)}.json`;
  await fs.writeFile(outputFile, JSON.stringify(comparisonReport, null, 2));

  console.log();
  console.log(`📄 Full comparison report saved to: ${outputFile}`);

  // Recommendations
  console.log();
  console.log('💡 RECOMMENDATIONS:');

  if (metrics.pullback.trades === 0) {
    console.log('   ⚠️  No trades generated - pullback levels may be too strict');
    console.log('   • Try increasing maxPullbackDistance to 75-100 points');
    console.log('   • Reduce minPullbackDistance to 5 points');
    console.log('   • Disable requireMomentumAlignment temporarily');
  } else if (metrics.pullback.trades < metrics.conservative.trades * 0.5) {
    console.log('   • Trade count significantly reduced - consider loosening filters');
    console.log('   • Increase maxPullbackWait to allow more time for pullbacks');
  }

  if (winRateImprovement < 0) {
    console.log('   • Win rate decreased - pullback levels may need adjustment');
    console.log('   • Consider adjusting level detector weights');
  }

  if (ddImprovement > 0) {
    console.log('   • Drawdown increased - stops may be too tight at pullback levels');
    console.log('   • Consider increasing stop buffer from 8 to 12-15 points');
  }

  console.log();
  console.log('✅ Comparison complete!');

  return comparisonReport;
}

// Run comparison
compareStrategies().catch(console.error);