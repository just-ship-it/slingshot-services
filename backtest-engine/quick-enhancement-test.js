#!/usr/bin/env node

/**
 * Quick Enhancement Test
 *
 * Runs a targeted comparison of specific enhancements on 6 months of data
 * to identify the most promising improvements
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

// Test configurations for quick comparison
const testConfigs = [
  {
    name: 'base',
    description: 'Base Strategy',
    params: {
      strategy: 'gex-ldpm-confluence',
      confluenceThreshold: 10,
      entryDistance: 15,
      stopLossPoints: 40,
      volumeConfirmationPct: 0
    }
  },
  {
    name: 'enhanced_minimal',
    description: 'Enhanced - Minimal RSI Filter',
    params: {
      strategy: 'gex-ldpm-confluence-enhanced',
      useMomentumDivergence: true,
      useMarketStructure: false,
      useFibonacciEntry: false,
      requireDivergence: false,
      divergenceMinStrength: 20,  // Lower threshold
      confluenceThreshold: 10,
      entryDistance: 15,
      stopLossPoints: 40,
      volumeConfirmationPct: 0
    }
  },
  {
    name: 'enhanced_strict',
    description: 'Enhanced - Strict Requirements',
    params: {
      strategy: 'gex-ldpm-confluence-enhanced',
      useMomentumDivergence: true,
      useMarketStructure: true,
      useFibonacciEntry: false,
      requireDivergence: true,
      requireStructureBreak: true,
      divergenceMinStrength: 40,
      structureConfidenceMin: 60,
      confluenceThreshold: 10,
      entryDistance: 15,
      stopLossPoints: 40,
      volumeConfirmationPct: 0
    }
  }
];

// Test on 6 months of data for faster execution
const commonParams = {
  ticker: 'NQ',
  startDate: '2024-06-01',  // Summer 2024 - good volatility period
  endDate: '2024-11-30',    // 6 months
  timeframe: '15m',
  commission: 5,
  initialCapital: 100000,
  defaultQuantity: 1,
  maxRisk: 50,
  signalCooldownMs: 300000,
  targetAtCenter: true
};

/**
 * Run a single backtest
 */
async function runBacktest(config, outputDir) {
  const outputFile = path.join(outputDir, `${config.name}_results.json`);

  // Combine parameters
  const params = {
    ...commonParams,
    ...config.params
  };

  console.log(`\n📊 Running test: ${config.description}`);
  console.log(`   Output: ${outputFile}`);

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
        console.log(`   Net PnL: $${(summary.totalPnL || 0).toFixed(2)}`);

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
function generateQuickReport(results) {
  console.log(`\n\n📈 ENHANCEMENT COMPARISON RESULTS\n`);
  console.log(`| Strategy | Trades | Win Rate | Profit Factor | Sharpe | Max DD | Net PnL |`);
  console.log(`|----------|--------|----------|---------------|--------|--------|---------|`);

  for (const result of results) {
    const s = result.summary;
    const trades = s.totalTrades || 0;
    const winRate = (s.winRate || 0).toFixed(1);
    const pf = (s.profitFactor || 0).toFixed(2);
    const sharpe = (s.sharpeRatio || 0).toFixed(2);
    const dd = (s.maxDrawdown || 0).toFixed(1);
    const pnl = (s.totalPnL || 0).toFixed(0);

    console.log(`| ${result.description.padEnd(8)} | ${trades.toString().padEnd(6)} | ${winRate.padEnd(8)}% | ${pf.padEnd(13)} | ${sharpe.padEnd(6)} | ${dd.padEnd(6)}% | $${pnl.padEnd(6)} |`);
  }

  // Find best performers
  const bestByPnL = results.reduce((best, current) =>
    (current.summary.totalPnL || 0) > (best.summary.totalPnL || 0) ? current : best
  );
  const bestBySharpe = results.reduce((best, current) =>
    (current.summary.sharpeRatio || 0) > (best.summary.sharpeRatio || 0) ? current : best
  );
  const bestByWinRate = results.reduce((best, current) =>
    (current.summary.winRate || 0) > (best.summary.winRate || 0) ? current : best
  );

  console.log(`\n🏆 BEST PERFORMERS:`);
  console.log(`   Best PnL: ${bestByPnL.description} ($${(bestByPnL.summary.totalPnL || 0).toFixed(0)})`);
  console.log(`   Best Sharpe: ${bestBySharpe.description} (${(bestBySharpe.summary.sharpeRatio || 0).toFixed(2)})`);
  console.log(`   Best Win Rate: ${bestByWinRate.description} (${(bestByWinRate.summary.winRate || 0).toFixed(1)}%)`);

  // Improvement analysis
  const baseResult = results.find(r => r.config === 'base');
  if (baseResult && results.length > 1) {
    console.log(`\n📊 IMPROVEMENTS VS BASE:`);
    for (const result of results) {
      if (result.config === 'base') continue;

      const pnlChange = ((result.summary.totalPnL || 0) - (baseResult.summary.totalPnL || 0));
      const winRateChange = (result.summary.winRate || 0) - (baseResult.summary.winRate || 0);
      const sharpeChange = (result.summary.sharpeRatio || 0) - (baseResult.summary.sharpeRatio || 0);

      console.log(`\n   ${result.description}:`);
      console.log(`     PnL Change: ${pnlChange >= 0 ? '+' : ''}$${pnlChange.toFixed(0)}`);
      console.log(`     Win Rate Change: ${winRateChange >= 0 ? '+' : ''}${winRateChange.toFixed(1)}%`);
      console.log(`     Sharpe Change: ${sharpeChange >= 0 ? '+' : ''}${sharpeChange.toFixed(2)}`);
    }
  }
}

/**
 * Main execution
 */
async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const outputDir = path.join('/home/drew/projects/slingshot-services/backtest-engine/results', `quick_test_${timestamp}`);

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
      console.error(`❌ Test failed: ${config.name}`, error.message);
      // Continue with other tests
    }
  }

  // Generate comparison report
  if (results.length > 0) {
    generateQuickReport(results);
  }

  console.log(`\n✅ Quick test completed. Results in: ${outputDir}`);
}

// Run tests
main().catch(console.error);