#!/usr/bin/env node
/**
 * Test strategy directly without full backtest
 */

import { ContrarianBounceStrategy } from '../shared/strategies/contrarian-bounce.js';
import { isValidCandle } from '../shared/strategies/strategy-utils.js';

// Test strategy directly
const strategy = new ContrarianBounceStrategy({
  tradingSymbol: 'NQ',
  signalCooldownMs: 0, // No cooldown for testing
  requirePositiveGex: false,
  useTimeFilter: false,
  useSentimentFilter: false,
  useDistanceFilter: false,
  useIvFilter: false
});

// Create test candle and GEX data - price BELOW gamma flip
const testCandle = {
  timestamp: Date.now(),
  open: 24900,
  high: 24950,
  low: 24850,
  close: 24900,  // Below gamma flip of 25000
  volume: 1000
};

const prevCandle = {
  timestamp: Date.now() - 900000,
  open: 24950,
  high: 25000,
  low: 24900,
  close: 24950,
  volume: 1000
};

const gexLevels = {
  gamma_flip: 25000,  // Above current price
  call_wall: 25200,
  put_wall: 24700,
  regime: 'positive',
  support: [24800, 24700, 24600],
  resistance: [25100, 25200, 25300]
};

console.log('=== Testing ContrarianBounceStrategy ===\n');
console.log('Test candle valid:', isValidCandle(testCandle));
console.log('Prev candle valid:', isValidCandle(prevCandle));
console.log('Price:', testCandle.close, '< Gamma flip:', gexLevels.gamma_flip, '=', testCandle.close < gexLevels.gamma_flip);
console.log('Distance below flip:', gexLevels.gamma_flip - testCandle.close, 'points');

// Add debug logging
const price = testCandle.close;
const gammaFlip = gexLevels.gamma_flip;
console.log('\nDirect condition checks:');
console.log('  price >= gammaFlip:', price >= gammaFlip, `(${price} >= ${gammaFlip})`);
console.log('  price < gammaFlip:', price < gammaFlip, `(${price} < ${gammaFlip})`);

// Check stop calculation
const stopPrice = gexLevels.put_wall ? gexLevels.put_wall - 5 : price - 15;
const risk = price - stopPrice;
console.log('  stopPrice:', stopPrice);
console.log('  risk:', risk, '(maxRisk:', strategy.params.maxRisk, ')');
console.log('  risk > maxRisk:', risk > strategy.params.maxRisk);
console.log('  risk <= 0:', risk <= 0);

const signal = strategy.evaluateSignal(testCandle, prevCandle, { gexLevels });
console.log('\nSignal generated:', signal ? 'YES' : 'NO');

if (signal) {
  console.log('\nSignal details:');
  console.log(JSON.stringify(signal, null, 2));
} else {
  // Debug why no signal
  console.log('\nDebugging...');
  console.log('Strategy params:', JSON.stringify(strategy.params, null, 2));
}

// Test with price ABOVE gamma flip (should NOT generate signal)
console.log('\n=== Test with price ABOVE gamma flip ===');
const testCandle2 = { ...testCandle, close: 25100 };
const signal2 = strategy.evaluateSignal(testCandle2, prevCandle, { gexLevels });
console.log('Price:', testCandle2.close, '> Gamma flip:', gexLevels.gamma_flip);
console.log('Signal generated:', signal2 ? 'YES (ERROR!)' : 'NO (correct)');
