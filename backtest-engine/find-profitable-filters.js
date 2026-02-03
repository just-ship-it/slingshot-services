/**
 * Find profitable filters - with corrected win/loss categorization
 */
import fs from 'fs';

const data = JSON.parse(fs.readFileSync('./results/regime_scalp.json', 'utf8'));
const trades = data.trades;

// Proper categorization
const winners = trades.filter(t => t.exitReason?.toLowerCase() === 'trailing_stop');
const losers = trades.filter(t => t.exitReason?.toLowerCase() === 'stop_loss');

console.log(`\n========================================`);
console.log(`FINDING PROFITABLE FILTERS`);
console.log(`========================================`);
console.log(`Total trades: ${trades.length}`);
console.log(`Winners: ${winners.length}, Losers: ${losers.length}`);
console.log(`Current win rate: ${(winners.length / (winners.length + losers.length) * 100).toFixed(1)}%`);

// Helper to get ET hour
function getETHour(timestamp) {
  const date = new Date(timestamp);
  const etString = date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
  return parseInt(etString);
}

// Define filters to test
const filters = [
  {
    name: "Only best hours (0,3,6,16,21,23)",
    fn: t => [0, 3, 6, 16, 21, 23].includes(getETHour(t.timestamp))
  },
  {
    name: "Only Hour 16 (81.5% WR)",
    fn: t => getETHour(t.timestamp) === 16
  },
  {
    name: "Only Hour 6 (80.4% WR)",
    fn: t => getETHour(t.timestamp) === 6
  },
  {
    name: "Sunday only (79.9% WR)",
    fn: t => new Date(t.timestamp).getDay() === 0
  },
  {
    name: "Avoid worst hours (5,9,22)",
    fn: t => ![5, 9, 22].includes(getETHour(t.timestamp))
  },
  {
    name: "Only S1 level",
    fn: t => t.signal?.levelType === 'S1'
  },
  {
    name: "Avoid S2 level (worst)",
    fn: t => t.signal?.levelType !== 'S2'
  },
  {
    name: "Only profitable months (Mar, Apr, Sep)",
    fn: t => [2, 3, 8].includes(new Date(t.timestamp).getMonth()) // 0-indexed
  },
  {
    name: "Avoid November (worst month)",
    fn: t => new Date(t.timestamp).getMonth() !== 10
  },
  {
    name: "WEAK_TRENDING_UP only (best avg P&L)",
    fn: t => t.signal?.regime === 'WEAK_TRENDING_UP'
  },
  {
    name: "STRONG_TRENDING_UP only",
    fn: t => t.signal?.regime === 'STRONG_TRENDING_UP'
  },
  {
    name: "Confidence >= 75%",
    fn: t => (t.signal?.regimeConfidence || 0) >= 0.75
  },
  {
    name: "Confidence >= 80%",
    fn: t => (t.signal?.regimeConfidence || 0) >= 0.80
  },
  {
    name: "Combined: Best hours + S1 level",
    fn: t => [0, 3, 6, 16, 21, 23].includes(getETHour(t.timestamp)) && t.signal?.levelType === 'S1'
  },
  {
    name: "Combined: Best hours + Avoid S2",
    fn: t => [0, 3, 6, 16, 21, 23].includes(getETHour(t.timestamp)) && t.signal?.levelType !== 'S2'
  },
  {
    name: "Combined: Profitable months + WEAK_TRENDING_UP",
    fn: t => [2, 3, 8].includes(new Date(t.timestamp).getMonth()) && t.signal?.regime === 'WEAK_TRENDING_UP'
  },
  {
    name: "Combined: Sunday + Best hours",
    fn: t => new Date(t.timestamp).getDay() === 0 && [0, 3, 6, 16, 21, 23].includes(getETHour(t.timestamp))
  },
  {
    name: "Combined: Sunday/Monday + Avoid worst hours",
    fn: t => [0, 1].includes(new Date(t.timestamp).getDay()) && ![5, 9, 22].includes(getETHour(t.timestamp))
  },
];

const results = [];

for (const filter of filters) {
  // Filter all trades (including market close)
  const filtered = trades.filter(filter.fn);

  // Count wins and losses from filtered trades
  const filteredWins = filtered.filter(t => t.exitReason?.toLowerCase() === 'trailing_stop').length;
  const filteredLosses = filtered.filter(t => t.exitReason?.toLowerCase() === 'stop_loss').length;
  const marketClose = filtered.filter(t => t.exitReason?.toLowerCase() === 'market_close').length;

  // Calculate P&L
  const totalPnL = filtered.reduce((sum, t) => sum + (t.netPnL || 0), 0);
  const winPnL = filtered.filter(t => t.exitReason?.toLowerCase() === 'trailing_stop')
    .reduce((sum, t) => sum + (t.netPnL || 0), 0);
  const lossPnL = filtered.filter(t => t.exitReason?.toLowerCase() === 'stop_loss')
    .reduce((sum, t) => sum + (t.netPnL || 0), 0);

  const winRate = filteredWins + filteredLosses > 0
    ? (filteredWins / (filteredWins + filteredLosses) * 100).toFixed(1)
    : 'N/A';
  const avgWin = filteredWins > 0 ? winPnL / filteredWins : 0;
  const avgLoss = filteredLosses > 0 ? lossPnL / filteredLosses : 0;
  const avgPnL = filtered.length > 0 ? totalPnL / filtered.length : 0;

  results.push({
    name: filter.name,
    count: filtered.length,
    wins: filteredWins,
    losses: filteredLosses,
    marketClose,
    winRate,
    totalPnL,
    avgWin,
    avgLoss,
    avgPnL
  });
}

// Sort by total P&L
results.sort((a, b) => b.totalPnL - a.totalPnL);

console.log(`\n========================================`);
console.log(`FILTER RESULTS (Sorted by P&L)`);
console.log(`========================================`);

for (const r of results) {
  const pctOfTotal = ((r.count / trades.length) * 100).toFixed(1);
  const isPositive = r.totalPnL > 0 ? '✓' : '✗';

  console.log(`\n${isPositive} ${r.name}:`);
  console.log(`  Trades: ${r.count} (${pctOfTotal}% of total)`);
  console.log(`  Win/Loss: ${r.wins}W / ${r.losses}L / ${r.marketClose}MC`);
  console.log(`  Win Rate: ${r.winRate}%`);
  console.log(`  Avg Win: $${r.avgWin.toFixed(2)}, Avg Loss: $${r.avgLoss.toFixed(2)}`);
  console.log(`  Total P&L: $${r.totalPnL.toFixed(0)}, Avg P&L: $${r.avgPnL.toFixed(2)}`);
}

// Summary of profitable filters
console.log(`\n========================================`);
console.log(`PROFITABLE FILTERS SUMMARY`);
console.log(`========================================`);
const profitable = results.filter(r => r.totalPnL > 0);
console.log(`Profitable filters found: ${profitable.length} / ${results.length}`);
if (profitable.length > 0) {
  console.log(`\nBest profitable filters:`);
  for (const r of profitable.slice(0, 5)) {
    console.log(`  ${r.name}: $${r.totalPnL.toFixed(0)} (${r.count} trades, ${r.winRate}% WR)`);
  }
}
