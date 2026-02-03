#!/usr/bin/env node

/**
 * Test Pullback Strategy with Level Detection Output
 *
 * Runs a small backtest and ensures pullback levels are included in trade JSON
 */

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs/promises';
import path from 'path';

async function testPullbackWithLevels() {
  console.log('🔧 Testing Pullback Strategy with Level Output');
  console.log('=' .repeat(60));
  console.log();

  const config = {
    ticker: 'NQ',
    startDate: new Date('2025-10-01'),
    endDate: new Date('2025-10-02'),  // Small test period
    timeframe: '15m',
    strategy: 'gex-ldpm-confluence-pullback',
    strategyParams: {
      confluenceThreshold: 5,
      entryDistance: 10,
      stopLossPoints: 50,
      targetAtCenter: true,
      enablePullbackSystem: true,
      maxPullbackWait: 24,
      maxPullbackDistance: 100,
      minPullbackDistance: 5,
      structuralLevelWeight: 1.0,
      sessionLevelWeight: 1.2,
      fibonacciLevelWeight: 0.8,
      tradingSymbol: 'NQ'
    },
    commission: 5,
    initialCapital: 100000,
    dataDir: 'data',
    verbose: false,
    quiet: false,
    showTrades: true
  };

  console.log('📅 Test Period: Oct 1-2, 2025');
  console.log('🎯 Strategy: GEX-LDPM Confluence with Pullback System');
  console.log();

  try {
    const engine = new BacktestEngine(config);

    // Override the strategy's evaluateSignal to capture pullback levels in signals
    const strategy = engine.strategy;
    const originalAddPending = strategy.addPendingSignalSync;

    strategy.addPendingSignalSync = function(signal, candle) {
      // Capture pullback levels when signal is added to pending
      const pullbackLevels = this.identifyPullbackLevels(signal, candle.close);

      console.log(`\n📊 Signal Generated at ${new Date(candle.timestamp).toISOString()}`);
      console.log(`   Side: ${signal.side.toUpperCase()}`);
      console.log(`   Price: $${signal.price}`);
      console.log(`   Confluence Zone: $${signal.confluenceZone?.center || 'N/A'}`);

      console.log(`\n   🎯 Detected Pullback Levels (${pullbackLevels.length} total):`);

      if (pullbackLevels.length > 0) {
        // Group by source
        const levelsBySource = {
          structural: pullbackLevels.filter(l => l.source === 'structural'),
          session: pullbackLevels.filter(l => l.source === 'session'),
          fibonacci: pullbackLevels.filter(l => l.source === 'fibonacci')
        };

        if (levelsBySource.structural.length > 0) {
          console.log('   Structural Levels:');
          levelsBySource.structural.slice(0, 3).forEach(level => {
            console.log(`     - $${level.price.toFixed(2)} (${level.type}, weight: ${level.weight.toFixed(1)})`);
          });
        }

        if (levelsBySource.session.length > 0) {
          console.log('   Session Levels:');
          levelsBySource.session.slice(0, 3).forEach(level => {
            console.log(`     - $${level.price.toFixed(2)} (${level.type}, weight: ${level.weight.toFixed(1)})`);
          });
        }

        if (levelsBySource.fibonacci.length > 0) {
          console.log('   Fibonacci Levels:');
          levelsBySource.fibonacci.slice(0, 5).forEach(level => {
            console.log(`     - $${level.price.toFixed(2)} (${level.description || level.type}, weight: ${level.weight.toFixed(1)})`);
          });
        }
      } else {
        console.log('   ❌ No pullback levels detected');
      }

      // Add levels to signal for JSON output
      signal.pullbackLevels = pullbackLevels.map(level => ({
        price: level.price,
        source: level.source,
        type: level.type,
        description: level.description,
        weight: level.weight,
        distance: Math.abs(level.price - candle.close)
      }));

      // Call original method
      return originalAddPending.call(this, signal, candle);
    };

    const results = await engine.run();

    console.log('\n' + '='.repeat(60));
    console.log('📈 BACKTEST COMPLETE');
    console.log('='.repeat(60));

    console.log(`\nTotal Signals Generated: ${results.simulation.totalSignals}`);
    console.log(`Pending Signals Created: ${results.simulation.rejectedSignals || 0}`);
    console.log(`Trades Executed: ${results.trades.length}`);

    // Output trades with pullback levels to JSON
    const outputData = {
      config: {
        ticker: config.ticker,
        period: `${config.startDate.toISOString().split('T')[0]} to ${config.endDate.toISOString().split('T')[0]}`,
        strategy: config.strategy
      },
      summary: {
        totalSignals: results.simulation.totalSignals,
        tradesExecuted: results.trades.length,
        totalReturn: results.performance.totalReturn,
        winRate: results.performance.winRate
      },
      trades: results.trades.map(trade => ({
        id: trade.id,
        entryTime: new Date(trade.entryTime).toISOString(),
        exitTime: trade.exitTime ? new Date(trade.exitTime).toISOString() : null,
        side: trade.side,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        quantity: trade.quantity,
        pnl: trade.pnl,
        pnlPercent: trade.pnlPercent,
        exitReason: trade.exitReason,
        // Include pullback levels if available
        pullbackLevels: trade.pullbackLevels || [],
        // Include other indicators
        indicators: {
          gexRegime: trade.gexRegime,
          confluenceZone: trade.confluenceZone,
          volumeRatio: trade.volumeRatio,
          distanceFromZone: trade.distanceFromZone
        }
      })),
      pendingSignals: results.pendingSignals || []
    };

    // Write to JSON file
    const outputPath = path.join(process.cwd(), 'results', 'pullback-levels-test.json');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(outputData, null, 2));

    console.log(`\n✅ Results saved to: ${outputPath}`);

    // Display sample trade with levels
    if (outputData.trades.length > 0) {
      const sampleTrade = outputData.trades[0];
      console.log('\n📊 Sample Trade JSON:');
      console.log(JSON.stringify(sampleTrade, null, 2));
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  }
}

testPullbackWithLevels().catch(console.error);