#!/usr/bin/env node
/**
 * Test Contrarian Bounce - Scalping Variation
 *
 * Based on analysis findings:
 * - Trades close to gamma flip (0-20 pts) have 66-75% win rate
 * - But current strategy loses money waiting for full move to gamma flip
 *
 * Scalping approach:
 * - Only enter when within 20 pts of gamma flip
 * - Use trailing stop to capture quick profits
 * - Tighter stop loss to reduce damage on losers
 */

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs';

const testPeriod = { name: 'Full 2025', startDate: '2025-01-13', endDate: '2025-12-24' };

// Test configurations
const configs = [
  {
    name: 'Baseline (current)',
    params: {
      tradingSymbol: 'NQ',
      defaultQuantity: 1,
      stopBuffer: 30.0,
      maxRisk: 200.0,
      useGexLevelStops: false,
      targetMode: 'gamma_flip',
      useTrailingStop: false,
      signalCooldownMs: 0,
      requirePositiveGex: false,
      useTimeFilter: false,
      useSentimentFilter: false,
      useDistanceFilter: false,
      useIvFilter: false,
      allowLong: true,
      allowShort: false
    }
  },
  {
    name: 'Scalp v1: Max 20pt dist, 15pt stop, trail 10/5',
    params: {
      tradingSymbol: 'NQ',
      defaultQuantity: 1,
      stopBuffer: 15.0,
      maxRisk: 200.0,
      useGexLevelStops: false,
      targetMode: 'gamma_flip',
      useTrailingStop: true,
      trailingTrigger: 10.0,
      trailingOffset: 5.0,
      signalCooldownMs: 0,
      requirePositiveGex: false,
      useTimeFilter: false,
      useSentimentFilter: false,
      useDistanceFilter: true,
      minDistanceBelowFlip: 0,
      maxDistanceBelowFlip: 20,
      useIvFilter: false,
      allowLong: true,
      allowShort: false
    }
  },
  {
    name: 'Scalp v2: Max 15pt dist, 12pt stop, trail 8/4',
    params: {
      tradingSymbol: 'NQ',
      defaultQuantity: 1,
      stopBuffer: 12.0,
      maxRisk: 200.0,
      useGexLevelStops: false,
      targetMode: 'gamma_flip',
      useTrailingStop: true,
      trailingTrigger: 8.0,
      trailingOffset: 4.0,
      signalCooldownMs: 0,
      requirePositiveGex: false,
      useTimeFilter: false,
      useSentimentFilter: false,
      useDistanceFilter: true,
      minDistanceBelowFlip: 0,
      maxDistanceBelowFlip: 15,
      useIvFilter: false,
      allowLong: true,
      allowShort: false
    }
  },
  {
    name: 'Scalp v3: Max 20pt dist, 20pt stop, trail 12/6',
    params: {
      tradingSymbol: 'NQ',
      defaultQuantity: 1,
      stopBuffer: 20.0,
      maxRisk: 200.0,
      useGexLevelStops: false,
      targetMode: 'gamma_flip',
      useTrailingStop: true,
      trailingTrigger: 12.0,
      trailingOffset: 6.0,
      signalCooldownMs: 0,
      requirePositiveGex: false,
      useTimeFilter: false,
      useSentimentFilter: false,
      useDistanceFilter: true,
      minDistanceBelowFlip: 0,
      maxDistanceBelowFlip: 20,
      useIvFilter: false,
      allowLong: true,
      allowShort: false
    }
  },
  {
    name: 'Scalp v4: Max 25pt dist, 18pt stop, trail 10/5, +GEX regime',
    params: {
      tradingSymbol: 'NQ',
      defaultQuantity: 1,
      stopBuffer: 18.0,
      maxRisk: 200.0,
      useGexLevelStops: false,
      targetMode: 'gamma_flip',
      useTrailingStop: true,
      trailingTrigger: 10.0,
      trailingOffset: 5.0,
      signalCooldownMs: 0,
      requirePositiveGex: true,
      useTimeFilter: false,
      useSentimentFilter: false,
      useDistanceFilter: true,
      minDistanceBelowFlip: 0,
      maxDistanceBelowFlip: 25,
      useIvFilter: false,
      allowLong: true,
      allowShort: false
    }
  },
  {
    name: 'Scalp v5: Fixed 15pt target (no gamma flip), trail 10/5',
    params: {
      tradingSymbol: 'NQ',
      defaultQuantity: 1,
      stopBuffer: 15.0,
      maxRisk: 200.0,
      useGexLevelStops: false,
      targetMode: 'fixed',
      fixedTargetPoints: 15.0,
      useTrailingStop: true,
      trailingTrigger: 10.0,
      trailingOffset: 5.0,
      signalCooldownMs: 0,
      requirePositiveGex: false,
      useTimeFilter: false,
      useSentimentFilter: false,
      useDistanceFilter: true,
      minDistanceBelowFlip: 0,
      maxDistanceBelowFlip: 20,
      useIvFilter: false,
      allowLong: true,
      allowShort: false
    }
  },
  {
    name: 'Scalp v6: Max 30pt dist, 15pt stop, aggressive trail 8/4',
    params: {
      tradingSymbol: 'NQ',
      defaultQuantity: 1,
      stopBuffer: 15.0,
      maxRisk: 200.0,
      useGexLevelStops: false,
      targetMode: 'gamma_flip',
      useTrailingStop: true,
      trailingTrigger: 8.0,
      trailingOffset: 4.0,
      signalCooldownMs: 0,
      requirePositiveGex: false,
      useTimeFilter: false,
      useSentimentFilter: false,
      useDistanceFilter: true,
      minDistanceBelowFlip: 0,
      maxDistanceBelowFlip: 30,
      useIvFilter: false,
      allowLong: true,
      allowShort: false
    }
  }
];

async function runBacktest(name, params) {
  const config = {
    ticker: 'NQ',
    startDate: new Date(testPeriod.startDate),
    endDate: new Date(testPeriod.endDate),
    timeframe: '15m',
    strategy: 'contrarian-bounce',
    strategyParams: params,
    commission: 5,
    initialCapital: 100000,
    dataDir: 'data',
    quiet: true
  };

  try {
    const engine = new BacktestEngine(config);
    const results = await engine.run();
    return results;
  } catch (error) {
    console.error(`Error running ${name}:`, error.message);
    return null;
  }
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
  console.log('='.repeat(130));
  console.log('CONTRARIAN BOUNCE - SCALPING VARIATION TEST');
  console.log('='.repeat(130));
  console.log('\nHypothesis: Enter only when close to gamma flip, use trailing stop for quick profits');
  console.log('');

  const allResults = [];

  console.log('Configuration                                        | Trades | Win%  |    Total P&L |  Avg P&L | Profit Factor | MaxDD%');
  console.log('-'.repeat(130));

  for (const config of configs) {
    const results = await runBacktest(config.name, config.params);

    if (results && results.performance) {
      const perf = results.performance.summary || {};
      const trades = perf.totalTrades || 0;
      const winRate = (perf.winRate || 0).toFixed(1);
      const totalPnl = perf.totalPnL || 0;
      const avgPnl = trades > 0 ? totalPnl / trades : 0;
      const profitFactor = (perf.profitFactor || 0).toFixed(2);
      const maxDD = (perf.maxDrawdown || 0).toFixed(1);

      console.log(
        `${config.name.substring(0, 52).padEnd(52)} | ${String(trades).padStart(6)} | ${winRate.padStart(5)}% | $${totalPnl.toFixed(0).padStart(11)} | $${avgPnl.toFixed(0).padStart(7)} | ${profitFactor.padStart(13)} | ${maxDD.padStart(5)}%`
      );

      // Analyze exit reasons
      const exits = analyzeExitReasons(results.trades);

      allResults.push({
        name: config.name,
        params: config.params,
        summary: perf,
        exitReasons: exits,
        trades: results.trades?.length || 0
      });
    } else {
      console.log(`${config.name.substring(0, 52).padEnd(52)} | ERROR - No results`);
    }
  }

  // Print detailed exit analysis
  console.log('\n' + '='.repeat(130));
  console.log('EXIT REASON BREAKDOWN');
  console.log('='.repeat(130));

  for (const result of allResults) {
    console.log(`\n${result.name}:`);
    for (const [reason, data] of Object.entries(result.exitReasons)) {
      const avgPnl = data.count > 0 ? data.pnl / data.count : 0;
      console.log(`  ${reason.padEnd(15)}: ${String(data.count).padStart(5)} trades | $${data.pnl.toFixed(0).padStart(10)} | Avg: $${avgPnl.toFixed(0).padStart(6)}`);
    }
  }

  // Save results
  const outputPath = './results/contrarian-scalp-test.json';
  fs.writeFileSync(outputPath, JSON.stringify({
    testDate: new Date().toISOString(),
    period: testPeriod,
    results: allResults
  }, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);
}

main().catch(console.error);
