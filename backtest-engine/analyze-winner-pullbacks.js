#!/usr/bin/env node
/**
 * Analyze winning trades' pullback behavior
 *
 * Question: How much do winning trades pull back from their high/low water mark
 * before eventually hitting target?
 *
 * This helps determine the optimal trailing offset that won't prematurely
 * stop out trades that would have been winners.
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
const highIdx = header.indexOf('high');
const lowIdx = header.indexOf('low');
const closeIdx = header.indexOf('close');

for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(',');
  if (cols.length < 5) continue;
  const ts = new Date(cols[tsIdx]).getTime();
  if (isNaN(ts)) continue;
  candles.push({
    ts,
    high: parseFloat(cols[highIdx]),
    low: parseFloat(cols[lowIdx]),
    close: parseFloat(cols[closeIdx])
  });
}
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

// Get winning trades
const winners = results.trades.filter(t => t.exitReason === 'take_profit');
console.log(`Analyzing ${winners.length} winning trades...\n`);

console.log('=' .repeat(80));
console.log('WINNER PULLBACK ANALYSIS');
console.log('How much do winners pull back from peak before hitting target?');
console.log('=' .repeat(80));

// For each winner, track:
// 1. Max favorable excursion (MFE) - highest profit reached
// 2. Max pullback from MFE before target hit
const winnerAnalysis = [];

for (const trade of winners) {
  const entryTime = trade.entryTime;
  const exitTime = trade.exitTime;
  const side = trade.side;
  const entryPrice = trade.actualEntry;
  const takeProfit = trade.takeProfit;
  const targetDistance = Math.abs(takeProfit - entryPrice);

  const startIdx = findCandleIndex(entryTime);
  const endIdx = findCandleIndex(exitTime);

  const priceMin = entryPrice * 0.95;
  const priceMax = entryPrice * 1.05;

  let highWaterMark = entryPrice;
  let lowWaterMark = entryPrice;
  let maxPullbackFromPeak = 0;
  let peakProfit = 0;

  // Track price action during the trade
  for (let i = startIdx; i <= endIdx && i < candles.length; i++) {
    const candle = candles[i];
    if (candle.ts > exitTime) break;
    if (candle.close < priceMin || candle.close > priceMax) continue;

    if (side === 'buy') {
      // Update high water mark
      if (candle.high > highWaterMark) {
        highWaterMark = candle.high;
        peakProfit = highWaterMark - entryPrice;
      }
      // Calculate pullback from peak
      const pullback = highWaterMark - candle.low;
      maxPullbackFromPeak = Math.max(maxPullbackFromPeak, pullback);
    } else {
      // Short: update low water mark
      if (candle.low < lowWaterMark) {
        lowWaterMark = candle.low;
        peakProfit = entryPrice - lowWaterMark;
      }
      // Calculate pullback from peak (for shorts, high is adverse)
      const pullback = candle.high - lowWaterMark;
      maxPullbackFromPeak = Math.max(maxPullbackFromPeak, pullback);
    }
  }

  winnerAnalysis.push({
    id: trade.id,
    date: new Date(entryTime).toISOString().split('T')[0],
    side,
    entryPrice,
    targetDistance,
    peakProfit,
    maxPullbackFromPeak,
    netPnL: trade.netPnL
  });
}

// Analyze pullback distribution
console.log('\n--- MAX PULLBACK FROM PEAK (before hitting target) ---\n');

const pullbackBuckets = {
  '0-5 pts': [],
  '5-10 pts': [],
  '10-15 pts': [],
  '15-20 pts': [],
  '20-25 pts': [],
  '25-30 pts': [],
  '30-40 pts': [],
  '40-50 pts': [],
  '50+ pts': []
};

for (const w of winnerAnalysis) {
  const pb = w.maxPullbackFromPeak;
  if (pb < 5) pullbackBuckets['0-5 pts'].push(w);
  else if (pb < 10) pullbackBuckets['5-10 pts'].push(w);
  else if (pb < 15) pullbackBuckets['10-15 pts'].push(w);
  else if (pb < 20) pullbackBuckets['15-20 pts'].push(w);
  else if (pb < 25) pullbackBuckets['20-25 pts'].push(w);
  else if (pb < 30) pullbackBuckets['25-30 pts'].push(w);
  else if (pb < 40) pullbackBuckets['30-40 pts'].push(w);
  else if (pb < 50) pullbackBuckets['40-50 pts'].push(w);
  else pullbackBuckets['50+ pts'].push(w);
}

console.log('Pullback Range'.padEnd(20) + 'Winners'.padEnd(10) + 'Profit'.padEnd(14) + 'Would Survive Trail Of:');
console.log('-'.repeat(80));

let cumulative = 0;
for (const [bucket, trades] of Object.entries(pullbackBuckets)) {
  cumulative += trades.length;
  const totalProfit = trades.reduce((sum, t) => sum + t.netPnL, 0);
  const surviveTrail = bucket.split('-')[1]?.replace(' pts', '') || '50+';
  console.log(
    bucket.padEnd(20) +
    `${trades.length}`.padEnd(10) +
    `$${totalProfit.toLocaleString()}`.padEnd(14) +
    `${surviveTrail} pts or wider`
  );
}

// Summary stats
const pullbacks = winnerAnalysis.map(w => w.maxPullbackFromPeak);
const avgPullback = pullbacks.reduce((a, b) => a + b, 0) / pullbacks.length;
const maxPullback = Math.max(...pullbacks);
const medianPullback = pullbacks.sort((a, b) => a - b)[Math.floor(pullbacks.length / 2)];

console.log('\n--- SUMMARY STATISTICS ---\n');
console.log(`Average max pullback: ${avgPullback.toFixed(1)} pts`);
console.log(`Median max pullback: ${medianPullback.toFixed(1)} pts`);
console.log(`Max pullback seen: ${maxPullback.toFixed(1)} pts`);

// Simulate different trail offsets
console.log('\n' + '=' .repeat(80));
console.log('TRAIL OFFSET IMPACT ON WINNERS');
console.log('(Assuming 30pt trigger activation)');
console.log('=' .repeat(80) + '\n');

const trailOffsets = [10, 15, 20, 25, 30, 35, 40, 50];

console.log('Trail Offset'.padEnd(15) + 'Winners Hurt'.padEnd(15) + 'Profit Lost'.padEnd(15) + 'Winners Safe'.padEnd(15) + 'Profit Kept');
console.log('-'.repeat(80));

for (const offset of trailOffsets) {
  let winnersHurt = 0;
  let profitLost = 0;
  let winnersSafe = 0;
  let profitKept = 0;

  for (const w of winnerAnalysis) {
    // Only trades that reached 30pt profit would have trail activated
    if (w.peakProfit >= 30) {
      if (w.maxPullbackFromPeak > offset) {
        // Would have been stopped out early
        winnersHurt++;
        // Lost the difference between where we'd exit and actual target
        const exitProfit = w.peakProfit - offset;
        const actualProfit = w.targetDistance;
        profitLost += (actualProfit - exitProfit) * 20;
      } else {
        winnersSafe++;
        profitKept += w.netPnL;
      }
    } else {
      // Trail never activated, trade behaves normally
      winnersSafe++;
      profitKept += w.netPnL;
    }
  }

  console.log(
    `${offset} pts`.padEnd(15) +
    `${winnersHurt}`.padEnd(15) +
    `$${profitLost.toLocaleString()}`.padEnd(15) +
    `${winnersSafe}`.padEnd(15) +
    `$${profitKept.toLocaleString()}`
  );
}

// Show winners that would be hurt by 15pt trail
console.log('\n' + '=' .repeat(80));
console.log('WINNERS THAT WOULD BE HURT BY 15pt TRAIL (pulled back >15 pts from peak)');
console.log('=' .repeat(80) + '\n');

const hurtBy15 = winnerAnalysis
  .filter(w => w.peakProfit >= 30 && w.maxPullbackFromPeak > 15)
  .sort((a, b) => b.maxPullbackFromPeak - a.maxPullbackFromPeak);

console.log(`Found ${hurtBy15.length} winners that would exit early with 15pt trail\n`);

console.log('Date'.padEnd(12) + 'Side'.padEnd(6) + 'Target'.padEnd(10) + 'Peak'.padEnd(10) + 'Pullback'.padEnd(12) + 'Profit'.padEnd(10) + 'Exit @ Trail');
console.log('-'.repeat(80));

for (const w of hurtBy15.slice(0, 15)) {
  const exitAtTrail = (w.peakProfit - 15) * 20 - 5;
  console.log(
    w.date.padEnd(12) +
    w.side.toUpperCase().padEnd(6) +
    `${w.targetDistance.toFixed(0)} pts`.padEnd(10) +
    `${w.peakProfit.toFixed(0)} pts`.padEnd(10) +
    `${w.maxPullbackFromPeak.toFixed(0)} pts`.padEnd(12) +
    `$${w.netPnL}`.padEnd(10) +
    `$${exitAtTrail.toFixed(0)}`
  );
}

// Recommendation
console.log('\n' + '=' .repeat(80));
console.log('RECOMMENDATION');
console.log('=' .repeat(80));

const hurtBy20 = winnerAnalysis.filter(w => w.peakProfit >= 30 && w.maxPullbackFromPeak > 20).length;
const hurtBy25 = winnerAnalysis.filter(w => w.peakProfit >= 30 && w.maxPullbackFromPeak > 25).length;
const hurtBy30 = winnerAnalysis.filter(w => w.peakProfit >= 30 && w.maxPullbackFromPeak > 30).length;

console.log(`
Winners with 30+ pt peak profit: ${winnerAnalysis.filter(w => w.peakProfit >= 30).length}

Trail offset analysis:
  15 pts: ${hurtBy15.length} winners hurt (${(hurtBy15.length / winners.length * 100).toFixed(0)}%)
  20 pts: ${hurtBy20} winners hurt (${(hurtBy20 / winners.length * 100).toFixed(0)}%)
  25 pts: ${hurtBy25} winners hurt (${(hurtBy25 / winners.length * 100).toFixed(0)}%)
  30 pts: ${hurtBy30} winners hurt (${(hurtBy30 / winners.length * 100).toFixed(0)}%)

Median winner pullback: ${medianPullback.toFixed(0)} pts
Average winner pullback: ${avgPullback.toFixed(0)} pts

Suggested trail offset: ${Math.ceil(medianPullback / 5) * 5} pts (based on median)
`);

// Save analysis
fs.writeFileSync('./results/winner-pullback-analysis.json', JSON.stringify({
  winners: winnerAnalysis,
  summary: {
    totalWinners: winners.length,
    avgPullback,
    medianPullback,
    maxPullback
  },
  pullbackBuckets: Object.fromEntries(
    Object.entries(pullbackBuckets).map(([k, v]) => [k, v.length])
  )
}, null, 2));

console.log('Analysis saved to ./results/winner-pullback-analysis.json');
