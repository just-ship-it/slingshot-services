/**
 * Trace through backtest engine to find where signals are lost
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
  quiet: true,
  verbose: false,
  dataDir: '/home/drew/projects/slingshot-services/backtest-engine/data',
  strategyParams: {
    debug: true,
    signalCooldownMs: 0
  }
};

async function main() {
  const engine = new BacktestEngine(config);

  console.log('Loading data...');
  const data = await engine.loadData();

  console.log(`Candles: ${data.candles.length}`);
  console.log(`Original Candles: ${data.originalCandles.length}`);
  console.log(`LT Levels: ${data.liquidityLevels.length}`);

  // Check if strategy has LT data loaded
  if (engine.strategy.ltLevels) {
    console.log(`Strategy LT data: ${engine.strategy.ltLevels.length} records`);
  } else {
    console.log('Strategy has NO ltLevels!');
  }

  // Manually test first few candles
  console.log('\n=== Testing first 50 candles manually ===\n');

  let prevCandle = null;
  let signalCount = 0;

  for (let i = 0; i < Math.min(50, data.candles.length); i++) {
    const candle = data.candles[i];
    const marketData = engine.getMarketDataForTimestamp(candle.timestamp, data.marketDataLookup, data);

    const signal = engine.strategy.evaluateSignal(candle, prevCandle, marketData, {});

    if (signal) {
      signalCount++;
      console.log(`Signal at candle ${i}: ${new Date(candle.timestamp).toISOString()}`);
    }

    prevCandle = candle;
  }

  console.log(`\nManual test: ${signalCount} signals`);

  // Now run full simulation
  console.log('\n=== Running full simulation ===');
  engine.strategy.reset();

  // Reload LT data
  if (data.liquidityLevels && engine.strategy.loadLTData) {
    engine.strategy.loadLTData(data.liquidityLevels);
    console.log('LT data reloaded after reset');
  }

  const results = await engine.runSimulation(data);
  console.log(`Full simulation: ${results.signals.length} signals, ${results.trades.length} trades`);
}

main().catch(console.error);
