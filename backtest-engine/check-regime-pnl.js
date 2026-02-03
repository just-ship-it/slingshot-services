/**
 * Check P&L by regime
 */
import fs from 'fs';

const data = JSON.parse(fs.readFileSync('./results/regime_scalp.json', 'utf8'));
const trades = data.trades;

const regimes = [...new Set(trades.map(t => t.signal?.regime).filter(Boolean))];

console.log(`\n========================================`);
console.log(`P&L BREAKDOWN BY REGIME`);
console.log(`========================================`);

const results = [];

for (const regime of regimes) {
  const regimeTrades = trades.filter(t => t.signal?.regime === regime);
  const winners = regimeTrades.filter(t => t.exitReason?.toLowerCase() === 'trailing_stop');
  const losers = regimeTrades.filter(t => t.exitReason?.toLowerCase() === 'stop_loss');
  const totalPnL = regimeTrades.reduce((sum, t) => sum + (t.netPnL || 0), 0);
  const winRate = winners.length + losers.length > 0
    ? (winners.length / (winners.length + losers.length) * 100).toFixed(1)
    : 'N/A';
  const avgWin = winners.length > 0
    ? winners.reduce((sum, t) => sum + (t.netPnL || 0), 0) / winners.length
    : 0;
  const avgLoss = losers.length > 0
    ? losers.reduce((sum, t) => sum + (t.netPnL || 0), 0) / losers.length
    : 0;

  results.push({
    regime,
    count: regimeTrades.length,
    winners: winners.length,
    losers: losers.length,
    winRate,
    totalPnL,
    avgWin,
    avgLoss
  });
}

// Sort by P&L
results.sort((a, b) => b.totalPnL - a.totalPnL);

console.log(`\nRegime Performance (sorted by P&L):`);
for (const r of results) {
  console.log(`\n${r.regime}:`);
  console.log(`  Trades: ${r.count} (${r.winners}W / ${r.losers}L)`);
  console.log(`  Win Rate: ${r.winRate}%`);
  console.log(`  Total P&L: $${r.totalPnL.toFixed(0)}`);
  console.log(`  Avg Win: $${r.avgWin.toFixed(2)}, Avg Loss: $${r.avgLoss.toFixed(2)}`);
  console.log(`  Avg P&L/trade: $${(r.totalPnL / r.count).toFixed(2)}`);
}

// Summary
const totalWinners = results.reduce((sum, r) => sum + r.winners, 0);
const totalLosers = results.reduce((sum, r) => sum + r.losers, 0);
const totalPnL = results.reduce((sum, r) => sum + r.totalPnL, 0);

console.log(`\n========================================`);
console.log(`OVERALL SUMMARY`);
console.log(`========================================`);
console.log(`Total trades: ${trades.length}`);
console.log(`Total winners: ${totalWinners}, Total losers: ${totalLosers}`);
console.log(`Overall win rate: ${(totalWinners / (totalWinners + totalLosers) * 100).toFixed(1)}%`);
console.log(`Total P&L: $${totalPnL.toFixed(0)}`);

// Find the best regime combination
console.log(`\n========================================`);
console.log(`REGIME COMBINATIONS`);
console.log(`========================================`);

// Test different combinations
const combos = [
  ['BOUNCING_SUPPORT'],
  ['WEAK_TRENDING_UP'],
  ['STRONG_TRENDING_UP'],
  ['BOUNCING_SUPPORT', 'WEAK_TRENDING_UP'],
  ['BOUNCING_SUPPORT', 'STRONG_TRENDING_UP'],
  ['WEAK_TRENDING_UP', 'STRONG_TRENDING_UP'],
  ['BOUNCING_SUPPORT', 'WEAK_TRENDING_UP', 'STRONG_TRENDING_UP'],
];

for (const combo of combos) {
  const comboTrades = trades.filter(t => combo.includes(t.signal?.regime));
  const comboWinners = comboTrades.filter(t => t.exitReason?.toLowerCase() === 'trailing_stop').length;
  const comboLosers = comboTrades.filter(t => t.exitReason?.toLowerCase() === 'stop_loss').length;
  const comboPnL = comboTrades.reduce((sum, t) => sum + (t.netPnL || 0), 0);
  const winRate = comboWinners + comboLosers > 0
    ? (comboWinners / (comboWinners + comboLosers) * 100).toFixed(1)
    : 'N/A';

  console.log(`\n${combo.join(' + ')}:`);
  console.log(`  Trades: ${comboTrades.length}, Win Rate: ${winRate}%`);
  console.log(`  P&L: $${comboPnL.toFixed(0)}, Avg: $${(comboPnL / comboTrades.length).toFixed(2)}`);
}
