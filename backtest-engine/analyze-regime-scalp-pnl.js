/**
 * Deep P&L analysis for regime-scalp trades
 */

import fs from 'fs';

const data = JSON.parse(fs.readFileSync('./results/regime_scalp.json', 'utf8'));
const trades = data.trades;

const winners = trades.filter(t => t.exitReason?.toLowerCase().includes('trailing'));
const losers = trades.filter(t => t.exitReason?.toLowerCase().includes('stop'));

console.log(`\n========================================`);
console.log(`P&L DISTRIBUTION ANALYSIS`);
console.log(`========================================`);

// P&L distributions
const winnerPnL = winners.map(t => t.netPnL || 0).sort((a, b) => a - b);
const loserPnL = losers.map(t => t.netPnL || 0).sort((a, b) => a - b);

console.log(`\nWinner P&L distribution:`);
console.log(`  Min: $${Math.min(...winnerPnL).toFixed(2)}`);
console.log(`  25th percentile: $${winnerPnL[Math.floor(winnerPnL.length * 0.25)]?.toFixed(2)}`);
console.log(`  Median: $${winnerPnL[Math.floor(winnerPnL.length * 0.5)]?.toFixed(2)}`);
console.log(`  75th percentile: $${winnerPnL[Math.floor(winnerPnL.length * 0.75)]?.toFixed(2)}`);
console.log(`  Max: $${Math.max(...winnerPnL).toFixed(2)}`);
console.log(`  Total: $${winnerPnL.reduce((a, b) => a + b, 0).toFixed(2)}`);

console.log(`\nLoser P&L distribution:`);
console.log(`  Min: $${Math.min(...loserPnL).toFixed(2)}`);
console.log(`  25th percentile: $${loserPnL[Math.floor(loserPnL.length * 0.25)]?.toFixed(2)}`);
console.log(`  Median: $${loserPnL[Math.floor(loserPnL.length * 0.5)]?.toFixed(2)}`);
console.log(`  75th percentile: $${loserPnL[Math.floor(loserPnL.length * 0.75)]?.toFixed(2)}`);
console.log(`  Max: $${Math.max(...loserPnL).toFixed(2)}`);
console.log(`  Total: $${loserPnL.reduce((a, b) => a + b, 0).toFixed(2)}`);

// Winner exit analysis - how far did price move after entry?
console.log(`\n========================================`);
console.log(`WINNER EXIT ANALYSIS`);
console.log(`========================================`);

const winnerPoints = winners.map(t => {
  const entry = t.actualEntry || t.entryPrice;
  const exit = t.actualExit;
  return (exit - entry);
});

console.log(`Points captured by winners:`);
console.log(`  Min: ${Math.min(...winnerPoints).toFixed(2)} pts`);
console.log(`  Median: ${winnerPoints.sort((a, b) => a - b)[Math.floor(winnerPoints.length * 0.5)]?.toFixed(2)} pts`);
console.log(`  Max: ${Math.max(...winnerPoints).toFixed(2)} pts`);
console.log(`  Avg: ${(winnerPoints.reduce((a, b) => a + b, 0) / winnerPoints.length).toFixed(2)} pts`);

// Loser analysis
const loserPoints = losers.map(t => {
  const entry = t.actualEntry || t.entryPrice;
  const exit = t.actualExit;
  return (exit - entry);
});

console.log(`\nPoints lost by losers:`);
console.log(`  Min: ${Math.min(...loserPoints).toFixed(2)} pts`);
console.log(`  Median: ${loserPoints.sort((a, b) => a - b)[Math.floor(loserPoints.length * 0.5)]?.toFixed(2)} pts`);
console.log(`  Max: ${Math.max(...loserPoints).toFixed(2)} pts`);
console.log(`  Avg: ${(loserPoints.reduce((a, b) => a + b, 0) / loserPoints.length).toFixed(2)} pts`);

// High water mark analysis for winners - how high did price go before trailing stop hit?
console.log(`\n========================================`);
console.log(`HIGH WATER MARK ANALYSIS (Winners)`);
console.log(`========================================`);

const hwmData = winners.filter(t => t.trailingStop?.highWaterMark).map(t => {
  const entry = t.actualEntry || t.entryPrice;
  const hwm = t.trailingStop.highWaterMark;
  const exit = t.actualExit;
  const maxProfit = hwm - entry;
  const actualProfit = exit - entry;
  const giveback = maxProfit - actualProfit;
  return { maxProfit, actualProfit, giveback, pctCaptured: actualProfit / maxProfit * 100 };
});

if (hwmData.length > 0) {
  const maxProfits = hwmData.map(d => d.maxProfit);
  const givebacks = hwmData.map(d => d.giveback);
  const pctCaptured = hwmData.map(d => d.pctCaptured).filter(p => isFinite(p));

  console.log(`Max profit reached (HWM - Entry):`);
  console.log(`  Median: ${maxProfits.sort((a, b) => a - b)[Math.floor(maxProfits.length * 0.5)]?.toFixed(2)} pts`);
  console.log(`  Avg: ${(maxProfits.reduce((a, b) => a + b, 0) / maxProfits.length).toFixed(2)} pts`);

  console.log(`\nGiveback (HWM - Exit):`);
  console.log(`  Median: ${givebacks.sort((a, b) => a - b)[Math.floor(givebacks.length * 0.5)]?.toFixed(2)} pts`);
  console.log(`  Avg: ${(givebacks.reduce((a, b) => a + b, 0) / givebacks.length).toFixed(2)} pts`);

  console.log(`\nPercent of max profit captured:`);
  console.log(`  Median: ${pctCaptured.sort((a, b) => a - b)[Math.floor(pctCaptured.length * 0.5)]?.toFixed(1)}%`);
  console.log(`  Avg: ${(pctCaptured.reduce((a, b) => a + b, 0) / pctCaptured.length).toFixed(1)}%`);
}

// Look at trades that would have been big winners if held longer
console.log(`\n========================================`);
console.log(`MISSED PROFIT ANALYSIS`);
console.log(`========================================`);

const bigWinPotential = hwmData.filter(d => d.maxProfit >= 30); // 30+ pt potential
console.log(`Trades with 30+ pt max profit: ${bigWinPotential.length}`);
if (bigWinPotential.length > 0) {
  const avgCaptured = bigWinPotential.reduce((a, b) => a + b.actualProfit, 0) / bigWinPotential.length;
  const avgMax = bigWinPotential.reduce((a, b) => a + b.maxProfit, 0) / bigWinPotential.length;
  console.log(`  Avg max profit: ${avgMax.toFixed(1)} pts`);
  console.log(`  Avg actual profit: ${avgCaptured.toFixed(1)} pts`);
  console.log(`  Avg missed: ${(avgMax - avgCaptured).toFixed(1)} pts`);
}

// Analyze by trailing trigger settings in trades
console.log(`\n========================================`);
console.log(`TRAILING STOP SETTINGS IN TRADES`);
console.log(`========================================`);

const triggerSettings = {};
for (const trade of [...winners, ...losers]) {
  const trigger = trade.trailingTrigger || trade.signal?.trailingTrigger || 'unknown';
  const offset = trade.trailingOffset || trade.signal?.trailingOffset || 'unknown';
  const key = `${trigger}/${offset}`;
  if (!triggerSettings[key]) triggerSettings[key] = { wins: 0, losses: 0, winPnL: 0, lossPnL: 0 };
  if (trade.exitReason?.toLowerCase().includes('trailing')) {
    triggerSettings[key].wins++;
    triggerSettings[key].winPnL += trade.netPnL || 0;
  } else {
    triggerSettings[key].losses++;
    triggerSettings[key].lossPnL += trade.netPnL || 0;
  }
}

console.log(`Performance by trailing trigger/offset:`);
for (const [key, data] of Object.entries(triggerSettings)) {
  const total = data.wins + data.losses;
  const winRate = total > 0 ? (data.wins / total * 100).toFixed(1) : 'N/A';
  const avgWin = data.wins > 0 ? (data.winPnL / data.wins).toFixed(2) : 'N/A';
  const avgLoss = data.losses > 0 ? (data.lossPnL / data.losses).toFixed(2) : 'N/A';
  const netPnL = data.winPnL + data.lossPnL;
  console.log(`  ${key}: ${data.wins}W/${data.losses}L (${winRate}%), avgWin: $${avgWin}, avgLoss: $${avgLoss}, net: $${netPnL.toFixed(0)}`);
}

// The key question: what makes a loser a loser?
console.log(`\n========================================`);
console.log(`LOSER DEEP DIVE`);
console.log(`========================================`);

// Did losers ever go positive?
const losersWithHWM = losers.filter(t => t.trailingStop?.highWaterMark);
const losersWentPositive = losersWithHWM.filter(t => {
  const entry = t.actualEntry || t.entryPrice;
  const hwm = t.trailingStop.highWaterMark;
  return hwm > entry;
});

console.log(`Losers that went positive before stopping out: ${losersWentPositive.length} / ${losers.length} (${(losersWentPositive.length / losers.length * 100).toFixed(1)}%)`);

if (losersWentPositive.length > 0) {
  const maxProfitBeforeLoss = losersWentPositive.map(t => t.trailingStop.highWaterMark - (t.actualEntry || t.entryPrice));
  console.log(`  Avg max profit reached: ${(maxProfitBeforeLoss.reduce((a, b) => a + b, 0) / maxProfitBeforeLoss.length).toFixed(2)} pts`);
  console.log(`  Median max profit reached: ${maxProfitBeforeLoss.sort((a, b) => a - b)[Math.floor(maxProfitBeforeLoss.length * 0.5)]?.toFixed(2)} pts`);
}

// Time to stop - how quickly did losers stop out?
const loserDurations = losers.map(t => (t.exitTime - t.entryTime) / 1000 / 60);
console.log(`\nTime to stop loss:`);
console.log(`  < 1 min: ${loserDurations.filter(d => d < 1).length}`);
console.log(`  1-5 min: ${loserDurations.filter(d => d >= 1 && d < 5).length}`);
console.log(`  5-15 min: ${loserDurations.filter(d => d >= 5 && d < 15).length}`);
console.log(`  15-30 min: ${loserDurations.filter(d => d >= 15 && d < 30).length}`);
console.log(`  30+ min: ${loserDurations.filter(d => d >= 30).length}`);

// Combined profitable filtering analysis
console.log(`\n========================================`);
console.log(`COMBINED FILTER SIMULATION`);
console.log(`========================================`);

// Best performing filters identified:
// - Hour 16, Hour 6, Sunday, Hour 23, Hour 0, Hour 3
// - Level S1 > S2
// - trend_pullback > support_bounce > neutral_support
// - Avoid NEUTRAL regime

function getETHour(timestamp) {
  const date = new Date(timestamp);
  const etString = date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
  return parseInt(etString);
}

// Simulate various filter combinations
const filters = [
  {
    name: "Avoid Hour 18 (worst hour)",
    fn: t => getETHour(t.timestamp) !== 18
  },
  {
    name: "Only best hours (0,3,6,16,21,23)",
    fn: t => [0, 3, 6, 16, 21, 23].includes(getETHour(t.timestamp))
  },
  {
    name: "Only S1 level",
    fn: t => t.signal?.levelType === 'S1'
  },
  {
    name: "Only trend_pullback entry",
    fn: t => t.signal?.entryType === 'trend_pullback'
  },
  {
    name: "Avoid NEUTRAL regime",
    fn: t => t.signal?.regime !== 'NEUTRAL'
  },
  {
    name: "Sunday/Monday/Wednesday only",
    fn: t => [0, 1, 3].includes(new Date(t.timestamp).getDay())
  },
  {
    name: "Combined: S1 + trend_pullback + avoid NEUTRAL",
    fn: t => t.signal?.levelType === 'S1' && t.signal?.entryType === 'trend_pullback' && t.signal?.regime !== 'NEUTRAL'
  },
  {
    name: "Combined: Best hours + S1",
    fn: t => [0, 3, 6, 16, 21, 23].includes(getETHour(t.timestamp)) && t.signal?.levelType === 'S1'
  }
];

for (const filter of filters) {
  const filtered = [...winners, ...losers].filter(filter.fn);
  const filteredWins = filtered.filter(t => t.exitReason?.toLowerCase().includes('trailing')).length;
  const filteredLosses = filtered.filter(t => t.exitReason?.toLowerCase().includes('stop')).length;
  const totalPnL = filtered.reduce((sum, t) => sum + (t.netPnL || 0), 0);
  const winRate = filteredWins + filteredLosses > 0 ? (filteredWins / (filteredWins + filteredLosses) * 100).toFixed(1) : 'N/A';

  console.log(`\n${filter.name}:`);
  console.log(`  Trades: ${filtered.length} (${((filtered.length / (winners.length + losers.length)) * 100).toFixed(1)}% of total)`);
  console.log(`  Win rate: ${winRate}% (${filteredWins}W/${filteredLosses}L)`);
  console.log(`  Net P&L: $${totalPnL.toFixed(0)}`);
  console.log(`  Avg P&L: $${(totalPnL / filtered.length).toFixed(2)}`);
}

console.log(`\n========================================`);
console.log(`ANALYSIS COMPLETE`);
console.log(`========================================`);
