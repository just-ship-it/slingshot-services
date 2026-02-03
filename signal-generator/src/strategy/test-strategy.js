#!/usr/bin/env node

// Test Strategy Engine independently
import GexRecoilStrategy from './gex-recoil.js';
import { createLogger } from '../../../shared/index.js';
import config from '../utils/config.js';

const logger = createLogger('strategy-test');

console.log('='.repeat(60));
console.log('Strategy Engine Test');
console.log('='.repeat(60));

async function testStrategy() {
  try {
    // Create strategy instance
    const strategy = new GexRecoilStrategy();

    console.log('📋 Strategy Parameters:');
    console.log(`- Target Points: ${strategy.params.targetPoints}`);
    console.log(`- Stop Buffer: ${strategy.params.stopBuffer}`);
    console.log(`- Max Risk: ${strategy.params.maxRisk}`);
    console.log(`- Use Trailing Stop: ${strategy.params.useTrailingStop}`);
    console.log(`- Liquidity Filter: ${strategy.params.useLiquidityFilter}`);
    console.log('');

    // Mock GEX levels (similar to what we get from GEX calculator)
    const mockGexLevels = {
      putWall: 24442,
      callWall: 26099,
      gammaFlip: 25271,
      support: [25271, 25064, 24856, 24442, 24028],
      resistance: [25478, 26099, 26306, 26514, 26928],
      regime: 'negative',
      totalGex: -4.05
    };

    console.log('📊 Mock GEX Levels:');
    console.log(`- Put Wall: ${mockGexLevels.putWall}`);
    console.log(`- Call Wall: ${mockGexLevels.callWall}`);
    console.log(`- Support: ${mockGexLevels.support.join(', ')}`);
    console.log(`- Resistance: ${mockGexLevels.resistance.join(', ')}`);
    console.log('');

    // Test scenario 1: Price crosses below put wall
    console.log('🧪 Test 1: Price crosses below put wall');

    const prevCandle1 = {
      symbol: 'NQ1!',
      open: 24500,
      high: 24520,
      low: 24450,
      close: 24460, // Above put wall
      volume: 1000,
      timestamp: Date.now() - 900000 // 15 minutes ago
    };

    const currentCandle1 = {
      symbol: 'NQ1!',
      open: 24460,
      high: 24470,
      low: 24400,
      close: 24420, // Below put wall (24442)
      volume: 1200,
      timestamp: Date.now()
    };

    console.log(`- Previous: Close=${prevCandle1.close} (above put wall ${mockGexLevels.putWall})`);
    console.log(`- Current: Close=${currentCandle1.close} (below put wall ${mockGexLevels.putWall})`);

    // First call to set previous candle
    const signal1a = strategy.generateSignal(prevCandle1, mockGexLevels);
    console.log(`- First call result: ${signal1a ? 'Signal' : 'No signal'} (expected: No signal)`);

    // Second call should generate signal
    const signal1b = strategy.generateSignal(currentCandle1, mockGexLevels);
    console.log(`- Second call result: ${signal1b ? 'Signal Generated!' : 'No signal'}`);

    if (signal1b) {
      console.log(`- Signal Details:`);
      console.log(`  - Action: ${signal1b.action}`);
      console.log(`  - Side: ${signal1b.side}`);
      console.log(`  - Symbol: ${signal1b.symbol}`);
      console.log(`  - Price: ${signal1b.price}`);
      console.log(`  - Stop Loss: ${signal1b.stop_loss}`);
      console.log(`  - Take Profit: ${signal1b.take_profit}`);
      console.log(`  - Strategy: ${signal1b.strategy}`);
      console.log(`  - Entry Reason: ${signal1b.metadata.entry_reason}`);
    }
    console.log('');

    // Test scenario 2: Price doesn't cross (should not signal)
    console.log('🧪 Test 2: Price stays above levels (no crossover)');

    const prevCandle2 = {
      symbol: 'NQ1!',
      open: 25300,
      high: 25320,
      low: 25280,
      close: 25300,
      volume: 1000,
      timestamp: Date.now() - 900000
    };

    const currentCandle2 = {
      symbol: 'NQ1!',
      open: 25300,
      high: 25320,
      low: 25280,
      close: 25310,
      volume: 1200,
      timestamp: Date.now()
    };

    console.log(`- Previous: Close=${prevCandle2.close}`);
    console.log(`- Current: Close=${currentCandle2.close}`);
    console.log('- Both above all GEX support levels');

    // Reset strategy for new test
    strategy.reset();

    const signal2a = strategy.generateSignal(prevCandle2, mockGexLevels);
    const signal2b = strategy.generateSignal(currentCandle2, mockGexLevels);
    console.log(`- Result: ${signal2b ? 'Signal Generated' : 'No signal'} (expected: No signal)`);
    console.log('');

    // Test scenario 3: Risk filter rejection
    console.log('🧪 Test 3: Risk filter rejection (high risk trade)');

    const prevCandle3 = {
      symbol: 'NQ1!',
      open: 24500,
      high: 24520,
      low: 24450,
      close: 24460,
      volume: 1000,
      timestamp: Date.now() - 900000
    };

    // Very low candle to create high risk
    const currentCandle3 = {
      symbol: 'NQ1!',
      open: 24460,
      high: 24470,
      low: 24300, // Very low
      close: 24420,
      volume: 1200,
      timestamp: Date.now()
    };

    console.log(`- Previous: Close=${prevCandle3.close}`);
    console.log(`- Current: Close=${currentCandle3.close}, Low=${currentCandle3.low}`);

    const riskPoints = currentCandle3.close - (currentCandle3.low - strategy.params.stopBuffer);
    console.log(`- Risk: ${riskPoints.toFixed(2)} points (max: ${strategy.params.maxRisk})`);

    strategy.reset();
    const signal3a = strategy.generateSignal(prevCandle3, mockGexLevels);
    const signal3b = strategy.generateSignal(currentCandle3, mockGexLevels);
    console.log(`- Result: ${signal3b ? 'Signal Generated' : 'No signal'} (expected: No signal due to risk filter)`);
    console.log('');

    console.log('✅ All strategy tests completed!');

  } catch (error) {
    console.error('❌ Strategy test failed:', error);
    process.exit(1);
  }
}

// Run tests
testStrategy().then(() => {
  console.log('');
  console.log('🎯 Strategy engine is ready for integration!');
  process.exit(0);
});