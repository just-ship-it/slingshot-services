#!/usr/bin/env node
/**
 * Deep dive analysis - focusing on patterns unique to losing trades
 * Especially max_hold_time exits and Hour 19 trades
 */

import fs from 'fs';
import path from 'path';

const resultsPath = process.argv[2] || 'results/iv-skew-gex-2025.json';
const data = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), resultsPath), 'utf8'));

const trades = data.trades.filter(t => t.status === 'completed');
const losers = trades.filter(t => t.netPnL < 0);
const winners = trades.filter(t => t.netPnL > 0);

function getHour(ts) { return new Date(ts).getUTCHours(); }
function getMinute(ts) { return new Date(ts).getUTCMinutes(); }
function formatDate(ts) { return new Date(ts).toISOString().split('T')[0]; }
function formatTime(ts) {
  const d = new Date(ts);
  return `${d.getUTCHours().toString().padStart(2,'0')}:${d.getUTCMinutes().toString().padStart(2,'0')}`;
}

console.log('='.repeat(80));
console.log('DEEP DIVE: HOUR 19 (2pm EST) ANALYSIS');
console.log('='.repeat(80));

const hour19Trades = trades.filter(t => getHour(t.entryTime) === 19);
const hour19Winners = hour19Trades.filter(t => t.netPnL > 0);
const hour19Losers = hour19Trades.filter(t => t.netPnL < 0);

console.log(`\nHour 19 Total: ${hour19Trades.length}, Winners: ${hour19Winners.length}, Losers: ${hour19Losers.length}`);
console.log(`Win Rate: ${(hour19Winners.length / hour19Trades.length * 100).toFixed(1)}%`);
console.log(`Total P&L: $${hour19Trades.reduce((s,t) => s + t.netPnL, 0).toFixed(0)}`);

console.log('\nHour 19 Winners:');
hour19Winners.forEach(t => {
  console.log(`  ${formatDate(t.entryTime)} ${formatTime(t.entryTime)} - ${t.side} @ ${t.signal.levelType}, P&L: $${t.netPnL.toFixed(0)}, Exit: ${t.exitReason}, Bars: ${t.barsSinceEntry}`);
});

console.log('\nHour 19 Losers:');
hour19Losers.forEach(t => {
  console.log(`  ${formatDate(t.entryTime)} ${formatTime(t.entryTime)} - ${t.side} @ ${t.signal.levelType}, P&L: $${t.netPnL.toFixed(0)}, Exit: ${t.exitReason}, Bars: ${t.barsSinceEntry}`);
});

// What makes Hour 19 winners different from Hour 19 losers?
console.log('\nHour 19 Winners vs Losers comparison:');
const h19WinnerLevels = {};
hour19Winners.forEach(t => { h19WinnerLevels[t.signal.levelType] = (h19WinnerLevels[t.signal.levelType] || 0) + 1; });
const h19LoserLevels = {};
hour19Losers.forEach(t => { h19LoserLevels[t.signal.levelType] = (h19LoserLevels[t.signal.levelType] || 0) + 1; });

console.log('  Level distribution - Winners:', JSON.stringify(h19WinnerLevels));
console.log('  Level distribution - Losers:', JSON.stringify(h19LoserLevels));

// Side distribution
const h19WinnerSides = { long: hour19Winners.filter(t => t.side === 'long').length, short: hour19Winners.filter(t => t.side === 'short').length };
const h19LoserSides = { long: hour19Losers.filter(t => t.side === 'long').length, short: hour19Losers.filter(t => t.side === 'short').length };
console.log('  Side - Winners:', JSON.stringify(h19WinnerSides));
console.log('  Side - Losers:', JSON.stringify(h19LoserSides));

// =====================================================
console.log('\n' + '='.repeat(80));
console.log('DEEP DIVE: MAX_HOLD_TIME EXITS');
console.log('='.repeat(80));

const maxHoldLosers = losers.filter(t => t.exitReason === 'max_hold_time');
const maxHoldWinners = winners.filter(t => t.exitReason === 'max_hold_time');

console.log(`\nMax Hold Time exits: ${maxHoldLosers.length} losers, ${maxHoldWinners.length} winners`);

// These are trades that ran the full duration without hitting stop or target
// The losers here are trades that:
// 1. Never reached their profit target
// 2. Never hit their stop loss
// 3. Ended up underwater after 60 bars

console.log('\nMax Hold Time LOSERS - characteristics:');
const mhtLosserPnLs = maxHoldLosers.map(t => t.netPnL);
console.log(`  P&L range: $${Math.min(...mhtLosserPnLs)} to $${Math.max(...mhtLosserPnLs)}`);
console.log(`  Mean loss: $${(mhtLosserPnLs.reduce((s,v) => s+v, 0) / mhtLosserPnLs.length).toFixed(0)}`);

// What price movement happened?
console.log('\n  Exit P&L distribution:');
const pnlBuckets = [
  { min: -1500, max: -1000, count: 0 },
  { min: -1000, max: -500, count: 0 },
  { min: -500, max: -200, count: 0 },
  { min: -200, max: 0, count: 0 }
];
maxHoldLosers.forEach(t => {
  for (const b of pnlBuckets) {
    if (t.netPnL >= b.min && t.netPnL < b.max) { b.count++; break; }
  }
});
pnlBuckets.forEach(b => {
  console.log(`    $${b.min} to $${b.max}: ${b.count} trades`);
});

// Compare characteristics of max_hold winners vs losers
console.log('\nMax Hold Winners vs Losers comparison:');
const mhtWinAvgPnL = maxHoldWinners.length > 0 ? maxHoldWinners.reduce((s,t) => s+t.netPnL, 0) / maxHoldWinners.length : 0;
const mhtLoseAvgPnL = maxHoldLosers.reduce((s,t) => s+t.netPnL, 0) / maxHoldLosers.length;
console.log(`  Avg P&L - Winners: $${mhtWinAvgPnL.toFixed(0)}, Losers: $${mhtLoseAvgPnL.toFixed(0)}`);

// Level type distribution
const mhtWinLevels = {};
maxHoldWinners.forEach(t => { mhtWinLevels[t.signal.levelType] = (mhtWinLevels[t.signal.levelType] || 0) + 1; });
const mhtLoseLevels = {};
maxHoldLosers.forEach(t => { mhtLoseLevels[t.signal.levelType] = (mhtLoseLevels[t.signal.levelType] || 0) + 1; });
console.log('  Level types - Winners:', JSON.stringify(mhtWinLevels));
console.log('  Level types - Losers:', JSON.stringify(mhtLoseLevels));

// Hour distribution
console.log('\nMax Hold Losers by hour:');
const mhtLoseByHour = {};
maxHoldLosers.forEach(t => {
  const h = getHour(t.entryTime);
  mhtLoseByHour[h] = (mhtLoseByHour[h] || 0) + 1;
});
Object.entries(mhtLoseByHour).sort((a,b) => parseInt(a[0]) - parseInt(b[0])).forEach(([h, c]) => {
  const estHour = (parseInt(h) - 5 + 24) % 24;
  console.log(`  Hour ${h} (${estHour} EST): ${c} trades`);
});

// =====================================================
console.log('\n' + '='.repeat(80));
console.log('DEEP DIVE: STOP LOSS EXITS');
console.log('='.repeat(80));

const stopLossTrades = losers.filter(t => t.exitReason === 'stop_loss');
console.log(`\nStop Loss exits: ${stopLossTrades.length} trades`);

// How fast do stop losses get hit?
const slBarCounts = stopLossTrades.map(t => t.barsSinceEntry);
console.log(`\nBars until stop loss hit:`);
console.log(`  Min: ${Math.min(...slBarCounts)}, Max: ${Math.max(...slBarCounts)}`);
console.log(`  Mean: ${(slBarCounts.reduce((s,v) => s+v, 0) / slBarCounts.length).toFixed(1)}`);

// Distribution
const slBarBuckets = { '0-5': 0, '5-15': 0, '15-30': 0, '30-60': 0 };
slBarCounts.forEach(b => {
  if (b < 5) slBarBuckets['0-5']++;
  else if (b < 15) slBarBuckets['5-15']++;
  else if (b < 30) slBarBuckets['15-30']++;
  else slBarBuckets['30-60']++;
});
console.log('  Distribution:', JSON.stringify(slBarBuckets));

// Fast stops (0-5 bars) - what's unique about these?
console.log('\nFAST STOP LOSSES (0-5 bars) - These are immediate reversals:');
const fastStops = stopLossTrades.filter(t => t.barsSinceEntry <= 5);
fastStops.forEach(t => {
  console.log(`  ${formatDate(t.entryTime)} ${formatTime(t.entryTime)} - ${t.side} @ ${t.signal.levelType}, Entry: ${t.actualEntry.toFixed(2)}, IV: ${(t.signal.ivValue*100).toFixed(1)}%, Skew: ${t.signal.ivSkew.toFixed(4)}, Dist: ${t.signal.levelDistance.toFixed(1)}pts`);
});

// =====================================================
console.log('\n' + '='.repeat(80));
console.log('COMBINATION ANALYSIS: FACTORS THAT CLUSTER IN LOSERS');
console.log('='.repeat(80));

// Look for combinations that have HIGH loser concentration

// Combo 1: Hour 19 + S1/S2 longs
const h19SupportLongs = trades.filter(t =>
  getHour(t.entryTime) === 19 &&
  t.side === 'long' &&
  ['S1', 'S2'].includes(t.signal.levelType)
);
const h19SLWins = h19SupportLongs.filter(t => t.netPnL > 0).length;
const h19SLLoss = h19SupportLongs.filter(t => t.netPnL < 0).length;
console.log(`\nHour 19 + S1/S2 Long: ${h19SLWins} wins, ${h19SLLoss} losses (${(h19SLWins/(h19SLWins+h19SLLoss)*100).toFixed(1)}% WR)`);

// Combo 2: Hour 19 + R1/R2 shorts
const h19ResShorts = trades.filter(t =>
  getHour(t.entryTime) === 19 &&
  t.side === 'short' &&
  ['R1', 'R2'].includes(t.signal.levelType)
);
const h19RSWins = h19ResShorts.filter(t => t.netPnL > 0).length;
const h19RSLoss = h19ResShorts.filter(t => t.netPnL < 0).length;
console.log(`Hour 19 + R1/R2 Short: ${h19RSWins} wins, ${h19RSLoss} losses (${(h19RSWins/(h19RSWins+h19RSLoss)*100).toFixed(1)}% WR)`);

// Combo 3: S2 level (worst individual level at 50%)
const s2Trades = trades.filter(t => t.signal.levelType === 'S2');
const s2ByHour = {};
for (let h = 13; h <= 20; h++) {
  const hourTrades = s2Trades.filter(t => getHour(t.entryTime) === h);
  if (hourTrades.length > 0) {
    const wins = hourTrades.filter(t => t.netPnL > 0).length;
    s2ByHour[h] = { wins, losses: hourTrades.length - wins, total: hourTrades.length };
  }
}
console.log('\nS2 Level by Hour:');
Object.entries(s2ByHour).forEach(([h, s]) => {
  const estHour = (parseInt(h) - 5 + 24) % 24;
  console.log(`  Hour ${h} (${estHour}EST): ${s.wins}W/${s.losses}L (${(s.wins/s.total*100).toFixed(0)}% WR)`);
});

// Combo 4: IV > 25% + S2
const highIVS2 = trades.filter(t => t.signal.ivValue > 0.25 && t.signal.levelType === 'S2');
const highIVS2Wins = highIVS2.filter(t => t.netPnL > 0).length;
const highIVS2Loss = highIVS2.filter(t => t.netPnL < 0).length;
console.log(`\nIV > 25% + S2: ${highIVS2Wins} wins, ${highIVS2Loss} losses (${(highIVS2Wins/(highIVS2Wins+highIVS2Loss)*100).toFixed(1)}% WR)`);

// Combo 5: Late entry (after 19:00 UTC / 2pm EST)
const lateEntries = trades.filter(t => getHour(t.entryTime) >= 19);
const lateWins = lateEntries.filter(t => t.netPnL > 0).length;
const lateLoss = lateEntries.filter(t => t.netPnL < 0).length;
console.log(`\nLate entries (after 2pm EST): ${lateWins} wins, ${lateLoss} losses (${(lateWins/(lateWins+lateLoss)*100).toFixed(1)}% WR)`);
console.log(`  Total P&L: $${lateEntries.reduce((s,t) => s+t.netPnL, 0).toFixed(0)}`);
console.log(`  Impact of excluding: Would lose ${lateWins} winners, remove ${lateLoss} losers`);

// =====================================================
console.log('\n' + '='.repeat(80));
console.log('EARLY EXIT ANALYSIS: TRADES THAT WENT PROFITABLE');
console.log('='.repeat(80));

// For stop loss exits - calculate how much profit they might have had
// We can estimate this by looking at the relationship between entry and the candle extremes

// This needs more detailed candle data, but we can look at metadata
console.log('\nAnalyzing losers that may have been profitable at some point...');

// Since we don't have full candle history, look at max_hold_time losers
// These by definition didn't hit their stop, so they may have been profitable
const smallLossMHT = maxHoldLosers.filter(t => t.netPnL > -500);
console.log(`\nMax Hold Time losers with small loss (> -$500): ${smallLossMHT.length}`);
smallLossMHT.forEach(t => {
  console.log(`  ${formatDate(t.entryTime)} ${formatTime(t.entryTime)} - ${t.side} @ ${t.signal.levelType}, P&L: $${t.netPnL.toFixed(0)}, Entry: ${t.actualEntry.toFixed(2)}, Exit: ${t.actualExit.toFixed(2)}`);
});

// =====================================================
console.log('\n' + '='.repeat(80));
console.log('RECOMMENDED FILTER: HOUR 19 (2PM EST) CUTOFF');
console.log('='.repeat(80));

// Calculate exact impact of not trading after 2pm EST
const beforeH19 = trades.filter(t => getHour(t.entryTime) < 19);
const beforeH19Wins = beforeH19.filter(t => t.netPnL > 0);
const beforeH19Loss = beforeH19.filter(t => t.netPnL < 0);

console.log(`\nTrades before Hour 19 (2pm EST):`);
console.log(`  Count: ${beforeH19.length} (vs ${trades.length} total)`);
console.log(`  Winners: ${beforeH19Wins.length}, Losers: ${beforeH19Loss.length}`);
console.log(`  Win Rate: ${(beforeH19Wins.length / beforeH19.length * 100).toFixed(1)}%`);
console.log(`  Total P&L: $${beforeH19.reduce((s,t) => s+t.netPnL, 0).toFixed(0)}`);

const afterH19 = trades.filter(t => getHour(t.entryTime) >= 19);
const afterH19Wins = afterH19.filter(t => t.netPnL > 0);
const afterH19Loss = afterH19.filter(t => t.netPnL < 0);

console.log(`\nTrades at/after Hour 19 (2pm EST):`);
console.log(`  Count: ${afterH19.length}`);
console.log(`  Winners: ${afterH19Wins.length}, Losers: ${afterH19Loss.length}`);
console.log(`  Win Rate: ${(afterH19Wins.length / afterH19.length * 100).toFixed(1)}%`);
console.log(`  Total P&L: $${afterH19.reduce((s,t) => s+t.netPnL, 0).toFixed(0)}`);

// Break down Hour 19-20 further
console.log('\nDetailed Hour 19-20 breakdown:');
for (let h = 19; h <= 20; h++) {
  const hourTrades = trades.filter(t => getHour(t.entryTime) === h);
  const hwins = hourTrades.filter(t => t.netPnL > 0);
  const hloss = hourTrades.filter(t => t.netPnL < 0);
  const estHour = h - 5;
  console.log(`  Hour ${h} (${estHour}pm EST): ${hwins.length}W/${hloss.length}L = ${(hwins.length/hourTrades.length*100).toFixed(1)}% WR, P&L: $${hourTrades.reduce((s,t) => s+t.netPnL,0).toFixed(0)}`);

  // By minute
  for (let m = 0; m < 60; m += 15) {
    const minuteTrades = hourTrades.filter(t => {
      const min = getMinute(t.entryTime);
      return min >= m && min < m + 15;
    });
    if (minuteTrades.length > 0) {
      const mwins = minuteTrades.filter(t => t.netPnL > 0).length;
      const mloss = minuteTrades.filter(t => t.netPnL < 0).length;
      console.log(`    ${h}:${m.toString().padStart(2,'0')}-${h}:${(m+14).toString().padStart(2,'0')}: ${mwins}W/${mloss}L (${minuteTrades.length} trades)`);
    }
  }
}

// =====================================================
console.log('\n' + '='.repeat(80));
console.log('FINAL RECOMMENDATIONS');
console.log('='.repeat(80));

console.log(`
1. ENTRY CUTOFF AT 19:00 UTC (2:00 PM EST)
   - Trades after this time: ${afterH19.length} with ${(afterH19Wins.length/afterH19.length*100).toFixed(1)}% win rate
   - These trades lose $${Math.abs(afterH19.reduce((s,t) => s+t.netPnL, 0)).toFixed(0)} net
   - Impact: Remove ${afterH19Loss.length} losers, lose ${afterH19Wins.length} winners
   - Net effect: +$${Math.abs(afterH19.reduce((s,t) => s+t.netPnL, 0)).toFixed(0)} improvement

2. CONSIDER BREAKEVEN STOP
   - ${maxHoldLosers.filter(t => t.netPnL > -500).length} max_hold losses are small (<$500)
   - These trades likely went profitable then returned
   - A breakeven stop at ~25 points could capture some of these

3. REDUCE MAX HOLD TIME
   - Current: 60 bars (15 hours on 15m chart?)
   - ${maxHoldLosers.length} losses from max_hold_time
   - Consider reducing to 40 bars or adding time-based decay on targets
`);

// What if we combine Hour 19 cutoff with the current filter?
const withH19Cutoff = beforeH19;
const withH19Wins = withH19Cutoff.filter(t => t.netPnL > 0);
const withH19Loss = withH19Cutoff.filter(t => t.netPnL < 0);

console.log('\nSIMULATED RESULTS with Hour 19 cutoff:');
console.log(`  Trades: ${withH19Cutoff.length} (${trades.length - withH19Cutoff.length} fewer)`);
console.log(`  Winners: ${withH19Wins.length}, Losers: ${withH19Loss.length}`);
console.log(`  Win Rate: ${(withH19Wins.length / withH19Cutoff.length * 100).toFixed(1)}% (was ${(winners.length/trades.length*100).toFixed(1)}%)`);
console.log(`  Total P&L: $${withH19Cutoff.reduce((s,t) => s+t.netPnL, 0).toFixed(0)} (was $${trades.reduce((s,t) => s+t.netPnL, 0).toFixed(0)})`);
console.log(`  Avg P&L: $${(withH19Cutoff.reduce((s,t) => s+t.netPnL, 0) / withH19Cutoff.length).toFixed(0)} (was $${(trades.reduce((s,t) => s+t.netPnL, 0) / trades.length).toFixed(0)})`);
