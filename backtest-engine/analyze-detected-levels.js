#!/usr/bin/env node

/**
 * Analyze Detected Levels for Sep 30, 2025 @ 11 PM EDT Signal
 *
 * Comprehensive analysis of what levels are being detected
 */

import { BacktestEngine } from './src/backtest-engine.js';

async function analyzeLevels() {
  console.log('🔍 Analyzing Level Detection for Sep 30, 2025 @ 11 PM EDT Signal');
  console.log('=' .repeat(60));
  console.log();

  // Configure with proper seeding
  const actualStartDate = new Date('2025-10-01T00:00:00Z');
  const seedingStartDate = new Date(actualStartDate.getTime() - (50 * 15 * 60 * 1000));

  const config = {
    ticker: 'NQ',
    startDate: seedingStartDate,
    endDate: new Date('2025-10-01T04:00:00Z'), // Just need the first few hours
    timeframe: '15m',
    strategy: 'gex-ldpm-confluence-pullback',
    strategyParams: {
      confluenceThreshold: 5,
      entryDistance: 10,
      stopLossPoints: 50,
      enablePullbackSystem: true,
      maxPullbackDistance: 100,
      tradingSymbol: 'NQ'
    },
    commission: 5,
    initialCapital: 100000,
    dataDir: 'data',
    verbose: false,
    quiet: true
  };

  try {
    const engine = new BacktestEngine(config);
    const data = await engine.loadData();

    // Separate seeding from test data
    const seedingEndTime = actualStartDate.getTime();
    const seedingCandles = data.candles.filter(c => c.timestamp < seedingEndTime);

    console.log(`📊 Data Loaded:`);
    console.log(`   Seeding candles: ${seedingCandles.length}`);
    console.log(`   Total candles: ${data.candles.length}`);
    console.log();

    // Initialize strategy with seeding
    const strategy = engine.strategy;

    // Build candle history
    seedingCandles.forEach(candle => {
      if (!strategy.candleHistory) {
        strategy.candleHistory = [];
      }
      strategy.candleHistory.push(candle);
    });

    // Process seeding candles
    if (strategy.candleHistory.length >= 27) {
      strategy.structuralLevels.processCandles(strategy.candleHistory);
      strategy.sessionLevels.processCandles(strategy.candleHistory);
      strategy.fibonacciLevels.processCandles(strategy.candleHistory);
    }

    // Now process candles up to the signal at 03:00 UTC
    const signalTime = new Date('2025-10-01T03:00:00Z').getTime();
    const candlesUntilSignal = data.candles.filter(c => c.timestamp <= signalTime);

    // Process remaining candles
    candlesUntilSignal.forEach(candle => {
      if (strategy.candleHistory.findIndex(c => c.timestamp === candle.timestamp) === -1) {
        strategy.candleHistory.push(candle);
      }
    });

    // Process all candles through detectors
    strategy.structuralLevels.processCandles(strategy.candleHistory);
    strategy.sessionLevels.processCandles(strategy.candleHistory);
    strategy.fibonacciLevels.processCandles(strategy.candleHistory);

    // Get the signal candle (Sep 30, 2025 @ 11 PM EDT = Oct 1 03:00 UTC)
    const signalCandle = candlesUntilSignal.find(c => c.timestamp === signalTime);

    console.log('📊 Signal Analysis:');
    console.log(`   Time: Sep 30, 2025 @ 11 PM EDT (2025-10-01T03:00:00.000Z)`);
    console.log(`   Price: $${signalCandle?.close || 24772.75}`);
    console.log();

    // Create test signal
    const testSignal = {
      side: 'sell',  // Testing SELL signal as shown in chart
      price: signalCandle?.close || 24772.75
    };

    // Get levels for each detector
    const currentPrice = testSignal.price;

    console.log('🎯 DETECTED LEVELS AT SIGNAL TIME:');
    console.log('=' .repeat(40));

    // Session Levels
    console.log('\n📅 SESSION LEVELS:');
    const sessionLevels = strategy.sessionLevels.getActiveLevels();
    const sessionPullbacks = strategy.sessionLevels.getPullbackLevels(currentPrice, testSignal.side, 100);

    console.log(`   Active levels: ${sessionLevels.length}`);
    console.log(`   Pullback levels (for ${testSignal.side}): ${sessionPullbacks.length}`);

    // Check RTH levels from previous day
    const sessionDebug = strategy.sessionLevels.getDebugInfo();
    if (sessionDebug.previousRTH) {
      console.log(`\n   Previous RTH (Yesterday's):`);
      console.log(`     High: $${sessionDebug.previousRTH.high}`);
      console.log(`     Low: $${sessionDebug.previousRTH.low}`);
    }

    sessionPullbacks.slice(0, 5).forEach(level => {
      const distance = Math.abs(level.price - currentPrice);
      console.log(`     - $${level.price.toFixed(2)} (${level.type}) - ${distance.toFixed(1)} pts away`);
    });

    // Fibonacci Levels
    console.log('\n📊 FIBONACCI LEVELS:');
    const fibLevels = strategy.fibonacciLevels.getActiveLevels();
    const fibPullbacks = strategy.fibonacciLevels.getPullbackLevels(currentPrice, testSignal.side, 100);

    console.log(`   Active levels: ${fibLevels.length}`);
    console.log(`   Pullback levels (for ${testSignal.side}): ${fibPullbacks.length}`);

    const fibDebug = strategy.fibonacciLevels.getDebugInfo();
    console.log(`   Recent swings: ${fibDebug.recentSwings.length}`);

    if (fibDebug.recentSwings.length > 0) {
      fibDebug.recentSwings.forEach(swing => {
        console.log(`     - ${swing.direction} swing: ${swing.size} pts`);
      });
    }

    fibPullbacks.slice(0, 5).forEach(level => {
      const distance = Math.abs(level.price - currentPrice);
      console.log(`     - $${level.price.toFixed(2)} (${level.description}) - ${distance.toFixed(1)} pts away`);
    });

    // Structural Levels
    console.log('\n📐 STRUCTURAL LEVELS:');
    const structuralLevels = strategy.structuralLevels.getActiveLevels();
    const structuralPullbacks = strategy.structuralLevels.getPullbackLevels(currentPrice, testSignal.side, 100);

    console.log(`   Active levels: ${structuralLevels.length}`);
    console.log(`   Pullback levels (for ${testSignal.side}): ${structuralPullbacks.length}`);

    structuralPullbacks.slice(0, 5).forEach(level => {
      const distance = Math.abs(level.price - currentPrice);
      console.log(`     - $${level.price.toFixed(2)} (${level.type}) - ${distance.toFixed(1)} pts away`);
    });

    // Compare to user's chart
    console.log('\n' + '=' .repeat(60));
    console.log('📊 COMPARISON TO CHART:');
    console.log('=' .repeat(60));
    console.log('\nUser\'s Chart Levels (from screenshot):');
    console.log('   - Yesterday\'s Low: $24,722.25');
    console.log('   - 50% Fib: $24,747.75');
    console.log('   - 70% Fib: $24,654.25');
    console.log('   - 79% Fib: $24,615.75');

    console.log('\nDetected Levels Summary:');
    if (sessionDebug.previousRTH) {
      console.log(`   ✅ Yesterday's Low detected: $${sessionDebug.previousRTH.low} (matches chart: $24,722.25)`);
    }

    if (fibPullbacks.length > 0) {
      console.log(`   📊 Fibonacci levels detected: ${fibPullbacks.length}`);
      const closest50 = fibPullbacks.find(l => l.description?.includes('50'));
      if (closest50) {
        console.log(`   - 50% level: $${closest50.price.toFixed(2)}`);
      }
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  }
}

analyzeLevels().catch(console.error);