#!/usr/bin/env node

// Debug script to analyze why GEX Level Sweep strategy isn't generating signals
// Tests the squeeze momentum indicator and GEX level detection

import { CSVLoader } from './src/data/csv-loader.js';
import { CandleAggregator } from './src/data/candle-aggregator.js';
import { GexLevelSweepStrategy } from '../shared/strategies/gex-level-sweep.js';
import { SqueezeMomentumIndicator } from '../shared/indicators/squeeze-momentum.js';
import fs from 'fs';
import path from 'path';

console.log('🔍 Debugging GEX Level Sweep Strategy\n');

async function debugStrategy() {
  try {
    // Load configuration
    const defaultConfigPath = path.join(process.cwd(), 'src/config/default.json');
    const defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));

    // Initialize data loader
    const csvLoader = new CSVLoader('./data', defaultConfig);
    const aggregator = new CandleAggregator();

    console.log('📊 Loading data for June-December 2025...');

    // Load data for the period
    const startDate = new Date('2025-06-01');
    const endDate = new Date('2025-12-19');

    // Load data using separate methods
    const [ohlcvData, gexLevels, liquidityLevels] = await Promise.all([
      csvLoader.loadOHLCVData('NQ', startDate, endDate),
      csvLoader.loadGEXData('NQ', startDate, endDate),
      csvLoader.loadLiquidityData('NQ', startDate, endDate)
    ]);

    console.log(`✅ Loaded ${ohlcvData.candles.length} 1-minute candles`);
    console.log(`✅ Loaded ${gexLevels.length} GEX level records`);
    console.log(`✅ Loaded ${liquidityLevels.length} LT records`);

    // Aggregate to 15-minute candles
    const data = {
      candles: aggregator.aggregate(ohlcvData.candles, '15m'),
      gexLevels: gexLevels,
      liquidityLevels: liquidityLevels
    };

    console.log(`✅ Aggregated to ${data.candles.length} 15-minute candles`);

    // Initialize strategy and indicator
    const strategy = new GexLevelSweepStrategy({
      defaultQuantity: 1,
      tradingSymbol: 'NQ',
      maxRiskPoints: 30,
      targetPoints: 20,
      stopBuffer: 10,
      maxBarsAfterSweep: 10,
      orderExpiryBars: 2,
      signalCooldownMs: 0 // No cooldown for testing
    });

    const squeezeIndicator = new SqueezeMomentumIndicator();

    console.log('\n🔍 Analyzing first 100 candles for patterns...\n');

    let gexLevelCount = 0;
    let sweepDetectionCount = 0;
    let squeezeCalculationCount = 0;
    let momentumValues = [];
    let levelSweeps = [];

    const sampleSize = Math.min(500, data.candles.length);

    for (let i = 20; i < sampleSize; i++) { // Start after 20 candles for indicator calculation
      const candle = data.candles[i];
      const timestamp = candle.timestamp;

      // Get GEX levels for this timestamp
      const marketData = getMarketDataForTimestamp(timestamp, data.gexLevels);

      if (marketData.gexLevels) {
        gexLevelCount++;

        // Test squeeze momentum calculation
        const recentCandles = data.candles.slice(Math.max(0, i - 25), i + 1);
        let squeezeData = null;

        try {
          squeezeData = squeezeIndicator.calculate(recentCandles, momentumValues.length > 0 ? momentumValues[momentumValues.length - 1] : null);

          if (squeezeData) {
            squeezeCalculationCount++;
            momentumValues.push(squeezeData.momentum.value);

            // Log interesting squeeze data
            if (i < 30) {
              console.log(`Candle ${i}: Close=${candle.close}, Momentum=${squeezeData.momentum.value.toFixed(4)}, State=${squeezeData.squeeze.state}`);
            }
          }
        } catch (error) {
          console.log(`Error calculating squeeze for candle ${i}:`, error.message);
        }

        // Test level sweep detection
        if (squeezeData) {
          marketData.squeezeData = squeezeData;

          const signal = strategy.evaluateSignal(candle, i > 0 ? data.candles[i - 1] : null, marketData);

          if (signal) {
            console.log(`\n🎯 SIGNAL FOUND at candle ${i}:`, signal);
          }

          // Check for level sweeps manually
          const sweep = detectLevelSweepManual(candle, marketData.gexLevels);
          if (sweep) {
            sweepDetectionCount++;
            levelSweeps.push({
              candleIndex: i,
              timestamp: new Date(timestamp).toISOString(),
              close: candle.close,
              sweep: sweep,
              momentum: squeezeData ? squeezeData.momentum.value : null
            });

            if (levelSweeps.length <= 5) {
              console.log(`\n🔄 Level Sweep ${levelSweeps.length} at candle ${i}:`);
              console.log(`   Close: ${candle.close}`);
              console.log(`   Sweep Type: ${sweep.type} at ${sweep.level}`);
              console.log(`   Direction: ${sweep.direction}`);
              console.log(`   Momentum: ${squeezeData ? squeezeData.momentum.value.toFixed(4) : 'N/A'}`);
              console.log(`   Strategy State: ${strategy.currentState}`);
            }
          }
        }
      }
    }

    // Summary statistics
    console.log('\n📊 ANALYSIS SUMMARY:');
    console.log('═══════════════════════════════════════');
    console.log(`Candles analyzed: ${sampleSize}`);
    console.log(`Candles with GEX levels: ${gexLevelCount}`);
    console.log(`Successful squeeze calculations: ${squeezeCalculationCount}`);
    console.log(`Level sweeps detected: ${sweepDetectionCount}`);
    console.log(`Total signals generated: 0 (as expected from backtest)`);

    if (momentumValues.length > 0) {
      const avgMomentum = momentumValues.reduce((a, b) => a + b, 0) / momentumValues.length;
      const minMomentum = Math.min(...momentumValues);
      const maxMomentum = Math.max(...momentumValues);

      console.log('\n📈 MOMENTUM STATISTICS:');
      console.log(`   Average: ${avgMomentum.toFixed(4)}`);
      console.log(`   Range: ${minMomentum.toFixed(4)} to ${maxMomentum.toFixed(4)}`);
      console.log(`   Bullish samples: ${momentumValues.filter(v => v > 0).length}`);
      console.log(`   Bearish samples: ${momentumValues.filter(v => v < 0).length}`);
    }

    if (levelSweeps.length > 0) {
      console.log('\n🎯 LEVEL SWEEP ANALYSIS:');
      console.log(`   Total sweeps found: ${levelSweeps.length}`);
      const bullishSweeps = levelSweeps.filter(s => s.sweep.direction === 'bullish_setup');
      const bearishSweeps = levelSweeps.filter(s => s.sweep.direction === 'bearish_setup');
      console.log(`   Bullish setups: ${bullishSweeps.length}`);
      console.log(`   Bearish setups: ${bearishSweeps.length}`);

      // Show first few sweeps with momentum
      console.log('\n   Sample sweeps with momentum data:');
      levelSweeps.slice(0, 3).forEach((sweep, idx) => {
        console.log(`   ${idx + 1}. ${sweep.sweep.type} @ ${sweep.level} | Momentum: ${sweep.momentum?.toFixed(4) || 'N/A'} | Close: ${sweep.close}`);
      });
    }

    console.log('\n🔍 POTENTIAL ISSUES TO INVESTIGATE:');
    console.log('1. Are momentum values in expected range?');
    console.log('2. Is momentum alignment logic working correctly?');
    console.log('3. Are GEX level sweeps being detected at all?');
    console.log('4. Is the state machine transitioning properly?');

  } catch (error) {
    console.error('❌ Debug failed:', error);
  }
}

// Helper function to get market data for timestamp
function getMarketDataForTimestamp(timestamp, gexLevels) {
  const marketData = { gexLevels: null };

  // Find GEX levels for this timestamp
  for (let i = gexLevels.length - 1; i >= 0; i--) {
    const gexRecord = gexLevels[i];
    if (gexRecord.timestamp <= timestamp) {
      marketData.gexLevels = {
        nqSpot: null, // Not available in current data format
        gammaFlip: gexRecord.nq_gamma_flip,
        putWall: gexRecord.nq_put_wall_1,
        callWall: gexRecord.nq_call_wall_1,
        support: [gexRecord.nq_put_wall_1, gexRecord.nq_put_wall_2, gexRecord.nq_put_wall_3].filter(s => s),
        resistance: [gexRecord.nq_call_wall_1, gexRecord.nq_call_wall_2, gexRecord.nq_call_wall_3].filter(r => r),
        regime: gexRecord.regime
      };
      break;
    }
  }

  return marketData;
}

// Manual level sweep detection for debugging
function detectLevelSweepManual(candle, gexLevels) {
  if (!gexLevels) return null;

  const close = candle.close;

  // Check resistance sweeps
  if (gexLevels.resistance && gexLevels.resistance.length > 0) {
    for (const resistance of gexLevels.resistance) {
      if (close > resistance) {
        return {
          type: 'resistance',
          level: resistance,
          penetration: close - resistance,
          direction: 'bearish_setup'
        };
      }
    }
  }

  // Check support sweeps
  if (gexLevels.support && gexLevels.support.length > 0) {
    for (const support of gexLevels.support) {
      if (close < support) {
        return {
          type: 'support',
          level: support,
          penetration: support - close,
          direction: 'bullish_setup'
        };
      }
    }
  }

  return null;
}

// Run the debug analysis
debugStrategy();