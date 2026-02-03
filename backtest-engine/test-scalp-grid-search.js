#!/usr/bin/env node
/**
 * Grid Search - Stop Loss and Trailing Stop Optimization
 *
 * Tests a wide variety of configurations to find optimal parameters.
 */

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs';

const testPeriod = { name: 'Full 2025', startDate: '2025-01-13', endDate: '2025-12-24' };

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

async function runBacktest(params) {
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
  console.log('='.repeat(140));
  console.log('SCALPING STRATEGY - GRID SEARCH OPTIMIZATION');
  console.log('='.repeat(140));

  const configs = generateConfigs();
  console.log(`\nTesting ${configs.length} configurations...`);
  console.log('Parameters: Max Distance, Stop Buffer, Trailing Trigger/Offset, GEX Regime Filter\n');

  const allResults = [];
  let completed = 0;

  // Run all backtests
  for (const config of configs) {
    const results = await runBacktest(config.params);
    completed++;

    if (completed % 50 === 0) {
      console.log(`Progress: ${completed}/${configs.length} (${(completed/configs.length*100).toFixed(0)}%)`);
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

  // Save full results
  const outputPath = './results/scalp-grid-search.json';
  fs.writeFileSync(outputPath, JSON.stringify({
    testDate: new Date().toISOString(),
    period: testPeriod,
    totalConfigs: configs.length,
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

  console.log('\n2. HIGHEST P&L WITH GEX FILTER:');
  console.log(`   ${bestWithGex.name}`);
  console.log(`   Trades: ${bestWithGex.trades} | Win: ${bestWithGex.winRate.toFixed(1)}% | P&L: $${bestWithGex.totalPnL.toFixed(0)} | MaxDD: ${bestWithGex.maxDrawdown.toFixed(1)}%`);

  console.log('\n3. BEST RISK-ADJUSTED:');
  console.log(`   ${bestRiskAdj.name}`);
  console.log(`   Trades: ${bestRiskAdj.trades} | Win: ${bestRiskAdj.winRate.toFixed(1)}% | P&L: $${bestRiskAdj.totalPnL.toFixed(0)} | MaxDD: ${bestRiskAdj.maxDrawdown.toFixed(1)}%`);
}

main().catch(console.error);
