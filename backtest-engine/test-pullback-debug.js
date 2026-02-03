#!/usr/bin/env node

/**
 * Debug Pullback Strategy
 *
 * Single test to debug why pullback system isn't working
 */

import { BacktestEngine } from './src/backtest-engine.js';

async function debugPullback() {
  console.log('🔧 Debugging Pullback Strategy');
  console.log('=' .repeat(60));
  console.log();

  const config = {
    ticker: 'NQ',
    startDate: new Date('2025-10-01'),
    endDate: new Date('2025-10-02'),  // Just 1 day
    timeframe: '15m',
    strategy: 'gex-ldpm-confluence-pullback',
    strategyParams: {
      confluenceThreshold: 5,
      entryDistance: 10,
      stopLossPoints: 50,
      targetAtCenter: true,
      tradingSymbol: 'NQ',

      // Pullback system parameters
      enablePullbackSystem: true,
      maxPullbackWait: 24,
      maxPullbackDistance: 100,
      minPullbackDistance: 5,
      requireMomentumAlignment: false,
      requireLevelRespect: false,

      // Level detector weights
      structuralLevelWeight: 1.0,
      sessionLevelWeight: 1.2,
      fibonacciLevelWeight: 0.8
    },
    commission: 5,
    initialCapital: 100000,
    dataDir: 'data',
    verbose: true,
    quiet: false,
    showTrades: true
  };

  console.log('📅 Test Period: Oct 1, 2025 (1 day debug)');
  console.log('🎯 Looking for pullback signal conversion...');
  console.log();

  try {
    const engine = new BacktestEngine(config);
    const results = await engine.run();

    console.log();
    console.log('=' .repeat(60));
    console.log('🔧 DEBUG RESULTS');
    console.log('=' .repeat(60));

    const perf = results?.performance?.summary || {};
    const trades = perf.totalTrades || 0;
    const pendingSignals = results?.pendingSignals?.length || 0;

    console.log(`Total Trades: ${trades}`);
    console.log(`Pending Signals: ${pendingSignals}`);

    if (results?.trades?.length > 0) {
      console.log('\n📋 Executed Trades:');
      results.trades.slice(0, 3).forEach((trade, i) => {
        const entryDate = new Date(trade.entryTime);
        console.log(`  ${i + 1}. ${trade.side?.toUpperCase()} at ${entryDate.toISOString().slice(0, 19)}`);
        console.log(`     Entry: $${trade.entryPrice} | P&L: $${trade.grossPnL || trade.pnl}`);
      });
    }

    if (results?.pendingSignals?.length > 0) {
      console.log('\n⏳ Pending Signals:');
      results.pendingSignals.slice(0, 3).forEach((signal, i) => {
        const signalDate = new Date(signal.timestamp);
        console.log(`  ${i + 1}. ${signal.side?.toUpperCase()} at ${signalDate.toISOString().slice(0, 19)}`);
        console.log(`     Price: $${signal.price} | Zone: $${signal.zone}`);
      });
    } else {
      console.log('\n❌ No pending signals generated');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  }

  console.log('\n✅ Debug complete!');
}

debugPullback().catch(console.error);