#!/usr/bin/env node

/**
 * Sweep Strategy Parameter Matrix Testing
 *
 * Tests various target/stop combinations to find profitable configurations.
 * Uses the GEX Level Sweep strategy with volume spike detection.
 */

import { BacktestEngine } from '../src/backtest-engine.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
  quiet: true,  // Suppress individual backtest output
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
  console.log('========================================\n');
  console.log(`Period: ${BASE_CONFIG.startDate.toISOString().split('T')[0]} to ${BASE_CONFIG.endDate.toISOString().split('T')[0]}`);
  console.log(`Timeframe: ${BASE_CONFIG.timeframe}`);
  console.log(`Volume Spike: Required (z >= ${BASE_CONFIG.strategyParams.volumeZThreshold})`);
  console.log(`Sessions: ${BASE_CONFIG.strategyParams.allowedSessions.join(', ')}`);
  console.log('\nTesting combinations...\n');

  const results = [];
  const totalCombos = TARGET_POINTS.length * STOP_POINTS.length;
  let completed = 0;

  for (const target of TARGET_POINTS) {
    for (const stop of STOP_POINTS) {
      const config = {
        ...BASE_CONFIG,
        strategyParams: {
          ...BASE_CONFIG.strategyParams,
          targetPoints: target,
          stopPoints: stop
        }
      };

      try {
        const engine = new BacktestEngine(config);
        const result = await engine.run();

        const perf = result.performance;
        const rrRatio = target / stop;
        const breakeven = stop / (target + stop);  // Win rate needed to break even

        results.push({
          target,
          stop,
          rrRatio: rrRatio.toFixed(2),
          breakevenWR: (breakeven * 100).toFixed(1),
          trades: result.trades.length,
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

  return results;
}

// Run the matrix
runParameterMatrix().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
