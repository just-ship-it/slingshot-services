#!/usr/bin/env node
/**
 * Test Contrarian Bounce Strategy - Baseline
 *
 * This script runs the contrarian bounce strategy with minimal filtering
 * to establish a baseline for performance.
 *
 * Strategy: Enter long when price is below gamma flip (mean reversion)
 * All filters disabled to see raw signal frequency and performance.
 */

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs';

// Test periods to analyze
const testPeriods = [
  { name: 'Full 2025', startDate: '2025-01-13', endDate: '2025-12-24' },
  { name: 'Q1 2025', startDate: '2025-01-13', endDate: '2025-03-31' },
  { name: 'Q2 2025', startDate: '2025-04-01', endDate: '2025-06-30' },
  { name: 'Q3 2025', startDate: '2025-07-01', endDate: '2025-09-30' },
  { name: 'Q4 2025', startDate: '2025-10-01', endDate: '2025-12-24' }
];

// Baseline configuration - WIDE settings, all filters OFF
const baselineParams = {
  // Position sizing
  tradingSymbol: 'NQ',
  defaultQuantity: 1,

  // Risk management - WIDE for baseline
  stopBuffer: 30.0,           // 30 point stop below entry
  maxRisk: 200.0,             // Wide to not filter signals
  useGexLevelStops: false,    // Fixed stop, not put wall

  // Targets - use gamma flip as primary target
  targetMode: 'gamma_flip',
  fixedTargetPoints: 30.0,

  // No trailing stop for baseline
  useTrailingStop: false,

  // NO COOLDOWN for baseline - cast wide net
  signalCooldownMs: 0,

  // === ALL FILTERS DISABLED FOR BASELINE ===
  requirePositiveGex: false,
  useTimeFilter: false,
  useSentimentFilter: false,
  useDistanceFilter: false,
  useIvFilter: false,

  // Long only for baseline
  allowLong: true,
  allowShort: false
};

async function runBacktest(period, params) {
  const config = {
    ticker: 'NQ',
    startDate: new Date(period.startDate),
    endDate: new Date(period.endDate),
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
    console.error(`Error running backtest for ${period.name}:`, error.message);
    return null;
  }
}

function formatResults(period, results) {
  if (!results || !results.performance) {
    return `${period.name}: No results`;
  }

  const perf = results.performance.summary || {};
  const trades = perf.totalTrades || 0;
  const winRate = (perf.winRate || 0).toFixed(1);
  const pnl = (perf.totalPnL || 0).toFixed(0);
  const avgWin = (perf.avgWin || 0).toFixed(0);
  const avgLoss = (perf.avgLoss || 0).toFixed(0);
  const profitFactor = (perf.profitFactor || 0).toFixed(2);
  const maxDrawdown = (perf.maxDrawdown || 0).toFixed(0);

  return `${period.name.padEnd(12)} | Trades: ${String(trades).padStart(4)} | Win: ${winRate.padStart(5)}% | P&L: $${pnl.padStart(7)} | Avg Win: $${avgWin.padStart(5)} | Avg Loss: $${avgLoss.padStart(5)} | PF: ${profitFactor} | MaxDD: $${maxDrawdown}`;
}

async function main() {
  console.log('='.repeat(120));
  console.log('CONTRARIAN BOUNCE STRATEGY - BASELINE TEST');
  console.log('='.repeat(120));
  console.log('\nStrategy: Enter LONG when price is BELOW gamma flip (mean reversion)');
  console.log('Target: Gamma flip level | Stop: Put wall or 15 pts below entry');
  console.log('Filters: NONE (baseline)');
  console.log('Cooldown: 15 minutes between signals');
  console.log('\n' + '-'.repeat(120));

  const allResults = [];

  // Run each test period
  for (const period of testPeriods) {
    console.log(`\nRunning ${period.name}...`);
    const results = await runBacktest(period, baselineParams);

    if (results) {
      console.log(formatResults(period, results));
      allResults.push({ period: period.name, results });
    }
  }

  console.log('\n' + '='.repeat(120));

  // Save detailed results to JSON
  const outputPath = './results/contrarian-bounce-baseline.json';
  const outputData = {
    strategy: 'contrarian-bounce',
    testDate: new Date().toISOString(),
    params: baselineParams,
    results: allResults.map(r => ({
      period: r.period,
      summary: r.results?.performance?.summary || {},
      trades: r.results?.trades?.length || 0
    }))
  };

  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  console.log(`\nDetailed results saved to: ${outputPath}`);

  // Print filter test suggestions
  console.log('\n' + '='.repeat(120));
  console.log('NEXT STEPS - Filter Tests to Run:');
  console.log('-'.repeat(120));
  console.log('1. requirePositiveGex: true   - Only signal in positive GEX regime');
  console.log('2. useTimeFilter: true        - Only signal 12:00-15:30 ET (best window)');
  console.log('3. useSentimentFilter: true   - Only signal when liquidity is BULLISH');
  console.log('4. useDistanceFilter: true    - Require min 10pts below gamma flip');
  console.log('5. Combined filters           - Stack best performing filters');
  console.log('='.repeat(120));
}

main().catch(console.error);
