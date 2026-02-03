#!/usr/bin/env node
/**
 * Analyze if trailing stops would have helped losing trades
 *
 * For each trade (winners and losers), we calculate:
 * - MFE (Maximum Favorable Excursion): How far into profit before reversal
 * - MAE (Maximum Adverse Excursion): How far into loss before recovery
 *
 * Then simulate various trailing stop strategies to see:
 * 1. How many losers would have been saved (exited at breakeven or small profit)
 * 2. How many winners would have been hurt (stopped out before target)
 */

import fs from 'fs';
import path from 'path';

// Load the backtest results
const resultsPath = './results/gex-pullback-optimized.json';
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

// Load candle data
const dataDir = './data';
console.log('Loading candle data from CSV...');
const candles = [];

const csvPath = path.join(dataDir, 'ohlcv', 'NQ_ohlcv_1m.csv');
const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.split('\n');
const header = lines[0].split(',');

const tsIdx = header.indexOf('ts_event');
const openIdx = header.indexOf('open');
const highIdx = header.indexOf('high');
const lowIdx = header.indexOf('low');
const closeIdx = header.indexOf('close');

for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(',');
  if (cols.length < 5) continue;

  const tsString = cols[tsIdx];
  const ts = new Date(tsString).getTime();
  if (isNaN(ts)) continue;

  candles.push({
    ts,
    open: parseFloat(cols[openIdx]),
    high: parseFloat(cols[highIdx]),
    low: parseFloat(cols[lowIdx]),
    close: parseFloat(cols[closeIdx])
  });
}

// Sort by timestamp
candles.sort((a, b) => a.ts - b.ts);
console.log(`Loaded ${candles.length} candles\n`);

// Binary search helper
function findCandleIndex(timestamp) {
  let left = 0, right = candles.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (candles[mid].ts < timestamp) left = mid + 1;
    else right = mid;
  }
  return left;
}

// Analyze MFE/MAE for each trade
function analyzeTrade(trade) {
  const entryTime = trade.entryTime;
  const exitTime = trade.exitTime;
  const side = trade.side;
  const entryPrice = trade.actualEntry;
  const stopLoss = trade.stopLoss;
  const takeProfit = trade.takeProfit;

  // Find candles during the trade
  const startIdx = findCandleIndex(entryTime);
  const endIdx = findCandleIndex(exitTime);

  // Price range filter (within 5% of entry to avoid wrong contracts)
  const priceMin = entryPrice * 0.95;
  const priceMax = entryPrice * 1.05;

  let mfe = 0;  // Maximum Favorable Excursion (points in our favor)
  let mae = 0;  // Maximum Adverse Excursion (points against us)
  let mfeTime = entryTime;
  let runningHigh = entryPrice;
  let runningLow = entryPrice;

  for (let i = startIdx; i <= endIdx && i < candles.length; i++) {
    const candle = candles[i];
    if (candle.ts > exitTime) break;
    if (candle.close < priceMin || candle.close > priceMax) continue;

    if (side === 'buy') {
      // For longs: high is favorable, low is adverse
      if (candle.high > runningHigh) {
        runningHigh = candle.high;
        const currentMfe = runningHigh - entryPrice;
        if (currentMfe > mfe) {
          mfe = currentMfe;
          mfeTime = candle.ts;
        }
      }
      if (candle.low < runningLow) {
        runningLow = candle.low;
        mae = Math.max(mae, entryPrice - runningLow);
      }
    } else {
      // For shorts: low is favorable, high is adverse
      if (candle.low < runningLow) {
        runningLow = candle.low;
        const currentMfe = entryPrice - runningLow;
        if (currentMfe > mfe) {
          mfe = currentMfe;
          mfeTime = candle.ts;
        }
      }
      if (candle.high > runningHigh) {
        runningHigh = candle.high;
        mae = Math.max(mae, candle.high - entryPrice);
      }
    }
  }

  return {
    ...trade,
    mfe: mfe,
    mae: mae,
    mfeTime: mfeTime,
    minutesToMfe: (mfeTime - entryTime) / (1000 * 60),
    targetDistance: Math.abs(takeProfit - entryPrice),
    stopDistance: Math.abs(entryPrice - stopLoss)
  };
}

// Analyze all trades
console.log('Analyzing MFE/MAE for all trades...\n');
const analyzedTrades = results.trades.map(analyzeTrade);

const winners = analyzedTrades.filter(t => t.exitReason === 'take_profit');
const losers = analyzedTrades.filter(t => t.exitReason === 'stop_loss');

console.log('=' .repeat(80));
console.log('MAXIMUM FAVORABLE EXCURSION (MFE) ANALYSIS');
console.log('=' .repeat(80));

// Analyze losers' MFE
console.log(`\n--- LOSING TRADES (${losers.length} trades) ---`);
console.log('How far into profit did losing trades go before reversing?\n');

const mfeBuckets = {
  '0-5 pts (straight losers)': [],
  '5-10 pts': [],
  '10-20 pts': [],
  '20-30 pts': [],
  '30-50 pts': [],
  '50+ pts': []
};

for (const trade of losers) {
  if (trade.mfe < 5) mfeBuckets['0-5 pts (straight losers)'].push(trade);
  else if (trade.mfe < 10) mfeBuckets['5-10 pts'].push(trade);
  else if (trade.mfe < 20) mfeBuckets['10-20 pts'].push(trade);
  else if (trade.mfe < 30) mfeBuckets['20-30 pts'].push(trade);
  else if (trade.mfe < 50) mfeBuckets['30-50 pts'].push(trade);
  else mfeBuckets['50+ pts'].push(trade);
}

for (const [bucket, trades] of Object.entries(mfeBuckets)) {
  const totalLoss = trades.reduce((sum, t) => sum + t.netPnL, 0);
  console.log(`${bucket.padEnd(30)} ${trades.length.toString().padStart(3)} trades  Loss: $${totalLoss.toLocaleString()}`);
}

const avgMfe = losers.reduce((sum, t) => sum + t.mfe, 0) / losers.length;
const maxMfe = Math.max(...losers.map(t => t.mfe));
console.log(`\nAvg MFE of losers: ${avgMfe.toFixed(1)} pts`);
console.log(`Max MFE of losers: ${maxMfe.toFixed(1)} pts`);

// Analyze winners' MFE and MAE (to understand trailing stop risk)
console.log(`\n--- WINNING TRADES (${winners.length} trades) ---`);
console.log('How much drawdown did winning trades experience before hitting target?\n');

const winnerMaeBuckets = {
  '0-5 pts (clean winners)': [],
  '5-10 pts': [],
  '10-20 pts': [],
  '20-30 pts': [],
  '30-50 pts': [],
  '50+ pts': []
};

for (const trade of winners) {
  if (trade.mae < 5) winnerMaeBuckets['0-5 pts (clean winners)'].push(trade);
  else if (trade.mae < 10) winnerMaeBuckets['5-10 pts'].push(trade);
  else if (trade.mae < 20) winnerMaeBuckets['10-20 pts'].push(trade);
  else if (trade.mae < 30) winnerMaeBuckets['20-30 pts'].push(trade);
  else if (trade.mae < 50) winnerMaeBuckets['30-50 pts'].push(trade);
  else winnerMaeBuckets['50+ pts'].push(trade);
}

for (const [bucket, trades] of Object.entries(winnerMaeBuckets)) {
  const totalProfit = trades.reduce((sum, t) => sum + t.netPnL, 0);
  console.log(`${bucket.padEnd(30)} ${trades.length.toString().padStart(3)} trades  Profit: $${totalProfit.toLocaleString()}`);
}

const avgWinnerMae = winners.reduce((sum, t) => sum + t.mae, 0) / winners.length;
console.log(`\nAvg MAE of winners: ${avgWinnerMae.toFixed(1)} pts (drawdown before profit)`);

// Simulate trailing stop strategies
console.log('\n' + '=' .repeat(80));
console.log('TRAILING STOP SIMULATION');
console.log('=' .repeat(80));

console.log('\nSimulating: "Move stop to breakeven when trade reaches X points profit"');
console.log('Then trail at Y points behind price\n');

// For each trailing strategy, calculate:
// - Losers saved (would have exited at breakeven instead of full stop)
// - Winners hurt (would have been stopped out before target)
function simulateTrailingStop(triggerPoints, trailOffset) {
  let losersSaved = 0;
  let losersSavedPnL = 0;  // Saved loss (negative of what they lost)
  let winnersHurt = 0;
  let winnersLostPnL = 0;  // Profit we would have missed

  for (const trade of losers) {
    // If MFE reached trigger, we would have moved stop to breakeven
    if (trade.mfe >= triggerPoints) {
      // Trade would have been stopped at breakeven (or trigger - trailOffset)
      const exitPrice = trade.actualEntry + (trade.side === 'buy' ? (triggerPoints - trailOffset) : -(triggerPoints - trailOffset));
      const savedAmount = -trade.netPnL;  // What we saved by not taking full loss
      losersSaved++;
      losersSavedPnL += savedAmount;
    }
  }

  for (const trade of winners) {
    // Check if the trade would have been stopped out by trailing
    // This happens if MAE from peak > trailOffset before reaching target
    // Simplified: if trade went to MFE but then pulled back more than trailOffset before target

    // For winners, they eventually hit target. But would trailing have stopped them?
    // We need to check if at any point after reaching trigger, the pullback exceeded trailOffset

    // Approximation: if winner's MAE > (MFE - trailOffset), it might have been stopped
    // More accurate: check if after reaching trigger, price pulled back more than trailOffset

    if (trade.mfe >= triggerPoints) {
      // Trade would have engaged trailing stop
      // If the trade pulled back more than trailOffset from its peak, it would stop out
      // Since MAE is max adverse from entry, not from peak, we need to estimate

      // For a winner that went to MFE then target:
      // If (MFE - target profit realized) > 0, there was pullback
      // Simpler: if MAE happened AFTER MFE, the pullback was MAE

      // Conservative estimate: assume pullback = MFE - actual profit points
      const actualProfitPts = Math.abs(trade.actualExit - trade.actualEntry);
      const pullbackFromPeak = trade.mfe - actualProfitPts;

      if (pullbackFromPeak > trailOffset) {
        // Would have been stopped out
        winnersHurt++;
        // Lost the profit we would have made
        winnersLostPnL += trade.netPnL;
      }
    }
  }

  return {
    triggerPoints,
    trailOffset,
    losersSaved,
    losersSavedPnL,
    winnersHurt,
    winnersLostPnL,
    netImpact: losersSavedPnL - winnersLostPnL
  };
}

// Test various trailing stop configurations
const configs = [
  { trigger: 10, trail: 5 },
  { trigger: 10, trail: 8 },
  { trigger: 15, trail: 8 },
  { trigger: 15, trail: 10 },
  { trigger: 20, trail: 10 },
  { trigger: 20, trail: 12 },
  { trigger: 25, trail: 12 },
  { trigger: 25, trail: 15 },
  { trigger: 30, trail: 15 },
  { trigger: 30, trail: 20 },
];

console.log('Trigger'.padEnd(10) + 'Trail'.padEnd(8) + 'Losers'.padEnd(10) + 'Saved $'.padEnd(12) +
            'Winners'.padEnd(10) + 'Lost $'.padEnd(12) + 'Net Impact');
console.log('-'.repeat(80));

const simResults = [];
for (const config of configs) {
  const result = simulateTrailingStop(config.trigger, config.trail);
  simResults.push(result);

  console.log(
    `${result.triggerPoints} pts`.padEnd(10) +
    `${result.trailOffset} pts`.padEnd(8) +
    `${result.losersSaved}`.padEnd(10) +
    `$${result.losersSavedPnL.toLocaleString()}`.padEnd(12) +
    `${result.winnersHurt}`.padEnd(10) +
    `$${result.winnersLostPnL.toLocaleString()}`.padEnd(12) +
    `${result.netImpact >= 0 ? '+' : ''}$${result.netImpact.toLocaleString()}`
  );
}

// Find best configuration
const bestConfig = simResults.reduce((best, curr) =>
  curr.netImpact > best.netImpact ? curr : best
);

console.log(`\nBest configuration: Trigger at ${bestConfig.triggerPoints}pts, Trail at ${bestConfig.trailOffset}pts`);
console.log(`  Net improvement: $${bestConfig.netImpact.toLocaleString()}`);

// Detailed analysis of losers with high MFE
console.log('\n' + '=' .repeat(80));
console.log('DETAILED: LOSERS WITH MFE >= 20 PTS (best candidates for trailing stop)');
console.log('=' .repeat(80) + '\n');

const highMfeLosers = losers.filter(t => t.mfe >= 20).sort((a, b) => b.mfe - a.mfe);
console.log(`Found ${highMfeLosers.length} losers that went 20+ pts into profit before reversing\n`);

console.log('Date'.padEnd(12) + 'Side'.padEnd(6) + 'MFE'.padEnd(10) + 'Stop Dist'.padEnd(12) +
            'Target Dist'.padEnd(12) + 'Loss'.padEnd(10) + 'Time to MFE');
console.log('-'.repeat(80));

for (const trade of highMfeLosers.slice(0, 15)) {
  console.log(
    new Date(trade.entryTime).toISOString().split('T')[0].padEnd(12) +
    trade.side.toUpperCase().padEnd(6) +
    `${trade.mfe.toFixed(1)} pts`.padEnd(10) +
    `${trade.stopDistance.toFixed(1)} pts`.padEnd(12) +
    `${trade.targetDistance.toFixed(1)} pts`.padEnd(12) +
    `$${trade.netPnL}`.padEnd(10) +
    `${trade.minutesToMfe.toFixed(0)} min`
  );
}

// Save analysis
const analysis = {
  losers: losers.map(t => ({
    id: t.id,
    date: new Date(t.entryTime).toISOString().split('T')[0],
    side: t.side,
    mfe: t.mfe,
    mae: t.mae,
    stopDistance: t.stopDistance,
    targetDistance: t.targetDistance,
    netPnL: t.netPnL,
    minutesToMfe: t.minutesToMfe
  })),
  winners: winners.map(t => ({
    id: t.id,
    date: new Date(t.entryTime).toISOString().split('T')[0],
    side: t.side,
    mfe: t.mfe,
    mae: t.mae,
    stopDistance: t.stopDistance,
    targetDistance: t.targetDistance,
    netPnL: t.netPnL
  })),
  trailingStopSimulations: simResults,
  summary: {
    totalLosers: losers.length,
    totalWinners: winners.length,
    avgLoserMfe: avgMfe,
    avgWinnerMae: avgWinnerMae,
    bestTrailingConfig: bestConfig
  }
};

fs.writeFileSync('./results/trailing-stop-analysis.json', JSON.stringify(analysis, null, 2));
console.log('\n\nDetailed analysis saved to ./results/trailing-stop-analysis.json');
