/**
 * Simulate what would happen with lower trailing triggers
 * to capture losers that went positive but not to 7pts
 */
import fs from 'fs';

const data = JSON.parse(fs.readFileSync('./results/regime_scalp.json', 'utf8'));
const trades = data.trades;

// Proper categorization
const winners = trades.filter(t => t.exitReason?.toLowerCase() === 'trailing_stop');
const losers = trades.filter(t => t.exitReason?.toLowerCase() === 'stop_loss');

console.log(`\n========================================`);
console.log(`LOWER TRAILING TRIGGER SIMULATION`);
console.log(`========================================`);
console.log(`Current: ${winners.length} winners, ${losers.length} losers`);
console.log(`Current win rate: ${(winners.length / (winners.length + losers.length) * 100).toFixed(1)}%`);

// Get HWM data for all trades
const allTrades = [...winners, ...losers].filter(t => t.trailingStop?.highWaterMark && t.actualEntry);

console.log(`\nTrades with HWM data: ${allTrades.length}`);

// Current settings
const currentOffset = 4;
const stopLoss = 20;

// Test different trailing triggers
const triggers = [3, 4, 5, 6, 7];

console.log(`\n========================================`);
console.log(`SIMULATION: Different Trailing Triggers (offset=4, stop=20)`);
console.log(`========================================`);

for (const trigger of triggers) {
  let simWins = 0;
  let simLosses = 0;
  let totalPnL = 0;

  for (const trade of allTrades) {
    const entry = trade.actualEntry;
    const hwm = trade.trailingStop.highWaterMark;
    const maxProfit = hwm - entry;

    if (maxProfit >= trigger) {
      // Would trigger trailing stop and exit at hwm - offset
      const exitProfit = maxProfit - currentOffset;
      if (exitProfit > 0) {
        simWins++;
        totalPnL += (exitProfit * 20) - 5;
      } else {
        // Trailing triggered but gave back profit
        simLosses++;
        totalPnL += (exitProfit * 20) - 5;
      }
    } else {
      // Would hit stop loss
      simLosses++;
      totalPnL += (-stopLoss * 20) - 5;
    }
  }

  const winRate = (simWins / (simWins + simLosses) * 100).toFixed(1);
  const avgPnL = (totalPnL / allTrades.length).toFixed(2);

  // Count how many losers would be converted to winners
  const losersConverted = losers.filter(t => {
    if (!t.trailingStop?.highWaterMark || !t.actualEntry) return false;
    const maxProfit = t.trailingStop.highWaterMark - t.actualEntry;
    return maxProfit >= trigger;
  }).length;

  console.log(`\nTrigger ${trigger} pts:`);
  console.log(`  Win rate: ${winRate}% (${simWins}W/${simLosses}L)`);
  console.log(`  Net P&L: $${totalPnL.toFixed(0)}`);
  console.log(`  Avg P&L/trade: $${avgPnL}`);
  console.log(`  Losers converted to wins: ${losersConverted}`);
}

// Now test different offsets too
console.log(`\n========================================`);
console.log(`SIMULATION: Different Trigger/Offset Combos`);
console.log(`========================================`);

const combos = [
  { trigger: 3, offset: 2 },  // Very tight
  { trigger: 4, offset: 2 },
  { trigger: 4, offset: 3 },
  { trigger: 5, offset: 3 },
  { trigger: 5, offset: 4 },
  { trigger: 6, offset: 3 },
  { trigger: 6, offset: 4 },
  { trigger: 7, offset: 4 },  // Current
  { trigger: 10, offset: 5 },
  { trigger: 15, offset: 7 },
];

const results = [];

for (const { trigger, offset } of combos) {
  let simWins = 0;
  let simLosses = 0;
  let totalPnL = 0;

  for (const trade of allTrades) {
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
  results.push({ trigger, offset, winRate, simWins, simLosses, totalPnL });
}

// Sort by P&L
results.sort((a, b) => b.totalPnL - a.totalPnL);

console.log(`\nRanked by Net P&L:`);
for (const r of results) {
  const marker = r.trigger === 7 && r.offset === 4 ? ' <-- CURRENT' : '';
  console.log(`  T${r.trigger}/O${r.offset}: ${r.winRate}% (${r.simWins}W/${r.simLosses}L), P&L: $${r.totalPnL.toFixed(0)}${marker}`);
}

// Calculate breakeven point
console.log(`\n========================================`);
console.log(`BREAKEVEN ANALYSIS`);
console.log(`========================================`);

// For each trigger, what's the minimum win rate needed to breakeven?
// Win amount = (trigger - offset) * 20 - 5
// Loss amount = stopLoss * 20 + 5
// At breakeven: winRate * winAmt = (1-winRate) * lossAmt

for (const trigger of [3, 4, 5, 6, 7]) {
  const offset = Math.floor(trigger / 2) + 1;  // rough estimate
  const winAmt = (trigger - offset) * 20 - 5;
  const lossAmt = stopLoss * 20 + 5;

  const breakEvenWinRate = lossAmt / (winAmt + lossAmt);
  console.log(`Trigger ${trigger} (offset ${offset}): Need ${(breakEvenWinRate * 100).toFixed(1)}% win rate to breakeven`);
  console.log(`  Win: +$${winAmt}, Loss: -$${lossAmt}`);
}
