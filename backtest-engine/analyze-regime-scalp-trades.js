/**
 * Analyze regime-scalp trades to find patterns in winners vs losers
 */

import fs from 'fs';
import path from 'path';

// Load trade data
const tradesFile = './results/regime_scalp.json';
const data = JSON.parse(fs.readFileSync(tradesFile, 'utf8'));
const trades = data.trades;

console.log(`\n========================================`);
console.log(`REGIME SCALP TRADE ANALYSIS`);
console.log(`========================================`);
console.log(`Total trades: ${trades.length}`);

// Categorize trades by exit reason
const winners = trades.filter(t => t.exitReason === 'trailing_stop' || t.exitReason === 'TRAILING_STOP');
const losers = trades.filter(t => t.exitReason === 'stop_loss' || t.exitReason === 'STOP_LOSS');
const marketClose = trades.filter(t => t.exitReason === 'market_close' || t.exitReason === 'MARKET_CLOSE');

console.log(`\nWinners (trailing stop): ${winners.length}`);
console.log(`Losers (stop loss): ${losers.length}`);
console.log(`Market close: ${marketClose.length}`);

// Helper functions
const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const median = arr => {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Analysis 1: Regime Confidence
console.log(`\n========================================`);
console.log(`1. REGIME CONFIDENCE`);
console.log(`========================================`);
const winnerConfidence = winners.map(t => t.signal?.regimeConfidence || 0);
const loserConfidence = losers.map(t => t.signal?.regimeConfidence || 0);
console.log(`Winners avg confidence: ${(avg(winnerConfidence) * 100).toFixed(1)}%`);
console.log(`Losers avg confidence: ${(avg(loserConfidence) * 100).toFixed(1)}%`);
console.log(`Winners median confidence: ${(median(winnerConfidence) * 100).toFixed(1)}%`);
console.log(`Losers median confidence: ${(median(loserConfidence) * 100).toFixed(1)}%`);

// Confidence buckets
const confBuckets = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
console.log(`\nWin rate by confidence bucket:`);
for (let i = 0; i < confBuckets.length; i++) {
  const min = confBuckets[i];
  const max = confBuckets[i + 1] || 1.0;
  const bucketWins = winners.filter(t => (t.signal?.regimeConfidence || 0) >= min && (t.signal?.regimeConfidence || 0) < max).length;
  const bucketLosses = losers.filter(t => (t.signal?.regimeConfidence || 0) >= min && (t.signal?.regimeConfidence || 0) < max).length;
  const total = bucketWins + bucketLosses;
  const winRate = total > 0 ? (bucketWins / total * 100).toFixed(1) : 'N/A';
  console.log(`  ${(min * 100).toFixed(0)}%-${(max * 100).toFixed(0)}%: ${bucketWins}W/${bucketLosses}L = ${winRate}% win rate`);
}

// Analysis 2: Level Type
console.log(`\n========================================`);
console.log(`2. LEVEL TYPE`);
console.log(`========================================`);
const levelTypes = [...new Set(trades.map(t => t.signal?.levelType).filter(Boolean))];
console.log(`Level types found: ${levelTypes.join(', ')}`);
console.log(`\nWin rate by level type:`);
for (const levelType of levelTypes) {
  const ltWins = winners.filter(t => t.signal?.levelType === levelType).length;
  const ltLosses = losers.filter(t => t.signal?.levelType === levelType).length;
  const total = ltWins + ltLosses;
  const winRate = total > 0 ? (ltWins / total * 100).toFixed(1) : 'N/A';
  const avgPnL = avg(trades.filter(t => t.signal?.levelType === levelType).map(t => t.netPnL || 0));
  console.log(`  ${levelType}: ${ltWins}W/${ltLosses}L = ${winRate}% win rate, avg P&L: $${avgPnL.toFixed(2)}`);
}

// Analysis 3: Level Distance
console.log(`\n========================================`);
console.log(`3. LEVEL DISTANCE (how close to support)`);
console.log(`========================================`);
const winnerDistance = winners.map(t => t.signal?.levelDistance || 0);
const loserDistance = losers.map(t => t.signal?.levelDistance || 0);
console.log(`Winners avg distance: ${avg(winnerDistance).toFixed(2)} pts`);
console.log(`Losers avg distance: ${avg(loserDistance).toFixed(2)} pts`);
console.log(`Winners median distance: ${median(winnerDistance).toFixed(2)} pts`);
console.log(`Losers median distance: ${median(loserDistance).toFixed(2)} pts`);

// Distance buckets
console.log(`\nWin rate by distance bucket:`);
const distBuckets = [0, 1, 2, 3, 4, 5];
for (let i = 0; i < distBuckets.length; i++) {
  const min = distBuckets[i];
  const max = distBuckets[i + 1] || 10;
  const bucketWins = winners.filter(t => (t.signal?.levelDistance || 0) >= min && (t.signal?.levelDistance || 0) < max).length;
  const bucketLosses = losers.filter(t => (t.signal?.levelDistance || 0) >= min && (t.signal?.levelDistance || 0) < max).length;
  const total = bucketWins + bucketLosses;
  const winRate = total > 0 ? (bucketWins / total * 100).toFixed(1) : 'N/A';
  console.log(`  ${min}-${max} pts: ${bucketWins}W/${bucketLosses}L = ${winRate}% win rate`);
}

// Analysis 4: Time of Day
console.log(`\n========================================`);
console.log(`4. TIME OF DAY (Eastern Time)`);
console.log(`========================================`);
function getETHour(timestamp) {
  const date = new Date(timestamp);
  const etString = date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
  return parseInt(etString);
}

const hourBuckets = {};
for (const trade of [...winners, ...losers]) {
  const hour = getETHour(trade.timestamp);
  if (!hourBuckets[hour]) hourBuckets[hour] = { wins: 0, losses: 0 };
  if (trade.exitReason?.toLowerCase().includes('trailing')) {
    hourBuckets[hour].wins++;
  } else {
    hourBuckets[hour].losses++;
  }
}

console.log(`Win rate by hour (ET):`);
const sortedHours = Object.keys(hourBuckets).sort((a, b) => parseInt(a) - parseInt(b));
for (const hour of sortedHours) {
  const { wins, losses } = hourBuckets[hour];
  const total = wins + losses;
  const winRate = total > 0 ? (wins / total * 100).toFixed(1) : 'N/A';
  const session = hour >= 9.5 && hour < 16 ? 'RTH' : (hour >= 4 && hour < 9.5 ? 'Pre' : (hour >= 16 && hour < 18 ? 'AH' : 'ON'));
  console.log(`  ${hour}:00 (${session}): ${wins}W/${losses}L = ${winRate}% win rate`);
}

// Analysis 5: Day of Week
console.log(`\n========================================`);
console.log(`5. DAY OF WEEK`);
console.log(`========================================`);
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayBuckets = {};
for (const trade of [...winners, ...losers]) {
  const day = new Date(trade.timestamp).getDay();
  if (!dayBuckets[day]) dayBuckets[day] = { wins: 0, losses: 0 };
  if (trade.exitReason?.toLowerCase().includes('trailing')) {
    dayBuckets[day].wins++;
  } else {
    dayBuckets[day].losses++;
  }
}

for (let day = 0; day < 7; day++) {
  if (dayBuckets[day]) {
    const { wins, losses } = dayBuckets[day];
    const total = wins + losses;
    const winRate = total > 0 ? (wins / total * 100).toFixed(1) : 'N/A';
    console.log(`  ${dayNames[day]}: ${wins}W/${losses}L = ${winRate}% win rate`);
  }
}

// Analysis 6: Entry Type
console.log(`\n========================================`);
console.log(`6. ENTRY TYPE`);
console.log(`========================================`);
const entryTypes = [...new Set(trades.map(t => t.signal?.entryType).filter(Boolean))];
for (const entryType of entryTypes) {
  const etWins = winners.filter(t => t.signal?.entryType === entryType).length;
  const etLosses = losers.filter(t => t.signal?.entryType === entryType).length;
  const total = etWins + etLosses;
  const winRate = total > 0 ? (etWins / total * 100).toFixed(1) : 'N/A';
  console.log(`  ${entryType}: ${etWins}W/${etLosses}L = ${winRate}% win rate`);
}

// Analysis 7: Duration before stop/win
console.log(`\n========================================`);
console.log(`7. TRADE DURATION`);
console.log(`========================================`);
const winnerDuration = winners.map(t => (t.exitTime - t.entryTime) / 1000 / 60); // minutes
const loserDuration = losers.map(t => (t.exitTime - t.entryTime) / 1000 / 60);
console.log(`Winners avg duration: ${avg(winnerDuration).toFixed(1)} minutes`);
console.log(`Losers avg duration: ${avg(loserDuration).toFixed(1)} minutes`);
console.log(`Winners median duration: ${median(winnerDuration).toFixed(1)} minutes`);
console.log(`Losers median duration: ${median(loserDuration).toFixed(1)} minutes`);

// Analysis 8: Price movement before entry
console.log(`\n========================================`);
console.log(`8. FILL DELAY (signal to fill)`);
console.log(`========================================`);
const winnerFillDelay = winners.map(t => (t.fillDelay || 0) / 1000); // seconds
const loserFillDelay = losers.map(t => (t.fillDelay || 0) / 1000);
console.log(`Winners avg fill delay: ${avg(winnerFillDelay).toFixed(1)} seconds`);
console.log(`Losers avg fill delay: ${avg(loserFillDelay).toFixed(1)} seconds`);

// Analysis 9: Month patterns
console.log(`\n========================================`);
console.log(`9. MONTHLY PATTERNS`);
console.log(`========================================`);
const monthBuckets = {};
for (const trade of [...winners, ...losers]) {
  const month = new Date(trade.timestamp).getMonth();
  if (!monthBuckets[month]) monthBuckets[month] = { wins: 0, losses: 0, pnl: 0 };
  if (trade.exitReason?.toLowerCase().includes('trailing')) {
    monthBuckets[month].wins++;
  } else {
    monthBuckets[month].losses++;
  }
  monthBuckets[month].pnl += trade.netPnL || 0;
}

const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
for (let month = 0; month < 12; month++) {
  if (monthBuckets[month]) {
    const { wins, losses, pnl } = monthBuckets[month];
    const total = wins + losses;
    const winRate = total > 0 ? (wins / total * 100).toFixed(1) : 'N/A';
    console.log(`  ${monthNames[month]}: ${wins}W/${losses}L = ${winRate}% win rate, P&L: $${pnl.toFixed(0)}`);
  }
}

// Analysis 10: Regime type breakdown
console.log(`\n========================================`);
console.log(`10. REGIME TYPE`);
console.log(`========================================`);
const regimes = [...new Set(trades.map(t => t.signal?.regime).filter(Boolean))];
for (const regime of regimes) {
  const rWins = winners.filter(t => t.signal?.regime === regime).length;
  const rLosses = losers.filter(t => t.signal?.regime === regime).length;
  const total = rWins + rLosses;
  const winRate = total > 0 ? (rWins / total * 100).toFixed(1) : 'N/A';
  const avgPnL = avg(trades.filter(t => t.signal?.regime === regime).map(t => t.netPnL || 0));
  console.log(`  ${regime}: ${rWins}W/${rLosses}L = ${winRate}% win rate, avg P&L: $${avgPnL.toFixed(2)}`);
}

// Summary: Find the best filters
console.log(`\n========================================`);
console.log(`POTENTIAL FILTERS TO IMPROVE WIN RATE`);
console.log(`========================================`);

// Find conditions with best win rates
const conditions = [];

// Check each hour
for (const hour of sortedHours) {
  const { wins, losses } = hourBuckets[hour];
  const total = wins + losses;
  if (total >= 10) { // Need enough samples
    const winRate = wins / total;
    conditions.push({ filter: `Hour ${hour} ET`, winRate, wins, losses, total });
  }
}

// Check each day
for (let day = 0; day < 7; day++) {
  if (dayBuckets[day]) {
    const { wins, losses } = dayBuckets[day];
    const total = wins + losses;
    if (total >= 10) {
      const winRate = wins / total;
      conditions.push({ filter: `${dayNames[day]}`, winRate, wins, losses, total });
    }
  }
}

// Check each level type
for (const levelType of levelTypes) {
  const ltWins = winners.filter(t => t.signal?.levelType === levelType).length;
  const ltLosses = losers.filter(t => t.signal?.levelType === levelType).length;
  const total = ltWins + ltLosses;
  if (total >= 10) {
    const winRate = ltWins / total;
    conditions.push({ filter: `Level: ${levelType}`, winRate, wins: ltWins, losses: ltLosses, total });
  }
}

// Check confidence ranges
for (let i = 0; i < confBuckets.length; i++) {
  const min = confBuckets[i];
  const max = confBuckets[i + 1] || 1.0;
  const bucketWins = winners.filter(t => (t.signal?.regimeConfidence || 0) >= min && (t.signal?.regimeConfidence || 0) < max).length;
  const bucketLosses = losers.filter(t => (t.signal?.regimeConfidence || 0) >= min && (t.signal?.regimeConfidence || 0) < max).length;
  const total = bucketWins + bucketLosses;
  if (total >= 10) {
    const winRate = bucketWins / total;
    conditions.push({ filter: `Confidence ${(min * 100).toFixed(0)}-${(max * 100).toFixed(0)}%`, winRate, wins: bucketWins, losses: bucketLosses, total });
  }
}

// Sort by win rate
conditions.sort((a, b) => b.winRate - a.winRate);

console.log(`\nTop conditions by win rate (min 10 trades):`);
conditions.slice(0, 15).forEach((c, i) => {
  console.log(`  ${i + 1}. ${c.filter}: ${(c.winRate * 100).toFixed(1)}% (${c.wins}W/${c.losses}L, n=${c.total})`);
});

console.log(`\nWorst conditions by win rate:`);
conditions.slice(-10).reverse().forEach((c, i) => {
  console.log(`  ${i + 1}. ${c.filter}: ${(c.winRate * 100).toFixed(1)}% (${c.wins}W/${c.losses}L, n=${c.total})`);
});

console.log(`\n========================================`);
console.log(`ANALYSIS COMPLETE`);
console.log(`========================================`);
