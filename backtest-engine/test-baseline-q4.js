#!/usr/bin/env node
import { BacktestEngine } from './src/backtest-engine.js';

console.log('Testing baseline Q4 2025 (pullback disabled)');
const config = {
  ticker: 'NQ',
  startDate: new Date('2025-10-01'),
  endDate: new Date('2025-12-19'),
  timeframe: '15m',
  strategy: 'gex-ldpm-confluence-pullback',
  strategyParams: {
    confluenceThreshold: 5,
    entryDistance: 10,
    stopLossPoints: 50,
    enablePullbackSystem: false, // DISABLED to test baseline
    tradingSymbol: 'NQ'
  },
  commission: 5,
  initialCapital: 100000,
  dataDir: 'data',
  quiet: true
};

const engine = new BacktestEngine(config);
engine.run().then(results => {
  const perf = results?.performance?.summary || {};
  console.log(`Trades: ${perf.totalTrades || 0} | Win Rate: ${(perf.winRate || 0).toFixed(1)}% | P&L: $${(perf.totalPnL || 0).toFixed(0)}`);
}).catch(console.error);
