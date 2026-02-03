/**
 * Debug CLI parameter flow
 */

import { CLI } from '../../src/cli.js';

// Mock console to capture output
const originalLog = console.log;
const logs = [];
console.log = (...args) => {
  logs.push(args.join(' '));
  originalLog.apply(console, args);
};

// Patch executeBacktest to see strategyParams
class DebugCLI extends CLI {
  async executeBacktest(args) {
    console.log('\n=== DEBUG: args ===');
    console.log('args.strategy:', args.strategy);
    console.log('args.gexLevels:', args.gexLevels, typeof args.gexLevels);

    // Build strategy parameters like CLI does
    const strategyParams = {
      ...this.defaultConfig.strategies[args.strategy],
      tradingSymbol: args.ticker.toUpperCase()
    };

    console.log('\n=== After spreading default config ===');
    console.log('strategyParams.tradeLevels:', strategyParams.tradeLevels);

    // GEX level selection (from line 833)
    if (args.gexLevels) {
      console.log('\n=== args.gexLevels is truthy, applying... ===');
      strategyParams.tradeLevels = args.gexLevels.split(',').map(s => parseInt(s.trim(), 10));
    }

    console.log('\n=== Final tradeLevels ===');
    console.log('strategyParams.tradeLevels:', strategyParams.tradeLevels);

    // Don't run actual backtest
    console.log('\nDebug complete - not running actual backtest');
  }
}

const cli = new DebugCLI();

const argv = [
  'node', 'index.js',
  '--ticker', 'NQ',
  '--start', '2025-01-02',
  '--end', '2025-01-05',
  '--strategy', 'lt-failed-breakdown',
  '--timeframe', '1m'
];

cli.run(argv).catch(console.error);
