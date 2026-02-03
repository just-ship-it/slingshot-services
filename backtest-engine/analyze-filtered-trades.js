#!/usr/bin/env node
/**
 * Analyze filtered trades to find next optimization opportunity
 */

import fs from 'fs';

// Load the session-filtered results
const comparison = JSON.parse(fs.readFileSync('./results/session-filter-comparison.json', 'utf8'));
const trades = comparison.filtered.results.trades;

console.log('='.repeat(70));
console.log('ANALYSIS OF SESSION-FILTERED TRADES');
console.log(`Total trades analyzed: ${trades.length}`);
console.log('='.repeat(70));

// Helper function to calculate stats
function calcStats(tradeSet, label) {
  if (tradeSet.length === 0) {
    return { label, count: 0, winRate: 0, totalPnL: 0, avgPnL: 0, stopOutRate: 0 };
  }

  const wins = tradeSet.filter(t => t.netPnL > 0).length;
  const stopOuts = tradeSet.filter(t => t.exitReason === 'stop_loss').length;
  const totalPnL = tradeSet.reduce((sum, t) => sum + t.netPnL, 0);

  return {
    label,
    count: tradeSet.length,
    winRate: (wins / tradeSet.length * 100).toFixed(1),
    totalPnL: totalPnL.toFixed(0),
    avgPnL: (totalPnL / tradeSet.length).toFixed(2),
    stopOutRate: (stopOuts / tradeSet.length * 100).toFixed(1)
  };
}

function printTable(stats, title) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(title);
  console.log('-'.repeat(70));
  console.log('Category'.padEnd(25) + 'Count'.padEnd(8) + 'Win%'.padEnd(8) + 'Stop%'.padEnd(8) + 'Total P&L'.padEnd(12) + 'Avg P&L');
  console.log('-'.repeat(70));

  stats.sort((a, b) => parseFloat(b.totalPnL) - parseFloat(a.totalPnL));

  for (const s of stats) {
    console.log(
      s.label.padEnd(25) +
      s.count.toString().padEnd(8) +
      (s.winRate + '%').padEnd(8) +
      (s.stopOutRate + '%').padEnd(8) +
      ('$' + s.totalPnL).padEnd(12) +
      '$' + s.avgPnL
    );
  }
}

// 1. Analysis by GEX Regime
console.log('\n\n1. PERFORMANCE BY GEX REGIME');
const byRegime = {};
trades.forEach(t => {
  // Get regime from signal metadata or trade metadata
  const regime = t.signal?.metadata?.gexRegime || t.metadata?.gexRegime || 'unknown';
  if (!byRegime[regime]) byRegime[regime] = [];
  byRegime[regime].push(t);
});

const regimeStats = Object.entries(byRegime).map(([regime, trades]) => calcStats(trades, regime));
printTable(regimeStats, 'By GEX Regime');

// 2. Analysis by Entry Level Type
console.log('\n\n2. PERFORMANCE BY ENTRY LEVEL TYPE');
const byLevelType = {};
trades.forEach(t => {
  const levelType = t.signal?.metadata?.entryLevel?.type || t.metadata?.entryLevel?.type || 'unknown';
  if (!byLevelType[levelType]) byLevelType[levelType] = [];
  byLevelType[levelType].push(t);
});

const levelTypeStats = Object.entries(byLevelType).map(([type, trades]) => calcStats(trades, type));
printTable(levelTypeStats, 'By Entry Level Type');

// 3. Analysis by Confirmation Type
console.log('\n\n3. PERFORMANCE BY CONFIRMATION TYPE');
const byConfirmation = {};
trades.forEach(t => {
  const confirmationType = t.signal?.metadata?.confirmationType || t.metadata?.confirmationType || 'unknown';
  if (!byConfirmation[confirmationType]) byConfirmation[confirmationType] = [];
  byConfirmation[confirmationType].push(t);
});

const confirmationStats = Object.entries(byConfirmation).map(([type, trades]) => calcStats(trades, type));
printTable(confirmationStats, 'By Confirmation Type');

// 4. Analysis by Trade Side
console.log('\n\n4. PERFORMANCE BY TRADE SIDE');
const bySide = {};
trades.forEach(t => {
  const side = t.side || 'unknown';
  if (!bySide[side]) bySide[side] = [];
  bySide[side].push(t);
});

const sideStats = Object.entries(bySide).map(([side, trades]) => calcStats(trades, side));
printTable(sideStats, 'By Trade Side');

// 5. Analysis by Hour (UTC) - remaining sessions
console.log('\n\n5. PERFORMANCE BY HOUR (UTC) - Remaining Sessions');
const byHour = {};
trades.forEach(t => {
  const hour = new Date(t.entryTime).getUTCHours();
  const hourLabel = `UTC ${hour.toString().padStart(2, '0')}:00 (${hour - 5} EST)`;
  if (!byHour[hourLabel]) byHour[hourLabel] = [];
  byHour[hourLabel].push(t);
});

const hourStats = Object.entries(byHour).map(([hour, trades]) => calcStats(trades, hour));
hourStats.sort((a, b) => {
  const hourA = parseInt(a.label.match(/UTC (\d+)/)[1]);
  const hourB = parseInt(b.label.match(/UTC (\d+)/)[1]);
  return hourA - hourB;
});
printTable(hourStats, 'By Hour (UTC)');

// 6. Analysis by Risk:Reward Ratio buckets
console.log('\n\n6. PERFORMANCE BY RISK:REWARD RATIO');
const byRR = {
  'R:R < 2': [],
  'R:R 2-5': [],
  'R:R 5-10': [],
  'R:R > 10': []
};
trades.forEach(t => {
  const rr = t.signal?.metadata?.riskRewardRatio || t.metadata?.riskRewardRatio || 0;
  if (rr < 2) byRR['R:R < 2'].push(t);
  else if (rr < 5) byRR['R:R 2-5'].push(t);
  else if (rr < 10) byRR['R:R 5-10'].push(t);
  else byRR['R:R > 10'].push(t);
});

const rrStats = Object.entries(byRR).map(([bucket, trades]) => calcStats(trades, bucket));
printTable(rrStats, 'By Risk:Reward Ratio');

// 7. Analysis by Bars to Entry
console.log('\n\n7. PERFORMANCE BY BARS TO ENTRY');
const byBars = {
  '1 bar (immediate)': [],
  '2 bars': [],
  '3 bars': [],
  '4+ bars': []
};
trades.forEach(t => {
  const bars = t.signal?.metadata?.barsToEntry || t.metadata?.barsToEntry || 0;
  if (bars <= 1) byBars['1 bar (immediate)'].push(t);
  else if (bars === 2) byBars['2 bars'].push(t);
  else if (bars === 3) byBars['3 bars'].push(t);
  else byBars['4+ bars'].push(t);
});

const barsStats = Object.entries(byBars).map(([bucket, trades]) => calcStats(trades, bucket));
printTable(barsStats, 'By Bars to Entry');

// 8. Analysis by Stop Loss Size (risk in points)
console.log('\n\n8. PERFORMANCE BY STOP LOSS SIZE');
const byStopSize = {
  'Tight (< 10 pts)': [],
  'Medium (10-20 pts)': [],
  'Wide (20-30 pts)': [],
  'Very Wide (> 30 pts)': []
};
trades.forEach(t => {
  const risk = t.signal?.metadata?.riskPoints || t.metadata?.riskPoints ||
               Math.abs(t.entryPrice - t.stopLoss) || 0;
  if (risk < 10) byStopSize['Tight (< 10 pts)'].push(t);
  else if (risk < 20) byStopSize['Medium (10-20 pts)'].push(t);
  else if (risk < 30) byStopSize['Wide (20-30 pts)'].push(t);
  else byStopSize['Very Wide (> 30 pts)'].push(t);
});

const stopSizeStats = Object.entries(byStopSize).map(([bucket, trades]) => calcStats(trades, bucket));
printTable(stopSizeStats, 'By Stop Loss Size');

// 9. Combined Analysis: Side + Regime
console.log('\n\n9. COMBINED: SIDE + GEX REGIME');
const bySideRegime = {};
trades.forEach(t => {
  const side = t.side || 'unknown';
  const regime = t.signal?.metadata?.gexRegime || t.metadata?.gexRegime || 'unknown';
  const key = `${side} in ${regime}`;
  if (!bySideRegime[key]) bySideRegime[key] = [];
  bySideRegime[key].push(t);
});

const sideRegimeStats = Object.entries(bySideRegime).map(([key, trades]) => calcStats(trades, key));
printTable(sideRegimeStats, 'By Side + Regime');

// 10. Analysis by Day of Week
console.log('\n\n10. PERFORMANCE BY DAY OF WEEK');
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const byDay = {};
trades.forEach(t => {
  const day = dayNames[new Date(t.entryTime).getUTCDay()];
  if (!byDay[day]) byDay[day] = [];
  byDay[day].push(t);
});

const dayStats = Object.entries(byDay).map(([day, trades]) => calcStats(trades, day));
printTable(dayStats, 'By Day of Week');

// 11. Summary of worst performing categories
console.log('\n\n' + '='.repeat(70));
console.log('POTENTIAL OPTIMIZATION TARGETS');
console.log('='.repeat(70));

// Collect all negative P&L categories with significant trade counts
const allStats = [
  ...levelTypeStats,
  ...confirmationStats,
  ...sideStats,
  ...hourStats,
  ...rrStats,
  ...barsStats,
  ...stopSizeStats,
  ...sideRegimeStats,
  ...dayStats
].filter(s => s.count >= 20 && parseFloat(s.totalPnL) < 0);

allStats.sort((a, b) => parseFloat(a.totalPnL) - parseFloat(b.totalPnL));

console.log('\nWorst performing categories (min 20 trades, negative P&L):');
console.log('-'.repeat(70));
console.log('Category'.padEnd(30) + 'Count'.padEnd(8) + 'Win%'.padEnd(8) + 'Total P&L');
console.log('-'.repeat(70));

for (const s of allStats.slice(0, 10)) {
  console.log(
    s.label.padEnd(30) +
    s.count.toString().padEnd(8) +
    (s.winRate + '%').padEnd(8) +
    '$' + s.totalPnL
  );
}

console.log('\n' + '='.repeat(70));
