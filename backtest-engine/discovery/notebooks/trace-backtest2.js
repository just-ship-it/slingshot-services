/**
 * Trace through backtest engine - simpler version
 */

import { BacktestEngine } from '../../src/backtest-engine.js';

const config = {
  ticker: 'NQ',
  startDate: new Date('2025-01-02'),
  endDate: new Date('2025-01-05'),
  strategy: 'lt-failed-breakdown',
  timeframe: '1m',
  commission: 5,
  initialCapital: 100000,
  quiet: false,  // Let's see all output
  verbose: true,
  dataDir: '/home/drew/projects/slingshot-services/backtest-engine/data',
  strategyParams: {
    debug: true,
    signalCooldownMs: 300000  // 5 minutes (default for many strategies)
  }
};

async function main() {
  console.log('Creating BacktestEngine...');
  console.log('Strategy params:', config.strategyParams);

  const engine = new BacktestEngine(config);

  console.log('\nStrategy object:', engine.strategy.constructor.name);
  console.log('Strategy params after construction:', engine.strategy.params);

  console.log('\nCalling run()...');
  const results = await engine.run();

  console.log('\n=== RESULTS ===');
  console.log(`Signals: ${results.simulation.totalSignals}`);
  console.log(`Trades: ${results.simulation.executedTrades}`);
}

main().catch(console.error);
