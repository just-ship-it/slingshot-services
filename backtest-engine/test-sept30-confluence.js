#!/usr/bin/env node

/**
 * Test Sept 30, 2025 Confluence Detection
 *
 * Validates that the enhanced confluence system correctly identifies
 * the 24,633 level where GEX Put Wall matched the actual market low
 */

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs/promises';
import path from 'path';

async function testSept30Confluence() {
  console.log('🎯 Testing Sept 30, 2025 Confluence Detection');
  console.log('=' .repeat(70));
  console.log();
  console.log('📊 Target: Verify confluence at 24,633 (GEX Put Wall 3 + Market Low)');
  console.log('📈 Expected Swing: High ~24,975 (Sept 26) → Low ~24,520 (Sept 29)');
  console.log();

  const config = {
    ticker: 'NQ',
    startDate: new Date('2025-09-26'),
    endDate: new Date('2025-09-30'),
    timeframe: '15m',
    strategy: 'gex-ldpm-confluence-pullback',
    strategyParams: {
      // Confluence detection parameters
      confluenceThreshold: 5,
      entryDistance: 10,
      stopLossPoints: 50,
      targetAtCenter: true,

      // Enhanced pullback system
      enablePullbackSystem: true,
      maxPullbackWait: 24,
      maxPullbackDistance: 100,
      minPullbackDistance: 5,

      // Level weights (prioritize GEX and fibonacci)
      structuralLevelWeight: 1.0,
      sessionLevelWeight: 1.2,
      fibonacciLevelWeight: 1.2,  // Increased for 70.5% ratio importance

      // Debug mode for detailed output
      debugMode: true,
      tradingSymbol: 'NQ'
    },
    commission: 5,
    initialCapital: 100000,
    dataDir: 'data',
    verbose: true,  // Enable verbose output
    quiet: false,
    showTrades: true,
    debugMode: true  // Extra debug info
  };

  console.log('📅 Test Period: Sept 26-30, 2025');
  console.log('⚙️  Strategy: GEX-LDPM Confluence with 3-Stage System');
  console.log();

  try {
    // Initialize backtest engine
    const engine = new BacktestEngine(config);

    // Hook into strategy to capture intermediate data
    const strategy = engine.strategy;

    // Capture fibonacci levels
    let fibLevels = [];
    let confluenceZones = [];
    let monitoredLevels = [];
    let capturedGexLevels = [];

    // Override some methods to capture data
    const originalEvaluate = strategy.evaluateSignal.bind(strategy);
    strategy.evaluateSignal = function(candle, prevCandle, marketData, options) {
      // Capture GEX levels
      if (marketData && marketData.gexLevels) {
        const unifiedGex = this.convertGexLevelsToUnifiedFormat(marketData.gexLevels);
        if (unifiedGex.length > 0) {
          capturedGexLevels = unifiedGex;
        }
      }
      // Capture fibonacci levels periodically
      if (this.fibonacciLevels && this.fibonacciLevels.fibLevels.length > 0) {
        fibLevels = this.fibonacciLevels.getActiveLevels();
      }

      // Capture confluence zones
      if (this.confluenceAnalyzer && this.confluenceAnalyzer.confluenceZones.length > 0) {
        confluenceZones = this.confluenceAnalyzer.confluenceZones;
      }

      // Capture monitored levels
      if (this.levelMonitor) {
        const status = this.levelMonitor.getMonitoredLevelsStatus();
        if (status.activeLevels.length > 0) {
          monitoredLevels = status.activeLevels;
        }
      }

      return originalEvaluate(candle, prevCandle, marketData, options);
    };

    // Run the backtest
    console.log('🚀 Running backtest...\n');
    const results = await engine.run();

    // Display results
    console.log('\n' + '='.repeat(70));
    console.log('📊 CONFLUENCE ANALYSIS RESULTS');
    console.log('='.repeat(70) + '\n');

    // Display ALL levels for experimentation
    console.log('📋 ALL DETECTED LEVELS (for experimentation):');
    console.log('-'.repeat(50));
    const allLevels = [];

    // Add fibonacci levels
    fibLevels.forEach(level => {
      allLevels.push({
        price: level.price,
        type: 'Fibonacci',
        description: `${(level.ratio * 100).toFixed(1)}%`,
        strength: level.strength
      });
    });

    // Add GEX levels
    capturedGexLevels.forEach(level => {
      allLevels.push({
        price: level.price,
        type: 'GEX',
        description: level.description,
        strength: level.strength
      });
    });

    // Sort all levels by price
    allLevels.sort((a, b) => a.price - b.price);

    // Display in table format
    console.log('  Price     | Type       | Description        | Strength');
    console.log('  ----------|------------|-------------------|----------');
    allLevels.forEach(level => {
      const marker = Math.abs(level.price - 24633.68) < 1 ? ' ⭐' : '';
      console.log(`  ${level.price.toFixed(2).padEnd(9)} | ${level.type.padEnd(10)} | ${level.description.padEnd(17)} | ${level.strength.toFixed(1)}${marker}`);
    });

    // Show gaps between levels
    console.log('\n  Level Gaps (sorted):');
    for (let i = 1; i < allLevels.length; i++) {
      const gap = allLevels[i].price - allLevels[i - 1].price;
      if (gap < 100) { // Only show gaps less than 100 points
        console.log(`    ${allLevels[i - 1].price.toFixed(2)} → ${allLevels[i].price.toFixed(2)}: ${gap.toFixed(2)} pts`);
      }
    }
    console.log();

    // Display fibonacci levels
    console.log('📐 FIBONACCI LEVELS DETECTED:');
    console.log('-'.repeat(50));
    if (fibLevels.length > 0) {
      // Sort by ratio to highlight 70.5%
      const sortedFibs = fibLevels.sort((a, b) => b.ratio - a.ratio);
      sortedFibs.forEach(level => {
        const marker = level.ratio === 0.705 ? ' ⭐ PRIMARY GOLDEN' : '';
        console.log(`  ${(level.ratio * 100).toFixed(1)}% @ ${level.price.toFixed(2)} - Strength: ${level.strength.toFixed(1)}${marker}`);
        if (level.swingHigh && level.swingLow) {
          console.log(`    Swing: ${level.swingHigh.toFixed(2)} → ${level.swingLow.toFixed(2)} (${level.swingSize.toFixed(1)} pts)`);
        }
      });
    } else {
      console.log('  No fibonacci levels detected (may need more historical data)');
    }
    console.log();

    // Display confluence zones
    console.log('🎯 CONFLUENCE ZONES IDENTIFIED:');
    console.log('-'.repeat(50));
    if (confluenceZones.length > 0) {
      confluenceZones.slice(0, 5).forEach((zone, idx) => {
        console.log(`  Zone ${idx + 1}: ${zone.centerPrice.toFixed(2)} (${zone.minPrice.toFixed(2)} - ${zone.maxPrice.toFixed(2)})`);
        console.log(`    Score: ${zone.score.toFixed(2)} - Quality: ${zone.quality}`);
        console.log(`    Levels: ${zone.levelCount} from ${zone.uniqueSources} sources`);
        if (zone.hasGex) console.log('    ✓ Contains GEX level');
        if (zone.hasPrimeGoldenFib) console.log('    ✓ Contains 70.5% Fibonacci');
        if (zone.hasSessionLevel) console.log('    ✓ Contains session level');

        // Check if this zone matches our target
        if (Math.abs(zone.centerPrice - 24633) < 10) {
          console.log('    🎯 MATCHES TARGET CONFLUENCE AT 24,633!');
        }
      });
    } else {
      console.log('  No confluence zones detected');
    }
    console.log();

    // Display monitored levels
    if (monitoredLevels.length > 0) {
      console.log('👁️ MONITORED LEVELS:');
      console.log('-'.repeat(50));
      monitoredLevels.forEach(level => {
        console.log(`  ${level.centerPrice} - Status: ${level.status}`);
        console.log(`    Approached: ${level.approached}, Tested: ${level.tested}, Holding: ${level.holding}`);
        console.log(`    Elapsed: ${level.elapsed}`);
      });
      console.log();
    }

    // Display GEX levels captured during evaluation
    console.log('💹 GEX LEVELS DETECTED:');
    console.log('-'.repeat(50));
    if (capturedGexLevels.length > 0) {
      capturedGexLevels.forEach(level => {
        const marker = Math.abs(level.price - 24633.68) < 1 ? ' ⭐ TARGET MATCH!' : '';
        console.log(`  ${level.description}: ${level.price.toFixed(2)} (${level.type})${marker}`);
      });
    } else {
      console.log('  No GEX levels captured during evaluation');
    }
    console.log();

    // Performance summary
    console.log('📈 BACKTEST PERFORMANCE:');
    console.log('-'.repeat(50));
    console.log(`  Total Trades: ${results.performance.totalTrades}`);
    console.log(`  Win Rate: ${(results.performance.winRate * 100).toFixed(1)}%`);
    console.log(`  Avg Win: $${results.performance.avgWin.toFixed(2)}`);
    console.log(`  Avg Loss: $${results.performance.avgLoss.toFixed(2)}`);
    console.log(`  Total P&L: $${results.performance.totalPL.toFixed(2)}`);
    console.log(`  Sharpe Ratio: ${results.performance.sharpeRatio.toFixed(2)}`);
    console.log();

    // Display actual trades
    if (results.trades && results.trades.length > 0) {
      console.log('💼 TRADES EXECUTED:');
      console.log('-'.repeat(50));
      results.trades.forEach((trade, idx) => {
        console.log(`  Trade ${idx + 1}: ${trade.side.toUpperCase()} @ ${trade.entryPrice.toFixed(2)}`);
        console.log(`    Entry Time: ${new Date(trade.entryTime).toLocaleString()}`);
        if (trade.metadata && trade.metadata.confluenceZone) {
          console.log(`    Confluence Zone: ${trade.metadata.confluenceZone.centerPrice.toFixed(2)}`);
          console.log(`    Zone Score: ${trade.metadata.confluenceZone.score.toFixed(2)}`);
        }
        if (trade.metadata && trade.metadata.pullbackLevel) {
          console.log(`    Pullback Level: ${trade.metadata.pullbackLevel.price.toFixed(2)} (${trade.metadata.pullbackLevel.source})`);
        }
        console.log(`    P&L: $${trade.realizedPL.toFixed(2)}`);
      });
      console.log();
    }

    // Save detailed results
    const outputPath = path.join('results', `sept30-confluence-${Date.now()}.json`);
    await fs.writeFile(
      outputPath,
      JSON.stringify({
        config,
        results,
        confluenceAnalysis: {
          fibonacciLevels: fibLevels,
          confluenceZones: confluenceZones,
          monitoredLevels: monitoredLevels
        }
      }, null, 2)
    );

    console.log(`✅ Detailed results saved to: ${outputPath}`);

    // Validation summary
    console.log('\n' + '='.repeat(70));
    console.log('🔍 VALIDATION SUMMARY:');
    console.log('='.repeat(70));

    // Check if we found the expected confluence
    const foundTargetConfluence = confluenceZones.some(zone =>
      Math.abs(zone.centerPrice - 24633) < 10
    );

    if (foundTargetConfluence) {
      console.log('✅ Successfully identified confluence zone at 24,633 level');
    } else {
      console.log('⚠️  Did not detect expected confluence at 24,633');
      console.log('   This may require GEX data for Sept 30 to be present');
    }

    // Check fibonacci detection
    const found705Fib = fibLevels.some(level => Math.abs(level.ratio - 0.705) < 0.01);
    if (found705Fib) {
      console.log('✅ Detected 70.5% fibonacci retracement level');
    } else {
      console.log('⚠️  70.5% fibonacci not detected (check swing detection)');
    }

  } catch (error) {
    console.error('❌ Error running backtest:', error);
    console.error(error.stack);
  }
}

// Run the test
testSept30Confluence().catch(console.error);