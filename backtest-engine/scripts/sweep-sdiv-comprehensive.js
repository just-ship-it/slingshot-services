#!/usr/bin/env node
/**
 * Comprehensive Short-DTE IV Strategy Parameter Optimization
 *
 * Phase 1: Sweep thresholds × stops × targets × sides (pure TP/SL)
 * Phase 2: Sweep trailing stop params on top Phase 1 configs
 * Phase 3: Final ranking across all phases
 *
 * Loads data ONCE, reuses across all runs.
 * Saves all results to JSON for analysis.
 *
 * Usage:
 *   node scripts/sweep-sdiv-comprehensive.js
 *   node scripts/sweep-sdiv-comprehensive.js --phase 1    # Only Phase 1
 *   node scripts/sweep-sdiv-comprehensive.js --phase 2    # Only Phase 2 (reads Phase 1 JSON)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BacktestEngine } from '../src/backtest-engine.js';
import { ShortDTEIVStrategy } from '../../shared/strategies/short-dte-iv.js';
import { TradeSimulator } from '../src/execution/trade-simulator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_DIR = path.join(__dirname, '..', 'research', 'output');

const start = '2025-01-29';
const end = '2026-01-28';

// Parse CLI
const args = process.argv.slice(2);
let phaseFilter = 0; // 0 = all phases
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--phase') phaseFilter = parseInt(args[++i]);
}

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const phase1File = path.join(OUTPUT_DIR, 'sdiv-sweep-phase1.json');
const phase2File = path.join(OUTPUT_DIR, 'sdiv-sweep-phase2.json');
const finalFile = path.join(OUTPUT_DIR, 'sdiv-sweep-final.json');

// ═══════════════════════════════════════════════════════════════════════
// Helper: Run a single simulation
// ═══════════════════════════════════════════════════════════════════════

async function runSingle(engine, simConfig, data, params, baseConfig) {
  engine.strategy = new ShortDTEIVStrategy(params);
  engine.tradeSimulator = new TradeSimulator(simConfig);

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
  const avgWin = perf.basic.averageWin || 0;
  const avgLoss = perf.basic.averageLoss || 0;

  // Count exits by reason
  let tpCount = 0, slCount = 0, mhCount = 0, mcCount = 0, trailCount = 0;
  for (const t of simResults.trades) {
    const r = t.exitReason || '';
    if (r.includes('TAKE_PROFIT') || r.includes('TAKE PROFIT')) tpCount++;
    else if (r.includes('TRAILING') || r.includes('trailing')) trailCount++;
    else if (r.includes('STOP_LOSS') || r.includes('STOP LOSS')) slCount++;
    else if (r.includes('MAX_HOLD') || r.includes('MAX HOLD')) mhCount++;
    else if (r.includes('MARKET_CLOSE') || r.includes('MARKET CLOSE')) mcCount++;
  }

  return {
    trades, winRate, pnl, pf, expectancy, maxDD, sharpe,
    avgWin, avgLoss, tpCount, slCount, trailCount, mhCount, mcCount
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Load data once
// ═══════════════════════════════════════════════════════════════════════

console.log('═'.repeat(80));
console.log('COMPREHENSIVE SHORT-DTE IV PARAMETER OPTIMIZATION');
console.log('═'.repeat(80));
console.log(`Date range: ${start} → ${end}`);
console.log(`Phase: ${phaseFilter === 0 ? 'All' : phaseFilter}\n`);

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
    ivChangeThreshold: 0.008,
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
const simConfig = engine.tradeSimulator.config;

console.log('Data loaded.\n');

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Threshold × Stop × Target × Side (pure TP/SL, no trailing)
// ═══════════════════════════════════════════════════════════════════════

let phase1Results = [];

if (phaseFilter === 0 || phaseFilter === 1) {
  console.log('═'.repeat(80));
  console.log('PHASE 1: Threshold × Stop × Target × Side (pure TP/SL)');
  console.log('═'.repeat(80));

  const thresholds = [0.005, 0.008, 0.01, 0.012, 0.015, 0.02, 0.025, 0.03];
  const stops = [10, 15, 20, 30, 40, 50];
  const targets = [10, 15, 20, 30, 40, 50, 75, 100];
  const sides = ['both', 'long', 'short'];

  const totalRuns = thresholds.length * stops.length * targets.length * sides.length;
  console.log(`${thresholds.length} thresholds × ${stops.length} stops × ${targets.length} targets × ${sides.length} sides = ${totalRuns} runs\n`);

  let runNum = 0;
  const sweepStart = Date.now();

  for (const threshold of thresholds) {
    console.log(`\n── Threshold: ${threshold} ──`);

    for (const side of sides) {
      for (const stop of stops) {
        for (const target of targets) {
          runNum++;

          const params = {
            ivChangeThreshold: threshold,
            enableLong: side !== 'short',
            enableShort: side !== 'long',
            targetPoints: target,
            stopPoints: stop,
            trailingTrigger: 9999,
            trailingOffset: 0,
            maxHoldBars: 60,
            cooldownMs: 900000,
            timeoutCandles: 2,
          };

          try {
            const result = await runSingle(engine, simConfig, data, params, baseConfig);
            const row = { threshold, side, stop, target, trailing: false, ...result };
            phase1Results.push(row);

            const rr = (target / stop).toFixed(1);
            const pnlStr = result.pnl >= 0 ? `+$${result.pnl.toFixed(0)}` : `-$${Math.abs(result.pnl).toFixed(0)}`;
            const elapsed = ((Date.now() - sweepStart) / 1000).toFixed(0);

            if (runNum % 10 === 0 || runNum === totalRuns) {
              const pct = ((runNum / totalRuns) * 100).toFixed(1);
              const rate = (runNum / ((Date.now() - sweepStart) / 60000)).toFixed(0);
              const eta = ((totalRuns - runNum) / (runNum / ((Date.now() - sweepStart) / 1000))).toFixed(0);
              console.log(`[${String(runNum).padStart(4)}/${totalRuns}] (${pct}%, ${rate}/min, ETA ${eta}s) th=${threshold} ${side.padEnd(5)} S:${String(stop).padStart(2)} T:${String(target).padStart(3)} | R:R=${rr} | ${String(result.trades).padStart(3)} tr | WR=${result.winRate.toFixed(1)}% | PF=${result.pf.toFixed(2)} | ${pnlStr.padStart(9)} | Exp=$${result.expectancy.toFixed(0)}`);
            }
          } catch (err) {
            console.log(`[${String(runNum).padStart(4)}/${totalRuns}] ERROR: ${err.message.split('\n')[0]}`);
          }
        }
      }
    }
  }

  const totalTime = ((Date.now() - sweepStart) / 1000).toFixed(1);
  console.log(`\nPhase 1 completed: ${totalRuns} runs in ${totalTime}s (${(totalRuns / (totalTime / 60)).toFixed(0)} runs/min)\n`);

  // Save Phase 1 results
  fs.writeFileSync(phase1File, JSON.stringify(phase1Results, null, 2));
  console.log(`Phase 1 results saved to ${phase1File}\n`);

  // Print Phase 1 top 30 by expectancy (minimum 50 trades)
  const viable = phase1Results.filter(r => r.trades >= 50);
  viable.sort((a, b) => b.expectancy - a.expectancy);

  console.log('═'.repeat(120));
  console.log('PHASE 1 TOP 30 BY EXPECTANCY (min 50 trades)');
  console.log('═'.repeat(120));
  console.log('Rank | Threshold |  Side  | Stop | Target | Trades | WinRate |   PF  | Expectancy |   Total P&L   | MaxDD | Sharpe');
  console.log('─'.repeat(120));

  for (let i = 0; i < Math.min(30, viable.length); i++) {
    const r = viable[i];
    const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0)}` : `-$${Math.abs(r.pnl).toFixed(0)}`;
    console.log(
      `${String(i + 1).padStart(4)} |   ${String(r.threshold).padStart(5)} | ${r.side.padEnd(6)} | ${String(r.stop).padStart(4)} | ${String(r.target).padStart(6)} | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.pf.toFixed(2).padStart(5)} |     $${String(r.expectancy.toFixed(0)).padStart(5)} | ${pnlStr.padStart(13)} | ${r.maxDD.toFixed(1).padStart(4)}% | ${r.sharpe.toFixed(2).padStart(5)}`
    );
  }

  // Also print top 30 by total P&L
  viable.sort((a, b) => b.pnl - a.pnl);
  console.log('\n' + '═'.repeat(120));
  console.log('PHASE 1 TOP 30 BY TOTAL P&L (min 50 trades)');
  console.log('═'.repeat(120));
  console.log('Rank | Threshold |  Side  | Stop | Target | Trades | WinRate |   PF  | Expectancy |   Total P&L   | MaxDD | Sharpe');
  console.log('─'.repeat(120));

  for (let i = 0; i < Math.min(30, viable.length); i++) {
    const r = viable[i];
    const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0)}` : `-$${Math.abs(r.pnl).toFixed(0)}`;
    console.log(
      `${String(i + 1).padStart(4)} |   ${String(r.threshold).padStart(5)} | ${r.side.padEnd(6)} | ${String(r.stop).padStart(4)} | ${String(r.target).padStart(6)} | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.pf.toFixed(2).padStart(5)} |     $${String(r.expectancy.toFixed(0)).padStart(5)} | ${pnlStr.padStart(13)} | ${r.maxDD.toFixed(1).padStart(4)}% | ${r.sharpe.toFixed(2).padStart(5)}`
    );
  }

  // Print top 30 by P&L/MaxDD ratio (risk-adjusted)
  const riskAdj = viable.filter(r => r.maxDD > 0).map(r => ({ ...r, pnlDDRatio: r.pnl / (r.maxDD / 100 * 100000) }));
  riskAdj.sort((a, b) => b.pnlDDRatio - a.pnlDDRatio);
  console.log('\n' + '═'.repeat(120));
  console.log('PHASE 1 TOP 30 BY RETURN/DRAWDOWN RATIO (min 50 trades)');
  console.log('═'.repeat(120));
  console.log('Rank | Threshold |  Side  | Stop | Target | Trades | WinRate |   PF  |  P&L/DD  |   Total P&L   | MaxDD | Sharpe');
  console.log('─'.repeat(120));

  for (let i = 0; i < Math.min(30, riskAdj.length); i++) {
    const r = riskAdj[i];
    const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0)}` : `-$${Math.abs(r.pnl).toFixed(0)}`;
    console.log(
      `${String(i + 1).padStart(4)} |   ${String(r.threshold).padStart(5)} | ${r.side.padEnd(6)} | ${String(r.stop).padStart(4)} | ${String(r.target).padStart(6)} | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.pf.toFixed(2).padStart(5)} | ${r.pnlDDRatio.toFixed(1).padStart(7)}x | ${pnlStr.padStart(13)} | ${r.maxDD.toFixed(1).padStart(4)}% | ${r.sharpe.toFixed(2).padStart(5)}`
    );
  }
} else {
  // Load Phase 1 results from file
  if (fs.existsSync(phase1File)) {
    phase1Results = JSON.parse(fs.readFileSync(phase1File, 'utf8'));
    console.log(`Loaded ${phase1Results.length} Phase 1 results from ${phase1File}\n`);
  } else {
    console.error('Phase 1 results not found. Run Phase 1 first.');
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Trailing stop sweep on top Phase 1 configs
// ═══════════════════════════════════════════════════════════════════════

let phase2Results = [];

if (phaseFilter === 0 || phaseFilter === 2) {
  console.log('\n' + '═'.repeat(80));
  console.log('PHASE 2: Trailing Stop Sweep on Top Configs');
  console.log('═'.repeat(80));

  // Find top configs from Phase 1 to test trailing on
  // Select diverse set: top by expectancy and top by P&L, various thresholds/sides
  const viable = phase1Results.filter(r => r.trades >= 50);

  // Get top 5 by expectancy and top 5 by P&L, deduplicated
  const byExp = [...viable].sort((a, b) => b.expectancy - a.expectancy).slice(0, 8);
  const byPnl = [...viable].sort((a, b) => b.pnl - a.pnl).slice(0, 8);
  const byRiskAdj = [...viable].filter(r => r.maxDD > 0)
    .sort((a, b) => (b.pnl / b.maxDD) - (a.pnl / a.maxDD)).slice(0, 8);

  // Deduplicate by threshold+side+stop+target
  const seen = new Set();
  const topConfigs = [];
  for (const r of [...byExp, ...byPnl, ...byRiskAdj]) {
    const key = `${r.threshold}-${r.side}-${r.stop}-${r.target}`;
    if (!seen.has(key)) {
      seen.add(key);
      topConfigs.push(r);
    }
  }

  console.log(`Selected ${topConfigs.length} top configs for trailing stop sweep:\n`);
  for (const c of topConfigs) {
    console.log(`  th=${c.threshold} ${c.side} S:${c.stop} T:${c.target} | PF=${c.pf.toFixed(2)} Exp=$${c.expectancy.toFixed(0)} P&L=$${c.pnl.toFixed(0)}`);
  }

  // Trailing stop parameter grid
  const trailingTriggers = [5, 8, 10, 15, 20, 25, 30];
  const trailingOffsets = [3, 5, 8, 10, 15];

  // For each top config, test:
  // 1. Various trailing trigger/offset combos WITH the original fixed TP
  // 2. Same trailing combos with NO fixed TP (target=9999, let trailing handle exit)
  const totalPhase2 = topConfigs.length * trailingTriggers.length * trailingOffsets.length * 2;
  console.log(`\n${topConfigs.length} configs × ${trailingTriggers.length} triggers × ${trailingOffsets.length} offsets × 2 (with/without TP) = ${totalPhase2} runs\n`);

  let runNum = 0;
  const sweepStart = Date.now();

  for (const config of topConfigs) {
    for (const trailTrigger of trailingTriggers) {
      for (const trailOffset of trailingOffsets) {
        // Skip if offset >= trigger (trailing would be useless)
        if (trailOffset >= trailTrigger) continue;

        for (const useFixedTP of [true, false]) {
          runNum++;

          const effectiveTarget = useFixedTP ? config.target : 9999;

          const params = {
            ivChangeThreshold: config.threshold,
            enableLong: config.side !== 'short',
            enableShort: config.side !== 'long',
            targetPoints: effectiveTarget,
            stopPoints: config.stop,
            trailingTrigger: trailTrigger,
            trailingOffset: trailOffset,
            maxHoldBars: 60,
            cooldownMs: 900000,
            timeoutCandles: 2,
          };

          try {
            const result = await runSingle(engine, simConfig, data, params, baseConfig);
            const row = {
              threshold: config.threshold,
              side: config.side,
              stop: config.stop,
              target: effectiveTarget,
              originalTarget: config.target,
              trailingTrigger: trailTrigger,
              trailingOffset: trailOffset,
              useFixedTP,
              trailing: true,
              ...result
            };
            phase2Results.push(row);

            if (runNum % 10 === 0 || runNum === totalPhase2) {
              const elapsed = ((Date.now() - sweepStart) / 1000).toFixed(0);
              const rate = (runNum / ((Date.now() - sweepStart) / 60000)).toFixed(0);
              const pnlStr = result.pnl >= 0 ? `+$${result.pnl.toFixed(0)}` : `-$${Math.abs(result.pnl).toFixed(0)}`;
              console.log(
                `[${String(runNum).padStart(4)}/${totalPhase2}] (${rate}/min, ${elapsed}s) ` +
                `th=${config.threshold} ${config.side.padEnd(5)} S:${config.stop} T:${effectiveTarget === 9999 ? 'trail' : effectiveTarget} ` +
                `TrTrig:${trailTrigger} TrOff:${trailOffset} | ` +
                `${String(result.trades).padStart(3)} tr WR=${result.winRate.toFixed(1)}% PF=${result.pf.toFixed(2)} ${pnlStr}`
              );
            }
          } catch (err) {
            console.log(`[${String(runNum).padStart(4)}/${totalPhase2}] ERROR: ${err.message.split('\n')[0]}`);
          }
        }
      }
    }
  }

  const totalTime = ((Date.now() - sweepStart) / 1000).toFixed(1);
  console.log(`\nPhase 2 completed: ${runNum} runs in ${totalTime}s\n`);

  fs.writeFileSync(phase2File, JSON.stringify(phase2Results, null, 2));
  console.log(`Phase 2 results saved to ${phase2File}\n`);

  // Phase 2 top results
  const viable2 = phase2Results.filter(r => r.trades >= 50);
  viable2.sort((a, b) => b.expectancy - a.expectancy);

  console.log('═'.repeat(140));
  console.log('PHASE 2 TOP 30 BY EXPECTANCY (min 50 trades)');
  console.log('═'.repeat(140));
  console.log('Rank | Threshold |  Side  | Stop | Target | TrTrig | TrOff | FixTP | Trades | WinRate |   PF  | Expectancy |   Total P&L   | MaxDD');
  console.log('─'.repeat(140));

  for (let i = 0; i < Math.min(30, viable2.length); i++) {
    const r = viable2[i];
    const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0)}` : `-$${Math.abs(r.pnl).toFixed(0)}`;
    const tgtStr = r.target === 9999 ? 'trail' : String(r.target);
    console.log(
      `${String(i + 1).padStart(4)} |   ${String(r.threshold).padStart(5)} | ${r.side.padEnd(6)} | ${String(r.stop).padStart(4)} | ${tgtStr.padStart(6)} | ${String(r.trailingTrigger).padStart(6)} | ${String(r.trailingOffset).padStart(5)} |   ${r.useFixedTP ? 'Y' : 'N'}   | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.pf.toFixed(2).padStart(5)} |     $${String(r.expectancy.toFixed(0)).padStart(5)} | ${pnlStr.padStart(13)} | ${r.maxDD.toFixed(1).padStart(4)}%`
    );
  }

  // Phase 2 top by P&L
  viable2.sort((a, b) => b.pnl - a.pnl);
  console.log('\n' + '═'.repeat(140));
  console.log('PHASE 2 TOP 30 BY TOTAL P&L (min 50 trades)');
  console.log('═'.repeat(140));
  console.log('Rank | Threshold |  Side  | Stop | Target | TrTrig | TrOff | FixTP | Trades | WinRate |   PF  | Expectancy |   Total P&L   | MaxDD');
  console.log('─'.repeat(140));

  for (let i = 0; i < Math.min(30, viable2.length); i++) {
    const r = viable2[i];
    const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0)}` : `-$${Math.abs(r.pnl).toFixed(0)}`;
    const tgtStr = r.target === 9999 ? 'trail' : String(r.target);
    console.log(
      `${String(i + 1).padStart(4)} |   ${String(r.threshold).padStart(5)} | ${r.side.padEnd(6)} | ${String(r.stop).padStart(4)} | ${tgtStr.padStart(6)} | ${String(r.trailingTrigger).padStart(6)} | ${String(r.trailingOffset).padStart(5)} |   ${r.useFixedTP ? 'Y' : 'N'}   | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.pf.toFixed(2).padStart(5)} |     $${String(r.expectancy.toFixed(0)).padStart(5)} | ${pnlStr.padStart(13)} | ${r.maxDD.toFixed(1).padStart(4)}%`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Combined final ranking
// ═══════════════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(140));
console.log('FINAL COMBINED RANKING — TOP 50 OVERALL (min 50 trades)');
console.log('═'.repeat(140));

const allResults = [...phase1Results, ...phase2Results].filter(r => r.trades >= 50);

// Score: weighted combination of expectancy, P&L, PF, and risk-adjusted return
// Normalize each metric to 0-1 range, then weight
const maxExp = Math.max(...allResults.map(r => r.expectancy));
const maxPnl = Math.max(...allResults.map(r => r.pnl));
const maxPf = Math.max(...allResults.map(r => r.pf));
const maxSharpe = Math.max(...allResults.map(r => r.sharpe));

for (const r of allResults) {
  const normExp = maxExp > 0 ? r.expectancy / maxExp : 0;
  const normPnl = maxPnl > 0 ? r.pnl / maxPnl : 0;
  const normPf = maxPf > 0 ? r.pf / maxPf : 0;
  const normSharpe = maxSharpe > 0 ? r.sharpe / maxSharpe : 0;
  const ddPenalty = r.maxDD > 10 ? 0.9 : 1.0; // Slight penalty for >10% drawdown

  // Weighted score: emphasize expectancy and risk-adjusted
  r.score = ddPenalty * (
    0.30 * normExp +
    0.25 * normPnl +
    0.20 * normPf +
    0.25 * normSharpe
  );
}

allResults.sort((a, b) => b.score - a.score);

console.log('Rank | Score | Threshold |  Side  | Stop | Target | Trail     | Trades | WinRate |   PF  | Exp$/tr |   Total P&L   | MaxDD | Sharpe');
console.log('─'.repeat(140));

for (let i = 0; i < Math.min(50, allResults.length); i++) {
  const r = allResults[i];
  const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0)}` : `-$${Math.abs(r.pnl).toFixed(0)}`;
  const tgtStr = r.target === 9999 ? 'trail' : String(r.target);
  const trailStr = r.trailing && r.trailingTrigger
    ? `${r.trailingTrigger}/${r.trailingOffset}${r.useFixedTP ? '+TP' : ''}`
    : 'none';

  console.log(
    `${String(i + 1).padStart(4)} | ${r.score.toFixed(3)} |   ${String(r.threshold).padStart(5)} | ${r.side.padEnd(6)} | ${String(r.stop).padStart(4)} | ${tgtStr.padStart(6)} | ${trailStr.padEnd(9)} | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.pf.toFixed(2).padStart(5)} |  $${String(r.expectancy.toFixed(0)).padStart(5)} | ${pnlStr.padStart(13)} | ${r.maxDD.toFixed(1).padStart(4)}% | ${r.sharpe.toFixed(2).padStart(5)}`
  );
}

// Save final combined results
fs.writeFileSync(finalFile, JSON.stringify(allResults.slice(0, 200), null, 2));
console.log(`\nFinal results saved to ${finalFile}`);

// Summary statistics
console.log('\n' + '═'.repeat(80));
console.log('OPTIMIZATION SUMMARY');
console.log('═'.repeat(80));
console.log(`Total configurations tested: ${phase1Results.length + phase2Results.length}`);
console.log(`  Phase 1 (pure TP/SL): ${phase1Results.length}`);
console.log(`  Phase 2 (trailing):   ${phase2Results.length}`);
console.log(`Viable configs (≥50 trades): ${allResults.length}`);
console.log(`\nBest by expectancy: th=${allResults[0]?.threshold} ${allResults[0]?.side} S:${allResults[0]?.stop} T:${allResults[0]?.target} → $${allResults[0]?.expectancy.toFixed(0)}/trade`);

const bestPnl = [...allResults].sort((a, b) => b.pnl - a.pnl)[0];
console.log(`Best by total P&L: th=${bestPnl?.threshold} ${bestPnl?.side} S:${bestPnl?.stop} T:${bestPnl?.target} → $${bestPnl?.pnl.toFixed(0)}`);

const bestRisk = [...allResults].filter(r => r.maxDD > 0).sort((a, b) => (b.pnl / b.maxDD) - (a.pnl / a.maxDD))[0];
console.log(`Best risk-adjusted: th=${bestRisk?.threshold} ${bestRisk?.side} S:${bestRisk?.stop} T:${bestRisk?.target} → P&L/DD=${(bestRisk?.pnl / (bestRisk?.maxDD / 100 * 100000)).toFixed(1)}x`);

console.log('\nDone.');
