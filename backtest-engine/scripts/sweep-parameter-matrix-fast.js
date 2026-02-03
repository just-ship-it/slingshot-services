#!/usr/bin/env node

/**
 * OPTIMIZED Sweep Strategy Parameter Matrix Testing
 *
 * Loads data ONCE and reuses for all parameter combinations.
 * Tests various target/stop combinations to find profitable configurations.
 */

import { BacktestEngine } from '../src/backtest-engine.js';
import { GexLevelSweepStrategy } from '../../shared/strategies/gex-level-sweep.js';
import { TradeSimulator } from '../src/execution/trade-simulator.js';
import { PerformanceCalculator } from '../src/analytics/performance-calculator.js';
import { LTLevelAnalyzer } from '../src/analytics/lt-level-analyzer.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const BASE_CONFIG = {
  ticker: 'NQ',
  startDate: new Date('2024-01-01'),
  endDate: new Date('2024-12-31'),
  timeframe: '1m',
  strategy: 'gex-sweep',
  dataDir: join(__dirname, '..', 'data'),
  initialCapital: 100000,
  commission: 5,
  quiet: true,
  strategyParams: {
    requireVolumeSpike: true,
    volumeZThreshold: 2.0,
    rangeZThreshold: 1.5,
    wickRatio: 0.6,
    levelTolerance: 5,
    useSessionFilter: true,
    allowedSessions: ['premarket', 'overnight']
  }
};

// Parameter combinations to test
const TARGET_POINTS = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15];
const STOP_POINTS = [3, 4, 5, 6, 7, 8, 10, 12, 15];

async function runParameterMatrix() {
  console.log('\n========================================');
  console.log('   GEX Level Sweep Parameter Matrix');
  console.log('   (OPTIMIZED - Single Data Load)');
  console.log('========================================\n');
  console.log(`Period: ${BASE_CONFIG.startDate.toISOString().split('T')[0]} to ${BASE_CONFIG.endDate.toISOString().split('T')[0]}`);
  console.log(`Timeframe: ${BASE_CONFIG.timeframe}`);
  console.log(`Volume Spike: Required (z >= ${BASE_CONFIG.strategyParams.volumeZThreshold})`);
  console.log(`Sessions: ${BASE_CONFIG.strategyParams.allowedSessions.join(', ')}`);
  console.log('\nLoading data (one time)...\n');

  // Create engine and load data ONCE
  const engine = new BacktestEngine({
    ...BASE_CONFIG,
    strategyParams: {
      ...BASE_CONFIG.strategyParams,
      targetPoints: 3,  // Default values for initial load
      stopPoints: 5
    }
  });

  // Load default config for trade simulator
  const defaultConfigPath = path.join(__dirname, '..', 'src', 'config', 'default.json');
  const defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));

  // Load data once
  engine.validateConfiguration();
  const data = await engine.loadData();

  console.log(`\n✅ Data loaded: ${data.candles.length} candles, ${data.gexLevels.length} GEX snapshots`);
  console.log('\nTesting combinations...\n');

  const results = [];
  const totalCombos = TARGET_POINTS.length * STOP_POINTS.length;
  let completed = 0;

  for (const target of TARGET_POINTS) {
    for (const stop of STOP_POINTS) {
      try {
        // Create fresh strategy with new params
        const strategy = new GexLevelSweepStrategy({
          ...BASE_CONFIG.strategyParams,
          targetPoints: target,
          stopPoints: stop
        });

        // Create fresh trade simulator
        const tradeSimulator = new TradeSimulator({
          commission: BASE_CONFIG.commission,
          slippage: defaultConfig.backtesting.slippage,
          contractSpecs: defaultConfig.contracts,
          forceCloseAtMarketClose: defaultConfig.backtesting.forceCloseAtMarketClose,
          marketCloseTimeUTC: defaultConfig.backtesting.marketCloseTimeUTC,
          verbose: false,
          debugMode: false
        });

        // Initialize calendar spreads if available
        if (data.calendarSpreads && data.calendarSpreads.length > 0) {
          tradeSimulator.initializeCalendarSpreads(data.calendarSpreads);
        }

        // Run simulation with this strategy
        const simulation = await runSimulationWithStrategy(engine, data, strategy, tradeSimulator);

        // Calculate performance
        const performanceCalculator = new PerformanceCalculator(
          BASE_CONFIG.initialCapital,
          defaultConfig.backtesting.riskFreeRate
        );
        const perf = performanceCalculator.calculate(simulation.trades, simulation.equityCurve);

        const rrRatio = target / stop;
        const breakeven = stop / (target + stop);

        results.push({
          target,
          stop,
          rrRatio: rrRatio.toFixed(2),
          breakevenWR: (breakeven * 100).toFixed(1),
          trades: simulation.trades.length,
          winRate: perf.winRate?.toFixed(1) || '0.0',
          profitFactor: perf.profitFactor?.toFixed(2) || '0.00',
          expectancy: perf.expectancy?.toFixed(2) || '0.00',
          totalPnL: perf.totalPnL?.toFixed(0) || '0',
          maxDD: (perf.maxDrawdown * 100)?.toFixed(1) || '0.0',
          profitable: perf.totalPnL > 0
        });

        completed++;
        process.stdout.write(`\r  Progress: ${completed}/${totalCombos} (${((completed/totalCombos)*100).toFixed(0)}%)`);

      } catch (error) {
        console.error(`\nError testing target=${target}, stop=${stop}: ${error.message}`);
        completed++;
      }
    }
  }

  displayResults(results);
  return results;
}

/**
 * Run simulation with a specific strategy (without reloading data)
 */
async function runSimulationWithStrategy(engine, data, strategy, tradeSimulator) {
  const signals = [];
  const trades = [];
  const equityCurve = [{ timestamp: BASE_CONFIG.startDate.getTime(), equity: BASE_CONFIG.initialCapital }];

  let currentEquity = BASE_CONFIG.initialCapital;
  let prevCandle = null;

  // Process each candle
  for (let i = 0; i < data.candles.length; i++) {
    const candle = data.candles[i];

    // Update trade simulator with candle for exit checks
    const exitResults = tradeSimulator.processCandle(candle, engine.secondDataProvider);
    for (const exit of exitResults) {
      const trade = exit.trade;
      currentEquity += trade.pnl - (trade.commission || 0);
      equityCurve.push({ timestamp: candle.timestamp, equity: currentEquity });
      trades.push(trade);
    }

    // Get GEX levels for this candle
    const gexData = engine.gexLoader.getLevelsAt(candle.timestamp);

    // Get LT levels for this candle
    const ltLevels = data.liquidityLevels.filter(lt =>
      lt.datetime <= candle.timestamp
    ).pop();

    // Get IV data if available
    const ivData = data.ivLoader ? data.ivLoader.getIVAt(candle.timestamp) : null;

    // Evaluate strategy
    const signal = strategy.evaluate({
      candle,
      prevCandle,
      gexData,
      ltLevels,
      ivData
    });

    if (signal) {
      signals.push(signal);
      const entryResult = tradeSimulator.processSignal(signal, candle, engine.secondDataProvider);
      if (entryResult && entryResult.trade) {
        // Entry executed
      }
    }

    prevCandle = candle;
  }

  // Force close any remaining positions at end
  const closedTrades = tradeSimulator.forceCloseAllPositions(
    data.candles[data.candles.length - 1],
    'End of backtest'
  );
  for (const trade of closedTrades) {
    currentEquity += trade.pnl - (trade.commission || 0);
    equityCurve.push({ timestamp: trade.exitTime, equity: currentEquity });
    trades.push(trade);
  }

  return { signals, trades, equityCurve };
}

function displayResults(results) {
  console.log('\n\n========================================');
  console.log('   RESULTS MATRIX');
  console.log('========================================\n');

  // Sort by profitability (total P&L descending)
  results.sort((a, b) => parseFloat(b.totalPnL) - parseFloat(a.totalPnL));

  // Show all results in a table
  console.log('Target  Stop   R:R    BE%    Trades  WinRate  PF      Expect   Total P&L   MaxDD');
  console.log('------  ----   ----   ----   ------  -------  ------  -------  ---------   -----');

  for (const r of results) {
    const pnlStr = r.profitable ? `+$${r.totalPnL}` : `$${r.totalPnL}`;
    const marker = r.profitable ? '✅' : '  ';
    console.log(
      `${marker} ${String(r.target).padStart(4)}pt  ${String(r.stop).padStart(3)}pt  ` +
      `${r.rrRatio.padStart(4)}   ${r.breakevenWR.padStart(4)}%  ` +
      `${String(r.trades).padStart(6)}  ${r.winRate.padStart(6)}%  ` +
      `${r.profitFactor.padStart(6)}  ${r.expectancy.padStart(7)}  ` +
      `${pnlStr.padStart(9)}   ${r.maxDD.padStart(5)}%`
    );
  }

  // Summary statistics
  const profitable = results.filter(r => r.profitable);
  const bestByPnL = results[0];
  const bestByPF = results.reduce((best, r) =>
    parseFloat(r.profitFactor) > parseFloat(best.profitFactor) ? r : best
  );
  const bestByWinRate = results.reduce((best, r) =>
    parseFloat(r.winRate) > parseFloat(best.winRate) ? r : best
  );

  console.log('\n========================================');
  console.log('   SUMMARY');
  console.log('========================================\n');

  console.log(`Total combinations tested: ${results.length}`);
  console.log(`Profitable combinations: ${profitable.length} (${((profitable.length/results.length)*100).toFixed(1)}%)`);

  if (profitable.length > 0) {
    console.log('\n📈 PROFITABLE CONFIGURATIONS:');
    console.log('─────────────────────────────');
    for (const r of profitable) {
      console.log(`  Target: ${r.target}pt | Stop: ${r.stop}pt | R:R: ${r.rrRatio} | Win Rate: ${r.winRate}% | P&L: +$${r.totalPnL}`);
    }
  }

  console.log('\n🏆 BEST BY TOTAL P&L:');
  console.log(`  Target: ${bestByPnL.target}pt | Stop: ${bestByPnL.stop}pt | P&L: $${bestByPnL.totalPnL} | WR: ${bestByPnL.winRate}%`);

  console.log('\n🎯 BEST BY PROFIT FACTOR:');
  console.log(`  Target: ${bestByPF.target}pt | Stop: ${bestByPF.stop}pt | PF: ${bestByPF.profitFactor} | WR: ${bestByPF.winRate}%`);

  console.log('\n📊 BEST BY WIN RATE:');
  console.log(`  Target: ${bestByWinRate.target}pt | Stop: ${bestByWinRate.stop}pt | WR: ${bestByWinRate.winRate}% | P&L: $${bestByWinRate.totalPnL}`);

  // R:R analysis
  console.log('\n📉 R:R RATIO ANALYSIS:');
  console.log('─────────────────────────────');
  const rrGroups = {};
  for (const r of results) {
    const rr = r.rrRatio;
    if (!rrGroups[rr]) rrGroups[rr] = [];
    rrGroups[rr].push(r);
  }

  for (const rr of Object.keys(rrGroups).sort((a, b) => parseFloat(b) - parseFloat(a))) {
    const group = rrGroups[rr];
    const avgPnL = group.reduce((sum, r) => sum + parseFloat(r.totalPnL), 0) / group.length;
    const avgWR = group.reduce((sum, r) => sum + parseFloat(r.winRate), 0) / group.length;
    const profitableCount = group.filter(r => r.profitable).length;
    console.log(`  R:R ${rr}: Avg P&L: $${avgPnL.toFixed(0)} | Avg WR: ${avgWR.toFixed(1)}% | Profitable: ${profitableCount}/${group.length}`);
  }

  console.log('\n========================================\n');
}

// Run the matrix
runParameterMatrix().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
