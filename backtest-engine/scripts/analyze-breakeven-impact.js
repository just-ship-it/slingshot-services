#!/usr/bin/env node
/**
 * Analyze if breakeven stop would help capture profits from losing trades
 * that likely went profitable before returning to a loss
 */

import fs from 'fs';
import path from 'path';

const resultsPath = process.argv[2] || 'results/iv-skew-gex-2025.json';
const data = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), resultsPath), 'utf8'));

const trades = data.trades.filter(t => t.status === 'completed');
const losers = trades.filter(t => t.netPnL < 0);
const winners = trades.filter(t => t.netPnL > 0);

console.log('='.repeat(80));
console.log('BREAKEVEN STOP IMPACT ANALYSIS');
console.log('='.repeat(80));

// The strategy params show current settings
const config = data.config.strategyParams;
console.log('\nCurrent Strategy Parameters:');
console.log(`  Stop Loss: ${config.stopLossPoints} points`);
console.log(`  Take Profit: ${config.takeProfitPoints} points`);
console.log(`  Max Hold Bars: ${config.maxHoldBars}`);
console.log(`  Breakeven Enabled: ${config.breakevenStop}`);
console.log(`  Breakeven Trigger: ${config.breakevenTrigger} points`);

// Max hold time losers with small losses - likely went profitable
const maxHoldLosers = losers.filter(t => t.exitReason === 'max_hold_time');
const smallLossMHT = maxHoldLosers.filter(t => t.netPnL > -500);

console.log(`\n${'='.repeat(80)}`);
console.log('MAX_HOLD_TIME LOSERS ANALYSIS');
console.log(`${'='.repeat(80)}`);
console.log(`\nTotal max_hold losers: ${maxHoldLosers.length}`);
console.log(`Small loss (<$500): ${smallLossMHT.length}`);
console.log(`Medium loss ($500-$1000): ${maxHoldLosers.filter(t => t.netPnL <= -500 && t.netPnL > -1000).length}`);
console.log(`Large loss (>$1000): ${maxHoldLosers.filter(t => t.netPnL <= -1000).length}`);

// For small losses, estimate MFE (max favorable excursion)
// If a trade entered at X and exited at X-Y (small loss), and had 70pt stop,
// and 60 bars to work with, it likely saw SOME profit before returning
console.log('\n--- Small Loss Trades (likely went profitable) ---');
console.log('These trades held for 60 bars without hitting stop (70pts) but ended negative');
console.log('High probability they were profitable at some point\n');

let estimatedRecoverable = 0;
smallLossMHT.forEach(t => {
  const lossPoints = t.side === 'long'
    ? t.actualEntry - t.actualExit
    : t.actualExit - t.actualEntry;

  // If loss is small (say <25 points), trade likely reached +25 at some point
  // before returning. A breakeven stop at +25 would have saved this.
  const couldHaveBroken = lossPoints < 25;
  if (couldHaveBroken) {
    estimatedRecoverable += Math.abs(t.netPnL);
  }

  console.log(`  ${new Date(t.entryTime).toISOString().split('T')[0]} ${t.side} @ ${t.signal.levelType}: Loss ${lossPoints.toFixed(1)}pts ($${t.netPnL.toFixed(0)}) ${couldHaveBroken ? '← BREAKEVEN CANDIDATE' : ''}`);
});

const breakEvenCandidates = smallLossMHT.filter(t => {
  const lossPoints = t.side === 'long'
    ? t.actualEntry - t.actualExit
    : t.actualExit - t.actualEntry;
  return lossPoints < 25;
});

console.log(`\nBreakeven candidates (loss < 25 pts): ${breakEvenCandidates.length}`);
console.log(`Estimated recoverable losses: $${breakEvenCandidates.reduce((s,t) => s + Math.abs(t.netPnL), 0).toFixed(0)}`);

// Now analyze the stop_loss losers
console.log(`\n${'='.repeat(80)}`);
console.log('STOP_LOSS EXITS - DID THEY EVER GO PROFITABLE?');
console.log(`${'='.repeat(80)}`);

const stopLossTrades = losers.filter(t => t.exitReason === 'stop_loss');
console.log(`\nTotal stop_loss exits: ${stopLossTrades.length}`);

// Trades that took a long time to hit stop (30+ bars) may have been profitable first
const slowStops = stopLossTrades.filter(t => t.barsSinceEntry >= 30);
const fastStops = stopLossTrades.filter(t => t.barsSinceEntry < 5);
const mediumStops = stopLossTrades.filter(t => t.barsSinceEntry >= 5 && t.barsSinceEntry < 30);

console.log(`\nFast stops (<5 bars): ${fastStops.length} - Likely immediate reversals, no breakeven help`);
console.log(`Medium stops (5-30 bars): ${mediumStops.length} - May or may not have gone profitable`);
console.log(`Slow stops (30+ bars): ${slowStops.length} - Likely went profitable before reversal`);

console.log('\nSlow stop losses (30+ bars) - high chance they saw profit:');
slowStops.forEach(t => {
  console.log(`  ${new Date(t.entryTime).toISOString().split('T')[0]} ${t.side} @ ${t.signal.levelType}: ${t.barsSinceEntry} bars until stop`);
});

// Estimate total impact of breakeven stop at various trigger levels
console.log(`\n${'='.repeat(80)}`);
console.log('BREAKEVEN TRIGGER LEVEL ANALYSIS');
console.log(`${'='.repeat(80)}`);

// We can't know exactly when a trade hit various profit levels,
// but we can estimate based on the exit data we have

console.log('\nEstimating impact of breakeven stop at various trigger levels:');
console.log('(Assumption: trades that held 30+ bars and lost likely saw at least 25pts profit)\n');

// Conservative estimate: only count max_hold_time losers with small losses
// and slow stop_loss losers as "would have been saved"
const conservativeSaveable = [
  ...breakEvenCandidates,  // max_hold small losses
  ...slowStops.filter(t => t.barsSinceEntry >= 40)  // very slow stops
];

console.log(`Conservative estimate of trades a breakeven stop would save: ${conservativeSaveable.length}`);
console.log(`Potential P&L improvement: $${conservativeSaveable.reduce((s,t) => s + Math.abs(t.netPnL), 0).toFixed(0)}`);

// But we'd also potentially hurt some winners if they pulled back through breakeven
// before hitting target. Let's look at winner behavior.
console.log(`\n${'='.repeat(80)}`);
console.log('POTENTIAL NEGATIVE IMPACT ON WINNERS');
console.log(`${'='.repeat(80)}`);

// Winners that took a long time might have pulled back significantly
const slowWinners = winners.filter(t => t.barsSinceEntry >= 40);
console.log(`\nWinners that took 40+ bars: ${slowWinners.length}`);
console.log('These might have pulled back through a breakeven stop before winning.\n');

// Winners that exited via max_hold_time (didn't hit target)
const maxHoldWinners = winners.filter(t => t.exitReason === 'max_hold_time');
console.log(`Winners via max_hold_time: ${maxHoldWinners.length}`);
console.log('Average P&L:', (maxHoldWinners.reduce((s,t) => s + t.netPnL, 0) / maxHoldWinners.length).toFixed(0));

// If a winner exited via max_hold with small profit, it probably pulled back
const smallProfitMHT = maxHoldWinners.filter(t => t.netPnL < 500);
console.log(`Winners via max_hold with small profit (<$500): ${smallProfitMHT.length}`);

// These would likely be hurt by a tight breakeven stop
console.log('\nThese slow/small winners might be hurt by breakeven:');
smallProfitMHT.forEach(t => {
  console.log(`  ${new Date(t.entryTime).toISOString().split('T')[0]} ${t.side} @ ${t.signal.levelType}: $${t.netPnL.toFixed(0)}, ${t.barsSinceEntry} bars`);
});

// NET IMPACT CALCULATION
console.log(`\n${'='.repeat(80)}`);
console.log('NET IMPACT ESTIMATE');
console.log(`${'='.repeat(80)}`);

const potentialSavings = conservativeSaveable.reduce((s,t) => s + Math.abs(t.netPnL), 0);
const potentialLosses = smallProfitMHT.reduce((s,t) => s + t.netPnL, 0);  // These would become $0 instead of +profit

console.log(`\nPotential savings (losers → breakeven): $${potentialSavings.toFixed(0)}`);
console.log(`Potential losses (small winners → breakeven): $${potentialLosses.toFixed(0)}`);
console.log(`NET ESTIMATED IMPACT: $${(potentialSavings - potentialLosses).toFixed(0)}`);

// TRAILING STOP ANALYSIS
console.log(`\n${'='.repeat(80)}`);
console.log('TRAILING STOP ANALYSIS');
console.log(`${'='.repeat(80)}`);

// Current config doesn't mention trailing stop settings
// Let's see if there's evidence for it

// Take profit winners - these hit the 70pt target
const tpWinners = winners.filter(t => t.exitReason === 'take_profit');
console.log(`\nTake profit winners: ${tpWinners.length}`);
console.log(`Average bars to target: ${(tpWinners.reduce((s,t) => s + t.barsSinceEntry, 0) / tpWinners.length).toFixed(1)}`);

// These are the "clean" winners - reached target efficiently
// A trailing stop wouldn't help these much unless market went WAY past target

// The question is: would a trailing stop help max_hold_time losers?
// If they went +25pts then returned to -20pts, a trailing stop at +25 → 15pt trail
// would have exited around +10pts instead of -20pts

console.log(`\n${'='.repeat(80)}`);
console.log('HYBRID TRAILING STOP RECOMMENDATION');
console.log(`${'='.repeat(80)}`);

console.log(`
RECOMMENDED: Breakeven stop at +25 points, then trail at 15 points

Rationale:
1. ${breakEvenCandidates.length} max_hold losers had small losses (<25pts)
   → Likely went +25pts before returning
   → Would have exited breakeven instead of loss

2. ${slowStops.length} stop-loss trades took 30+ bars
   → Likely went profitable before reversing
   → Would have exited breakeven or small profit

3. Risk: ${smallProfitMHT.length} small-profit winners might be stopped out earlier
   → But they already have small profits, so impact is limited

ESTIMATED NET BENEFIT: $${(potentialSavings - potentialLosses).toFixed(0)} improvement
`);

// HOUR 19 + BREAKEVEN COMBINED
console.log(`\n${'='.repeat(80)}`);
console.log('COMBINED FILTER: HOUR 19 CUTOFF + BREAKEVEN STOP');
console.log(`${'='.repeat(80)}`);

// Trades before hour 19 with estimated breakeven improvement
const beforeH19 = trades.filter(t => new Date(t.entryTime).getUTCHours() < 19);
const beforeH19Winners = beforeH19.filter(t => t.netPnL > 0);
const beforeH19Losers = beforeH19.filter(t => t.netPnL < 0);
const currentPnL = beforeH19.reduce((s,t) => s + t.netPnL, 0);

// Estimate losers that would be saved by breakeven (within before-H19 set)
const h19BreakevenCandidates = breakEvenCandidates.filter(t => new Date(t.entryTime).getUTCHours() < 19);
const h19SlowStops = slowStops.filter(t => new Date(t.entryTime).getUTCHours() < 19 && t.barsSinceEntry >= 40);

console.log(`
If we combine Hour 19 cutoff with breakeven stop:

Current results (Hour 19 cutoff only):
  Trades: ${beforeH19.length}
  Winners: ${beforeH19Winners.length}, Losers: ${beforeH19Losers.length}
  Win Rate: ${(beforeH19Winners.length/beforeH19.length*100).toFixed(1)}%
  Total P&L: $${currentPnL.toFixed(0)}

Estimated additional improvement from breakeven:
  Breakeven candidates in pre-H19: ${h19BreakevenCandidates.length}
  Slow stop candidates in pre-H19: ${h19SlowStops.length}
  Estimated additional P&L: $${(h19BreakevenCandidates.reduce((s,t) => s + Math.abs(t.netPnL), 0) + h19SlowStops.reduce((s,t) => s + Math.abs(t.netPnL), 0)).toFixed(0)}

COMBINED ESTIMATED P&L: $${(currentPnL + h19BreakevenCandidates.reduce((s,t) => s + Math.abs(t.netPnL), 0) + h19SlowStops.reduce((s,t) => s + Math.abs(t.netPnL), 0) * 0.5).toFixed(0)}
(Assumes 50% of slow stops would have been saved)
`);
