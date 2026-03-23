#!/usr/bin/env node
/**
 * Time-Based Trailing Stop Parameter Sweep v2
 *
 * Post phantom-stop fix: the backtest now correctly exits at market price
 * when a trailing stop crosses through current price. This means old TB
 * parameters are invalid and need re-optimization.
 *
 * Baseline (no trailing): $297,919 PnL, 69% WR, 17.6 Sharpe
 * Old TB rules (now realistic): $273,172 — WORSE than no trailing
 *
 * Sweeps:
 * Phase 1: Single-rule sweep (find best standalone rule)
 * Phase 2: Two-rule combinations (best rule 1 + various rule 2)
 * Phase 3: Target/stop widening with winning TB config
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

const args = process.argv.slice(2);
let phaseFilter = 0;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--phase') phaseFilter = parseInt(args[++i]);
}

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const resultsFile = path.join(OUTPUT_DIR, 'tb-trailing-sweep-v2.json');

// ═══════════════════════════════════════════════════════════════════════

async function runSingle(engine, data, baseConfig, strategyParams, tbRules) {
  const mergedParams = { ...baseConfig.strategyParams, ...strategyParams };
  if (strategyParams.targetPoints !== undefined) {
    mergedParams.takeProfitPoints = strategyParams.targetPoints;
  }

  engine.strategy = engine.createStrategy('iv-skew-gex', mergedParams);

  const hasTB = tbRules && tbRules.length > 0;
  engine.config.strategyParams = {
    ...mergedParams,
    timeBasedTrailing: hasTB,
    timeBasedTrailingConfig: hasTB ? { rules: tbRules } : undefined,
    mfeRatchet: false,
  };

  const simConfig = {
    commission: baseConfig.commission,
    slippage: engine.tradeSimulator.config.slippage,
    contractSpecs: engine.tradeSimulator.config.contractSpecs,
    forceCloseAtMarketClose: mergedParams.forceCloseAtMarketClose ?? engine.tradeSimulator.config.forceCloseAtMarketClose,
    marketCloseTimeUTC: mergedParams.marketCloseTimeUTC ?? engine.tradeSimulator.config.marketCloseTimeUTC,
    timeBasedTrailing: hasTB ? { enabled: true, rules: tbRules } : { enabled: false },
  };
  engine.tradeSimulator = new TradeSimulator(simConfig);

  const simResults = await engine.runSimulation(data);
  const perf = engine.performanceCalculator.calculateMetrics(
    simResults.trades, simResults.equityCurve, baseConfig.startDate, baseConfig.endDate
  );

  let tpCount = 0, slCount = 0, trailCount = 0, mhCount = 0, mcCount = 0;
  let totalGiveback = 0, gbCount = 0;
  let avgDuration = 0;
  for (const t of simResults.trades) {
    const r = (t.exitReason || '').toLowerCase();
    if (r.includes('take_profit')) tpCount++;
    else if (r.includes('trailing')) trailCount++;
    else if (r.includes('stop_loss')) slCount++;
    else if (r.includes('max_hold')) mhCount++;
    else if (r.includes('market_close')) mcCount++;
    if (t.profitGiveBack != null) { totalGiveback += t.profitGiveBack; gbCount++; }
    if (t.entryTime && t.exitTime) avgDuration += (new Date(t.exitTime) - new Date(t.entryTime)) / 60000;
  }

  return {
    trades: perf.summary.totalTrades || 0,
    winRate: perf.summary.winRate || 0,
    pnl: perf.summary.totalPnL || 0,
    pf: perf.basic.profitFactor || 0,
    sharpe: perf.summary.sharpeRatio || 0,
    maxDD: perf.summary.maxDrawdown || 0,
    expectancy: perf.basic.expectancy || 0,
    tpCount, slCount, trailCount, mhCount, mcCount,
    avgGiveback: gbCount > 0 ? totalGiveback / gbCount : 0,
    avgDurationMin: (perf.summary.totalTrades || 1) > 0 ? avgDuration / (perf.summary.totalTrades || 1) : 0,
  };
}

function fmtPnl(pnl) {
  return pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
}

function ruleStr(rules) {
  if (!rules || rules.length === 0) return 'NONE';
  return rules.map(r => {
    const action = r.action === 'breakeven' ? 'BE' : `T:${r.trailDistance}`;
    return `${r.afterBars}b/${r.ifMFE}m/${action}`;
  }).join(' + ');
}

// ═══════════════════════════════════════════════════════════════════════

console.log('═'.repeat(80));
console.log('TIME-BASED TRAILING SWEEP v2 — Post Phantom Stop Fix');
console.log('═'.repeat(80));
console.log(`Date range: ${start} → ${end}`);
console.log(`Phase: ${phaseFilter === 0 ? 'All' : phaseFilter}\n`);
console.log('Loading data...\n');

const baseConfig = {
  ticker: 'NQ', strategy: 'iv-skew-gex', timeframe: '1m',
  noContinuous: true,
  startDate: new Date(start), endDate: new Date(end),
  dataDir: DATA_DIR, initialCapital: 100000, commission: 5,
  strategyParams: { maxHoldBars: 60, stopLossPoints: 70, targetPoints: 70 },
  quiet: true,
};

const engine = new BacktestEngine(baseConfig);
const data = await engine.loadData();
console.log('Data loaded.\n');

const allResults = { baseline: null, phase1: [], phase2: [], phase3: [] };
let baselinePnl = 0;

// ═══════════════════════════════════════════════════════════════════════
// Baseline: No trailing
// ═══════════════════════════════════════════════════════════════════════

console.log('═'.repeat(80));
console.log('BASELINE: No Trailing (TP/SL/MaxHold only)');
console.log('═'.repeat(80));

const baseline = await runSingle(engine, data, baseConfig,
  { maxHoldBars: 60, stopLossPoints: 70, targetPoints: 70 }, []);
baselinePnl = baseline.pnl;

console.log(`  Trades: ${baseline.trades} | PnL: ${fmtPnl(baseline.pnl)} | WR: ${baseline.winRate.toFixed(1)}% | PF: ${baseline.pf.toFixed(2)} | Sharpe: ${baseline.sharpe.toFixed(1)} | DD: ${baseline.maxDD.toFixed(1)}%`);
console.log(`  TP=${baseline.tpCount} SL=${baseline.slCount} Trail=${baseline.trailCount} MH=${baseline.mhCount} | GB=${baseline.avgGiveback.toFixed(0)} Dur=${baseline.avgDurationMin.toFixed(0)}min`);
allResults.baseline = baseline;
fs.writeFileSync(resultsFile, JSON.stringify(allResults, null, 2));
console.log('  (results saved)\n');

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Single-rule sweep
// ═══════════════════════════════════════════════════════════════════════

if (phaseFilter === 0 || phaseFilter === 1) {
  console.log('═'.repeat(80));
  console.log('PHASE 1: Single-Rule Sweep');
  console.log('═'.repeat(80));

  const afterBarsOptions = [5, 10, 15, 20, 25, 30, 35, 40];
  const ifMFEOptions = [20, 30, 35, 40, 50];
  const actionOptions = [
    { action: 'breakeven' },
    { trailDistance: 25 },
    { trailDistance: 20 },
    { trailDistance: 15 },
    { trailDistance: 10 },
    { trailDistance: 5 },
  ];

  const configs = [];
  for (const bars of afterBarsOptions) {
    for (const mfe of ifMFEOptions) {
      // MFE threshold shouldn't exceed realistic range
      if (mfe > 50) continue;
      for (const act of actionOptions) {
        // Trail distance shouldn't exceed MFE (meaningless)
        if (act.trailDistance && act.trailDistance >= mfe) continue;
        configs.push({ afterBars: bars, ifMFE: mfe, ...act });
      }
    }
  }

  console.log(`${configs.length} single-rule configurations to test\n`);

  const sweepStart = Date.now();
  for (let i = 0; i < configs.length; i++) {
    const rule = configs[i];
    const result = await runSingle(engine, data, baseConfig,
      { maxHoldBars: 60, stopLossPoints: 70, targetPoints: 70 }, [rule]);

    const delta = result.pnl - baselinePnl;
    const label = ruleStr([rule]);

    if ((i + 1) % 20 === 0 || i === configs.length - 1) {
      const elapsed = ((Date.now() - sweepStart) / 1000).toFixed(0);
      console.log(`  [${i + 1}/${configs.length}] (${elapsed}s) ...`);
    }

    allResults.phase1.push({ rule, label, ...result, pnlDelta: delta });
  }

  // Print top 20 by PnL
  const sorted = [...allResults.phase1].sort((a, b) => b.pnl - a.pnl);
  console.log('\n' + '─'.repeat(120));
  console.log('PHASE 1 TOP 20 — SORTED BY P&L');
  console.log('─'.repeat(120));
  console.log(`${'Rule'.padEnd(24)} | ${'PnL'.padStart(9)} | ${'Δ Base'.padStart(8)} | ${'WR%'.padStart(5)} | ${'PF'.padStart(5)} | ${'Sharpe'.padStart(6)} | ${'DD%'.padStart(5)} | ${'GB'.padStart(3)} | ${'Dur'.padStart(4)} | ${'TP'.padStart(3)} ${'Trail'.padStart(5)} ${'SL'.padStart(3)} ${'MH'.padStart(3)}`);
  console.log('─'.repeat(120));
  console.log(`${'BASELINE (no trail)'.padEnd(24)} | ${fmtPnl(baselinePnl).padStart(9)} | ${'--'.padStart(8)} | ${baseline.winRate.toFixed(1).padStart(5)} | ${baseline.pf.toFixed(2).padStart(5)} | ${baseline.sharpe.toFixed(1).padStart(6)} | ${baseline.maxDD.toFixed(1).padStart(5)} | ${baseline.avgGiveback.toFixed(0).padStart(3)} | ${baseline.avgDurationMin.toFixed(0).padStart(4)} | ${String(baseline.tpCount).padStart(3)} ${String(baseline.trailCount).padStart(5)} ${String(baseline.slCount).padStart(3)} ${String(baseline.mhCount).padStart(3)}`);
  for (const r of sorted.slice(0, 20)) {
    console.log(`${r.label.padEnd(24)} | ${fmtPnl(r.pnl).padStart(9)} | ${fmtPnl(r.pnlDelta).padStart(8)} | ${r.winRate.toFixed(1).padStart(5)} | ${r.pf.toFixed(2).padStart(5)} | ${r.sharpe.toFixed(1).padStart(6)} | ${r.maxDD.toFixed(1).padStart(5)} | ${r.avgGiveback.toFixed(0).padStart(3)} | ${r.avgDurationMin.toFixed(0).padStart(4)} | ${String(r.tpCount).padStart(3)} ${String(r.trailCount).padStart(5)} ${String(r.slCount).padStart(3)} ${String(r.mhCount).padStart(3)}`);
  }

  const totalTime = ((Date.now() - sweepStart) / 1000).toFixed(1);
  console.log(`\nPhase 1 completed in ${totalTime}s\n`);

  fs.writeFileSync(resultsFile, JSON.stringify(allResults, null, 2));
  console.log('  (results saved)\n');
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Two-rule combinations
// ═══════════════════════════════════════════════════════════════════════

if (phaseFilter === 0 || phaseFilter === 2) {
  console.log('═'.repeat(80));
  console.log('PHASE 2: Two-Rule Combinations');
  console.log('═'.repeat(80));

  // Use top 5 single rules from Phase 1 as rule 1, combine with various rule 2
  let topSingleRules;
  if (allResults.phase1.length > 0) {
    topSingleRules = [...allResults.phase1]
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 5)
      .map(r => r.rule);
  } else {
    // Default if Phase 1 wasn't run
    topSingleRules = [
      { afterBars: 15, ifMFE: 30, trailDistance: 15 },
      { afterBars: 10, ifMFE: 30, trailDistance: 15 },
      { afterBars: 20, ifMFE: 35, trailDistance: 15 },
      { afterBars: 15, ifMFE: 35, trailDistance: 20 },
      { afterBars: 10, ifMFE: 20, trailDistance: 10 },
    ];
  }

  // Rule 2 candidates: tighter trailing that activates later
  const rule2Candidates = [
    { afterBars: 25, ifMFE: 40, trailDistance: 15 },
    { afterBars: 25, ifMFE: 40, trailDistance: 10 },
    { afterBars: 25, ifMFE: 50, trailDistance: 15 },
    { afterBars: 25, ifMFE: 50, trailDistance: 10 },
    { afterBars: 30, ifMFE: 40, trailDistance: 15 },
    { afterBars: 30, ifMFE: 40, trailDistance: 10 },
    { afterBars: 30, ifMFE: 50, trailDistance: 15 },
    { afterBars: 30, ifMFE: 50, trailDistance: 10 },
    { afterBars: 35, ifMFE: 50, trailDistance: 10 },
    { afterBars: 35, ifMFE: 50, trailDistance: 5 },
    { afterBars: 40, ifMFE: 50, trailDistance: 10 },
    { afterBars: 40, ifMFE: 50, trailDistance: 5 },
  ];

  const configs = [];
  for (const r1 of topSingleRules) {
    for (const r2 of rule2Candidates) {
      // Rule 2 must be later/tighter than rule 1
      if (r2.afterBars <= r1.afterBars) continue;
      if (r2.trailDistance >= (r1.trailDistance || 999)) continue;
      configs.push([r1, r2]);
    }
  }

  console.log(`${configs.length} two-rule combinations to test\n`);

  const sweepStart = Date.now();
  for (let i = 0; i < configs.length; i++) {
    const rules = configs[i];
    const result = await runSingle(engine, data, baseConfig,
      { maxHoldBars: 60, stopLossPoints: 70, targetPoints: 70 }, rules);

    const delta = result.pnl - baselinePnl;
    const label = ruleStr(rules);

    if ((i + 1) % 10 === 0 || i === configs.length - 1) {
      const elapsed = ((Date.now() - sweepStart) / 1000).toFixed(0);
      console.log(`  [${i + 1}/${configs.length}] (${elapsed}s) ...`);
    }

    allResults.phase2.push({ rules, label, ...result, pnlDelta: delta });
  }

  // Print top 20 by PnL
  const sorted = [...allResults.phase2].sort((a, b) => b.pnl - a.pnl);
  console.log('\n' + '─'.repeat(140));
  console.log('PHASE 2 TOP 20 — SORTED BY P&L');
  console.log('─'.repeat(140));
  console.log(`${'Rules'.padEnd(50)} | ${'PnL'.padStart(9)} | ${'Δ Base'.padStart(8)} | ${'WR%'.padStart(5)} | ${'PF'.padStart(5)} | ${'Sharpe'.padStart(6)} | ${'DD%'.padStart(5)} | ${'GB'.padStart(3)} | ${'Dur'.padStart(4)} | ${'TP'.padStart(3)} ${'Trail'.padStart(5)} ${'SL'.padStart(3)} ${'MH'.padStart(3)}`);
  console.log('─'.repeat(140));
  console.log(`${'BASELINE (no trail)'.padEnd(50)} | ${fmtPnl(baselinePnl).padStart(9)} | ${'--'.padStart(8)} | ${baseline.winRate.toFixed(1).padStart(5)} | ${baseline.pf.toFixed(2).padStart(5)} | ${baseline.sharpe.toFixed(1).padStart(6)} | ${baseline.maxDD.toFixed(1).padStart(5)} | ${baseline.avgGiveback.toFixed(0).padStart(3)} | ${baseline.avgDurationMin.toFixed(0).padStart(4)} | ${String(baseline.tpCount).padStart(3)} ${String(baseline.trailCount).padStart(5)} ${String(baseline.slCount).padStart(3)} ${String(baseline.mhCount).padStart(3)}`);
  for (const r of sorted.slice(0, 20)) {
    console.log(`${r.label.padEnd(50)} | ${fmtPnl(r.pnl).padStart(9)} | ${fmtPnl(r.pnlDelta).padStart(8)} | ${r.winRate.toFixed(1).padStart(5)} | ${r.pf.toFixed(2).padStart(5)} | ${r.sharpe.toFixed(1).padStart(6)} | ${r.maxDD.toFixed(1).padStart(5)} | ${r.avgGiveback.toFixed(0).padStart(3)} | ${r.avgDurationMin.toFixed(0).padStart(4)} | ${String(r.tpCount).padStart(3)} ${String(r.trailCount).padStart(5)} ${String(r.slCount).padStart(3)} ${String(r.mhCount).padStart(3)}`);
  }

  const totalTime = ((Date.now() - sweepStart) / 1000).toFixed(1);
  console.log(`\nPhase 2 completed in ${totalTime}s\n`);

  fs.writeFileSync(resultsFile, JSON.stringify(allResults, null, 2));
  console.log('  (results saved)\n');
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Target/stop widening with best TB config
// ═══════════════════════════════════════════════════════════════════════

if (phaseFilter === 0 || phaseFilter === 3) {
  console.log('═'.repeat(80));
  console.log('PHASE 3: Target/Stop Widening with Best TB Config');
  console.log('═'.repeat(80));

  // Find best rules from Phase 2, or Phase 1, or use defaults
  let bestRules;
  if (allResults.phase2.length > 0) {
    bestRules = [...allResults.phase2].sort((a, b) => b.pnl - a.pnl)[0].rules;
  } else if (allResults.phase1.length > 0) {
    bestRules = [[...allResults.phase1].sort((a, b) => b.pnl - a.pnl)[0].rule];
  } else {
    bestRules = [
      { afterBars: 15, ifMFE: 30, trailDistance: 15 },
      { afterBars: 30, ifMFE: 50, trailDistance: 10 },
    ];
  }
  console.log(`Best TB rules: ${ruleStr(bestRules)}\n`);

  const targetStopConfigs = [
    { target: 70, stop: 70 },
    { target: 80, stop: 70 },
    { target: 90, stop: 70 },
    { target: 100, stop: 70 },
    { target: 120, stop: 70 },
    { target: 100, stop: 80 },
    { target: 100, stop: 90 },
    { target: 100, stop: 100 },
    { target: 120, stop: 80 },
    { target: 120, stop: 100 },
  ];

  const modes = ['noTrail', 'bestTB'];
  const totalRuns = targetStopConfigs.length * modes.length;
  console.log(`${totalRuns} runs\n`);

  const sweepStart = Date.now();
  let runNum = 0;

  for (const { target, stop } of targetStopConfigs) {
    for (const mode of modes) {
      runNum++;
      const rules = mode === 'bestTB' ? bestRules : [];
      const result = await runSingle(engine, data, baseConfig,
        { maxHoldBars: 60, stopLossPoints: stop, targetPoints: target }, rules);

      const label = `T:${target} SL:${stop} ${mode === 'bestTB' ? 'TB' : 'none'}`;
      console.log(
        `[${String(runNum).padStart(2)}/${totalRuns}] ${label.padEnd(22)} | ` +
        `${String(result.trades).padStart(3)} tr | WR=${result.winRate.toFixed(1).padStart(5)}% | ` +
        `PF=${result.pf.toFixed(2).padStart(5)} | ${fmtPnl(result.pnl).padStart(9)} | ` +
        `Sharpe=${result.sharpe.toFixed(1)} | DD=${result.maxDD.toFixed(1)}% | ` +
        `Dur=${result.avgDurationMin.toFixed(0)}min | ` +
        `TP=${result.tpCount} Trail=${result.trailCount} SL=${result.slCount} MH=${result.mhCount}`
      );

      allResults.phase3.push({
        target, stop, mode, rules: mode === 'bestTB' ? bestRules : null,
        ...result, pnlDelta: result.pnl - baselinePnl,
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
