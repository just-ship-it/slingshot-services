#!/usr/bin/env node
/**
 * Analyze GEX level movement during trades
 * If S1/R1/GammaFlip move significantly, the trade thesis may have changed
 */

import fs from 'fs';
import path from 'path';

const resultsPath = process.argv[2] || 'results/iv-skew-gex-2025.json';
const gexPath = process.argv[3] || 'data/gex/NQ_gex_levels.csv';

const data = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), resultsPath), 'utf8'));
const gexRaw = fs.readFileSync(path.resolve(process.cwd(), gexPath), 'utf8');

// Parse GEX levels CSV
// Format: date,nq_gamma_flip,nq_put_wall_1,nq_put_wall_2,nq_put_wall_3,nq_call_wall_1,nq_call_wall_2,nq_call_wall_3,total_gex,regime
const gexLines = gexRaw.trim().split('\n');
const gexHeader = gexLines[0].split(',');
const gexLevels = [];

for (let i = 1; i < gexLines.length; i++) {
  const cols = gexLines[i].split(',');
  const dateStr = cols[0];
  // Parse date - format is YYYY-MM-DD
  const [year, month, day] = dateStr.split('-').map(Number);
  const ts = new Date(Date.UTC(year, month - 1, day)).getTime();

  gexLevels.push({
    date: dateStr,
    timestamp: ts,
    gammaFlip: parseFloat(cols[1]) || null,
    putWall1: parseFloat(cols[2]) || null,  // S1
    putWall2: parseFloat(cols[3]) || null,  // S2
    putWall3: parseFloat(cols[4]) || null,  // S3
    callWall1: parseFloat(cols[5]) || null, // R1
    callWall2: parseFloat(cols[6]) || null, // R2
    callWall3: parseFloat(cols[7]) || null, // R3
    totalGex: parseFloat(cols[8]) || null,
    regime: cols[9]
  });
}

// Sort by timestamp
gexLevels.sort((a, b) => a.timestamp - b.timestamp);

// Function to find GEX levels for a given timestamp
function getGexForDate(timestamp) {
  // Find the most recent GEX data before or on this date
  const date = new Date(timestamp);
  const targetDate = `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;

  // GEX levels are published daily at market open
  // So for intraday trades, use the current day's levels
  for (let i = gexLevels.length - 1; i >= 0; i--) {
    if (gexLevels[i].date <= targetDate) {
      return gexLevels[i];
    }
  }
  return null;
}

const trades = data.trades.filter(t => t.status === 'completed');
const losers = trades.filter(t => t.netPnL < 0);
const winners = trades.filter(t => t.netPnL > 0);

console.log('='.repeat(80));
console.log('GEX LEVEL MOVEMENT DURING TRADES');
console.log('='.repeat(80));

// For each trade, calculate how much the relevant GEX level moved
// between entry and exit

// Note: Daily GEX data won't show intraday movement, but will show
// day-over-day changes for multi-day trades

const tradeGexAnalysis = [];

trades.forEach(trade => {
  const entryGex = getGexForDate(trade.entryTime);
  const exitGex = getGexForDate(trade.exitTime);

  if (!entryGex || !exitGex) return;

  // Get the level that was traded
  const levelType = trade.signal.levelType;
  let entryLevel = trade.signal.levelPrice;
  let exitLevel = null;

  // Map level types to GEX data fields
  if (levelType === 'S1') exitLevel = exitGex.putWall1;
  else if (levelType === 'S2') exitLevel = exitGex.putWall2;
  else if (levelType === 'S3') exitLevel = exitGex.putWall3;
  else if (levelType === 'R1') exitLevel = exitGex.callWall1;
  else if (levelType === 'R2') exitLevel = exitGex.callWall2;
  else if (levelType === 'R3') exitLevel = exitGex.callWall3;
  else if (levelType === 'GammaFlip') exitLevel = exitGex.gammaFlip;

  // Also track gamma flip movement (important for regime changes)
  const gammaFlipEntry = entryGex.gammaFlip;
  const gammaFlipExit = exitGex.gammaFlip;
  const gammaFlipMove = gammaFlipExit && gammaFlipEntry ? gammaFlipExit - gammaFlipEntry : null;

  // Calculate S1/R1 movement even if not trading those levels
  const s1Move = exitGex.putWall1 && entryGex.putWall1 ? exitGex.putWall1 - entryGex.putWall1 : null;
  const r1Move = exitGex.callWall1 && entryGex.callWall1 ? exitGex.callWall1 - entryGex.callWall1 : null;

  const levelMove = exitLevel && entryLevel ? exitLevel - entryLevel : null;

  // Check if price crossed through gamma flip during trade
  const entryPrice = trade.actualEntry;
  const exitPrice = trade.actualExit;
  const crossedGammaFlip = gammaFlipEntry &&
    ((entryPrice > gammaFlipEntry && exitPrice < gammaFlipEntry) ||
     (entryPrice < gammaFlipEntry && exitPrice > gammaFlipEntry));

  // Determine if the traded level moved away from price (unfavorable) or toward it
  let levelMoveDirection = null;
  if (levelMove !== null) {
    if (trade.side === 'long') {
      // For long, support moving down is bad (level getting weaker)
      levelMoveDirection = levelMove < 0 ? 'unfavorable' : (levelMove > 0 ? 'favorable' : 'stable');
    } else {
      // For short, resistance moving up is bad
      levelMoveDirection = levelMove > 0 ? 'unfavorable' : (levelMove < 0 ? 'favorable' : 'stable');
    }
  }

  tradeGexAnalysis.push({
    ...trade,
    entryDate: entryGex.date,
    exitDate: exitGex.date,
    entryGex,
    exitGex,
    levelMove,
    levelMoveDirection,
    gammaFlipMove,
    s1Move,
    r1Move,
    crossedGammaFlip,
    daysDiff: (new Date(exitGex.date).getTime() - new Date(entryGex.date).getTime()) / (1000 * 60 * 60 * 24)
  });
});

console.log(`\nAnalyzed ${tradeGexAnalysis.length} trades with GEX data`);

// Separate same-day trades from multi-day trades
const sameDayTrades = tradeGexAnalysis.filter(t => t.daysDiff === 0);
const multiDayTrades = tradeGexAnalysis.filter(t => t.daysDiff > 0);

console.log(`Same-day trades: ${sameDayTrades.length}`);
console.log(`Multi-day trades: ${multiDayTrades.length}`);

// For multi-day trades, analyze level movement
console.log(`\n${'='.repeat(80)}`);
console.log('MULTI-DAY TRADES - GEX LEVEL MOVEMENT');
console.log(`${'='.repeat(80)}`);

const multiWinners = multiDayTrades.filter(t => t.netPnL > 0);
const multiLosers = multiDayTrades.filter(t => t.netPnL < 0);

console.log(`\nMulti-day winners: ${multiWinners.length}`);
console.log(`Multi-day losers: ${multiLosers.length}`);

// Level movement stats
function calcMoveStats(trades, field) {
  const moves = trades.map(t => t[field]).filter(v => v !== null);
  if (moves.length === 0) return { count: 0, mean: 0, absAvg: 0 };
  const mean = moves.reduce((s,v) => s+v, 0) / moves.length;
  const absAvg = moves.reduce((s,v) => s + Math.abs(v), 0) / moves.length;
  return { count: moves.length, mean, absAvg };
}

console.log('\nGamma Flip Movement (multi-day trades):');
const winGFStats = calcMoveStats(multiWinners, 'gammaFlipMove');
const loseGFStats = calcMoveStats(multiLosers, 'gammaFlipMove');
console.log(`  Winners: ${winGFStats.count} trades, avg move ${winGFStats.mean.toFixed(1)}pts, avg |move| ${winGFStats.absAvg.toFixed(1)}pts`);
console.log(`  Losers:  ${loseGFStats.count} trades, avg move ${loseGFStats.mean.toFixed(1)}pts, avg |move| ${loseGFStats.absAvg.toFixed(1)}pts`);

console.log('\nS1 Movement (multi-day trades):');
const winS1Stats = calcMoveStats(multiWinners, 's1Move');
const loseS1Stats = calcMoveStats(multiLosers, 's1Move');
console.log(`  Winners: ${winS1Stats.count} trades, avg move ${winS1Stats.mean.toFixed(1)}pts, avg |move| ${winS1Stats.absAvg.toFixed(1)}pts`);
console.log(`  Losers:  ${loseS1Stats.count} trades, avg move ${loseS1Stats.mean.toFixed(1)}pts, avg |move| ${loseS1Stats.absAvg.toFixed(1)}pts`);

console.log('\nR1 Movement (multi-day trades):');
const winR1Stats = calcMoveStats(multiWinners, 'r1Move');
const loseR1Stats = calcMoveStats(multiLosers, 'r1Move');
console.log(`  Winners: ${winR1Stats.count} trades, avg move ${winR1Stats.mean.toFixed(1)}pts, avg |move| ${winR1Stats.absAvg.toFixed(1)}pts`);
console.log(`  Losers:  ${loseR1Stats.count} trades, avg move ${loseR1Stats.mean.toFixed(1)}pts, avg |move| ${loseR1Stats.absAvg.toFixed(1)}pts`);

// Analyze trades where level moved significantly
console.log(`\n${'='.repeat(80)}`);
console.log('SIGNIFICANT LEVEL MOVEMENTS (> 50 pts)');
console.log(`${'='.repeat(80)}`);

const bigMoves = multiDayTrades.filter(t =>
  Math.abs(t.gammaFlipMove || 0) > 50 ||
  Math.abs(t.s1Move || 0) > 50 ||
  Math.abs(t.r1Move || 0) > 50
);

console.log(`\nTrades with >50pt GEX level movement: ${bigMoves.length}`);
const bigMoveWinners = bigMoves.filter(t => t.netPnL > 0);
const bigMoveLosers = bigMoves.filter(t => t.netPnL < 0);
console.log(`  Winners: ${bigMoveWinners.length} (${(bigMoveWinners.length/bigMoves.length*100).toFixed(1)}%)`);
console.log(`  Losers: ${bigMoveLosers.length} (${(bigMoveLosers.length/bigMoves.length*100).toFixed(1)}%)`);

// Show the big move losers
if (bigMoveLosers.length > 0) {
  console.log('\nBig move losers:');
  bigMoveLosers.forEach(t => {
    console.log(`  ${t.entryDate} → ${t.exitDate}: ${t.side} @ ${t.signal.levelType}`);
    console.log(`    P&L: $${t.netPnL.toFixed(0)}, GF move: ${(t.gammaFlipMove||0).toFixed(0)}pts, S1: ${(t.s1Move||0).toFixed(0)}pts, R1: ${(t.r1Move||0).toFixed(0)}pts`);
  });
}

// Analyze level move direction (favorable vs unfavorable)
console.log(`\n${'='.repeat(80)}`);
console.log('LEVEL MOVE DIRECTION ANALYSIS (Multi-day trades)');
console.log(`${'='.repeat(80)}`);

const directions = { favorable: { win: 0, lose: 0 }, unfavorable: { win: 0, lose: 0 }, stable: { win: 0, lose: 0 } };
multiDayTrades.forEach(t => {
  if (t.levelMoveDirection) {
    if (t.netPnL > 0) directions[t.levelMoveDirection].win++;
    else directions[t.levelMoveDirection].lose++;
  }
});

console.log('\nTrade outcome by level move direction:');
Object.entries(directions).forEach(([dir, counts]) => {
  const total = counts.win + counts.lose;
  if (total > 0) {
    console.log(`  ${dir.padEnd(11)}: ${counts.win}W/${counts.lose}L (${(counts.win/total*100).toFixed(1)}% WR)`);
  }
});

// Check if price crossed gamma flip
console.log(`\n${'='.repeat(80)}`);
console.log('GAMMA FLIP CROSSING ANALYSIS');
console.log(`${'='.repeat(80)}`);

const gfCrossed = tradeGexAnalysis.filter(t => t.crossedGammaFlip);
const gfNotCrossed = tradeGexAnalysis.filter(t => !t.crossedGammaFlip);

console.log(`\nTrades where price crossed Gamma Flip: ${gfCrossed.length}`);
const gfCrossWin = gfCrossed.filter(t => t.netPnL > 0).length;
const gfCrossLose = gfCrossed.filter(t => t.netPnL < 0).length;
console.log(`  Win rate: ${(gfCrossWin/(gfCrossWin+gfCrossLose)*100).toFixed(1)}% (${gfCrossWin}W/${gfCrossLose}L)`);

console.log(`\nTrades where price did NOT cross Gamma Flip: ${gfNotCrossed.length}`);
const gfNotWin = gfNotCrossed.filter(t => t.netPnL > 0).length;
const gfNotLose = gfNotCrossed.filter(t => t.netPnL < 0).length;
console.log(`  Win rate: ${(gfNotWin/(gfNotWin+gfNotLose)*100).toFixed(1)}% (${gfNotWin}W/${gfNotLose}L)`);

// Gamma flip crossed losers
if (gfCrossLose > 0) {
  console.log('\nLosers where price crossed Gamma Flip:');
  gfCrossed.filter(t => t.netPnL < 0).forEach(t => {
    const d = new Date(t.entryTime);
    console.log(`  ${d.toISOString().split('T')[0]}: ${t.side} @ ${t.signal.levelType}, Entry: ${t.actualEntry.toFixed(2)}, GF: ${t.entryGex.gammaFlip?.toFixed(2)}`);
  });
}

// Analyze regime changes
console.log(`\n${'='.repeat(80)}`);
console.log('REGIME ANALYSIS');
console.log(`${'='.repeat(80)}`);

const regimeAtEntry = {};
tradeGexAnalysis.forEach(t => {
  const regime = t.entryGex.regime;
  if (!regimeAtEntry[regime]) regimeAtEntry[regime] = { win: 0, lose: 0 };
  if (t.netPnL > 0) regimeAtEntry[regime].win++;
  else regimeAtEntry[regime].lose++;
});

console.log('\nPerformance by GEX regime at entry:');
Object.entries(regimeAtEntry).sort((a,b) => (b[1].win+b[1].lose) - (a[1].win+a[1].lose)).forEach(([regime, counts]) => {
  const total = counts.win + counts.lose;
  console.log(`  ${regime?.padEnd(12) || 'UNKNOWN'}: ${counts.win}W/${counts.lose}L (${(counts.win/total*100).toFixed(1)}% WR, n=${total})`);
});

// Multi-day regime change analysis
const regimeChanged = multiDayTrades.filter(t => t.entryGex.regime !== t.exitGex.regime);
console.log(`\nMulti-day trades where regime changed: ${regimeChanged.length}`);
const regChangeWin = regimeChanged.filter(t => t.netPnL > 0).length;
const regChangeLose = regimeChanged.filter(t => t.netPnL < 0).length;
if (regimeChanged.length > 0) {
  console.log(`  Win rate: ${(regChangeWin/regimeChanged.length*100).toFixed(1)}% (${regChangeWin}W/${regChangeLose}L)`);
}

// Identify losers where regime changed
if (regChangeLose > 0) {
  console.log('\nLosers where regime changed:');
  regimeChanged.filter(t => t.netPnL < 0).forEach(t => {
    console.log(`  ${t.entryDate}: ${t.entryGex.regime} → ${t.exitGex.regime}, ${t.side} @ ${t.signal.levelType}, P&L: $${t.netPnL.toFixed(0)}`);
  });
}

// RECOMMENDATIONS
console.log(`\n${'='.repeat(80)}`);
console.log('RECOMMENDATIONS FOR GEX LEVEL MONITORING');
console.log(`${'='.repeat(80)}`);

console.log(`
Based on this analysis:

1. GAMMA FLIP CROSSING
   - Trades crossing gamma flip: ${gfCrossed.length} with ${(gfCrossWin/(gfCrossWin+gfCrossLose)*100).toFixed(1)}% win rate
   - Consider early exit if price crosses gamma flip against position

2. MULTI-DAY TRADES
   - ${multiLosers.length} multi-day losers had GEX level changes
   - Consider tighter time limits or monitoring level changes

3. REGIME CHANGES
   - ${regChangeLose} trades lost when regime changed during trade
   - Consider exiting on regime change

4. IMPLEMENTATION SUGGESTIONS
   - Track GEX levels during trade lifecycle
   - Alert when traded level moves > 50 points from entry level
   - Exit early if gamma flip level is breached
   - Exit early if regime changes from entry regime
`);
