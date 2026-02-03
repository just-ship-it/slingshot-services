#!/usr/bin/env node
/**
 * Opening Range Breakout Analysis
 *
 * Goal: Determine if first 15-30 min range predicts direction
 *
 * Analysis:
 * 1. Calculate opening range (first 15, 30, 60 minutes)
 * 2. Track when price breaks above/below OR high/low
 * 3. Correlate breakout direction with final daily direction
 * 4. Analyze trades that align vs counter to OR breakout
 * 5. Check win rate when trading with OR breakout direction
 *
 * Hypothesis: OR breakout direction predicts daily trend.
 */

import {
  loadTrades,
  loadNQOHLCV,
  getRTHCandles,
  getCandlesForDay
} from './utils/data-loader.js';

import {
  calculatePerformance,
  bucket,
  correlation,
  round,
  saveResults,
  analyzeDimension,
  formatCurrency
} from './utils/analysis-helpers.js';

// Opening range periods to analyze (minutes)
const OR_PERIODS = [15, 30, 60];

async function runAnalysis() {
  console.log('='.repeat(70));
  console.log('  Opening Range Breakout Analysis');
  console.log('='.repeat(70));
  console.log();

  // Load data
  console.log('Loading data...');
  const trades = await loadTrades();
  const ohlcv = await loadNQOHLCV('2025-01-01', '2025-12-31');

  console.log();

  // Build opening range data for each trading day
  const openingRanges = new Map(); // date string -> { or15, or30, or60, breakout }

  // Get unique trading days
  const tradeDates = new Set(trades.map(t => t.entryDate));

  for (const dateStr of tradeDates) {
    const date = new Date(dateStr);
    const rthCandles = getRTHCandles(ohlcv, date);

    if (rthCandles.length < 30) continue;

    const orData = { date: dateStr };

    // Calculate OR for each period
    for (const minutes of OR_PERIODS) {
      const orCandles = rthCandles.filter(c => {
        const candleDate = new Date(c.timestamp);
        const rthStart = new Date(c.timestamp);
        rthStart.setHours(9, 30, 0, 0);
        const elapsed = (candleDate - rthStart) / (1000 * 60);
        return elapsed < minutes;
      });

      if (orCandles.length === 0) continue;

      const orHigh = Math.max(...orCandles.map(c => c.high));
      const orLow = Math.min(...orCandles.map(c => c.low));
      const orMid = (orHigh + orLow) / 2;
      const orRange = orHigh - orLow;

      orData[`or${minutes}`] = {
        high: orHigh,
        low: orLow,
        mid: orMid,
        range: orRange
      };

      // Determine breakout direction (first sustained break)
      const postOrCandles = rthCandles.filter(c => {
        const candleDate = new Date(c.timestamp);
        const rthStart = new Date(c.timestamp);
        rthStart.setHours(9, 30, 0, 0);
        const elapsed = (candleDate - rthStart) / (1000 * 60);
        return elapsed >= minutes;
      });

      let breakoutDir = 'none';
      for (const candle of postOrCandles) {
        if (candle.close > orHigh) {
          breakoutDir = 'up';
          break;
        }
        if (candle.close < orLow) {
          breakoutDir = 'down';
          break;
        }
      }

      orData[`or${minutes}Breakout`] = breakoutDir;
    }

    // Calculate day's final result
    const dayClose = rthCandles[rthCandles.length - 1].close;
    const dayOpen = rthCandles[0].open;
    orData.dayDirection = dayClose > dayOpen ? 'up' : dayClose < dayOpen ? 'down' : 'flat';
    orData.dayChange = round(dayClose - dayOpen, 2);

    openingRanges.set(dateStr, orData);
  }

  console.log(`Calculated opening ranges for ${openingRanges.size} trading days\n`);

  // Analyze trades relative to opening range
  const tradesWithOR = [];

  for (const trade of trades) {
    const orData = openingRanges.get(trade.entryDate);
    if (!orData) continue;

    // Get entry time relative to RTH start
    const entryDate = new Date(trade.entryTime);
    const rthStart = new Date(trade.entryTime);
    rthStart.setHours(9, 30, 0, 0);
    const minutesAfterOpen = (entryDate - rthStart) / (1000 * 60);

    // Determine which OR period applies
    let orPeriod = 15;
    if (minutesAfterOpen >= 60) orPeriod = 60;
    else if (minutesAfterOpen >= 30) orPeriod = 30;

    const or = orData[`or${orPeriod}`];
    if (!or) continue;

    const breakoutDir = orData[`or${orPeriod}Breakout`];
    const entryPrice = trade.entryPrice;

    // Position relative to OR
    let orPosition;
    if (entryPrice > or.high) orPosition = 'above_or';
    else if (entryPrice < or.low) orPosition = 'below_or';
    else orPosition = 'inside_or';

    // Trade alignment with breakout
    let alignment = 'neutral';
    if (breakoutDir === 'up' && trade.side === 'buy') alignment = 'with_breakout';
    else if (breakoutDir === 'down' && trade.side === 'sell') alignment = 'with_breakout';
    else if (breakoutDir !== 'none' && alignment === 'neutral') alignment = 'against_breakout';

    // Trade alignment with day direction
    let dayAlignment = 'neutral';
    if (orData.dayDirection === 'up' && trade.side === 'buy') dayAlignment = 'with_day';
    else if (orData.dayDirection === 'down' && trade.side === 'sell') dayAlignment = 'with_day';
    else if (orData.dayDirection !== 'flat') dayAlignment = 'against_day';

    tradesWithOR.push({
      ...trade,
      orHigh: round(or.high, 2),
      orLow: round(or.low, 2),
      orRange: round(or.range, 2),
      orPeriod,
      orPosition,
      breakoutDir,
      alignment,
      dayDirection: orData.dayDirection,
      dayAlignment,
      minutesAfterOpen: round(minutesAfterOpen, 0)
    });
  }

  console.log(`Analyzed ${tradesWithOR.length} trades with opening range data\n`);

  // Analysis 1: Performance by OR Position
  console.log('1. Performance by Position Relative to Opening Range');
  console.log('-'.repeat(50));

  const orPosAnalysis = analyzeDimension(tradesWithOR, 'orPosition', 'OR Position');

  orPosAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(15)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 2: Alignment with OR Breakout
  console.log('\n2. Performance by Alignment with OR Breakout');
  console.log('-'.repeat(50));

  const alignAnalysis = analyzeDimension(tradesWithOR, 'alignment', 'Breakout Alignment');

  alignAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(18)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.totalPnL)} total`);
  });

  // Analysis 3: Alignment with Day Direction
  console.log('\n3. Performance by Alignment with Day Direction');
  console.log('-'.repeat(50));

  const dayAlignAnalysis = analyzeDimension(tradesWithOR, 'dayAlignment', 'Day Alignment');

  dayAlignAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(15)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.totalPnL)} total`);
  });

  // Analysis 4: Breakout Direction Accuracy
  console.log('\n4. OR Breakout Direction vs Day Direction Accuracy');
  console.log('-'.repeat(50));

  let correctBreakouts = 0;
  let totalBreakouts = 0;

  for (const [dateStr, orData] of openingRanges) {
    const breakout = orData.or30Breakout; // Use 30-min OR
    const dayDir = orData.dayDirection;

    if (breakout === 'none' || dayDir === 'flat') continue;

    totalBreakouts++;
    if (breakout === dayDir) correctBreakouts++;
  }

  const breakoutAccuracy = totalBreakouts > 0 ? round((correctBreakouts / totalBreakouts) * 100, 1) : 0;
  console.log(`  30-min OR breakout predicts day direction: ${breakoutAccuracy}% (${correctBreakouts}/${totalBreakouts})`);

  // Analysis 5: OR Range Size Impact
  console.log('\n5. Performance by Opening Range Size');
  console.log('-'.repeat(50));

  const rangeBuckets = [
    { min: 0, max: 20, label: 'Tight OR (<20 pts)' },
    { min: 20, max: 40, label: 'Normal OR (20-40)' },
    { min: 40, max: 60, label: 'Wide OR (40-60)' },
    { min: 60, max: 500, label: 'Very wide OR (>60)' }
  ];

  const rangeAnalysis = analyzeDimension(
    tradesWithOR,
    trade => bucket(trade.orRange, rangeBuckets),
    'OR Range Size'
  );

  rangeAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(22)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 6: Time Since Open Impact
  console.log('\n6. Performance by Time Since Open');
  console.log('-'.repeat(50));

  const timeBuckets = [
    { min: 0, max: 30, label: 'First 30 min' },
    { min: 30, max: 60, label: '30-60 min' },
    { min: 60, max: 120, label: '1-2 hours' },
    { min: 120, max: 240, label: '2-4 hours' },
    { min: 240, max: 600, label: '4+ hours' }
  ];

  const timeAnalysis = analyzeDimension(
    tradesWithOR,
    trade => bucket(trade.minutesAfterOpen, timeBuckets),
    'Time Since Open'
  );

  timeAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(18)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 7: By trade direction and OR position
  console.log('\n7. Direction Analysis at OR Levels');
  console.log('-'.repeat(50));

  for (const pos of ['above_or', 'below_or', 'inside_or']) {
    const subset = tradesWithOR.filter(t => t.orPosition === pos);
    if (subset.length < 10) continue;

    const longs = subset.filter(t => t.side === 'buy');
    const shorts = subset.filter(t => t.side === 'sell');

    console.log(`  ${pos}:`);
    if (longs.length >= 5) {
      const perf = calculatePerformance(longs);
      console.log(`    Longs:  ${perf.tradeCount} trades, ${perf.winRate}% WR`);
    }
    if (shorts.length >= 5) {
      const perf = calculatePerformance(shorts);
      console.log(`    Shorts: ${perf.tradeCount} trades, ${perf.winRate}% WR`);
    }
  }

  // Compile results
  const results = {
    analysis: 'Opening Range Breakout Analysis',
    timestamp: new Date().toISOString(),
    summary: {
      totalTrades: tradesWithOR.length,
      totalDays: openingRanges.size,
      hypothesis: 'OR breakout direction predicts daily trend',
      orBreakoutAccuracy: breakoutAccuracy,
      finding: breakoutAccuracy >= 55 ? 'SUPPORTED' : breakoutAccuracy <= 45 ? 'CONTRADICTED' : 'INCONCLUSIVE'
    },
    byORPosition: orPosAnalysis.groups,
    byBreakoutAlignment: alignAnalysis.groups,
    byDayAlignment: dayAlignAnalysis.groups,
    byORRange: rangeAnalysis.groups,
    byTimeSinceOpen: timeAnalysis.groups,
    recommendations: []
  };

  // Generate recommendations
  const withBreakout = alignAnalysis.groups.find(g => g.name === 'with_breakout');
  const againstBreakout = alignAnalysis.groups.find(g => g.name === 'against_breakout');

  if (withBreakout && againstBreakout && withBreakout.winRate > againstBreakout.winRate + 5) {
    results.recommendations.push(`Trade with OR breakout: ${withBreakout.winRate}% vs ${againstBreakout.winRate}% WR`);
  }

  const withDay = dayAlignAnalysis.groups.find(g => g.name === 'with_day');
  const againstDay = dayAlignAnalysis.groups.find(g => g.name === 'against_day');

  if (withDay && againstDay && withDay.winRate > againstDay.winRate + 5) {
    results.recommendations.push(`Trade with day trend: ${withDay.winRate}% vs ${againstDay.winRate}% WR`);
  }

  const bestRange = rangeAnalysis.groups[0];
  if (bestRange.winRate > 35) {
    results.recommendations.push(`Best OR range: ${bestRange.name} with ${bestRange.winRate}% WR`);
  }

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('  SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Hypothesis: ${results.summary.hypothesis}`);
  console.log(`  OR Breakout Accuracy: ${breakoutAccuracy}%`);
  console.log(`  Finding: ${results.summary.finding}`);
  console.log();

  if (results.recommendations.length > 0) {
    console.log('  Recommendations:');
    results.recommendations.forEach(r => console.log(`    - ${r}`));
  }

  // Save results
  saveResults('04_opening_range.json', results);

  return results;
}

runAnalysis().catch(console.error);
