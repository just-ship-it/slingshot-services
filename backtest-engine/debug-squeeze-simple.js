#!/usr/bin/env node

// Simple debug script to test Squeeze Momentum Indicator calculations
// Uses real NQ data patterns to validate the indicator

import { SqueezeMomentumIndicator } from '../shared/indicators/squeeze-momentum.js';
import { Candle } from '../signal-generator/src/models/candle.js';

console.log('🔍 Debugging Squeeze Momentum Indicator\n');

// Create sample NQ candles based on real patterns (21600-21800 range)
const sampleCandles = [
  // Initial trend up
  { symbol: 'NQ', timestamp: '2025-06-01T14:00:00Z', open: 21600, high: 21620, low: 21590, close: 21615, volume: 1200 },
  { symbol: 'NQ', timestamp: '2025-06-01T14:15:00Z', open: 21615, high: 21635, low: 21605, close: 21630, volume: 1350 },
  { symbol: 'NQ', timestamp: '2025-06-01T14:30:00Z', open: 21630, high: 21645, low: 21620, close: 21640, volume: 1180 },
  { symbol: 'NQ', timestamp: '2025-06-01T14:45:00Z', open: 21640, high: 21655, low: 21630, close: 21650, volume: 1420 },
  { symbol: 'NQ', timestamp: '2025-06-01T15:00:00Z', open: 21650, high: 21665, low: 21640, close: 21660, volume: 980 },
  { symbol: 'NQ', timestamp: '2025-06-01T15:15:00Z', open: 21660, high: 21675, low: 21650, close: 21670, volume: 1250 },
  { symbol: 'NQ', timestamp: '2025-06-01T15:30:00Z', open: 21670, high: 21685, low: 21660, close: 21680, volume: 1100 },
  { symbol: 'NQ', timestamp: '2025-06-01T15:45:00Z', open: 21680, high: 21695, low: 21670, close: 21690, volume: 1300 },
  { symbol: 'NQ', timestamp: '2025-06-01T16:00:00Z', open: 21690, high: 21705, low: 21680, close: 21700, volume: 1150 },
  { symbol: 'NQ', timestamp: '2025-06-01T16:15:00Z', open: 21700, high: 21715, low: 21690, close: 21710, volume: 1400 },
  { symbol: 'NQ', timestamp: '2025-06-01T16:30:00Z', open: 21710, high: 21725, low: 21700, close: 21720, volume: 1050 },
  { symbol: 'NQ', timestamp: '2025-06-01T16:45:00Z', open: 21720, high: 21735, low: 21710, close: 21730, volume: 1320 },
  { symbol: 'NQ', timestamp: '2025-06-01T17:00:00Z', open: 21730, high: 21745, low: 21720, close: 21740, volume: 1200 },
  { symbol: 'NQ', timestamp: '2025-06-01T17:15:00Z', open: 21740, high: 21755, low: 21730, close: 21750, volume: 1380 },
  { symbol: 'NQ', timestamp: '2025-06-01T17:30:00Z', open: 21750, high: 21765, low: 21740, close: 21760, volume: 1150 },
  { symbol: 'NQ', timestamp: '2025-06-01T17:45:00Z', open: 21760, high: 21775, low: 21750, close: 21770, volume: 1290 },
  { symbol: 'NQ', timestamp: '2025-06-01T18:00:00Z', open: 21770, high: 21785, low: 21760, close: 21780, volume: 1100 },
  { symbol: 'NQ', timestamp: '2025-06-01T18:15:00Z', open: 21780, high: 21795, low: 21770, close: 21790, volume: 1350 },
  { symbol: 'NQ', timestamp: '2025-06-01T18:30:00Z', open: 21790, high: 21805, low: 21780, close: 21800, volume: 1220 },

  // Resistance and reversal - compression phase
  { symbol: 'NQ', timestamp: '2025-06-01T18:45:00Z', open: 21800, high: 21810, low: 21790, close: 21805, volume: 950 },
  { symbol: 'NQ', timestamp: '2025-06-01T19:00:00Z', open: 21805, high: 21815, low: 21795, close: 21810, volume: 850 },
  { symbol: 'NQ', timestamp: '2025-06-01T19:15:00Z', open: 21810, high: 21820, low: 21800, close: 21815, volume: 780 },
  { symbol: 'NQ', timestamp: '2025-06-01T19:30:00Z', open: 21815, high: 21825, low: 21805, close: 21820, volume: 720 },
  { symbol: 'NQ', timestamp: '2025-06-01T19:45:00Z', open: 21820, high: 21830, low: 21810, close: 21825, volume: 680 },

  // Breakdown - momentum shift
  { symbol: 'NQ', timestamp: '2025-06-01T20:00:00Z', open: 21825, high: 21830, low: 21800, close: 21810, volume: 1600 },
  { symbol: 'NQ', timestamp: '2025-06-01T20:15:00Z', open: 21810, high: 21820, low: 21785, close: 21790, volume: 1800 },
  { symbol: 'NQ', timestamp: '2025-06-01T20:30:00Z', open: 21790, high: 21800, low: 21770, close: 21775, volume: 1750 },
  { symbol: 'NQ', timestamp: '2025-06-01T20:45:00Z', open: 21775, high: 21785, low: 21750, close: 21760, volume: 1900 }
];

// Convert to Candle objects
const candles = sampleCandles.map(data => new Candle(data));

console.log(`📊 Testing with ${candles.length} candles\n`);

// Test Squeeze Momentum Indicator
const squeezeIndicator = new SqueezeMomentumIndicator({
  bbLength: 20,
  bbMultFactor: 2.0,
  kcLength: 20,
  kcMultFactor: 1.5,
  useTrueRange: true
});

let previousMomentum = null;

console.log('🔍 Testing individual components:\n');

// Test Bollinger Bands
console.log('📈 Bollinger Bands:');
const bb = squeezeIndicator.calculateBollingerBands(candles);
if (bb) {
  console.log(`   Upper BB: ${bb.upperBB.toFixed(2)}`);
  console.log(`   Lower BB: ${bb.lowerBB.toFixed(2)}`);
  console.log(`   Basis: ${bb.basis.toFixed(2)}`);
  console.log(`   Width: ${(bb.upperBB - bb.lowerBB).toFixed(2)}`);
} else {
  console.log('   ❌ Failed to calculate Bollinger Bands');
}

// Test Keltner Channels
console.log('\n📊 Keltner Channels:');
const kc = squeezeIndicator.calculateKeltnerChannels(candles);
if (kc) {
  console.log(`   Upper KC: ${kc.upperKC.toFixed(2)}`);
  console.log(`   Lower KC: ${kc.lowerKC.toFixed(2)}`);
  console.log(`   MA: ${kc.ma.toFixed(2)}`);
  console.log(`   Width: ${(kc.upperKC - kc.lowerKC).toFixed(2)}`);
} else {
  console.log('   ❌ Failed to calculate Keltner Channels');
}

// Test Squeeze State
if (bb && kc) {
  console.log('\n🎪 Squeeze State:');
  const squeezeState = squeezeIndicator.calculateSqueezeState(bb, kc);
  if (squeezeState) {
    console.log(`   Squeeze On: ${squeezeState.sqzOn}`);
    console.log(`   Squeeze Off: ${squeezeState.sqzOff}`);
    console.log(`   No Squeeze: ${squeezeState.noSqz}`);
    console.log(`   State: ${squeezeState.state}`);
  }
}

// Test Momentum
console.log('\n⚡ Momentum Calculation:');
const momentum = squeezeIndicator.calculateMomentum(candles);
if (momentum !== null) {
  console.log(`   Momentum: ${momentum.toFixed(6)}`);
  console.log(`   Direction: ${momentum > 0 ? 'Bullish' : 'Bearish'}`);
} else {
  console.log('   ❌ Failed to calculate momentum');
}

// Test complete indicator
console.log('\n🧪 Complete Indicator Test:');

console.log('\nProcessing last 5 candles to see momentum progression:\n');

for (let i = Math.max(20, candles.length - 5); i < candles.length; i++) {
  const testCandles = candles.slice(0, i + 1);
  const result = squeezeIndicator.calculate(testCandles, previousMomentum);

  if (result) {
    console.log(`Candle ${i + 1} (${candles[i].timestamp.split('T')[1].slice(0, 5)}):`);
    console.log(`  Close: ${candles[i].close}`);
    console.log(`  Momentum: ${result.momentum.value.toFixed(6)} (${result.momentum.color})`);
    console.log(`  Squeeze: ${result.squeeze.state}`);
    console.log(`  BB Width: ${(result.bollingerBands.upperBB - result.bollingerBands.lowerBB).toFixed(2)}`);
    console.log(`  KC Width: ${(result.keltnerChannels.upperKC - result.keltnerChannels.lowerKC).toFixed(2)}`);

    if (result.signals.squeezeBreakout) {
      console.log(`  🎯 SQUEEZE BREAKOUT!`);
    }
    if (result.signals.momentumShift) {
      console.log(`  📈 MOMENTUM SHIFT!`);
    }

    previousMomentum = result.momentum.value;
  } else {
    console.log(`Candle ${i + 1}: ❌ Failed to calculate`);
  }

  console.log();
}

// Test momentum behavior in different scenarios
console.log('🎯 TESTING MOMENTUM DIRECTION:\n');

// Simulate bullish momentum scenario
const bullishCandles = candles.slice();
// Add some strong bullish candles
bullishCandles.push(
  new Candle({ symbol: 'NQ', timestamp: '2025-06-01T21:00:00Z', open: 21760, high: 21790, low: 21755, close: 21785, volume: 2000 }),
  new Candle({ symbol: 'NQ', timestamp: '2025-06-01T21:15:00Z', open: 21785, high: 21810, low: 21780, close: 21805, volume: 2100 }),
  new Candle({ symbol: 'NQ', timestamp: '2025-06-01T21:30:00Z', open: 21805, high: 21830, low: 21800, close: 21825, volume: 2200 })
);

const bullishResult = squeezeIndicator.calculate(bullishCandles, previousMomentum);
if (bullishResult) {
  console.log('Bullish Scenario:');
  console.log(`  Momentum: ${bullishResult.momentum.value.toFixed(6)}`);
  console.log(`  Expected: Positive for bullish trend`);
  console.log(`  Status: ${bullishResult.momentum.value > 0 ? '✅ Correct' : '❌ Unexpected'}`);
} else {
  console.log('❌ Failed to calculate bullish scenario');
}

// Simulate bearish momentum scenario
const bearishCandles = candles.slice();
// Add some strong bearish candles
bearishCandles.push(
  new Candle({ symbol: 'NQ', timestamp: '2025-06-01T21:00:00Z', open: 21760, high: 21765, low: 21730, close: 21735, volume: 2000 }),
  new Candle({ symbol: 'NQ', timestamp: '2025-06-01T21:15:00Z', open: 21735, high: 21740, low: 21705, close: 21710, volume: 2100 }),
  new Candle({ symbol: 'NQ', timestamp: '2025-06-01T21:30:00Z', open: 21710, high: 21715, low: 21680, close: 21685, volume: 2200 })
);

const bearishResult = squeezeIndicator.calculate(bearishCandles, bullishResult ? bullishResult.momentum.value : null);
if (bearishResult) {
  console.log('\nBearish Scenario:');
  console.log(`  Momentum: ${bearishResult.momentum.value.toFixed(6)}`);
  console.log(`  Expected: Negative for bearish trend`);
  console.log(`  Status: ${bearishResult.momentum.value < 0 ? '✅ Correct' : '❌ Unexpected'}`);
} else {
  console.log('\n❌ Failed to calculate bearish scenario');
}

console.log('\n📊 DIAGNOSIS:');
console.log('If momentum calculations are working but no signals in backtest:');
console.log('1. Check GEX level sweep detection logic');
console.log('2. Verify momentum alignment conditions in strategy');
console.log('3. Ensure state machine is transitioning correctly');
console.log('4. Check cooldown and timing parameters');

console.log('\n✅ Squeeze momentum indicator analysis complete!');