/**
 * Test Trend Scalp Filters
 *
 * Runs the trend-scalp strategy with each filter individually
 * to measure their impact on performance.
 */

import { BacktestEngine } from './src/backtest-engine.js';

const baseConfig = {
  ticker: 'NQ',
  timeframe: '5m',
  startDate: new Date('2024-10-01'),
  endDate: new Date('2025-01-31'),  // 4 months
  strategy: 'trend-scalp',
  dataDir: './data',
  initialCapital: 100000,
  commission: 5,
  quiet: true,
  strategyParams: {
    lookback: 3,
    minTrendSize: 5,
    maxRisk: 8,
    trailingTrigger: 2,
    trailingOffset: 2,
    targetPoints: 12,
    signalCooldownMs: 300000,
  }
};

const filterTests = [
  // Best filter combo with different trailing/risk settings
  { name: 'GEX+Body baseline', params: { useGexFilter: true, gexProximityPoints: 15, useBodySizeFilter: true, minBodySize: 2 } },
  { name: 'GEX+Body, maxRisk=6', params: { useGexFilter: true, gexProximityPoints: 15, useBodySizeFilter: true, minBodySize: 2, maxRisk: 6 } },
  { name: 'GEX+Body, maxRisk=5', params: { useGexFilter: true, gexProximityPoints: 15, useBodySizeFilter: true, minBodySize: 2, maxRisk: 5 } },
  { name: 'GEX+Body, trail 3/2', params: { useGexFilter: true, gexProximityPoints: 15, useBodySizeFilter: true, minBodySize: 2, trailingTrigger: 3, trailingOffset: 2 } },
  { name: 'GEX+Body, target 15', params: { useGexFilter: true, gexProximityPoints: 15, useBodySizeFilter: true, minBodySize: 2, targetPoints: 15 } },
  { name: 'GEX+Body, target 20', params: { useGexFilter: true, gexProximityPoints: 15, useBodySizeFilter: true, minBodySize: 2, targetPoints: 20 } },
];

async function runTest(testConfig) {
  const config = {
    ...baseConfig,
    strategyParams: { ...baseConfig.strategyParams, ...testConfig.params }
  };

  const engine = new BacktestEngine(config);
  const results = await engine.run();

  return {
    name: testConfig.name,
    trades: results.performance.basic.totalTrades,
    winRate: results.performance.basic.winRate / 100, // Convert from % to decimal
    avgWin: results.performance.basic.avgWin,
    avgLoss: Math.abs(results.performance.basic.avgLoss),
    totalPnL: results.performance.basic.totalPnL,
    profitFactor: results.performance.basic.profitFactor,
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('TREND SCALP FILTER COMPARISON');
  console.log('Period: 2025-01-01 to 2025-01-31 | Timeframe: 5m | Ticker: NQ');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  const results = [];

  for (const test of filterTests) {
    process.stdout.write(`Testing: ${test.name.padEnd(35)}`);
    try {
      const result = await runTest(test);
      results.push(result);
      console.log(`✓ ${result.trades} trades, ${(result.winRate * 100).toFixed(1)}% win, $${result.totalPnL.toFixed(0)} P&L`);
    } catch (error) {
      console.log(`✗ Error: ${error.message}`);
      results.push({ name: test.name, error: error.message });
    }
  }

  // Summary table
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('Filter'.padEnd(35) + 'Trades'.padStart(8) + 'Win%'.padStart(8) + 'AvgWin'.padStart(10) + 'AvgLoss'.padStart(10) + 'P&L'.padStart(12) + 'PF'.padStart(8));
  console.log('─'.repeat(91));

  for (const r of results) {
    if (r.error) {
      console.log(`${r.name.padEnd(35)} ERROR: ${r.error}`);
    } else {
      console.log(
        r.name.padEnd(35) +
        String(r.trades).padStart(8) +
        `${(r.winRate * 100).toFixed(1)}%`.padStart(8) +
        `$${r.avgWin.toFixed(0)}`.padStart(10) +
        `$${r.avgLoss.toFixed(0)}`.padStart(10) +
        `$${r.totalPnL.toFixed(0)}`.padStart(12) +
        r.profitFactor.toFixed(2).padStart(8)
      );
    }
  }

  // Find best performing filter
  const validResults = results.filter(r => !r.error && r.trades > 0);
  if (validResults.length > 0) {
    const best = validResults.reduce((a, b) => a.totalPnL > b.totalPnL ? a : b);
    const bestWinRate = validResults.reduce((a, b) => a.winRate > b.winRate ? a : b);
    const bestPF = validResults.reduce((a, b) => a.profitFactor > b.profitFactor ? a : b);

    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('TOP PERFORMERS');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log(`Best P&L:          ${best.name} ($${best.totalPnL.toFixed(0)})`);
    console.log(`Best Win Rate:     ${bestWinRate.name} (${(bestWinRate.winRate * 100).toFixed(1)}%)`);
    console.log(`Best Profit Factor: ${bestPF.name} (${bestPF.profitFactor.toFixed(2)})`);
  }
}

main().catch(console.error);
