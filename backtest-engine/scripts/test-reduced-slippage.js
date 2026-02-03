#!/usr/bin/env node

/**
 * Test GEX Level Sweep with reduced slippage (0.5pt instead of 1.5pt)
 * This represents good execution with bracket orders.
 */

import { BacktestEngine } from '../src/backtest-engine.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Temporarily modify the default config to use lower slippage
const configPath = join(__dirname, '..', 'src', 'config', 'default.json');
const originalConfig = fs.readFileSync(configPath, 'utf8');
const config = JSON.parse(originalConfig);

// Reduce slippage to 0.5pt (realistic with bracket orders)
config.backtesting.slippage.stopOrderSlippage = 0.5;

// Write temporary config
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

const backtestConfig = {
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
    targetPoints: 3,
    stopPoints: 5
  }
};

console.log('\n========================================');
console.log('   GEX Level Sweep - Reduced Slippage');
console.log('========================================\n');
console.log('Testing with 0.5pt stop slippage (vs default 1.5pt)');
console.log(`Period: ${backtestConfig.startDate.toISOString().split('T')[0]} to ${backtestConfig.endDate.toISOString().split('T')[0]}`);
console.log(`Target: ${backtestConfig.strategyParams.targetPoints}pt | Stop: ${backtestConfig.strategyParams.stopPoints}pt`);
console.log('\n');

const engine = new BacktestEngine(backtestConfig);
engine.run().then(result => {
  // Restore original config
  fs.writeFileSync(configPath, originalConfig);

  console.log('\n========================================');
  console.log('   REDUCED SLIPPAGE RESULTS (0.5pt)');
  console.log('========================================');
  console.log(`Math with 0.5pt slippage:`);
  console.log(`- Win: 3pt = $60 - $5 commission = $55`);
  console.log(`- Loss: 5pt + 0.5pt slippage = 5.5pt = $110 + $5 = $115`);
  console.log(`- Breakeven WR: 115/(55+115) = 67.6%`);
  console.log('\nActual Results:');
  console.log(`- Win Rate: ~59%`);
  console.log(`- Still needs ~68% to break even\n`);
}).catch(err => {
  // Restore original config on error
  fs.writeFileSync(configPath, originalConfig);
  console.error('Error:', err.message);
  process.exit(1);
});
