#!/usr/bin/env node
/**
 * IV/Skew Trade Correlation Analysis
 *
 * Analyzes the relationship between IV/skew values at entry (and their
 * trajectory during trades) and trade outcomes (win/loss, PnL magnitude).
 *
 * Usage: node scripts/analyze-iv-trade-correlation.js [trades.json]
 */

import fs from 'fs';
import path from 'path';

const inputFile = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'iv-skew-gex-iv-analysis.json');

if (!fs.existsSync(inputFile)) {
  console.error(`File not found: ${inputFile}`);
  console.error('Run the gold standard backtest first with --output flag');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
const trades = data.trades || data;

// Filter to completed trades with IV data
const tradesWithIV = trades.filter(t =>
  t.status === 'completed' && t.entryIV && t.entryIV.iv != null
);

console.log(`\n${'='.repeat(80)}`);
console.log(`IV/SKEW TRADE CORRELATION ANALYSIS`);
console.log(`${'='.repeat(80)}`);
console.log(`Total trades: ${trades.length}`);
console.log(`Trades with IV data: ${tradesWithIV.length}`);

if (tradesWithIV.length === 0) {
  console.error('\nNo trades with IV data found. Make sure the backtest was run with IV tracking enabled.');
  process.exit(1);
}

// Classify trades
const winners = tradesWithIV.filter(t => t.netPnL > 0);
const losers = tradesWithIV.filter(t => t.netPnL <= 0);

console.log(`Winners: ${winners.length} (${(winners.length / tradesWithIV.length * 100).toFixed(1)}%)`);
console.log(`Losers: ${losers.length} (${(losers.length / tradesWithIV.length * 100).toFixed(1)}%)`);

// ============================================================
// 1. Entry IV Distribution: Winners vs Losers
// ============================================================
console.log(`\n${'─'.repeat(80)}`);
console.log(`1. ENTRY IV: WINNERS vs LOSERS`);
console.log(`${'─'.repeat(80)}`);

function stats(arr) {
  if (arr.length === 0) return { mean: 0, median: 0, min: 0, max: 0, stdDev: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return {
    mean: mean,
    median: median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stdDev: Math.sqrt(variance)
  };
}

function printStats(label, values, format = 'pct') {
  const s = stats(values);
  const fmt = format === 'pct'
    ? (v) => `${(v * 100).toFixed(2)}%`
    : (v) => v.toFixed(4);
  console.log(`  ${label.padEnd(12)} Mean: ${fmt(s.mean).padStart(8)}  Median: ${fmt(s.median).padStart(8)}  Min: ${fmt(s.min).padStart(8)}  Max: ${fmt(s.max).padStart(8)}  StdDev: ${fmt(s.stdDev).padStart(8)}`);
}

console.log('\n  Entry IV (ATM Implied Volatility):');
printStats('Winners', winners.map(t => t.entryIV.iv));
printStats('Losers', losers.map(t => t.entryIV.iv));

console.log('\n  Entry Skew (Put-Call IV Difference):');
printStats('Winners', winners.map(t => t.entryIV.skew));
printStats('Losers', losers.map(t => t.entryIV.skew));

console.log('\n  Entry |Skew| (Absolute Skew Magnitude):');
printStats('Winners', winners.map(t => Math.abs(t.entryIV.skew)));
printStats('Losers', losers.map(t => Math.abs(t.entryIV.skew)));

// ============================================================
// 2. IV/Skew Buckets and Win Rate
// ============================================================
console.log(`\n${'─'.repeat(80)}`);
console.log(`2. WIN RATE BY IV BUCKET`);
console.log(`${'─'.repeat(80)}`);

function bucketAnalysis(trades, field, buckets, label) {
  console.log(`\n  ${label}:`);
  console.log(`  ${'Bucket'.padEnd(20)} ${'Count'.padStart(6)} ${'Win%'.padStart(7)} ${'AvgPnL'.padStart(10)} ${'AvgWin'.padStart(10)} ${'AvgLoss'.padStart(10)}`);
  console.log(`  ${'─'.repeat(63)}`);

  for (let i = 0; i < buckets.length - 1; i++) {
    const lo = buckets[i];
    const hi = buckets[i + 1];
    const inBucket = trades.filter(t => {
      const val = typeof field === 'function' ? field(t) : t.entryIV[field];
      return val >= lo && val < hi;
    });
    if (inBucket.length === 0) continue;

    const bucketWinners = inBucket.filter(t => t.netPnL > 0);
    const bucketLosers = inBucket.filter(t => t.netPnL <= 0);
    const avgPnL = inBucket.reduce((s, t) => s + t.netPnL, 0) / inBucket.length;
    const avgWin = bucketWinners.length > 0 ? bucketWinners.reduce((s, t) => s + t.netPnL, 0) / bucketWinners.length : 0;
    const avgLoss = bucketLosers.length > 0 ? bucketLosers.reduce((s, t) => s + t.netPnL, 0) / bucketLosers.length : 0;

    const bucketLabel = `${(lo * 100).toFixed(1)}%-${(hi * 100).toFixed(1)}%`;
    console.log(`  ${bucketLabel.padEnd(20)} ${String(inBucket.length).padStart(6)} ${(bucketWinners.length / inBucket.length * 100).toFixed(1).padStart(6)}% ${('$' + avgPnL.toFixed(0)).padStart(10)} ${('$' + avgWin.toFixed(0)).padStart(10)} ${('$' + avgLoss.toFixed(0)).padStart(10)}`);
  }
}

bucketAnalysis(tradesWithIV, 'iv',
  [0.10, 0.15, 0.18, 0.20, 0.22, 0.25, 0.30, 0.40, 0.60, 1.0],
  'IV at Entry');

bucketAnalysis(tradesWithIV, (t) => Math.abs(t.entryIV.skew),
  [0.00, 0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.15, 0.50],
  '|Skew| at Entry');

// ============================================================
// 3. IV Change During Trade: Winners vs Losers
// ============================================================
console.log(`\n${'─'.repeat(80)}`);
console.log(`3. IV/SKEW CHANGE DURING TRADE: WINNERS vs LOSERS`);
console.log(`${'─'.repeat(80)}`);

const tradesWithChange = tradesWithIV.filter(t => t.ivChange != null);
if (tradesWithChange.length > 0) {
  const winnersWithChange = tradesWithChange.filter(t => t.netPnL > 0);
  const losersWithChange = tradesWithChange.filter(t => t.netPnL <= 0);

  console.log(`\n  Trades with IV change data: ${tradesWithChange.length}`);

  console.log('\n  IV Change (Exit - Entry):');
  printStats('Winners', winnersWithChange.map(t => t.ivChange));
  printStats('Losers', losersWithChange.map(t => t.ivChange));

  console.log('\n  Skew Change (Exit - Entry):');
  printStats('Winners', winnersWithChange.map(t => t.skewChange));
  printStats('Losers', losersWithChange.map(t => t.skewChange));

  // Separate by trade direction
  const shorts = tradesWithChange.filter(t => t.side === 'sell' || t.side === 'short');
  const longs = tradesWithChange.filter(t => t.side === 'buy' || t.side === 'long');

  if (shorts.length > 0) {
    console.log(`\n  SHORT trades (${shorts.length}):`);
    console.log('  IV Change:');
    printStats('  Win', shorts.filter(t => t.netPnL > 0).map(t => t.ivChange));
    printStats('  Loss', shorts.filter(t => t.netPnL <= 0).map(t => t.ivChange));
    console.log('  Skew Change:');
    printStats('  Win', shorts.filter(t => t.netPnL > 0).map(t => t.skewChange));
    printStats('  Loss', shorts.filter(t => t.netPnL <= 0).map(t => t.skewChange));
  }

  if (longs.length > 0) {
    console.log(`\n  LONG trades (${longs.length}):`);
    console.log('  IV Change:');
    printStats('  Win', longs.filter(t => t.netPnL > 0).map(t => t.ivChange));
    printStats('  Loss', longs.filter(t => t.netPnL <= 0).map(t => t.ivChange));
    console.log('  Skew Change:');
    printStats('  Win', longs.filter(t => t.netPnL > 0).map(t => t.skewChange));
    printStats('  Loss', longs.filter(t => t.netPnL <= 0).map(t => t.skewChange));
  }
}

// ============================================================
// 4. IV Trajectory Analysis (using per-bar snapshots)
// ============================================================
console.log(`\n${'─'.repeat(80)}`);
console.log(`4. IV TRAJECTORY DURING TRADES`);
console.log(`${'─'.repeat(80)}`);

const tradesWithHistory = tradesWithIV.filter(t => t.ivHistory && t.ivHistory.length >= 2);
if (tradesWithHistory.length > 0) {
  console.log(`\n  Trades with IV history: ${tradesWithHistory.length}`);

  // Compute per-trade IV trend (simple linear slope of IV over bars)
  function ivSlope(history) {
    if (history.length < 2) return 0;
    const n = history.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const h of history) {
      sumX += h.bar;
      sumY += h.iv;
      sumXY += h.bar * h.iv;
      sumXX += h.bar * h.bar;
    }
    return (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  }

  function skewSlope(history) {
    if (history.length < 2) return 0;
    const n = history.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const h of history) {
      sumX += h.bar;
      sumY += h.skew;
      sumXY += h.bar * h.skew;
      sumXX += h.bar * h.bar;
    }
    return (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  }

  const winnersWithHist = tradesWithHistory.filter(t => t.netPnL > 0);
  const losersWithHist = tradesWithHistory.filter(t => t.netPnL <= 0);

  console.log('\n  IV Slope (per bar, positive = IV rising during trade):');
  printStats('Winners', winnersWithHist.map(t => ivSlope(t.ivHistory)), 'raw');
  printStats('Losers', losersWithHist.map(t => ivSlope(t.ivHistory)), 'raw');

  console.log('\n  Skew Slope (per bar, positive = skew rising during trade):');
  printStats('Winners', winnersWithHist.map(t => skewSlope(t.ivHistory)), 'raw');
  printStats('Losers', losersWithHist.map(t => skewSlope(t.ivHistory)), 'raw');

  // IV volatility during trade (std dev of IV snapshots)
  function ivVolatility(history) {
    if (history.length < 2) return 0;
    const ivs = history.map(h => h.iv);
    const mean = ivs.reduce((s, v) => s + v, 0) / ivs.length;
    const variance = ivs.reduce((s, v) => s + (v - mean) ** 2, 0) / ivs.length;
    return Math.sqrt(variance);
  }

  console.log('\n  IV Volatility (stddev of IV during trade):');
  printStats('Winners', winnersWithHist.map(t => ivVolatility(t.ivHistory)), 'raw');
  printStats('Losers', losersWithHist.map(t => ivVolatility(t.ivHistory)), 'raw');
} else {
  console.log('\n  No trades with IV history (per-bar snapshots) found.');
}

// ============================================================
// 5. PnL Correlation with IV/Skew
// ============================================================
console.log(`\n${'─'.repeat(80)}`);
console.log(`5. PNL CORRELATION WITH IV/SKEW AT ENTRY`);
console.log(`${'─'.repeat(80)}`);

function correlation(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

const pnls = tradesWithIV.map(t => t.netPnL);
const entryIVs = tradesWithIV.map(t => t.entryIV.iv);
const entrySkews = tradesWithIV.map(t => Math.abs(t.entryIV.skew));
const entrySignedSkews = tradesWithIV.map(t => t.entryIV.skew);

console.log(`\n  Pearson Correlation with PnL:`);
console.log(`    Entry IV vs PnL:        r = ${correlation(entryIVs, pnls).toFixed(4)}`);
console.log(`    Entry |Skew| vs PnL:    r = ${correlation(entrySkews, pnls).toFixed(4)}`);
console.log(`    Entry Skew vs PnL:      r = ${correlation(entrySignedSkews, pnls).toFixed(4)}`);

if (tradesWithChange.length > 0) {
  const changePnls = tradesWithChange.map(t => t.netPnL);
  const ivChanges = tradesWithChange.map(t => t.ivChange);
  const skewChanges = tradesWithChange.map(t => t.skewChange);
  console.log(`    IV Change vs PnL:       r = ${correlation(ivChanges, changePnls).toFixed(4)}`);
  console.log(`    Skew Change vs PnL:     r = ${correlation(skewChanges, changePnls).toFixed(4)}`);
}

// ============================================================
// 6. Top/Bottom Trades by IV
// ============================================================
console.log(`\n${'─'.repeat(80)}`);
console.log(`6. EXTREME TRADES`);
console.log(`${'─'.repeat(80)}`);

const sortedByIV = [...tradesWithIV].sort((a, b) => b.entryIV.iv - a.entryIV.iv);
console.log('\n  Top 10 Highest IV at Entry:');
console.log(`  ${'IV'.padStart(8)} ${'Skew'.padStart(8)} ${'Side'.padEnd(6)} ${'PnL'.padStart(10)} ${'Exit'.padEnd(15)} ${'Date'.padEnd(20)}`);
sortedByIV.slice(0, 10).forEach(t => {
  console.log(`  ${(t.entryIV.iv * 100).toFixed(2).padStart(7)}% ${(t.entryIV.skew * 100).toFixed(2).padStart(7)}% ${t.side.padEnd(6)} ${('$' + t.netPnL.toFixed(0)).padStart(10)} ${t.exitReason.padEnd(15)} ${new Date(t.entryTime).toISOString().substring(0, 16)}`);
});

const sortedBySkew = [...tradesWithIV].sort((a, b) => Math.abs(b.entryIV.skew) - Math.abs(a.entryIV.skew));
console.log('\n  Top 10 Highest |Skew| at Entry:');
console.log(`  ${'IV'.padStart(8)} ${'Skew'.padStart(8)} ${'Side'.padEnd(6)} ${'PnL'.padStart(10)} ${'Exit'.padEnd(15)} ${'Date'.padEnd(20)}`);
sortedBySkew.slice(0, 10).forEach(t => {
  console.log(`  ${(t.entryIV.iv * 100).toFixed(2).padStart(7)}% ${(t.entryIV.skew * 100).toFixed(2).padStart(7)}% ${t.side.padEnd(6)} ${('$' + t.netPnL.toFixed(0)).padStart(10)} ${t.exitReason.padEnd(15)} ${new Date(t.entryTime).toISOString().substring(0, 16)}`);
});

console.log(`\n${'='.repeat(80)}`);
console.log('Analysis complete.');
