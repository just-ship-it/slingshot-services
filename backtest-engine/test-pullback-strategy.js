#!/usr/bin/env node

/**
 * Test Pullback Strategy Implementation
 *
 * Simple test to verify the pullback strategy works and compares
 * basic performance against the original conservative strategy.
 */

import { BacktestEngine } from './src/backtest-engine.js';

async function testPullbackStrategy() {
  console.log('🧪 Testing GEX-LDPM Pullback Strategy Implementation');
  console.log('=' .repeat(80));
  console.log();

  // Test configuration - use a shorter time period for faster testing
  const testConfig = {
    ticker: 'NQ',
    startDate: new Date('2025-10-01'),
    endDate: new Date('2025-11-01'),
    timeframe: '15m',
    strategy: 'gex-ldpm-confluence-pullback',
    strategyParams: {
      confluenceThreshold: 5,
      entryDistance: 10,
      enablePullbackSystem: true,
      maxPullbackWait: 6, // Shorter wait for testing
      maxPullbackDistance: 30,
      requireMomentumAlignment: true,
      tradingSymbol: 'NQ'
    },
    commission: 5,
    initialCapital: 100000,
    dataDir: 'data',
    verbose: false,
    quiet: true,
    showTrades: false
  };

  try {
    console.log('🚀 Running pullback strategy test...');
    console.log(`📅 Period: ${testConfig.startDate.toISOString().slice(0, 10)} to ${testConfig.endDate.toISOString().slice(0, 10)}`);
    console.log(`📊 Strategy: ${testConfig.strategy}`);
    console.log(`⚙️  Pullback System: ${testConfig.strategyParams.enablePullbackSystem ? 'ENABLED' : 'DISABLED'}`);
    console.log();

    // Create and run backtest engine
    const engine = new BacktestEngine(testConfig);
    const results = await engine.run();

    // Display results
    console.log('📈 PULLBACK STRATEGY TEST RESULTS');
    console.log('-'.repeat(60));

    if (results && results.performance && results.performance.summary) {
      const perf = results.performance.summary;
      console.log(`✅ Test completed successfully!`);
      console.log();
      console.log('Performance Summary:');
      console.log(`   Total Trades: ${perf.totalTrades || 0}`);
      console.log(`   Win Rate: ${perf.winRate ? perf.winRate.toFixed(1) : 0}%`);
      console.log(`   Net P&L: $${perf.totalPnL ? perf.totalPnL.toFixed(2) : 0}`);
      console.log(`   Max Drawdown: ${perf.maxDrawdown ? perf.maxDrawdown.toFixed(1) : 0}%`);
      console.log();

      // Check if strategy is working
      if (perf.totalTrades > 0) {
        console.log('🎉 Strategy is generating trades - pullback system is working!');

        // Basic validation
        if (perf.winRate > 30 && perf.totalPnL !== 0) {
          console.log('✅ Strategy performance looks reasonable');
        } else {
          console.log('⚠️  Strategy performance needs review');
        }
      } else {
        console.log('🚨 No trades generated - may need to adjust parameters or check data');
      }

    } else {
      console.log('⚠️  No performance data returned - check strategy implementation');
    }

    console.log();
    console.log('💡 Next Steps:');
    console.log('1. Run full comparison test against original conservative strategy');
    console.log('2. Analyze trade entry timing and pullback effectiveness');
    console.log('3. Optimize pullback parameters based on results');
    console.log('4. Test with different market conditions');

  } catch (error) {
    console.error('❌ Error testing pullback strategy:', error.message);
    console.error('');
    console.error('Common issues:');
    console.error('- Missing base strategy class');
    console.error('- Data loading problems');
    console.error('- Strategy parameter validation');
    console.error('- Indicator initialization issues');

    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
  }
}

// Run test
testPullbackStrategy().catch(console.error);