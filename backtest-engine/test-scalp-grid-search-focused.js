#!/usr/bin/env node
/**
 * Focused Grid Search - Based on Best Results from Initial Tests
 *
 * Best performers:
 * - Scalp v6: 30pt dist, 15pt stop, trail 8/4 → $13,040 (632 trades, 79% WR)
 * - Scalp v2: 15pt dist, 12pt stop, trail 8/4 → $7,705 (402 trades, 79.3% WR)
 *
 * This search focuses on variations around these optimal parameters.
 */

import fs from 'fs';
import path from 'path';
import { CSVLoader } from './src/data/csv-loader.js';
import { CandleAggregator } from '../shared/utils/candle-aggregator.js';
import { TradeSimulator } from './src/execution/trade-simulator.js';
import { PerformanceCalculator } from './src/analytics/performance-calculator.js';
import { ContrarianBounceStrategy } from '../shared/strategies/contrarian-bounce.js';
import { GexLoader } from './src/data-loaders/gex-loader.js';

const testPeriod = { name: 'Full 2025', startDate: '2025-01-13', endDate: '2025-12-24' };
const dataDir = 'data';
const initialCapital = 100000;
const commission = 5;

// Focused parameter ranges (based on best performers)
// Reduced to ~144 configs for faster completion (~35 min)
const stopBuffers = [12, 15, 18];
const trailingTriggers = [6, 8, 10];
const trailingOffsets = [3, 4, 5];
const maxDistances = [20, 25, 30, 35];
const gexRegimeOptions = [false, true];

function generateConfigs() {
  const configs = [];

  for (const maxDist of maxDistances) {
    for (const stopBuffer of stopBuffers) {
      for (const trailTrigger of trailingTriggers) {
        for (const trailOffset of trailingOffsets) {
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

async function loadAllData() {
  console.log('📊 Loading data...');
  const startTime = Date.now();

  const defaultConfigPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'src/config', 'default.json');
  const defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));

  const csvLoader = new CSVLoader(dataDir, defaultConfig);
  const aggregator = new CandleAggregator();
  const gexLoader = new GexLoader(path.join(dataDir, 'gex'));

  const startDate = new Date(testPeriod.startDate);
  const endDate = new Date(testPeriod.endDate);

  const [ohlcvResult, liquidityData] = await Promise.all([
    csvLoader.loadOHLCVData('NQ', startDate, endDate),
    csvLoader.loadLiquidityData('NQ', startDate, endDate)
  ]);

  await gexLoader.loadDateRange(startDate, endDate);

  const ohlcvData = ohlcvResult.candles;
  const calendarSpreads = ohlcvResult.calendarSpreads;
  const aggregatedCandles = aggregator.aggregate(ohlcvData, '15m');

  const liquidityLookup = new Map();
  liquidityData.forEach(lt => {
    liquidityLookup.set(new Date(lt.timestamp).getTime(), lt);
  });

  const calendarSpreadsByTime = buildCalendarSpreadLookup(calendarSpreads);

  const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Data loaded in ${loadTime}s: ${aggregatedCandles.length} 15m candles, ${ohlcvData.length} 1m candles`);

  return { candles: aggregatedCandles, originalCandles: ohlcvData, gexLoader, liquidityLookup, calendarSpreadsByTime, defaultConfig };
}

function getMarketDataForTimestamp(timestamp, data) {
  let gexLevels = data.gexLoader?.sortedTimestamps?.length > 0 ? data.gexLoader.getGexLevels(new Date(timestamp)) : null;

  let liquidityLevels = null;
  const maxTimeDiff = 15 * 60 * 1000;
  for (const [ltTimestamp, ltData] of data.liquidityLookup) {
    const timeDiff = Math.abs(timestamp - ltTimestamp);
    if (timeDiff <= maxTimeDiff && (!liquidityLevels || timeDiff < Math.abs(timestamp - liquidityLevels.timestamp))) {
      liquidityLevels = ltData;
    }
  }

  return { gexLevels, ltLevels: liquidityLevels, gexLoader: data.gexLoader };
}

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

  if (data.calendarSpreadsByTime?.size > 0) {
    tradeSimulator.calendarSpreadsByTime = data.calendarSpreadsByTime;
  }

  const trades = [];
  let currentEquity = initialCapital;
  let prevCandle = null;
  let candleIndex1m = 0;

  for (let i = 0; i < data.candles.length; i++) {
    const candle = data.candles[i];
    const candleStartTime = candle.timestamp - (15 * 60 * 1000 - 60000);

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

  const calculator = new PerformanceCalculator(initialCapital, data.defaultConfig.backtesting.riskFreeRate);
  const equityCurve = [{ timestamp: new Date(testPeriod.startDate).getTime(), equity: initialCapital }];
  let runningEquity = initialCapital;
  trades.forEach(t => {
    runningEquity += t.netPnL;
    equityCurve.push({ timestamp: t.exitTime, equity: runningEquity, trade: t });
  });

  const performance = calculator.calculateMetrics(trades, equityCurve, new Date(testPeriod.startDate), new Date(testPeriod.endDate));
  return { trades, performance };
}

function analyzeExitReasons(trades) {
  const exits = {};
  for (const trade of trades || []) {
    const reason = trade.exitReason || 'unknown';
    if (!exits[reason]) exits[reason] = { count: 0, pnl: 0 };
    exits[reason].count++;
    exits[reason].pnl += trade.netPnL || 0;
  }
  return exits;
}

async function main() {
  console.log('='.repeat(140));
  console.log('FOCUSED GRID SEARCH - SCALPING STRATEGY OPTIMIZATION');
  console.log('='.repeat(140));

  const data = await loadAllData();
  const configs = generateConfigs();
  console.log(`\nTesting ${configs.length} configurations...\n`);

  const allResults = [];
  const startTime = Date.now();

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const configStartTime = Date.now();
    const results = runBacktest(config.params, data);
    const configTime = ((Date.now() - configStartTime) / 1000).toFixed(1);

    if ((i + 1) % 20 === 0 || i === configs.length - 1 || i < 3) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = elapsed > 0 ? ((i + 1) / elapsed).toFixed(2) : 'N/A';
      const eta = elapsed > 0 ? ((configs.length - i - 1) / ((i + 1) / elapsed) / 60).toFixed(1) : 'N/A';
      console.log(`[${i + 1}/${configs.length}] ${config.name} - ${configTime}s | ETA: ${eta}min`);
    }

    if (results?.performance) {
      const perf = results.performance.summary || {};
      allResults.push({
        name: config.name,
        params: config.params,
        trades: perf.totalTrades || 0,
        winRate: perf.winRate || 0,
        totalPnL: perf.totalPnL || 0,
        avgPnL: perf.totalTrades > 0 ? (perf.totalPnL || 0) / perf.totalTrades : 0,
        maxDrawdown: perf.maxDrawdown || 0,
        profitFactor: perf.profitFactor || 0,
        exitReasons: analyzeExitReasons(results.trades)
      });
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Grid search completed in ${totalTime}s`);

  allResults.sort((a, b) => b.totalPnL - a.totalPnL);

  // TOP 30
  console.log('\n' + '='.repeat(140));
  console.log('TOP 30 CONFIGURATIONS BY TOTAL P&L');
  console.log('='.repeat(140));
  console.log('\nRank | Configuration                    | Trades | Win%  |    Total P&L |  Avg P&L | MaxDD% | PF');
  console.log('-'.repeat(120));

  for (let i = 0; i < Math.min(30, allResults.length); i++) {
    const r = allResults[i];
    console.log(
      `${String(i + 1).padStart(4)} | ${r.name.padEnd(32)} | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(5)}% | $${r.totalPnL.toFixed(0).padStart(11)} | $${r.avgPnL.toFixed(0).padStart(7)} | ${r.maxDrawdown.toFixed(1).padStart(5)}% | ${r.profitFactor.toFixed(2).padStart(5)}`
    );
  }

  // Best with/without GEX
  const withGex = allResults.filter(r => r.params.requirePositiveGex).slice(0, 5);
  const withoutGex = allResults.filter(r => !r.params.requirePositiveGex).slice(0, 5);

  console.log('\n--- BEST WITHOUT GEX FILTER ---');
  for (const r of withoutGex) {
    console.log(`${r.name}: ${r.trades} trades | ${r.winRate.toFixed(1)}% WR | $${r.totalPnL.toFixed(0)} P&L | ${r.maxDrawdown.toFixed(1)}% DD`);
  }

  console.log('\n--- BEST WITH GEX FILTER ---');
  for (const r of withGex) {
    console.log(`${r.name}: ${r.trades} trades | ${r.winRate.toFixed(1)}% WR | $${r.totalPnL.toFixed(0)} P&L | ${r.maxDrawdown.toFixed(1)}% DD`);
  }

  // Parameter analysis
  console.log('\n' + '='.repeat(140));
  console.log('PARAMETER SENSITIVITY');
  console.log('='.repeat(140));

  for (const stop of stopBuffers) {
    const filtered = allResults.filter(r => r.params.stopBuffer === stop);
    const avgPnL = filtered.reduce((s, r) => s + r.totalPnL, 0) / filtered.length;
    console.log(`Stop ${stop}pt: Avg P&L $${avgPnL.toFixed(0)}`);
  }

  console.log('');
  for (const trigger of trailingTriggers) {
    const filtered = allResults.filter(r => r.params.trailingTrigger === trigger);
    const avgPnL = filtered.reduce((s, r) => s + r.totalPnL, 0) / filtered.length;
    console.log(`Trigger ${trigger}pt: Avg P&L $${avgPnL.toFixed(0)}`);
  }

  console.log('');
  for (const dist of maxDistances) {
    const filtered = allResults.filter(r => r.params.maxDistanceBelowFlip === dist);
    const avgPnL = filtered.reduce((s, r) => s + r.totalPnL, 0) / filtered.length;
    console.log(`MaxDist ${dist}pt: Avg P&L $${avgPnL.toFixed(0)}`);
  }

  // Risk-adjusted top 10
  console.log('\n' + '='.repeat(140));
  console.log('TOP 10 RISK-ADJUSTED (P&L / MaxDrawdown)');
  console.log('='.repeat(140));

  const riskAdjusted = allResults
    .filter(r => r.totalPnL > 0 && r.maxDrawdown > 0)
    .map(r => ({ ...r, riskAdj: r.totalPnL / r.maxDrawdown }))
    .sort((a, b) => b.riskAdj - a.riskAdj)
    .slice(0, 10);

  for (let i = 0; i < riskAdjusted.length; i++) {
    const r = riskAdjusted[i];
    console.log(`${String(i + 1).padStart(2)}. ${r.name}: $${r.totalPnL.toFixed(0)} P&L | ${r.maxDrawdown.toFixed(1)}% DD | Risk-Adj: ${r.riskAdj.toFixed(2)}`);
  }

  // Save results
  if (!fs.existsSync('./results')) fs.mkdirSync('./results', { recursive: true });
  fs.writeFileSync('./results/scalp-grid-search.json', JSON.stringify({
    testDate: new Date().toISOString(),
    period: testPeriod,
    totalConfigs: configs.length,
    executionTimeSec: parseFloat(totalTime),
    results: allResults
  }, null, 2));
  console.log('\nResults saved to: ./results/scalp-grid-search.json');

  // Final recommendation
  console.log('\n' + '='.repeat(140));
  console.log('RECOMMENDED CONFIGURATION');
  console.log('='.repeat(140));
  const best = allResults[0];
  console.log(`\n${best.name}`);
  console.log(`Trades: ${best.trades} | Win Rate: ${best.winRate.toFixed(1)}% | Total P&L: $${best.totalPnL.toFixed(0)} | Max DD: ${best.maxDrawdown.toFixed(1)}%`);
  console.log(`\nStrategy Parameters:`);
  console.log(`  stopBuffer: ${best.params.stopBuffer}`);
  console.log(`  trailingTrigger: ${best.params.trailingTrigger}`);
  console.log(`  trailingOffset: ${best.params.trailingOffset}`);
  console.log(`  maxDistanceBelowFlip: ${best.params.maxDistanceBelowFlip}`);
  console.log(`  requirePositiveGex: ${best.params.requirePositiveGex}`);
}

main().catch(console.error);
