#!/usr/bin/env node

/**
 * Test Runner for GEX-LDPM Confluence Strategy Enhancements
 *
 * Runs backtests with different combinations of enhancements to measure impact:
 * 1. Base strategy (no enhancements)
 * 2. Base + Momentum Divergence
 * 3. Base + Market Structure
 * 4. Base + Fibonacci Entries
 * 5. Base + All Enhancements
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

// Test configurations
const testConfigs = [
  {
    name: 'base',
    description: 'Base strategy without enhancements',
    params: {
      strategy: 'gex-ldpm-confluence',
      useMomentumDivergence: false,
      useMarketStructure: false,
      useFibonacciEntry: false
    }
  },
  {
    name: 'momentum',
    description: 'Base + Momentum Divergence',
    params: {
      strategy: 'gex-ldpm-confluence-enhanced',
      useMomentumDivergence: true,
      useMarketStructure: false,
      useFibonacciEntry: false,
      requireDivergence: false,  // Don't require, just use as confirmation
      divergenceMinStrength: 30
    }
  },
  {
    name: 'structure',
    description: 'Base + Market Structure',
    params: {
      strategy: 'gex-ldpm-confluence-enhanced',
      useMomentumDivergence: false,
      useMarketStructure: true,
      useFibonacciEntry: false,
      requireStructureBreak: false,  // Don't require, just use as confirmation
      structureConfidenceMin: 50
    }
  },
  {
    name: 'fibonacci',
    description: 'Base + Fibonacci Entries',
    params: {
      strategy: 'gex-ldpm-confluence-enhanced',
      useMomentumDivergence: false,
      useMarketStructure: true,  // Need structure for fib levels
      useFibonacciEntry: true,
      requireStructureBreak: false
    }
  },
  {
    name: 'momentum_structure',
    description: 'Base + Momentum + Structure',
    params: {
      strategy: 'gex-ldpm-confluence-enhanced',
      useMomentumDivergence: true,
      useMarketStructure: true,
      useFibonacciEntry: false,
      requireDivergence: false,
      requireStructureBreak: false,
      divergenceMinStrength: 30,
      structureConfidenceMin: 50
    }
  },
  {
    name: 'all_soft',
    description: 'All Enhancements (Soft Requirements)',
    params: {
      strategy: 'gex-ldpm-confluence-enhanced',
      useMomentumDivergence: true,
      useMarketStructure: true,
      useFibonacciEntry: true,
      requireDivergence: false,
      requireStructureBreak: false,
      divergenceMinStrength: 30,
      structureConfidenceMin: 50,
      confirmedStopTightening: 0.75,
      unconfirmedPositionReduction: 0.7
    }
  },
  {
    name: 'all_strict',
    description: 'All Enhancements (Strict Requirements)',
    params: {
      strategy: 'gex-ldpm-confluence-enhanced',
      useMomentumDivergence: true,
      useMarketStructure: true,
      useFibonacciEntry: true,
      requireDivergence: true,  // Require divergence
      requireStructureBreak: true,  // Require structure break
      divergenceMinStrength: 40,
      structureConfidenceMin: 60,
      confirmedStopTightening: 0.6,
      waitForConfirmation: true,
      confirmationCandles: 3
    }
  }
];

// Common backtest parameters
const commonParams = {
  ticker: 'NQ',
  startDate: '2023-04-04',  // Full dataset from April 2023
  endDate: '2025-12-19',    // Through December 2025
  timeframe: '15m',
  commission: 5,
  initialCapital: 100000,
  // Base strategy params
  confluenceThreshold: 10,
  entryDistance: 15,
  stopLossPoints: 40,
  targetAtCenter: true,
  maxRisk: 50,
  volumeConfirmationPct: 0,  // Disable volume filter for cleaner testing
  signalCooldownMs: 300000,
  defaultQuantity: 1
};

/**
 * Run a single backtest
 */
async function runBacktest(config, outputDir) {
  const outputFile = path.join(outputDir, `${config.name}_results.json`);

  // Combine parameters
  const params = {
    ...commonParams,
    ...config.params,
    outputFiles: {
      json: outputFile
    }
  };

  console.log(`\n📊 Running test: ${config.description}`);
  console.log(`   Output: ${outputFile}`);

  // Create parameter file
  const paramFile = path.join(outputDir, `${config.name}_params.json`);
  await fs.writeFile(paramFile, JSON.stringify(params, null, 2));

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
    if (!['ticker', 'startDate', 'endDate', 'timeframe', 'strategy', 'commission', 'initialCapital', 'outputFiles'].includes(key)) {
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

  // Run backtest
  return new Promise((resolve, reject) => {
    const backtest = spawn('node', args, {
      cwd: '/home/drew/projects/slingshot-services/backtest-engine'
    });

    let stdout = '';
    let stderr = '';

    backtest.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data);
    });

    backtest.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    backtest.on('close', async (code) => {
      if (code !== 0) {
        console.error(`❌ Backtest failed with code ${code}`);
        reject(new Error(stderr));
        return;
      }

      // Read results
      try {
        const results = JSON.parse(await fs.readFile(outputFile, 'utf-8'));
        const summary = results.summary || {};

        console.log(`\n✅ Test completed: ${config.name}`);
        console.log(`   Trades: ${summary.totalTrades || 0}`);
        console.log(`   Win Rate: ${(summary.winRate || 0).toFixed(1)}%`);
        console.log(`   Profit Factor: ${(summary.profitFactor || 0).toFixed(2)}`);
        console.log(`   Sharpe Ratio: ${(summary.sharpeRatio || 0).toFixed(2)}`);
        console.log(`   Max Drawdown: ${(summary.maxDrawdown || 0).toFixed(1)}%`);
        console.log(`   Net PnL: $${(summary.netPnL || 0).toFixed(2)}`);

        resolve({
          config: config.name,
          description: config.description,
          summary
        });
      } catch (error) {
        console.error(`❌ Failed to read results: ${error.message}`);
        reject(error);
      }
    });
  });
}

/**
 * Generate comparison report
 */
async function generateReport(results, outputDir) {
  const reportFile = path.join(outputDir, 'enhancement_comparison.md');

  let report = `# GEX-LDPM Confluence Strategy Enhancement Analysis\n\n`;
  report += `Generated: ${new Date().toISOString()}\n\n`;
  report += `## Test Results\n\n`;

  // Create comparison table
  report += `| Configuration | Trades | Win Rate | Profit Factor | Sharpe | Max DD | Net PnL |\n`;
  report += `|--------------|--------|----------|---------------|--------|--------|----------|\n`;

  for (const result of results) {
    const s = result.summary;
    report += `| ${result.description} | ${s.totalTrades || 0} | ${(s.winRate || 0).toFixed(1)}% | ${(s.profitFactor || 0).toFixed(2)} | ${(s.sharpeRatio || 0).toFixed(2)} | ${(s.maxDrawdown || 0).toFixed(1)}% | $${(s.netPnL || 0).toFixed(0)} |\n`;
  }

  // Add analysis sections
  report += `\n## Key Findings\n\n`;

  // Find best performer
  const bestByPnL = results.reduce((best, current) =>
    (current.summary.netPnL || 0) > (best.summary.netPnL || 0) ? current : best
  );
  const bestBySharpe = results.reduce((best, current) =>
    (current.summary.sharpeRatio || 0) > (best.summary.sharpeRatio || 0) ? current : best
  );
  const bestByWinRate = results.reduce((best, current) =>
    (current.summary.winRate || 0) > (best.summary.winRate || 0) ? current : best
  );

  report += `- **Best Net PnL**: ${bestByPnL.description} ($${(bestByPnL.summary.netPnL || 0).toFixed(0)})\n`;
  report += `- **Best Sharpe Ratio**: ${bestBySharpe.description} (${(bestBySharpe.summary.sharpeRatio || 0).toFixed(2)})\n`;
  report += `- **Best Win Rate**: ${bestByWinRate.description} (${(bestByWinRate.summary.winRate || 0).toFixed(1)}%)\n`;

  // Calculate improvements
  const baseResult = results.find(r => r.config === 'base');
  if (baseResult) {
    report += `\n## Improvements vs Base Strategy\n\n`;

    for (const result of results) {
      if (result.config === 'base') continue;

      const pnlImprovement = ((result.summary.netPnL || 0) - (baseResult.summary.netPnL || 0)) /
                             Math.abs(baseResult.summary.netPnL || 1) * 100;
      const winRateImprovement = (result.summary.winRate || 0) - (baseResult.summary.winRate || 0);
      const sharpeImprovement = (result.summary.sharpeRatio || 0) - (baseResult.summary.sharpeRatio || 0);

      report += `### ${result.description}\n`;
      report += `- PnL Change: ${pnlImprovement >= 0 ? '+' : ''}${pnlImprovement.toFixed(1)}%\n`;
      report += `- Win Rate Change: ${winRateImprovement >= 0 ? '+' : ''}${winRateImprovement.toFixed(1)}%\n`;
      report += `- Sharpe Change: ${sharpeImprovement >= 0 ? '+' : ''}${sharpeImprovement.toFixed(2)}\n`;
      report += `- Trade Count: ${result.summary.totalTrades} (${((result.summary.totalTrades / baseResult.summary.totalTrades - 1) * 100).toFixed(1)}% change)\n\n`;
    }
  }

  // Write report
  await fs.writeFile(reportFile, report);
  console.log(`\n📄 Report generated: ${reportFile}`);

  return report;
}

/**
 * Main execution
 */
async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const outputDir = path.join('/home/drew/projects/slingshot-services/backtest-engine/results', `enhancement_test_${timestamp}`);

  // Create output directory
  await fs.mkdir(outputDir, { recursive: true });
  console.log(`📁 Output directory: ${outputDir}`);

  const results = [];

  // Run all tests
  for (const config of testConfigs) {
    try {
      const result = await runBacktest(config, outputDir);
      results.push(result);
    } catch (error) {
      console.error(`❌ Test failed: ${config.name}`, error);
      // Continue with other tests
    }
  }

  // Generate comparison report
  if (results.length > 0) {
    await generateReport(results, outputDir);
  }

  console.log(`\n✅ All tests completed. Results in: ${outputDir}`);
}

// Run tests
main().catch(console.error);