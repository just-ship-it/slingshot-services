/**
 * Simulate different exit strategies on the same entries
 */

import fs from 'fs';

const data = JSON.parse(fs.readFileSync('./results/regime_scalp.json', 'utf8'));
const trades = data.trades.filter(t => t.actualEntry && t.trailingStop);

console.log(`\n========================================`);
console.log(`EXIT STRATEGY SIMULATION`);
console.log(`========================================`);
console.log(`Trades with HWM data: ${trades.length}`);

// Current results
const currentWins = trades.filter(t => t.exitReason?.toLowerCase().includes('trailing'));
const currentLosses = trades.filter(t => t.exitReason?.toLowerCase().includes('stop'));
const currentPnL = trades.reduce((sum, t) => sum + (t.netPnL || 0), 0);

console.log(`\nCurrent strategy (trailing 7/4):`);
console.log(`  Wins: ${currentWins.length}, Losses: ${currentLosses.length}`);
console.log(`  Win rate: ${(currentWins.length / (currentWins.length + currentLosses.length) * 100).toFixed(1)}%`);
console.log(`  Net P&L: $${currentPnL.toFixed(0)}`);

// Simulate fixed take profit at different levels
console.log(`\n========================================`);
console.log(`FIXED TAKE PROFIT SIMULATION`);
console.log(`========================================`);

const tpLevels = [5, 7, 10, 12, 15, 20];
const stopLoss = 20; // 20 pt stop

for (const tp of tpLevels) {
  let wins = 0;
  let losses = 0;
  let totalPnL = 0;

  for (const trade of trades) {
    const entry = trade.actualEntry;
    const hwm = trade.trailingStop.highWaterMark;
    const maxProfit = hwm - entry;
    const actualLoss = trade.actualExit - entry; // Could be stop loss

    if (maxProfit >= tp) {
      // Would have hit take profit
      wins++;
      totalPnL += (tp * 20) - 5; // $20/pt minus commission
    } else if (actualLoss <= -stopLoss) {
      // Hit stop loss
      losses++;
      totalPnL += (-stopLoss * 20) - 5;
    } else {
      // Market close or other - use actual result
      totalPnL += (trade.netPnL || 0);
    }
  }

  const winRate = wins + losses > 0 ? (wins / (wins + losses) * 100).toFixed(1) : 'N/A';
  console.log(`TP ${tp} pts: ${wins}W/${losses}L (${winRate}%), Net P&L: $${totalPnL.toFixed(0)}, Avg: $${(totalPnL / trades.length).toFixed(2)}`);
}

// Simulate tighter trailing stop
console.log(`\n========================================`);
console.log(`TIGHTER TRAILING STOP SIMULATION`);
console.log(`========================================`);

const trailingConfigs = [
  [3, 2],  // Very tight
  [5, 3],  // Tight
  [7, 4],  // Current
  [10, 5], // Medium
  [15, 7], // Wide
];

for (const [trigger, offset] of trailingConfigs) {
  let wins = 0;
  let losses = 0;
  let totalPnL = 0;

  for (const trade of trades) {
    const entry = trade.actualEntry;
    const hwm = trade.trailingStop.highWaterMark;
    const maxProfit = hwm - entry;

    if (maxProfit >= trigger) {
      // Trailing would have triggered
      // Assume we exit at hwm - offset (simplified)
      const exitProfit = maxProfit - offset;
      if (exitProfit > 0) {
        wins++;
        totalPnL += (exitProfit * 20) - 5;
      } else {
        // Trailing triggered but gave back too much
        losses++;
        totalPnL += (exitProfit * 20) - 5;
      }
    } else {
      // Would have hit stop loss
      losses++;
      totalPnL += (-stopLoss * 20) - 5;
    }
  }

  const winRate = wins + losses > 0 ? (wins / (wins + losses) * 100).toFixed(1) : 'N/A';
  console.log(`Trail ${trigger}/${offset}: ${wins}W/${losses}L (${winRate}%), Net P&L: $${totalPnL.toFixed(0)}, Avg: $${(totalPnL / trades.length).toFixed(2)}`);
}

// Hybrid: Fixed TP with trailing for runners
console.log(`\n========================================`);
console.log(`HYBRID: FIXED TP + TRAILING FOR RUNNERS`);
console.log(`========================================`);

const hybridConfigs = [
  { tp: 8, trailTrigger: 15, trailOffset: 5 },
  { tp: 10, trailTrigger: 20, trailOffset: 7 },
  { tp: 10, trailTrigger: 25, trailOffset: 10 },
  { tp: 12, trailTrigger: 25, trailOffset: 10 },
];

for (const config of hybridConfigs) {
  let wins = 0;
  let losses = 0;
  let totalPnL = 0;

  for (const trade of trades) {
    const entry = trade.actualEntry;
    const hwm = trade.trailingStop.highWaterMark;
    const maxProfit = hwm - entry;

    if (maxProfit >= config.trailTrigger) {
      // Runner - use trailing
      const exitProfit = maxProfit - config.trailOffset;
      wins++;
      totalPnL += (exitProfit * 20) - 5;
    } else if (maxProfit >= config.tp) {
      // Hit fixed TP
      wins++;
      totalPnL += (config.tp * 20) - 5;
    } else {
      // Hit stop
      losses++;
      totalPnL += (-stopLoss * 20) - 5;
    }
  }

  const winRate = wins + losses > 0 ? (wins / (wins + losses) * 100).toFixed(1) : 'N/A';
  console.log(`TP ${config.tp} + Trail ${config.trailTrigger}/${config.trailOffset}: ${wins}W/${losses}L (${winRate}%), Net P&L: $${totalPnL.toFixed(0)}, Avg: $${(totalPnL / trades.length).toFixed(2)}`);
}

// Best combination: Based on HWM distribution, what's optimal?
console.log(`\n========================================`);
console.log(`HWM DISTRIBUTION (for optimal TP selection)`);
console.log(`========================================`);

const hwmProfits = trades.map(t => t.trailingStop.highWaterMark - t.actualEntry);
const sorted = [...hwmProfits].sort((a, b) => a - b);

const percentiles = [25, 50, 60, 70, 75, 80, 85, 90, 95];
for (const p of percentiles) {
  const idx = Math.floor(sorted.length * p / 100);
  const value = sorted[idx];
  console.log(`  ${p}th percentile: ${value?.toFixed(1)} pts (${sorted.filter(v => v >= value).length} trades hit this)`);
}

// Optimal TP based on analysis
console.log(`\n========================================`);
console.log(`RECOMMENDATION`);
console.log(`========================================`);

// Find breakeven TP level
for (let tp = 5; tp <= 20; tp++) {
  const winCount = hwmProfits.filter(p => p >= tp).length;
  const lossCount = trades.length - winCount;
  const winPnL = winCount * (tp * 20 - 5);
  const lossPnL = lossCount * (-stopLoss * 20 - 5);
  const netPnL = winPnL + lossPnL;

  if (netPnL > 0) {
    console.log(`Breakeven TP appears to be around ${tp} pts`);
    console.log(`  At TP ${tp}: ${winCount}W/${lossCount}L, Net: $${netPnL.toFixed(0)}`);
    break;
  }
}

console.log(`\n========================================`);
console.log(`ANALYSIS COMPLETE`);
console.log(`========================================`);
