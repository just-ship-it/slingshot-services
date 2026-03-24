#!/usr/bin/env node
/**
 * Close-Below Rule Sweep — Early Exit for Stagnant Trades
 *
 * Tests adding a "close_below" rule that forces exit when a trade has been
 * open for N bars but hasn't reached M points of MFE. These "stuck" trades
 * have a 38% win rate vs 61% overall — they're a drag on performance.
 *
 * Sweeps:
 *   - afterBars: when to evaluate (25, 30, 35, 40, 45)
 *   - mfeBelow: close if MFE < this (20, 30, 40, 50)
 *
 * Base config: gold standard IV-SKEW-GEX with TB rules:
 *   Rule 1: 15,50,breakeven
 *   Rule 2: 40,50,trail:10
 *
 * Usage:
 *   node scripts/sweep-close-below.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BacktestEngine } from '../src/backtest-engine.js';
import { TradeSimulator } from '../src/execution/trade-simulator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_DIR = path.join(__dirname, '..', 'research', 'output');

const start = '2025-01-13';
const end = '2026-01-23';

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Gold standard time-based trailing rules
const GOLD_TB_RULES = [
  { afterBars: 15, ifMFE: 50, action: 'breakeven' },
  { afterBars: 40, ifMFE: 50, trailDistance: 10 },
];

// Sweep parameters
const BARS_VALUES = [25, 30, 35, 40, 45];
const MFE_VALUES = [20, 30, 40, 50];

function fmtPnl(pnl) {
  return pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
}

async function runSingle(engine, data, baseConfig, tbRules) {
  const strategyParams = { ...baseConfig.strategyParams };

  engine.strategy = engine.createStrategy('iv-skew-gex', strategyParams);

  engine.config.strategyParams = {
    ...strategyParams,
    timeBasedTrailing: true,
    timeBasedTrailingConfig: { rules: tbRules },
  };

  const simConfig = {
    commission: baseConfig.commission,
    slippage: engine.tradeSimulator.config.slippage,
    contractSpecs: engine.tradeSimulator.config.contractSpecs,
    forceCloseAtMarketClose: engine.tradeSimulator.config.forceCloseAtMarketClose,
    marketCloseTimeUTC: engine.tradeSimulator.config.marketCloseTimeUTC,
    timeBasedTrailing: { enabled: true, rules: tbRules },
  };
  engine.tradeSimulator = new TradeSimulator(simConfig);

  const simResults = await engine.runSimulation(data);
  const perf = engine.performanceCalculator.calculateMetrics(
    simResults.trades, simResults.equityCurve,
    baseConfig.startDate, baseConfig.endDate
  );

  const trades = perf.summary.totalTrades || 0;
  const winRate = perf.summary.winRate || 0;
  const pnl = perf.summary.totalPnL || 0;
  const pf = perf.basic.profitFactor || 0;
  const expectancy = perf.basic.expectancy || 0;
  const maxDD = perf.summary.maxDrawdown || 0;
  const sharpe = perf.summary.sharpeRatio || 0;

  // Count exits by reason
  let tpCount = 0, slCount = 0, mhCount = 0, mcCount = 0, trailCount = 0, mfeTimeoutCount = 0;
  for (const t of simResults.trades) {
    const r = (t.exitReason || '').toLowerCase();
    if (r.includes('take_profit') || r.includes('take profit')) tpCount++;
    else if (r.includes('mfe_timeout')) mfeTimeoutCount++;
    else if (r.includes('trailing') || r.includes('ratchet')) trailCount++;
    else if (r.includes('stop_loss') || r.includes('stop loss')) slCount++;
    else if (r.includes('max_hold') || r.includes('max hold')) mhCount++;
    else if (r.includes('market_close') || r.includes('market close')) mcCount++;
  }

  return {
    trades, winRate, pnl, pf, expectancy, maxDD, sharpe,
    tpCount, slCount, trailCount, mhCount, mcCount, mfeTimeoutCount,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

console.log('═'.repeat(80));
console.log('CLOSE-BELOW RULE SWEEP — Early Exit for Stagnant Trades');
console.log('═'.repeat(80));
console.log(`Date range: ${start} → ${end}`);
console.log(`Base TB rules: 15,50,breakeven | 40,50,trail:10`);
console.log(`Sweep: afterBars=[${BARS_VALUES}] × mfeBelow=[${MFE_VALUES}]`);
console.log(`Total combinations: ${BARS_VALUES.length * MFE_VALUES.length + 1} (incl. baseline)\n`);

console.log('Loading data (one time, 1m raw-contracts)...\n');

const baseConfig = {
  ticker: 'NQ',
  strategy: 'iv-skew-gex',
  timeframe: '1m',
  noContinuous: true,
  startDate: new Date(start),
  endDate: new Date(end),
  dataDir: DATA_DIR,
  initialCapital: 100000,
  commission: 5,
  strategyParams: {
    maxHoldBars: 60,
    stopLossPoints: 80,
    targetPoints: 120,
    ivResolution: '1m',
  },
  quiet: true,
};

const engine = new BacktestEngine(baseConfig);
const data = await engine.loadData();

console.log('Data loaded.\n');

// ─── Phase 1: Baseline ──────────────────────────────────────────────
console.log('─'.repeat(80));
console.log('PHASE 1: BASELINE (no close_below rule)');
console.log('─'.repeat(80));

const baseline = await runSingle(engine, data, baseConfig, [...GOLD_TB_RULES]);
console.log(`  Trades: ${baseline.trades} | WR: ${baseline.winRate.toFixed(1)}% | PnL: ${fmtPnl(baseline.pnl)} | PF: ${baseline.pf.toFixed(2)} | Sharpe: ${baseline.sharpe.toFixed(2)} | MaxDD: ${baseline.maxDD.toFixed(2)}%`);
console.log(`  Exits: TP=${baseline.tpCount} Trail=${baseline.trailCount} SL=${baseline.slCount} MH=${baseline.mhCount} MC=${baseline.mcCount}`);
console.log('');

// ─── Phase 2: Sweep ──────────────────────────────────────────────────
console.log('─'.repeat(80));
console.log('PHASE 2: SWEEP close_below parameters');
console.log('─'.repeat(80));

const results = [];
let runCount = 0;
const totalRuns = BARS_VALUES.length * MFE_VALUES.length;

for (const afterBars of BARS_VALUES) {
  for (const mfeBelow of MFE_VALUES) {
    runCount++;
    const label = `bars>=${afterBars},MFE<${mfeBelow}`;

    // Build rules: gold standard + close_below
    const rules = [
      ...GOLD_TB_RULES,
      { afterBars, ifMFE: mfeBelow, action: 'close_below' },
    ];

    const result = await runSingle(engine, data, baseConfig, rules);
    const pnlDelta = result.pnl - baseline.pnl;
    const wrDelta = result.winRate - baseline.winRate;
    const tradeDelta = result.trades - baseline.trades;

    results.push({
      afterBars,
      mfeBelow,
      label,
      ...result,
      pnlDelta,
      wrDelta,
      tradeDelta,
    });

    const deltaStr = pnlDelta >= 0 ? `+$${pnlDelta.toFixed(0)}` : `-$${Math.abs(pnlDelta).toFixed(0)}`;
    console.log(`  [${runCount}/${totalRuns}] ${label.padEnd(22)} | ${result.trades} trades | WR: ${result.winRate.toFixed(1)}% (${wrDelta >= 0 ? '+' : ''}${wrDelta.toFixed(1)}) | PnL: ${fmtPnl(result.pnl)} (${deltaStr}) | PF: ${result.pf.toFixed(2)} | Sharpe: ${result.sharpe.toFixed(2)} | MaxDD: ${result.maxDD.toFixed(2)}% | MFE_TO: ${result.mfeTimeoutCount} | MH: ${result.mhCount}`);
  }
}

// ─── Phase 3: Summary ──────────────────────────────────────────────
console.log('\n' + '─'.repeat(80));
console.log('PHASE 3: RANKED RESULTS (by PnL)');
console.log('─'.repeat(80));

results.sort((a, b) => b.pnl - a.pnl);

console.log(`${'Rank'.padEnd(5)} ${'Rule'.padEnd(22)} ${'Trades'.padEnd(8)} ${'WR'.padEnd(8)} ${'PnL'.padEnd(12)} ${'Delta'.padEnd(10)} ${'PF'.padEnd(7)} ${'Sharpe'.padEnd(8)} ${'MaxDD'.padEnd(8)} ${'MFE_TO'.padEnd(8)} ${'MH'.padEnd(5)}`);
console.log('─'.repeat(110));

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const deltaStr = r.pnlDelta >= 0 ? `+$${r.pnlDelta.toFixed(0)}` : `-$${Math.abs(r.pnlDelta).toFixed(0)}`;
  console.log(`${(i + 1 + '.').padEnd(5)} ${r.label.padEnd(22)} ${String(r.trades).padEnd(8)} ${r.winRate.toFixed(1).padEnd(8)} ${fmtPnl(r.pnl).padEnd(12)} ${deltaStr.padEnd(10)} ${r.pf.toFixed(2).padEnd(7)} ${r.sharpe.toFixed(2).padEnd(8)} ${r.maxDD.toFixed(2).padEnd(8)} ${String(r.mfeTimeoutCount).padEnd(8)} ${r.mhCount}`);
}

console.log('\nBaseline: ' + `${baseline.trades} trades | WR: ${baseline.winRate.toFixed(1)}% | PnL: ${fmtPnl(baseline.pnl)} | PF: ${baseline.pf.toFixed(2)} | Sharpe: ${baseline.sharpe.toFixed(2)} | MaxDD: ${baseline.maxDD.toFixed(2)}%`);

// Save results
const output = {
  timestamp: new Date().toISOString(),
  baseConfig: {
    stopLossPoints: 80,
    targetPoints: 120,
    maxHoldBars: 60,
    tbRules: GOLD_TB_RULES,
  },
  baseline,
  results: results.map(r => ({ afterBars: r.afterBars, mfeBelow: r.mfeBelow, ...r })),
};
fs.writeFileSync(path.join(OUTPUT_DIR, 'close-below-sweep.json'), JSON.stringify(output, null, 2));
console.log(`\nResults saved to research/output/close-below-sweep.json`);
