#!/usr/bin/env node

// Detailed debug backtest to trace exactly what happens at signal timestamps
// Focuses on June 5-6, 2025 when debug script found signals

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs';
import path from 'path';

console.log('🔍 Detailed Backtest Debug - Signal Timestamp Analysis\n');

const targetTimestamps = [
  1749100500000, // 2025-06-05T05:15:00.000Z (Candle 305)
  1749104100000, // 2025-06-05T06:15:00.000Z (Candle 309)
  1749189600000, // 2025-06-06T06:00:00.000Z (Candle 400)
  1749194100000, // 2025-06-06T07:15:00.000Z (Candle 405)
  1749197700000  // 2025-06-06T08:15:00.000Z (Candle 409)
];

async function debugBacktest() {
  // Create backtest config matching debug script exactly
  const backtestConfig = {
    ticker: 'NQ',
    startDate: new Date('2025-06-01'), // Wider window to get all data
    endDate: new Date('2025-06-10'), // Wider window to get all data
    timeframe: '15m',
    strategy: 'gex-level-sweep',
    strategyParams: {
      defaultQuantity: 1,
      tradingSymbol: 'NQ',
      maxRiskPoints: 30,
      targetPoints: 20,
      stopBuffer: 10,
      maxBarsAfterSweep: 10,
      orderExpiryBars: 2,
      signalCooldownMs: 0 // Critical: no cooldown
    },
    commission: 5,
    initialCapital: 100000,
    dataDir: './data',
    verbose: true,
    quiet: false,
    showTrades: true
  };

  console.log('📊 Configuration:');
  console.log('Target Timestamps for Analysis:');
  targetTimestamps.forEach((ts, i) => {
    console.log(`  ${i+1}: ${new Date(ts).toISOString()} (${ts})`);
  });
  console.log('\n🔄 Starting detailed backtest...\n');

  // Create the backtest engine
  const engine = new BacktestEngine(backtestConfig);

  // Load data first
  const data = await engine.loadData();

  console.log(`📈 Loaded ${data.candles.length} 15m candles for analysis`);
  console.log(`📊 Date range: ${new Date(data.candles[0].timestamp).toISOString()} → ${new Date(data.candles[data.candles.length-1].timestamp).toISOString()}\n`);

  // Find target candles
  const targetCandles = [];
  data.candles.forEach((candle, i) => {
    if (targetTimestamps.includes(candle.timestamp)) {
      targetCandles.push({ candle, index: i });
      console.log(`🎯 FOUND TARGET CANDLE ${targetTimestamps.indexOf(candle.timestamp) + 1}:`);
      console.log(`   Index: ${i}`);
      console.log(`   Timestamp: ${new Date(candle.timestamp).toISOString()}`);
      console.log(`   OHLC: O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close}\n`);
    }
  });

  if (targetCandles.length === 0) {
    console.log('❌ ERROR: No target candles found in dataset!');
    return;
  }

  // Now run manual analysis on each target candle
  console.log('🔍 DETAILED CANDLE-BY-CANDLE ANALYSIS:\n');

  for (const { candle, index } of targetCandles) {
    console.log(`${'='.repeat(80)}`);
    console.log(`🎯 ANALYZING TARGET CANDLE ${targetTimestamps.indexOf(candle.timestamp) + 1} (Index: ${index})`);
    console.log(`   Timestamp: ${new Date(candle.timestamp).toISOString()}`);
    console.log(`   OHLC: O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close}`);

    // Get market data for this timestamp
    const date = new Date(candle.timestamp);
    const dateKey = date.toDateString();
    console.log(`   Debug: Timestamp ${candle.timestamp} → Date ${date.toISOString()} → DateKey "${dateKey}"`);

    // Check what's in the lookup
    console.log(`   Debug: Available GEX dates in lookup:`);
    for (const [key, gex] of data.marketDataLookup.gex.entries()) {
      console.log(`      "${key}" → ${gex.date}`);
    }

    const marketData = engine.getMarketDataForTimestamp(candle.timestamp, data.marketDataLookup);

    console.log('\n📊 Market Data:');
    console.log(`   GEX Levels Available: ${!!marketData.gexLevels}`);
    if (marketData.gexLevels) {
      console.log(`   GEX Levels Object: ${JSON.stringify(marketData.gexLevels, null, 2)}`);
      if (marketData.gexLevels.putWalls) {
        console.log(`   GEX Levels: Put Walls=[${marketData.gexLevels.putWalls.join(', ')}]`);
      }
      if (marketData.gexLevels.callWalls) {
        console.log(`   GEX Levels: Call Walls=[${marketData.gexLevels.callWalls.join(', ')}]`);
      }
      console.log(`   Gamma Flip: ${marketData.gexLevels.gammaFlip}`);
    }
    console.log(`   Liquidity Levels Available: ${!!marketData.liquidityLevels}`);

    // Calculate squeeze data
    if (index >= 25 && engine.squeezeIndicator) {
      const recentCandles = data.candles.slice(Math.max(0, index - 25), index + 1);
      console.log(`\n🔄 Calculating squeeze momentum with ${recentCandles.length} candles...`);

      try {
        const squeezeData = engine.squeezeIndicator.calculate(recentCandles, engine.previousMomentum);
        if (squeezeData) {
          marketData.squeezeData = squeezeData;
          console.log(`   Momentum: ${squeezeData.momentum.value.toFixed(4)}`);
          console.log(`   Squeeze State: ${squeezeData.squeeze.state}`);
          console.log(`   BB Upper/Lower: ${squeezeData.bollingerBands.upperBB.toFixed(2)} / ${squeezeData.bollingerBands.lowerBB.toFixed(2)}`);
          console.log(`   KC Upper/Lower: ${squeezeData.keltnerChannels.upperKC.toFixed(2)} / ${squeezeData.keltnerChannels.lowerKC.toFixed(2)}`);
        } else {
          console.log('   ❌ Squeeze calculation returned null');
        }
      } catch (error) {
        console.log(`   ❌ Squeeze calculation failed: ${error.message}`);
      }
    }

    // Test signal evaluation
    console.log('\n🎯 Signal Evaluation:');
    if (index > 0) {
      const prevCandle = data.candles[index - 1];
      console.log(`   Previous candle: ${new Date(prevCandle.timestamp).toISOString()}`);
      console.log(`   Has prevCandle: ${!!prevCandle}`);
      console.log(`   Has marketData.gexLevels: ${!!marketData.gexLevels}`);
      console.log(`   Has marketData.squeezeData: ${!!marketData.squeezeData}`);

      if (prevCandle && marketData.gexLevels) {
        console.log('\n   🔄 Calling strategy.evaluateSignal()...');
        try {
          const signal = engine.strategy.evaluateSignal(candle, prevCandle, marketData);
          console.log(`   Signal Result: ${signal ? 'SIGNAL GENERATED!' : 'No signal'}`);

          if (signal) {
            console.log('   📈 SIGNAL DETAILS:');
            console.log(`      Action: ${signal.action}`);
            console.log(`      Side: ${signal.side}`);
            console.log(`      Price: ${signal.price}`);
            console.log(`      Stop Loss: ${signal.stop_loss}`);
            console.log(`      Take Profit: ${signal.take_profit}`);
          } else {
            // Let's dig deeper - check strategy state
            console.log('\n   🔍 Strategy Internal State:');
            console.log(`      Current State: ${engine.strategy.currentState}`);
            console.log(`      Candle History Length: ${engine.strategy.candleHistory.length}`);

            // Manual checks
            console.log('\n   🔍 Manual Level Sweep Check:');
            if (marketData.gexLevels && marketData.gexLevels.support && marketData.gexLevels.resistance) {
              const allLevels = [...marketData.gexLevels.support, ...marketData.gexLevels.resistance];
              console.log(`      Support Levels: [${marketData.gexLevels.support.join(', ')}]`);
              console.log(`      Resistance Levels: [${marketData.gexLevels.resistance.join(', ')}]`);
              console.log(`      Current Close: ${candle.close}`);

              // Check level sweeps manually
              for (const level of marketData.gexLevels.support) {
                if (candle.close < level) {
                  console.log(`      🎯 SUPPORT SWEEP! Close ${candle.close} below support ${level} (penetration: ${(level - candle.close).toFixed(2)})`);
                }
              }
              for (const level of marketData.gexLevels.resistance) {
                if (candle.close > level) {
                  console.log(`      🎯 RESISTANCE SWEEP! Close ${candle.close} above resistance ${level} (penetration: ${(candle.close - level).toFixed(2)})`);
                }
              }
            }
          }
        } catch (error) {
          console.log(`   ❌ evaluateSignal failed: ${error.message}`);
        }
      } else {
        console.log('   ❌ Missing required data for signal evaluation');
      }
    } else {
      console.log('   ❌ No previous candle available (index 0)');
    }

    console.log(`${'='.repeat(80)}\n`);
  }

  console.log('✅ Detailed analysis complete!');
}

// Run the debug analysis
debugBacktest().catch(console.error);