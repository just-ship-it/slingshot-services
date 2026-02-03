#!/usr/bin/env node
/**
 * Profit Protection Analysis
 *
 * Goal: Prevent deep green trades from going red
 * NOT trying to save marginal losers - those should stop out fast
 *
 * Focus on losers with high MFE (50+, 75+, 100+ pts) that should have been protected
 */

import fs from 'fs';
import path from 'path';

// Load previous analysis
const trailingAnalysis = JSON.parse(fs.readFileSync('./results/trailing-stop-analysis.json', 'utf8'));

const losers = trailingAnalysis.losers;
const winners = trailingAnalysis.winners;

console.log('=' .repeat(80));
console.log('PROFIT PROTECTION ANALYSIS');
console.log('="Deep green trades should never go red"');
console.log('=' .repeat(80));

// Focus on losers with significant MFE
console.log('\n--- LOSERS THAT WENT DEEP GREEN BEFORE STOPPING OUT ---\n');

const mfeThresholds = [50, 75, 100, 150, 200];

for (const threshold of mfeThresholds) {
  const deepGreenLosers = losers.filter(t => t.mfe >= threshold);
  const totalLoss = deepGreenLosers.reduce((sum, t) => sum + t.netPnL, 0);
  const avgMfe = deepGreenLosers.reduce((sum, t) => sum + t.mfe, 0) / deepGreenLosers.length || 0;

  console.log(`MFE >= ${threshold} pts: ${deepGreenLosers.length} trades, Lost $${Math.abs(totalLoss).toLocaleString()}, Avg MFE: ${avgMfe.toFixed(0)} pts`);
}

// For high-MFE losers, what profit could we have locked in?
console.log('\n--- POTENTIAL PROFIT IF WE LOCKED IN AT X% OF MFE ---\n');

const highMfeLosers = losers.filter(t => t.mfe >= 50);
console.log(`Analyzing ${highMfeLosers.length} losers that went 50+ pts into profit\n`);

// If we had locked in profit at various percentages of MFE
const lockInPcts = [0.25, 0.33, 0.50, 0.66, 0.75];

for (const pct of lockInPcts) {
  let totalLockedProfit = 0;
  let tradesProtected = 0;

  for (const trade of highMfeLosers) {
    const lockedPts = trade.mfe * pct;
    const lockedProfit = lockedPts * 20 - 5; // $20/pt minus commission
    totalLockedProfit += lockedProfit;
    tradesProtected++;
  }

  // Compare to actual losses
  const actualLosses = highMfeLosers.reduce((sum, t) => sum + t.netPnL, 0);
  const swing = totalLockedProfit - actualLosses;

  console.log(`Lock in ${(pct * 100).toFixed(0)}% of MFE:`);
  console.log(`  Would have captured: $${totalLockedProfit.toLocaleString()} (instead of losing $${Math.abs(actualLosses).toLocaleString()})`);
  console.log(`  Total swing: +$${swing.toLocaleString()}\n`);
}

// Now check impact on winners
console.log('=' .repeat(80));
console.log('IMPACT ON WINNERS');
console.log('=' .repeat(80));

// For each winner, would a profit protection stop have hurt it?
// A winner gets hurt if: it went X pts in profit, pulled back, then eventually hit target
// If our trailing stop would have stopped it during the pullback, we lose target profit

console.log('\nSimulating profit protection: "Once trade reaches X pts profit, trail stop at Y pts behind"');
console.log('(Only activates after significant profit, not at entry)\n');

function simulateProfitProtection(activationPts, trailPts) {
  // For losers with MFE >= activationPts:
  // We would have exited at (MFE - trailPts) instead of full stop loss
  let loserProfitCaptured = 0;
  let losersProtected = 0;

  for (const trade of losers) {
    if (trade.mfe >= activationPts) {
      // Would have trailed and exited at MFE - trailPts
      const exitPts = Math.max(0, trade.mfe - trailPts); // Can't be negative
      const exitProfit = exitPts * 20 - 5;
      const swing = exitProfit - trade.netPnL; // How much better vs actual loss
      loserProfitCaptured += swing;
      losersProtected++;
    }
  }

  // For winners: would we have stopped out early?
  // This happens if: MAE from peak > trailPts
  // Approximation: winner "survives" if their natural pullback < trailPts
  // Or if they reached target before pulling back trailPts

  let winnersHurt = 0;
  let winnerProfitLost = 0;

  for (const trade of winners) {
    if (trade.mfe >= activationPts) {
      // Trail would have activated
      // Would it have stopped us out before target?

      // The winner's actual profit pts
      const actualProfitPts = trade.targetDistance; // They hit target

      // If MFE was higher than target, there was overshoot then pullback to target
      // If MFE equals target, clean hit
      // The question: did price pull back more than trailPts before hitting target?

      // Estimate: if (MFE - actualProfitPts) > some threshold, there was overshoot
      // If trade.mae (max adverse from entry) > 0, there was early drawdown

      // Conservative: assume if MFE > target + trailPts, we might have been stopped
      // at MFE - trailPts (which could still be profitable)

      if (trade.mfe > trade.targetDistance + trailPts) {
        // We would have been stopped at MFE - trailPts instead of target
        const stoppedAtPts = trade.mfe - trailPts;
        if (stoppedAtPts < trade.targetDistance) {
          // Stopped before reaching full target profit
          const lostPts = trade.targetDistance - stoppedAtPts;
          const lostProfit = lostPts * 20;
          winnersHurt++;
          winnerProfitLost += lostProfit;
        }
        // If stoppedAtPts >= targetDistance, we actually captured MORE than target
      }
    }
  }

  return {
    activationPts,
    trailPts,
    losersProtected,
    loserProfitCaptured,
    winnersHurt,
    winnerProfitLost,
    netImpact: loserProfitCaptured - winnerProfitLost
  };
}

// Test various profit protection configurations
// Key: activation should be HIGH (only protect real winners)
// Trail should give room but not too much

const configs = [
  // High activation thresholds - only protect clearly winning trades
  { activation: 30, trail: 15 },
  { activation: 40, trail: 20 },
  { activation: 50, trail: 20 },
  { activation: 50, trail: 25 },
  { activation: 75, trail: 25 },
  { activation: 75, trail: 30 },
  { activation: 100, trail: 30 },
  { activation: 100, trail: 40 },
  { activation: 100, trail: 50 },
  { activation: 150, trail: 50 },
];

console.log('Activation'.padEnd(12) + 'Trail'.padEnd(10) + 'Losers'.padEnd(10) + 'Profit Saved'.padEnd(14) +
            'Winners Hurt'.padEnd(14) + 'Net Impact');
console.log('-'.repeat(80));

const results = [];
for (const config of configs) {
  const result = simulateProfitProtection(config.activation, config.trail);
  results.push(result);

  console.log(
    `${result.activationPts} pts`.padEnd(12) +
    `${result.trailPts} pts`.padEnd(10) +
    `${result.losersProtected}`.padEnd(10) +
    `+$${result.loserProfitCaptured.toLocaleString()}`.padEnd(14) +
    `${result.winnersHurt} (-$${result.winnerProfitLost.toLocaleString()})`.padEnd(14) +
    `${result.netImpact >= 0 ? '+' : ''}$${result.netImpact.toLocaleString()}`
  );
}

// Find best
const bestConfig = results.reduce((best, curr) =>
  curr.netImpact > best.netImpact ? curr : best
);

console.log(`\nBest config: Activate at ${bestConfig.activationPts}pts, Trail at ${bestConfig.trailPts}pts`);
console.log(`  Net improvement: +$${bestConfig.netImpact.toLocaleString()}`);

// Detailed look at the egregious cases
console.log('\n' + '=' .repeat(80));
console.log('EGREGIOUS CASES: Trades that went 100+ pts green then stopped out');
console.log('=' .repeat(80) + '\n');

const egregiousCases = losers
  .filter(t => t.mfe >= 100)
  .sort((a, b) => b.mfe - a.mfe);

console.log(`Found ${egregiousCases.length} trades that went 100+ pts into profit then lost\n`);

console.log('Date'.padEnd(12) + 'Side'.padEnd(6) + 'MFE'.padEnd(12) + 'Target'.padEnd(12) +
            'Stop'.padEnd(10) + 'Loss'.padEnd(10) + 'Should Have');
console.log('-'.repeat(80));

for (const trade of egregiousCases) {
  // What we should have captured with reasonable profit protection
  const shouldHaveCaptured = Math.max(0, trade.mfe - 30) * 20 - 5; // 30pt trail

  console.log(
    trade.date.padEnd(12) +
    trade.side.toUpperCase().padEnd(6) +
    `${trade.mfe.toFixed(0)} pts`.padEnd(12) +
    `${trade.targetDistance.toFixed(0)} pts`.padEnd(12) +
    `${trade.stopDistance.toFixed(0)} pts`.padEnd(10) +
    `$${trade.netPnL}`.padEnd(10) +
    `+$${shouldHaveCaptured.toLocaleString()}`
  );
}

const totalEgregiousLoss = egregiousCases.reduce((sum, t) => sum + t.netPnL, 0);
const totalShouldHave = egregiousCases.reduce((sum, t) => sum + (Math.max(0, t.mfe - 30) * 20 - 5), 0);
console.log('-'.repeat(80));
console.log(`Total: Lost $${Math.abs(totalEgregiousLoss).toLocaleString()}, Should have captured: +$${totalShouldHave.toLocaleString()}`);
console.log(`Swing: +$${(totalShouldHave - totalEgregiousLoss).toLocaleString()}`);

// Summary recommendation
console.log('\n' + '=' .repeat(80));
console.log('RECOMMENDATION');
console.log('=' .repeat(80));

console.log(`
Profit Protection Strategy:

1. DO NOT use trailing stops at entry (hurts winners too much)

2. ACTIVATE profit protection after trade goes ${bestConfig.activationPts}+ pts in profit
   - Trail stop at ${bestConfig.trailPts} pts behind highest profit reached
   - This only protects trades that are clearly working

3. Expected improvement: +$${bestConfig.netImpact.toLocaleString()} over the backtest period
   - Protects ${bestConfig.losersProtected} trades from going red
   - Minimal impact on winners

4. The ${egregiousCases.length} egregious cases (100+ pts green then stopped):
   - Currently losing $${Math.abs(totalEgregiousLoss).toLocaleString()}
   - Could capture +$${totalShouldHave.toLocaleString()}
   - Swing of +$${(totalShouldHave - totalEgregiousLoss).toLocaleString()}
`);

// Save results
fs.writeFileSync('./results/profit-protection-analysis.json', JSON.stringify({
  simulations: results,
  bestConfig,
  egregiousCases,
  summary: {
    totalLosers: losers.length,
    totalWinners: winners.length,
    highMfeLosers: highMfeLosers.length,
    egregiousCases: egregiousCases.length
  }
}, null, 2));

console.log('Analysis saved to ./results/profit-protection-analysis.json');
