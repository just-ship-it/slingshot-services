#!/usr/bin/env node
/**
 * Deep dive analysis of losing trades from iv-skew-gex strategy backtest
 * Looking for patterns that ONLY appear in losing trades
 */

import fs from 'fs';
import path from 'path';

const resultsPath = process.argv[2] || 'results/iv-skew-gex-2025.json';
const data = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), resultsPath), 'utf8'));

const trades = data.trades.filter(t => t.status === 'completed');
const losers = trades.filter(t => t.netPnL < 0);
const winners = trades.filter(t => t.netPnL > 0);
const breakeven = trades.filter(t => t.netPnL === 0);

console.log('='.repeat(80));
console.log('IV-SKEW-GEX LOSING TRADE ANALYSIS');
console.log('='.repeat(80));
console.log(`\nTotal Trades: ${trades.length}`);
console.log(`Winners: ${winners.length} (${(winners.length/trades.length*100).toFixed(1)}%)`);
console.log(`Losers: ${losers.length} (${(losers.length/trades.length*100).toFixed(1)}%)`);
console.log(`Breakeven: ${breakeven.length}`);
console.log(`\nAvg Winner: $${(winners.reduce((s,t) => s + t.netPnL, 0) / winners.length).toFixed(2)}`);
console.log(`Avg Loser: $${(losers.reduce((s,t) => s + t.netPnL, 0) / losers.length).toFixed(2)}`);

// Helper to calculate statistics
function calcStats(arr) {
  if (arr.length === 0) return { mean: 0, median: 0, stdDev: 0, min: 0, max: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const median = arr.length % 2 === 0
    ? (sorted[arr.length/2 - 1] + sorted[arr.length/2]) / 2
    : sorted[Math.floor(arr.length/2)];
  const variance = arr.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / arr.length;
  const stdDev = Math.sqrt(variance);
  return { mean, median, stdDev, min: sorted[0], max: sorted[arr.length - 1] };
}

// Helper to get hour from timestamp
function getHour(ts) {
  return new Date(ts).getUTCHours();
}

function getMinute(ts) {
  return new Date(ts).getUTCMinutes();
}

function getDayOfWeek(ts) {
  return new Date(ts).getUTCDay();
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${d.getUTCHours().toString().padStart(2,'0')}:${d.getUTCMinutes().toString().padStart(2,'0')}`;
}

// =====================================================
// ANALYSIS 1: EXIT REASON DISTRIBUTION
// =====================================================
console.log('\n' + '='.repeat(80));
console.log('EXIT REASON ANALYSIS');
console.log('='.repeat(80));

const exitReasons = {
  winners: {},
  losers: {}
};

winners.forEach(t => {
  exitReasons.winners[t.exitReason] = (exitReasons.winners[t.exitReason] || 0) + 1;
});
losers.forEach(t => {
  exitReasons.losers[t.exitReason] = (exitReasons.losers[t.exitReason] || 0) + 1;
});

console.log('\nWinners by exit reason:');
Object.entries(exitReasons.winners).sort((a,b) => b[1] - a[1]).forEach(([reason, count]) => {
  console.log(`  ${reason}: ${count} (${(count/winners.length*100).toFixed(1)}%)`);
});

console.log('\nLosers by exit reason:');
Object.entries(exitReasons.losers).sort((a,b) => b[1] - a[1]).forEach(([reason, count]) => {
  console.log(`  ${reason}: ${count} (${(count/losers.length*100).toFixed(1)}%)`);
});

// =====================================================
// ANALYSIS 2: TIME OF DAY PATTERNS
// =====================================================
console.log('\n' + '='.repeat(80));
console.log('TIME OF DAY ANALYSIS (UTC - subtract 5 for EST)');
console.log('='.repeat(80));

const hourlyWinRate = {};
for (let h = 0; h < 24; h++) {
  const hourWinners = winners.filter(t => getHour(t.entryTime) === h);
  const hourLosers = losers.filter(t => getHour(t.entryTime) === h);
  const total = hourWinners.length + hourLosers.length;
  if (total > 0) {
    hourlyWinRate[h] = {
      winners: hourWinners.length,
      losers: hourLosers.length,
      total,
      winRate: hourWinners.length / total * 100,
      avgWinPnL: hourWinners.length > 0 ? hourWinners.reduce((s,t) => s + t.netPnL, 0) / hourWinners.length : 0,
      avgLossPnL: hourLosers.length > 0 ? hourLosers.reduce((s,t) => s + t.netPnL, 0) / hourLosers.length : 0
    };
  }
}

console.log('\nHour | Wins | Loss | Total | Win% | Avg Win | Avg Loss | Expectancy');
console.log('-'.repeat(75));
Object.entries(hourlyWinRate).sort((a,b) => parseInt(a[0]) - parseInt(b[0])).forEach(([hour, stats]) => {
  const expectancy = (stats.winRate/100 * stats.avgWinPnL) + ((100-stats.winRate)/100 * stats.avgLossPnL);
  const estHour = (parseInt(hour) - 5 + 24) % 24;
  console.log(`${hour.padStart(2)}(${estHour.toString().padStart(2)}EST) | ${stats.winners.toString().padStart(4)} | ${stats.losers.toString().padStart(4)} | ${stats.total.toString().padStart(5)} | ${stats.winRate.toFixed(1).padStart(4)}% | $${stats.avgWinPnL.toFixed(0).padStart(5)} | $${stats.avgLossPnL.toFixed(0).padStart(6)} | $${expectancy.toFixed(0).padStart(5)}`);
});

// Hours with very low win rate (potential filter candidates)
console.log('\nHours with win rate < 50% (potential filter candidates):');
Object.entries(hourlyWinRate).filter(([h, s]) => s.winRate < 50 && s.total >= 3).forEach(([h, s]) => {
  const estHour = (parseInt(h) - 5 + 24) % 24;
  console.log(`  Hour ${h} (${estHour} EST): ${s.winRate.toFixed(1)}% win rate, ${s.total} trades`);
});

// =====================================================
// ANALYSIS 3: DAY OF WEEK PATTERNS
// =====================================================
console.log('\n' + '='.repeat(80));
console.log('DAY OF WEEK ANALYSIS');
console.log('='.repeat(80));

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dailyStats = {};

for (let d = 0; d < 7; d++) {
  const dayWinners = winners.filter(t => getDayOfWeek(t.entryTime) === d);
  const dayLosers = losers.filter(t => getDayOfWeek(t.entryTime) === d);
  const total = dayWinners.length + dayLosers.length;
  if (total > 0) {
    dailyStats[d] = {
      name: dayNames[d],
      winners: dayWinners.length,
      losers: dayLosers.length,
      total,
      winRate: dayWinners.length / total * 100,
      totalPnL: dayWinners.reduce((s,t) => s + t.netPnL, 0) + dayLosers.reduce((s,t) => s + t.netPnL, 0)
    };
  }
}

console.log('\nDay       | Wins | Loss | Total | Win% | Total P&L');
console.log('-'.repeat(55));
Object.values(dailyStats).forEach(stats => {
  console.log(`${stats.name.padEnd(9)} | ${stats.winners.toString().padStart(4)} | ${stats.losers.toString().padStart(4)} | ${stats.total.toString().padStart(5)} | ${stats.winRate.toFixed(1).padStart(4)}% | $${stats.totalPnL.toFixed(0).padStart(6)}`);
});

// =====================================================
// ANALYSIS 4: IV SKEW ANALYSIS
// =====================================================
console.log('\n' + '='.repeat(80));
console.log('IV SKEW ANALYSIS');
console.log('='.repeat(80));

const winnerSkews = winners.map(t => t.signal.ivSkew).filter(v => v !== undefined);
const loserSkews = losers.map(t => t.signal.ivSkew).filter(v => v !== undefined);

console.log('\nIV Skew Statistics:');
const winSkewStats = calcStats(winnerSkews);
const loseSkewStats = calcStats(loserSkews);

console.log(`  Winners: mean=${winSkewStats.mean.toFixed(4)}, median=${winSkewStats.median.toFixed(4)}, std=${winSkewStats.stdDev.toFixed(4)}, range=[${winSkewStats.min.toFixed(4)}, ${winSkewStats.max.toFixed(4)}]`);
console.log(`  Losers:  mean=${loseSkewStats.mean.toFixed(4)}, median=${loseSkewStats.median.toFixed(4)}, std=${loseSkewStats.stdDev.toFixed(4)}, range=[${loseSkewStats.min.toFixed(4)}, ${loseSkewStats.max.toFixed(4)}]`);

// Analyze by skew buckets
const skewBuckets = [
  { min: -Infinity, max: -0.03, label: '< -0.03' },
  { min: -0.03, max: -0.02, label: '-0.03 to -0.02' },
  { min: -0.02, max: -0.01, label: '-0.02 to -0.01' },
  { min: -0.01, max: 0.01, label: '-0.01 to 0.01' },
  { min: 0.01, max: 0.02, label: '0.01 to 0.02' },
  { min: 0.02, max: 0.03, label: '0.02 to 0.03' },
  { min: 0.03, max: Infinity, label: '> 0.03' }
];

console.log('\nPerformance by IV Skew Bucket:');
console.log('Skew Range      | Wins | Loss | Total | Win% | Avg P&L');
console.log('-'.repeat(60));

skewBuckets.forEach(bucket => {
  const bucketWinners = winners.filter(t => t.signal.ivSkew >= bucket.min && t.signal.ivSkew < bucket.max);
  const bucketLosers = losers.filter(t => t.signal.ivSkew >= bucket.min && t.signal.ivSkew < bucket.max);
  const total = bucketWinners.length + bucketLosers.length;
  if (total > 0) {
    const winRate = bucketWinners.length / total * 100;
    const avgPnL = (bucketWinners.reduce((s,t) => s + t.netPnL, 0) + bucketLosers.reduce((s,t) => s + t.netPnL, 0)) / total;
    console.log(`${bucket.label.padEnd(15)} | ${bucketWinners.length.toString().padStart(4)} | ${bucketLosers.length.toString().padStart(4)} | ${total.toString().padStart(5)} | ${winRate.toFixed(1).padStart(4)}% | $${avgPnL.toFixed(0).padStart(6)}`);
  }
});

// =====================================================
// ANALYSIS 5: IV LEVEL ANALYSIS
// =====================================================
console.log('\n' + '='.repeat(80));
console.log('IV LEVEL ANALYSIS');
console.log('='.repeat(80));

const winnerIVs = winners.map(t => t.signal.ivValue).filter(v => v !== undefined);
const loserIVs = losers.map(t => t.signal.ivValue).filter(v => v !== undefined);

const winIVStats = calcStats(winnerIVs);
const loseIVStats = calcStats(loserIVs);

console.log('\nIV Value Statistics:');
console.log(`  Winners: mean=${(winIVStats.mean*100).toFixed(1)}%, median=${(winIVStats.median*100).toFixed(1)}%, range=[${(winIVStats.min*100).toFixed(1)}%, ${(winIVStats.max*100).toFixed(1)}%]`);
console.log(`  Losers:  mean=${(loseIVStats.mean*100).toFixed(1)}%, median=${(loseIVStats.median*100).toFixed(1)}%, range=[${(loseIVStats.min*100).toFixed(1)}%, ${(loseIVStats.max*100).toFixed(1)}%]`);

// IV Buckets
const ivBuckets = [
  { min: 0, max: 0.15, label: '< 15%' },
  { min: 0.15, max: 0.18, label: '15-18%' },
  { min: 0.18, max: 0.20, label: '18-20%' },
  { min: 0.20, max: 0.25, label: '20-25%' },
  { min: 0.25, max: 0.30, label: '25-30%' },
  { min: 0.30, max: 0.40, label: '30-40%' },
  { min: 0.40, max: 1.0, label: '> 40%' }
];

console.log('\nPerformance by IV Level:');
console.log('IV Range   | Wins | Loss | Total | Win% | Avg P&L');
console.log('-'.repeat(55));

ivBuckets.forEach(bucket => {
  const bucketWinners = winners.filter(t => t.signal.ivValue >= bucket.min && t.signal.ivValue < bucket.max);
  const bucketLosers = losers.filter(t => t.signal.ivValue >= bucket.min && t.signal.ivValue < bucket.max);
  const total = bucketWinners.length + bucketLosers.length;
  if (total > 0) {
    const winRate = bucketWinners.length / total * 100;
    const avgPnL = (bucketWinners.reduce((s,t) => s + t.netPnL, 0) + bucketLosers.reduce((s,t) => s + t.netPnL, 0)) / total;
    console.log(`${bucket.label.padEnd(10)} | ${bucketWinners.length.toString().padStart(4)} | ${bucketLosers.length.toString().padStart(4)} | ${total.toString().padStart(5)} | ${winRate.toFixed(1).padStart(4)}% | $${avgPnL.toFixed(0).padStart(6)}`);
  }
});

// =====================================================
// ANALYSIS 6: LEVEL TYPE ANALYSIS
// =====================================================
console.log('\n' + '='.repeat(80));
console.log('GEX LEVEL TYPE ANALYSIS');
console.log('='.repeat(80));

const levelTypeStats = {};
trades.forEach(t => {
  const levelType = t.signal.levelType;
  if (!levelTypeStats[levelType]) {
    levelTypeStats[levelType] = { winners: 0, losers: 0, totalPnL: 0 };
  }
  if (t.netPnL > 0) {
    levelTypeStats[levelType].winners++;
  } else if (t.netPnL < 0) {
    levelTypeStats[levelType].losers++;
  }
  levelTypeStats[levelType].totalPnL += t.netPnL;
});

console.log('\nPerformance by GEX Level Type:');
console.log('Level     | Wins | Loss | Total | Win% | Total P&L | Avg P&L');
console.log('-'.repeat(65));

Object.entries(levelTypeStats).sort((a, b) => {
  const aTotal = a[1].winners + a[1].losers;
  const bTotal = b[1].winners + b[1].losers;
  return bTotal - aTotal;
}).forEach(([levelType, stats]) => {
  const total = stats.winners + stats.losers;
  const winRate = stats.winners / total * 100;
  const avgPnL = stats.totalPnL / total;
  console.log(`${levelType.padEnd(9)} | ${stats.winners.toString().padStart(4)} | ${stats.losers.toString().padStart(4)} | ${total.toString().padStart(5)} | ${winRate.toFixed(1).padStart(4)}% | $${stats.totalPnL.toFixed(0).padStart(8)} | $${avgPnL.toFixed(0).padStart(6)}`);
});

// =====================================================
// ANALYSIS 7: SIDE ANALYSIS (Long vs Short)
// =====================================================
console.log('\n' + '='.repeat(80));
console.log('SIDE ANALYSIS (Long vs Short)');
console.log('='.repeat(80));

const longTrades = trades.filter(t => t.side === 'long');
const shortTrades = trades.filter(t => t.side === 'short');

const longWinners = winners.filter(t => t.side === 'long');
const longLosers = losers.filter(t => t.side === 'long');
const shortWinners = winners.filter(t => t.side === 'short');
const shortLosers = losers.filter(t => t.side === 'short');

console.log(`\nLong Trades: ${longTrades.length} total, ${longWinners.length} wins (${(longWinners.length/longTrades.length*100).toFixed(1)}%), ${longLosers.length} losses`);
console.log(`  Total P&L: $${longTrades.reduce((s,t) => s + t.netPnL, 0).toFixed(0)}`);
console.log(`  Avg P&L: $${(longTrades.reduce((s,t) => s + t.netPnL, 0) / longTrades.length).toFixed(0)}`);

console.log(`\nShort Trades: ${shortTrades.length} total, ${shortWinners.length} wins (${(shortWinners.length/shortTrades.length*100).toFixed(1)}%), ${shortLosers.length} losses`);
console.log(`  Total P&L: $${shortTrades.reduce((s,t) => s + t.netPnL, 0).toFixed(0)}`);
console.log(`  Avg P&L: $${(shortTrades.reduce((s,t) => s + t.netPnL, 0) / shortTrades.length).toFixed(0)}`);

// =====================================================
// ANALYSIS 8: LEVEL DISTANCE ANALYSIS
// =====================================================
console.log('\n' + '='.repeat(80));
console.log('LEVEL DISTANCE ANALYSIS');
console.log('='.repeat(80));

const winnerDistances = winners.map(t => t.signal.levelDistance).filter(v => v !== undefined);
const loserDistances = losers.map(t => t.signal.levelDistance).filter(v => v !== undefined);

const winDistStats = calcStats(winnerDistances);
const loseDistStats = calcStats(loserDistances);

console.log('\nDistance from GEX Level at Entry:');
console.log(`  Winners: mean=${winDistStats.mean.toFixed(1)} pts, median=${winDistStats.median.toFixed(1)} pts, range=[${winDistStats.min.toFixed(1)}, ${winDistStats.max.toFixed(1)}]`);
console.log(`  Losers:  mean=${loseDistStats.mean.toFixed(1)} pts, median=${loseDistStats.median.toFixed(1)} pts, range=[${loseDistStats.min.toFixed(1)}, ${loseDistStats.max.toFixed(1)}]`);

// Distance buckets
const distBuckets = [
  { min: 0, max: 5, label: '0-5 pts' },
  { min: 5, max: 10, label: '5-10 pts' },
  { min: 10, max: 15, label: '10-15 pts' },
  { min: 15, max: 20, label: '15-20 pts' },
  { min: 20, max: 25, label: '20-25 pts' }
];

console.log('\nPerformance by Distance from Level:');
console.log('Distance   | Wins | Loss | Total | Win% | Avg P&L');
console.log('-'.repeat(55));

distBuckets.forEach(bucket => {
  const bucketWinners = winners.filter(t => t.signal.levelDistance >= bucket.min && t.signal.levelDistance < bucket.max);
  const bucketLosers = losers.filter(t => t.signal.levelDistance >= bucket.min && t.signal.levelDistance < bucket.max);
  const total = bucketWinners.length + bucketLosers.length;
  if (total > 0) {
    const winRate = bucketWinners.length / total * 100;
    const avgPnL = (bucketWinners.reduce((s,t) => s + t.netPnL, 0) + bucketLosers.reduce((s,t) => s + t.netPnL, 0)) / total;
    console.log(`${bucket.label.padEnd(10)} | ${bucketWinners.length.toString().padStart(4)} | ${bucketLosers.length.toString().padStart(4)} | ${total.toString().padStart(5)} | ${winRate.toFixed(1).padStart(4)}% | $${avgPnL.toFixed(0).padStart(6)}`);
  }
});

// =====================================================
// ANALYSIS 9: MAX FAVORABLE/ADVERSE EXCURSION
// =====================================================
console.log('\n' + '='.repeat(80));
console.log('MAX FAVORABLE / ADVERSE EXCURSION (MFE/MAE)');
console.log('='.repeat(80));

// Calculate MFE/MAE for each trade
function calculateExcursions(trade) {
  // For now, we can infer from the trade data
  // MFE = how far it went in our favor before exit
  // MAE = how far it went against us before exit
  const entry = trade.actualEntry || trade.entryPrice;
  const exit = trade.actualExit;
  const side = trade.side;

  // If we have entryCandle and exitCandle info, we can calculate
  // For now, calculate from the trade result
  if (side === 'long') {
    // Long: favorable = high - entry, adverse = entry - low
    // But we only have entry/exit, so infer from result
    if (trade.exitReason === 'stop_loss') {
      return { mfe: trade.stopLoss - entry + (entry - exit), mae: entry - exit };
    } else if (trade.exitReason === 'take_profit') {
      return { mfe: exit - entry, mae: 0 }; // Minimal adverse excursion likely
    }
  } else {
    // Short: favorable = entry - low, adverse = high - entry
    if (trade.exitReason === 'stop_loss') {
      return { mfe: entry - trade.stopLoss + (exit - entry), mae: exit - entry };
    } else if (trade.exitReason === 'take_profit') {
      return { mfe: entry - exit, mae: 0 };
    }
  }
  return { mfe: 0, mae: 0 };
}

// Analyze losers that went profitable before stopping out
const losersWithMFE = losers.filter(t => {
  // Check if there's metadata about max profit reached
  return t.metadata && t.metadata.maxUnrealizedProfit !== undefined && t.metadata.maxUnrealizedProfit > 0;
});

console.log(`\nLosers that were profitable before stopping out: ${losersWithMFE.length}`);

if (losersWithMFE.length > 0) {
  const mfeProfits = losersWithMFE.map(t => t.metadata.maxUnrealizedProfit);
  const mfeStats = calcStats(mfeProfits);
  console.log(`  Max profit before loss: mean=$${mfeStats.mean.toFixed(0)}, median=$${mfeStats.median.toFixed(0)}, max=$${mfeStats.max.toFixed(0)}`);
}

// =====================================================
// ANALYSIS 10: BARS HELD ANALYSIS
// =====================================================
console.log('\n' + '='.repeat(80));
console.log('BARS HELD ANALYSIS');
console.log('='.repeat(80));

const winnerBars = winners.map(t => t.barsSinceEntry).filter(v => v !== undefined);
const loserBars = losers.map(t => t.barsSinceEntry).filter(v => v !== undefined);

const winBarStats = calcStats(winnerBars);
const loseBarStats = calcStats(loserBars);

console.log('\nBars Held Before Exit:');
console.log(`  Winners: mean=${winBarStats.mean.toFixed(1)}, median=${winBarStats.median.toFixed(1)}, range=[${winBarStats.min}, ${winBarStats.max}]`);
console.log(`  Losers:  mean=${loseBarStats.mean.toFixed(1)}, median=${loseBarStats.median.toFixed(1)}, range=[${loseBarStats.min}, ${loseBarStats.max}]`);

// Bars held buckets
console.log('\nPerformance by Bars Held:');
console.log('Bars Held  | Wins | Loss | Total | Win%');
console.log('-'.repeat(45));

const barBuckets = [
  { min: 0, max: 5, label: '0-5' },
  { min: 5, max: 10, label: '5-10' },
  { min: 10, max: 20, label: '10-20' },
  { min: 20, max: 30, label: '20-30' },
  { min: 30, max: 60, label: '30-60' },
  { min: 60, max: Infinity, label: '60+' }
];

barBuckets.forEach(bucket => {
  const bucketWinners = winners.filter(t => t.barsSinceEntry >= bucket.min && t.barsSinceEntry < bucket.max);
  const bucketLosers = losers.filter(t => t.barsSinceEntry >= bucket.min && t.barsSinceEntry < bucket.max);
  const total = bucketWinners.length + bucketLosers.length;
  if (total > 0) {
    const winRate = bucketWinners.length / total * 100;
    console.log(`${bucket.label.padEnd(10)} | ${bucketWinners.length.toString().padStart(4)} | ${bucketLosers.length.toString().padStart(4)} | ${total.toString().padStart(5)} | ${winRate.toFixed(1).padStart(4)}%`);
  }
});

// =====================================================
// ANALYSIS 11: CONSECUTIVE LOSS ANALYSIS
// =====================================================
console.log('\n' + '='.repeat(80));
console.log('CONSECUTIVE LOSS ANALYSIS');
console.log('='.repeat(80));

// Sort trades by time
const sortedTrades = [...trades].sort((a, b) => a.entryTime - b.entryTime);

let maxConsecLosses = 0;
let currentConsecLosses = 0;
let consecLossStreaks = [];
let currentStreak = [];

sortedTrades.forEach((trade, i) => {
  if (trade.netPnL < 0) {
    currentConsecLosses++;
    currentStreak.push(trade);
  } else {
    if (currentConsecLosses >= 2) {
      consecLossStreaks.push({
        count: currentConsecLosses,
        trades: currentStreak,
        totalLoss: currentStreak.reduce((s, t) => s + t.netPnL, 0)
      });
    }
    if (currentConsecLosses > maxConsecLosses) {
      maxConsecLosses = currentConsecLosses;
    }
    currentConsecLosses = 0;
    currentStreak = [];
  }
});

// Handle trailing streak
if (currentConsecLosses > maxConsecLosses) {
  maxConsecLosses = currentConsecLosses;
}
if (currentConsecLosses >= 2) {
  consecLossStreaks.push({
    count: currentConsecLosses,
    trades: currentStreak,
    totalLoss: currentStreak.reduce((s, t) => s + t.netPnL, 0)
  });
}

console.log(`\nMax consecutive losses: ${maxConsecLosses}`);
console.log(`Loss streaks >= 2: ${consecLossStreaks.length}`);

if (consecLossStreaks.length > 0) {
  const worstStreak = consecLossStreaks.sort((a, b) => a.totalLoss - b.totalLoss)[0];
  console.log(`\nWorst loss streak: ${worstStreak.count} trades, $${worstStreak.totalLoss.toFixed(0)} total loss`);
  console.log('Trades in worst streak:');
  worstStreak.trades.forEach(t => {
    const date = new Date(t.entryTime).toISOString().split('T')[0];
    console.log(`  ${date} ${formatTime(t.entryTime)} UTC - ${t.side} @ ${t.signal.levelType}, P&L: $${t.netPnL.toFixed(0)}, IV: ${(t.signal.ivValue*100).toFixed(1)}%, Skew: ${t.signal.ivSkew.toFixed(4)}`);
  });
}

// =====================================================
// ANALYSIS 12: DETAILED LOSING TRADE LIST
// =====================================================
console.log('\n' + '='.repeat(80));
console.log('ALL LOSING TRADES - DETAILED');
console.log('='.repeat(80));

console.log('\nDate       | Time  | Side  | Level    | Entry    | Exit     | P&L    | Bars | IV%   | Skew');
console.log('-'.repeat(100));

losers.sort((a, b) => a.entryTime - b.entryTime).forEach(t => {
  const date = new Date(t.entryTime).toISOString().split('T')[0];
  const time = formatTime(t.entryTime);
  const iv = t.signal.ivValue ? (t.signal.ivValue * 100).toFixed(1) : '?';
  const skew = t.signal.ivSkew ? t.signal.ivSkew.toFixed(4) : '?';
  console.log(`${date} | ${time} | ${t.side.padEnd(5)} | ${(t.signal.levelType || '?').padEnd(8)} | ${t.actualEntry.toFixed(2).padStart(8)} | ${t.actualExit.toFixed(2).padStart(8)} | $${t.netPnL.toFixed(0).padStart(5)} | ${t.barsSinceEntry.toString().padStart(4)} | ${iv.padStart(5)} | ${skew}`);
});

// =====================================================
// ANALYSIS 13: UNIQUE LOSER PATTERNS
// =====================================================
console.log('\n' + '='.repeat(80));
console.log('UNIQUE LOSER PATTERNS (Only in Losers, Not Winners)');
console.log('='.repeat(80));

// Look for patterns that are significantly more common in losers

// Pattern 1: Very high IV
const highIVThreshold = 0.35;
const winHighIV = winners.filter(t => t.signal.ivValue > highIVThreshold).length;
const loseHighIV = losers.filter(t => t.signal.ivValue > highIVThreshold).length;
console.log(`\nHigh IV (>${highIVThreshold*100}%): ${winHighIV} winners, ${loseHighIV} losers`);
if (loseHighIV > 0) {
  const highIVLosers = losers.filter(t => t.signal.ivValue > highIVThreshold);
  console.log(`  High IV losers avg P&L: $${(highIVLosers.reduce((s,t) => s + t.netPnL, 0) / highIVLosers.length).toFixed(0)}`);
}

// Pattern 2: Very close to level (< 5 pts)
const closeThreshold = 5;
const winClose = winners.filter(t => t.signal.levelDistance < closeThreshold).length;
const loseClose = losers.filter(t => t.signal.levelDistance < closeThreshold).length;
console.log(`\nVery close to level (<${closeThreshold} pts): ${winClose} winners, ${loseClose} losers`);

// Pattern 3: Large positive skew (shorts)
const highPosSkew = 0.025;
const shortWinHighSkew = winners.filter(t => t.side === 'short' && t.signal.ivSkew > highPosSkew).length;
const shortLoseHighSkew = losers.filter(t => t.side === 'short' && t.signal.ivSkew > highPosSkew).length;
console.log(`\nShort with high pos skew (>${highPosSkew}): ${shortWinHighSkew} winners, ${shortLoseHighSkew} losers`);

// Pattern 4: Large negative skew (longs)
const highNegSkew = -0.025;
const longWinLowSkew = winners.filter(t => t.side === 'long' && t.signal.ivSkew < highNegSkew).length;
const longLoseLowSkew = losers.filter(t => t.side === 'long' && t.signal.ivSkew < highNegSkew).length;
console.log(`\nLong with high neg skew (<${highNegSkew}): ${longWinLowSkew} winners, ${longLoseLowSkew} losers`);

// Pattern 5: Specific level types with poor performance
console.log('\nLevel types where losers significantly outnumber winners:');
Object.entries(levelTypeStats).forEach(([level, stats]) => {
  if (stats.losers > stats.winners * 1.5 && stats.losers >= 3) {
    console.log(`  ${level}: ${stats.winners} wins, ${stats.losers} losses (${(stats.losers / stats.winners).toFixed(1)}x more losses)`);
  }
});

// =====================================================
// ANALYSIS 14: CANDIDATE FILTERS
// =====================================================
console.log('\n' + '='.repeat(80));
console.log('CANDIDATE FILTERS (Would remove X losers while keeping Y winners)');
console.log('='.repeat(80));

// Test various filter combinations
const filters = [
  {
    name: 'Avoid GammaFlip level',
    test: t => t.signal.levelType !== 'GammaFlip'
  },
  {
    name: 'Avoid IV > 35%',
    test: t => t.signal.ivValue <= 0.35
  },
  {
    name: 'Avoid IV > 30%',
    test: t => t.signal.ivValue <= 0.30
  },
  {
    name: 'Only trade S1/R1',
    test: t => ['S1', 'R1'].includes(t.signal.levelType)
  },
  {
    name: 'Avoid first 30min of RTH (14:30-15:00 UTC)',
    test: t => !(getHour(t.entryTime) === 14 && getMinute(t.entryTime) >= 30)
  },
  {
    name: 'Avoid last hour of RTH (20:00-21:00 UTC)',
    test: t => getHour(t.entryTime) < 20
  },
  {
    name: 'Level distance > 10 pts',
    test: t => t.signal.levelDistance > 10
  },
  {
    name: 'Level distance > 15 pts',
    test: t => t.signal.levelDistance > 15
  },
  {
    name: 'Avoid extreme skew (abs > 0.03)',
    test: t => Math.abs(t.signal.ivSkew) <= 0.03
  }
];

console.log('\nFilter Impact Analysis:');
console.log('Filter                                | Losers Removed | Winners Kept | Net Trades | Est. P&L Impact');
console.log('-'.repeat(100));

filters.forEach(filter => {
  const winnersKept = winners.filter(filter.test).length;
  const losersRemoved = losers.length - losers.filter(filter.test).length;
  const losersKept = losers.filter(filter.test);
  const winnersRemoved = winners.length - winnersKept;

  const keptWinnerPnL = winners.filter(filter.test).reduce((s, t) => s + t.netPnL, 0);
  const keptLoserPnL = losersKept.reduce((s, t) => s + t.netPnL, 0);
  const newTotalPnL = keptWinnerPnL + keptLoserPnL;
  const originalPnL = trades.reduce((s, t) => s + t.netPnL, 0);
  const pnlImpact = newTotalPnL - originalPnL;

  const netTrades = winnersKept + losersKept.length;

  console.log(`${filter.name.padEnd(37)} | ${losersRemoved.toString().padStart(14)} | ${winnersKept.toString().padStart(12)} | ${netTrades.toString().padStart(10)} | $${pnlImpact.toFixed(0).padStart(13)}`);
});

console.log('\n' + '='.repeat(80));
console.log('END OF ANALYSIS');
console.log('='.repeat(80));
