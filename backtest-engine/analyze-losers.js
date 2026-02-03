#!/usr/bin/env node
/**
 * Analyze losing trades to find patterns
 */

import fs from 'fs';

const results = JSON.parse(fs.readFileSync('./results/gex-pullback-with-trailing.json', 'utf8'));

const losers = results.trades.filter(t => t.netPnL < 0);
const winners = results.trades.filter(t => t.netPnL > 0);

console.log('='.repeat(80));
console.log('LOSING TRADE ANALYSIS');
console.log('='.repeat(80));
console.log(`\nTotal trades: ${results.trades.length}`);
console.log(`Winners: ${winners.length} (${(winners.length/results.trades.length*100).toFixed(1)}%)`);
console.log(`Losers: ${losers.length} (${(losers.length/results.trades.length*100).toFixed(1)}%)`);

// ============================================================================
// By Exit Reason
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('LOSERS BY EXIT REASON');
console.log('='.repeat(80));

const byExitReason = {};
for (const trade of losers) {
  const reason = trade.exitReason;
  if (!byExitReason[reason]) byExitReason[reason] = { count: 0, totalLoss: 0, trades: [] };
  byExitReason[reason].count++;
  byExitReason[reason].totalLoss += trade.netPnL;
  byExitReason[reason].trades.push(trade);
}

console.log('\nExit Reason'.padEnd(20) + 'Count'.padEnd(10) + 'Total Loss'.padEnd(15) + 'Avg Loss');
console.log('-'.repeat(60));
for (const [reason, data] of Object.entries(byExitReason).sort((a, b) => a[1].totalLoss - b[1].totalLoss)) {
  console.log(
    reason.padEnd(20) +
    `${data.count}`.padEnd(10) +
    `$${data.totalLoss.toLocaleString()}`.padEnd(15) +
    `$${(data.totalLoss / data.count).toFixed(0)}`
  );
}

// ============================================================================
// By Side (Buy vs Sell)
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('LOSERS BY SIDE');
console.log('='.repeat(80));

const bySide = { buy: { losers: [], winners: [] }, sell: { losers: [], winners: [] } };
for (const trade of results.trades) {
  const side = trade.side.toLowerCase();
  if (trade.netPnL < 0) bySide[side].losers.push(trade);
  else bySide[side].winners.push(trade);
}

console.log('\nSide'.padEnd(10) + 'Losers'.padEnd(12) + 'Winners'.padEnd(12) + 'Win Rate'.padEnd(12) + 'Loser Avg'.padEnd(12) + 'Winner Avg');
console.log('-'.repeat(70));
for (const [side, data] of Object.entries(bySide)) {
  const total = data.losers.length + data.winners.length;
  const winRate = (data.winners.length / total * 100).toFixed(1);
  const loserAvg = data.losers.length > 0 ? data.losers.reduce((s, t) => s + t.netPnL, 0) / data.losers.length : 0;
  const winnerAvg = data.winners.length > 0 ? data.winners.reduce((s, t) => s + t.netPnL, 0) / data.winners.length : 0;
  console.log(
    side.toUpperCase().padEnd(10) +
    `${data.losers.length}`.padEnd(12) +
    `${data.winners.length}`.padEnd(12) +
    `${winRate}%`.padEnd(12) +
    `$${loserAvg.toFixed(0)}`.padEnd(12) +
    `$${winnerAvg.toFixed(0)}`
  );
}

// ============================================================================
// By Hour of Day (UTC)
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('LOSERS BY HOUR (UTC)');
console.log('='.repeat(80));

const byHour = {};
for (let h = 0; h < 24; h++) byHour[h] = { losers: 0, winners: 0, loserPnL: 0, winnerPnL: 0 };

for (const trade of results.trades) {
  const hour = new Date(trade.entryTime || trade.timestamp).getUTCHours();
  if (trade.netPnL < 0) {
    byHour[hour].losers++;
    byHour[hour].loserPnL += trade.netPnL;
  } else {
    byHour[hour].winners++;
    byHour[hour].winnerPnL += trade.netPnL;
  }
}

console.log('\nHour'.padEnd(8) + 'Losers'.padEnd(10) + 'Winners'.padEnd(10) + 'Win%'.padEnd(10) + 'Net PnL'.padEnd(12) + 'Session');
console.log('-'.repeat(70));
for (let h = 0; h < 24; h++) {
  const data = byHour[h];
  const total = data.losers + data.winners;
  if (total === 0) continue;
  const winRate = (data.winners / total * 100).toFixed(0);
  const netPnL = data.loserPnL + data.winnerPnL;
  const session = h >= 14 && h < 21 ? 'RTH' : h >= 21 || h < 4 ? 'Overnight' : 'Pre-market';
  console.log(
    `${h.toString().padStart(2, '0')}:00`.padEnd(8) +
    `${data.losers}`.padEnd(10) +
    `${data.winners}`.padEnd(10) +
    `${winRate}%`.padEnd(10) +
    `$${netPnL.toLocaleString()}`.padEnd(12) +
    session
  );
}

// ============================================================================
// By Day of Week
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('LOSERS BY DAY OF WEEK');
console.log('='.repeat(80));

const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const byDay = {};
for (const day of days) byDay[day] = { losers: 0, winners: 0, loserPnL: 0, winnerPnL: 0 };

for (const trade of results.trades) {
  const day = days[new Date(trade.entryTime || trade.timestamp).getUTCDay()];
  if (trade.netPnL < 0) {
    byDay[day].losers++;
    byDay[day].loserPnL += trade.netPnL;
  } else {
    byDay[day].winners++;
    byDay[day].winnerPnL += trade.netPnL;
  }
}

console.log('\nDay'.padEnd(12) + 'Losers'.padEnd(10) + 'Winners'.padEnd(10) + 'Win%'.padEnd(10) + 'Net PnL');
console.log('-'.repeat(55));
for (const day of days) {
  const data = byDay[day];
  const total = data.losers + data.winners;
  if (total === 0) continue;
  const winRate = (data.winners / total * 100).toFixed(0);
  const netPnL = data.loserPnL + data.winnerPnL;
  console.log(
    day.padEnd(12) +
    `${data.losers}`.padEnd(10) +
    `${data.winners}`.padEnd(10) +
    `${winRate}%`.padEnd(10) +
    `$${netPnL.toLocaleString()}`
  );
}

// ============================================================================
// By Entry Level Type
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('LOSERS BY ENTRY LEVEL TYPE');
console.log('='.repeat(80));

const byLevelType = {};
for (const trade of results.trades) {
  const levelType = trade.signal?.metadata?.entryLevel?.type || trade.metadata?.entryLevel?.type || 'unknown';
  if (!byLevelType[levelType]) byLevelType[levelType] = { losers: 0, winners: 0, loserPnL: 0, winnerPnL: 0 };
  if (trade.netPnL < 0) {
    byLevelType[levelType].losers++;
    byLevelType[levelType].loserPnL += trade.netPnL;
  } else {
    byLevelType[levelType].winners++;
    byLevelType[levelType].winnerPnL += trade.netPnL;
  }
}

console.log('\nLevel Type'.padEnd(20) + 'Losers'.padEnd(10) + 'Winners'.padEnd(10) + 'Win%'.padEnd(10) + 'Net PnL');
console.log('-'.repeat(65));
for (const [type, data] of Object.entries(byLevelType).sort((a, b) => (b[1].loserPnL + b[1].winnerPnL) - (a[1].loserPnL + a[1].winnerPnL))) {
  const total = data.losers + data.winners;
  const winRate = (data.winners / total * 100).toFixed(0);
  const netPnL = data.loserPnL + data.winnerPnL;
  console.log(
    type.padEnd(20) +
    `${data.losers}`.padEnd(10) +
    `${data.winners}`.padEnd(10) +
    `${winRate}%`.padEnd(10) +
    `$${netPnL.toLocaleString()}`
  );
}

// ============================================================================
// By Risk/Reward Ratio
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('LOSERS BY RISK/REWARD RATIO');
console.log('='.repeat(80));

const byRR = { 'RR < 1.0': { l: 0, w: 0, lp: 0, wp: 0 }, 'RR 1.0-1.5': { l: 0, w: 0, lp: 0, wp: 0 }, 'RR 1.5-2.0': { l: 0, w: 0, lp: 0, wp: 0 }, 'RR > 2.0': { l: 0, w: 0, lp: 0, wp: 0 } };

for (const trade of results.trades) {
  const rr = trade.signal?.metadata?.riskRewardRatio || trade.metadata?.riskRewardRatio || 0;
  let bucket;
  if (rr < 1.0) bucket = 'RR < 1.0';
  else if (rr < 1.5) bucket = 'RR 1.0-1.5';
  else if (rr < 2.0) bucket = 'RR 1.5-2.0';
  else bucket = 'RR > 2.0';

  if (trade.netPnL < 0) {
    byRR[bucket].l++;
    byRR[bucket].lp += trade.netPnL;
  } else {
    byRR[bucket].w++;
    byRR[bucket].wp += trade.netPnL;
  }
}

console.log('\nR:R Bucket'.padEnd(15) + 'Losers'.padEnd(10) + 'Winners'.padEnd(10) + 'Win%'.padEnd(10) + 'Net PnL');
console.log('-'.repeat(55));
for (const [bucket, data] of Object.entries(byRR)) {
  const total = data.l + data.w;
  if (total === 0) continue;
  const winRate = (data.w / total * 100).toFixed(0);
  const netPnL = data.lp + data.wp;
  console.log(
    bucket.padEnd(15) +
    `${data.l}`.padEnd(10) +
    `${data.w}`.padEnd(10) +
    `${winRate}%`.padEnd(10) +
    `$${netPnL.toLocaleString()}`
  );
}

// ============================================================================
// Consecutive Losers
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('CONSECUTIVE LOSING STREAKS');
console.log('='.repeat(80));

let maxStreak = 0;
let currentStreak = 0;
const streaks = [];

for (const trade of results.trades) {
  if (trade.netPnL < 0) {
    currentStreak++;
    maxStreak = Math.max(maxStreak, currentStreak);
  } else {
    if (currentStreak > 0) streaks.push(currentStreak);
    currentStreak = 0;
  }
}
if (currentStreak > 0) streaks.push(currentStreak);

console.log(`\nMax consecutive losers: ${maxStreak}`);
console.log(`Average losing streak: ${(streaks.reduce((a, b) => a + b, 0) / streaks.length).toFixed(1)}`);
console.log(`Streak distribution: ${streaks.filter(s => s === 1).length}x1, ${streaks.filter(s => s === 2).length}x2, ${streaks.filter(s => s === 3).length}x3, ${streaks.filter(s => s >= 4).length}x4+`);

// ============================================================================
// Loss Size Distribution
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('LOSS SIZE DISTRIBUTION');
console.log('='.repeat(80));

const lossSizes = losers.map(t => Math.abs(t.netPnL)).sort((a, b) => a - b);
const avgLoss = lossSizes.reduce((a, b) => a + b, 0) / lossSizes.length;
const medianLoss = lossSizes[Math.floor(lossSizes.length / 2)];
const maxLoss = Math.max(...lossSizes);
const minLoss = Math.min(...lossSizes);

console.log(`\nAverage loss: $${avgLoss.toFixed(0)}`);
console.log(`Median loss: $${medianLoss}`);
console.log(`Min loss: $${minLoss}`);
console.log(`Max loss: $${maxLoss}`);

const lossBuckets = { '$0-250': 0, '$250-500': 0, '$500-750': 0, '$750-1000': 0, '$1000+': 0 };
for (const loss of lossSizes) {
  if (loss < 250) lossBuckets['$0-250']++;
  else if (loss < 500) lossBuckets['$250-500']++;
  else if (loss < 750) lossBuckets['$500-750']++;
  else if (loss < 1000) lossBuckets['$750-1000']++;
  else lossBuckets['$1000+']++;
}

console.log('\nLoss Size'.padEnd(15) + 'Count'.padEnd(10) + 'Percent');
console.log('-'.repeat(35));
for (const [bucket, count] of Object.entries(lossBuckets)) {
  console.log(bucket.padEnd(15) + `${count}`.padEnd(10) + `${(count/losers.length*100).toFixed(0)}%`);
}

// ============================================================================
// Biggest Losers Details
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('TOP 10 BIGGEST LOSERS');
console.log('='.repeat(80));

const sortedLosers = [...losers].sort((a, b) => a.netPnL - b.netPnL);

console.log('\nDate'.padEnd(12) + 'Side'.padEnd(6) + 'Exit'.padEnd(15) + 'Loss'.padEnd(10) + 'Level Type');
console.log('-'.repeat(60));
for (const trade of sortedLosers.slice(0, 10)) {
  const date = new Date(trade.entryTime || trade.timestamp).toISOString().split('T')[0];
  const levelType = trade.signal?.metadata?.entryLevel?.type || trade.metadata?.entryLevel?.type || 'unknown';
  console.log(
    date.padEnd(12) +
    trade.side.toUpperCase().padEnd(6) +
    trade.exitReason.padEnd(15) +
    `$${trade.netPnL}`.padEnd(10) +
    levelType
  );
}

// ============================================================================
// Year-over-Year Loss Comparison
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('YEAR-OVER-YEAR LOSS COMPARISON');
console.log('='.repeat(80));

const byYear = {};
for (const trade of losers) {
  const year = new Date(trade.entryTime || trade.timestamp).getFullYear();
  if (!byYear[year]) byYear[year] = { count: 0, totalLoss: 0 };
  byYear[year].count++;
  byYear[year].totalLoss += trade.netPnL;
}

console.log('\nYear'.padEnd(8) + 'Losers'.padEnd(10) + 'Total Loss'.padEnd(15) + 'Avg Loss');
console.log('-'.repeat(45));
for (const [year, data] of Object.entries(byYear).sort()) {
  console.log(
    year.padEnd(8) +
    `${data.count}`.padEnd(10) +
    `$${data.totalLoss.toLocaleString()}`.padEnd(15) +
    `$${(data.totalLoss / data.count).toFixed(0)}`
  );
}
