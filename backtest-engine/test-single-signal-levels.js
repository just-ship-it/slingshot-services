#!/usr/bin/env node

/**
 * Test Single Signal Level Detection
 *
 * Quick test focusing on the Sep 30, 2025 @ 11 PM EDT signal
 */

import { GexLdpmConfluencePullbackStrategy } from '../shared/strategies/gex-ldpm-confluence-pullback.js';

async function testSingleSignal() {
  console.log('🔧 Testing Level Detection for Single Signal');
  console.log('=' .repeat(60));

  // Initialize strategy
  const strategy = new GexLdpmConfluencePullbackStrategy({
    confluenceThreshold: 5,
    entryDistance: 10,
    stopLossPoints: 50,
    targetAtCenter: true,
    enablePullbackSystem: true,
    swingStrengthLeft: 3,  // 3/3 for 15m candles
    swingStrengthRight: 3,
    tradingSymbol: 'NQ'
  });

  // Create some test candles around the signal time
  // Sep 30, 2025 @ 11 PM EDT = 2025-10-01T03:00:00.000Z
  const testCandles = [
    { timestamp: new Date('2025-10-01T00:00:00Z').getTime(), open: 24837, high: 24837, low: 24817.5, close: 24823 },
    { timestamp: new Date('2025-10-01T00:15:00Z').getTime(), open: 24823, high: 24823.5, low: 24785.5, close: 24792 },
    { timestamp: new Date('2025-10-01T00:30:00Z').getTime(), open: 24792, high: 24805.75, low: 24790.5, close: 24800 },
    { timestamp: new Date('2025-10-01T00:45:00Z').getTime(), open: 24800, high: 24811.5, low: 24788.25, close: 24795 },
    { timestamp: new Date('2025-10-01T01:00:00Z').getTime(), open: 24795, high: 24798.75, low: 24783.75, close: 24790 },
    { timestamp: new Date('2025-10-01T01:15:00Z').getTime(), open: 24790, high: 24808.5, low: 24788, close: 24805 },
    { timestamp: new Date('2025-10-01T01:30:00Z').getTime(), open: 24805, high: 24810.5, low: 24794.25, close: 24800 },
    { timestamp: new Date('2025-10-01T01:45:00Z').getTime(), open: 24800, high: 24811, low: 24801, close: 24805 },
    { timestamp: new Date('2025-10-01T02:00:00Z').getTime(), open: 24805, high: 24805.5, low: 24787, close: 24790 },
    { timestamp: new Date('2025-10-01T02:15:00Z').getTime(), open: 24790, high: 24803.75, low: 24788.25, close: 24795 },
    { timestamp: new Date('2025-10-01T02:30:00Z').getTime(), open: 24795, high: 24799.5, low: 24785, close: 24790 },
    { timestamp: new Date('2025-10-01T02:45:00Z').getTime(), open: 24790, high: 24791.5, low: 24781, close: 24785 },
    { timestamp: new Date('2025-10-01T03:00:00Z').getTime(), open: 24785, high: 24788.25, low: 24769.5, close: 24772.75 },
  ];

  // Process candles to build history
  testCandles.forEach(candle => {
    if (!strategy.candleHistory) {
      strategy.candleHistory = [];
    }
    strategy.candleHistory.push(candle);
  });

  // Update level detectors
  strategy.structuralLevels.processCandles(strategy.candleHistory);
  strategy.sessionLevels.processCandles(strategy.candleHistory);
  strategy.fibonacciLevels.processCandles(strategy.candleHistory);

  // Create test signal
  const testSignal = {
    side: 'buy',
    price: 24772.75,
    confluenceZone: { center: 24882.48 }
  };

  const currentPrice = 24772.75;

  // Get pullback levels
  const pullbackLevels = strategy.identifyPullbackLevels(testSignal, currentPrice);

  console.log(`\n📊 Test Signal: BUY at $${currentPrice}`);
  console.log(`   Confluence Zone: $${testSignal.confluenceZone.center}`);
  console.log(`\n🎯 Detected Pullback Levels: ${pullbackLevels.length} total`);

  if (pullbackLevels.length > 0) {
    // Group by source
    const levelsBySource = {
      structural: pullbackLevels.filter(l => l.source === 'structural'),
      session: pullbackLevels.filter(l => l.source === 'session'),
      fibonacci: pullbackLevels.filter(l => l.source === 'fibonacci')
    };

    if (levelsBySource.structural.length > 0) {
      console.log('\n📐 Structural Levels:');
      levelsBySource.structural.forEach(level => {
        console.log(`   - $${level.price.toFixed(2)} (${level.type}, weight: ${level.weight.toFixed(1)}, distance: ${Math.abs(level.price - currentPrice).toFixed(1)} pts)`);
      });
    }

    if (levelsBySource.session.length > 0) {
      console.log('\n📅 Session Levels:');
      levelsBySource.session.forEach(level => {
        console.log(`   - $${level.price.toFixed(2)} (${level.type}, weight: ${level.weight.toFixed(1)}, distance: ${Math.abs(level.price - currentPrice).toFixed(1)} pts)`);
      });
    }

    if (levelsBySource.fibonacci.length > 0) {
      console.log('\n📊 Fibonacci Levels:');
      levelsBySource.fibonacci.forEach(level => {
        console.log(`   - $${level.price.toFixed(2)} (${level.description || level.type}, weight: ${level.weight.toFixed(1)}, distance: ${Math.abs(level.price - currentPrice).toFixed(1)} pts)`);
      });
    }
  } else {
    console.log('   ❌ No levels detected');
  }

  // Debug info
  console.log('\n📊 Debug Info:');
  console.log(`   Candle history size: ${strategy.candleHistory.length}`);
  console.log(`   Structural levels active: ${strategy.structuralLevels.getActiveLevels().length}`);
  console.log(`   Session levels active: ${strategy.sessionLevels.getActiveLevels().length}`);
  console.log(`   Fibonacci levels active: ${strategy.fibonacciLevels.getActiveLevels().length}`);

  // Show fibonacci debug info
  const fibDebug = strategy.fibonacciLevels.getDebugInfo();
  console.log(`   Fibonacci swings: ${fibDebug.recentSwings.length}`);
  if (fibDebug.recentSwings.length > 0) {
    fibDebug.recentSwings.forEach(swing => {
      console.log(`     - ${swing.direction} swing: ${swing.size} pts`);
    });
  }
}

testSingleSignal().catch(console.error);