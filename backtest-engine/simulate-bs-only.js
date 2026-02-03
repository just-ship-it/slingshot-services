/**
 * Simulate trailing stop changes for BOUNCING_SUPPORT trades only
 */
import fs from 'fs';

const data = JSON.parse(fs.readFileSync('./results/regime_scalp.json', 'utf8'));
const allTrades = data.trades;

// Filter to only BOUNCING_SUPPORT regime
const trades = allTrades.filter(t => t.signal?.regime === 'BOUNCING_SUPPORT');

console.log(`\n========================================`);
console.log(`BOUNCING_SUPPORT ONLY ANALYSIS`);
console.log(`========================================`);
console.log(`Total BOUNCING_SUPPORT trades: ${trades.length} / ${allTrades.length}`);

const winners = trades.filter(t => t.exitReason?.toLowerCase() === 'trailing_stop');
const losers = trades.filter(t => t.exitReason?.toLowerCase() === 'stop_loss');
const marketClose = trades.filter(t => t.exitReason?.toLowerCase() === 'market_close');

console.log(`Winners (trailing_stop): ${winners.length}`);
console.log(`Losers (stop_loss): ${losers.length}`);
console.log(`Market close: ${marketClose.length}`);
console.log(`Win rate: ${(winners.length / (winners.length + losers.length) * 100).toFixed(1)}%`);

// Calculate current P&L
const currentPnL = trades.reduce((sum, t) => sum + (t.netPnL || 0), 0);
console.log(`Current net P&L: $${currentPnL.toFixed(0)}`);

// Get trades with HWM data
const tradesWithHWM = trades.filter(t => t.trailingStop?.highWaterMark && t.actualEntry);
console.log(`\nTrades with HWM data: ${tradesWithHWM.length}`);

// Loser max profit distribution
const loserMaxProfits = losers
  .filter(t => t.trailingStop?.highWaterMark && t.actualEntry)
  .map(t => t.trailingStop.highWaterMark - t.actualEntry);

if (loserMaxProfits.length > 0) {
  const sorted = [...loserMaxProfits].sort((a, b) => a - b);
  console.log(`\nLoser max profit before stopping:`);
  console.log(`  Min: ${Math.min(...loserMaxProfits).toFixed(2)} pts`);
  console.log(`  Median: ${sorted[Math.floor(sorted.length * 0.5)]?.toFixed(2)} pts`);
  console.log(`  Max: ${Math.max(...loserMaxProfits).toFixed(2)} pts`);
}

// Test different trailing triggers
const stopLoss = 20;
const triggers = [3, 4, 5, 6, 7, 10];
const offsets = [2, 3, 4];

console.log(`\n========================================`);
console.log(`TRAILING STOP SIMULATION (BOUNCING_SUPPORT only)`);
console.log(`========================================`);

const results = [];

for (const trigger of triggers) {
  for (const offset of offsets) {
    if (offset >= trigger) continue;  // offset must be less than trigger

    let simWins = 0;
    let simLosses = 0;
    let totalPnL = 0;

    for (const trade of tradesWithHWM) {
      const entry = trade.actualEntry;
      const hwm = trade.trailingStop.highWaterMark;
      const maxProfit = hwm - entry;

      if (maxProfit >= trigger) {
        const exitProfit = maxProfit - offset;
        if (exitProfit > 0) {
          simWins++;
        } else {
          simLosses++;
        }
        totalPnL += (exitProfit * 20) - 5;
      } else {
        simLosses++;
        totalPnL += (-stopLoss * 20) - 5;
      }
    }

    const winRate = (simWins / (simWins + simLosses) * 100).toFixed(1);
    const avgPnL = (totalPnL / tradesWithHWM.length).toFixed(2);

    results.push({ trigger, offset, simWins, simLosses, winRate, totalPnL, avgPnL });
  }
}

// Sort by P&L
results.sort((a, b) => b.totalPnL - a.totalPnL);

console.log(`\nRanked by Net P&L:`);
for (const r of results) {
  const marker = r.trigger === 7 && r.offset === 4 ? ' <-- CURRENT' : '';
  console.log(`  T${r.trigger}/O${r.offset}: ${r.winRate}% (${r.simWins}W/${r.simLosses}L), P&L: $${r.totalPnL.toFixed(0)}, Avg: $${r.avgPnL}${marker}`);
}

// Compare to actual backtest of BS-only
console.log(`\n========================================`);
console.log(`COMPARISON: Simulation vs Reality`);
console.log(`========================================`);
console.log(`Original T7/O4 actual P&L: $${currentPnL.toFixed(0)}`);
const t7o4Sim = results.find(r => r.trigger === 7 && r.offset === 4);
if (t7o4Sim) {
  console.log(`Simulation T7/O4 P&L: $${t7o4Sim.totalPnL.toFixed(0)}`);
  console.log(`Difference: $${(t7o4Sim.totalPnL - currentPnL).toFixed(0)}`);
}
