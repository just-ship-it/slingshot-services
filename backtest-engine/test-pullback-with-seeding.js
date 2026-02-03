#!/usr/bin/env node

/**
 * Test Pullback Strategy with Proper Data Seeding
 *
 * Seeds the strategy with enough historical data for 13/13 swing detection
 * before the actual backtest period begins
 */

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs/promises';
import path from 'path';

async function testPullbackWithSeeding() {
  console.log('🔧 Testing Pullback Strategy with Proper Data Seeding');
  console.log('=' .repeat(60));
  console.log();

  // Calculate seeding requirements for rolling window approach
  const windowLength = 100;  // Rolling window length like Pine script
  const minCandlesNeeded = windowLength;  // Need 100 candles minimum
  // Need to seed with enough data to capture multi-day swings (Sept 26 to Sept 29)
  // The low is on Sept 26 and high on Sept 29, so we need ~5 days of data
  const seedingCandles = 480;  // 5 days of 15m data to capture Sept 26 low

  console.log('📊 Seeding Requirements:');
  console.log(`   Rolling Window: ${windowLength} candles (needs ${minCandlesNeeded} candles minimum)`);
  console.log(`   Seeding Period: ${seedingCandles} candles (${(seedingCandles * 15 / 60).toFixed(1)} hours)`);
  console.log();

  // Actual test period
  const actualStartDate = new Date('2025-10-01T00:00:00Z');
  const actualEndDate = new Date('2025-10-02T00:00:00Z');

  // Calculate seeding start date (50 * 15 minutes = 750 minutes before)
  const seedingStartDate = new Date(actualStartDate.getTime() - (seedingCandles * 15 * 60 * 1000));

  const config = {
    ticker: 'NQ',
    startDate: seedingStartDate,  // Start earlier for seeding
    endDate: actualEndDate,
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

  console.log(`📅 Seeding Period: ${seedingStartDate.toISOString()} to ${actualStartDate.toISOString()}`);
  console.log(`📅 Test Period: ${actualStartDate.toISOString()} to ${actualEndDate.toISOString()}`);
  console.log('🎯 Strategy: GEX-LDPM Confluence with Pullback System');
  console.log();

  try {
    const engine = new BacktestEngine(config);

    // Load all data including seeding period
    const data = await engine.loadData();
    console.log(`✅ Loaded ${data.candles.length} total candles (including seeding period)`);

    // Separate seeding candles from test candles
    const seedingEndTime = actualStartDate.getTime();
    const seedingCandlesData = data.candles.filter(c => c.timestamp < seedingEndTime);
    const testCandles = data.candles.filter(c => c.timestamp >= seedingEndTime);

    console.log(`   📊 Seeding candles: ${seedingCandlesData.length}`);
    console.log(`   📊 Test candles: ${testCandles.length}`);
    console.log();

    // Initialize strategy with seeding data
    const strategy = engine.strategy;

    // Pre-process seeding candles to initialize indicators
    console.log('🌱 Seeding indicators with historical data...');
    seedingCandlesData.forEach((candle, index) => {
      if (!strategy.candleHistory) {
        strategy.candleHistory = [];
      }
      strategy.candleHistory.push(candle);
    });

    // Process all seeding candles through level detectors
    if (strategy.candleHistory.length >= 100) {  // Rolling window requires 100 candles
      strategy.structuralLevels.processCandles(strategy.candleHistory);
      strategy.sessionLevels.processCandles(strategy.candleHistory);
      strategy.fibonacciLevels.processCandles(strategy.candleHistory);

      console.log('✅ Indicators initialized with seeding data');
      console.log(`   Structural levels: ${strategy.structuralLevels.getActiveLevels().length}`);
      console.log(`   Session levels: ${strategy.sessionLevels.getActiveLevels().length}`);
      console.log(`   Fibonacci levels: ${strategy.fibonacciLevels.getActiveLevels().length}`);

      // Check fibonacci swings directly
      const fibSwings = strategy.fibonacciLevels.recentSwings || [];
      console.log(`   Fibonacci swings stored: ${fibSwings.length}`);
      if (fibSwings.length > 0) {
        const firstSwing = fibSwings[0];
        if (firstSwing.start && firstSwing.end) {
          const swingHigh = Math.max(firstSwing.start.price, firstSwing.end.price);
          const swingLow = Math.min(firstSwing.start.price, firstSwing.end.price);
          console.log(`   First swing: High=$${swingHigh.toFixed(2)}, Low=$${swingLow.toFixed(2)}, Size=${firstSwing.size.toFixed(1)} pts`);
        }
      }
    }
    console.log();

    // Override to capture pullback levels in signals
    const originalAddPending = strategy.addPendingSignalSync;
    let signalCount = 0;
    const allSignals = [];  // Store all signals with their levels

    strategy.addPendingSignalSync = function(signal, candle) {
      signalCount++;
      const pullbackLevels = this.identifyPullbackLevels(signal, candle.close);

      // Get fibonacci swings used for calculations
      const fibSwings = this.fibonacciLevels.recentSwings || [];

      // Debug: log swings if signal has fib levels
      const fibLevels = pullbackLevels.filter(l => l.source === 'fibonacci');
      if (fibLevels.length > 0 && signalCount <= 3) {
        console.log(`   Debug - Available swings: ${fibSwings.length}`);
        if (fibSwings.length > 0) {
          console.log(`   First swing:`, fibSwings[0]);
        }
      }

      // Map fibonacci levels to include their source swing
      const enrichedPullbackLevels = pullbackLevels.map(level => {
        const levelData = {
          price: level.price,
          source: level.source,
          type: level.type,
          description: level.description,
          weight: level.weight,
          distance: Math.abs(level.price - candle.close)
        };

        // If it's a fibonacci level, try to find the source swing
        if (level.source === 'fibonacci' && fibSwings.length > 0) {
          // Find the swing that would generate this level
          // Fibonacci levels are typically calculated from the most recent swing
          const mostRecentSwing = fibSwings[0];
          if (mostRecentSwing) {
            levelData.swingHigh = mostRecentSwing.high || 0;
            levelData.swingLow = mostRecentSwing.low || 0;
            levelData.swingDirection = mostRecentSwing.direction;
            levelData.swingSize = mostRecentSwing.size;
          }
        }

        return levelData;
      });

      // Store signal with levels and fibonacci swings
      allSignals.push({
        timestamp: new Date(candle.timestamp).toISOString(),
        side: signal.side,
        price: signal.price,
        confluenceZone: signal.confluenceZone?.center,
        pullbackLevels: enrichedPullbackLevels,
        fibonacciSwings: fibSwings.map(swing => {
          return {
            high: swing.high || 0,  // Use direct high/low from rolling window
            low: swing.low || 0,
            direction: swing.direction,
            size: swing.size,
            timestamp: swing.timestamp ? new Date(swing.timestamp).toISOString() : null
          };
        })
      });

      // Only display first 3 signals for clarity
      if (signalCount <= 3) {

        console.log(`\n📊 Signal ${signalCount} at ${new Date(candle.timestamp).toISOString()}`);
        console.log(`   Side: ${signal.side.toUpperCase()}`);
        console.log(`   Price: $${signal.price}`);
        console.log(`   Confluence Zone: $${signal.confluenceZone?.center || 'N/A'}`);

        console.log(`\n   🎯 Detected Pullback Levels (${enrichedPullbackLevels.length} total):`);

        if (enrichedPullbackLevels.length > 0) {
          // Group by source
          const levelsBySource = {
            structural: enrichedPullbackLevels.filter(l => l.source === 'structural'),
            session: enrichedPullbackLevels.filter(l => l.source === 'session'),
            fibonacci: enrichedPullbackLevels.filter(l => l.source === 'fibonacci')
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
              let levelStr = `     - $${level.price.toFixed(2)} (${level.description || level.type}`;
              if (level.weight !== undefined) {
                levelStr += `, weight: ${level.weight.toFixed(1)}`;
              }
              // Add swing info if present
              if (level.swingHigh && level.swingLow) {
                levelStr += `, from swing H:${level.swingHigh.toFixed(2)} L:${level.swingLow.toFixed(2)}`;
              }
              levelStr += ')';
              console.log(levelStr);
            });

            // Display fibonacci swings
            if (fibSwings.length > 0) {
              console.log('   Fibonacci Swings (used for calculations):');
              fibSwings.slice(0, 3).forEach((swing, idx) => {
                console.log(`     Swing ${idx + 1}: High=$${(swing.high || 0).toFixed(2)}, Low=$${(swing.low || 0).toFixed(2)}, Direction=${swing.direction}, Size=${swing.size.toFixed(1)} pts`);
              });
            }
          }
        } else {
          console.log('   ❌ No pullback levels detected');
        }
      }

      // Add levels to signal for JSON output
      signal.pullbackLevels = enrichedPullbackLevels;
      signal.fibonacciSwings = fibSwings;

      return originalAddPending.call(this, signal, candle);
    };

    // Run the actual backtest
    console.log('\n' + '='.repeat(60));
    console.log('🎯 Running backtest on test period...');
    console.log('='.repeat(60));

    // Modify data to only include test period for results
    const testData = {
      ...data,
      candles: testCandles
    };

    const results = await engine.runSimulation(testData);

    console.log('\n' + '='.repeat(60));
    console.log('📈 BACKTEST COMPLETE');
    console.log('='.repeat(60));

    console.log(`\nTotal Signals Generated: ${signalCount}`);
    console.log(`Trades Executed: ${results.trades.length}`);

    // Output results to JSON
    const outputData = {
      config: {
        ticker: config.ticker,
        seedingPeriod: `${seedingStartDate.toISOString()} to ${actualStartDate.toISOString()}`,
        testPeriod: `${actualStartDate.toISOString()} to ${actualEndDate.toISOString()}`,
        seedingCandles: seedingCandlesData.length,
        testCandles: testCandles.length,
        strategy: config.strategy
      },
      summary: {
        totalSignals: signalCount,
        tradesExecuted: results.trades.length
      },
      signals: allSignals,  // Include all signals with their pullback levels
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
        pullbackLevels: trade.pullbackLevels || [],
        indicators: {
          gexRegime: trade.gexRegime,
          confluenceZone: trade.confluenceZone,
          volumeRatio: trade.volumeRatio
        }
      }))
    };

    // Write to JSON file
    const outputPath = path.join(process.cwd(), 'results', 'pullback-with-seeding.json');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(outputData, null, 2));

    console.log(`\n✅ Results saved to: ${outputPath}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  }
}

testPullbackWithSeeding().catch(console.error);