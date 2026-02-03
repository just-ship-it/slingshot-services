#!/usr/bin/env node
/**
 * Price Momentum at Entry Analysis
 *
 * Goal: Determine if recent price momentum predicts outcome
 *
 * Analysis:
 * 1. Calculate price change over last 5, 10, 20 candles at entry
 * 2. Classify as trending up, trending down, or ranging
 * 3. Calculate rate of change (ROC) at entry
 * 4. Correlate momentum metrics with win rate
 * 5. Find optimal momentum conditions for long vs short
 *
 * Hypothesis: Entries with price momentum in trade direction outperform.
 */

import {
  loadTrades,
  loadNQOHLCV,
  getCandlesAround
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

async function runAnalysis() {
  console.log('='.repeat(70));
  console.log('  Price Momentum at Entry Analysis');
  console.log('='.repeat(70));
  console.log();

  // Load data
  console.log('Loading data...');
  const trades = await loadTrades();
  const ohlcv = await loadNQOHLCV('2025-01-01', '2025-12-31');

  console.log();

  // Analyze price momentum at each trade entry
  const tradesWithMomentum = [];

  for (const trade of trades) {
    const candles = getCandlesAround(ohlcv, trade.entryTime, 25, 0);

    if (candles.length < 25) continue;

    const closes = candles.map(c => c.close);

    // Calculate ROC at different periods
    const roc5 = roc(closes, 5);
    const roc10 = roc(closes, 10);
    const roc20 = roc(closes, 20);

    if (roc5 === null || roc10 === null || roc20 === null) continue;

    // Calculate price changes in points
    const change5 = closes[closes.length - 1] - closes[closes.length - 6];
    const change10 = closes[closes.length - 1] - closes[closes.length - 11];
    const change20 = closes[closes.length - 1] - closes[closes.length - 21];

    // Classify momentum state
    let momentum5State = 'neutral';
    if (roc5 > 0.2) momentum5State = 'bullish';
    else if (roc5 < -0.2) momentum5State = 'bearish';

    let momentum10State = 'neutral';
    if (roc10 > 0.3) momentum10State = 'bullish';
    else if (roc10 < -0.3) momentum10State = 'bearish';

    // Combined momentum
    let combinedMomentum = 'ranging';
    if (momentum5State === 'bullish' && momentum10State === 'bullish') {
      combinedMomentum = 'strong_bullish';
    } else if (momentum5State === 'bearish' && momentum10State === 'bearish') {
      combinedMomentum = 'strong_bearish';
    } else if (momentum5State === 'bullish' || momentum10State === 'bullish') {
      combinedMomentum = 'weak_bullish';
    } else if (momentum5State === 'bearish' || momentum10State === 'bearish') {
      combinedMomentum = 'weak_bearish';
    }

    // Momentum alignment with trade
    let momentumAlignment = 'neutral';
    if ((combinedMomentum.includes('bullish') && trade.side === 'buy') ||
        (combinedMomentum.includes('bearish') && trade.side === 'sell')) {
      momentumAlignment = 'aligned';
    } else if ((combinedMomentum.includes('bullish') && trade.side === 'sell') ||
               (combinedMomentum.includes('bearish') && trade.side === 'buy')) {
      momentumAlignment = 'counter';
    }

    // Trend strength (volatility-adjusted)
    const recentCandles = candles.slice(-20);
    const ranges = recentCandles.map(c => c.high - c.low);
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const trendStrength = Math.abs(change20) / (avgRange * 20);

    let strengthCategory = 'weak';
    if (trendStrength > 0.3) strengthCategory = 'strong';
    else if (trendStrength > 0.15) strengthCategory = 'moderate';

    tradesWithMomentum.push({
      ...trade,
      roc5: round(roc5, 2),
      roc10: round(roc10, 2),
      roc20: round(roc20, 2),
      change5: round(change5, 2),
      change10: round(change10, 2),
      change20: round(change20, 2),
      momentum5State,
      momentum10State,
      combinedMomentum,
      momentumAlignment,
      trendStrength: round(trendStrength, 3),
      strengthCategory
    });
  }

  console.log(`Analyzed price momentum for ${tradesWithMomentum.length} trades\n`);

  // Analysis 1: Combined Momentum Performance
  console.log('1. Performance by Combined Momentum');
  console.log('-'.repeat(50));

  const combinedAnalysis = analyzeDimension(tradesWithMomentum, 'combinedMomentum', 'Combined Momentum');

  combinedAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(18)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 2: Momentum Alignment Performance
  console.log('\n2. Performance by Momentum Alignment');
  console.log('-'.repeat(50));

  const alignAnalysis = analyzeDimension(tradesWithMomentum, 'momentumAlignment', 'Momentum Alignment');

  alignAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(12)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.totalPnL)} total`);
  });

  // Analysis 3: ROC Buckets
  console.log('\n3. Performance by 5-Candle ROC');
  console.log('-'.repeat(50));

  const rocBuckets = [
    { min: -5, max: -0.5, label: 'Strong down (<-0.5%)' },
    { min: -0.5, max: -0.2, label: 'Moderate down (-0.5 to -0.2%)' },
    { min: -0.2, max: 0.2, label: 'Flat (-0.2 to 0.2%)' },
    { min: 0.2, max: 0.5, label: 'Moderate up (0.2 to 0.5%)' },
    { min: 0.5, max: 5, label: 'Strong up (>0.5%)' }
  ];

  const roc5Analysis = analyzeDimension(
    tradesWithMomentum,
    trade => bucket(trade.roc5, rocBuckets),
    '5-Candle ROC'
  );

  roc5Analysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(28)}: ${g.tradeCount} trades, ${g.winRate}% WR`);
  });

  // Analysis 4: Trend Strength Impact
  console.log('\n4. Performance by Trend Strength');
  console.log('-'.repeat(50));

  const strengthAnalysis = analyzeDimension(tradesWithMomentum, 'strengthCategory', 'Trend Strength');

  strengthAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(12)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 5: Direction-specific analysis
  console.log('\n5. Price Momentum by Trade Direction');
  console.log('-'.repeat(50));

  for (const direction of ['buy', 'sell']) {
    const subset = tradesWithMomentum.filter(t => t.side === direction);

    console.log(`  ${direction.toUpperCase()}S:`);

    for (const mom of ['strong_bullish', 'weak_bullish', 'ranging', 'weak_bearish', 'strong_bearish']) {
      const momSubset = subset.filter(t => t.combinedMomentum === mom);
      if (momSubset.length >= 10) {
        const perf = calculatePerformance(momSubset);
        console.log(`    ${mom.padEnd(18)}: ${perf.tradeCount} trades, ${perf.winRate}% WR`);
      }
    }
  }

  // Analysis 6: Recent vs Longer-term momentum
  console.log('\n6. Short-term vs Long-term Momentum Agreement');
  console.log('-'.repeat(50));

  const agreeing = tradesWithMomentum.filter(t =>
    (t.roc5 > 0 && t.roc20 > 0) || (t.roc5 < 0 && t.roc20 < 0)
  );
  const disagreeing = tradesWithMomentum.filter(t =>
    (t.roc5 > 0 && t.roc20 < 0) || (t.roc5 < 0 && t.roc20 > 0)
  );

  if (agreeing.length >= 10) {
    const perf = calculatePerformance(agreeing);
    console.log(`  Short & Long agree:    ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.avgPnL)} avg`);
  }
  if (disagreeing.length >= 10) {
    const perf = calculatePerformance(disagreeing);
    console.log(`  Short & Long disagree: ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.avgPnL)} avg`);
  }

  // Analysis 7: Correlation
  console.log('\n7. Correlation Analysis');
  console.log('-'.repeat(50));

  const roc5s = tradesWithMomentum.map(t => t.roc5);
  const roc10s = tradesWithMomentum.map(t => t.roc10);
  const roc20s = tradesWithMomentum.map(t => t.roc20);
  const pnls = tradesWithMomentum.map(t => t.netPnL);
  const strengths = tradesWithMomentum.map(t => t.trendStrength);

  console.log(`  ROC(5) vs P&L:         ${correlation(roc5s, pnls)}`);
  console.log(`  ROC(10) vs P&L:        ${correlation(roc10s, pnls)}`);
  console.log(`  ROC(20) vs P&L:        ${correlation(roc20s, pnls)}`);
  console.log(`  Trend Strength vs P&L: ${correlation(strengths, pnls)}`);

  // Analysis 8: Optimal conditions by direction
  console.log('\n8. Optimal Momentum Conditions by Direction');
  console.log('-'.repeat(50));

  // For longs
  const longTrades = tradesWithMomentum.filter(t => t.side === 'buy');
  const longByRoc = {};

  for (const bucket of rocBuckets) {
    const trades = longTrades.filter(t => t.roc5 >= bucket.min && t.roc5 < bucket.max);
    if (trades.length >= 10) {
      longByRoc[bucket.label] = calculatePerformance(trades);
    }
  }

  console.log('  Best ROC(5) for LONGS:');
  const sortedLongRoc = Object.entries(longByRoc).sort((a, b) => b[1].winRate - a[1].winRate);
  sortedLongRoc.slice(0, 2).forEach(([label, perf]) => {
    console.log(`    ${label}: ${perf.winRate}% WR (${perf.tradeCount} trades)`);
  });

  // For shorts
  const shortTrades = tradesWithMomentum.filter(t => t.side === 'sell');
  const shortByRoc = {};

  for (const bucket of rocBuckets) {
    const trades = shortTrades.filter(t => t.roc5 >= bucket.min && t.roc5 < bucket.max);
    if (trades.length >= 10) {
      shortByRoc[bucket.label] = calculatePerformance(trades);
    }
  }

  console.log('  Best ROC(5) for SHORTS:');
  const sortedShortRoc = Object.entries(shortByRoc).sort((a, b) => b[1].winRate - a[1].winRate);
  sortedShortRoc.slice(0, 2).forEach(([label, perf]) => {
    console.log(`    ${label}: ${perf.winRate}% WR (${perf.tradeCount} trades)`);
  });

  // Compile results
  const results = {
    analysis: 'Price Momentum at Entry Analysis',
    timestamp: new Date().toISOString(),
    summary: {
      totalTrades: tradesWithMomentum.length,
      hypothesis: 'Entries with price momentum in trade direction outperform',
      finding: 'See recommendations'
    },
    correlations: {
      roc5VsPnL: correlation(roc5s, pnls),
      roc10VsPnL: correlation(roc10s, pnls),
      roc20VsPnL: correlation(roc20s, pnls),
      trendStrengthVsPnL: correlation(strengths, pnls)
    },
    byCombinedMomentum: combinedAnalysis.groups,
    byMomentumAlignment: alignAnalysis.groups,
    byROC5: roc5Analysis.groups,
    byTrendStrength: strengthAnalysis.groups,
    recommendations: []
  };

  // Generate recommendations
  const alignedPerf = alignAnalysis.groups.find(g => g.name === 'aligned');
  const counterPerf = alignAnalysis.groups.find(g => g.name === 'counter');

  if (alignedPerf && counterPerf && alignedPerf.winRate > counterPerf.winRate + 5) {
    results.summary.finding = 'SUPPORTED - Momentum aligned trades outperform';
    results.recommendations.push(`Trade with momentum: ${alignedPerf.winRate}% vs ${counterPerf.winRate}% WR`);
  } else if (alignedPerf && counterPerf && counterPerf.winRate > alignedPerf.winRate + 5) {
    results.summary.finding = 'CONTRADICTED - Counter-momentum (mean reversion) outperforms';
    results.recommendations.push(`Consider mean reversion entries: ${counterPerf.winRate}% vs ${alignedPerf.winRate}% WR`);
  } else {
    results.summary.finding = 'INCONCLUSIVE - No clear momentum edge';
  }

  const bestCombined = combinedAnalysis.groups[0];
  if (bestCombined.winRate > 35) {
    results.recommendations.push(`Best momentum state: ${bestCombined.name} with ${bestCombined.winRate}% WR`);
  }

  if (sortedLongRoc.length > 0) {
    results.recommendations.push(`Best ROC for longs: ${sortedLongRoc[0][0]} (${sortedLongRoc[0][1].winRate}% WR)`);
  }
  if (sortedShortRoc.length > 0) {
    results.recommendations.push(`Best ROC for shorts: ${sortedShortRoc[0][0]} (${sortedShortRoc[0][1].winRate}% WR)`);
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
  saveResults('08_price_momentum.json', results);

  return results;
}

runAnalysis().catch(console.error);
