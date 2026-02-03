#!/usr/bin/env node
/**
 * Deep dive on consecutive adverse GF movement as early exit signal
 */

import fs from 'fs';
import path from 'path';

const resultsPath = process.argv[2] || 'results/iv-skew-gex-2025.json';
const gexDir = process.argv[3] || 'data/gex/nq';

const data = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), resultsPath), 'utf8'));
const gexDirPath = path.resolve(process.cwd(), gexDir);
const gexFiles = fs.readdirSync(gexDirPath)
  .filter(f => f.startsWith('nq_gex_2025') && f.endsWith('.json'));

const snapshotMap = new Map();
gexFiles.forEach(f => {
  try {
    const gexData = JSON.parse(fs.readFileSync(path.join(gexDirPath, f), 'utf8'));
    gexData.data.forEach(snap => {
      const ts = new Date(snap.timestamp).getTime();
      snapshotMap.set(ts, { timestamp: ts, ...snap });
    });
  } catch (e) {}
});

console.log(`Loaded ${snapshotMap.size} GEX snapshots`);

function getSnapshotsDuringTrade(entryTime, exitTime) {
  const snapshots = [];
  const roundedEntry = Math.floor(entryTime / (15 * 60 * 1000)) * (15 * 60 * 1000);
  const roundedExit = Math.ceil(exitTime / (15 * 60 * 1000)) * (15 * 60 * 1000);

  for (let ts = roundedEntry; ts <= roundedExit; ts += 15 * 60 * 1000) {
    const snap = snapshotMap.get(ts);
    if (snap) snapshots.push(snap);
  }
  return snapshots;
}

const trades = data.trades.filter(t => t.status === 'completed');

console.log(`\n${'='.repeat(80)}`);
console.log('CONSECUTIVE ADVERSE GF MOVEMENT - DETAILED ANALYSIS');
console.log(`${'='.repeat(80)}`);

// Analyze each trade for consecutive adverse GF movements
const tradeAnalysis = [];

trades.forEach(trade => {
  const snapshots = getSnapshotsDuringTrade(trade.entryTime, trade.exitTime);
  if (snapshots.length < 2) return;

  // Track consecutive adverse moves and when they happen
  let maxConsec = 0;
  let currentConsec = 0;
  let prevGF = snapshots[0].gamma_flip;
  let consecStartIdx = null;
  let maxConsecStartIdx = null;
  let maxConsecEndIdx = null;

  // Also track cumulative adverse movement during consecutive streak
  let consecAdverseSum = 0;
  let maxConsecAdverseSum = 0;

  for (let i = 1; i < snapshots.length; i++) {
    const currentGF = snapshots[i].gamma_flip;
    const gfDelta = currentGF - prevGF;
    const isAdverse = trade.side === 'long' ? gfDelta < 0 : gfDelta > 0;

    if (isAdverse) {
      if (currentConsec === 0) consecStartIdx = i;
      currentConsec++;
      consecAdverseSum += Math.abs(gfDelta);

      if (currentConsec > maxConsec) {
        maxConsec = currentConsec;
        maxConsecStartIdx = consecStartIdx;
        maxConsecEndIdx = i;
        maxConsecAdverseSum = consecAdverseSum;
      }
    } else {
      currentConsec = 0;
      consecAdverseSum = 0;
    }
    prevGF = currentGF;
  }

  // Calculate when the consecutive streak happened (relative to trade duration)
  const relativeStart = maxConsecStartIdx !== null ? maxConsecStartIdx / snapshots.length : null;

  tradeAnalysis.push({
    ...trade,
    snapshotCount: snapshots.length,
    maxConsecAdverse: maxConsec,
    maxConsecAdverseSum,
    consecStartIdx: maxConsecStartIdx,
    consecRelativeStart: relativeStart,
    entryGF: snapshots[0].gamma_flip,
    exitGF: snapshots[snapshots.length - 1].gamma_flip,
    totalGFChange: snapshots[snapshots.length - 1].gamma_flip - snapshots[0].gamma_flip
  });
});

const winners = tradeAnalysis.filter(t => t.netPnL > 0);
const losers = tradeAnalysis.filter(t => t.netPnL < 0);

console.log(`\nAnalyzed ${tradeAnalysis.length} trades`);

// Distribution of max consecutive adverse moves
console.log(`\n${'='.repeat(80)}`);
console.log('DISTRIBUTION OF MAX CONSECUTIVE ADVERSE GF MOVES');
console.log(`${'='.repeat(80)}`);

const consecDist = { 0: { w: 0, l: 0 }, 1: { w: 0, l: 0 }, 2: { w: 0, l: 0 }, 3: { w: 0, l: 0 }, '4+': { w: 0, l: 0 } };

tradeAnalysis.forEach(t => {
  const bucket = t.maxConsecAdverse >= 4 ? '4+' : t.maxConsecAdverse.toString();
  if (t.netPnL > 0) consecDist[bucket].w++;
  else consecDist[bucket].l++;
});

console.log('\nConsec | Winners | Losers | Total | Win% | Loser%');
console.log('-'.repeat(55));
Object.entries(consecDist).forEach(([consec, counts]) => {
  const total = counts.w + counts.l;
  if (total > 0) {
    console.log(`${consec.toString().padStart(6)} | ${counts.w.toString().padStart(7)} | ${counts.l.toString().padStart(6)} | ${total.toString().padStart(5)} | ${(counts.w/total*100).toFixed(1).padStart(4)}% | ${(counts.l/total*100).toFixed(1).padStart(5)}%`);
  }
});

// Detail on 3+ consecutive trades
console.log(`\n${'='.repeat(80)}`);
console.log('TRADES WITH 3+ CONSECUTIVE ADVERSE GF MOVES');
console.log(`${'='.repeat(80)}`);

const threeConsec = tradeAnalysis.filter(t => t.maxConsecAdverse >= 3);
const threeConsecWins = threeConsec.filter(t => t.netPnL > 0);
const threeConsecLoss = threeConsec.filter(t => t.netPnL < 0);

console.log(`\nTotal: ${threeConsec.length} trades`);
console.log(`Winners: ${threeConsecWins.length}, Losers: ${threeConsecLoss.length}`);
console.log(`Win Rate: ${(threeConsecWins.length/threeConsec.length*100).toFixed(1)}%`);

console.log('\nAll 3+ consecutive trades:');
threeConsec.sort((a, b) => a.entryTime - b.entryTime).forEach(t => {
  const d = new Date(t.entryTime);
  const result = t.netPnL > 0 ? 'WIN' : 'LOSS';
  console.log(`  ${d.toISOString().split('T')[0]} ${t.side.padEnd(5)} @ ${t.signal.levelType.padEnd(3)}: ${t.maxConsecAdverse} consec, cumulative ${t.maxConsecAdverseSum.toFixed(0)}pts adverse, P&L: $${t.netPnL.toFixed(0).padStart(6)} [${result}]`);
});

// What makes the 2 winners different from the 10 losers?
console.log(`\n${'='.repeat(80)}`);
console.log('COMPARING 3+ CONSECUTIVE: WINNERS vs LOSERS');
console.log(`${'='.repeat(80)}`);

if (threeConsecWins.length > 0) {
  console.log('\n3+ Consecutive WINNERS (what saved them?):');
  threeConsecWins.forEach(t => {
    const d = new Date(t.entryTime);
    console.log(`  ${d.toISOString().split('T')[0]} ${t.side} @ ${t.signal.levelType}:`);
    console.log(`    - Consec adverse: ${t.maxConsecAdverse}, started at ${(t.consecRelativeStart * 100).toFixed(0)}% of trade`);
    console.log(`    - Cumulative adverse during streak: ${t.maxConsecAdverseSum.toFixed(0)}pts`);
    console.log(`    - Total GF change: ${t.totalGFChange.toFixed(0)}pts`);
    console.log(`    - P&L: $${t.netPnL.toFixed(0)}, Exit: ${t.exitReason}`);
  });
}

if (threeConsecLoss.length > 0) {
  console.log('\n3+ Consecutive LOSERS:');
  threeConsecLoss.forEach(t => {
    const d = new Date(t.entryTime);
    console.log(`  ${d.toISOString().split('T')[0]} ${t.side} @ ${t.signal.levelType}:`);
    console.log(`    - Consec adverse: ${t.maxConsecAdverse}, started at ${(t.consecRelativeStart * 100).toFixed(0)}% of trade`);
    console.log(`    - Cumulative adverse during streak: ${t.maxConsecAdverseSum.toFixed(0)}pts`);
    console.log(`    - Total GF change: ${t.totalGFChange.toFixed(0)}pts`);
    console.log(`    - P&L: $${t.netPnL.toFixed(0)}, Exit: ${t.exitReason}`);
  });
}

// Refined signal: 3+ consecutive AND cumulative > X points
console.log(`\n${'='.repeat(80)}`);
console.log('REFINED SIGNAL: CONSECUTIVE + CUMULATIVE THRESHOLD');
console.log(`${'='.repeat(80)}`);

[20, 30, 40, 50, 75, 100].forEach(cumThreshold => {
  const matches = tradeAnalysis.filter(t => t.maxConsecAdverse >= 2 && t.maxConsecAdverseSum >= cumThreshold);
  const matchWins = matches.filter(t => t.netPnL > 0).length;
  const matchLoss = matches.filter(t => t.netPnL < 0).length;

  if (matches.length > 0) {
    console.log(`2+ consec AND cumulative >= ${cumThreshold}pts: ${matches.length} trades, ${matchWins}W/${matchLoss}L (${(matchLoss/matches.length*100).toFixed(0)}% losers)`);
  }
});

// Early timing signal: if streak starts early in trade
console.log(`\n${'='.repeat(80)}`);
console.log('TIMING ANALYSIS: WHEN DOES ADVERSE STREAK START?');
console.log(`${'='.repeat(80)}`);

const twoPlus = tradeAnalysis.filter(t => t.maxConsecAdverse >= 2 && t.consecRelativeStart !== null);

const earlyStreak = twoPlus.filter(t => t.consecRelativeStart < 0.33);
const midStreak = twoPlus.filter(t => t.consecRelativeStart >= 0.33 && t.consecRelativeStart < 0.66);
const lateStreak = twoPlus.filter(t => t.consecRelativeStart >= 0.66);

console.log('\nWhen 2+ consecutive adverse streak starts:');
console.log(`  Early (first 1/3): ${earlyStreak.length} trades, ${earlyStreak.filter(t=>t.netPnL>0).length}W/${earlyStreak.filter(t=>t.netPnL<0).length}L (${(earlyStreak.filter(t=>t.netPnL<0).length/earlyStreak.length*100).toFixed(0)}% losers)`);
console.log(`  Middle (mid 1/3): ${midStreak.length} trades, ${midStreak.filter(t=>t.netPnL>0).length}W/${midStreak.filter(t=>t.netPnL<0).length}L (${(midStreak.filter(t=>t.netPnL<0).length/midStreak.length*100).toFixed(0)}% losers)`);
console.log(`  Late (last 1/3): ${lateStreak.length} trades, ${lateStreak.filter(t=>t.netPnL>0).length}W/${lateStreak.filter(t=>t.netPnL<0).length}L (${(lateStreak.filter(t=>t.netPnL<0).length/lateStreak.length*100).toFixed(0)}% losers)`);

// Combined signal: early streak with cumulative threshold
console.log('\nCombined: Early streak (first 1/3) with cumulative threshold:');
[20, 30, 40, 50].forEach(cumThreshold => {
  const matches = earlyStreak.filter(t => t.maxConsecAdverseSum >= cumThreshold);
  if (matches.length > 0) {
    const wins = matches.filter(t => t.netPnL > 0).length;
    const losses = matches.filter(t => t.netPnL < 0).length;
    console.log(`  Early + cum >= ${cumThreshold}pts: ${matches.length} trades, ${wins}W/${losses}L (${(losses/matches.length*100).toFixed(0)}% losers)`);
  }
});

// RECOMMENDATION
console.log(`\n${'='.repeat(80)}`);
console.log('RECOMMENDED EARLY EXIT RULES');
console.log(`${'='.repeat(80)}`);

const best3Consec = tradeAnalysis.filter(t => t.maxConsecAdverse >= 3);
const best3ConsecSaved = best3Consec.filter(t => t.netPnL < 0).reduce((s, t) => s + Math.abs(t.netPnL), 0);
const best3ConsecLost = best3Consec.filter(t => t.netPnL > 0).reduce((s, t) => s + t.netPnL, 0);

console.log(`
OPTION 1: Simple Rule - Exit on 3+ consecutive adverse GF moves
  - Triggers: ${best3Consec.length} trades
  - Catches: ${best3Consec.filter(t=>t.netPnL<0).length} losers (saves ~$${best3ConsecSaved.toFixed(0)})
  - Hurts: ${best3Consec.filter(t=>t.netPnL>0).length} winners (loses ~$${best3ConsecLost.toFixed(0)})
  - Net benefit: $${(best3ConsecSaved - best3ConsecLost).toFixed(0)}
  - Loser catch rate: ${(best3Consec.filter(t=>t.netPnL<0).length/best3Consec.length*100).toFixed(0)}%

OPTION 2: Tighten to breakeven on 2+ consecutive (safer)
  - Use 2 consecutive as a WARNING signal
  - Tighten stop to breakeven instead of immediate exit
  - Preserves winners while protecting from further loss

IMPLEMENTATION LOGIC:
  1. Track GF value at each 15-min interval
  2. Count consecutive intervals where GF moves against position
  3. On 2 consecutive adverse moves: tighten stop to breakeven
  4. On 3 consecutive adverse moves: exit immediately at market
`);
