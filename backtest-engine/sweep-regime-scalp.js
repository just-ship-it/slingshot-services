/**
 * Parameter Sweep for Regime Scalp Strategy
 * Tests multiple parameter combinations to find profitable configurations
 */

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs';

// Parameter ranges to test - reduced for faster initial sweep
const PARAM_GRID = {
  // Regime combinations to test
  allowedRegimes: [
    ['BOUNCING_SUPPORT'],  // Most conservative - only support bounces
    ['BOUNCING_SUPPORT', 'WEAK_TRENDING_UP'],
    ['BOUNCING_SUPPORT', 'WEAK_TRENDING_UP', 'STRONG_TRENDING_UP'],
  ],

  // Stop loss points
  stopLossPoints: [20, 30, 40],

  // Level proximity (how close to support before entering)
  levelProximity: [3, 5],

  // Trailing stop configurations [trigger, offset]
  trailingConfigs: [
    [7, 4],   // Default
    [15, 7],  // Wide
    [25, 12], // Very wide - let winners run
  ],

  // Timeout candles (fixed at 5 for now)
  timeoutCandles: [5],
};

// Calculate total combinations
const totalCombinations =
  PARAM_GRID.allowedRegimes.length *
  PARAM_GRID.stopLossPoints.length *
  PARAM_GRID.levelProximity.length *
  PARAM_GRID.trailingConfigs.length *
  PARAM_GRID.timeoutCandles.length;

console.log(`\n========================================`);
console.log(`REGIME SCALP PARAMETER SWEEP`);
console.log(`========================================`);
console.log(`Total combinations to test: ${totalCombinations}`);
console.log(`Estimated time: ${Math.round(totalCombinations * 2 / 60)} - ${Math.round(totalCombinations * 5 / 60)} minutes`);
console.log(`========================================\n`);

// Results storage
const results = [];
let completedCount = 0;
const startTime = Date.now();

// Base config
const baseConfig = {
  ticker: 'NQ',
  startDate: new Date('2025-01-02'),
  endDate: new Date('2025-12-31'),
  timeframe: '1m',
  strategy: 'regime-scalp',
  commission: 5,
  initialCapital: 100000,
  dataDir: './data',
  verbose: false,
  quiet: true,
  showTrades: false,
  useSecondResolution: false,  // Disable for faster sweep
};

async function runSingleBacktest(params) {
  const config = {
    ...baseConfig,
    strategyParams: {
      debug: false,
      liveMode: false,
      symbol: 'NQ',
      tradingSymbol: 'NQ',
      useSessionFilter: false,
      allowedSessions: ['rth', 'premarket', 'afterhours', 'overnight'],
      ...params
    }
  };

  try {
    const engine = new BacktestEngine(config);
    const results = await engine.run();
    return results;
  } catch (error) {
    console.error(`Error running backtest:`, error.message);
    return null;
  }
}

function formatRegimes(regimes) {
  const shortNames = {
    'BOUNCING_SUPPORT': 'BS',
    'WEAK_TRENDING_UP': 'WTU',
    'STRONG_TRENDING_UP': 'STU',
    'NEUTRAL': 'N'
  };
  return regimes.map(r => shortNames[r] || r).join('+');
}

async function runSweep() {
  // CSV header
  const csvHeader = [
    'regimes',
    'stopLoss',
    'levelProximity',
    'trailTrigger',
    'trailOffset',
    'timeoutCandles',
    'totalTrades',
    'winRate',
    'netPnL',
    'totalReturn',
    'profitFactor',
    'avgWin',
    'avgLoss',
    'maxDrawdown',
    'sharpe',
    'avgTradesPerDay'
  ].join(',');

  const csvLines = [csvHeader];

  for (const allowedRegimes of PARAM_GRID.allowedRegimes) {
    for (const stopLossPoints of PARAM_GRID.stopLossPoints) {
      for (const levelProximity of PARAM_GRID.levelProximity) {
        for (const [trailingTrigger, trailingOffset] of PARAM_GRID.trailingConfigs) {
          for (const timeoutCandles of PARAM_GRID.timeoutCandles) {
            completedCount++;

            const params = {
              allowedRegimes,
              stopLossPoints,
              levelProximity,
              trailingTrigger,
              trailingOffset,
              timeoutCandles,
            };

            const elapsed = (Date.now() - startTime) / 1000;
            const rate = completedCount / elapsed;
            const eta = (totalCombinations - completedCount) / rate;

            const regimeStr = formatRegimes(allowedRegimes);
            process.stdout.write(`\r[${completedCount}/${totalCombinations}] ${regimeStr} SL:${stopLossPoints} LP:${levelProximity} TR:${trailingTrigger}/${trailingOffset} TO:${timeoutCandles} | ETA: ${Math.round(eta)}s    `);

            const result = await runSingleBacktest(params);

            if (result && result.performance) {
              const perf = result.performance;
              const sim = result.simulation;

              // Safe number formatting
              const safe = (val, decimals = 2) => {
                if (val === undefined || val === null || isNaN(val)) return '0';
                return val.toFixed(decimals);
              };

              const csvLine = [
                regimeStr,
                stopLossPoints,
                levelProximity,
                trailingTrigger,
                trailingOffset,
                timeoutCandles,
                sim.totalTrades || 0,
                safe((perf.winRate || 0) * 100),
                safe(perf.netPnL || 0),
                safe((perf.totalReturn || 0) * 100),
                safe(perf.profitFactor || 0),
                safe(perf.avgWin || 0),
                safe(perf.avgLoss || 0),
                safe((perf.maxDrawdown || 0) * 100),
                safe(perf.sharpeRatio || 0),
                safe((sim.totalTrades || 0) / 252, 1)  // Approx trading days
              ].join(',');

              csvLines.push(csvLine);

              results.push({
                params,
                regimeStr,
                trades: sim.totalTrades || 0,
                winRate: perf.winRate || 0,
                netPnL: perf.netPnL || 0,
                totalReturn: perf.totalReturn || 0,
                profitFactor: perf.profitFactor || 0,
                maxDrawdown: perf.maxDrawdown || 0,
                sharpe: perf.sharpeRatio || 0
              });
            }
          }
        }
      }
    }
  }

  // Write CSV file
  const csvPath = './results/regime-scalp-sweep.csv';
  fs.mkdirSync('./results', { recursive: true });
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  console.log(`\n\n========================================`);
  console.log(`SWEEP COMPLETE`);
  console.log(`========================================`);
  console.log(`Results saved to: ${csvPath}`);
  console.log(`Total time: ${Math.round((Date.now() - startTime) / 1000 / 60)} minutes`);

  // Find top 10 by net P&L
  const sortedByPnL = [...results].sort((a, b) => b.netPnL - a.netPnL);

  // Safe number formatting for summary
  const fmt = (val, decimals = 1) => {
    if (val === undefined || val === null || isNaN(val)) return '0';
    return val.toFixed(decimals);
  };

  console.log(`\n========================================`);
  console.log(`TOP 10 BY NET P&L`);
  console.log(`========================================`);
  sortedByPnL.slice(0, 10).forEach((r, i) => {
    console.log(`${i + 1}. ${r.regimeStr} | SL:${r.params.stopLossPoints} LP:${r.params.levelProximity} TR:${r.params.trailingTrigger}/${r.params.trailingOffset} TO:${r.params.timeoutCandles}`);
    console.log(`   Trades: ${r.trades} | Win: ${fmt(r.winRate * 100)}% | P&L: $${fmt(r.netPnL, 0)} | Return: ${fmt(r.totalReturn * 100)}% | PF: ${fmt(r.profitFactor, 2)} | DD: ${fmt(r.maxDrawdown * 100)}%`);
  });

  // Find top 10 by Sharpe ratio (risk-adjusted)
  const sortedBySharpe = [...results].filter(r => r.sharpe > 0).sort((a, b) => b.sharpe - a.sharpe);

  console.log(`\n========================================`);
  console.log(`TOP 10 BY SHARPE RATIO`);
  console.log(`========================================`);
  sortedBySharpe.slice(0, 10).forEach((r, i) => {
    console.log(`${i + 1}. ${r.regimeStr} | SL:${r.params.stopLossPoints} LP:${r.params.levelProximity} TR:${r.params.trailingTrigger}/${r.params.trailingOffset} TO:${r.params.timeoutCandles}`);
    console.log(`   Trades: ${r.trades} | Win: ${fmt(r.winRate * 100)}% | P&L: $${fmt(r.netPnL, 0)} | Sharpe: ${fmt(r.sharpe, 2)} | DD: ${fmt(r.maxDrawdown * 100)}%`);
  });

  // Find profitable combinations
  const profitable = results.filter(r => r.netPnL > 0);
  console.log(`\n========================================`);
  console.log(`SUMMARY`);
  console.log(`========================================`);
  console.log(`Total combinations tested: ${results.length}`);
  console.log(`Profitable combinations: ${profitable.length} (${fmt(profitable.length / results.length * 100)}%)`);

  if (profitable.length > 0) {
    const avgReturn = profitable.reduce((sum, r) => sum + r.totalReturn, 0) / profitable.length;
    console.log(`Avg return of profitable: ${fmt(avgReturn * 100)}%`);
  }
}

// Run the sweep
runSweep().catch(console.error);
