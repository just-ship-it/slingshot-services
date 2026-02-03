#!/usr/bin/env node

/**
 * Debug Level Detection - Oct-Dec 2025
 *
 * Test level detection for recent highs/lows to verify against charts
 */

import { BacktestEngine } from './src/backtest-engine.js';

async function debugLevelDetection() {
  console.log('🔧 Debug Level Detection for Oct-Dec 2025');
  console.log('=' .repeat(60));
  console.log();

  const config = {
    ticker: 'NQ',
    startDate: new Date('2025-10-01'),
    endDate: new Date('2025-12-31'),  // 3 month period for testing
    timeframe: '15m',
    strategy: 'gex-ldpm-confluence', // Use original strategy to get signals
    strategyParams: {
      confluenceThreshold: 5,
      entryDistance: 10,
      stopLossPoints: 50,
      targetAtCenter: true,
      tradingSymbol: 'NQ'
    },
    commission: 5,
    initialCapital: 100000,
    dataDir: 'data',
    verbose: false,
    quiet: true,
    showTrades: false
  };

  console.log('📅 Test Period: Oct 1 - Dec 31, 2025');
  console.log('🎯 Looking for confluence signals to debug level detection...');
  console.log();

  try {
    const engine = new BacktestEngine(config);

    // Override the evaluateSignal to capture signals and analyze levels
    const originalStrategy = engine.strategy;
    const originalEvaluate = originalStrategy.evaluateSignal.bind(originalStrategy);

    let signalCount = 0;

    originalStrategy.evaluateSignal = function(candle, prevCandle, marketData, options = {}) {
      const signal = originalEvaluate(candle, prevCandle, marketData, options);

      if (signal && signalCount < 3) { // Capture first 3 signals for analysis
        signalCount++;

        const candleTime = new Date(candle.timestamp).toISOString();
        console.log(`\n🎯 SIGNAL ${signalCount} - ${signal.side.toUpperCase()} at ${candleTime}`);
        console.log(`   Entry Price: $${signal.price}`);
        console.log(`   Zone: $${signal.zone || 'N/A'}`);

        // Calculate recent highs/lows from historical candles passed in options
        const historicalCandles = options.historicalCandles || [];
        const recentLevels = calculateRecentLevels(historicalCandles, candle);

        console.log('\n📊 RECENT LEVEL ANALYSIS:');
        console.log(`   Last 1-hour High: $${recentLevels.oneHourHigh} (${recentLevels.oneHourHighTime})`);
        console.log(`   Last 1-hour Low:  $${recentLevels.oneHourLow} (${recentLevels.oneHourLowTime})`);
        console.log(`   Last 4-hour High: $${recentLevels.fourHourHigh} (${recentLevels.fourHourHighTime})`);
        console.log(`   Last 4-hour Low:  $${recentLevels.fourHourLow} (${recentLevels.fourHourLowTime})`);

        console.log('\n🔍 LEVEL DISTANCES FROM CURRENT PRICE:');
        const currentPrice = signal.price;
        console.log(`   1H High: ${(recentLevels.oneHourHigh - currentPrice).toFixed(1)} pts`);
        console.log(`   1H Low:  ${(currentPrice - recentLevels.oneHourLow).toFixed(1)} pts`);
        console.log(`   4H High: ${(recentLevels.fourHourHigh - currentPrice).toFixed(1)} pts`);
        console.log(`   4H Low:  ${(currentPrice - recentLevels.fourHourLow).toFixed(1)} pts`);

        console.log('\n' + '='.repeat(60));
      }

      return signal;
    };

    const results = await engine.run();

    console.log('\n✅ Level detection analysis complete!');
    console.log(`Found ${signalCount} signals for level analysis.`);
    console.log('\nPlease verify these levels against your charts to confirm accuracy.');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  }
}

/**
 * Calculate recent highs/lows from candle data
 */
function calculateRecentLevels(candles, currentCandle) {
  if (!candles || candles.length === 0) {
    return {
      oneHourHigh: 0,
      oneHourLow: 0,
      fourHourHigh: 0,
      fourHourLow: 0,
      oneHourHighTime: 'N/A',
      oneHourLowTime: 'N/A',
      fourHourHighTime: 'N/A',
      fourHourLowTime: 'N/A'
    };
  }

  // Current candle should be the last in the historical array
  const currentIndex = candles.length - 1;

  // Calculate lookback periods (15m candles)
  const oneHourCandles = 4;   // 4 * 15min = 1 hour
  const fourHourCandles = 16; // 16 * 15min = 4 hours

  // Get 1-hour lookback
  const oneHourStart = Math.max(0, currentIndex - oneHourCandles);
  const oneHourData = candles.slice(oneHourStart, currentIndex);

  // Get 4-hour lookback
  const fourHourStart = Math.max(0, currentIndex - fourHourCandles);
  const fourHourData = candles.slice(fourHourStart, currentIndex);

  // Find highs and lows
  const oneHourHigh = oneHourData.length > 0 ? Math.max(...oneHourData.map(c => c.high)) : 0;
  const oneHourLow = oneHourData.length > 0 ? Math.min(...oneHourData.map(c => c.low)) : 0;

  const fourHourHigh = fourHourData.length > 0 ? Math.max(...fourHourData.map(c => c.high)) : 0;
  const fourHourLow = fourHourData.length > 0 ? Math.min(...fourHourData.map(c => c.low)) : 0;

  // Find timestamps of the highs/lows
  const oneHourHighCandle = oneHourData.find(c => c.high === oneHourHigh);
  const oneHourLowCandle = oneHourData.find(c => c.low === oneHourLow);
  const fourHourHighCandle = fourHourData.find(c => c.high === fourHourHigh);
  const fourHourLowCandle = fourHourData.find(c => c.low === fourHourLow);

  return {
    oneHourHigh,
    oneHourLow,
    fourHourHigh,
    fourHourLow,
    oneHourHighTime: oneHourHighCandle ? new Date(oneHourHighCandle.timestamp).toISOString().slice(11, 16) : 'N/A',
    oneHourLowTime: oneHourLowCandle ? new Date(oneHourLowCandle.timestamp).toISOString().slice(11, 16) : 'N/A',
    fourHourHighTime: fourHourHighCandle ? new Date(fourHourHighCandle.timestamp).toISOString().slice(11, 16) : 'N/A',
    fourHourLowTime: fourHourLowCandle ? new Date(fourHourLowCandle.timestamp).toISOString().slice(11, 16) : 'N/A'
  };
}

debugLevelDetection().catch(console.error);