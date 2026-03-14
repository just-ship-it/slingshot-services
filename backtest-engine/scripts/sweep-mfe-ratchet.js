#!/usr/bin/env node
/**
 * MFE Ratchet Parameter Sweep for IV-SKEW-GEX Strategy
 *
 * Tests whether wider targets + tuned MFE ratchet tiers can beat the
 * timeBased trailing baseline ($343,946 PnL, 90.12% WR, 405 trades).
 *
 * Phase 1: Sweep targetPoints with default ratchet tiers vs timeBased control
 * Phase 2: Tune tier configurations at best target from Phase 1
 *
 * Loads data ONCE (1m raw-contracts), reuses across all runs.
 *
 * Usage:
 *   node scripts/sweep-mfe-ratchet.js
 *   node scripts/sweep-mfe-ratchet.js --phase 1
 *   node scripts/sweep-mfe-ratchet.js --phase 2
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BacktestEngine } from '../src/backtest-engine.js';
import { IVSkewGexStrategy } from '../../shared/strategies/iv-skew-gex.js';
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
const resultsFile = path.join(OUTPUT_DIR, 'mfe-ratchet-sweep.json');

// Baseline reference (timeBased trailing, 70pt target)
const BASELINE = { trades: 405, winRate: 90.12, pnl: 343946, label: 'timeBased-70pt-baseline' };

// ═══════════════════════════════════════════════════════════════════════
// Helper: Run a single simulation
// ═══════════════════════════════════════════════════════════════════════

async function runSingle(engine, data, baseConfig, strategyParams, trailConfig) {
  // Merge strategy params — map targetPoints → takeProfitPoints for iv-skew-gex
  const mergedParams = {
    ...baseConfig.strategyParams,
    ...strategyParams,
  };
  if (strategyParams.targetPoints !== undefined) {
    mergedParams.takeProfitPoints = strategyParams.targetPoints;
  }

  // Create fresh strategy
  engine.strategy = engine.createStrategy('iv-skew-gex', mergedParams);

  // Update engine.config.strategyParams so signal augmentation (mfeRatchet, timeBased)
  // in runSimulation reads the correct flags
  engine.config.strategyParams = {
    ...mergedParams,
    mfeRatchet: trailConfig.mfeRatchet?.enabled || false,
    mfeRatchetTiers: trailConfig.mfeRatchet?.tiers || undefined,
    timeBasedTrailing: trailConfig.timeBasedTrailing?.enabled || false,
    timeBasedTrailingConfig: trailConfig.timeBasedTrailing?.enabled
      ? { rules: trailConfig.timeBasedTrailing.rules }
      : undefined,
  };

  // Create fresh trade simulator with the specified trailing config
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
  const avgWin = perf.basic.averageWin || 0;
  const avgLoss = perf.basic.averageLoss || 0;

  // Count exits by reason
  // Actual exit reason strings from TradeSimulator: 'take_profit', 'stop_loss', 'trailing_stop', 'max_hold_time', 'market_close'
  let tpCount = 0, slCount = 0, mhCount = 0, mcCount = 0, trailCount = 0, ratchetCount = 0;
  for (const t of simResults.trades) {
    const r = (t.exitReason || '').toLowerCase();
    if (r.includes('take_profit') || r.includes('take profit')) tpCount++;
    else if (r.includes('trailing_stop') || r.includes('trailing')) {
      // Check if it was a ratchet trailing stop (trailingStop.mode === 'mfeRatchet')
      if (t.trailingStop?.mode === 'mfeRatchet' || r.includes('ratchet')) ratchetCount++;
      else trailCount++;
    }
    else if (r.includes('stop_loss') || r.includes('stop loss')) slCount++;
    else if (r.includes('max_hold') || r.includes('max hold')) mhCount++;
    else if (r.includes('market_close') || r.includes('market close')) mcCount++;
  }

  return {
    trades, winRate, pnl, pf, expectancy, maxDD, sharpe,
    avgWin, avgLoss, tpCount, slCount, trailCount, ratchetCount, mhCount, mcCount,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Helper: Format PnL string
// ═══════════════════════════════════════════════════════════════════════

function fmtPnl(pnl) {
  return pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
}

function fmtTiers(tiers) {
  return tiers.map(t => `${t.minMFE}→${(t.lockPct * 100).toFixed(0)}%`).join(', ');
}

// ═══════════════════════════════════════════════════════════════════════
// Load data once
// ═══════════════════════════════════════════════════════════════════════

console.log('═'.repeat(80));
console.log('MFE RATCHET PARAMETER SWEEP — IV-SKEW-GEX');
console.log('═'.repeat(80));
console.log(`Date range: ${start} → ${end}`);
console.log(`Phase: ${phaseFilter === 0 ? 'All' : phaseFilter}`);
console.log(`Baseline: ${BASELINE.trades} trades, ${BASELINE.winRate}% WR, $${BASELINE.pnl.toLocaleString()} PnL (timeBased trailing)\n`);

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

// ═══════════════════════════════════════════════════════════════════════
// Default MFE ratchet tiers (from TradeSimulator)
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_TIERS = [
  { minMFE: 100, lockPct: 0.60, label: 'lock 60%' },
  { minMFE: 60,  lockPct: 0.50, label: 'lock 50%' },
  { minMFE: 40,  lockPct: 0.40, label: 'lock 40%' },
  { minMFE: 20,  lockPct: 0.25, label: 'lock 25%' },
];

// Default timeBased trailing rules (from BacktestEngine)
const DEFAULT_TIMEBASED_RULES = [
  { afterBars: 15, ifMFE: 20, action: 'breakeven' },
  { afterBars: 30, ifMFE: 30, trailDistance: 20 },
  { afterBars: 45, ifMFE: 40, trailDistance: 10 },
];

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Target widening with default ratchet tiers vs timeBased
// ═══════════════════════════════════════════════════════════════════════

let phase1Results = [];

if (phaseFilter === 0 || phaseFilter === 1) {
  console.log('═'.repeat(80));
  console.log('PHASE 1: Target Widening — MFE Ratchet (default tiers) vs timeBased');
  console.log('═'.repeat(80));

  const targetPoints = [70, 100, 130, 150, 200];
  const modes = ['mfeRatchet', 'timeBased', 'none'];

  const totalRuns = targetPoints.length * modes.length;
  console.log(`${targetPoints.length} targets × ${modes.length} modes = ${totalRuns} runs\n`);

  let runNum = 0;
  const sweepStart = Date.now();

  for (const target of targetPoints) {
    for (const mode of modes) {
      runNum++;

      const strategyParams = {
        maxHoldBars: 60,
        stopLossPoints: 70,
        targetPoints: target,
      };

      let trailConfig = {};
      let modeLabel = mode;

      if (mode === 'mfeRatchet') {
        trailConfig = {
          mfeRatchet: { enabled: true, tiers: DEFAULT_TIERS },
          timeBasedTrailing: { enabled: false },
        };
        modeLabel = `mfeRatchet(default)`;
      } else if (mode === 'timeBased') {
        trailConfig = {
          mfeRatchet: { enabled: false },
          timeBasedTrailing: { enabled: true, rules: DEFAULT_TIMEBASED_RULES },
        };
        modeLabel = `timeBased(default)`;
      } else {
        trailConfig = {
          mfeRatchet: { enabled: false },
          timeBasedTrailing: { enabled: false },
        };
        modeLabel = 'none(TP/SL only)';
      }

      try {
        const result = await runSingle(engine, data, baseConfig, strategyParams, trailConfig);
        const row = {
          phase: 1,
          target,
          mode,
          modeLabel,
          tiers: mode === 'mfeRatchet' ? DEFAULT_TIERS : null,
          ...result,
        };
        phase1Results.push(row);

        const elapsed = ((Date.now() - sweepStart) / 1000).toFixed(0);
        const pnlDelta = result.pnl - BASELINE.pnl;
        const deltaStr = pnlDelta >= 0 ? `+$${pnlDelta.toFixed(0)}` : `-$${Math.abs(pnlDelta).toFixed(0)}`;

        console.log(
          `[${String(runNum).padStart(2)}/${totalRuns}] (${elapsed}s) ` +
          `T:${String(target).padStart(3)} ${modeLabel.padEnd(22)} | ` +
          `${String(result.trades).padStart(3)} tr | WR=${result.winRate.toFixed(1).padStart(5)}% | ` +
          `PF=${result.pf.toFixed(2).padStart(5)} | ${fmtPnl(result.pnl).padStart(9)} | ` +
          `vs baseline: ${deltaStr} | ` +
          `exits: TP=${result.tpCount} SL=${result.slCount} Trail=${result.trailCount} Ratchet=${result.ratchetCount} MH=${result.mhCount} MC=${result.mcCount}`
        );
      } catch (err) {
        console.log(`[${String(runNum).padStart(2)}/${totalRuns}] ERROR: ${err.message.split('\n')[0]}`);
      }
    }
    console.log(''); // Blank line between target groups
  }

  const totalTime = ((Date.now() - sweepStart) / 1000).toFixed(1);
  console.log(`Phase 1 completed: ${totalRuns} runs in ${totalTime}s\n`);

  // Print Phase 1 summary table
  console.log('═'.repeat(130));
  console.log('PHASE 1 RESULTS — SORTED BY P&L');
  console.log('═'.repeat(130));
  console.log('Rank | Target |         Mode         | Trades | WinRate |   PF  |   Total P&L   |  vs Baseline  | MaxDD | Sharpe | TP  | SL  | Trail | Ratchet | MH  | MC');
  console.log('─'.repeat(130));

  const sorted = [...phase1Results].sort((a, b) => b.pnl - a.pnl);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const pnlDelta = r.pnl - BASELINE.pnl;
    const deltaStr = pnlDelta >= 0 ? `+$${pnlDelta.toFixed(0)}` : `-$${Math.abs(pnlDelta).toFixed(0)}`;
    console.log(
      `${String(i + 1).padStart(4)} | ${String(r.target).padStart(6)} | ${r.modeLabel.padEnd(20)} | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.pf.toFixed(2).padStart(5)} | ${fmtPnl(r.pnl).padStart(13)} | ${deltaStr.padStart(13)} | ${r.maxDD.toFixed(1).padStart(4)}% | ${r.sharpe.toFixed(2).padStart(5)}  | ${String(r.tpCount).padStart(3)} | ${String(r.slCount).padStart(3)} | ${String(r.trailCount).padStart(5)} | ${String(r.ratchetCount).padStart(7)} | ${String(r.mhCount).padStart(3)} | ${String(r.mcCount).padStart(2)}`
    );
  }

  // Save Phase 1 results
  fs.writeFileSync(resultsFile, JSON.stringify({ phase1: phase1Results, phase2: [] }, null, 2));
  console.log(`\nPhase 1 results saved to ${resultsFile}\n`);

  // Determine best target for Phase 2
  const bestMfeRatchet = phase1Results
    .filter(r => r.mode === 'mfeRatchet')
    .sort((a, b) => b.pnl - a.pnl)[0];

  if (bestMfeRatchet) {
    console.log(`Best MFE ratchet target: ${bestMfeRatchet.target}pts → $${bestMfeRatchet.pnl.toFixed(0)} (${bestMfeRatchet.winRate.toFixed(1)}% WR)`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Tier tuning at best target(s) from Phase 1
// ═══════════════════════════════════════════════════════════════════════

let phase2Results = [];

if (phaseFilter === 0 || phaseFilter === 2) {
  // Load Phase 1 results if running Phase 2 standalone
  if (phase1Results.length === 0 && fs.existsSync(resultsFile)) {
    const saved = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    phase1Results = saved.phase1 || [];
    console.log(`Loaded ${phase1Results.length} Phase 1 results from ${resultsFile}\n`);
  }

  if (phase1Results.length === 0) {
    console.error('No Phase 1 results found. Run Phase 1 first.');
    process.exit(1);
  }

  console.log('\n' + '═'.repeat(80));
  console.log('PHASE 2: MFE Ratchet Tier Tuning');
  console.log('═'.repeat(80));

  // Pick best 2 targets from mfeRatchet results in Phase 1
  const mfeResults = phase1Results.filter(r => r.mode === 'mfeRatchet').sort((a, b) => b.pnl - a.pnl);
  const testTargets = [...new Set(mfeResults.slice(0, 2).map(r => r.target))];

  // Tier configurations to test
  const tierConfigs = [
    {
      name: 'lower-thresholds-A',
      tiers: [
        { minMFE: 50, lockPct: 0.50, label: 'lock 50%' },
        { minMFE: 30, lockPct: 0.40, label: 'lock 40%' },
        { minMFE: 20, lockPct: 0.30, label: 'lock 30%' },
        { minMFE: 10, lockPct: 0.20, label: 'lock 20%' },
      ],
    },
    {
      name: 'lower-thresholds-B',
      tiers: [
        { minMFE: 60, lockPct: 0.55, label: 'lock 55%' },
        { minMFE: 40, lockPct: 0.45, label: 'lock 45%' },
        { minMFE: 25, lockPct: 0.35, label: 'lock 35%' },
        { minMFE: 10, lockPct: 0.20, label: 'lock 20%' },
      ],
    },
    {
      name: 'lower-thresholds-C',
      tiers: [
        { minMFE: 80, lockPct: 0.55, label: 'lock 55%' },
        { minMFE: 50, lockPct: 0.45, label: 'lock 45%' },
        { minMFE: 30, lockPct: 0.35, label: 'lock 35%' },
        { minMFE: 15, lockPct: 0.25, label: 'lock 25%' },
      ],
    },
    {
      name: 'higher-lock-pct',
      tiers: [
        { minMFE: 60, lockPct: 0.70, label: 'lock 70%' },
        { minMFE: 40, lockPct: 0.60, label: 'lock 60%' },
        { minMFE: 20, lockPct: 0.50, label: 'lock 50%' },
        { minMFE: 10, lockPct: 0.40, label: 'lock 40%' },
      ],
    },
    {
      name: 'aggressive',
      tiers: [
        { minMFE: 40, lockPct: 0.60, label: 'lock 60%' },
        { minMFE: 20, lockPct: 0.50, label: 'lock 50%' },
        { minMFE: 10, lockPct: 0.40, label: 'lock 40%' },
        { minMFE: 5,  lockPct: 0.30, label: 'lock 30%' },
      ],
    },
    {
      name: 'conservative',
      tiers: [
        { minMFE: 100, lockPct: 0.55, label: 'lock 55%' },
        { minMFE: 60,  lockPct: 0.45, label: 'lock 45%' },
        { minMFE: 40,  lockPct: 0.35, label: 'lock 35%' },
        { minMFE: 20,  lockPct: 0.20, label: 'lock 20%' },
      ],
    },
    {
      name: '2-tier-simple',
      tiers: [
        { minMFE: 40, lockPct: 0.55, label: 'lock 55%' },
        { minMFE: 15, lockPct: 0.35, label: 'lock 35%' },
      ],
    },
    {
      name: '3-tier',
      tiers: [
        { minMFE: 60, lockPct: 0.65, label: 'lock 65%' },
        { minMFE: 30, lockPct: 0.50, label: 'lock 50%' },
        { minMFE: 10, lockPct: 0.30, label: 'lock 30%' },
      ],
    },
    {
      name: '3-tier-tight',
      tiers: [
        { minMFE: 40, lockPct: 0.70, label: 'lock 70%' },
        { minMFE: 20, lockPct: 0.55, label: 'lock 55%' },
        { minMFE: 8,  lockPct: 0.40, label: 'lock 40%' },
      ],
    },
    {
      name: 'ultra-tight',
      tiers: [
        { minMFE: 30, lockPct: 0.75, label: 'lock 75%' },
        { minMFE: 15, lockPct: 0.60, label: 'lock 60%' },
        { minMFE: 5,  lockPct: 0.40, label: 'lock 40%' },
      ],
    },
    {
      name: 'breakeven-then-lock',
      tiers: [
        { minMFE: 60, lockPct: 0.60, label: 'lock 60%' },
        { minMFE: 30, lockPct: 0.40, label: 'lock 40%' },
        { minMFE: 10, lockPct: 0.00, label: 'breakeven' },
      ],
    },
    {
      name: 'wide-spacing',
      tiers: [
        { minMFE: 120, lockPct: 0.65, label: 'lock 65%' },
        { minMFE: 80,  lockPct: 0.50, label: 'lock 50%' },
        { minMFE: 40,  lockPct: 0.35, label: 'lock 35%' },
        { minMFE: 15,  lockPct: 0.20, label: 'lock 20%' },
      ],
    },
  ];

  const totalRuns = testTargets.length * tierConfigs.length;
  console.log(`${testTargets.length} targets × ${tierConfigs.length} tier configs = ${totalRuns} runs`);
  console.log(`Test targets: ${testTargets.join(', ')}pts\n`);

  for (const tc of tierConfigs) {
    console.log(`  ${tc.name}: [${fmtTiers(tc.tiers)}]`);
  }
  console.log('');

  let runNum = 0;
  const sweepStart = Date.now();

  for (const target of testTargets) {
    console.log(`\n── Target: ${target}pts ──`);

    for (const tc of tierConfigs) {
      runNum++;

      const strategyParams = {
        maxHoldBars: 60,
        stopLossPoints: 70,
        targetPoints: target,
      };

      const trailConfig = {
        mfeRatchet: { enabled: true, tiers: tc.tiers },
        timeBasedTrailing: { enabled: false },
      };

      try {
        const result = await runSingle(engine, data, baseConfig, strategyParams, trailConfig);
        const row = {
          phase: 2,
          target,
          mode: 'mfeRatchet',
          tierName: tc.name,
          tiers: tc.tiers,
          tiersStr: fmtTiers(tc.tiers),
          ...result,
        };
        phase2Results.push(row);

        const elapsed = ((Date.now() - sweepStart) / 1000).toFixed(0);
        const pnlDelta = result.pnl - BASELINE.pnl;
        const deltaStr = pnlDelta >= 0 ? `+$${pnlDelta.toFixed(0)}` : `-$${Math.abs(pnlDelta).toFixed(0)}`;

        console.log(
          `[${String(runNum).padStart(2)}/${totalRuns}] (${elapsed}s) ` +
          `${tc.name.padEnd(22)} | ` +
          `${String(result.trades).padStart(3)} tr | WR=${result.winRate.toFixed(1).padStart(5)}% | ` +
          `PF=${result.pf.toFixed(2).padStart(5)} | ${fmtPnl(result.pnl).padStart(9)} | ` +
          `vs baseline: ${deltaStr} | ` +
          `Ratchet=${result.ratchetCount} Trail=${result.trailCount}`
        );
      } catch (err) {
        console.log(`[${String(runNum).padStart(2)}/${totalRuns}] ERROR: ${err.message.split('\n')[0]}`);
      }
    }
  }

  const totalTime = ((Date.now() - sweepStart) / 1000).toFixed(1);
  console.log(`\nPhase 2 completed: ${totalRuns} runs in ${totalTime}s\n`);

  // Print Phase 2 results sorted by P&L
  console.log('═'.repeat(150));
  console.log('PHASE 2 RESULTS — SORTED BY P&L');
  console.log('═'.repeat(150));
  console.log('Rank | Target |      Tier Config       | Trades | WinRate |   PF  |   Total P&L   |  vs Baseline  | MaxDD | Sharpe | TP  | SL  | Ratchet | MH  | MC  |  Tiers');
  console.log('─'.repeat(150));

  const sorted2 = [...phase2Results].sort((a, b) => b.pnl - a.pnl);
  for (let i = 0; i < sorted2.length; i++) {
    const r = sorted2[i];
    const pnlDelta = r.pnl - BASELINE.pnl;
    const deltaStr = pnlDelta >= 0 ? `+$${pnlDelta.toFixed(0)}` : `-$${Math.abs(pnlDelta).toFixed(0)}`;
    console.log(
      `${String(i + 1).padStart(4)} | ${String(r.target).padStart(6)} | ${r.tierName.padEnd(22)} | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.pf.toFixed(2).padStart(5)} | ${fmtPnl(r.pnl).padStart(13)} | ${deltaStr.padStart(13)} | ${r.maxDD.toFixed(1).padStart(4)}% | ${r.sharpe.toFixed(2).padStart(5)}  | ${String(r.tpCount).padStart(3)} | ${String(r.slCount).padStart(3)} | ${String(r.ratchetCount).padStart(7)} | ${String(r.mhCount).padStart(3)} | ${String(r.mcCount).padStart(3)} | ${r.tiersStr}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Final combined ranking
// ═══════════════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(130));
console.log('FINAL COMBINED RANKING — ALL RUNS SORTED BY P&L');
console.log('═'.repeat(130));

const allResults = [...phase1Results, ...phase2Results].sort((a, b) => b.pnl - a.pnl);

console.log('Rank |  Phase | Target |         Config         | Trades | WinRate |   PF  |   Total P&L   |  vs Baseline  | MaxDD | Sharpe | Exits');
console.log('─'.repeat(130));

for (let i = 0; i < allResults.length; i++) {
  const r = allResults[i];
  const pnlDelta = r.pnl - BASELINE.pnl;
  const deltaStr = pnlDelta >= 0 ? `+$${pnlDelta.toFixed(0)}` : `-$${Math.abs(pnlDelta).toFixed(0)}`;
  const configStr = r.tierName || r.modeLabel || r.mode;
  const exitStr = `TP=${r.tpCount} SL=${r.slCount} R=${r.ratchetCount} T=${r.trailCount} MH=${r.mhCount} MC=${r.mcCount}`;

  console.log(
    `${String(i + 1).padStart(4)} |    P${r.phase} | ${String(r.target).padStart(6)} | ${configStr.padEnd(22)} | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.pf.toFixed(2).padStart(5)} | ${fmtPnl(r.pnl).padStart(13)} | ${deltaStr.padStart(13)} | ${r.maxDD.toFixed(1).padStart(4)}% | ${r.sharpe.toFixed(2).padStart(5)}  | ${exitStr}`
  );
}

// Save all results
fs.writeFileSync(resultsFile, JSON.stringify({ phase1: phase1Results, phase2: phase2Results, baseline: BASELINE }, null, 2));
console.log(`\nAll results saved to ${resultsFile}`);

// Summary
console.log('\n' + '═'.repeat(80));
console.log('SUMMARY');
console.log('═'.repeat(80));
console.log(`Baseline (timeBased trailing, 70pt target): ${BASELINE.trades} trades, ${BASELINE.winRate}% WR, $${BASELINE.pnl.toLocaleString()}`);

const best = allResults[0];
if (best) {
  const pnlDelta = best.pnl - BASELINE.pnl;
  const deltaStr = pnlDelta >= 0 ? `+$${pnlDelta.toFixed(0)}` : `-$${Math.abs(pnlDelta).toFixed(0)}`;
  const configStr = best.tierName || best.modeLabel || best.mode;
  console.log(`Best found: ${configStr} @ ${best.target}pt target → ${best.trades} trades, ${best.winRate.toFixed(1)}% WR, $${best.pnl.toFixed(0)} (${deltaStr} vs baseline)`);

  if (best.pnl > BASELINE.pnl) {
    console.log(`\n*** MFE ratchet BEAT baseline by $${pnlDelta.toFixed(0)} ***`);
  } else {
    console.log(`\n--- Baseline still wins by $${Math.abs(pnlDelta).toFixed(0)} ---`);
  }
}

console.log('\nDone.');
