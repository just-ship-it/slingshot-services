#!/usr/bin/env node

/**
 * Test Late September Support Sweep
 *
 * Focus on Sept 28-30 to catch the sweep of 24,633 support
 */

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs/promises';
import path from 'path';

async function testSeptemberSweep() {
  console.log('🎯 Testing Late September Support Sweep');
  console.log('=' .repeat(70));
  console.log();
  console.log('📊 Focus: Sept 28-30 - Testing 24,633 GEX Put Wall sweep');
  console.log();

  const config = {
    ticker: 'NQ',
    startDate: new Date('2025-09-28'),
    endDate: new Date('2025-09-30T23:59:59'),
    timeframe: '15m',
    strategy: 'gex-ldpm-confluence-pullback',
    strategyParams: {
      // Confluence detection
      confluenceThreshold: 5,
      entryDistance: 10,
      stopLossPoints: 50,
      targetAtCenter: true,

      // Enhanced pullback system
      enablePullbackSystem: true,
      maxPullbackWait: 24,
      maxPullbackDistance: 150,
      minPullbackDistance: 5,

      // Level weights
      structuralLevelWeight: 1.0,
      sessionLevelWeight: 1.2,
      fibonacciLevelWeight: 1.2,

      tradingSymbol: 'NQ',
      debugMode: true,

      // Force evaluation even in ranging markets
      minVolatility: 0,
      requireTrend: false
    },
    commission: 5,
    initialCapital: 100000,
    dataDir: 'data',
    verbose: true,
    quiet: false,
    showTrades: true,
    debugMode: true
  };

  try {
    const engine = new BacktestEngine(config);
    const strategy = engine.strategy;

    // Track what's happening
    let levelEvents = [];
    let sweepDetected = false;
    let confirmationSignals = [];

    // Hook into level monitor to track events
    if (strategy.levelMonitor) {
      const originalLogEvent = strategy.levelMonitor.logLevelEvent.bind(strategy.levelMonitor);
      strategy.levelMonitor.logLevelEvent = function(levelId, eventType, description) {
        const event = {
          time: new Date().toISOString(),
          levelId,
          eventType,
          description
        };
        levelEvents.push(event);

        // Log important events in real-time
        if (eventType === 'confirmed' || eventType === 'level_lost' ||
            description.includes('wick') || description.includes('rejection')) {
          console.log(`  🔔 ${eventType.toUpperCase()}: ${description}`);
        }

        originalLogEvent(levelId, eventType, description);
      };
    }

    // Override evaluateSignal to track what's happening
    const originalEvaluate = strategy.evaluateSignal.bind(strategy);
    strategy.evaluateSignal = function(candle, prevCandle, marketData, options) {
      // Log when we're near the key level
      if (candle.low <= 24650 && candle.low >= 24600) {
        console.log(`\n📍 Testing Key Zone - Candle: ${new Date(candle.timestamp).toISOString()}`);
        console.log(`   Open: ${candle.open.toFixed(2)}, High: ${candle.high.toFixed(2)}, Low: ${candle.low.toFixed(2)}, Close: ${candle.close.toFixed(2)}`);

        // Check for wick below 24,633
        if (candle.low < 24633.68 && candle.close > 24633.68) {
          sweepDetected = true;
          console.log(`   ✅ WICK SWEEP DETECTED! Low: ${candle.low.toFixed(2)}, Close: ${candle.close.toFixed(2)}`);
        }
      }

      const signal = originalEvaluate(candle, prevCandle, marketData, options);

      if (signal) {
        console.log(`\n🚀 SIGNAL GENERATED:`);
        console.log(`   Type: ${signal.action}`);
        console.log(`   Side: ${signal.side}`);
        console.log(`   Entry: ${signal.price.toFixed(2)}`);
        console.log(`   Stop: ${signal.stop_loss.toFixed(2)}`);
        console.log(`   Target: ${signal.take_profit.toFixed(2)}`);
        if (signal.testedLevel) {
          console.log(`   Tested Level: ${signal.testedLevel.toFixed(2)}`);
        }
        if (signal.confirmationType) {
          console.log(`   Confirmation: ${signal.confirmationType}`);
        }
        confirmationSignals.push(signal);
      }

      return signal;
    };

    console.log('🚀 Running backtest...\n');
    const results = await engine.run();

    // Analysis section
    console.log('\n' + '='.repeat(70));
    console.log('📊 SWEEP ANALYSIS RESULTS');
    console.log('='.repeat(70) + '\n');

    // Key level events
    console.log('🔍 KEY LEVEL EVENTS:');
    console.log('-'.repeat(50));
    const keyEvents = levelEvents.filter(e =>
      e.description.includes('24633') ||
      e.description.includes('24664') ||
      e.description.includes('wick') ||
      e.eventType === 'confirmed'
    );

    if (keyEvents.length > 0) {
      keyEvents.forEach(event => {
        console.log(`  ${event.eventType}: ${event.description}`);
      });
    } else {
      console.log('  No key level events detected');
    }
    console.log();

    // Sweep detection
    console.log('🎯 SWEEP DETECTION:');
    console.log('-'.repeat(50));
    if (sweepDetected) {
      console.log('  ✅ Price swept below 24,633.68 and recovered!');
    } else {
      console.log('  ❌ No sweep of 24,633.68 detected');
    }
    console.log();

    // Signals generated
    console.log('📈 CONFIRMATION SIGNALS:');
    console.log('-'.repeat(50));
    if (confirmationSignals.length > 0) {
      confirmationSignals.forEach((sig, idx) => {
        console.log(`  Signal ${idx + 1}:`);
        console.log(`    Entry: ${sig.price.toFixed(2)}`);
        console.log(`    Stop: ${sig.stop_loss.toFixed(2)} (Risk: ${(sig.price - sig.stop_loss).toFixed(2)} pts)`);
        console.log(`    Target: ${sig.take_profit.toFixed(2)} (Reward: ${(sig.take_profit - sig.price).toFixed(2)} pts)`);
        console.log(`    R:R Ratio: ${((sig.take_profit - sig.price) / (sig.price - sig.stop_loss)).toFixed(2)}`);
      });
    } else {
      console.log('  No confirmation signals generated');
    }
    console.log();

    // Trade results
    console.log('💼 TRADES EXECUTED:');
    console.log('-'.repeat(50));
    if (results.trades && results.trades.length > 0) {
      results.trades.forEach((trade, idx) => {
        console.log(`  Trade ${idx + 1}: ${trade.side.toUpperCase()}`);
        console.log(`    Entry: ${trade.entryPrice.toFixed(2)} @ ${new Date(trade.entryTime).toLocaleString()}`);
        console.log(`    Exit: ${trade.exitPrice.toFixed(2)} @ ${new Date(trade.exitTime).toLocaleString()}`);
        console.log(`    P&L: $${trade.realizedPL.toFixed(2)}`);
        console.log(`    Exit Reason: ${trade.exitReason}`);
      });
    } else {
      console.log('  No trades executed');
    }
    console.log();

    // Performance summary
    console.log('📊 PERFORMANCE SUMMARY:');
    console.log('-'.repeat(50));
    console.log(`  Total Trades: ${results.performance.totalTrades}`);
    console.log(`  Win Rate: ${(results.performance.winRate * 100).toFixed(1)}%`);
    console.log(`  Total P&L: $${results.performance.totalPL.toFixed(2)}`);
    if (results.performance.totalTrades > 0) {
      console.log(`  Avg Win: $${results.performance.avgWin.toFixed(2)}`);
      console.log(`  Avg Loss: $${results.performance.avgLoss.toFixed(2)}`);
    }

    // Save results
    const outputPath = path.join('results', `sept-sweep-${Date.now()}.json`);
    await fs.writeFile(
      outputPath,
      JSON.stringify({
        config,
        results,
        analysis: {
          sweepDetected,
          levelEvents: keyEvents,
          confirmationSignals
        }
      }, null, 2)
    );

    console.log(`\n✅ Results saved to: ${outputPath}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  }
}

// Run the test
testSeptemberSweep().catch(console.error);