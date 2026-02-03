#!/usr/bin/env node
/**
 * Analyze Zero Gamma trajectory during trades to design an early exit system
 * When GF trends against the trade direction, exit early
 */

import fs from 'fs';
import path from 'path';

const resultsPath = process.argv[2] || 'results/iv-skew-gex-2025.json';
const gexDir = process.argv[3] || 'data/gex/nq';

const data = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), resultsPath), 'utf8'));

// Load all GEX intraday files
const gexDirPath = path.resolve(process.cwd(), gexDir);
const gexFiles = fs.readdirSync(gexDirPath)
  .filter(f => f.startsWith('nq_gex_2025') && f.endsWith('.json'));

console.log(`Loading ${gexFiles.length} GEX intraday files from ${gexDirPath}...`);

// Create a map for quick lookup - use numeric timestamps as keys
const snapshotMap = new Map();
gexFiles.forEach(f => {
  try {
    const gexData = JSON.parse(fs.readFileSync(path.join(gexDirPath, f), 'utf8'));
    gexData.data.forEach(snap => {
      const ts = new Date(snap.timestamp).getTime();
      snapshotMap.set(ts, {
        timestamp: ts,
        ...snap
      });
    });
  } catch (e) {
    console.error(`Error loading ${f}:`, e.message);
  }
});

console.log(`Loaded ${snapshotMap.size} GEX snapshots`);

// Function to get all GEX snapshots during a trade
function getSnapshotsDuringTrade(entryTime, exitTime) {
  const snapshots = [];
  const roundedEntry = Math.floor(entryTime / (15 * 60 * 1000)) * (15 * 60 * 1000);
  const roundedExit = Math.ceil(exitTime / (15 * 60 * 1000)) * (15 * 60 * 1000);

  for (let ts = roundedEntry; ts <= roundedExit; ts += 15 * 60 * 1000) {
    const snap = snapshotMap.get(ts);
    if (snap) {
      snapshots.push(snap);
    }
  }
  return snapshots;
}


const trades = data.trades.filter(t => t.status === 'completed');

console.log(`\n${'='.repeat(80)}`);
console.log('ZERO GAMMA TRAJECTORY ANALYSIS FOR EARLY EXIT');
console.log(`${'='.repeat(80)}`);

// Analyze each trade's GF trajectory
const tradeTrajectories = [];

trades.forEach(trade => {
  const snapshots = getSnapshotsDuringTrade(trade.entryTime, trade.exitTime);
  if (snapshots.length < 2) return;

  const entryGF = snapshots[0].gamma_flip;
  if (!entryGF) return;

  // Track GF movement at each snapshot
  const trajectory = snapshots.map((snap, i) => ({
    timestamp: snap.timestamp,
    gammaFlip: snap.gamma_flip,
    gfChange: snap.gamma_flip - entryGF,
    snapshotIndex: i
  }));

  // Calculate max favorable and max adverse GF excursion
  let maxFavorableGF = 0;
  let maxAdverseGF = 0;
  let adverseExcursionTime = null;

  trajectory.forEach(t => {
    if (trade.side === 'long') {
      // For longs: GF going up is favorable
      if (t.gfChange > maxFavorableGF) maxFavorableGF = t.gfChange;
      if (t.gfChange < maxAdverseGF) {
        maxAdverseGF = t.gfChange;
        adverseExcursionTime = t.timestamp;
      }
    } else {
      // For shorts: GF going down is favorable
      if (t.gfChange < 0 && Math.abs(t.gfChange) > Math.abs(maxFavorableGF)) {
        maxFavorableGF = t.gfChange;
      }
      if (t.gfChange > maxAdverseGF) {
        maxAdverseGF = t.gfChange;
        adverseExcursionTime = t.timestamp;
      }
    }
  });

  // Normalize: make adverse always negative for analysis
  const normalizedAdverse = trade.side === 'long' ? maxAdverseGF : -maxAdverseGF;
  const normalizedFavorable = trade.side === 'long' ? maxFavorableGF : -maxFavorableGF;

  // Check if GF trended against trade at any point
  const gfTrendedAgainst = trade.side === 'long'
    ? trajectory.some(t => t.gfChange < -30)
    : trajectory.some(t => t.gfChange > 30);

  tradeTrajectories.push({
    ...trade,
    trajectory,
    entryGF,
    exitGF: snapshots[snapshots.length - 1].gamma_flip,
    totalGFChange: snapshots[snapshots.length - 1].gamma_flip - entryGF,
    maxFavorableGF: normalizedFavorable,
    maxAdverseGF: normalizedAdverse,
    gfTrendedAgainst,
    snapshotCount: snapshots.length
  });
});

console.log(`\nAnalyzed ${tradeTrajectories.length} trades with GF trajectories`);

const winners = tradeTrajectories.filter(t => t.netPnL > 0);
const losers = tradeTrajectories.filter(t => t.netPnL < 0);

// Summary statistics
console.log(`\n${'='.repeat(80)}`);
console.log('GF TRAJECTORY STATISTICS');
console.log(`${'='.repeat(80)}`);

const avgAdverseWin = winners.reduce((s, t) => s + t.maxAdverseGF, 0) / winners.length;
const avgAdverseLose = losers.reduce((s, t) => s + t.maxAdverseGF, 0) / losers.length;
const avgFavorableWin = winners.reduce((s, t) => s + t.maxFavorableGF, 0) / winners.length;
const avgFavorableLose = losers.reduce((s, t) => s + t.maxFavorableGF, 0) / losers.length;

console.log('\nMax Adverse GF Excursion (GF moving against trade):');
console.log(`  Winners: avg ${avgAdverseWin.toFixed(1)}pts`);
console.log(`  Losers:  avg ${avgAdverseLose.toFixed(1)}pts`);

console.log('\nMax Favorable GF Excursion (GF moving with trade):');
console.log(`  Winners: avg ${avgFavorableWin.toFixed(1)}pts`);
console.log(`  Losers:  avg ${avgFavorableLose.toFixed(1)}pts`);

// GF trended against analysis
const trendedAgainstWins = winners.filter(t => t.gfTrendedAgainst);
const trendedAgainstLosses = losers.filter(t => t.gfTrendedAgainst);

console.log(`\n${'='.repeat(80)}`);
console.log('GF TRENDED AGAINST TRADE (>30pts adverse)');
console.log(`${'='.repeat(80)}`);

console.log(`\nTrades where GF trended against position by >30pts:`);
console.log(`  Winners: ${trendedAgainstWins.length} of ${winners.length} (${(trendedAgainstWins.length/winners.length*100).toFixed(1)}%)`);
console.log(`  Losers: ${trendedAgainstLosses.length} of ${losers.length} (${(trendedAgainstLosses.length/losers.length*100).toFixed(1)}%)`);

const trendedAgainst = tradeTrajectories.filter(t => t.gfTrendedAgainst);
const didNotTrend = tradeTrajectories.filter(t => !t.gfTrendedAgainst);

console.log(`\nWin rate when GF trended against: ${(trendedAgainstWins.length/trendedAgainst.length*100).toFixed(1)}% (${trendedAgainst.length} trades)`);
console.log(`Win rate when GF did NOT trend against: ${(didNotTrend.filter(t=>t.netPnL>0).length/didNotTrend.length*100).toFixed(1)}% (${didNotTrend.length} trades)`);

// Threshold analysis for early exit
console.log(`\n${'='.repeat(80)}`);
console.log('EARLY EXIT THRESHOLD ANALYSIS');
console.log(`${'='.repeat(80)}`);

const thresholds = [20, 30, 40, 50, 75, 100, 150, 200];

console.log('\nIf we exit when GF moves against trade by X points:');
console.log('Threshold | Trades Affected | Would Exit Winners | Would Exit Losers | Net Impact');
console.log('-'.repeat(85));

thresholds.forEach(threshold => {
  // Trades that would trigger early exit
  const wouldExit = tradeTrajectories.filter(t => Math.abs(t.maxAdverseGF) >= threshold);
  const exitWinners = wouldExit.filter(t => t.netPnL > 0);
  const exitLosers = wouldExit.filter(t => t.netPnL < 0);

  // Estimate impact: losers saved vs winners hurt
  // Assume early exit at breakeven or small loss for winners
  const losersTotal = exitLosers.reduce((s, t) => s + Math.abs(t.netPnL), 0);
  const winnersLost = exitWinners.reduce((s, t) => s + t.netPnL, 0);

  // Net benefit = losses avoided - profits foregone
  const netBenefit = losersTotal - winnersLost;

  console.log(`${threshold.toString().padStart(9)}pts | ${wouldExit.length.toString().padStart(15)} | ${exitWinners.length.toString().padStart(18)} | ${exitLosers.length.toString().padStart(17)} | $${netBenefit.toFixed(0).padStart(10)}`);
});

// Detailed analysis at promising thresholds
console.log(`\n${'='.repeat(80)}`);
console.log('DETAILED ANALYSIS AT KEY THRESHOLDS');
console.log(`${'='.repeat(80)}`);

[50, 75, 100].forEach(threshold => {
  const wouldExit = tradeTrajectories.filter(t => Math.abs(t.maxAdverseGF) >= threshold);
  const exitWinners = wouldExit.filter(t => t.netPnL > 0);
  const exitLosers = wouldExit.filter(t => t.netPnL < 0);

  console.log(`\n--- Threshold: ${threshold} points ---`);
  console.log(`Trades that would trigger: ${wouldExit.length}`);
  console.log(`  Winners affected: ${exitWinners.length}`);
  console.log(`  Losers affected: ${exitLosers.length}`);

  if (exitLosers.length > 0) {
    console.log(`\nLosers that would be saved (sample):`);
    exitLosers.slice(0, 5).forEach(t => {
      const d = new Date(t.entryTime);
      console.log(`  ${d.toISOString().split('T')[0]}: ${t.side} @ ${t.signal.levelType}, MaxAdverse: ${t.maxAdverseGF.toFixed(0)}pts, P&L: $${t.netPnL.toFixed(0)}`);
    });
  }

  if (exitWinners.length > 0) {
    console.log(`\nWinners that would be hurt (sample):`);
    exitWinners.slice(0, 5).forEach(t => {
      const d = new Date(t.entryTime);
      console.log(`  ${d.toISOString().split('T')[0]}: ${t.side} @ ${t.signal.levelType}, MaxAdverse: ${t.maxAdverseGF.toFixed(0)}pts, P&L: $${t.netPnL.toFixed(0)}`);
    });
  }
});

// Time-based analysis: when does GF adverse movement happen?
console.log(`\n${'='.repeat(80)}`);
console.log('TIMING OF ADVERSE GF MOVEMENT');
console.log(`${'='.repeat(80)}`);

// For losers, how many snapshots into the trade does max adverse occur?
const loserTimings = losers.map(t => {
  let maxAdverseIdx = 0;
  let maxAdverse = 0;

  t.trajectory.forEach((snap, i) => {
    const adverse = t.side === 'long' ? -snap.gfChange : snap.gfChange;
    if (adverse > maxAdverse) {
      maxAdverse = adverse;
      maxAdverseIdx = i;
    }
  });

  return {
    trade: t,
    maxAdverseIdx,
    totalSnapshots: t.trajectory.length,
    relativePosition: maxAdverseIdx / t.trajectory.length
  };
});

console.log('\nWhen does max adverse GF occur for LOSERS (relative to trade duration)?');
const earlyAdverse = loserTimings.filter(t => t.relativePosition < 0.33);
const midAdverse = loserTimings.filter(t => t.relativePosition >= 0.33 && t.relativePosition < 0.66);
const lateAdverse = loserTimings.filter(t => t.relativePosition >= 0.66);

console.log(`  Early (first 1/3): ${earlyAdverse.length} trades (${(earlyAdverse.length/loserTimings.length*100).toFixed(1)}%)`);
console.log(`  Middle (middle 1/3): ${midAdverse.length} trades (${(midAdverse.length/loserTimings.length*100).toFixed(1)}%)`);
console.log(`  Late (last 1/3): ${lateAdverse.length} trades (${(lateAdverse.length/loserTimings.length*100).toFixed(1)}%)`);

// Consecutive adverse movement analysis
console.log(`\n${'='.repeat(80)}`);
console.log('CONSECUTIVE ADVERSE GF MOVEMENT');
console.log(`${'='.repeat(80)}`);

function countConsecutiveAdverse(trajectory, side) {
  let maxConsec = 0;
  let currentConsec = 0;
  let prevGF = trajectory[0].gammaFlip;

  for (let i = 1; i < trajectory.length; i++) {
    const currentGF = trajectory[i].gammaFlip;
    const isAdverse = side === 'long' ? currentGF < prevGF : currentGF > prevGF;

    if (isAdverse) {
      currentConsec++;
      maxConsec = Math.max(maxConsec, currentConsec);
    } else {
      currentConsec = 0;
    }
    prevGF = currentGF;
  }
  return maxConsec;
}

const winnerConsec = winners.map(t => countConsecutiveAdverse(t.trajectory, t.side));
const loserConsec = losers.map(t => countConsecutiveAdverse(t.trajectory, t.side));

const avgConsecWin = winnerConsec.reduce((s, v) => s + v, 0) / winnerConsec.length;
const avgConsecLose = loserConsec.reduce((s, v) => s + v, 0) / loserConsec.length;

console.log('\nMax consecutive snapshots with GF moving adversely:');
console.log(`  Winners: avg ${avgConsecWin.toFixed(1)} consecutive adverse moves`);
console.log(`  Losers:  avg ${avgConsecLose.toFixed(1)} consecutive adverse moves`);

// Test consecutive adverse as exit signal
console.log('\nEarly exit if X consecutive adverse GF moves:');
[2, 3, 4, 5].forEach(consec => {
  const wouldExit = tradeTrajectories.filter(t => {
    const maxConsec = countConsecutiveAdverse(t.trajectory, t.side);
    return maxConsec >= consec;
  });

  const exitWins = wouldExit.filter(t => t.netPnL > 0).length;
  const exitLoss = wouldExit.filter(t => t.netPnL < 0).length;

  console.log(`  ${consec} consecutive: ${wouldExit.length} trades affected (${exitWins}W/${exitLoss}L), Would exit ${(exitLoss/(exitLoss+exitWins)*100).toFixed(1)}% losers`);
});

// RECOMMENDATION
console.log(`\n${'='.repeat(80)}`);
console.log('RECOMMENDED EARLY EXIT RULES');
console.log(`${'='.repeat(80)}`);

// Find optimal threshold
let bestThreshold = 50;
let bestNetBenefit = 0;

thresholds.forEach(threshold => {
  const wouldExit = tradeTrajectories.filter(t => Math.abs(t.maxAdverseGF) >= threshold);
  const exitLosers = wouldExit.filter(t => t.netPnL < 0);
  const exitWinners = wouldExit.filter(t => t.netPnL > 0);

  const losersTotal = exitLosers.reduce((s, t) => s + Math.abs(t.netPnL), 0);
  const winnersLost = exitWinners.reduce((s, t) => s + t.netPnL, 0);
  const netBenefit = losersTotal - winnersLost;

  // Also factor in ratio of losers to winners affected
  const ratio = exitLosers.length / (exitWinners.length || 1);

  // Weight: prefer thresholds that catch more losers than winners
  const weightedBenefit = netBenefit * (ratio > 1 ? 1.2 : 0.8);

  if (weightedBenefit > bestNetBenefit) {
    bestNetBenefit = weightedBenefit;
    bestThreshold = threshold;
  }
});

const bestWouldExit = tradeTrajectories.filter(t => Math.abs(t.maxAdverseGF) >= bestThreshold);
const bestExitLosers = bestWouldExit.filter(t => t.netPnL < 0);
const bestExitWinners = bestWouldExit.filter(t => t.netPnL > 0);

console.log(`
RECOMMENDED EARLY EXIT SYSTEM:

Primary Rule: Exit if Zero Gamma moves ${bestThreshold}+ points against trade direction
  - Trigger: GF drops ${bestThreshold}pts for LONGS, rises ${bestThreshold}pts for SHORTS
  - Would affect: ${bestWouldExit.length} trades
  - Losers caught: ${bestExitLosers.length} (saves ~$${bestExitLosers.reduce((s,t)=>s+Math.abs(t.netPnL),0).toFixed(0)})
  - Winners hurt: ${bestExitWinners.length} (loses ~$${bestExitWinners.reduce((s,t)=>s+t.netPnL,0).toFixed(0)})
  - Net estimated benefit: $${(bestExitLosers.reduce((s,t)=>s+Math.abs(t.netPnL),0) - bestExitWinners.reduce((s,t)=>s+t.netPnL,0)).toFixed(0)}

Secondary Rule: Exit if 3+ consecutive GF snapshots move adversely
  - Provides faster exit signal
  - Catches trending adverse movement early

Implementation:
  1. Track Zero Gamma at trade entry
  2. On each 15-min GEX update, calculate GF change from entry
  3. If GF change exceeds threshold against position, exit immediately
  4. Alternatively, tighten stop to breakeven when GF moves ${Math.round(bestThreshold/2)}pts against

Combined with Hour 19 cutoff and breakeven stop, estimated total improvement: $20,000+
`);
