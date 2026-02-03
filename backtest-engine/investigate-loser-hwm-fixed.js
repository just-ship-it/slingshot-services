/**
 * Properly investigate why losers with 7+ pt HWM didn't trigger trailing stop
 */
import fs from 'fs';

const data = JSON.parse(fs.readFileSync('./results/regime_scalp.json', 'utf8'));
const trades = data.trades;

// Proper categorization - losers are ONLY stop_loss, not trailing_stop
const winners = trades.filter(t => t.exitReason?.toLowerCase() === 'trailing_stop');
const losers = trades.filter(t => t.exitReason?.toLowerCase() === 'stop_loss');
const marketClose = trades.filter(t => t.exitReason?.toLowerCase() === 'market_close');

console.log(`\n========================================`);
console.log(`TRADE CATEGORIZATION`);
console.log(`========================================`);
console.log(`Winners (trailing_stop): ${winners.length}`);
console.log(`Losers (stop_loss): ${losers.length}`);
console.log(`Market close: ${marketClose.length}`);

// Filter losers with HWM data
const losersWithHWM = losers.filter(t => t.trailingStop?.highWaterMark);
console.log(`\nLosers with HWM data: ${losersWithHWM.length}`);

// Calculate max profit for each loser
const loserAnalysis = losersWithHWM.map(t => {
  const entry = t.actualEntry;
  const hwm = t.trailingStop.highWaterMark;
  const maxProfit = hwm - entry;
  const trigger = t.trailingTrigger || t.signal?.trailingTrigger || 7;
  const offset = t.trailingOffset || t.signal?.trailingOffset || 4;

  return {
    id: t.id,
    entry,
    hwm,
    maxProfit,
    trailingTrigger: trigger,
    trailingOffset: offset,
    actualExit: t.actualExit,
    exitReason: t.exitReason,
    stopLoss: t.stopLoss,
    trailingStopMode: t.trailingStop?.mode,
    trailingStopTriggered: t.trailingStop?.triggered,
    currentStop: t.trailingStop?.currentStop,
    timestamp: new Date(t.timestamp).toISOString(),
    pnl: t.netPnL
  };
});

// Find losers that SHOULD have triggered trailing stop (max profit >= trigger)
const shouldHaveWon = loserAnalysis.filter(t => t.maxProfit >= t.trailingTrigger);
const wentPositive = loserAnalysis.filter(t => t.maxProfit > 0);

console.log(`\n========================================`);
console.log(`LOSER HWM ANALYSIS`);
console.log(`========================================`);
console.log(`Losers that went positive: ${wentPositive.length} / ${loserAnalysis.length} (${(wentPositive.length/loserAnalysis.length*100).toFixed(1)}%)`);
console.log(`Losers that reached trailing trigger (${loserAnalysis[0]?.trailingTrigger || 7} pts): ${shouldHaveWon.length} / ${loserAnalysis.length} (${(shouldHaveWon.length/loserAnalysis.length*100).toFixed(1)}%)`);

if (shouldHaveWon.length > 0) {
  console.log(`\n========================================`);
  console.log(`BUG IDENTIFIED: LOSERS THAT SHOULD HAVE BEEN WINNERS`);
  console.log(`========================================`);

  // Show first 10 examples
  console.log(`\nFirst 10 examples of bug:`);
  for (const t of shouldHaveWon.slice(0, 10)) {
    console.log(`\n${t.id} @ ${t.timestamp}:`);
    console.log(`  Entry: ${t.entry.toFixed(2)}, HWM: ${t.hwm.toFixed(2)}`);
    console.log(`  Max profit: ${t.maxProfit.toFixed(2)} pts (trigger was ${t.trailingTrigger})`);
    console.log(`  Trail triggered: ${t.trailingStopTriggered}, mode: ${t.trailingStopMode}`);
    console.log(`  Stop Loss set at: ${t.stopLoss.toFixed(2)}, Current stop: ${t.currentStop?.toFixed(2)}`);
    console.log(`  Actual exit: ${t.actualExit.toFixed(2)}, Reason: ${t.exitReason}`);
    console.log(`  P&L: $${t.pnl?.toFixed(2)}`);

    // If trail should have triggered, what would exit have been?
    const expectedTrailStop = t.hwm - t.trailingOffset;
    const expectedPnL = (expectedTrailStop - t.entry) * 20 - 5;
    console.log(`  >> If trailing worked: exit at ${expectedTrailStop.toFixed(2)}, P&L: $${expectedPnL.toFixed(2)}`);
  }

  // Calculate total lost profit
  let lostProfit = 0;
  for (const t of shouldHaveWon) {
    const actualPnL = t.pnl || ((t.actualExit - t.entry) * 20 - 5);
    const expectedTrailStop = t.hwm - t.trailingOffset;
    const expectedPnL = (expectedTrailStop - t.entry) * 20 - 5;
    lostProfit += (expectedPnL - actualPnL);
  }

  const avgMaxProfit = shouldHaveWon.reduce((sum, t) => sum + t.maxProfit, 0) / shouldHaveWon.length;

  console.log(`\n========================================`);
  console.log(`BUG IMPACT`);
  console.log(`========================================`);
  console.log(`Trades affected by trailing stop bug: ${shouldHaveWon.length}`);
  console.log(`Avg max profit reached before stopping: ${avgMaxProfit.toFixed(2)} pts`);
  console.log(`Estimated profit lost due to bug: $${lostProfit.toFixed(0)}`);
} else {
  console.log(`\nNo trailing stop bug detected - losers did NOT reach trigger threshold.`);

  // Show distribution of max profit for losers
  const maxProfits = loserAnalysis.map(t => t.maxProfit).sort((a, b) => a - b);
  console.log(`\nLoser max profit distribution:`);
  console.log(`  Min: ${Math.min(...maxProfits).toFixed(2)} pts`);
  console.log(`  25th: ${maxProfits[Math.floor(maxProfits.length * 0.25)]?.toFixed(2)} pts`);
  console.log(`  Median: ${maxProfits[Math.floor(maxProfits.length * 0.5)]?.toFixed(2)} pts`);
  console.log(`  75th: ${maxProfits[Math.floor(maxProfits.length * 0.75)]?.toFixed(2)} pts`);
  console.log(`  Max: ${Math.max(...maxProfits).toFixed(2)} pts`);
}

// Show HWM distribution for all losers
const allMaxProfits = loserAnalysis.map(t => t.maxProfit).sort((a, b) => a - b);
console.log(`\n========================================`);
console.log(`LOSER MAX PROFIT DISTRIBUTION`);
console.log(`========================================`);
const buckets = [-999, 0, 1, 2, 3, 4, 5, 6, 7, 10, 15, 999];
for (let i = 0; i < buckets.length - 1; i++) {
  const min = buckets[i];
  const max = buckets[i + 1];
  const count = allMaxProfits.filter(p => p > min && p <= max).length;
  const pct = (count / allMaxProfits.length * 100).toFixed(1);
  const label = max === 999 ? `${min}+` : `${min}-${max}`;
  console.log(`  ${label} pts: ${count} (${pct}%)`);
}
