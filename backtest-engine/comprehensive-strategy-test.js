#!/usr/bin/env node

/**
 * Comprehensive Strategy Analysis Framework
 *
 * Tests all available strategies with full historical data (April 2023 - December 2025)
 * to identify alpha-generating components and optimal parameters.
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

// All available strategies to test
const strategies = [
  {
    name: 'gex-recoil',
    description: 'GEX Recoil Strategy',
    params: {
      targetPoints: 25.0,
      stopBuffer: 10.0,
      maxRisk: 30.0,
      useLiquidityFilter: false,
      signalCooldownMs: 900000,  // 15 minutes
      maxLtLevelsBelow: 3
    }
  },
  {
    name: 'gex-ldpm-confluence',
    description: 'GEX-LDPM Confluence Strategy',
    params: {
      confluenceThreshold: 10,
      entryDistance: 15,
      stopLossPoints: 40,
      volumeConfirmationPct: 0,
      targetAtCenter: true,
      signalCooldownMs: 300000  // 5 minutes
    }
  },
  {
    name: 'gex-ldpm-confluence-lt',
    description: 'GEX-LDPM Confluence with LT Filtering',
    params: {
      confluenceThreshold: 10,
      entryDistance: 15,
      stopLossPoints: 40,
      volumeConfirmationPct: 20,
      targetAtCenter: true,
      signalCooldownMs: 300000,
      filterByLtConfiguration: true,
      ltFilterProfile: 'conservative'
    }
  },
  {
    name: 'gex-level-sweep',
    description: 'GEX Level Sweep Strategy',
    params: {
      targetPoints: 20,
      stopBuffer: 12,
      maxRisk: 30,
      maxBarsAfterSweep: 10,
      useLiquidityFilter: false,
      signalCooldownMs: 900000
    }
  },
  {
    name: 'gex-squeeze-confluence',
    description: 'GEX-Squeeze Confluence Strategy',
    params: {
      gexProximityPoints: 50,
      supportResistanceRank: 3,
      requireSqueezeOff: true,
      momentumThreshold: 0.5,
      stopLossPoints: 50,
      takeProfitPoints: 100,
      signalCooldownMs: 900000
    }
  }
];

// Test variations for key strategies
const strategyVariations = [
  {
    name: 'gex-ldpm-confluence-aggressive',
    baseStrategy: 'gex-ldpm-confluence',
    description: 'GEX-LDPM Confluence (Aggressive)',
    params: {
      confluenceThreshold: 15,
      entryDistance: 20,
      stopLossPoints: 30,
      volumeConfirmationPct: 0,
      signalCooldownMs: 180000  // 3 minutes
    }
  },
  {
    name: 'gex-ldpm-confluence-conservative',
    baseStrategy: 'gex-ldpm-confluence',
    description: 'GEX-LDPM Confluence (Conservative)',
    params: {
      confluenceThreshold: 5,
      entryDistance: 10,
      stopLossPoints: 50,
      volumeConfirmationPct: 50,
      signalCooldownMs: 600000  // 10 minutes
    }
  },
  {
    name: 'gex-recoil-tight',
    baseStrategy: 'gex-recoil',
    description: 'GEX Recoil (Tight Stops)',
    params: {
      targetPoints: 20.0,
      stopBuffer: 8.0,
      maxRisk: 25.0,
      useLiquidityFilter: true,
      signalCooldownMs: 600000,
      maxLtLevelsBelow: 2
    }
  },
  {
    name: 'gex-recoil-wide',
    baseStrategy: 'gex-recoil',
    description: 'GEX Recoil (Wide Stops)',
    params: {
      targetPoints: 35.0,
      stopBuffer: 15.0,
      maxRisk: 40.0,
      useLiquidityFilter: false,
      signalCooldownMs: 1200000,
      maxLtLevelsBelow: 5
    }
  }
];

// Common backtest parameters for full dataset analysis
const commonParams = {
  ticker: 'NQ',
  startDate: '2023-04-04',  // Full dataset
  endDate: '2025-12-19',    // Through December 2025
  timeframe: '15m',
  commission: 5,
  initialCapital: 100000,
  defaultQuantity: 1,
  maxRisk: 50
};

/**
 * Run a single backtest
 */
async function runBacktest(strategy, outputDir, isVariation = false) {
  const strategyName = isVariation ? strategy.baseStrategy : strategy.name;
  const outputFile = path.join(outputDir, `${strategy.name}_results.json`);

  // Combine parameters
  const params = {
    ...commonParams,
    ...strategy.params,
    strategy: strategyName
  };

  console.log(`\n📊 Running: ${strategy.description}`);
  console.log(`   Strategy: ${strategyName}`);
  console.log(`   Output: ${path.basename(outputFile)}`);

  // Build command line arguments
  const args = [
    'index.js',
    '--ticker', params.ticker,
    '--start', params.startDate,
    '--end', params.endDate,
    '--timeframe', params.timeframe,
    '--strategy', params.strategy,
    '--commission', params.commission.toString(),
    '--capital', params.initialCapital.toString(),
    '--output-json', outputFile,
    '--quiet'
  ];

  // Add strategy-specific parameters
  Object.keys(params).forEach(key => {
    if (!['ticker', 'startDate', 'endDate', 'timeframe', 'strategy', 'commission', 'initialCapital'].includes(key)) {
      const value = params[key];
      if (typeof value === 'boolean') {
        if (value) {
          args.push(`--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`);
        }
      } else {
        args.push(`--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`, value.toString());
      }
    }
  });

  const startTime = Date.now();

  // Run backtest
  return new Promise((resolve, reject) => {
    const backtest = spawn('node', args, {
      cwd: '/home/drew/projects/slingshot-services/backtest-engine'
    });

    let stdout = '';
    let stderr = '';

    backtest.stdout.on('data', (data) => {
      stdout += data.toString();
      // Only show summary progress, not full output
      if (data.toString().includes('✅') || data.toString().includes('❌')) {
        process.stdout.write(data);
      }
    });

    backtest.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    backtest.on('close', async (code) => {
      const duration = Math.round((Date.now() - startTime) / 1000);

      if (code !== 0) {
        console.error(`❌ Failed after ${duration}s: ${strategy.name}`);
        reject(new Error(stderr));
        return;
      }

      // Read results
      try {
        const results = JSON.parse(await fs.readFile(outputFile, 'utf-8'));
        const summary = results.summary || {};

        console.log(`✅ Completed in ${duration}s: ${strategy.name}`);
        console.log(`   📈 Trades: ${summary.totalTrades || 0} | Win Rate: ${(summary.winRate || 0).toFixed(1)}% | PnL: $${(summary.totalPnL || 0).toFixed(0)} | DD: ${(summary.maxDrawdown || 0).toFixed(1)}%`);

        resolve({
          name: strategy.name,
          description: strategy.description,
          strategyType: strategyName,
          isVariation,
          params: strategy.params,
          summary,
          executionTime: duration,
          outputFile
        });
      } catch (error) {
        console.error(`❌ Failed to read results: ${strategy.name}`, error.message);
        reject(error);
      }
    });
  });
}

/**
 * Generate comprehensive analysis report
 */
async function generateAnalysisReport(results, outputDir) {
  const reportFile = path.join(outputDir, 'comprehensive_strategy_analysis.md');

  // Sort results by net PnL
  const sortedResults = results.sort((a, b) => (b.summary.totalPnL || 0) - (a.summary.totalPnL || 0));

  let report = `# Comprehensive Strategy Analysis Report\n\n`;
  report += `**Analysis Period:** April 4, 2023 - December 19, 2025\n`;
  report += `**Generated:** ${new Date().toISOString()}\n`;
  report += `**Total Strategies Tested:** ${results.length}\n\n`;

  // Executive Summary
  report += `## 🎯 Executive Summary\n\n`;

  const bestStrategy = sortedResults[0];
  const worstStrategy = sortedResults[sortedResults.length - 1];
  const profitableStrategies = results.filter(r => (r.summary.totalPnL || 0) > 0);

  report += `- **Best Performing Strategy:** ${bestStrategy.description} (+$${(bestStrategy.summary.totalPnL || 0).toFixed(0)})\n`;
  report += `- **Worst Performing Strategy:** ${worstStrategy.description} ($${(worstStrategy.summary.totalPnL || 0).toFixed(0)})\n`;
  report += `- **Profitable Strategies:** ${profitableStrategies.length}/${results.length} (${((profitableStrategies.length / results.length) * 100).toFixed(1)}%)\n`;

  if (profitableStrategies.length > 0) {
    const avgProfit = profitableStrategies.reduce((sum, r) => sum + (r.summary.totalPnL || 0), 0) / profitableStrategies.length;
    report += `- **Average Profit (profitable strategies):** +$${avgProfit.toFixed(0)}\n`;
  }

  // Performance Comparison Table
  report += `\n## 📊 Performance Comparison\n\n`;
  report += `| Strategy | Trades | Win Rate | Net PnL | Max DD | Sharpe | Profit Factor | Avg Trade | Best Month | Worst Month |\n`;
  report += `|----------|--------|----------|---------|--------|--------|---------------|-----------|------------|-------------|\n`;

  for (const result of sortedResults) {
    const s = result.summary;
    const trades = s.totalTrades || 0;
    const winRate = (s.winRate || 0).toFixed(1);
    const pnl = (s.totalPnL || 0).toFixed(0);
    const dd = (s.maxDrawdown || 0).toFixed(1);
    const sharpe = (s.sharpeRatio || 0).toFixed(2);
    const pf = (s.profitFactor || 0).toFixed(2);
    const avgTrade = trades > 0 ? ((s.totalPnL || 0) / trades).toFixed(0) : '0';
    const bestMonth = (s.bestMonth?.return || 0).toFixed(1);
    const worstMonth = (s.worstMonth?.return || 0).toFixed(1);

    const pnlDisplay = (s.totalPnL || 0) >= 0 ? `+$${pnl}` : `$${pnl}`;
    const perfIcon = (s.totalPnL || 0) > 0 ? '🟢' : '🔴';

    report += `| ${perfIcon} ${result.description} | ${trades} | ${winRate}% | ${pnlDisplay} | ${dd}% | ${sharpe} | ${pf} | $${avgTrade} | ${bestMonth}% | ${worstMonth}% |\n`;
  }

  // Strategy Type Analysis
  report += `\n## 🔍 Strategy Type Analysis\n\n`;

  const strategyTypes = {};
  results.forEach(r => {
    const type = r.strategyType;
    if (!strategyTypes[type]) {
      strategyTypes[type] = [];
    }
    strategyTypes[type].push(r);
  });

  Object.keys(strategyTypes).forEach(type => {
    const strategies = strategyTypes[type];
    const avgPnL = strategies.reduce((sum, r) => sum + (r.summary.totalPnL || 0), 0) / strategies.length;
    const avgWinRate = strategies.reduce((sum, r) => sum + (r.summary.winRate || 0), 0) / strategies.length;
    const avgSharpe = strategies.reduce((sum, r) => sum + (r.summary.sharpeRatio || 0), 0) / strategies.length;

    report += `### ${type.toUpperCase().replace(/-/g, ' ')}\n`;
    report += `- **Variations Tested:** ${strategies.length}\n`;
    report += `- **Average PnL:** $${avgPnL.toFixed(0)}\n`;
    report += `- **Average Win Rate:** ${avgWinRate.toFixed(1)}%\n`;
    report += `- **Average Sharpe:** ${avgSharpe.toFixed(2)}\n`;

    const bestVariation = strategies.reduce((best, current) =>
      (current.summary.totalPnL || 0) > (best.summary.totalPnL || 0) ? current : best
    );
    report += `- **Best Variation:** ${bestVariation.description} ($${(bestVariation.summary.totalPnL || 0).toFixed(0)})\n\n`;
  });

  // Parameter Impact Analysis
  report += `## ⚙️ Parameter Impact Analysis\n\n`;

  // Analyze confluence strategies parameter impact
  const confluenceStrategies = results.filter(r => r.strategyType.includes('confluence'));
  if (confluenceStrategies.length > 1) {
    report += `### GEX-LDPM Confluence Parameter Optimization\n\n`;

    // Compare confluence thresholds
    const thresholdGroups = {};
    confluenceStrategies.forEach(r => {
      const threshold = r.params.confluenceThreshold || 10;
      if (!thresholdGroups[threshold]) {
        thresholdGroups[threshold] = [];
      }
      thresholdGroups[threshold].push(r);
    });

    report += `**Confluence Threshold Impact:**\n`;
    Object.keys(thresholdGroups).sort((a, b) => a - b).forEach(threshold => {
      const group = thresholdGroups[threshold];
      const avgPnL = group.reduce((sum, r) => sum + (r.summary.totalPnL || 0), 0) / group.length;
      const avgTrades = group.reduce((sum, r) => sum + (r.summary.totalTrades || 0), 0) / group.length;
      report += `- Threshold ${threshold}: Avg PnL $${avgPnL.toFixed(0)}, Avg Trades ${avgTrades.toFixed(0)}\n`;
    });
    report += `\n`;
  }

  // Alpha Generation Analysis
  report += `## 🎪 Alpha Generation Components\n\n`;

  if (profitableStrategies.length > 0) {
    report += `### Successful Strategy Characteristics:\n`;

    // Analyze what makes profitable strategies work
    const profitableSharpe = profitableStrategies.reduce((sum, r) => sum + (r.summary.sharpeRatio || 0), 0) / profitableStrategies.length;
    const profitableAvgWinRate = profitableStrategies.reduce((sum, r) => sum + (r.summary.winRate || 0), 0) / profitableStrategies.length;
    const profitableAvgTrades = profitableStrategies.reduce((sum, r) => sum + (r.summary.totalTrades || 0), 0) / profitableStrategies.length;

    report += `- **Average Sharpe Ratio:** ${profitableSharpe.toFixed(2)}\n`;
    report += `- **Average Win Rate:** ${profitableAvgWinRate.toFixed(1)}%\n`;
    report += `- **Average Trade Count:** ${profitableAvgTrades.toFixed(0)}\n`;

    // Identify common parameters among profitable strategies
    const commonParams = {};
    profitableStrategies.forEach(r => {
      Object.keys(r.params).forEach(param => {
        if (!commonParams[param]) {
          commonParams[param] = [];
        }
        commonParams[param].push(r.params[param]);
      });
    });

    report += `\n**Common Parameter Patterns:**\n`;
    Object.keys(commonParams).forEach(param => {
      const values = commonParams[param];
      const uniqueValues = [...new Set(values)];
      if (uniqueValues.length <= 3) {  // Only show if there's a clear pattern
        report += `- **${param}:** ${uniqueValues.join(', ')}\n`;
      }
    });
  }

  // Recommendations
  report += `\n## 💡 Recommendations\n\n`;

  if (profitableStrategies.length > 0) {
    const topStrategies = sortedResults.slice(0, Math.min(3, profitableStrategies.length));
    report += `### Focus Areas for Enhancement:\n`;
    topStrategies.forEach((strategy, index) => {
      report += `${index + 1}. **${strategy.description}** - Build upon this foundation\n`;
    });

    report += `\n### Next Steps:\n`;
    report += `1. **Implement Market Structure filters** on top-performing strategies\n`;
    report += `2. **Add Key Levels integration** for better entry timing\n`;
    report += `3. **Test momentum divergence confirmations** on profitable strategies\n`;
    report += `4. **Optimize position sizing** based on regime/volatility\n`;
    report += `5. **Implement dynamic stop losses** based on market structure\n`;
  } else {
    report += `### All strategies showed losses in this period. Consider:\n`;
    report += `1. **Period-specific analysis** - This may have been a challenging market period\n`;
    report += `2. **Fundamental strategy revision** - Review core assumptions\n`;
    report += `3. **Market regime adaptation** - Strategies may need regime-specific parameters\n`;
    report += `4. **Risk management enhancement** - Focus on downside protection\n`;
  }

  // Technical Details
  report += `\n## 📋 Technical Details\n\n`;
  report += `- **Test Period:** ${commonParams.startDate} to ${commonParams.endDate}\n`;
  report += `- **Timeframe:** ${commonParams.timeframe}\n`;
  report += `- **Commission:** $${commonParams.commission} per trade\n`;
  report += `- **Initial Capital:** $${commonParams.initialCapital.toLocaleString()}\n`;
  report += `- **Total Execution Time:** ${results.reduce((sum, r) => sum + r.executionTime, 0)} seconds\n\n`;

  // Write report
  await fs.writeFile(reportFile, report);

  // Also create JSON summary for programmatic analysis
  const jsonSummary = {
    generatedAt: new Date().toISOString(),
    testPeriod: {
      start: commonParams.startDate,
      end: commonParams.endDate,
      timeframe: commonParams.timeframe
    },
    totalStrategies: results.length,
    profitableStrategies: profitableStrategies.length,
    bestStrategy: bestStrategy,
    worstStrategy: worstStrategy,
    results: results.map(r => ({
      name: r.name,
      description: r.description,
      strategyType: r.strategyType,
      summary: r.summary,
      executionTime: r.executionTime
    }))
  };

  await fs.writeFile(path.join(outputDir, 'analysis_summary.json'), JSON.stringify(jsonSummary, null, 2));

  console.log(`\n📄 Analysis report generated: ${reportFile}`);
  return report;
}

/**
 * Main execution
 */
async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -19);
  const outputDir = path.join('/home/drew/projects/slingshot-services/backtest-engine/results', `comprehensive_analysis_${timestamp}`);

  // Create output directory
  await fs.mkdir(outputDir, { recursive: true });
  console.log(`📁 Analysis output directory: ${outputDir}\n`);

  const allResults = [];
  const allStrategies = [...strategies, ...strategyVariations];

  console.log(`🚀 Starting comprehensive strategy analysis...`);
  console.log(`📊 Testing ${allStrategies.length} strategy configurations`);
  console.log(`📅 Period: ${commonParams.startDate} to ${commonParams.endDate}\n`);

  // Run all tests
  for (let i = 0; i < allStrategies.length; i++) {
    const strategy = allStrategies[i];
    const progress = `[${i + 1}/${allStrategies.length}]`;

    try {
      console.log(`\n${progress} ====================================`);
      const result = await runBacktest(strategy, outputDir, strategyVariations.includes(strategy));
      allResults.push(result);
    } catch (error) {
      console.error(`❌ ${progress} Test failed: ${strategy.name}`, error.message);
      // Continue with other tests
    }
  }

  // Generate comprehensive analysis
  if (allResults.length > 0) {
    console.log(`\n🔍 Generating comprehensive analysis report...`);
    await generateAnalysisReport(allResults, outputDir);

    console.log(`\n✅ Comprehensive strategy analysis completed!`);
    console.log(`📊 Tested ${allResults.length}/${allStrategies.length} strategies successfully`);
    console.log(`📁 Results available in: ${outputDir}`);

    // Show top 3 performers
    const topPerformers = allResults
      .sort((a, b) => (b.summary.totalPnL || 0) - (a.summary.totalPnL || 0))
      .slice(0, 3);

    console.log(`\n🏆 Top Performers:`);
    topPerformers.forEach((result, index) => {
      console.log(`   ${index + 1}. ${result.description}: $${(result.summary.totalPnL || 0).toFixed(0)} (${(result.summary.winRate || 0).toFixed(1)}% win rate)`);
    });
  } else {
    console.log(`\n❌ No successful backtests completed.`);
  }
}

// Run comprehensive analysis
main().catch(console.error);