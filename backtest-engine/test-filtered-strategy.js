/**
 * Test Filtered Level Bounce Strategy
 *
 * Uses only the profitable level+session combinations identified
 * from the full 2025 year analysis.
 */

import { BacktestEngine } from './src/backtest-engine.js';

// Profitable combinations from full year analysis
const profitableLevelSessionRules = {
  "BB_Middle": ["rth", "premarket"],
  "VWAP+2σ": ["premarket"],
  "VWAP": ["overnight"],
  "VWAP-3σ": ["rth"],
  "BB_Lower": ["afterhours"]
};

const config = {
  ticker: 'NQ',
  timeframe: '1m',
  startDate: new Date('2025-01-01'),
  endDate: new Date('2025-12-31'),
  strategy: 'level-bounce',
  dataDir: './data',
  initialCapital: 100000,
  commission: 5,
  quiet: false,
  showTrades: false,
  strategyParams: {
    proximityPoints: 4,
    minWickTouch: 1,
    minRejectionSize: 1,
    stopLossPoints: 10,       // Fixed 10pt stop
    targetPoints: 10,         // Fixed 10pt target
    trailingTrigger: 999,     // Disable trailing
    trailingOffset: 999,
    signalCooldownMs: 60000,
    useSessionFilter: false,   // Let levelSessionRules handle filtering
    useLimitOrders: true,
    orderTimeoutCandles: 3,
    maxRisk: 999,

    // Use only profitable level+session combinations
    levelSessionRules: profitableLevelSessionRules,

    // Enable adaptive tracking to monitor performance
    useAdaptiveTracking: true,
    adaptiveMinTrades: 20,
    adaptiveMinWinRate: 0.48,
    adaptiveMinProfitFactor: 0.95,
  }
};

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('FILTERED LEVEL BOUNCE STRATEGY - FULL YEAR 2025');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('Using only profitable level+session combinations:\n');

  for (const [level, sessions] of Object.entries(profitableLevelSessionRules)) {
    console.log(`  ${level}: ${sessions.join(', ')}`);
  }

  console.log('\n');

  const engine = new BacktestEngine(config);
  const results = await engine.run();

  // Print performance tracker summary if available
  if (results.simulation?.strategy?.getPerformanceSummary) {
    results.simulation.strategy.printPerformanceReport();
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('FILTERED STRATEGY RESULTS');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`Total Trades: ${results.performance.basic.totalTrades}`);
  console.log(`Win Rate: ${results.performance.basic.winRate.toFixed(1)}%`);
  console.log(`Total P&L: ${results.performance.basic.totalPnL >= 0 ? '+' : ''}$${results.performance.basic.totalPnL.toFixed(0)}`);
  console.log(`Profit Factor: ${results.performance.basic.profitFactor.toFixed(2)}`);
  console.log(`Avg Win: $${results.performance.basic.avgWin.toFixed(0)}`);
  console.log(`Avg Loss: $${Math.abs(results.performance.basic.avgLoss).toFixed(0)}`);
  console.log(`Max Drawdown: ${results.performance.risk.maxDrawdownPercent.toFixed(2)}%`);
}

main().catch(console.error);
