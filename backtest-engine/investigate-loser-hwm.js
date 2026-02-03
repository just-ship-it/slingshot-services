/**
 * Investigate why losers with 7+ pt HWM didn't trigger trailing stop
 */
import fs from 'fs';

const data = JSON.parse(fs.readFileSync('./results/regime_scalp.json', 'utf8'));
const trades = data.trades;

// Find losers (stop_loss exits)
const losers = trades.filter(t => t.exitReason?.toLowerCase().includes('stop'));

console.log(`\n========================================`);
console.log(`INVESTIGATING LOSER HWM vs TRAILING TRIGGER`);
console.log(`========================================`);
console.log(`Total losers: ${losers.length}`);

// Filter losers with HWM data
const losersWithHWM = losers.filter(t => t.trailingStop?.highWaterMark);
console.log(`Losers with HWM data: ${losersWithHWM.length}`);

// Calculate max profit for each loser
const loserMaxProfits = losersWithHWM.map(t => {
  const entry = t.actualEntry;
  const hwm = t.trailingStop.highWaterMark;
  return {
    id: t.id,
    entry,
    hwm,
    maxProfit: hwm - entry,
    trailingTrigger: t.trailingTrigger || t.signal?.trailingTrigger || 7,
    trailingOffset: t.trailingOffset || t.signal?.trailingOffset || 4,
    actualExit: t.actualExit,
    exitReason: t.exitReason,
    stopLoss: t.stopLoss,
    trailingStopMode: t.trailingStop?.mode,
    trailingStopTriggered: t.trailingStop?.triggered,
    currentStop: t.trailingStop?.currentStop,
    timestamp: new Date(t.timestamp).toISOString()
  };
});

// Find losers that SHOULD have triggered trailing stop (max profit >= trigger)
const shouldHaveWon = loserMaxProfits.filter(t => t.maxProfit >= t.trailingTrigger);
console.log(`\nLosers that reached trailing trigger threshold: ${shouldHaveWon.length}`);

if (shouldHaveWon.length > 0) {
  console.log(`\n========================================`);
  console.log(`LOSERS THAT SHOULD HAVE TRIGGERED TRAILING STOP`);
  console.log(`========================================`);
  
  // Show first 20 examples
  console.log(`\nFirst 20 examples:`);
  for (const t of shouldHaveWon.slice(0, 20)) {
    console.log(`\n${t.id} @ ${t.timestamp}:`);
    console.log(`  Entry: ${t.entry.toFixed(2)}, HWM: ${t.hwm.toFixed(2)}`);
    console.log(`  Max profit: ${t.maxProfit.toFixed(2)} pts (trigger was ${t.trailingTrigger})`);
    console.log(`  Trail triggered: ${t.trailingStopTriggered}, mode: ${t.trailingStopMode}`);
    console.log(`  Stop: ${t.stopLoss.toFixed(2)}, Current stop: ${t.currentStop?.toFixed(2)}`);
    console.log(`  Exit: ${t.actualExit.toFixed(2)}, Reason: ${t.exitReason}`);
    
    // If trail should have triggered at entry + 7, trailing stop at HWM - 4
    const expectedTrailStop = t.hwm - t.trailingOffset;
    const wouldHaveExitedAt = expectedTrailStop;
    console.log(`  >> Expected trail stop if triggered: ${wouldHaveExitedAt.toFixed(2)}`);
    console.log(`  >> Diff from actual exit: ${(wouldHaveExitedAt - t.actualExit).toFixed(2)} pts`);
  }
  
  // Summary stats
  const avgMaxProfit = shouldHaveWon.reduce((sum, t) => sum + t.maxProfit, 0) / shouldHaveWon.length;
  const maxMaxProfit = Math.max(...shouldHaveWon.map(t => t.maxProfit));
  console.log(`\n========================================`);
  console.log(`SUMMARY`);
  console.log(`========================================`);
  console.log(`Losers that should have triggered trailing: ${shouldHaveWon.length} / ${losersWithHWM.length} (${(shouldHaveWon.length/losersWithHWM.length*100).toFixed(1)}%)`);
  console.log(`Avg max profit before stopping: ${avgMaxProfit.toFixed(2)} pts`);
  console.log(`Max profit before stopping: ${maxMaxProfit.toFixed(2)} pts`);
  
  // Check how many had trail triggered but still stopped
  const trailTriggeredButStopped = shouldHaveWon.filter(t => t.trailingStopTriggered);
  console.log(`\nTrail triggered but still stopped: ${trailTriggeredButStopped.length}`);
  
  // Check how many had trail mode still "fixed" 
  const modeStillFixed = shouldHaveWon.filter(t => t.trailingStopMode === 'fixed');
  console.log(`Trail mode still "fixed": ${modeStillFixed.length}`);
  
  // Check if HWM equals entry (meaning no actual move up)
  const hwmEqualsEntry = shouldHaveWon.filter(t => t.hwm === t.entry);
  console.log(`HWM equals entry (bug?): ${hwmEqualsEntry.length}`);
  
  // Check potential lost profit
  let lostProfit = 0;
  for (const t of shouldHaveWon) {
    const actualPnL = (t.actualExit - t.entry) * 20 - 5;
    const expectedTrailStop = t.hwm - t.trailingOffset;
    const expectedPnL = (expectedTrailStop - t.entry) * 20 - 5;
    lostProfit += (expectedPnL - actualPnL);
  }
  console.log(`\nEstimated lost profit due to trailing stop bug: $${lostProfit.toFixed(0)}`);
}
