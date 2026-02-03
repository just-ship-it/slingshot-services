#!/usr/bin/env node

/**
 * Test Swing Detection Logic
 *
 * Debug why fibonacci and structural levels are detecting 0 swings
 */

import { FibonacciLevelCalculator } from '../shared/indicators/fibonacci-levels.js';
import { StructuralLevelDetector } from '../shared/indicators/structural-levels.js';
import { BacktestEngine } from './src/backtest-engine.js';

async function testSwingDetection() {
  console.log('🔧 Testing Swing Detection Logic');
  console.log('=' .repeat(60));
  console.log();

  // Load some test data
  const config = {
    ticker: 'NQ',
    startDate: new Date('2025-10-01'),
    endDate: new Date('2025-10-02'),
    timeframe: '15m',
    strategy: 'gex-ldpm-confluence',
    strategyParams: {},
    commission: 5,
    initialCapital: 100000,
    dataDir: 'data',
    verbose: false,
    quiet: true
  };

  try {
    const engine = new BacktestEngine(config);
    const data = await engine.loadData();

    const candles = data.candles;  // These are the aggregated 15m candles
    console.log(`📊 Loaded ${candles?.length || 0} candles`);

    if (!candles || candles.length === 0) {
      console.log('❌ No candle data available for testing');
      return;
    }

    console.log(`📈 First candle: ${new Date(candles[0].timestamp).toISOString()} - ${candles[0].high}/${candles[0].low}`);
    console.log(`📈 Last candle: ${new Date(candles[candles.length-1].timestamp).toISOString()} - ${candles[candles.length-1].high}/${candles[candles.length-1].low}`);
    console.log();

    // Test basic price range
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);

    console.log(`💹 Price Range: ${minLow} - ${maxHigh} (${(maxHigh - minLow).toFixed(2)} point range)`);
    console.log();

    // Test Fibonacci calculator
    console.log('🔍 Testing Fibonacci Calculator:');
    const fibCalc = new FibonacciLevelCalculator({
      swingStrengthLeft: 3,
      swingStrengthRight: 3,
      minSwingSize: 5  // Very low threshold
    });

    const fibLevels = fibCalc.processCandles(candles);
    console.log(`📊 Fibonacci: Found ${fibLevels.length} levels from ${fibCalc.recentSwings.length} swings`);

    if (fibCalc.recentSwings.length > 0) {
      fibCalc.recentSwings.forEach((swing, i) => {
        console.log(`   Swing ${i+1}: ${swing.direction} from ${swing.start.price} to ${swing.end.price} (${swing.size.toFixed(1)} pts)`);
      });
    }

    console.log(`📊 Raw fib levels: ${fibCalc.fibLevels.length}`);
    if (fibCalc.fibLevels.length > 0) {
      fibCalc.fibLevels.slice(0, 3).forEach((level, i) => {
        console.log(`   Level ${i+1}: ${level.ratioPercent}% at ${level.price.toFixed(2)} - Fresh: ${level.isFresh} - Touches: ${level.touches} - Age: ${level.age?.toFixed(1)}h`);
      });
    }

    // Test manual swing detection on a small sample
    console.log();
    console.log('🔍 Manual Swing Test (first 20 candles):');

    const testCandles = candles.slice(0, 20);
    console.log('Candle data:');
    testCandles.forEach((candle, i) => {
      const time = new Date(candle.timestamp).toISOString().slice(11, 16);
      console.log(`  ${i}: ${time} H:${candle.high} L:${candle.low}`);
    });

    console.log();
    console.log('Testing 3/3 swing highs manually:');

    for (let i = 3; i < testCandles.length - 3; i++) {
      const currentHigh = testCandles[i].high;
      let isSwingHigh = true;

      // Check left side
      for (let j = i - 3; j < i; j++) {
        if (testCandles[j].high >= currentHigh) {
          isSwingHigh = false;
          break;
        }
      }

      if (!isSwingHigh) continue;

      // Check right side
      for (let j = i + 1; j <= i + 3; j++) {
        if (testCandles[j].high >= currentHigh) {
          isSwingHigh = false;
          break;
        }
      }

      if (isSwingHigh) {
        const time = new Date(testCandles[i].timestamp).toISOString().slice(11, 16);
        console.log(`  ✅ Swing High at index ${i} (${time}): ${currentHigh}`);
      }
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testSwingDetection().catch(console.error);