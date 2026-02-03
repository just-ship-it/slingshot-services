#!/usr/bin/env node

/**
 * Test GEX Level Sweep with S1 support level only (73.68% historical accuracy)
 */

import { BacktestEngine } from '../src/backtest-engine.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const config = {
  ticker: 'NQ',
  startDate: new Date('2024-01-01'),
  endDate: new Date('2024-12-31'),
  timeframe: '1m',
  strategy: 'gex-sweep',
  dataDir: join(__dirname, '..', 'data'),
  initialCapital: 100000,
  commission: 5,
  quiet: false,
  strategyParams: {
    // Ralph loop winning config
    requireVolumeSpike: true,
    volumeZThreshold: 2.0,
    rangeZThreshold: 1.5,
    wickRatio: 0.6,
    levelTolerance: 5,
    useSessionFilter: true,
    allowedSessions: ['premarket', 'overnight'],

    // Target/stop - Ralph loop winning config
    targetPoints: 3,
    stopPoints: 5,

    // Trade top-performing levels (S1: 73.68%, OvernightLow: 58.82%, OvernightHigh: 50.65%)
    tradeSupportLevels: ['S1', 'OvernightLow'],
    tradeResistanceLevels: ['R1', 'OvernightHigh']
  }
};

console.log('\n========================================');
console.log('   GEX Level Sweep - S1/R1 Only');
console.log('========================================\n');
console.log('Testing with S1/R1 levels only (highest accuracy per Ralph loop)');
console.log(`Period: ${config.startDate.toISOString().split('T')[0]} to ${config.endDate.toISOString().split('T')[0]}`);
console.log(`Target: ${config.strategyParams.targetPoints}pt | Stop: ${config.strategyParams.stopPoints}pt`);
console.log(`Sessions: ${config.strategyParams.allowedSessions.join(', ')}`);
console.log('\n');

const engine = new BacktestEngine(config);
engine.run().then(result => {
  const perf = result.performance;
  console.log('\n========================================');
  console.log('   S1/R1 ONLY RESULTS');
  console.log('========================================');
  console.log(`Trades: ${result.trades.length}`);
  console.log(`Win Rate: ${(perf.winRate || 0).toFixed(1)}%`);
  console.log(`Total P&L: $${(perf.totalPnL || 0).toFixed(0)}`);
  console.log(`Profit Factor: ${(perf.profitFactor || 0).toFixed(2)}`);
  console.log(`Max Drawdown: ${((perf.maxDrawdown || 0) * 100).toFixed(1)}%`);
  console.log(`Expectancy: $${(perf.expectancy || 0).toFixed(2)}`);
  console.log('\n');
}).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
