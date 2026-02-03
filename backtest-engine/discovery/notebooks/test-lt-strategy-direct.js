/**
 * Direct test of LT Failed Breakdown Strategy
 */

import { LTFailedBreakdownStrategy } from '../../../shared/strategies/lt-failed-breakdown.js';
import { CSVLoader } from '../../src/data/csv-loader.js';
import fs from 'fs';

const dataDir = '/home/drew/projects/slingshot-services/backtest-engine/data';
const configPath = '/home/drew/projects/slingshot-services/backtest-engine/src/config/default.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const loader = new CSVLoader(dataDir, config);

async function main() {
  const start = new Date('2025-01-02');
  const end = new Date('2025-01-05');

  // Load data
  console.log('Loading data...');
  const ltData = await loader.loadLiquidityData('nq', start, end);
  const ohlcv = await loader.loadOHLCVData('nq', start, end);

  console.log(`Loaded ${ltData.length} LT records`);
  console.log(`Loaded ${ohlcv.candles.length} OHLCV candles`);

  // Create strategy with debug enabled
  const strategy = new LTFailedBreakdownStrategy({
    debug: true,
    signalCooldownMs: 0  // Disable cooldown for testing
  });

  // Load LT data into strategy
  strategy.loadLTData(ltData);

  console.log('\n=== Testing strategy on first 100 candles ===\n');

  let signalCount = 0;
  let prevCandle = null;

  for (let i = 0; i < Math.min(100, ohlcv.candles.length); i++) {
    const candle = ohlcv.candles[i];

    // Create minimal market data
    const marketData = {};

    const signal = strategy.evaluateSignal(candle, prevCandle, marketData, { debug: false });

    if (signal) {
      signalCount++;
      console.log(`\nSIGNAL #${signalCount} at ${new Date(candle.timestamp).toISOString()}:`);
      console.log(`  Side: ${signal.side}`);
      console.log(`  Price: ${signal.price}`);
      console.log(`  Level: ${signal.levelKey} @ ${signal.levelValue}`);
      console.log(`  Reason: ${signal.reason}`);
    }

    prevCandle = candle;
  }

  console.log(`\n\n=== Total signals in first 100 candles: ${signalCount} ===`);

  // Now test with more candles
  console.log('\n=== Testing full dataset ===\n');

  strategy.reset();
  strategy.loadLTData(ltData);

  let totalSignals = 0;
  prevCandle = null;

  for (let i = 0; i < ohlcv.candles.length; i++) {
    const candle = ohlcv.candles[i];
    const marketData = {};

    const signal = strategy.evaluateSignal(candle, prevCandle, marketData, { debug: false });

    if (signal) {
      totalSignals++;
      if (totalSignals <= 10) {
        console.log(`Signal #${totalSignals}: ${new Date(candle.timestamp).toISOString()} | ${signal.side} @ ${signal.price} | ${signal.levelKey}`);
      }
    }

    prevCandle = candle;
  }

  console.log(`\nTotal signals: ${totalSignals}`);
}

main().catch(console.error);
