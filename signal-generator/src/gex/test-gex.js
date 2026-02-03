#!/usr/bin/env node

// Standalone test for GEX Calculator
import GexCalculator from './gex-calculator.js';
import config from '../utils/config.js';

console.log('='.repeat(50));
console.log('GEX Calculator Test');
console.log('='.repeat(50));

console.log('Configuration:');
console.log('- Symbol:', config.GEX_SYMBOL);
console.log('- Cache File:', config.GEX_CACHE_FILE);
console.log('- Cooldown:', config.GEX_COOLDOWN_MINUTES, 'minutes');
console.log('');

// Create calculator
const calculator = new GexCalculator({
  symbol: config.GEX_SYMBOL,
  cacheFile: config.GEX_CACHE_FILE,
  cooldownMinutes: config.GEX_COOLDOWN_MINUTES
});

async function test() {
  try {
    // First try to load cached levels
    console.log('Loading cached levels...');
    const cached = await calculator.loadCachedLevels();

    if (cached) {
      console.log('✅ Found cached GEX levels:');
      console.log(JSON.stringify(cached, null, 2));
      console.log('');
    } else {
      console.log('No cached levels found');
      console.log('');
    }

    // Now fetch fresh levels
    console.log('Fetching fresh GEX levels from CBOE...');
    console.log('(This may take a moment...)');

    const levels = await calculator.calculateLevels(true); // Force fresh fetch

    console.log('');
    console.log('✅ GEX Levels Calculated Successfully!');
    console.log('='.repeat(50));

    // Display results
    console.log('📊 Market Data:');
    console.log(`- QQQ Spot: $${levels.qqqSpot.toFixed(2)}`);
    console.log(`- NQ Spot: ${levels.nqSpot.toFixed(0)}`);
    console.log(`- Multiplier: ${levels.multiplier.toFixed(2)}`);
    console.log('');

    console.log('📈 GEX Metrics:');
    console.log(`- Total GEX: ${levels.totalGex.toFixed(2)}B`);
    console.log(`- Regime: ${levels.regime.toUpperCase()}`);
    console.log(`- Gamma Flip: ${levels.gammaFlip}`);
    console.log('');

    console.log('🎯 Key Levels:');
    console.log(`- Put Wall: ${levels.putWall}`);
    console.log(`- Call Wall: ${levels.callWall}`);
    console.log('');

    console.log('📉 Support Levels:');
    levels.support.forEach((level, i) => {
      console.log(`  ${i + 1}. ${level}`);
    });
    console.log('');

    console.log('📈 Resistance Levels:');
    levels.resistance.forEach((level, i) => {
      console.log(`  ${i + 1}. ${level}`);
    });
    console.log('');

    console.log('💾 Data saved to cache:', config.GEX_CACHE_FILE);

    // Test cooldown
    console.log('');
    console.log('Testing cooldown (should return cached)...');
    const cached2 = await calculator.calculateLevels(false);
    console.log(`From cache: ${cached2.fromCache ? '✅ Yes' : '❌ No'}`);

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Error details:', error);
    process.exit(1);
  }
}

// Run the test
console.log('Starting GEX calculation test...');
console.log('');
test().then(() => {
  console.log('');
  console.log('✅ All tests completed successfully!');
  process.exit(0);
});