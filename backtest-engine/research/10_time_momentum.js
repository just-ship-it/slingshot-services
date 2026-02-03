#!/usr/bin/env node
/**
 * Time-Based Momentum Patterns Analysis
 *
 * Goal: Find optimal entry timing based on intraday patterns
 *
 * Analysis:
 * 1. Calculate momentum (squeeze/RSI) at each 30-min window
 * 2. Track which windows have highest directional accuracy
 * 3. Analyze momentum regime at key times (9:30, 10:00, 2:00, 3:00)
 * 4. Correlate time-based momentum with trade direction
 * 5. Find "golden windows" where momentum predicts direction
 *
 * Hypothesis: Certain times have more predictable momentum.
 */

import {
  loadTrades,
  loadNQOHLCV,
  getCandlesAround,
  getRTHCandles
} from './utils/data-loader.js';

import {
  calculatePerformance,
  bucket,
  correlation,
  round,
  saveResults,
  analyzeDimension,
  formatCurrency,
  roc
} from './utils/analysis-helpers.js';

// Key trading time windows (ET)
const TIME_WINDOWS = [
  { start: 9.5, end: 10, label: '9:30-10:00' },
  { start: 10, end: 10.5, label: '10:00-10:30' },
  { start: 10.5, end: 11, label: '10:30-11:00' },
  { start: 11, end: 11.5, label: '11:00-11:30' },
  { start: 11.5, end: 12, label: '11:30-12:00' },
  { start: 12, end: 13, label: '12:00-13:00' },
  { start: 13, end: 14, label: '13:00-14:00' },
  { start: 14, end: 14.5, label: '14:00-14:30' },
  { start: 14.5, end: 15, label: '14:30-15:00' },
  { start: 15, end: 15.5, label: '15:00-15:30' },
  { start: 15.5, end: 16, label: '15:30-16:00' }
];

// Calculate simple RSI
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0, losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return round(100 - (100 / (1 + rs)), 2);
}

function getTimeWindow(timestamp) {
  const date = new Date(timestamp);
  const hour = date.getHours() + date.getMinutes() / 60;

  for (const window of TIME_WINDOWS) {
    if (hour >= window.start && hour < window.end) {
      return window.label;
    }
  }

  // Outside RTH
  if (hour < 9.5) return 'Pre-market';
  if (hour >= 16) return 'After-hours';
  return 'Unknown';
}

async function runAnalysis() {
  console.log('='.repeat(70));
  console.log('  Time-Based Momentum Patterns Analysis');
  console.log('='.repeat(70));
  console.log();

  // Load data
  console.log('Loading data...');
  const trades = await loadTrades();
  const ohlcv = await loadNQOHLCV('2025-01-01', '2025-12-31');

  console.log();

  // Analyze momentum at each trade entry
  const tradesWithTimeMom = [];

  for (const trade of trades) {
    const candles = getCandlesAround(ohlcv, trade.entryTime, 20, 0);
    if (candles.length < 20) continue;

    const closes = candles.map(c => c.close);

    // Calculate momentum indicators
    const rsi = calculateRSI(closes);
    const roc5 = roc(closes, 5);
    const roc10 = roc(closes, 10);

    if (rsi === null || roc5 === null) continue;

    // Time window
    const timeWindow = getTimeWindow(trade.entryTime);

    // Categorize RSI
    let rsiCategory = 'neutral';
    if (rsi >= 70) rsiCategory = 'overbought';
    else if (rsi >= 60) rsiCategory = 'bullish';
    else if (rsi <= 30) rsiCategory = 'oversold';
    else if (rsi <= 40) rsiCategory = 'bearish';

    // Categorize momentum
    let momCategory = 'ranging';
    if (roc5 > 0.2) momCategory = 'bullish_momentum';
    else if (roc5 < -0.2) momCategory = 'bearish_momentum';

    // Combined time-momentum state
    const timeMomState = `${timeWindow}_${momCategory}`;

    // Momentum alignment with trade
    let momAlignment = 'neutral';
    if ((momCategory === 'bullish_momentum' && trade.side === 'buy') ||
        (momCategory === 'bearish_momentum' && trade.side === 'sell')) {
      momAlignment = 'aligned';
    } else if (momCategory !== 'ranging') {
      momAlignment = 'counter';
    }

    tradesWithTimeMom.push({
      ...trade,
      timeWindow,
      rsi,
      rsiCategory,
      roc5: round(roc5, 2),
      roc10: round(roc10, 2),
      momCategory,
      momAlignment,
      timeMomState
    });
  }

  console.log(`Analyzed time-momentum for ${tradesWithTimeMom.length} trades\n`);

  // Analysis 1: Performance by Time Window
  console.log('1. Performance by Time Window');
  console.log('-'.repeat(50));

  const timeAnalysis = analyzeDimension(tradesWithTimeMom, 'timeWindow', 'Time Window');

  // Sort by time order
  const timeOrder = TIME_WINDOWS.map(w => w.label);
  const sortedTimeGroups = timeAnalysis.groups.sort((a, b) => {
    const aIdx = timeOrder.indexOf(a.name);
    const bIdx = timeOrder.indexOf(b.name);
    return aIdx - bIdx;
  });

  sortedTimeGroups.forEach(g => {
    console.log(`  ${g.name.padEnd(14)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 2: Performance by Momentum Category at Entry
  console.log('\n2. Performance by Momentum at Entry');
  console.log('-'.repeat(50));

  const momAnalysis = analyzeDimension(tradesWithTimeMom, 'momCategory', 'Momentum Category');

  momAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(18)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 3: Momentum Alignment Performance
  console.log('\n3. Performance by Momentum Alignment');
  console.log('-'.repeat(50));

  const alignAnalysis = analyzeDimension(tradesWithTimeMom, 'momAlignment', 'Momentum Alignment');

  alignAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(12)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.totalPnL)} total`);
  });

  // Analysis 4: RSI Category Performance
  console.log('\n4. Performance by RSI at Entry');
  console.log('-'.repeat(50));

  const rsiAnalysis = analyzeDimension(tradesWithTimeMom, 'rsiCategory', 'RSI Category');

  rsiAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(12)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 5: Time + Momentum Combined (Golden Windows)
  console.log('\n5. Golden Windows (Time + Momentum Combined)');
  console.log('-'.repeat(50));

  // Find best performing time-momentum combinations
  const timeMomGroups = new Map();

  tradesWithTimeMom.forEach(t => {
    const key = `${t.timeWindow}|${t.momAlignment}`;
    if (!timeMomGroups.has(key)) {
      timeMomGroups.set(key, []);
    }
    timeMomGroups.get(key).push(t);
  });

  const goldenWindows = [];

  for (const [key, trades] of timeMomGroups) {
    if (trades.length < 15) continue;

    const perf = calculatePerformance(trades);
    const [time, alignment] = key.split('|');

    goldenWindows.push({
      time,
      alignment,
      ...perf
    });
  }

  // Sort by win rate
  goldenWindows.sort((a, b) => b.winRate - a.winRate);

  console.log('  Top 5 Time + Momentum Combinations:');
  goldenWindows.slice(0, 5).forEach((g, i) => {
    console.log(`    ${i + 1}. ${g.time} + ${g.alignment}: ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg (${g.tradeCount} trades)`);
  });

  console.log('\n  Bottom 5 Time + Momentum Combinations:');
  goldenWindows.slice(-5).forEach((g, i) => {
    console.log(`    ${i + 1}. ${g.time} + ${g.alignment}: ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg (${g.tradeCount} trades)`);
  });

  // Analysis 6: Time Windows by Direction
  console.log('\n6. Best Time Windows by Trade Direction');
  console.log('-'.repeat(50));

  for (const direction of ['buy', 'sell']) {
    const subset = tradesWithTimeMom.filter(t => t.side === direction);

    const byTime = new Map();
    subset.forEach(t => {
      if (!byTime.has(t.timeWindow)) byTime.set(t.timeWindow, []);
      byTime.get(t.timeWindow).push(t);
    });

    const timePerf = [];
    for (const [time, trades] of byTime) {
      if (trades.length >= 10) {
        timePerf.push({ time, ...calculatePerformance(trades) });
      }
    }

    timePerf.sort((a, b) => b.winRate - a.winRate);

    console.log(`  ${direction.toUpperCase()}S - Best Times:`);
    timePerf.slice(0, 3).forEach(t => {
      console.log(`    ${t.time}: ${t.winRate}% WR (${t.tradeCount} trades)`);
    });
  }

  // Analysis 7: Momentum regime at key times
  console.log('\n7. Momentum Regime Analysis at Key Times');
  console.log('-'.repeat(50));

  const keyTimes = ['9:30-10:00', '10:00-10:30', '14:00-14:30', '15:00-15:30'];

  for (const keyTime of keyTimes) {
    const subset = tradesWithTimeMom.filter(t => t.timeWindow === keyTime);
    if (subset.length < 20) continue;

    const aligned = subset.filter(t => t.momAlignment === 'aligned');
    const counter = subset.filter(t => t.momAlignment === 'counter');

    console.log(`  ${keyTime}:`);
    if (aligned.length >= 5) {
      const perf = calculatePerformance(aligned);
      console.log(`    Momentum aligned:  ${perf.winRate}% WR (${perf.tradeCount})`);
    }
    if (counter.length >= 5) {
      const perf = calculatePerformance(counter);
      console.log(`    Momentum counter:  ${perf.winRate}% WR (${perf.tradeCount})`);
    }
  }

  // Correlations
  console.log('\n8. Correlation Analysis');
  console.log('-'.repeat(50));

  const rsis = tradesWithTimeMom.map(t => t.rsi);
  const roc5s = tradesWithTimeMom.map(t => t.roc5);
  const pnls = tradesWithTimeMom.map(t => t.netPnL);

  console.log(`  RSI vs P&L:    ${correlation(rsis, pnls)}`);
  console.log(`  ROC(5) vs P&L: ${correlation(roc5s, pnls)}`);

  // Compile results
  const results = {
    analysis: 'Time-Based Momentum Patterns Analysis',
    timestamp: new Date().toISOString(),
    summary: {
      totalTrades: tradesWithTimeMom.length,
      hypothesis: 'Certain times have more predictable momentum',
      finding: 'See recommendations'
    },
    correlations: {
      rsiVsPnL: correlation(rsis, pnls),
      roc5VsPnL: correlation(roc5s, pnls)
    },
    byTimeWindow: sortedTimeGroups,
    byMomentumCategory: momAnalysis.groups,
    byMomentumAlignment: alignAnalysis.groups,
    byRSICategory: rsiAnalysis.groups,
    goldenWindows: goldenWindows.slice(0, 10),
    avoidWindows: goldenWindows.slice(-5),
    recommendations: []
  };

  // Generate recommendations
  const bestTime = sortedTimeGroups.reduce((best, g) =>
    g.winRate > best.winRate && g.tradeCount >= 20 ? g : best, sortedTimeGroups[0]);
  const worstTime = sortedTimeGroups.reduce((worst, g) =>
    g.winRate < worst.winRate && g.tradeCount >= 20 ? g : worst, sortedTimeGroups[0]);

  if (bestTime.winRate - worstTime.winRate > 10) {
    results.summary.finding = 'SUPPORTED - Significant time window variance';
    results.recommendations.push(`Best time: ${bestTime.name} (${bestTime.winRate}% WR)`);
    results.recommendations.push(`Avoid: ${worstTime.name} (${worstTime.winRate}% WR)`);
  } else {
    results.summary.finding = 'INCONCLUSIVE - Limited time window variance';
  }

  if (goldenWindows.length > 0) {
    const golden = goldenWindows[0];
    if (golden.winRate >= 40) {
      results.recommendations.push(`Golden window: ${golden.time} + ${golden.alignment} (${golden.winRate}% WR)`);
    }
  }

  const alignedPerf = alignAnalysis.groups.find(g => g.name === 'aligned');
  const counterPerf = alignAnalysis.groups.find(g => g.name === 'counter');

  if (alignedPerf && counterPerf && alignedPerf.winRate > counterPerf.winRate + 5) {
    results.recommendations.push(`Trade with momentum: ${alignedPerf.winRate}% vs ${counterPerf.winRate}% WR`);
  }

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('  SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Hypothesis: ${results.summary.hypothesis}`);
  console.log(`  Finding: ${results.summary.finding}`);
  console.log();

  if (results.recommendations.length > 0) {
    console.log('  Recommendations:');
    results.recommendations.forEach(r => console.log(`    - ${r}`));
  }

  // Save results
  saveResults('10_time_momentum.json', results);

  return results;
}

runAnalysis().catch(console.error);
