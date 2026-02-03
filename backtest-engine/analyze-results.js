#!/usr/bin/env node

/**
 * Analyze Backtest Results
 * Extracts and displays actual performance metrics from JSON result files
 */

import fs from 'fs/promises';
import path from 'path';

const resultsDir = '/home/drew/projects/slingshot-services/backtest-engine/results/comprehensive_analysis_2026-';

async function analyzeResults() {
  console.log('📊 Analyzing Comprehensive Strategy Backtest Results');
  console.log('=' .repeat(80));
  console.log();

  const files = await fs.readdir(resultsDir);
  const jsonFiles = files.filter(f => f.endsWith('_results.json'));

  const results = [];

  for (const file of jsonFiles) {
    const filePath = path.join(resultsDir, file);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);

      const strategyName = file.replace('_results.json', '');

      // Extract metrics from the performance object
      const performance = data.performance || {};
      const summary = performance.summary || {};
      const basic = performance.basic || {};
      const advanced = performance.advanced || {};
      const monthly = performance.monthly || {};

      results.push({
        strategy: strategyName,
        trades: summary.totalTrades || basic.totalTrades || 0,
        winRate: summary.winRate || basic.winRate || 0,
        netPnL: summary.totalPnL || basic.netPnL || 0,
        maxDrawdown: summary.maxDrawdown || advanced.maxDrawdown || 0,
        sharpeRatio: summary.sharpeRatio || advanced.sharpeRatio || 0,
        profitFactor: advanced.profitFactor || 0,
        avgWinningTrade: basic.avgWinningTrade || 0,
        avgLosingTrade: basic.avgLosingTrade || 0,
        bestMonth: monthly.bestMonth?.return || 0,
        worstMonth: monthly.worstMonth?.return || 0,
        winningTrades: basic.winningTrades || 0,
        losingTrades: basic.losingTrades || 0
      });

    } catch (error) {
      console.error(`Error reading ${file}:`, error.message);
    }
  }

  // Sort by net PnL
  results.sort((a, b) => b.netPnL - a.netPnL);

  // Display results
  console.log('📈 PERFORMANCE RANKING (Sorted by Net P&L)');
  console.log('-'.repeat(80));
  console.log();

  results.forEach((r, index) => {
    const icon = r.netPnL > 0 ? '🟢' : r.netPnL < 0 ? '🔴' : '⚪';
    const pnlDisplay = r.netPnL >= 0 ? `+$${r.netPnL.toFixed(2)}` : `$${r.netPnL.toFixed(2)}`;

    console.log(`${index + 1}. ${icon} ${r.strategy.toUpperCase()}`);
    console.log(`   Net P&L: ${pnlDisplay}`);
    console.log(`   Trades: ${r.trades} (${r.winningTrades} wins / ${r.losingTrades} losses)`);
    console.log(`   Win Rate: ${r.winRate.toFixed(1)}%`);
    console.log(`   Max Drawdown: ${r.maxDrawdown.toFixed(1)}%`);
    console.log(`   Sharpe Ratio: ${r.sharpeRatio.toFixed(2)}`);
    console.log(`   Profit Factor: ${r.profitFactor.toFixed(2)}`);
    console.log(`   Avg Win: $${r.avgWinningTrade.toFixed(2)} | Avg Loss: $${Math.abs(r.avgLosingTrade).toFixed(2)}`);
    console.log(`   Best Month: ${r.bestMonth.toFixed(1)}% | Worst Month: ${r.worstMonth.toFixed(1)}%`);
    console.log();
  });

  // Summary statistics
  console.log('=' .repeat(80));
  console.log('📊 SUMMARY STATISTICS');
  console.log('-'.repeat(80));

  const profitableStrategies = results.filter(r => r.netPnL > 0);
  const totalPnL = results.reduce((sum, r) => sum + r.netPnL, 0);
  const avgWinRate = results.reduce((sum, r) => sum + r.winRate, 0) / results.length;
  const avgSharpe = results.reduce((sum, r) => sum + r.sharpeRatio, 0) / results.length;

  console.log(`Total Strategies Tested: ${results.length}`);
  console.log(`Profitable Strategies: ${profitableStrategies.length} (${(profitableStrategies.length / results.length * 100).toFixed(1)}%)`);
  console.log(`Combined Net P&L: $${totalPnL.toFixed(2)}`);
  console.log(`Average Win Rate: ${avgWinRate.toFixed(1)}%`);
  console.log(`Average Sharpe Ratio: ${avgSharpe.toFixed(2)}`);
  console.log();

  if (profitableStrategies.length > 0) {
    console.log('🏆 TOP PERFORMERS:');
    profitableStrategies.slice(0, 3).forEach((r, i) => {
      console.log(`   ${i + 1}. ${r.strategy}: $${r.netPnL.toFixed(2)} (${r.winRate.toFixed(1)}% win rate)`);
    });
  }

  // Create comparison table
  console.log();
  console.log('=' .repeat(80));
  console.log('📋 DETAILED COMPARISON TABLE');
  console.log('-'.repeat(80));
  console.log();
  console.log('| Strategy | Trades | Win% | Net P&L | Max DD | Sharpe | PF |');
  console.log('|----------|--------|------|---------|--------|--------|-----|');

  results.forEach(r => {
    const pnl = r.netPnL >= 0 ? `+$${r.netPnL.toFixed(0)}` : `$${r.netPnL.toFixed(0)}`;
    console.log(
      `| ${r.strategy.substring(0, 8).padEnd(8)} | ${r.trades.toString().padEnd(6)} | ${r.winRate.toFixed(1).padEnd(4)}% | ${pnl.padEnd(7)} | ${r.maxDrawdown.toFixed(1).padEnd(5)}% | ${r.sharpeRatio.toFixed(2).padEnd(6)} | ${r.profitFactor.toFixed(1).padEnd(3)} |`
    );
  });

  // Strategy type analysis
  console.log();
  console.log('=' .repeat(80));
  console.log('🔍 STRATEGY TYPE ANALYSIS');
  console.log('-'.repeat(80));

  const strategyTypes = {};
  results.forEach(r => {
    const baseType = r.strategy.split('-')[0];
    if (!strategyTypes[baseType]) {
      strategyTypes[baseType] = [];
    }
    strategyTypes[baseType].push(r);
  });

  Object.keys(strategyTypes).forEach(type => {
    const strategies = strategyTypes[type];
    const avgPnL = strategies.reduce((sum, r) => sum + r.netPnL, 0) / strategies.length;
    const bestVariant = strategies.reduce((best, current) =>
      current.netPnL > best.netPnL ? current : best
    );

    console.log(`\n${type.toUpperCase()} Strategies:`);
    console.log(`  Variants: ${strategies.length}`);
    console.log(`  Avg P&L: $${avgPnL.toFixed(2)}`);
    console.log(`  Best: ${bestVariant.strategy} ($${bestVariant.netPnL.toFixed(2)})`);
  });

  // Save summary to file
  const summaryReport = {
    generatedAt: new Date().toISOString(),
    totalStrategies: results.length,
    profitableCount: profitableStrategies.length,
    results: results,
    topPerformers: profitableStrategies.slice(0, 3),
    worstPerformers: results.slice(-3).reverse()
  };

  await fs.writeFile(
    path.join(resultsDir, 'analyzed_results.json'),
    JSON.stringify(summaryReport, null, 2)
  );

  console.log();
  console.log('=' .repeat(80));
  console.log('✅ Analysis complete! Results saved to analyzed_results.json');

  return results;
}

// Run analysis
analyzeResults().catch(console.error);