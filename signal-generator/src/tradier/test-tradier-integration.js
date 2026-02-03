#!/usr/bin/env node

// Test Tradier integration in sandbox mode
import { createLogger } from '../../../shared/index.js';
import TradierClient from './tradier-client.js';
import OptionsChainManager from './options-chain-manager.js';
import ExposureCalculator from './exposure-calculator.js';
import FuturesConverter from './futures-converter.js';
import TradierExposureService from './tradier-exposure-service.js';

const logger = createLogger('tradier-test');

// Test configuration (using sandbox)
const testConfig = {
  accessToken: process.env.TRADIER_ACCESS_TOKEN || 'demo_token',
  baseUrl: 'https://sandbox.tradier.com/v1', // Sandbox for testing
  symbols: ['SPY', 'QQQ'],
  maxExpirations: 3
};

async function testTradierClient() {
  console.log('\n=== Testing Tradier Client ===');

  try {
    const client = new TradierClient({
      accessToken: testConfig.accessToken,
      baseUrl: testConfig.baseUrl
    });

    console.log('✅ TradierClient created');
    console.log(`Rate limit status:`, client.getRateLimitStatus());

    // Test basic connectivity
    try {
      const quotes = await client.getQuotes(['SPY']);
      console.log('✅ API connection test passed');
      console.log('Sample quote:', quotes);
    } catch (error) {
      console.log('⚠️  API connection test failed (expected in sandbox):', error.message);
    }

  } catch (error) {
    console.error('❌ TradierClient test failed:', error.message);
  }
}

async function testExposureCalculator() {
  console.log('\n=== Testing Exposure Calculator ===');

  try {
    const calculator = new ExposureCalculator({
      riskFreeRate: 0.05
    });

    console.log('✅ ExposureCalculator created');

    // Test option symbol parsing
    const testSymbols = [
      'SPY260110C00600000',
      'QQQ260117P00450000'
    ];

    for (const symbol of testSymbols) {
      const parsed = calculator.parseOptionSymbol(symbol);
      if (parsed) {
        console.log(`✅ Parsed ${symbol}:`, {
          underlying: parsed.underlying,
          type: parsed.type,
          strike: parsed.strike,
          expiry: parsed.expiry.toISOString().split('T')[0]
        });
      } else {
        console.log(`❌ Failed to parse ${symbol}`);
      }
    }

    // Test time to expiry calculation
    const tte = calculator.calculateTimeToExpiry(new Date('2026-01-17'));
    console.log('✅ Time to expiry calculation:', tte.toFixed(6), 'years');

    // Test Black-Scholes calculations
    const spot = 600;
    const strike = 590;
    const vol = 0.20;
    const timeToExpiry = 0.1; // ~5 weeks
    const rate = 0.05;

    const gamma = calculator.calculateGamma(spot, strike, rate, vol, timeToExpiry);
    const vanna = calculator.calculateVanna(spot, strike, rate, vol, timeToExpiry);
    const charm = calculator.calculateCharm(spot, strike, rate, vol, timeToExpiry, 'call');

    console.log('✅ Greeks calculations:');
    console.log(`  Gamma: ${gamma.toFixed(6)}`);
    console.log(`  Vanna: ${vanna.toFixed(6)}`);
    console.log(`  Charm: ${charm.toFixed(6)}`);

  } catch (error) {
    console.error('❌ ExposureCalculator test failed:', error.message);
  }
}

async function testFuturesConverter() {
  console.log('\n=== Testing Futures Converter ===');

  try {
    const converter = new FuturesConverter({
      redisUrl: 'redis://localhost:6379'
    });

    console.log('✅ FuturesConverter created');

    // Test ratio calculations
    const spyLevel = 600;
    const qqqLevel = 450;

    const esLevel = converter.spyToES(spyLevel);
    const nqLevel = converter.qqqToNQ(qqqLevel);

    console.log(`✅ Conversions using fallback ratios:`);
    console.log(`  SPY ${spyLevel} → ES ${esLevel.toFixed(2)}`);
    console.log(`  QQQ ${qqqLevel} → NQ ${nqLevel.toFixed(2)}`);

    const ratioInfo = converter.getRatioInfo();
    console.log('✅ Ratio info:', ratioInfo);

  } catch (error) {
    console.error('❌ FuturesConverter test failed:', error.message);
  }
}

async function testOptionsChainManager() {
  console.log('\n=== Testing Options Chain Manager ===');

  try {
    const client = new TradierClient({
      accessToken: testConfig.accessToken,
      baseUrl: testConfig.baseUrl
    });

    const manager = new OptionsChainManager({
      tradierClient: client,
      symbols: testConfig.symbols,
      maxExpirations: testConfig.maxExpirations,
      pollIntervalMinutes: 1
    });

    console.log('✅ OptionsChainManager created');

    // Test expiration selection logic
    const mockExpirations = [
      '2026-01-09', // 0DTE (today)
      '2026-01-10',
      '2026-01-17', // Weekly
      '2026-01-24', // Weekly
      '2026-01-31',
      '2026-02-21'  // Monthly (third Friday)
    ];

    const selected = manager.selectExpirations(mockExpirations, 'SPY');
    console.log('✅ Expiration selection test:', selected);

    const stats = manager.getCacheStats();
    console.log('✅ Cache stats:', stats);

  } catch (error) {
    console.error('❌ OptionsChainManager test failed:', error.message);
  }
}

async function testTradierExposureService() {
  console.log('\n=== Testing Tradier Exposure Service ===');

  try {
    // Mock environment for testing
    process.env.TRADIER_ACCESS_TOKEN = testConfig.accessToken;
    process.env.TRADIER_BASE_URL = testConfig.baseUrl;
    process.env.TRADIER_SYMBOLS = testConfig.symbols.join(',');

    const service = new TradierExposureService();
    console.log('✅ TradierExposureService created');

    // Test initialization (will likely fail in sandbox but should show proper error handling)
    try {
      await service.initialize();
      console.log('✅ TradierExposureService initialized');

      const health = service.getHealthStatus();
      console.log('✅ Health status:', health);

    } catch (error) {
      console.log('⚠️  Initialization failed (expected in test environment):', error.message);
    }

  } catch (error) {
    console.error('❌ TradierExposureService test failed:', error.message);
  }
}

async function runAllTests() {
  console.log('🧪 Starting Tradier Integration Tests');
  console.log('📋 Configuration:', testConfig);

  await testTradierClient();
  await testExposureCalculator();
  await testFuturesConverter();
  await testOptionsChainManager();
  await testTradierExposureService();

  console.log('\n✅ All tests completed!');
  console.log('\nℹ️  Note: Some tests may show warnings in sandbox/test mode - this is expected.');
  console.log('ℹ️  For full testing, configure a real Tradier API token in the environment.');
}

// Run tests if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests()
    .then(() => {
      console.log('\n🎉 Test suite finished');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n💥 Test suite failed:', error);
      process.exit(1);
    });
}

export { runAllTests };