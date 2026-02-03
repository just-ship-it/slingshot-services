/**
 * Test Level Bounce Strategy
 *
 * Tests the new bounce detection strategy that trades off
 * dynamic indicator levels (EMA, VWAP, Bollinger Bands).
 */

import { BacktestEngine } from './src/backtest-engine.js';

const baseConfig = {
  ticker: 'NQ',
  timeframe: '1m',  // Switch to 1m for more granularity
  startDate: new Date('2025-01-01'),
  endDate: new Date('2025-01-31'),
  strategy: 'level-bounce',
  dataDir: './data',
  initialCapital: 100000,
  commission: 5,
  quiet: true,
  strategyParams: {
    proximityPoints: 4,    // Slightly more relaxed
    minWickTouch: 1,
    minRejectionSize: 1,
    stopBuffer: 2,
    maxRisk: 8,            // Allow slightly more risk
    trailingTrigger: 2,
    trailingOffset: 2,
    targetPoints: 10,
    signalCooldownMs: 60000,
    useSessionFilter: true,
    allowedHoursEST: [[9.5, 16]],
  }
};

const testConfigs = [
  // Baseline without confirmation
  { name: '1m Baseline', params: {} },

  // Confirmation with relaxed settings
  { name: '1m Confirm (move 0.5)', params: { useConfirmation: true, confirmationMinMove: 0.5 } },
  { name: '1m Confirm (move 1)', params: { useConfirmation: true, confirmationMinMove: 1 } },

  // Confirmation + wider proximity
  { name: 'Confirm + prox 5', params: { useConfirmation: true, confirmationMinMove: 0.5, proximityPoints: 5 } },
  { name: 'Confirm + prox 6', params: { useConfirmation: true, confirmationMinMove: 0.5, proximityPoints: 6 } },

  // Only track key levels (VWAP and BB middle)
  { name: 'Confirm + VWAP only', params: { useConfirmation: true, confirmationMinMove: 0.5, emaPeriods: [], vwapBands: [], levelPriority: { vwap: 10 } } },
  { name: 'Confirm + EMA20 only', params: { useConfirmation: true, confirmationMinMove: 0.5, emaPeriods: [20], vwapBands: [], levelPriority: { ema: 10 } } },

  // Longer cooldown to avoid overtrading
  { name: 'Confirm + 3min cooldown', params: { useConfirmation: true, confirmationMinMove: 0.5, signalCooldownMs: 180000 } },
  { name: 'Confirm + 5min cooldown', params: { useConfirmation: true, confirmationMinMove: 0.5, signalCooldownMs: 300000 } },

  // Combined settings
  { name: 'Confirm + prox5 + 3min CD', params: { useConfirmation: true, confirmationMinMove: 0.5, proximityPoints: 5, signalCooldownMs: 180000 } },
  { name: 'Confirm + target15 + trail3', params: { useConfirmation: true, confirmationMinMove: 0.5, targetPoints: 15, trailingTrigger: 3, trailingOffset: 2 } },
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
    winRate: results.performance.basic.winRate / 100,
    avgWin: results.performance.basic.avgWin,
    avgLoss: Math.abs(results.performance.basic.avgLoss),
    totalPnL: results.performance.basic.totalPnL,
    profitFactor: results.performance.basic.profitFactor,
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('LEVEL BOUNCE STRATEGY - PARAMETER COMPARISON');
  console.log(`Period: ${baseConfig.startDate.toISOString().split('T')[0]} to ${baseConfig.endDate.toISOString().split('T')[0]}`);
  console.log(`Timeframe: ${baseConfig.timeframe} | Ticker: ${baseConfig.ticker}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  const results = [];

  for (const test of testConfigs) {
    process.stdout.write(`Testing: ${test.name.padEnd(30)}`);
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
  console.log('Config'.padEnd(32) + 'Trades'.padStart(8) + 'Win%'.padStart(8) + 'AvgWin'.padStart(10) + 'AvgLoss'.padStart(10) + 'P&L'.padStart(12) + 'PF'.padStart(8));
  console.log('─'.repeat(88));

  for (const r of results) {
    if (r.error) {
      console.log(`${r.name.padEnd(32)} ERROR: ${r.error}`);
    } else {
      console.log(
        r.name.padEnd(32) +
        String(r.trades).padStart(8) +
        `${(r.winRate * 100).toFixed(1)}%`.padStart(8) +
        `$${r.avgWin.toFixed(0)}`.padStart(10) +
        `$${r.avgLoss.toFixed(0)}`.padStart(10) +
        `$${r.totalPnL.toFixed(0)}`.padStart(12) +
        r.profitFactor.toFixed(2).padStart(8)
      );
    }
  }

  // Find best performing
  const validResults = results.filter(r => !r.error && r.trades > 0);
  if (validResults.length > 0) {
    const best = validResults.reduce((a, b) => a.totalPnL > b.totalPnL ? a : b);
    const bestWinRate = validResults.reduce((a, b) => a.winRate > b.winRate ? a : b);
    const bestPF = validResults.reduce((a, b) => a.profitFactor > b.profitFactor ? a : b);

    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('TOP PERFORMERS');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log(`Best P&L:           ${best.name} ($${best.totalPnL.toFixed(0)})`);
    console.log(`Best Win Rate:      ${bestWinRate.name} (${(bestWinRate.winRate * 100).toFixed(1)}%)`);
    console.log(`Best Profit Factor: ${bestPF.name} (${bestPF.profitFactor.toFixed(2)})`);
  }
}

main().catch(console.error);
