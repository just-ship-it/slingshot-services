/**
 * GEX Mean Reversion Strategy - Unit Tests
 *
 * Tests signal generation, risk validation, and core logic
 */

import { GexMeanReversionStrategy } from '../strategy.js';

// Test helper to create candle objects
function createCandle(close, timestamp = Date.now(), { high = close + 5, low = close - 5, open = close } = {}) {
  return { timestamp, open, high, low, close, volume: 1000, symbol: 'NQ' };
}

// Test helper to create GEX levels
function createGexLevels(supportLevel, { regime = 'negative', total_gex = -1e10 } = {}) {
  return {
    support: [supportLevel, supportLevel - 50, supportLevel - 100],
    resistance: [supportLevel + 100, supportLevel + 150],
    gamma_flip: supportLevel - 200,
    put_wall: supportLevel + 10,
    regime,
    total_gex
  };
}

// Test runner
async function runTests() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (error) {
      console.log(`❌ ${name}`);
      console.log(`   Error: ${error.message}`);
      failed++;
    }
  }

  function assertEqual(actual, expected, message = '') {
    if (actual !== expected) {
      throw new Error(`${message} Expected ${expected}, got ${actual}`);
    }
  }

  function assertNotNull(value, message = '') {
    if (value === null || value === undefined) {
      throw new Error(`${message} Expected non-null value`);
    }
  }

  function assertNull(value, message = '') {
    if (value !== null) {
      throw new Error(`${message} Expected null, got ${JSON.stringify(value)}`);
    }
  }

  console.log('\n🧪 GEX Mean Reversion Strategy Tests\n');

  // --- Risk Validation Tests ---

  test('validateRiskReward: accepts valid 1:3 R:R', () => {
    const strategy = new GexMeanReversionStrategy();
    const result = strategy.validateRiskReward(21000, 20980, 21060);
    assertEqual(result.valid, true, 'Should be valid');
    assertEqual(result.riskReward, 3.0, 'R:R should be 3.0');
  });

  test('validateRiskReward: rejects R:R below 3', () => {
    const strategy = new GexMeanReversionStrategy();
    const result = strategy.validateRiskReward(21000, 20980, 21040);
    assertEqual(result.valid, false, 'Should be invalid');
  });

  test('validateRiskReward: rejects risk > 30 points', () => {
    const strategy = new GexMeanReversionStrategy();
    const result = strategy.validateRiskReward(21000, 20965, 21105); // 35pt risk
    assertEqual(result.valid, false, 'Should be invalid');
  });

  test('constructor: throws on invalid stop > 30', () => {
    try {
      new GexMeanReversionStrategy({ stopLossPoints: 35 });
      throw new Error('Should have thrown');
    } catch (e) {
      if (!e.message.includes('exceeds 30pt maximum')) {
        throw new Error('Wrong error message');
      }
    }
  });

  test('constructor: throws on R:R below 3', () => {
    try {
      new GexMeanReversionStrategy({ stopLossPoints: 20, takeProfitPoints: 50 });
      throw new Error('Should have thrown');
    } catch (e) {
      if (!e.message.includes('below 3.0 minimum')) {
        throw new Error('Wrong error message');
      }
    }
  });

  // --- GEX Regime Detection Tests ---

  test('isNegativeGEXRegime: detects negative total_gex', () => {
    const strategy = new GexMeanReversionStrategy();
    const result = strategy.isNegativeGEXRegime({ total_gex: -5e10 });
    assertEqual(result, true, 'Should detect negative');
  });

  test('isNegativeGEXRegime: detects positive total_gex', () => {
    const strategy = new GexMeanReversionStrategy();
    const result = strategy.isNegativeGEXRegime({ total_gex: 5e10 });
    assertEqual(result, false, 'Should detect positive');
  });

  test('isNegativeGEXRegime: detects negative regime string', () => {
    const strategy = new GexMeanReversionStrategy();
    const result = strategy.isNegativeGEXRegime({ regime: 'strong_negative' });
    assertEqual(result, true, 'Should detect from regime string');
  });

  // --- Support Level Detection Tests ---

  test('findNearestSupport: finds support within proximity', () => {
    const strategy = new GexMeanReversionStrategy({ levelProximity: 15 });
    const gex = createGexLevels(21000);
    gex.put_wall = null; // Remove put_wall to test S1
    const support = strategy.findNearestSupport(21010, gex);
    assertNotNull(support, 'Should find support');
    assertEqual(support.level, 21000, 'Should be first support');
  });

  test('findNearestSupport: returns null if too far', () => {
    const strategy = new GexMeanReversionStrategy({ levelProximity: 15 });
    const gex = createGexLevels(21000);
    const support = strategy.findNearestSupport(21100, gex); // 100 points away
    assertNull(support, 'Should not find support');
  });

  test('findNearestSupport: prioritizes put wall', () => {
    const strategy = new GexMeanReversionStrategy({ levelProximity: 20 });
    const gex = createGexLevels(21000);
    gex.put_wall = 21015; // Closer than S1
    const support = strategy.findNearestSupport(21020, gex);
    assertNotNull(support, 'Should find support');
    assertEqual(support.type, 'PutWall', 'Should prioritize put wall (closer)');
  });

  // --- Signal Generation Tests ---

  test('evaluateSignal: generates signal near support in negative GEX', () => {
    const strategy = new GexMeanReversionStrategy({
      useSessionFilter: false,  // Skip session check for testing
      debug: false
    });

    // RTH timestamp (2 PM EST = 7 PM UTC)
    const timestamp = new Date('2024-06-15T19:00:00Z').getTime();
    const candle = createCandle(21010, timestamp);
    const prevCandle = createCandle(21020, timestamp - 60000);
    const marketData = { gexLevels: createGexLevels(21000) };

    const signal = strategy.evaluateSignal(candle, prevCandle, marketData);
    assertNotNull(signal, 'Should generate signal');
    assertEqual(signal.side, 'long', 'Should be long signal');
    assertEqual(signal.strategy, 'GEX_MEAN_REVERSION', 'Should have correct strategy name');
  });

  test('evaluateSignal: no signal in positive GEX when requireNegativeGEX=true', () => {
    const strategy = new GexMeanReversionStrategy({
      requireNegativeGEX: true,
      useSessionFilter: false
    });

    const timestamp = new Date('2024-06-15T19:00:00Z').getTime();
    const candle = createCandle(21010, timestamp);
    const prevCandle = createCandle(21020, timestamp - 60000);
    const gex = createGexLevels(21000, { regime: 'positive', total_gex: 5e10 });
    const marketData = { gexLevels: gex };

    const signal = strategy.evaluateSignal(candle, prevCandle, marketData);
    assertNull(signal, 'Should not generate signal in positive GEX');
  });

  test('evaluateSignal: no signal when price below support (breakdown)', () => {
    const strategy = new GexMeanReversionStrategy({
      useSessionFilter: false
    });

    const timestamp = new Date('2024-06-15T19:00:00Z').getTime();
    const candle = createCandle(20995, timestamp); // Below 21000 support
    const prevCandle = createCandle(21010, timestamp - 60000);
    const marketData = { gexLevels: createGexLevels(21000) };

    const signal = strategy.evaluateSignal(candle, prevCandle, marketData);
    assertNull(signal, 'Should not generate signal when price below support');
  });

  test('evaluateSignal: respects cooldown period', () => {
    const strategy = new GexMeanReversionStrategy({
      useSessionFilter: false,
      signalCooldownMs: 1800000 // 30 min = 1,800,000 ms
    });

    // Use 11 AM EST = 4 PM UTC to avoid entry cutoff (3:30 PM EST = 8:30 PM UTC)
    const timestamp1 = new Date('2024-06-15T16:00:00Z').getTime();
    const candle1 = createCandle(21010, timestamp1);
    const prevCandle1 = createCandle(21020, timestamp1 - 60000);
    // Create market data with put_wall removed to simplify test
    const gex = createGexLevels(21000);
    gex.put_wall = null;
    const marketData = { gexLevels: gex };

    // First signal should work
    const signal1 = strategy.evaluateSignal(candle1, prevCandle1, marketData);
    assertNotNull(signal1, 'First signal should generate');

    // Second signal within cooldown should fail
    const timestamp2 = timestamp1 + 900000; // 15 minutes later = 900,000 ms
    const candle2 = createCandle(21012, timestamp2);
    const prevCandle2 = createCandle(21022, timestamp2 - 60000);
    const signal2 = strategy.evaluateSignal(candle2, prevCandle2, marketData);
    assertNull(signal2, 'Should not generate signal within cooldown');

    // Third signal after cooldown should work
    // Cooldown is 1,800,000 ms (30 min), so we need to be at least that far from signal1
    const timestamp3 = timestamp1 + 1850000; // ~30.8 minutes later (11:30 AM EST)
    const candle3 = createCandle(21010, timestamp3);
    const prevCandle3 = createCandle(21020, timestamp3 - 60000);
    const signal3 = strategy.evaluateSignal(candle3, prevCandle3, marketData);
    assertNotNull(signal3, 'Should generate signal after cooldown');
  });

  test('evaluateSignal: signal has correct stop and target', () => {
    const strategy = new GexMeanReversionStrategy({
      stopLossPoints: 20,
      takeProfitPoints: 60,
      useSessionFilter: false
    });

    const timestamp = new Date('2024-06-15T19:00:00Z').getTime();
    const candle = createCandle(21010, timestamp);
    const prevCandle = createCandle(21020, timestamp - 60000);
    const marketData = { gexLevels: createGexLevels(21000) };

    const signal = strategy.evaluateSignal(candle, prevCandle, marketData);
    assertNotNull(signal, 'Should generate signal');
    assertEqual(signal.stopLoss, 20990, 'Stop should be entry - 20');
    assertEqual(signal.takeProfit, 21070, 'Target should be entry + 60');
  });

  // --- Configuration Tests ---

  test('getConfig: returns configuration summary', () => {
    const strategy = new GexMeanReversionStrategy({
      stopLossPoints: 25,
      takeProfitPoints: 75
    });

    const config = strategy.getConfig();
    assertEqual(config.stopLoss, 25, 'Should have correct stop');
    assertEqual(config.takeProfit, 75, 'Should have correct target');
    assertEqual(config.riskReward, 3, 'Should have correct R:R');
  });

  // --- Summary ---
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// Run tests
runTests().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
