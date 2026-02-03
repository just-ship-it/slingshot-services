#!/usr/bin/env node

/**
 * Test Entry Zone Detection
 * Verify that the system correctly identifies entry zones vs target zones
 */

import { GexLdpmConfluencePullbackStrategy } from '../shared/strategies/gex-ldpm-confluence-pullback.js';

// Create strategy instance
const strategy = new GexLdpmConfluencePullbackStrategy({
  enablePullbackSystem: true,
  tradingSymbol: 'NQ'
});

// Simulate market data for Sept 30
const mockCandle = {
  timestamp: new Date('2025-09-30T13:00:00').getTime(),
  open: 24850,
  high: 24875,
  low: 24825,
  close: 24850,
  volume: 1000
};

const mockMarketData = {
  gexLevels: {
    support: [23016.32, 24467.79, 24633.68],  // Put walls
    resistance: [24882.50, 25297.21, 25089.86], // Call walls
    gammaFlip: 25086.71
  }
};

// Initialize fibonacci levels with test data
strategy.fibonacciLevels.fibLevels = [
  { price: 24664.24, ratio: 0.786, strength: 100, ratioPercent: '78.6', type: 'deep_retracement' },
  { price: 24696.32, ratio: 0.705, strength: 100, ratioPercent: '70.5', type: 'prime_golden' },
  { price: 24730.77, ratio: 0.618, strength: 100, ratioPercent: '61.8', type: 'standard_golden' },
  { price: 24777.50, ratio: 0.5, strength: 100, ratioPercent: '50.0', type: 'half_retracement' },
  { price: 24824.23, ratio: 0.382, strength: 100, ratioPercent: '38.2', type: 'shallow_retracement' },
  { price: 24882.04, ratio: 0.236, strength: 100, ratioPercent: '23.6', type: 'shallow_retracement' }
];

// Mock getActiveLevels to return the levels
strategy.fibonacciLevels.getActiveLevels = () => strategy.fibonacciLevels.fibLevels;

console.log('Testing Entry Zone Detection');
console.log('=' .repeat(50));
console.log(`Current Price: ${mockCandle.close}`);
console.log();

// Mock the parent's evaluateSignal to return a buy signal
const mockOriginalSignal = {
  side: 'buy',
  symbol: 'NQ',
  take_profit: 25088,  // Target zone
  strength: 75,
  quantity: 1
};

// Test the analyzeConfluenceSignal directly by mocking super.evaluateSignal
const originalSuper = Object.getPrototypeOf(Object.getPrototypeOf(strategy)).evaluateSignal;
Object.getPrototypeOf(Object.getPrototypeOf(strategy)).evaluateSignal = function() {
  return mockOriginalSignal;
};

// Test the confluence signal analysis
const signal = strategy.analyzeConfluenceSignal(mockCandle, null, mockMarketData);

// Restore original
Object.getPrototypeOf(Object.getPrototypeOf(strategy)).evaluateSignal = originalSuper;

if (signal) {
  console.log('✅ Signal Generated:');
  console.log(`  Side: ${signal.side}`);
  console.log(`  Target Price: ${signal.take_profit.toFixed(2)}`);

  if (signal.targetZone) {
    console.log(`  Target Zone: ${signal.targetZone.centerPrice.toFixed(2)}`);
  }

  console.log();
  console.log('📍 Entry Zones Identified:');
  if (signal.entryZones && signal.entryZones.length > 0) {
    signal.entryZones.forEach((zone, idx) => {
      console.log(`  Zone ${idx + 1}: ${zone.centerPrice.toFixed(2)} (${zone.minPrice.toFixed(2)} - ${zone.maxPrice.toFixed(2)})`);
      console.log(`    Levels: ${zone.levelCount}, Score: ${zone.score.toFixed(2)}`);

      // Check if this contains our key levels
      if (Math.abs(zone.centerPrice - 24664) < 50) {
        console.log(`    ⭐ Contains 24,664 area (Fib 78.6% + GEX support)`);
      }
    });
  } else {
    console.log('  ❌ No entry zones identified');
  }
} else {
  console.log('❌ No signal generated');
}

console.log();
console.log('Expected Behavior:');
console.log('  - Target should be around 25,088 (confluence target)');
console.log('  - Entry zones should include 24,633-24,696 area');
console.log('  - System should monitor entry zones, not target zone');