#!/usr/bin/env node
/**
 * VWAP Analysis
 *
 * Goal: Determine if VWAP provides predictive edge
 *
 * Analysis:
 * 1. Build VWAP calculator (session-based, reset at 6 PM ET)
 * 2. Calculate entry distance from VWAP
 * 3. Analyze win rate by VWAP position (above/below/at)
 * 4. Check if VWAP acts as support/resistance
 * 5. Analyze VWAP deviation at entry (standard deviation bands)
 *
 * Hypothesis: Entries near VWAP or after VWAP tests should outperform.
 */

import {
  loadTrades,
  loadNQOHLCV,
  getCandlesAround
} from './utils/data-loader.js';

import {
  calculateSessionVWAP,
  getVWAPAtTime,
  analyzeVWAPPosition
} from './utils/vwap-calculator.js';

import {
  calculatePerformance,
  bucket,
  correlation,
  round,
  saveResults,
  analyzeDimension,
  formatCurrency
} from './utils/analysis-helpers.js';

async function runAnalysis() {
  console.log('='.repeat(70));
  console.log('  VWAP Analysis');
  console.log('='.repeat(70));
  console.log();

  // Load data
  console.log('Loading data...');
  const trades = await loadTrades();
  const ohlcv = await loadNQOHLCV('2025-01-01', '2025-12-31');

  console.log('Calculating session VWAP...');
  const vwapMap = calculateSessionVWAP(ohlcv);
  console.log(`Calculated VWAP for ${vwapMap.size.toLocaleString()} timestamps\n`);

  // Analyze VWAP at each trade entry
  const tradesWithVwap = [];

  for (const trade of trades) {
    const vwapData = getVWAPAtTime(vwapMap, trade.entryTime);

    if (!vwapData || !vwapData.vwap) continue;

    const analysis = analyzeVWAPPosition(trade.entryPrice, vwapData);

    if (!analysis) continue;

    tradesWithVwap.push({
      ...trade,
      vwap: round(vwapData.vwap, 2),
      vwapDistance: round(analysis.distance, 2),
      vwapDistancePercent: round(analysis.distancePercent, 3),
      vwapStdDevs: round(analysis.stdDevs, 2),
      vwapPosition: analysis.position,
      isAboveVwap: analysis.isAbove,
      isAtVwap: analysis.isAtVwap
    });
  }

  console.log(`Analyzed VWAP for ${tradesWithVwap.length} trades\n`);

  // Analysis 1: VWAP Position Performance
  console.log('1. Performance by VWAP Position');
  console.log('-'.repeat(50));

  const positionAnalysis = analyzeDimension(tradesWithVwap, 'vwapPosition', 'VWAP Position');

  positionAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(18)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 2: Above/Below VWAP
  console.log('\n2. Performance Above vs Below VWAP');
  console.log('-'.repeat(50));

  const aboveBelowAnalysis = analyzeDimension(tradesWithVwap, 'isAboveVwap', 'Above VWAP');

  aboveBelowAnalysis.groups.forEach(g => {
    const label = g.name === 'true' ? 'Above VWAP' : 'Below VWAP';
    console.log(`  ${label.padEnd(15)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.totalPnL)} total`);
  });

  // Analysis 3: At VWAP (within 0.5 std dev)
  console.log('\n3. Performance At VWAP vs Away');
  console.log('-'.repeat(50));

  const atVwapAnalysis = analyzeDimension(tradesWithVwap, 'isAtVwap', 'At VWAP');

  atVwapAnalysis.groups.forEach(g => {
    const label = g.name === 'true' ? 'At VWAP' : 'Away from VWAP';
    console.log(`  ${label.padEnd(18)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 4: Distance from VWAP (by std devs)
  console.log('\n4. Performance by Standard Deviations from VWAP');
  console.log('-'.repeat(50));

  const stdDevBuckets = [
    { min: -100, max: -2, label: '<-2 std (oversold)' },
    { min: -2, max: -1, label: '-2 to -1 std' },
    { min: -1, max: -0.5, label: '-1 to -0.5 std' },
    { min: -0.5, max: 0.5, label: 'At VWAP (+/-0.5)' },
    { min: 0.5, max: 1, label: '+0.5 to +1 std' },
    { min: 1, max: 2, label: '+1 to +2 std' },
    { min: 2, max: 100, label: '>+2 std (overbought)' }
  ];

  const stdDevAnalysis = analyzeDimension(
    tradesWithVwap,
    trade => bucket(trade.vwapStdDevs, stdDevBuckets),
    'VWAP Std Devs'
  );

  stdDevAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(22)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 5: By trade direction
  console.log('\n5. VWAP Analysis by Trade Direction');
  console.log('-'.repeat(50));

  for (const direction of ['buy', 'sell']) {
    const subset = tradesWithVwap.filter(t => t.side === direction);
    const above = subset.filter(t => t.isAboveVwap);
    const below = subset.filter(t => !t.isAboveVwap);

    console.log(`  ${direction.toUpperCase()}S:`);

    if (above.length > 0) {
      const perf = calculatePerformance(above);
      console.log(`    Above VWAP: ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.totalPnL)}`);
    }
    if (below.length > 0) {
      const perf = calculatePerformance(below);
      console.log(`    Below VWAP: ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.totalPnL)}`);
    }
  }

  // Analysis 6: Correlation
  console.log('\n6. Correlation Analysis');
  console.log('-'.repeat(50));

  const vwapDistances = tradesWithVwap.map(t => t.vwapDistance);
  const vwapStdDevs = tradesWithVwap.map(t => t.vwapStdDevs);
  const pnls = tradesWithVwap.map(t => t.netPnL);
  const winIndicator = tradesWithVwap.map(t => t.netPnL > 0 ? 1 : 0);

  const distancePnlCorr = correlation(vwapDistances, pnls);
  const distanceWinCorr = correlation(vwapDistances, winIndicator);
  const stdDevPnlCorr = correlation(vwapStdDevs.map(Math.abs), pnls);

  console.log(`  VWAP Distance vs P&L correlation:  ${distancePnlCorr}`);
  console.log(`  VWAP Distance vs Win correlation:  ${distanceWinCorr}`);
  console.log(`  Abs(Std Devs) vs P&L correlation:  ${stdDevPnlCorr}`);

  // Analysis 7: Optimal entry zones
  console.log('\n7. Optimal VWAP Entry Zones');
  console.log('-'.repeat(50));

  // Find the best performing buckets
  const sortedByWinRate = [...stdDevAnalysis.groups].sort((a, b) => b.winRate - a.winRate);
  const sortedByPnL = [...stdDevAnalysis.groups].sort((a, b) => b.totalPnL - a.totalPnL);

  console.log('  Best by Win Rate:');
  sortedByWinRate.slice(0, 3).forEach((g, i) => {
    console.log(`    ${i + 1}. ${g.name}: ${g.winRate}% WR (${g.tradeCount} trades)`);
  });

  console.log('  Best by Total P&L:');
  sortedByPnL.slice(0, 3).forEach((g, i) => {
    console.log(`    ${i + 1}. ${g.name}: ${formatCurrency(g.totalPnL)} (${g.tradeCount} trades)`);
  });

  // Compile results
  const results = {
    analysis: 'VWAP Analysis',
    timestamp: new Date().toISOString(),
    summary: {
      totalTrades: tradesWithVwap.length,
      hypothesis: 'Entries near VWAP or after VWAP tests should outperform',
      finding: 'See analysis below'
    },
    correlations: {
      vwapDistancePnL: distancePnlCorr,
      vwapDistanceWin: distanceWinCorr,
      absStdDevsPnL: stdDevPnlCorr
    },
    byPosition: positionAnalysis.groups,
    byAboveBelow: aboveBelowAnalysis.groups,
    byAtVwap: atVwapAnalysis.groups,
    byStdDevs: stdDevAnalysis.groups,
    optimalZones: {
      byWinRate: sortedByWinRate.slice(0, 3).map(g => ({
        zone: g.name,
        winRate: g.winRate,
        trades: g.tradeCount
      })),
      byPnL: sortedByPnL.slice(0, 3).map(g => ({
        zone: g.name,
        totalPnL: g.totalPnL,
        trades: g.tradeCount
      }))
    },
    recommendations: []
  };

  // Generate recommendations
  const atVwapPerf = tradesWithVwap.filter(t => t.isAtVwap);
  const awayPerf = tradesWithVwap.filter(t => !t.isAtVwap);

  if (atVwapPerf.length > 0 && awayPerf.length > 0) {
    const atVwapWR = calculatePerformance(atVwapPerf).winRate;
    const awayWR = calculatePerformance(awayPerf).winRate;

    if (atVwapWR > awayWR + 5) {
      results.recommendations.push(`Entries at VWAP (+/- 0.5 std) outperform: ${atVwapWR}% vs ${awayWR}%`);
    }
  }

  if (sortedByWinRate[0].winRate > 35) {
    results.recommendations.push(`Best VWAP zone: ${sortedByWinRate[0].name} with ${sortedByWinRate[0].winRate}% WR`);
  }

  // Determine finding
  const atVwapGroup = atVwapAnalysis.groups.find(g => g.name === 'true');
  const awayGroup = atVwapAnalysis.groups.find(g => g.name === 'false');

  if (atVwapGroup && awayGroup && atVwapGroup.winRate > awayGroup.winRate + 3) {
    results.summary.finding = 'SUPPORTED - Entries near VWAP outperform';
  } else if (atVwapGroup && awayGroup && awayGroup.winRate > atVwapGroup.winRate + 3) {
    results.summary.finding = 'CONTRADICTED - Entries away from VWAP outperform';
  } else {
    results.summary.finding = 'INCONCLUSIVE - No clear VWAP edge detected';
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
  saveResults('02_vwap_analysis.json', results);

  return results;
}

runAnalysis().catch(console.error);
