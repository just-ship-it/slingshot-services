#!/usr/bin/env node

// Test GEX Calculator with Redis quote integration
import GexCalculator from './gex-calculator.js';
import config from '../utils/config.js';
import Redis from 'ioredis';

console.log('='.repeat(60));
console.log('GEX Calculator Redis Integration Test');
console.log('='.repeat(60));

async function setupMockQuotes() {
  // Set up mock quotes in Redis for testing
  const redis = new Redis(config.getRedisUrl());

  // Mock QQQ quote
  const mockQQQQuote = {
    symbol: 'NASDAQ:QQQ',
    baseSymbol: 'QQQ',
    close: 613.12,
    timestamp: new Date().toISOString(),
    source: 'tradingview'
  };

  // Mock NQ quote
  const mockNQQuote = {
    symbol: 'CME_MINI:NQ1!',
    baseSymbol: 'NQ',
    close: 25400,
    timestamp: new Date().toISOString(),
    source: 'tradingview'
  };

  await redis.setex('latest_quote_QQQ', 300, JSON.stringify(mockQQQQuote));
  await redis.setex('latest_quote_NQ', 300, JSON.stringify(mockNQQuote));

  console.log('📊 Mock quotes set in Redis:');
  console.log(`- QQQ: $${mockQQQQuote.close}`);
  console.log(`- NQ: ${mockNQQuote.close}`);
  console.log('');

  await redis.disconnect();
  return { qqq: mockQQQQuote.close, nq: mockNQQuote.close };
}

async function test() {
  try {
    // Set up mock quotes
    const mockQuotes = await setupMockQuotes();

    // Create calculator
    const calculator = new GexCalculator({
      symbol: config.GEX_SYMBOL,
      cacheFile: config.GEX_CACHE_FILE,
      cooldownMinutes: 0, // Bypass cooldown
      redisUrl: config.getRedisUrl()
    });

    console.log('🔄 Testing GEX calculation with Redis quotes...');
    console.log('(This will fetch fresh CBOE data...)');
    console.log('');

    const levels = await calculator.calculateLevels(true); // Force fresh fetch

    console.log('✅ GEX Levels Calculated Successfully!');
    console.log('='.repeat(50));

    console.log('📊 Market Data:');
    console.log(`- QQQ Spot: $${levels.qqqSpot.toFixed(2)} (${levels.dataSource})`);
    console.log(`- NQ Spot: ${levels.nqSpot.toFixed(0)} (${levels.dataSource})`);
    console.log(`- Multiplier: ${levels.multiplier.toFixed(2)}`);
    console.log(`- Used Live Prices: ${levels.usedLivePrices ? '✅ Yes' : '❌ No'}`);
    console.log(`- Data Source: ${levels.dataSource}`);
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

    // Compare with expected multiplier
    const expectedMultiplier = mockQuotes.nq / mockQuotes.qqq;
    console.log('🔍 Multiplier Comparison:');
    console.log(`- Expected (from mock): ${expectedMultiplier.toFixed(2)}`);
    console.log(`- Calculated: ${levels.multiplier.toFixed(2)}`);
    console.log(`- Match: ${Math.abs(expectedMultiplier - levels.multiplier) < 0.01 ? '✅' : '❌'}`);

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Error details:', error);
    process.exit(1);
  }
}

// Run the test
console.log('Starting GEX + Redis integration test...');
console.log('');
test().then(() => {
  console.log('');
  console.log('✅ All tests completed successfully!');
  process.exit(0);
});