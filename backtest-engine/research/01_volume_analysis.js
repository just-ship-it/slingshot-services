#!/usr/bin/env node
/**
 * Volume Confirmation Analysis
 *
 * Goal: Determine if volume at entry predicts trade outcome
 *
 * Analysis:
 * 1. Calculate average volume over prior 20 candles at entry time
 * 2. Classify entries as high/low volume relative to average
 * 3. Correlate volume ratio with win rate and P&L
 * 4. Check if winners have volume "confirmation" (above average)
 * 5. Analyze volume spike patterns before successful moves
 *
 * Hypothesis: Winners should have above-average volume confirming the move.
 */

import {
  loadTrades,
  loadNQOHLCV,
  getCandlesAround,
  calculateAverageVolume
} from './utils/data-loader.js';

import {
  calculatePerformance,
  groupTrades,
  bucket,
  correlation,
  round,
  saveResults,
  analyzeDimension,
  formatCurrency,
  formatPercent
} from './utils/analysis-helpers.js';

const VOLUME_LOOKBACK = 20; // Candles to average

async function runAnalysis() {
  console.log('='.repeat(70));
  console.log('  Volume Confirmation Analysis');
  console.log('='.repeat(70));
  console.log();

  // Load data
  console.log('Loading data...');
  const trades = await loadTrades();
  const ohlcv = await loadNQOHLCV('2025-01-01', '2025-12-31');
  const candleArray = Array.from(ohlcv.values()).sort((a, b) => a.timestamp - b.timestamp);

  console.log();

  // Analyze volume at each trade entry
  const tradesWithVolume = [];

  for (const trade of trades) {
    const entryCandles = getCandlesAround(ohlcv, trade.entryTime, VOLUME_LOOKBACK, 0);

    if (entryCandles.length < VOLUME_LOOKBACK) {
      continue;
    }

    // Entry candle is the last one
    const entryCandle = entryCandles[entryCandles.length - 1];
    const priorCandles = entryCandles.slice(0, -1);

    // Calculate average volume over prior candles
    const avgVolume = calculateAverageVolume(priorCandles, VOLUME_LOOKBACK - 1);
    const entryVolume = entryCandle.volume;

    if (!avgVolume || avgVolume === 0) continue;

    const volumeRatio = entryVolume / avgVolume;

    tradesWithVolume.push({
      ...trade,
      entryVolume,
      avgVolume: round(avgVolume, 0),
      volumeRatio: round(volumeRatio, 2),
      volumeCategory: volumeRatio >= 1.5 ? 'high' : volumeRatio >= 1.0 ? 'normal' : 'low'
    });
  }

  console.log(`Analyzed volume for ${tradesWithVolume.length} trades\n`);

  // Analysis 1: Volume Category Performance
  console.log('1. Performance by Volume Category');
  console.log('-'.repeat(50));

  const volumeCatAnalysis = analyzeDimension(tradesWithVolume, 'volumeCategory', 'Volume Category');

  volumeCatAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(10)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.totalPnL)} total`);
  });

  // Analysis 2: Volume Ratio Buckets
  console.log('\n2. Performance by Volume Ratio');
  console.log('-'.repeat(50));

  const volumeBuckets = [
    { min: 0, max: 0.5, label: '<0.5x (very low)' },
    { min: 0.5, max: 0.75, label: '0.5-0.75x (low)' },
    { min: 0.75, max: 1.0, label: '0.75-1x (below avg)' },
    { min: 1.0, max: 1.25, label: '1-1.25x (normal)' },
    { min: 1.25, max: 1.5, label: '1.25-1.5x (above avg)' },
    { min: 1.5, max: 2.0, label: '1.5-2x (high)' },
    { min: 2.0, max: 100, label: '>2x (spike)' }
  ];

  const volumeRatioAnalysis = analyzeDimension(
    tradesWithVolume,
    trade => bucket(trade.volumeRatio, volumeBuckets),
    'Volume Ratio'
  );

  volumeRatioAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(20)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 3: Correlation between volume ratio and P&L
  console.log('\n3. Volume-Performance Correlation');
  console.log('-'.repeat(50));

  const volumeRatios = tradesWithVolume.map(t => t.volumeRatio);
  const pnls = tradesWithVolume.map(t => t.netPnL);
  const winIndicator = tradesWithVolume.map(t => t.netPnL > 0 ? 1 : 0);

  const volumePnlCorr = correlation(volumeRatios, pnls);
  const volumeWinCorr = correlation(volumeRatios, winIndicator);

  console.log(`  Volume Ratio vs P&L correlation:      ${volumePnlCorr}`);
  console.log(`  Volume Ratio vs Win/Loss correlation: ${volumeWinCorr}`);

  // Analysis 4: Volume spikes before big moves
  console.log('\n4. Volume Spike Analysis (Pre-Entry)');
  console.log('-'.repeat(50));

  const spikeThreshold = 2.0; // 2x average = spike
  const tradesWithSpikes = [];

  for (const trade of tradesWithVolume) {
    const entryCandles = getCandlesAround(ohlcv, trade.entryTime, 10, 0);

    if (entryCandles.length < 10) continue;

    // Check for volume spike in last 5 candles before entry
    const recentCandles = entryCandles.slice(-5);
    const avgVol = trade.avgVolume;

    const hadSpike = recentCandles.some(c => c.volume >= avgVol * spikeThreshold);
    const spikeCount = recentCandles.filter(c => c.volume >= avgVol * spikeThreshold).length;

    tradesWithSpikes.push({
      ...trade,
      hadPreEntrySpike: hadSpike,
      preEntrySpikeCount: spikeCount
    });
  }

  const spikeAnalysis = analyzeDimension(tradesWithSpikes, 'hadPreEntrySpike', 'Pre-Entry Spike');

  spikeAnalysis.groups.forEach(g => {
    const label = g.name === 'true' ? 'With spike' : 'No spike';
    console.log(`  ${label.padEnd(15)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 5: Winners vs Losers Volume Comparison
  console.log('\n5. Winners vs Losers Volume Profile');
  console.log('-'.repeat(50));

  const winners = tradesWithVolume.filter(t => t.netPnL > 0);
  const losers = tradesWithVolume.filter(t => t.netPnL <= 0);

  const winnerAvgVolRatio = winners.length > 0
    ? round(winners.reduce((s, t) => s + t.volumeRatio, 0) / winners.length, 2)
    : 0;
  const loserAvgVolRatio = losers.length > 0
    ? round(losers.reduce((s, t) => s + t.volumeRatio, 0) / losers.length, 2)
    : 0;

  console.log(`  Winners average volume ratio: ${winnerAvgVolRatio}x`);
  console.log(`  Losers average volume ratio:  ${loserAvgVolRatio}x`);
  console.log(`  Difference: ${round(winnerAvgVolRatio - loserAvgVolRatio, 2)}x`);

  // Analysis 6: By trade direction
  console.log('\n6. Volume Analysis by Trade Direction');
  console.log('-'.repeat(50));

  const longTrades = tradesWithVolume.filter(t => t.side === 'buy');
  const shortTrades = tradesWithVolume.filter(t => t.side === 'sell');

  for (const [label, subset] of [['Longs', longTrades], ['Shorts', shortTrades]]) {
    const highVol = subset.filter(t => t.volumeCategory === 'high');
    const normalVol = subset.filter(t => t.volumeCategory === 'normal');
    const lowVol = subset.filter(t => t.volumeCategory === 'low');

    console.log(`  ${label}:`);
    if (highVol.length > 0) {
      const perf = calculatePerformance(highVol);
      console.log(`    High volume:   ${perf.tradeCount} trades, ${perf.winRate}% WR`);
    }
    if (normalVol.length > 0) {
      const perf = calculatePerformance(normalVol);
      console.log(`    Normal volume: ${perf.tradeCount} trades, ${perf.winRate}% WR`);
    }
    if (lowVol.length > 0) {
      const perf = calculatePerformance(lowVol);
      console.log(`    Low volume:    ${perf.tradeCount} trades, ${perf.winRate}% WR`);
    }
  }

  // Compile results
  const results = {
    analysis: 'Volume Confirmation Analysis',
    timestamp: new Date().toISOString(),
    summary: {
      totalTrades: tradesWithVolume.length,
      hypothesis: 'Winners should have above-average volume confirming the move',
      finding: volumePnlCorr > 0.1 ? 'SUPPORTED' : volumePnlCorr < -0.1 ? 'CONTRADICTED' : 'INCONCLUSIVE'
    },
    correlations: {
      volumeRatioPnL: volumePnlCorr,
      volumeRatioWin: volumeWinCorr
    },
    byVolumeCategory: volumeCatAnalysis.groups,
    byVolumeRatio: volumeRatioAnalysis.groups,
    preEntrySpikeAnalysis: spikeAnalysis.groups,
    winnerVsLoser: {
      winnerAvgVolumeRatio: winnerAvgVolRatio,
      loserAvgVolumeRatio: loserAvgVolRatio,
      difference: round(winnerAvgVolRatio - loserAvgVolRatio, 2)
    },
    recommendations: []
  };

  // Generate recommendations
  if (volumePnlCorr > 0.1) {
    results.recommendations.push('Consider filtering for higher volume entries (>1.25x average)');
  }
  if (volumePnlCorr < -0.1) {
    results.recommendations.push('Consider filtering for lower volume entries - high volume may indicate late entry');
  }

  const bestVolBucket = volumeRatioAnalysis.groups[0];
  if (bestVolBucket.winRate > volumeRatioAnalysis.groups[volumeRatioAnalysis.groups.length - 1].winRate + 5) {
    results.recommendations.push(`Best volume bucket: ${bestVolBucket.name} (${bestVolBucket.winRate}% WR)`);
  }

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('  SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Hypothesis: ${results.summary.hypothesis}`);
  console.log(`  Finding: ${results.summary.finding}`);
  console.log(`  Volume-P&L Correlation: ${volumePnlCorr}`);
  console.log();

  if (results.recommendations.length > 0) {
    console.log('  Recommendations:');
    results.recommendations.forEach(r => console.log(`    - ${r}`));
  }

  // Save results
  saveResults('01_volume_analysis.json', results);

  return results;
}

runAnalysis().catch(console.error);
