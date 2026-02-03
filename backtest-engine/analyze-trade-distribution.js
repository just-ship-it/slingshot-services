#!/usr/bin/env node
import fs from 'fs';

const results = JSON.parse(fs.readFileSync('./results/gex-pullback-with-trailing.json', 'utf8'));

// Group trades by year-month
const byMonth = {};
for (const trade of results.trades) {
  const date = new Date(trade.entryTime || trade.timestamp);
  const key = date.toISOString().substring(0, 7);
  if (!byMonth[key]) byMonth[key] = { count: 0, pnl: 0, winners: 0 };
  byMonth[key].count++;
  byMonth[key].pnl += trade.netPnL;
  if (trade.netPnL > 0) byMonth[key].winners++;
}

// Print by year
const byYear = {};
for (const [month, data] of Object.entries(byMonth)) {
  const year = month.substring(0, 4);
  if (!byYear[year]) byYear[year] = { count: 0, pnl: 0, winners: 0 };
  byYear[year].count += data.count;
  byYear[year].pnl += data.pnl;
  byYear[year].winners += data.winners;
}

console.log('=== TRADES BY YEAR ===');
for (const [year, data] of Object.entries(byYear).sort()) {
  const winRate = (data.winners/data.count*100).toFixed(0);
  console.log(`${year}: ${data.count} trades, ${winRate}% win rate, $${data.pnl.toFixed(0)}`);
}

console.log('');
console.log('=== TRADES BY MONTH ===');
for (const [month, data] of Object.entries(byMonth).sort()) {
  console.log(`${month}: ${data.count.toString().padStart(3)} trades, $${data.pnl.toFixed(0).padStart(8)}`);
}

// Check 2025 specifically
console.log('\n=== 2025 TRADE DETAILS ===');
const trades2025 = results.trades.filter(t => {
  const date = new Date(t.entryTime || t.timestamp);
  return date.getFullYear() === 2025;
});

console.log(`Total 2025 trades: ${trades2025.length}`);
for (const trade of trades2025) {
  const date = new Date(trade.entryTime || trade.timestamp);
  console.log(`  ${date.toISOString().split('T')[0]} ${trade.side.toUpperCase().padEnd(5)} ${trade.exitReason.padEnd(15)} $${trade.netPnL}`);
}
