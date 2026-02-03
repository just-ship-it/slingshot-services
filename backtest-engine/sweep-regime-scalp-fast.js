/**
 * Fast Parameter Sweep for Regime Scalp Strategy
 * Loads data once and tests multiple strategy parameter combinations
 */

import { BacktestEngine } from './src/backtest-engine.js';
import { RegimeScalpStrategy } from '../shared/strategies/regime-scalp.js';
import fs from 'fs';

// Parameter ranges to test - MINIMAL for quick results
const PARAM_GRID = {
  allowedRegimes: [
    ['BOUNCING_SUPPORT'],  // Most conservative
    ['BOUNCING_SUPPORT', 'WEAK_TRENDING_UP', 'STRONG_TRENDING_UP'],  // Without NEUTRAL
  ],
  stopLossPoints: [30, 40],  // Wider stops
  levelProximity: [3],  // Tighter proximity only
  trailingConfigs: [
    [15, 7],   // Wide trailing
    [25, 12],  // Very wide - let winners run more
  ],
  timeoutCandles: [5],
};

const totalCombinations =
  PARAM_GRID.allowedRegimes.length *
  PARAM_GRID.stopLossPoints.length *
  PARAM_GRID.levelProximity.length *
  PARAM_GRID.trailingConfigs.length *
  PARAM_GRID.timeoutCandles.length;

console.log(`\n========================================`);
console.log(`FAST REGIME SCALP PARAMETER SWEEP`);
console.log(`========================================`);
console.log(`Total combinations to test: ${totalCombinations}`);
console.log(`========================================\n`);

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
  useSecondResolution: false,
  strategyParams: {
    debug: false,
    liveMode: false,
    symbol: 'NQ',
    tradingSymbol: 'NQ',
    useSessionFilter: false,
    allowedSessions: ['rth', 'premarket', 'afterhours', 'overnight'],
  }
};

function formatRegimes(regimes) {
  const shortNames = {
    'BOUNCING_SUPPORT': 'BS',
    'WEAK_TRENDING_UP': 'WTU',
    'STRONG_TRENDING_UP': 'STU',
    'NEUTRAL': 'N'
  };
  return regimes.map(r => shortNames[r] || r).join('+');
}

const fmt = (val, decimals = 1) => {
  if (val === undefined || val === null || isNaN(val)) return '0';
  return val.toFixed(decimals);
};

async function runSweep() {
  const results = [];
  let completedCount = 0;
  const startTime = Date.now();

  // Create engine and load data ONCE
  console.log('Loading data (this only happens once)...\n');
  const engine = new BacktestEngine(baseConfig);

  // Load data by running once with first params - we'll extract the loaded data
  const firstParams = {
    ...baseConfig.strategyParams,
    allowedRegimes: PARAM_GRID.allowedRegimes[0],
    stopLossPoints: PARAM_GRID.stopLossPoints[0],
    levelProximity: PARAM_GRID.levelProximity[0],
    trailingTrigger: PARAM_GRID.trailingConfigs[0][0],
    trailingOffset: PARAM_GRID.trailingConfigs[0][1],
    timeoutCandles: PARAM_GRID.timeoutCandles[0],
  };

  // CSV setup
  const csvHeader = [
    'regimes', 'stopLoss', 'levelProximity', 'trailTrigger', 'trailOffset',
    'timeoutCandles', 'totalTrades', 'winRate', 'netPnL', 'totalReturn',
    'profitFactor', 'avgWin', 'avgLoss', 'maxDrawdown', 'sharpe', 'avgTradesPerDay'
  ].join(',');
  const csvLines = [csvHeader];

  // Iterate through all parameter combinations
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

            const regimeStr = formatRegimes(allowedRegimes);

            // Create new config with these params
            const testConfig = {
              ...baseConfig,
              strategyParams: {
                ...baseConfig.strategyParams,
                ...params
              }
            };

            // Progress update
            const elapsed = (Date.now() - startTime) / 1000;
            const rate = completedCount > 1 ? (completedCount - 1) / elapsed : 0;
            const eta = rate > 0 ? (totalCombinations - completedCount) / rate : 0;
            process.stdout.write(`\r[${completedCount}/${totalCombinations}] ${regimeStr} SL:${stopLossPoints} LP:${levelProximity} TR:${trailingTrigger}/${trailingOffset} | ETA: ${Math.round(eta)}s     `);

            try {
              const testEngine = new BacktestEngine(testConfig);
              const result = await testEngine.run();

              if (result && result.performance) {
                const perf = result.performance;
                const sim = result.simulation;

                const safe = (val, decimals = 2) => {
                  if (val === undefined || val === null || isNaN(val)) return '0';
                  return val.toFixed(decimals);
                };

                const csvLine = [
                  regimeStr, stopLossPoints, levelProximity, trailingTrigger, trailingOffset,
                  timeoutCandles, sim.totalTrades || 0, safe((perf.winRate || 0) * 100),
                  safe(perf.netPnL || 0), safe((perf.totalReturn || 0) * 100),
                  safe(perf.profitFactor || 0), safe(perf.avgWin || 0), safe(perf.avgLoss || 0),
                  safe((perf.maxDrawdown || 0) * 100), safe(perf.sharpeRatio || 0),
                  safe((sim.totalTrades || 0) / 252, 1)
                ].join(',');

                csvLines.push(csvLine);

                results.push({
                  params, regimeStr,
                  trades: sim.totalTrades || 0,
                  winRate: perf.winRate || 0,
                  netPnL: perf.netPnL || 0,
                  totalReturn: perf.totalReturn || 0,
                  profitFactor: perf.profitFactor || 0,
                  maxDrawdown: perf.maxDrawdown || 0,
                  sharpe: perf.sharpeRatio || 0
                });
              }
            } catch (error) {
              console.error(`\nError: ${error.message}`);
            }
          }
        }
      }
    }
  }

  // Write CSV
  const csvPath = './results/regime-scalp-sweep.csv';
  fs.mkdirSync('./results', { recursive: true });
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  // Summary
  console.log(`\n\n========================================`);
  console.log(`SWEEP COMPLETE`);
  console.log(`========================================`);
  console.log(`Results saved to: ${csvPath}`);
  console.log(`Total time: ${Math.round((Date.now() - startTime) / 1000 / 60)} minutes`);

  const sortedByPnL = [...results].sort((a, b) => b.netPnL - a.netPnL);

  console.log(`\n========================================`);
  console.log(`TOP 10 BY NET P&L`);
  console.log(`========================================`);
  sortedByPnL.slice(0, 10).forEach((r, i) => {
    console.log(`${i + 1}. ${r.regimeStr} | SL:${r.params.stopLossPoints} LP:${r.params.levelProximity} TR:${r.params.trailingTrigger}/${r.params.trailingOffset}`);
    console.log(`   Trades: ${r.trades} | Win: ${fmt(r.winRate * 100)}% | P&L: $${fmt(r.netPnL, 0)} | Return: ${fmt(r.totalReturn * 100)}% | PF: ${fmt(r.profitFactor, 2)} | DD: ${fmt(r.maxDrawdown * 100)}%`);
  });

  const sortedBySharpe = [...results].filter(r => r.sharpe > 0).sort((a, b) => b.sharpe - a.sharpe);
  console.log(`\n========================================`);
  console.log(`TOP 10 BY SHARPE RATIO`);
  console.log(`========================================`);
  sortedBySharpe.slice(0, 10).forEach((r, i) => {
    console.log(`${i + 1}. ${r.regimeStr} | SL:${r.params.stopLossPoints} LP:${r.params.levelProximity} TR:${r.params.trailingTrigger}/${r.params.trailingOffset}`);
    console.log(`   Trades: ${r.trades} | Win: ${fmt(r.winRate * 100)}% | P&L: $${fmt(r.netPnL, 0)} | Sharpe: ${fmt(r.sharpe, 2)} | DD: ${fmt(r.maxDrawdown * 100)}%`);
  });

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

runSweep().catch(console.error);
