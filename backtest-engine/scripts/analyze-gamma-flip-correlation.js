#!/usr/bin/env node
/**
 * Analyze correlation between Zero Gamma (Gamma Flip) movement and spot price movement
 * during trades
 */

import fs from 'fs';
import path from 'path';

const resultsPath = process.argv[2] || 'results/iv-skew-gex-2025.json';
const gexDir = process.argv[3] || 'data/gex/nq';

const data = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), resultsPath), 'utf8'));

// Load all GEX intraday files for 2025
const gexFiles = fs.readdirSync(path.resolve(process.cwd(), gexDir))
  .filter(f => f.startsWith('nq_gex_2025') && f.endsWith('.json'));

console.log(`Loading ${gexFiles.length} GEX intraday files...`);

const gexSnapshots = new Map();
gexFiles.forEach(f => {
  try {
    const gexData = JSON.parse(fs.readFileSync(path.join(process.cwd(), gexDir, f), 'utf8'));
    gexData.data.forEach(snap => {
      const ts = new Date(snap.timestamp).getTime();
      gexSnapshots.set(ts, snap);
    });
  } catch (e) {}
});

console.log(`Loaded ${gexSnapshots.size} GEX snapshots`);

function getNearestGex(timestamp) {
  const rounded = Math.floor(timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);
  if (gexSnapshots.has(rounded)) return gexSnapshots.get(rounded);
  for (let offset = -15 * 60 * 1000; offset <= 15 * 60 * 1000; offset += 15 * 60 * 1000) {
    if (gexSnapshots.has(rounded + offset)) return gexSnapshots.get(rounded + offset);
  }
  return null;
}

const trades = data.trades.filter(t => t.status === 'completed');

console.log(`\n${'='.repeat(80)}`);
console.log('ZERO GAMMA vs SPOT PRICE CORRELATION ANALYSIS');
console.log(`${'='.repeat(80)}`);

// Collect data points
const correlationData = [];

trades.forEach(trade => {
  const entryGex = getNearestGex(trade.entryTime);
  const exitGex = getNearestGex(trade.exitTime);

  if (!entryGex || !exitGex) return;
  if (!entryGex.gamma_flip || !exitGex.gamma_flip) return;

  const gammaFlipMove = exitGex.gamma_flip - entryGex.gamma_flip;
  const spotMove = trade.actualExit - trade.actualEntry;

  // Also get nq_spot from GEX data if available
  const entrySpot = entryGex.nq_spot || trade.actualEntry;
  const exitSpot = exitGex.nq_spot || trade.actualExit;
  const gexSpotMove = exitSpot - entrySpot;

  correlationData.push({
    ...trade,
    gammaFlipEntry: entryGex.gamma_flip,
    gammaFlipExit: exitGex.gamma_flip,
    gammaFlipMove,
    spotMove,
    gexSpotMove,
    // Direction match: both moved same direction
    sameDirection: (gammaFlipMove > 0 && spotMove > 0) || (gammaFlipMove < 0 && spotMove < 0),
    // Relative position: was spot above or below gamma flip?
    entryAboveGF: trade.actualEntry > entryGex.gamma_flip,
    exitAboveGF: trade.actualExit > exitGex.gamma_flip
  });
});

console.log(`\nAnalyzed ${correlationData.length} trades with gamma flip data`);

// Calculate Pearson correlation coefficient
function pearsonCorrelation(x, y) {
  const n = x.length;
  if (n === 0) return 0;

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  return denominator === 0 ? 0 : numerator / denominator;
}

const gfMoves = correlationData.map(t => t.gammaFlipMove);
const spotMoves = correlationData.map(t => t.spotMove);

const correlation = pearsonCorrelation(gfMoves, spotMoves);

console.log(`\n${'='.repeat(80)}`);
console.log('CORRELATION STATISTICS');
console.log(`${'='.repeat(80)}`);

console.log(`\nPearson Correlation (Gamma Flip Move vs Spot Move): ${correlation.toFixed(4)}`);
console.log(`  Interpretation: ${
  Math.abs(correlation) < 0.2 ? 'WEAK/NO correlation' :
  Math.abs(correlation) < 0.5 ? 'MODERATE correlation' :
  'STRONG correlation'
} (${correlation > 0 ? 'positive' : 'negative'})`);

// Same direction analysis
const sameDir = correlationData.filter(t => t.sameDirection);
const oppositeDir = correlationData.filter(t => !t.sameDirection && t.gammaFlipMove !== 0);

console.log(`\n${'='.repeat(80)}`);
console.log('DIRECTION AGREEMENT ANALYSIS');
console.log(`${'='.repeat(80)}`);

console.log(`\nTrades where Gamma Flip and Spot moved SAME direction: ${sameDir.length}`);
const sameDirWins = sameDir.filter(t => t.netPnL > 0).length;
const sameDirLoss = sameDir.filter(t => t.netPnL < 0).length;
console.log(`  Win Rate: ${(sameDirWins/(sameDirWins+sameDirLoss)*100).toFixed(1)}% (${sameDirWins}W/${sameDirLoss}L)`);
console.log(`  Total P&L: $${sameDir.reduce((s,t) => s + t.netPnL, 0).toFixed(0)}`);

console.log(`\nTrades where Gamma Flip and Spot moved OPPOSITE directions: ${oppositeDir.length}`);
const oppDirWins = oppositeDir.filter(t => t.netPnL > 0).length;
const oppDirLoss = oppositeDir.filter(t => t.netPnL < 0).length;
console.log(`  Win Rate: ${(oppDirWins/(oppDirWins+oppDirLoss)*100).toFixed(1)}% (${oppDirWins}W/${oppDirLoss}L)`);
console.log(`  Total P&L: $${oppositeDir.reduce((s,t) => s + t.netPnL, 0).toFixed(0)}`);

// Movement magnitude analysis
console.log(`\n${'='.repeat(80)}`);
console.log('MOVEMENT MAGNITUDE ANALYSIS');
console.log(`${'='.repeat(80)}`);

const winners = correlationData.filter(t => t.netPnL > 0);
const losers = correlationData.filter(t => t.netPnL < 0);

const avgGFMoveWin = winners.reduce((s,t) => s + t.gammaFlipMove, 0) / winners.length;
const avgGFMoveLose = losers.reduce((s,t) => s + t.gammaFlipMove, 0) / losers.length;
const avgAbsGFMoveWin = winners.reduce((s,t) => s + Math.abs(t.gammaFlipMove), 0) / winners.length;
const avgAbsGFMoveLose = losers.reduce((s,t) => s + Math.abs(t.gammaFlipMove), 0) / losers.length;

console.log('\nGamma Flip Movement:');
console.log(`  Winners: avg ${avgGFMoveWin.toFixed(1)}pts, avg |move| ${avgAbsGFMoveWin.toFixed(1)}pts`);
console.log(`  Losers:  avg ${avgGFMoveLose.toFixed(1)}pts, avg |move| ${avgAbsGFMoveLose.toFixed(1)}pts`);

const avgSpotMoveWin = winners.reduce((s,t) => s + t.spotMove, 0) / winners.length;
const avgSpotMoveLose = losers.reduce((s,t) => s + t.spotMove, 0) / losers.length;

console.log('\nSpot Price Movement:');
console.log(`  Winners: avg ${avgSpotMoveWin.toFixed(1)}pts`);
console.log(`  Losers:  avg ${avgSpotMoveLose.toFixed(1)}pts`);

// Analyze by trade side
console.log(`\n${'='.repeat(80)}`);
console.log('ANALYSIS BY TRADE SIDE');
console.log(`${'='.repeat(80)}`);

// For LONG trades: does GF moving up help?
const longs = correlationData.filter(t => t.side === 'long');
const longsGFUp = longs.filter(t => t.gammaFlipMove > 10);
const longsGFDown = longs.filter(t => t.gammaFlipMove < -10);
const longsGFStable = longs.filter(t => Math.abs(t.gammaFlipMove) <= 10);

console.log('\nLONG Trades - Gamma Flip Movement Impact:');
console.log(`  GF moved UP (>10pts): ${longsGFUp.length} trades, ${(longsGFUp.filter(t=>t.netPnL>0).length/longsGFUp.length*100).toFixed(1)}% WR`);
console.log(`  GF moved DOWN (<-10pts): ${longsGFDown.length} trades, ${longsGFDown.length > 0 ? (longsGFDown.filter(t=>t.netPnL>0).length/longsGFDown.length*100).toFixed(1) : 'N/A'}% WR`);
console.log(`  GF STABLE (±10pts): ${longsGFStable.length} trades, ${(longsGFStable.filter(t=>t.netPnL>0).length/longsGFStable.length*100).toFixed(1)}% WR`);

// For SHORT trades: does GF moving down help?
const shorts = correlationData.filter(t => t.side === 'short');
const shortsGFUp = shorts.filter(t => t.gammaFlipMove > 10);
const shortsGFDown = shorts.filter(t => t.gammaFlipMove < -10);
const shortsGFStable = shorts.filter(t => Math.abs(t.gammaFlipMove) <= 10);

console.log('\nSHORT Trades - Gamma Flip Movement Impact:');
console.log(`  GF moved UP (>10pts): ${shortsGFUp.length} trades, ${shortsGFUp.length > 0 ? (shortsGFUp.filter(t=>t.netPnL>0).length/shortsGFUp.length*100).toFixed(1) : 'N/A'}% WR`);
console.log(`  GF moved DOWN (<-10pts): ${shortsGFDown.length} trades, ${shortsGFDown.length > 0 ? (shortsGFDown.filter(t=>t.netPnL>0).length/shortsGFDown.length*100).toFixed(1) : 'N/A'}% WR`);
console.log(`  GF STABLE (±10pts): ${shortsGFStable.length} trades, ${(shortsGFStable.filter(t=>t.netPnL>0).length/shortsGFStable.length*100).toFixed(1)}% WR`);

// Analyze large GF moves
console.log(`\n${'='.repeat(80)}`);
console.log('LARGE GAMMA FLIP MOVEMENT ANALYSIS');
console.log(`${'='.repeat(80)}`);

const largeGFMoves = [50, 100, 150, 200];
largeGFMoves.forEach(threshold => {
  const bigMoves = correlationData.filter(t => Math.abs(t.gammaFlipMove) > threshold);
  if (bigMoves.length > 0) {
    const wins = bigMoves.filter(t => t.netPnL > 0).length;
    const losses = bigMoves.filter(t => t.netPnL < 0).length;
    console.log(`\n|GF Move| > ${threshold}pts: ${bigMoves.length} trades, ${(wins/bigMoves.length*100).toFixed(1)}% WR`);

    // Break down by direction relative to trade
    const favorable = bigMoves.filter(t =>
      (t.side === 'long' && t.gammaFlipMove > 0) ||
      (t.side === 'short' && t.gammaFlipMove < 0)
    );
    const unfavorable = bigMoves.filter(t =>
      (t.side === 'long' && t.gammaFlipMove < 0) ||
      (t.side === 'short' && t.gammaFlipMove > 0)
    );

    if (favorable.length > 0) {
      console.log(`    Favorable (GF moves with trade): ${favorable.length} trades, ${(favorable.filter(t=>t.netPnL>0).length/favorable.length*100).toFixed(1)}% WR`);
    }
    if (unfavorable.length > 0) {
      console.log(`    Unfavorable (GF moves against trade): ${unfavorable.length} trades, ${(unfavorable.filter(t=>t.netPnL>0).length/unfavorable.length*100).toFixed(1)}% WR`);
    }
  }
});

// Scatter plot data for visualization
console.log(`\n${'='.repeat(80)}`);
console.log('SCATTER PLOT DATA (GF Move vs Spot Move)');
console.log(`${'='.repeat(80)}`);

console.log('\nGamma Flip Move | Spot Move | P&L | Result | Side');
console.log('-'.repeat(60));

// Show a sample of trades to visualize the relationship
const sortedByGF = [...correlationData].sort((a, b) => a.gammaFlipMove - b.gammaFlipMove);
const sample = [
  ...sortedByGF.slice(0, 10),  // Most negative GF moves
  ...sortedByGF.slice(-10)     // Most positive GF moves
];

sample.forEach(t => {
  const result = t.netPnL > 0 ? 'WIN' : 'LOSS';
  console.log(`${t.gammaFlipMove.toFixed(1).padStart(15)} | ${t.spotMove.toFixed(1).padStart(9)} | $${t.netPnL.toFixed(0).padStart(5)} | ${result.padStart(4)} | ${t.side}`);
});

// Position relative to Gamma Flip analysis
console.log(`\n${'='.repeat(80)}`);
console.log('POSITION RELATIVE TO GAMMA FLIP');
console.log(`${'='.repeat(80)}`);

// Did the trade cross through gamma flip?
const crossedThrough = correlationData.filter(t => t.entryAboveGF !== t.exitAboveGF);
const stayedAbove = correlationData.filter(t => t.entryAboveGF && t.exitAboveGF);
const stayedBelow = correlationData.filter(t => !t.entryAboveGF && !t.exitAboveGF);

console.log(`\nPrice crossed through Gamma Flip: ${crossedThrough.length} trades`);
if (crossedThrough.length > 0) {
  const crossWins = crossedThrough.filter(t => t.netPnL > 0).length;
  console.log(`  Win Rate: ${(crossWins/crossedThrough.length*100).toFixed(1)}%`);
}

console.log(`\nPrice stayed ABOVE Gamma Flip: ${stayedAbove.length} trades`);
if (stayedAbove.length > 0) {
  const aboveWins = stayedAbove.filter(t => t.netPnL > 0).length;
  console.log(`  Win Rate: ${(aboveWins/stayedAbove.length*100).toFixed(1)}%`);
}

console.log(`\nPrice stayed BELOW Gamma Flip: ${stayedBelow.length} trades`);
if (stayedBelow.length > 0) {
  const belowWins = stayedBelow.filter(t => t.netPnL > 0).length;
  console.log(`  Win Rate: ${(belowWins/stayedBelow.length*100).toFixed(1)}%`);
}

// Specific analysis: When GF moves a lot but spot doesn't follow
console.log(`\n${'='.repeat(80)}`);
console.log('DIVERGENCE ANALYSIS: GF MOVES BUT SPOT DOESN\'T FOLLOW');
console.log(`${'='.repeat(80)}`);

const divergence = correlationData.filter(t =>
  Math.abs(t.gammaFlipMove) > 50 &&
  Math.abs(t.spotMove) < 30
);

console.log(`\nLarge GF move (>50pts) but small spot move (<30pts): ${divergence.length} trades`);
if (divergence.length > 0) {
  const divWins = divergence.filter(t => t.netPnL > 0).length;
  console.log(`  Win Rate: ${(divWins/divergence.length*100).toFixed(1)}%`);
  console.log(`  Average P&L: $${(divergence.reduce((s,t) => s + t.netPnL, 0) / divergence.length).toFixed(0)}`);

  console.log('\nDivergence trades:');
  divergence.forEach(t => {
    const d = new Date(t.entryTime);
    console.log(`  ${d.toISOString().split('T')[0]}: ${t.side} - GF: ${t.gammaFlipMove.toFixed(0)}pts, Spot: ${t.spotMove.toFixed(0)}pts, P&L: $${t.netPnL.toFixed(0)}`);
  });
}

// Recommendations
console.log(`\n${'='.repeat(80)}`);
console.log('SUMMARY AND RECOMMENDATIONS');
console.log(`${'='.repeat(80)}`);

console.log(`
CORRELATION FINDINGS:

1. Pearson Correlation: ${correlation.toFixed(4)}
   - ${Math.abs(correlation) < 0.3 ? 'Gamma Flip and Spot price movements are NOT strongly correlated' : 'There IS correlation between GF and Spot movements'}

2. Direction Agreement:
   - Same direction: ${sameDir.length} trades, ${(sameDirWins/(sameDirWins+sameDirLoss)*100).toFixed(1)}% WR
   - Opposite direction: ${oppositeDir.length} trades, ${(oppDirWins/(oppDirWins+oppDirLoss)*100).toFixed(1)}% WR
   ${Math.abs(sameDirWins/(sameDirWins+sameDirLoss) - oppDirWins/(oppDirWins+oppDirLoss)) > 0.1 ?
     '→ SIGNIFICANT difference based on direction alignment' :
     '→ Direction alignment does NOT significantly predict outcome'}

3. Key Insight for Losers:
   - Average GF move for winners: ${avgGFMoveWin.toFixed(1)} pts
   - Average GF move for losers: ${avgGFMoveLose.toFixed(1)} pts

ACTIONABLE RECOMMENDATIONS:
${Math.abs(correlation) > 0.3 ?
  '- Consider using GF movement as a confirming indicator' :
  '- GF movement alone is NOT predictive - focus on level movement instead'}
`);
