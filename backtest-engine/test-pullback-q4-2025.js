#!/usr/bin/env node

/**
 * Q4 2025 Pullback Strategy Test
 *
 * Tests the pullback strategy on the same period as our sample losing trades
 * for direct comparison with conservative strategy performance.
 */

import { BacktestEngine } from './src/backtest-engine.js';

async function testPullbackQ4() {
  console.log('🎯 Testing Pullback Strategy on Q4 2025 Data');
  console.log('=' .repeat(80));
  console.log();

  // Q4 2025 - same period as our analyzed sample trades
  const config = {
    ticker: 'NQ',
    startDate: new Date('2025-10-01'),
    endDate: new Date('2025-12-19'),
    timeframe: '15m',
    strategy: 'gex-ldpm-confluence-pullback',
    strategyParams: {
      // Base parameters (same as conservative)
      confluenceThreshold: 5,
      entryDistance: 10,
      stopLossPoints: 50,
      targetAtCenter: true,
      tradingSymbol: 'NQ',

      // Pullback system parameters - more aggressive for testing
      enablePullbackSystem: true,
      maxPullbackWait: 24,           // 24 hours to wait for pullback
      maxPullbackDistance: 75,       // Increased from 50
      minPullbackDistance: 5,        // Reduced from 10
      requireMomentumAlignment: false,
      requireLevelRespect: false,

      // Level detector weights
      structuralLevelWeight: 1.0,
      sessionLevelWeight: 1.5,
      fibonacciLevelWeight: 0.8
    },
    commission: 5,
    initialCapital: 100000,
    dataDir: 'data',
    verbose: false,
    quiet: false,
    showTrades: true,  // Show individual trades
    outputJson: 'results/gex-ldpm-pullback-q4-2025_results.json'
  };

  console.log('📅 Test Period: Oct 1 - Dec 19, 2025');
  console.log('📊 Strategy: GEX-LDPM Confluence with Pullback Entry System');
  console.log('⚙️  Configuration:');
  console.log(`   • Confluence Threshold: ${config.strategyParams.confluenceThreshold} points`);
  console.log(`   • Entry Distance: ${config.strategyParams.entryDistance} points`);
  console.log(`   • Pullback Wait: ${config.strategyParams.maxPullbackWait} hours`);
  console.log(`   • Pullback Range: ${config.strategyParams.minPullbackDistance}-${config.strategyParams.maxPullbackDistance} points`);
  console.log();

  try {
    const engine = new BacktestEngine(config);
    const results = await engine.run();

    console.log();
    console.log('=' .repeat(80));
    console.log('📊 Q4 2025 PULLBACK STRATEGY RESULTS');
    console.log('=' .repeat(80));
    console.log();

    // Extract metrics
    const perf = results?.performance?.summary || {};
    const basic = results?.performance?.basic || {};
    const advanced = results?.performance?.advanced || {};

    const trades = perf.totalTrades || basic.totalTrades || 0;
    const winRate = perf.winRate || basic.winRate || 0;
    const netPnL = perf.totalPnL || basic.netPnL || 0;
    const maxDD = perf.maxDrawdown || advanced.maxDrawdown || 0;
    const sharpe = perf.sharpeRatio || advanced.sharpeRatio || 0;
    const winTrades = basic.winningTrades || 0;
    const lossTrades = basic.losingTrades || 0;

    console.log('📈 Performance Summary:');
    console.log(`   Total Trades: ${trades}`);
    console.log(`   Winning: ${winTrades} | Losing: ${lossTrades}`);
    console.log(`   Win Rate: ${winRate.toFixed(1)}%`);
    console.log(`   Net P&L: $${netPnL.toFixed(2)}`);
    console.log(`   Max Drawdown: ${maxDD.toFixed(1)}%`);
    console.log(`   Sharpe Ratio: ${sharpe.toFixed(2)}`);
    console.log();

    // Check our specific sample trades
    console.log('🔍 Checking Sample Trade Dates:');
    console.log('   Oct 15, 2025 @ 3:59 PM EDT - SELL at $24,924.50');
    console.log('   Nov 5, 2025 @ 3:09 AM EST - SELL at $25,522.50');
    console.log('   Dec 15, 2025 @ 4:14 AM EST - SELL at $25,568.50');
    console.log();

    // Find trades near these dates
    if (results.trades && results.trades.length > 0) {
      const oct15 = new Date('2025-10-15T19:59:00Z').getTime(); // 3:59 PM EDT
      const nov5 = new Date('2025-11-05T08:09:00Z').getTime();  // 3:09 AM EST
      const dec15 = new Date('2025-12-15T09:14:00Z').getTime(); // 4:14 AM EST

      const nearbyTrades = results.trades.filter(trade => {
        const entryTime = trade.entryTime;
        return Math.abs(entryTime - oct15) < 86400000 || // Within 24 hours
               Math.abs(entryTime - nov5) < 86400000 ||
               Math.abs(entryTime - dec15) < 86400000;
      });

      if (nearbyTrades.length > 0) {
        console.log(`Found ${nearbyTrades.length} trades near sample dates:`);
        nearbyTrades.forEach(trade => {
          const entryDate = new Date(trade.entryTime);
          console.log(`   ${entryDate.toISOString().slice(0, 19)} - ${trade.side?.toUpperCase()} at $${trade.entryPrice || trade.signal?.price} - P&L: $${trade.grossPnL || trade.pnl}`);
        });
      } else {
        console.log('   No trades found near sample dates (might have waited for better pullback levels!)');
      }
    }

    console.log();

    // Assessment
    if (trades === 0) {
      console.log('❌ No trades generated');
      console.log();
      console.log('💡 Troubleshooting:');
      console.log('   • Pullback levels may not be getting detected properly');
      console.log('   • Try disabling pullback system to verify base strategy works');
      console.log('   • Check if pending signals are being created but not executed');
    } else if (trades < 10) {
      console.log('⚠️  Very few trades generated');
      console.log();
      console.log('💡 Suggestions:');
      console.log('   • Increase maxPullbackDistance further (100+ points)');
      console.log('   • Reduce level requirements');
      console.log('   • Check if structural levels are being detected');
    } else {
      console.log('✅ Strategy is generating trades!');

      if (winRate > 50) {
        console.log('🎯 Win rate improved compared to baseline!');
      }

      if (netPnL > 0) {
        console.log('💰 Profitable in Q4 2025!');
      }
    }

    console.log();
    console.log('✅ Q4 2025 test complete!');
    console.log(`📄 Full results saved to: ${config.outputJson}`);

  } catch (error) {
    console.error('❌ Error running pullback strategy:', error.message);
    console.error(error.stack);
  }
}

// Run test
testPullbackQ4().catch(console.error);