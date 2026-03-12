#!/usr/bin/env node
/**
 * Short-DTE IV Strategy Parameter Sweep
 *
 * Loads data ONCE via the backtest engine, then for each param combo:
 *   - Creates fresh strategy + trade simulator
 *   - Swaps them onto the engine
 *   - Runs full simulation (with 1s exit resolution)
 *
 * Usage:
 *   node scripts/sweep-sdiv.js --side both
 *   node scripts/sweep-sdiv.js --side long --threshold 0.015
 *   node scripts/sweep-sdiv.js --side all   (runs both, long, short)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { BacktestEngine } from '../src/backtest-engine.js';
import { ShortDTEIVStrategy } from '../../shared/strategies/short-dte-iv.js';
import { TradeSimulator } from '../src/execution/trade-simulator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const stops = [10, 15, 20, 30, 40, 50];
const targets = [10, 15, 20, 30, 40, 50];

// Parse CLI
const args = process.argv.slice(2);
let sideFilter = 'all';
let ivThreshold = 0.008;
let start = '2025-01-29';
let end = '2026-01-28';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--side') sideFilter = args[++i];
  if (args[i] === '--threshold') ivThreshold = parseFloat(args[++i]);
  if (args[i] === '--start') start = args[++i];
  if (args[i] === '--end') end = args[++i];
}

const sideCombos = sideFilter === 'all' ? ['both', 'long', 'short'] : [sideFilter];
const totalRuns = stops.length * targets.length * sideCombos.length;

console.log(`Short-DTE IV Parameter Sweep`);
console.log(`IV threshold: ${ivThreshold} | Sides: ${sideCombos.join(', ')}`);
console.log(`Date range: ${start} → ${end}`);
console.log(`Matrix: ${stops.length} stops × ${targets.length} targets × ${sideCombos.length} sides = ${totalRuns} runs\n`);

// ── Step 1: Load data once using the real backtest engine ──────────────
console.log('Loading data (one time)...\n');

const baseConfig = {
  ticker: 'NQ',
  strategy: 'short-dte-iv',
  timeframe: '15m',
  startDate: new Date(start),
  endDate: new Date(end),
  dataDir: DATA_DIR,
  initialCapital: 100000,
  commission: 5,
  strategyParams: {
    ivChangeThreshold: ivThreshold,
    trailingTrigger: 9999,
    trailingOffset: 0,
    maxHoldBars: 60,
    cooldownMs: 900000,
    timeoutCandles: 2,
  },
  quiet: true,
};

const engine = new BacktestEngine(baseConfig);
const data = await engine.loadData();

// Grab the simulator config from the engine's existing trade simulator
const simConfig = engine.tradeSimulator.config;

console.log(`Data loaded. Starting ${totalRuns} sweep runs...\n`);

// ── Step 2: Run sweep ──────────────────────────────────────────────────
const results = [];
let runNum = 0;
const sweepStart = Date.now();

for (const side of sideCombos) {
  for (const stop of stops) {
    for (const target of targets) {
      runNum++;

      // Fresh strategy with this combo's params
      const strategyParams = {
        ivChangeThreshold: ivThreshold,
        enableLong: side !== 'short',
        enableShort: side !== 'long',
        targetPoints: target,
        stopPoints: stop,
        trailingTrigger: 9999,   // Disable trailing — pure TP/SL
        trailingOffset: 0,
        maxHoldBars: 60,         // Effectively unlimited
        cooldownMs: 900000,      // 15 min
        timeoutCandles: 2,
      };

      // Swap strategy + trade simulator on the engine
      engine.strategy = new ShortDTEIVStrategy(strategyParams);
      engine.tradeSimulator = new TradeSimulator(simConfig);

      try {
        const simResults = await engine.runSimulation(data);
        const perf = engine.performanceCalculator.calculateMetrics(
          simResults.trades, simResults.equityCurve, baseConfig.startDate, baseConfig.endDate
        );

        const trades = perf.summary.totalTrades || 0;
        const winRate = perf.summary.winRate || 0;
        const pnl = perf.summary.totalPnL || 0;
        const pf = perf.basic.profitFactor || 0;
        const expectancy = perf.basic.expectancy || 0;
        const maxDD = perf.summary.maxDrawdown || 0;
        const sharpe = perf.summary.sharpeRatio || 0;

        // Count exits by reason
        let tpCount = 0, slCount = 0, mhCount = 0, mcCount = 0;
        for (const t of simResults.trades) {
          const r = t.exitReason || '';
          if (r.includes('TAKE_PROFIT') || r.includes('TAKE PROFIT')) tpCount++;
          else if (r.includes('STOP_LOSS') || r.includes('STOP LOSS')) slCount++;
          else if (r.includes('MAX_HOLD') || r.includes('MAX HOLD')) mhCount++;
          else if (r.includes('MARKET_CLOSE') || r.includes('MARKET CLOSE')) mcCount++;
        }

        results.push({ side, stop, target, trades, winRate, pnl, pf, expectancy, maxDD, sharpe, tpCount, slCount, mhCount, mcCount });

        const rr = (target / stop).toFixed(1);
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
        const elapsed = ((Date.now() - sweepStart) / 1000).toFixed(0);
        console.log(`[${String(runNum).padStart(3)}/${totalRuns}] ${side.padEnd(5)} S:${String(stop).padStart(2)} T:${String(target).padStart(2)} | R:R=${rr} | ${String(trades).padStart(3)} trades | WR=${winRate.toFixed(1)}% | PF=${pf.toFixed(2)} | ${pnlStr.padStart(9)} | Exp=$${expectancy.toFixed(0)} | DD=${maxDD.toFixed(1)}% | TP:${tpCount} SL:${slCount} MH:${mhCount} MC:${mcCount} (${elapsed}s)`);
      } catch (err) {
        console.log(`[${String(runNum).padStart(3)}/${totalRuns}] ${side.padEnd(5)} S:${stop} T:${target} | ERROR: ${err.message.split('\n')[0]}`);
      }
    }
  }
}

const totalTime = ((Date.now() - sweepStart) / 1000).toFixed(1);
console.log(`\nSweep completed in ${totalTime}s (${(totalRuns / (totalTime / 60)).toFixed(0)} runs/min)\n`);

// ── Step 3: Summary tables ─────────────────────────────────────────────
console.log('═'.repeat(100));
console.log('SUMMARY MATRICES');
console.log('═'.repeat(100));

for (const side of sideCombos) {
  const sr = results.filter(r => r.side === side);
  if (sr.length === 0) continue;

  const printMatrix = (title, getter, fmt) => {
    console.log(`\n${side.toUpperCase()} — ${title}`);
    console.log('Stop\\Target  ' + targets.map(t => String(t).padStart(8)).join(''));
    for (const stop of stops) {
      const row = targets.map(target => {
        const r = sr.find(r => r.stop === stop && r.target === target);
        if (!r || r.trades === 0) return '     N/A';
        return fmt(getter(r)).padStart(8);
      });
      console.log(`  ${String(stop).padStart(3)}       ${row.join('')}`);
    }
  };

  printMatrix('Win Rate %', r => r.winRate, v => `${v.toFixed(1)}%`);
  printMatrix('Expectancy ($/trade)', r => r.expectancy, v => `$${v.toFixed(0)}`);
  printMatrix('Profit Factor', r => r.pf, v => v.toFixed(2));
  printMatrix('Total P&L ($)', r => r.pnl, v => `$${v.toFixed(0)}`);
  printMatrix('Trade Count', r => r.trades, v => `${v}`);
  printMatrix('Max Drawdown %', r => r.maxDD, v => `${v.toFixed(1)}%`);
}
