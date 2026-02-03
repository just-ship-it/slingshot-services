#!/usr/bin/env node
/**
 * Grid Search - Stop Loss and Trailing Stop Optimization (FAST VERSION)
 *
 * Loads data once and runs all parameter combinations efficiently.
 */

import fs from 'fs';
import path from 'path';
import { CSVLoader } from './src/data/csv-loader.js';
import { CandleAggregator } from './src/data/candle-aggregator.js';
import { TradeSimulator } from './src/execution/trade-simulator.js';
import { PerformanceCalculator } from './src/analytics/performance-calculator.js';
import { ContrarianBounceStrategy } from '../shared/strategies/contrarian-bounce.js';
import { GexLoader } from './src/data-loaders/gex-loader.js';

const testPeriod = { name: 'Full 2025', startDate: '2025-01-13', endDate: '2025-12-24' };
const dataDir = 'data';
const initialCapital = 100000;
const commission = 5;

// Parameter ranges to test
const stopBuffers = [10, 12, 15, 18, 20];
const trailingTriggers = [6, 8, 10, 12, 15];
const trailingOffsets = [3, 4, 5, 6, 8];
const maxDistances = [20, 25, 30];
const gexRegimeOptions = [false, true];

// Generate all configurations
function generateConfigs() {
  const configs = [];

  for (const maxDist of maxDistances) {
    for (const stopBuffer of stopBuffers) {
      for (const trailTrigger of trailingTriggers) {
        for (const trailOffset of trailingOffsets) {
          // Skip invalid combinations (offset should be less than trigger)
          if (trailOffset >= trailTrigger) continue;

          for (const requireGex of gexRegimeOptions) {
            configs.push({
              name: `D${maxDist}_S${stopBuffer}_T${trailTrigger}/${trailOffset}${requireGex ? '_+GEX' : ''}`,
              params: {
                tradingSymbol: 'NQ',
                defaultQuantity: 1,
                stopBuffer: stopBuffer,
                maxRisk: 200.0,
                useGexLevelStops: false,
                targetMode: 'gamma_flip',
                useTrailingStop: true,
                trailingTrigger: trailTrigger,
                trailingOffset: trailOffset,
                signalCooldownMs: 0,
                requirePositiveGex: requireGex,
                useTimeFilter: false,
                useSentimentFilter: false,
                useDistanceFilter: true,
                minDistanceBelowFlip: 0,
                maxDistanceBelowFlip: maxDist,
                useIvFilter: false,
                allowLong: true,
                allowShort: false
              }
            });
          }
        }
      }
    }
  }

  return configs;
}

/**
 * Pre-build calendar spread lookup map (this is the expensive operation)
 */
function buildCalendarSpreadLookup(calendarSpreads) {
  const calendarSpreadsByTime = new Map();

  calendarSpreads.forEach(spread => {
    if (!spread.symbol || !spread.symbol.includes('-') || !spread.timestamp) return;

    const timestamp = new Date(spread.timestamp).getTime();

    if (!calendarSpreadsByTime.has(timestamp)) {
      calendarSpreadsByTime.set(timestamp, new Map());
    }

    calendarSpreadsByTime.get(timestamp).set(spread.symbol, spread.close);
  });

  return calendarSpreadsByTime;
}

/**
 * Load all data once
 */
async function loadAllData() {
  console.log('📊 Loading data (this happens only once)...');
  const startTime = Date.now();

  // Load default configuration
  const defaultConfigPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'src/config', 'default.json');
  const defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));

  const csvLoader = new CSVLoader(dataDir, defaultConfig);
  const aggregator = new CandleAggregator();
  const gexLoader = new GexLoader(path.join(dataDir, 'gex'));

  const startDate = new Date(testPeriod.startDate);
  const endDate = new Date(testPeriod.endDate);

  // Load raw OHLCV and liquidity data
  const [ohlcvResult, liquidityData] = await Promise.all([
    csvLoader.loadOHLCVData('NQ', startDate, endDate),
    csvLoader.loadLiquidityData('NQ', startDate, endDate)
  ]);

  // Load GEX data
  await gexLoader.loadDateRange(startDate, endDate);

  // Extract candles and calendar spreads
  const ohlcvData = ohlcvResult.candles;
  const calendarSpreads = ohlcvResult.calendarSpreads;

  // Aggregate candles to 15m for strategy evaluation
  const aggregatedCandles = aggregator.aggregate(ohlcvData, '15m');

  // Create market data lookup
  const liquidityLookup = new Map();
  liquidityData.forEach(lt => {
    const timestamp = new Date(lt.timestamp).getTime();
    liquidityLookup.set(timestamp, lt);
  });

  // Pre-build calendar spread lookup (expensive operation done once)
  console.log('📊 Building calendar spread lookup...');
  const calendarSpreadsByTime = buildCalendarSpreadLookup(calendarSpreads);
  console.log(`✅ Calendar spread lookup built: ${calendarSpreadsByTime.size} time periods`);

  const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Data loaded in ${loadTime}s:`);
  console.log(`   - ${aggregatedCandles.length} 15m candles`);
  console.log(`   - ${ohlcvData.length} 1m candles`);
  console.log(`   - ${gexLoader.sortedTimestamps.length} GEX snapshots`);
  console.log(`   - ${liquidityData.length} liquidity records`);

  return {
    candles: aggregatedCandles,
    originalCandles: ohlcvData,
    gexLoader,
    liquidityLookup,
    calendarSpreadsByTime,  // Pre-built lookup
    defaultConfig
  };
}

/**
 * Get market data for a timestamp
 */
function getMarketDataForTimestamp(timestamp, data) {
  let gexLevels = null;

  if (data.gexLoader && data.gexLoader.sortedTimestamps.length > 0) {
    gexLevels = data.gexLoader.getGexLevels(new Date(timestamp));
  }

  // Find closest liquidity levels
  let liquidityLevels = null;
  const maxTimeDiff = 15 * 60 * 1000;

  for (const [ltTimestamp, ltData] of data.liquidityLookup) {
    const timeDiff = Math.abs(timestamp - ltTimestamp);
    if (timeDiff <= maxTimeDiff) {
      if (!liquidityLevels || timeDiff < Math.abs(timestamp - liquidityLevels.timestamp)) {
        liquidityLevels = ltData;
      }
    }
  }

  return {
    gexLevels,
    ltLevels: liquidityLevels,
    gexLoader: data.gexLoader
  };
}

/**
 * Run a single backtest with preloaded data
 */
function runBacktest(params, data) {
  const strategy = new ContrarianBounceStrategy(params);

  const tradeSimulator = new TradeSimulator({
    commission,
    slippage: data.defaultConfig.backtesting.slippage,
    contractSpecs: data.defaultConfig.contracts,
    forceCloseAtMarketClose: data.defaultConfig.backtesting.forceCloseAtMarketClose,
    marketCloseTimeUTC: data.defaultConfig.backtesting.marketCloseTimeUTC,
    verbose: false,
    debugMode: false
  });

  // Use pre-built calendar spread lookup (skip expensive re-initialization)
  if (data.calendarSpreadsByTime && data.calendarSpreadsByTime.size > 0) {
    tradeSimulator.calendarSpreadsByTime = data.calendarSpreadsByTime;
  }

  const trades = [];
  let currentEquity = initialCapital;
  let prevCandle = null;
  let candleIndex1m = 0;

  for (let i = 0; i < data.candles.length; i++) {
    const candle = data.candles[i];
    const candleStartTime = candle.timestamp - (15 * 60 * 1000 - 60000);

    // Process 1-minute candles for exit monitoring
    while (candleIndex1m < data.originalCandles.length) {
      const candle1m = data.originalCandles[candleIndex1m];

      if (candle1m.timestamp > candle.timestamp) break;

      if (candle1m.timestamp >= candleStartTime) {
        const tradeUpdates = tradeSimulator.updateActiveTrades(candle1m);
        tradeUpdates.forEach(update => {
          if (update.status === 'completed') {
            trades.push(update);
            currentEquity += update.netPnL;
          }
        });
      }

      candleIndex1m++;
    }

    // Generate trading signal
    if (prevCandle) {
      const marketData = getMarketDataForTimestamp(candle.timestamp, data);

      if (marketData.gexLevels) {
        const historicalCandles = data.candles.slice(Math.max(0, i - 49), i + 1);
        const signal = strategy.evaluateSignal(candle, prevCandle, marketData, { historicalCandles });

        if (signal) {
          tradeSimulator.processSignal(signal, candle.timestamp);
        }
      }
    }

    prevCandle = candle;
  }

  // Process remaining 1m candles
  while (candleIndex1m < data.originalCandles.length) {
    const candle1m = data.originalCandles[candleIndex1m];
    const tradeUpdates = tradeSimulator.updateActiveTrades(candle1m);
    tradeUpdates.forEach(update => {
      if (update.status === 'completed') {
        trades.push(update);
        currentEquity += update.netPnL;
      }
    });
    candleIndex1m++;
  }

  // Calculate performance
  const calculator = new PerformanceCalculator(initialCapital, data.defaultConfig.backtesting.riskFreeRate);
  const equityCurve = [{ timestamp: new Date(testPeriod.startDate).getTime(), equity: initialCapital }];
  let runningEquity = initialCapital;
  trades.forEach(t => {
    runningEquity += t.netPnL;
    equityCurve.push({ timestamp: t.exitTime, equity: runningEquity, trade: t });
  });

  const performance = calculator.calculateMetrics(
    trades,
    equityCurve,
    new Date(testPeriod.startDate),
    new Date(testPeriod.endDate)
  );

  return { trades, performance };
}

function analyzeExitReasons(trades) {
  const exits = {};
  for (const trade of trades || []) {
    const reason = trade.exitReason || 'unknown';
    if (!exits[reason]) {
      exits[reason] = { count: 0, pnl: 0 };
    }
    exits[reason].count++;
    exits[reason].pnl += trade.netPnL || 0;
  }
  return exits;
}

async function main() {
  console.log('='.repeat(140));
  console.log('SCALPING STRATEGY - GRID SEARCH OPTIMIZATION (FAST VERSION)');
  console.log('='.repeat(140));

  // Load data once
  const data = await loadAllData();

  const configs = generateConfigs();
  console.log(`\nTesting ${configs.length} configurations...`);
  console.log('Parameters: Max Distance, Stop Buffer, Trailing Trigger/Offset, GEX Regime Filter\n');

  const allResults = [];
  const startTime = Date.now();

  // Run all backtests
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const configStartTime = Date.now();
    const results = runBacktest(config.params, data);
    const configTime = ((Date.now() - configStartTime) / 1000).toFixed(1);

    if ((i + 1) % 10 === 0 || i === configs.length - 1 || i < 5) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = elapsed > 0 ? ((i + 1) / elapsed).toFixed(2) : 'N/A';
      const eta = elapsed > 0 ? ((configs.length - i - 1) / ((i + 1) / elapsed) / 60).toFixed(1) : 'N/A';
      console.log(`[${i + 1}/${configs.length}] ${config.name} - ${configTime}s | Total: ${elapsed}s | Rate: ${rate}/s | ETA: ${eta}min`);
    }

    if (results && results.performance) {
      const perf = results.performance.summary || {};
      const exits = analyzeExitReasons(results.trades);

      allResults.push({
        name: config.name,
        params: config.params,
        trades: perf.totalTrades || 0,
        winRate: perf.winRate || 0,
        totalPnL: perf.totalPnL || 0,
        avgPnL: perf.totalTrades > 0 ? (perf.totalPnL || 0) / perf.totalTrades : 0,
        maxDrawdown: perf.maxDrawdown || 0,
        profitFactor: perf.profitFactor || 0,
        exitReasons: exits
      });
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Grid search completed in ${totalTime}s (${(configs.length / totalTime).toFixed(1)} configs/sec)`);

  // Sort by total P&L
  allResults.sort((a, b) => b.totalPnL - a.totalPnL);

  // Print top 30 results
  console.log('\n' + '='.repeat(140));
  console.log('TOP 30 CONFIGURATIONS BY TOTAL P&L');
  console.log('='.repeat(140));
  console.log('\nRank | Configuration                    | Trades | Win%  |    Total P&L |  Avg P&L | MaxDD% | Trail P&L | Stop P&L');
  console.log('-'.repeat(140));

  for (let i = 0; i < Math.min(30, allResults.length); i++) {
    const r = allResults[i];
    const trailPnL = r.exitReasons.trailing_stop?.pnl || 0;
    const stopPnL = r.exitReasons.stop_loss?.pnl || 0;

    console.log(
      `${String(i + 1).padStart(4)} | ${r.name.padEnd(32)} | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(5)}% | $${r.totalPnL.toFixed(0).padStart(11)} | $${r.avgPnL.toFixed(0).padStart(7)} | ${r.maxDrawdown.toFixed(1).padStart(5)}% | $${trailPnL.toFixed(0).padStart(8)} | $${stopPnL.toFixed(0).padStart(8)}`
    );
  }

  // Group by GEX filter and show best of each
  console.log('\n' + '='.repeat(140));
  console.log('BEST CONFIGURATIONS - WITH vs WITHOUT GEX REGIME FILTER');
  console.log('='.repeat(140));

  const withGex = allResults.filter(r => r.params.requirePositiveGex).slice(0, 10);
  const withoutGex = allResults.filter(r => !r.params.requirePositiveGex).slice(0, 10);

  console.log('\n--- WITHOUT GEX FILTER (More Trades) ---');
  console.log('Rank | Configuration                    | Trades | Win%  |    Total P&L |  Avg P&L | MaxDD%');
  console.log('-'.repeat(100));
  for (let i = 0; i < withoutGex.length; i++) {
    const r = withoutGex[i];
    console.log(
      `${String(i + 1).padStart(4)} | ${r.name.padEnd(32)} | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(5)}% | $${r.totalPnL.toFixed(0).padStart(11)} | $${r.avgPnL.toFixed(0).padStart(7)} | ${r.maxDrawdown.toFixed(1).padStart(5)}%`
    );
  }

  console.log('\n--- WITH GEX FILTER (Fewer Trades, Potentially Higher Quality) ---');
  console.log('Rank | Configuration                    | Trades | Win%  |    Total P&L |  Avg P&L | MaxDD%');
  console.log('-'.repeat(100));
  for (let i = 0; i < withGex.length; i++) {
    const r = withGex[i];
    console.log(
      `${String(i + 1).padStart(4)} | ${r.name.padEnd(32)} | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(5)}% | $${r.totalPnL.toFixed(0).padStart(11)} | $${r.avgPnL.toFixed(0).padStart(7)} | ${r.maxDrawdown.toFixed(1).padStart(5)}%`
    );
  }

  // Analyze by parameter
  console.log('\n' + '='.repeat(140));
  console.log('PARAMETER SENSITIVITY ANALYSIS');
  console.log('='.repeat(140));

  // Best by stop buffer
  console.log('\n--- By Stop Buffer ---');
  for (const stop of stopBuffers) {
    const filtered = allResults.filter(r => r.params.stopBuffer === stop);
    const avgPnL = filtered.reduce((sum, r) => sum + r.totalPnL, 0) / filtered.length;
    const best = filtered[0];
    console.log(`Stop ${stop}pt: Avg P&L across configs: $${avgPnL.toFixed(0).padStart(8)} | Best: ${best?.name} ($${best?.totalPnL.toFixed(0)})`);
  }

  // Best by trailing trigger
  console.log('\n--- By Trailing Trigger ---');
  for (const trigger of trailingTriggers) {
    const filtered = allResults.filter(r => r.params.trailingTrigger === trigger);
    const avgPnL = filtered.reduce((sum, r) => sum + r.totalPnL, 0) / filtered.length;
    const best = filtered[0];
    console.log(`Trigger ${trigger}pt: Avg P&L across configs: $${avgPnL.toFixed(0).padStart(8)} | Best: ${best?.name} ($${best?.totalPnL.toFixed(0)})`);
  }

  // Best by trailing offset
  console.log('\n--- By Trailing Offset ---');
  for (const offset of trailingOffsets) {
    const filtered = allResults.filter(r => r.params.trailingOffset === offset);
    if (filtered.length === 0) continue;
    const avgPnL = filtered.reduce((sum, r) => sum + r.totalPnL, 0) / filtered.length;
    const best = filtered[0];
    console.log(`Offset ${offset}pt: Avg P&L across configs: $${avgPnL.toFixed(0).padStart(8)} | Best: ${best?.name} ($${best?.totalPnL.toFixed(0)})`);
  }

  // Best by max distance
  console.log('\n--- By Max Distance ---');
  for (const dist of maxDistances) {
    const filtered = allResults.filter(r => r.params.maxDistanceBelowFlip === dist);
    const avgPnL = filtered.reduce((sum, r) => sum + r.totalPnL, 0) / filtered.length;
    const best = filtered[0];
    console.log(`MaxDist ${dist}pt: Avg P&L across configs: $${avgPnL.toFixed(0).padStart(8)} | Best: ${best?.name} ($${best?.totalPnL.toFixed(0)})`);
  }

  // Risk-adjusted analysis (P&L per unit drawdown)
  console.log('\n' + '='.repeat(140));
  console.log('TOP 15 BY RISK-ADJUSTED RETURN (P&L / MaxDrawdown)');
  console.log('='.repeat(140));

  const riskAdjusted = allResults
    .filter(r => r.totalPnL > 0 && r.maxDrawdown > 0)
    .map(r => ({ ...r, riskAdj: r.totalPnL / r.maxDrawdown }))
    .sort((a, b) => b.riskAdj - a.riskAdj)
    .slice(0, 15);

  console.log('\nRank | Configuration                    | Trades | Win%  |    Total P&L | MaxDD% | Risk-Adj');
  console.log('-'.repeat(110));
  for (let i = 0; i < riskAdjusted.length; i++) {
    const r = riskAdjusted[i];
    console.log(
      `${String(i + 1).padStart(4)} | ${r.name.padEnd(32)} | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(5)}% | $${r.totalPnL.toFixed(0).padStart(11)} | ${r.maxDrawdown.toFixed(1).padStart(5)}% | ${r.riskAdj.toFixed(2).padStart(8)}`
    );
  }

  // Ensure results directory exists
  if (!fs.existsSync('./results')) {
    fs.mkdirSync('./results', { recursive: true });
  }

  // Save full results
  const outputPath = './results/scalp-grid-search.json';
  fs.writeFileSync(outputPath, JSON.stringify({
    testDate: new Date().toISOString(),
    period: testPeriod,
    totalConfigs: configs.length,
    executionTimeSec: parseFloat(totalTime),
    results: allResults
  }, null, 2));
  console.log(`\nFull results saved to: ${outputPath}`);

  // Print recommended configuration
  console.log('\n' + '='.repeat(140));
  console.log('RECOMMENDED CONFIGURATIONS');
  console.log('='.repeat(140));

  const bestOverall = allResults[0];
  const bestWithGex = withGex[0];
  const bestRiskAdj = riskAdjusted[0];

  console.log('\n1. HIGHEST P&L:');
  console.log(`   ${bestOverall.name}`);
  console.log(`   Trades: ${bestOverall.trades} | Win: ${bestOverall.winRate.toFixed(1)}% | P&L: $${bestOverall.totalPnL.toFixed(0)} | MaxDD: ${bestOverall.maxDrawdown.toFixed(1)}%`);

  if (bestWithGex) {
    console.log('\n2. HIGHEST P&L WITH GEX FILTER:');
    console.log(`   ${bestWithGex.name}`);
    console.log(`   Trades: ${bestWithGex.trades} | Win: ${bestWithGex.winRate.toFixed(1)}% | P&L: $${bestWithGex.totalPnL.toFixed(0)} | MaxDD: ${bestWithGex.maxDrawdown.toFixed(1)}%`);
  }

  if (bestRiskAdj) {
    console.log('\n3. BEST RISK-ADJUSTED:');
    console.log(`   ${bestRiskAdj.name}`);
    console.log(`   Trades: ${bestRiskAdj.trades} | Win: ${bestRiskAdj.winRate.toFixed(1)}% | P&L: $${bestRiskAdj.totalPnL.toFixed(0)} | MaxDD: ${bestRiskAdj.maxDrawdown.toFixed(1)}%`);
  }
}

main().catch(console.error);
