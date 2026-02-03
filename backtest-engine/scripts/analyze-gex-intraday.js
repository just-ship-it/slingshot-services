#!/usr/bin/env node
/**
 * Analyze intraday GEX level movement during trades using 15-minute snapshots
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

// Build a map of timestamp -> GEX snapshot
const gexSnapshots = new Map();

gexFiles.forEach(f => {
  try {
    const gexData = JSON.parse(fs.readFileSync(path.join(process.cwd(), gexDir, f), 'utf8'));
    gexData.data.forEach(snap => {
      // Parse timestamp and round to 15-minute boundary
      const ts = new Date(snap.timestamp).getTime();
      gexSnapshots.set(ts, snap);
    });
  } catch (e) {
    // Skip files with errors
  }
});

console.log(`Loaded ${gexSnapshots.size} GEX snapshots`);

// Function to find nearest GEX snapshot for a timestamp
function getNearestGex(timestamp) {
  // Round to 15-minute boundary
  const rounded = Math.floor(timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);

  // Try exact match first
  if (gexSnapshots.has(rounded)) {
    return gexSnapshots.get(rounded);
  }

  // Try nearby timestamps (±15 min)
  for (let offset = -15 * 60 * 1000; offset <= 15 * 60 * 1000; offset += 15 * 60 * 1000) {
    if (gexSnapshots.has(rounded + offset)) {
      return gexSnapshots.get(rounded + offset);
    }
  }

  return null;
}

// Get level from snapshot based on type
function getLevelFromSnapshot(snap, levelType) {
  if (!snap) return null;

  if (levelType === 'GammaFlip') return snap.gamma_flip;
  if (levelType === 'CallWall') return snap.call_wall;
  if (levelType === 'PutWall') return snap.put_wall;

  // Support levels (S1-S5)
  if (levelType.startsWith('S')) {
    const idx = parseInt(levelType.slice(1)) - 1;
    return snap.support?.[idx] || null;
  }

  // Resistance levels (R1-R5)
  if (levelType.startsWith('R')) {
    const idx = parseInt(levelType.slice(1)) - 1;
    return snap.resistance?.[idx] || null;
  }

  return null;
}

const trades = data.trades.filter(t => t.status === 'completed');
const losers = trades.filter(t => t.netPnL < 0);
const winners = trades.filter(t => t.netPnL > 0);

console.log(`\n${'='.repeat(80)}`);
console.log('INTRADAY GEX LEVEL MOVEMENT ANALYSIS');
console.log(`${'='.repeat(80)}`);

// Analyze each trade
const tradeAnalysis = [];

trades.forEach(trade => {
  const entryGex = getNearestGex(trade.entryTime);
  const exitGex = getNearestGex(trade.exitTime);

  if (!entryGex || !exitGex) return;

  const levelType = trade.signal.levelType;
  const entryLevel = getLevelFromSnapshot(entryGex, levelType);
  const exitLevel = getLevelFromSnapshot(exitGex, levelType);

  const entryGammaFlip = entryGex.gamma_flip;
  const exitGammaFlip = exitGex.gamma_flip;

  const entryS1 = entryGex.support?.[0];
  const exitS1 = exitGex.support?.[0];
  const entryR1 = entryGex.resistance?.[0];
  const exitR1 = exitGex.resistance?.[0];

  // Calculate movements
  const levelMove = entryLevel && exitLevel ? exitLevel - entryLevel : null;
  const gammaFlipMove = entryGammaFlip && exitGammaFlip ? exitGammaFlip - entryGammaFlip : null;
  const s1Move = entryS1 && exitS1 ? exitS1 - entryS1 : null;
  const r1Move = entryR1 && exitR1 ? exitR1 - entryR1 : null;

  // Determine if level moved favorably or unfavorably
  let levelMoveDir = 'stable';
  if (levelMove !== null && Math.abs(levelMove) > 5) {
    if (trade.side === 'long') {
      // For longs on support: level moving up is favorable
      if (levelType.startsWith('S') || levelType === 'PutWall') {
        levelMoveDir = levelMove > 0 ? 'favorable' : 'unfavorable';
      }
    } else {
      // For shorts on resistance: level moving down is favorable
      if (levelType.startsWith('R') || levelType === 'CallWall') {
        levelMoveDir = levelMove < 0 ? 'favorable' : 'unfavorable';
      }
    }
  }

  // Check if price moved relative to gamma flip
  const entryAboveGF = trade.actualEntry > entryGammaFlip;
  const exitAboveGF = trade.actualExit > (exitGammaFlip || entryGammaFlip);
  const crossedGammaFlip = entryAboveGF !== exitAboveGF;

  // Regime change
  const regimeChanged = entryGex.regime !== exitGex.regime;

  tradeAnalysis.push({
    ...trade,
    entryGex,
    exitGex,
    levelMove,
    gammaFlipMove,
    s1Move,
    r1Move,
    levelMoveDir,
    crossedGammaFlip,
    regimeChanged,
    entryRegime: entryGex.regime,
    exitRegime: exitGex.regime
  });
});

console.log(`\nAnalyzed ${tradeAnalysis.length} trades with intraday GEX data`);

const analyzedWinners = tradeAnalysis.filter(t => t.netPnL > 0);
const analyzedLosers = tradeAnalysis.filter(t => t.netPnL < 0);

// Helper function
function calcStats(arr) {
  if (arr.length === 0) return { mean: 0, absAvg: 0, count: 0 };
  const mean = arr.reduce((s,v) => s+v, 0) / arr.length;
  const absAvg = arr.reduce((s,v) => s + Math.abs(v), 0) / arr.length;
  return { mean, absAvg, count: arr.length };
}

// LEVEL MOVEMENT STATISTICS
console.log(`\n${'='.repeat(80)}`);
console.log('TRADED LEVEL MOVEMENT STATISTICS');
console.log(`${'='.repeat(80)}`);

const winLevelMoves = analyzedWinners.map(t => t.levelMove).filter(v => v !== null);
const loseLevelMoves = analyzedLosers.map(t => t.levelMove).filter(v => v !== null);

const winStats = calcStats(winLevelMoves);
const loseStats = calcStats(loseLevelMoves);

console.log('\nTraded level movement during trade:');
console.log(`  Winners: mean=${winStats.mean.toFixed(1)}pts, avg |move|=${winStats.absAvg.toFixed(1)}pts, n=${winStats.count}`);
console.log(`  Losers:  mean=${loseStats.mean.toFixed(1)}pts, avg |move|=${loseStats.absAvg.toFixed(1)}pts, n=${loseStats.count}`);

// GAMMA FLIP MOVEMENT
console.log(`\n${'='.repeat(80)}`);
console.log('GAMMA FLIP MOVEMENT STATISTICS');
console.log(`${'='.repeat(80)}`);

const winGFMoves = analyzedWinners.map(t => t.gammaFlipMove).filter(v => v !== null);
const loseGFMoves = analyzedLosers.map(t => t.gammaFlipMove).filter(v => v !== null);

const winGFStats = calcStats(winGFMoves);
const loseGFStats = calcStats(loseGFMoves);

console.log('\nGamma Flip movement during trade:');
console.log(`  Winners: mean=${winGFStats.mean.toFixed(1)}pts, avg |move|=${winGFStats.absAvg.toFixed(1)}pts, n=${winGFStats.count}`);
console.log(`  Losers:  mean=${loseGFStats.mean.toFixed(1)}pts, avg |move|=${loseGFStats.absAvg.toFixed(1)}pts, n=${loseGFStats.count}`);

// S1 MOVEMENT
console.log('\nS1 (Support 1) movement during trade:');
const winS1Stats = calcStats(analyzedWinners.map(t => t.s1Move).filter(v => v !== null));
const loseS1Stats = calcStats(analyzedLosers.map(t => t.s1Move).filter(v => v !== null));
console.log(`  Winners: mean=${winS1Stats.mean.toFixed(1)}pts, avg |move|=${winS1Stats.absAvg.toFixed(1)}pts, n=${winS1Stats.count}`);
console.log(`  Losers:  mean=${loseS1Stats.mean.toFixed(1)}pts, avg |move|=${loseS1Stats.absAvg.toFixed(1)}pts, n=${loseS1Stats.count}`);

// R1 MOVEMENT
console.log('\nR1 (Resistance 1) movement during trade:');
const winR1Stats = calcStats(analyzedWinners.map(t => t.r1Move).filter(v => v !== null));
const loseR1Stats = calcStats(analyzedLosers.map(t => t.r1Move).filter(v => v !== null));
console.log(`  Winners: mean=${winR1Stats.mean.toFixed(1)}pts, avg |move|=${winR1Stats.absAvg.toFixed(1)}pts, n=${winR1Stats.count}`);
console.log(`  Losers:  mean=${loseR1Stats.mean.toFixed(1)}pts, avg |move|=${loseR1Stats.absAvg.toFixed(1)}pts, n=${loseR1Stats.count}`);

// LEVEL MOVE DIRECTION ANALYSIS
console.log(`\n${'='.repeat(80)}`);
console.log('LEVEL MOVE DIRECTION vs OUTCOME');
console.log(`${'='.repeat(80)}`);

const directions = { favorable: { win: 0, lose: 0 }, unfavorable: { win: 0, lose: 0 }, stable: { win: 0, lose: 0 } };
tradeAnalysis.forEach(t => {
  if (t.netPnL > 0) directions[t.levelMoveDir].win++;
  else directions[t.levelMoveDir].lose++;
});

console.log('\nOutcome by level move direction:');
Object.entries(directions).forEach(([dir, counts]) => {
  const total = counts.win + counts.lose;
  if (total > 0) {
    console.log(`  ${dir.padEnd(11)}: ${counts.win}W/${counts.lose}L (${(counts.win/total*100).toFixed(1)}% WR)`);
  }
});

// LARGE LEVEL MOVEMENTS
console.log(`\n${'='.repeat(80)}`);
console.log('LARGE LEVEL MOVEMENTS (>30 pts)');
console.log(`${'='.repeat(80)}`);

const largeLevelMove = tradeAnalysis.filter(t => t.levelMove !== null && Math.abs(t.levelMove) > 30);
const largeMoveWin = largeLevelMove.filter(t => t.netPnL > 0);
const largeMoveLose = largeLevelMove.filter(t => t.netPnL < 0);

console.log(`\nTrades with |level move| > 30pts: ${largeLevelMove.length}`);
console.log(`  Winners: ${largeMoveWin.length}, Losers: ${largeMoveLose.length}`);
if (largeLevelMove.length > 0) {
  console.log(`  Win Rate: ${(largeMoveWin.length/largeLevelMove.length*100).toFixed(1)}%`);
}

if (largeMoveLose.length > 0) {
  console.log('\nLosers with large level movement:');
  largeMoveLose.forEach(t => {
    const d = new Date(t.entryTime);
    const dateStr = d.toISOString().split('T')[0];
    const timeStr = `${d.getUTCHours().toString().padStart(2,'0')}:${d.getUTCMinutes().toString().padStart(2,'0')}`;
    console.log(`  ${dateStr} ${timeStr}: ${t.side} @ ${t.signal.levelType}, Level moved ${t.levelMove?.toFixed(1)}pts, P&L: $${t.netPnL.toFixed(0)}`);
  });
}

// GAMMA FLIP CROSSING
console.log(`\n${'='.repeat(80)}`);
console.log('GAMMA FLIP CROSSING ANALYSIS');
console.log(`${'='.repeat(80)}`);

const gfCrossed = tradeAnalysis.filter(t => t.crossedGammaFlip);
const gfNotCrossed = tradeAnalysis.filter(t => !t.crossedGammaFlip);

console.log(`\nTrades where price crossed Gamma Flip: ${gfCrossed.length}`);
if (gfCrossed.length > 0) {
  const gfCrossWin = gfCrossed.filter(t => t.netPnL > 0).length;
  const gfCrossLose = gfCrossed.filter(t => t.netPnL < 0).length;
  console.log(`  Win Rate: ${(gfCrossWin/gfCrossed.length*100).toFixed(1)}% (${gfCrossWin}W/${gfCrossLose}L)`);

  console.log('\nGamma Flip crossing trades:');
  gfCrossed.forEach(t => {
    const d = new Date(t.entryTime);
    console.log(`  ${d.toISOString().split('T')[0]}: ${t.side} @ ${t.signal.levelType}, P&L: $${t.netPnL.toFixed(0)}, GF: ${t.entryGex.gamma_flip?.toFixed(0)} → ${t.exitGex.gamma_flip?.toFixed(0)}`);
  });
}

console.log(`\nTrades where price did NOT cross Gamma Flip: ${gfNotCrossed.length}`);
if (gfNotCrossed.length > 0) {
  const gfNotWin = gfNotCrossed.filter(t => t.netPnL > 0).length;
  const gfNotLose = gfNotCrossed.filter(t => t.netPnL < 0).length;
  console.log(`  Win Rate: ${(gfNotWin/gfNotCrossed.length*100).toFixed(1)}% (${gfNotWin}W/${gfNotLose}L)`);
}

// REGIME CHANGE ANALYSIS
console.log(`\n${'='.repeat(80)}`);
console.log('REGIME CHANGE ANALYSIS');
console.log(`${'='.repeat(80)}`);

const regimeChanged = tradeAnalysis.filter(t => t.regimeChanged);
const regimeSame = tradeAnalysis.filter(t => !t.regimeChanged);

console.log(`\nTrades where regime changed: ${regimeChanged.length}`);
if (regimeChanged.length > 0) {
  const regChangeWin = regimeChanged.filter(t => t.netPnL > 0).length;
  const regChangeLose = regimeChanged.filter(t => t.netPnL < 0).length;
  console.log(`  Win Rate: ${(regChangeWin/regimeChanged.length*100).toFixed(1)}% (${regChangeWin}W/${regChangeLose}L)`);

  console.log('\nRegime change details:');
  regimeChanged.forEach(t => {
    const d = new Date(t.entryTime);
    console.log(`  ${d.toISOString().split('T')[0]}: ${t.entryRegime} → ${t.exitRegime}, ${t.side} @ ${t.signal.levelType}, P&L: $${t.netPnL.toFixed(0)}`);
  });
}

console.log(`\nTrades where regime stayed same: ${regimeSame.length}`);
if (regimeSame.length > 0) {
  const regSameWin = regimeSame.filter(t => t.netPnL > 0).length;
  const regSameLose = regimeSame.filter(t => t.netPnL < 0).length;
  console.log(`  Win Rate: ${(regSameWin/regimeSame.length*100).toFixed(1)}% (${regSameWin}W/${regSameLose}L)`);
}

// BY REGIME
console.log(`\n${'='.repeat(80)}`);
console.log('PERFORMANCE BY ENTRY REGIME');
console.log(`${'='.repeat(80)}`);

const byRegime = {};
tradeAnalysis.forEach(t => {
  const reg = t.entryRegime || 'unknown';
  if (!byRegime[reg]) byRegime[reg] = { win: 0, lose: 0, pnl: 0 };
  if (t.netPnL > 0) byRegime[reg].win++;
  else byRegime[reg].lose++;
  byRegime[reg].pnl += t.netPnL;
});

console.log('\nPerformance by GEX regime:');
Object.entries(byRegime).sort((a,b) => (b[1].win+b[1].lose) - (a[1].win+a[1].lose)).forEach(([regime, stats]) => {
  const total = stats.win + stats.lose;
  console.log(`  ${regime.padEnd(20)}: ${stats.win}W/${stats.lose}L (${(stats.win/total*100).toFixed(1)}% WR), P&L: $${stats.pnl.toFixed(0)}`);
});

// LOSERS WITH UNFAVORABLE LEVEL MOVE
console.log(`\n${'='.repeat(80)}`);
console.log('LOSERS WITH UNFAVORABLE LEVEL MOVEMENT');
console.log(`${'='.repeat(80)}`);

const unfavorableLosers = analyzedLosers.filter(t => t.levelMoveDir === 'unfavorable');
console.log(`\nLosers with unfavorable level movement: ${unfavorableLosers.length}`);

if (unfavorableLosers.length > 0) {
  unfavorableLosers.forEach(t => {
    const d = new Date(t.entryTime);
    console.log(`  ${d.toISOString().split('T')[0]} ${t.side} @ ${t.signal.levelType}: Level moved ${t.levelMove?.toFixed(1)}pts (${t.levelMoveDir}), P&L: $${t.netPnL.toFixed(0)}`);
  });
}

// RECOMMENDATIONS
console.log(`\n${'='.repeat(80)}`);
console.log('RECOMMENDATIONS');
console.log(`${'='.repeat(80)}`);

const avgWinLevelMove = winStats.absAvg;
const avgLoseLevelMove = loseStats.absAvg;

console.log(`
INTRADAY GEX MONITORING RECOMMENDATIONS:

1. LEVEL MOVEMENT MONITORING
   - Average |level move| for winners: ${avgWinLevelMove.toFixed(1)} pts
   - Average |level move| for losers: ${avgLoseLevelMove.toFixed(1)} pts
   - ${avgLoseLevelMove > avgWinLevelMove ? 'LOSERS have MORE level movement' : 'Winners and losers have similar level movement'}

2. LARGE LEVEL MOVEMENT FILTER
   - ${largeLevelMove.length} trades had >30pt level movement
   - Win rate: ${largeLevelMove.length > 0 ? (largeMoveWin.length/largeLevelMove.length*100).toFixed(1) : 'N/A'}%
   - Consider: Exit early if traded level moves >30pts unfavorably

3. REGIME CHANGE EXIT
   - ${regimeChanged.length} trades had regime change during trade
   - ${regimeChanged.length > 0 ? 'Win rate: ' + (regimeChanged.filter(t=>t.netPnL>0).length/regimeChanged.length*100).toFixed(1) + '%' : 'No regime changes'}
   - Consider: Exit if regime changes during trade

4. GAMMA FLIP AWARENESS
   - ${gfCrossed.length} trades had price cross gamma flip
   - This is ${gfCrossed.length < tradeAnalysis.length * 0.05 ? 'RARE' : 'COMMON'} in this dataset
`);
