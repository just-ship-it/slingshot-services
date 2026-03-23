#!/usr/bin/env node
/**
 * Combined Trailing Stop Sweep — Time-Based + Near-Target MFE Ratchet
 *
 * Tests whether adding a single high-threshold MFE ratchet tier ON TOP OF
 * the gold standard time-based trailing rules can reduce profit giveback
 * without destroying PnL.
 *
 * The key insight: prior sweeps showed ratchet-alone destroys PnL ($185K vs $315K)
 * because low-MFE tiers clip winners too early. The combined mode only adds
 * ratchet tiers that activate near the target (45-60pt MFE on a 70pt target).
 *
 * Phase 1: Quantify the problem (baseline MFE/giveback analysis)
 * Phase 2: Sweep single near-target ratchet tiers (combined with time-based)
 * Phase 3: Sweep target widening with the winning ratchet tier
 *
 * Usage:
 *   node scripts/sweep-combined-trailing.js
 *   node scripts/sweep-combined-trailing.js --phase 1
 *   node scripts/sweep-combined-trailing.js --phase 2
 *   node scripts/sweep-combined-trailing.js --phase 3
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

// Parse CLI
const args = process.argv.slice(2);
let phaseFilter = 0; // 0 = all
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--phase') phaseFilter = parseInt(args[++i]);
}

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const resultsFile = path.join(OUTPUT_DIR, 'combined-trailing-sweep.json');

// Gold standard time-based trailing rules
const GOLD_TB_RULES = [
  { afterBars: 20, ifMFE: 35, trailDistance: 20 },
  { afterBars: 35, ifMFE: 50, trailDistance: 10 },
];

// ═══════════════════════════════════════════════════════════════════════
// Helper: Run a single simulation
// ═══════════════════════════════════════════════════════════════════════

async function runSingle(engine, data, baseConfig, strategyParams, trailConfig) {
  const mergedParams = {
    ...baseConfig.strategyParams,
    ...strategyParams,
  };
  if (strategyParams.targetPoints !== undefined) {
    mergedParams.takeProfitPoints = strategyParams.targetPoints;
  }

  engine.strategy = engine.createStrategy('iv-skew-gex', mergedParams);

  engine.config.strategyParams = {
    ...mergedParams,
    mfeRatchet: trailConfig.mfeRatchet?.enabled || false,
    mfeRatchetTiers: trailConfig.mfeRatchet?.tiers || undefined,
    timeBasedTrailing: trailConfig.timeBasedTrailing?.enabled || false,
    timeBasedTrailingConfig: trailConfig.timeBasedTrailing?.enabled
      ? { rules: trailConfig.timeBasedTrailing.rules }
      : undefined,
  };

  const simConfig = {
    commission: baseConfig.commission,
    slippage: engine.tradeSimulator.config.slippage,
    contractSpecs: engine.tradeSimulator.config.contractSpecs,
    forceCloseAtMarketClose: mergedParams.forceCloseAtMarketClose ?? engine.tradeSimulator.config.forceCloseAtMarketClose,
    marketCloseTimeUTC: mergedParams.marketCloseTimeUTC ?? engine.tradeSimulator.config.marketCloseTimeUTC,
    ...trailConfig,
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
  let tpCount = 0, slCount = 0, mhCount = 0, mcCount = 0, trailCount = 0;
  for (const t of simResults.trades) {
    const r = (t.exitReason || '').toLowerCase();
    if (r.includes('take_profit') || r.includes('take profit')) tpCount++;
    else if (r.includes('trailing') || r.includes('ratchet')) trailCount++;
    else if (r.includes('stop_loss') || r.includes('stop loss')) slCount++;
    else if (r.includes('max_hold') || r.includes('max hold')) mhCount++;
    else if (r.includes('market_close') || r.includes('market close')) mcCount++;
  }

  // MFE/giveback analysis
  let totalMFE = 0, totalGiveback = 0, mfeCount = 0;
  let highMFELosses = 0; // trades with MFE >= 50 that still lost
  let avgDuration = 0;
  for (const t of simResults.trades) {
    if (t.mfePoints != null) {
      totalMFE += t.mfePoints;
      mfeCount++;
      if (t.mfePoints >= 50 && t.netPnL < 0) highMFELosses++;
    }
    if (t.profitGiveBack != null) totalGiveback += t.profitGiveBack;
    if (t.entryTime && t.exitTime) {
      avgDuration += (new Date(t.exitTime) - new Date(t.entryTime)) / 60000; // minutes
    }
  }

  return {
    trades, winRate, pnl, pf, expectancy, maxDD, sharpe,
    tpCount, slCount, trailCount, mhCount, mcCount,
    avgMFE: mfeCount > 0 ? totalMFE / mfeCount : 0,
    avgGiveback: mfeCount > 0 ? totalGiveback / mfeCount : 0,
    highMFELosses,
    avgDurationMin: trades > 0 ? avgDuration / trades : 0,
    rawTrades: simResults.trades,
  };
}

function fmtPnl(pnl) {
  return pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
}

// ═══════════════════════════════════════════════════════════════════════
// Load data once
// ═══════════════════════════════════════════════════════════════════════

console.log('═'.repeat(80));
console.log('COMBINED TRAILING STOP SWEEP — Time-Based + Near-Target MFE Ratchet');
console.log('═'.repeat(80));
console.log(`Date range: ${start} → ${end}`);
console.log(`Phase: ${phaseFilter === 0 ? 'All' : phaseFilter}`);
console.log(`TB rules: ${GOLD_TB_RULES.map(r => `bars>=${r.afterBars},MFE>=${r.ifMFE},trail:${r.trailDistance}`).join(' | ')}\n`);

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
    stopLossPoints: 70,
    targetPoints: 70,
  },
  quiet: true,
};

const engine = new BacktestEngine(baseConfig);
const data = await engine.loadData();

console.log('Data loaded.\n');

const allResults = { phase1: null, phase2: [], phase3: [] };

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Baseline analysis — Quantify the MFE/giveback problem
// ═══════════════════════════════════════════════════════════════════════

let baselinePnl = 0;

if (phaseFilter === 0 || phaseFilter === 1) {
  console.log('═'.repeat(80));
  console.log('PHASE 1: Baseline Analysis — Quantify the MFE/Giveback Problem');
  console.log('═'.repeat(80));

  const trailConfig = {
    mfeRatchet: { enabled: false },
    timeBasedTrailing: { enabled: true, rules: GOLD_TB_RULES },
  };

  const result = await runSingle(engine, data, baseConfig, {
    maxHoldBars: 60, stopLossPoints: 70, targetPoints: 70,
  }, trailConfig);

  baselinePnl = result.pnl;

  // Analyze MFE distribution
  const trades = result.rawTrades;
  const mfeBuckets = { '0-20': 0, '20-40': 0, '40-50': 0, '50-60': 0, '60-65': 0, '65-70': 0, '70+': 0 };
  let givebackOn50PlusMFE = 0, countWith50PlusMFE = 0;
  let winnersAbove50MFE = 0, losersAbove50MFE = 0;
  let totalDurationTP = 0, countTP = 0;
  let totalDurationTrail = 0, countTrail = 0;

  for (const t of trades) {
    const mfe = t.mfePoints ?? 0;
    if (mfe < 20) mfeBuckets['0-20']++;
    else if (mfe < 40) mfeBuckets['20-40']++;
    else if (mfe < 50) mfeBuckets['40-50']++;
    else if (mfe < 60) mfeBuckets['50-60']++;
    else if (mfe < 65) mfeBuckets['60-65']++;
    else if (mfe < 70) mfeBuckets['65-70']++;
    else mfeBuckets['70+']++;

    if (mfe >= 50) {
      countWith50PlusMFE++;
      givebackOn50PlusMFE += t.profitGiveBack ?? 0;
      if (t.netPnL > 0) winnersAbove50MFE++;
      else losersAbove50MFE++;
    }

    const dur = (t.entryTime && t.exitTime)
      ? (new Date(t.exitTime) - new Date(t.entryTime)) / 60000
      : 0;
    const r = (t.exitReason || '').toLowerCase();
    if (r.includes('take_profit')) { totalDurationTP += dur; countTP++; }
    else if (r.includes('trailing')) { totalDurationTrail += dur; countTrail++; }
  }

  console.log(`\n  Total trades: ${result.trades}`);
  console.log(`  Total PnL: $${result.pnl.toLocaleString()}`);
  console.log(`  Win Rate: ${result.winRate.toFixed(1)}%`);
  console.log(`  Profit Factor: ${result.pf.toFixed(2)}`);
  console.log(`  Sharpe: ${result.sharpe.toFixed(2)}`);
  console.log(`  Max DD: ${result.maxDD.toFixed(2)}%`);
  console.log(`  Avg MFE: ${result.avgMFE.toFixed(1)} pts`);
  console.log(`  Avg Giveback: ${result.avgGiveback.toFixed(1)} pts`);
  console.log(`  Avg Duration: ${result.avgDurationMin.toFixed(1)} min`);
  console.log(`  Exits: TP=${result.tpCount} Trail=${result.trailCount} SL=${result.slCount} MH=${result.mhCount} MC=${result.mcCount}`);

  console.log(`\n  MFE Distribution:`);
  for (const [bucket, count] of Object.entries(mfeBuckets)) {
    const pct = ((count / result.trades) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(count / 5));
    console.log(`    ${bucket.padEnd(6)} pts: ${String(count).padStart(4)} (${pct.padStart(5)}%) ${bar}`);
  }

  console.log(`\n  Trades with MFE >= 50pts: ${countWith50PlusMFE} (${((countWith50PlusMFE / result.trades) * 100).toFixed(1)}%)`);
  console.log(`    Winners: ${winnersAbove50MFE}, Losers: ${losersAbove50MFE}`);
  console.log(`    Avg giveback when MFE >= 50: ${countWith50PlusMFE > 0 ? (givebackOn50PlusMFE / countWith50PlusMFE).toFixed(1) : 'N/A'} pts`);
  console.log(`    Avg TP duration: ${countTP > 0 ? (totalDurationTP / countTP).toFixed(1) : 'N/A'} min`);
  console.log(`    Avg Trailing exit duration: ${countTrail > 0 ? (totalDurationTrail / countTrail).toFixed(1) : 'N/A'} min`);

  allResults.phase1 = {
    trades: result.trades, winRate: result.winRate, pnl: result.pnl,
    pf: result.pf, sharpe: result.sharpe, maxDD: result.maxDD,
    avgMFE: result.avgMFE, avgGiveback: result.avgGiveback,
    avgDurationMin: result.avgDurationMin,
    tpCount: result.tpCount, trailCount: result.trailCount,
    slCount: result.slCount, mhCount: result.mhCount,
    mfeBuckets, countWith50PlusMFE, winnersAbove50MFE, losersAbove50MFE,
    avgGivebackAbove50: countWith50PlusMFE > 0 ? givebackOn50PlusMFE / countWith50PlusMFE : 0,
  };

  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Sweep single near-target ratchet tiers (combined with TB)
// ═══════════════════════════════════════════════════════════════════════

if (phaseFilter === 0 || phaseFilter === 2) {
  console.log('═'.repeat(80));
  console.log('PHASE 2: Combined Mode — Time-Based + Single Near-Target Ratchet Tier');
  console.log('═'.repeat(80));

  const tierConfigs = [
    { minMFE: 45, lockPct: 0.80 },
    { minMFE: 45, lockPct: 0.85 },
    { minMFE: 45, lockPct: 0.90 },
    { minMFE: 50, lockPct: 0.80 },
    { minMFE: 50, lockPct: 0.85 },
    { minMFE: 50, lockPct: 0.90 },
    { minMFE: 55, lockPct: 0.80 },
    { minMFE: 55, lockPct: 0.85 },
    { minMFE: 55, lockPct: 0.90 },
    { minMFE: 60, lockPct: 0.85 },
    { minMFE: 60, lockPct: 0.90 },
  ];

  const totalRuns = tierConfigs.length + 1; // +1 for baseline
  console.log(`${totalRuns} runs (1 baseline + ${tierConfigs.length} combined configs)\n`);

  const sweepStart = Date.now();
  let runNum = 0;

  // Run baseline (time-based only) for comparison
  runNum++;
  const baselineResult = await runSingle(engine, data, baseConfig,
    { maxHoldBars: 60, stopLossPoints: 70, targetPoints: 70 },
    { mfeRatchet: { enabled: false }, timeBasedTrailing: { enabled: true, rules: GOLD_TB_RULES } }
  );
  if (!baselinePnl) baselinePnl = baselineResult.pnl;

  console.log(
    `[ ${String(runNum).padStart(2)}/${totalRuns}] BASELINE (TB only)          | ` +
    `${String(baselineResult.trades).padStart(3)} tr | WR=${baselineResult.winRate.toFixed(1).padStart(5)}% | ` +
    `PF=${baselineResult.pf.toFixed(2).padStart(5)} | ${fmtPnl(baselineResult.pnl).padStart(9)} | ` +
    `Sharpe=${baselineResult.sharpe.toFixed(1)} | DD=${baselineResult.maxDD.toFixed(1)}% | ` +
    `MFE=${baselineResult.avgMFE.toFixed(0)} GB=${baselineResult.avgGiveback.toFixed(0)} Dur=${baselineResult.avgDurationMin.toFixed(0)}min | ` +
    `TP=${baselineResult.tpCount} Trail=${baselineResult.trailCount} SL=${baselineResult.slCount}`
  );
  console.log('');

  // Run each combined config
  for (const tc of tierConfigs) {
    runNum++;
    const tier = { ...tc, label: `lock ${Math.round(tc.lockPct * 100)}%` };

    const trailConfig = {
      mfeRatchet: { enabled: true, tiers: [tier] },
      timeBasedTrailing: { enabled: true, rules: GOLD_TB_RULES },
    };

    const result = await runSingle(engine, data, baseConfig,
      { maxHoldBars: 60, stopLossPoints: 70, targetPoints: 70 },
      trailConfig
    );

    const pnlDelta = result.pnl - baselinePnl;
    const label = `MFE>=${tc.minMFE} lock ${Math.round(tc.lockPct * 100)}%`;

    console.log(
      `[ ${String(runNum).padStart(2)}/${totalRuns}] ${label.padEnd(22)} | ` +
      `${String(result.trades).padStart(3)} tr | WR=${result.winRate.toFixed(1).padStart(5)}% | ` +
      `PF=${result.pf.toFixed(2).padStart(5)} | ${fmtPnl(result.pnl).padStart(9)} (${fmtPnl(pnlDelta)}) | ` +
      `Sharpe=${result.sharpe.toFixed(1)} | DD=${result.maxDD.toFixed(1)}% | ` +
      `MFE=${result.avgMFE.toFixed(0)} GB=${result.avgGiveback.toFixed(0)} Dur=${result.avgDurationMin.toFixed(0)}min | ` +
      `TP=${result.tpCount} Trail=${result.trailCount} SL=${result.slCount}`
    );

    allResults.phase2.push({
      minMFE: tc.minMFE, lockPct: tc.lockPct,
      trades: result.trades, winRate: result.winRate, pnl: result.pnl,
      pf: result.pf, sharpe: result.sharpe, maxDD: result.maxDD,
      avgMFE: result.avgMFE, avgGiveback: result.avgGiveback,
      avgDurationMin: result.avgDurationMin,
      tpCount: result.tpCount, trailCount: result.trailCount,
      slCount: result.slCount, mhCount: result.mhCount,
      highMFELosses: result.highMFELosses,
      pnlDelta,
    });
  }

  // Print Phase 2 summary sorted by PnL
  console.log('\n' + '─'.repeat(80));
  console.log('PHASE 2 RESULTS — SORTED BY P&L');
  console.log('─'.repeat(80));
  const sorted = [...allResults.phase2].sort((a, b) => b.pnl - a.pnl);
  console.log(`${'Config'.padEnd(22)} | ${'PnL'.padStart(9)} | ${'Δ Base'.padStart(8)} | ${'WR%'.padStart(5)} | ${'PF'.padStart(5)} | ${'Sharpe'.padStart(6)} | ${'DD%'.padStart(5)} | ${'AvgGB'.padStart(5)} | ${'Dur'.padStart(4)} | ${'TP'.padStart(3)} ${'Trail'.padStart(5)} ${'SL'.padStart(3)}`);
  console.log('─'.repeat(120));
  console.log(`${'BASELINE (TB only)'.padEnd(22)} | ${fmtPnl(baselinePnl).padStart(9)} | ${'--'.padStart(8)} | ${baselineResult.winRate.toFixed(1).padStart(5)} | ${baselineResult.pf.toFixed(2).padStart(5)} | ${baselineResult.sharpe.toFixed(1).padStart(6)} | ${baselineResult.maxDD.toFixed(1).padStart(5)} | ${baselineResult.avgGiveback.toFixed(0).padStart(5)} | ${baselineResult.avgDurationMin.toFixed(0).padStart(4)} | ${String(baselineResult.tpCount).padStart(3)} ${String(baselineResult.trailCount).padStart(5)} ${String(baselineResult.slCount).padStart(3)}`);
  for (const r of sorted) {
    const label = `MFE>=${r.minMFE} lock ${Math.round(r.lockPct * 100)}%`;
    console.log(`${label.padEnd(22)} | ${fmtPnl(r.pnl).padStart(9)} | ${fmtPnl(r.pnlDelta).padStart(8)} | ${r.winRate.toFixed(1).padStart(5)} | ${r.pf.toFixed(2).padStart(5)} | ${r.sharpe.toFixed(1).padStart(6)} | ${r.maxDD.toFixed(1).padStart(5)} | ${r.avgGiveback.toFixed(0).padStart(5)} | ${r.avgDurationMin.toFixed(0).padStart(4)} | ${String(r.tpCount).padStart(3)} ${String(r.trailCount).padStart(5)} ${String(r.slCount).padStart(3)}`);
  }

  const totalTime = ((Date.now() - sweepStart) / 1000).toFixed(1);
  console.log(`\nPhase 2 completed in ${totalTime}s\n`);
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Target widening with best ratchet tier from Phase 2
// ═══════════════════════════════════════════════════════════════════════

if (phaseFilter === 0 || phaseFilter === 3) {
  console.log('═'.repeat(80));
  console.log('PHASE 3: Target Widening with Best Ratchet Tier');
  console.log('═'.repeat(80));

  // Find best tier from Phase 2 (highest PnL), or use a sensible default
  let bestTier = { minMFE: 55, lockPct: 0.85 };
  if (allResults.phase2.length > 0) {
    const best = allResults.phase2.sort((a, b) => b.pnl - a.pnl)[0];
    bestTier = { minMFE: best.minMFE, lockPct: best.lockPct };
  }
  console.log(`Using best tier from Phase 2: MFE>=${bestTier.minMFE}, lock ${Math.round(bestTier.lockPct * 100)}%\n`);

  const targets = [70, 80, 90, 100, 120];
  const modes = ['tbOnly', 'combined'];
  const totalRuns = targets.length * modes.length;
  console.log(`${targets.length} targets × ${modes.length} modes = ${totalRuns} runs\n`);

  const sweepStart = Date.now();
  let runNum = 0;

  for (const target of targets) {
    for (const mode of modes) {
      runNum++;
      const tier = { ...bestTier, label: `lock ${Math.round(bestTier.lockPct * 100)}%` };

      const trailConfig = mode === 'combined'
        ? { mfeRatchet: { enabled: true, tiers: [tier] }, timeBasedTrailing: { enabled: true, rules: GOLD_TB_RULES } }
        : { mfeRatchet: { enabled: false }, timeBasedTrailing: { enabled: true, rules: GOLD_TB_RULES } };

      const result = await runSingle(engine, data, baseConfig,
        { maxHoldBars: 60, stopLossPoints: 70, targetPoints: target },
        trailConfig
      );

      const label = mode === 'combined'
        ? `T:${target} combined`
        : `T:${target} TB-only`;

      console.log(
        `[${String(runNum).padStart(2)}/${totalRuns}] ${label.padEnd(18)} | ` +
        `${String(result.trades).padStart(3)} tr | WR=${result.winRate.toFixed(1).padStart(5)}% | ` +
        `PF=${result.pf.toFixed(2).padStart(5)} | ${fmtPnl(result.pnl).padStart(9)} | ` +
        `Sharpe=${result.sharpe.toFixed(1)} | DD=${result.maxDD.toFixed(1)}% | ` +
        `GB=${result.avgGiveback.toFixed(0)} Dur=${result.avgDurationMin.toFixed(0)}min | ` +
        `TP=${result.tpCount} Trail=${result.trailCount} SL=${result.slCount}`
      );

      allResults.phase3.push({
        target, mode,
        minMFE: bestTier.minMFE, lockPct: bestTier.lockPct,
        trades: result.trades, winRate: result.winRate, pnl: result.pnl,
        pf: result.pf, sharpe: result.sharpe, maxDD: result.maxDD,
        avgMFE: result.avgMFE, avgGiveback: result.avgGiveback,
        avgDurationMin: result.avgDurationMin,
        tpCount: result.tpCount, trailCount: result.trailCount,
        slCount: result.slCount, mhCount: result.mhCount,
      });
    }
    console.log('');
  }

  const totalTime = ((Date.now() - sweepStart) / 1000).toFixed(1);
  console.log(`Phase 3 completed in ${totalTime}s\n`);
}

// Save results
fs.writeFileSync(resultsFile, JSON.stringify(allResults, null, 2));
console.log(`Results saved to ${resultsFile}`);
