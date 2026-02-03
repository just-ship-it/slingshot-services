#!/usr/bin/env node
/**
 * Prior Day Levels Analysis
 *
 * Goal: Determine if PDH/PDL/PDC provide edge
 *
 * Analysis:
 * 1. Use session data to get PDH/PDL/PDC
 * 2. Calculate entry distance from each level
 * 3. Analyze win rate when entering near these levels
 * 4. Check if PDH/PDL act as support/resistance magnets
 * 5. Analyze gap fills (open vs PDC)
 *
 * Hypothesis: Institutional traders reference these levels heavily.
 */

import {
  loadTrades,
  loadNQOHLCV,
  getPreviousDayLevels,
  getRTHCandles
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

async function runAnalysis() {
  console.log('='.repeat(70));
  console.log('  Prior Day Levels Analysis (PDH/PDL/PDC)');
  console.log('='.repeat(70));
  console.log();

  // Load data
  console.log('Loading data...');
  const trades = await loadTrades();
  const ohlcv = await loadNQOHLCV('2025-01-01', '2025-12-31');

  console.log();

  // Analyze prior day levels at each trade entry
  const tradesWithLevels = [];

  for (const trade of trades) {
    const entryDate = new Date(trade.entryTime);
    const prevDayLevels = getPreviousDayLevels(ohlcv, entryDate);

    if (!prevDayLevels) continue;

    const entryPrice = trade.entryPrice;
    const { high: pdh, low: pdl, close: pdc } = prevDayLevels;

    // Calculate distances from each level
    const distFromPDH = entryPrice - pdh;
    const distFromPDL = entryPrice - pdl;
    const distFromPDC = entryPrice - pdc;

    // Categorize position relative to levels
    let priceZone;
    if (entryPrice > pdh) {
      priceZone = 'above_pdh';
    } else if (entryPrice < pdl) {
      priceZone = 'below_pdl';
    } else if (entryPrice > pdc) {
      priceZone = 'between_pdc_pdh';
    } else {
      priceZone = 'between_pdl_pdc';
    }

    // Check if near a level (within 10 points)
    const nearThreshold = 10;
    let nearLevel = 'none';
    if (Math.abs(distFromPDH) <= nearThreshold) nearLevel = 'near_pdh';
    else if (Math.abs(distFromPDL) <= nearThreshold) nearLevel = 'near_pdl';
    else if (Math.abs(distFromPDC) <= nearThreshold) nearLevel = 'near_pdc';

    // Get today's open to check for gap
    const todayRTH = getRTHCandles(ohlcv, entryDate);
    const todayOpen = todayRTH.length > 0 ? todayRTH[0].open : null;

    let gapType = 'no_gap';
    let gapSize = 0;
    if (todayOpen && pdc) {
      gapSize = todayOpen - pdc;
      if (gapSize > 20) gapType = 'gap_up';
      else if (gapSize < -20) gapType = 'gap_down';
    }

    tradesWithLevels.push({
      ...trade,
      pdh: round(pdh, 2),
      pdl: round(pdl, 2),
      pdc: round(pdc, 2),
      distFromPDH: round(distFromPDH, 2),
      distFromPDL: round(distFromPDL, 2),
      distFromPDC: round(distFromPDC, 2),
      priceZone,
      nearLevel,
      gapType,
      gapSize: round(gapSize, 2),
      prevDayRange: round(pdh - pdl, 2)
    });
  }

  console.log(`Analyzed prior day levels for ${tradesWithLevels.length} trades\n`);

  // Analysis 1: Performance by Price Zone
  console.log('1. Performance by Price Zone Relative to PD Levels');
  console.log('-'.repeat(50));

  const zoneAnalysis = analyzeDimension(tradesWithLevels, 'priceZone', 'Price Zone');

  zoneAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(20)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 2: Near Level Performance
  console.log('\n2. Performance When Near Key Levels (within 10 pts)');
  console.log('-'.repeat(50));

  const nearLevelAnalysis = analyzeDimension(tradesWithLevels, 'nearLevel', 'Near Level');

  nearLevelAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(15)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.totalPnL)} total`);
  });

  // Analysis 3: Distance from PDH/PDL buckets
  console.log('\n3. Performance by Distance from PDH');
  console.log('-'.repeat(50));

  const distBuckets = [
    { min: -200, max: -50, label: 'Well below PDH (>50)' },
    { min: -50, max: -20, label: '20-50 below PDH' },
    { min: -20, max: -10, label: '10-20 below PDH' },
    { min: -10, max: 0, label: 'Just below PDH (<10)' },
    { min: 0, max: 10, label: 'Just above PDH (<10)' },
    { min: 10, max: 50, label: '10-50 above PDH' },
    { min: 50, max: 200, label: 'Well above PDH (>50)' }
  ];

  const pdhDistAnalysis = analyzeDimension(
    tradesWithLevels,
    trade => bucket(trade.distFromPDH, distBuckets),
    'Distance from PDH'
  );

  pdhDistAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(25)}: ${g.tradeCount} trades, ${g.winRate}% WR`);
  });

  console.log('\n4. Performance by Distance from PDL');
  console.log('-'.repeat(50));

  const pdlDistBuckets = [
    { min: -200, max: -50, label: 'Well below PDL (>50)' },
    { min: -50, max: -10, label: '10-50 below PDL' },
    { min: -10, max: 0, label: 'Just below PDL (<10)' },
    { min: 0, max: 10, label: 'Just above PDL (<10)' },
    { min: 10, max: 20, label: '10-20 above PDL' },
    { min: 20, max: 50, label: '20-50 above PDL' },
    { min: 50, max: 200, label: 'Well above PDL (>50)' }
  ];

  const pdlDistAnalysis = analyzeDimension(
    tradesWithLevels,
    trade => bucket(trade.distFromPDL, pdlDistBuckets),
    'Distance from PDL'
  );

  pdlDistAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(25)}: ${g.tradeCount} trades, ${g.winRate}% WR`);
  });

  // Analysis 4: Gap Analysis
  console.log('\n5. Performance by Gap Type');
  console.log('-'.repeat(50));

  const gapAnalysis = analyzeDimension(tradesWithLevels, 'gapType', 'Gap Type');

  gapAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(12)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.totalPnL)} total`);
  });

  // Analysis 5: By direction near levels
  console.log('\n6. Trade Direction Analysis at Levels');
  console.log('-'.repeat(50));

  for (const level of ['near_pdh', 'near_pdl', 'near_pdc']) {
    const atLevel = tradesWithLevels.filter(t => t.nearLevel === level);
    if (atLevel.length < 5) continue;

    const longs = atLevel.filter(t => t.side === 'buy');
    const shorts = atLevel.filter(t => t.side === 'sell');

    console.log(`  ${level}:`);
    if (longs.length > 0) {
      const perf = calculatePerformance(longs);
      console.log(`    Longs:  ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.avgPnL)} avg`);
    }
    if (shorts.length > 0) {
      const perf = calculatePerformance(shorts);
      console.log(`    Shorts: ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.avgPnL)} avg`);
    }
  }

  // Analysis 6: Previous day range size impact
  console.log('\n7. Performance by Previous Day Range Size');
  console.log('-'.repeat(50));

  const rangeBuckets = [
    { min: 0, max: 100, label: 'Small (<100 pts)' },
    { min: 100, max: 200, label: 'Normal (100-200)' },
    { min: 200, max: 300, label: 'Large (200-300)' },
    { min: 300, max: 1000, label: 'Very large (>300)' }
  ];

  const rangeAnalysis = analyzeDimension(
    tradesWithLevels,
    trade => bucket(trade.prevDayRange, rangeBuckets),
    'PD Range'
  );

  rangeAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(20)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Correlations
  console.log('\n8. Correlation Analysis');
  console.log('-'.repeat(50));

  const pnls = tradesWithLevels.map(t => t.netPnL);
  const distPDH = tradesWithLevels.map(t => t.distFromPDH);
  const distPDL = tradesWithLevels.map(t => t.distFromPDL);
  const distPDC = tradesWithLevels.map(t => t.distFromPDC);
  const ranges = tradesWithLevels.map(t => t.prevDayRange);

  console.log(`  Distance from PDH vs P&L: ${correlation(distPDH, pnls)}`);
  console.log(`  Distance from PDL vs P&L: ${correlation(distPDL, pnls)}`);
  console.log(`  Distance from PDC vs P&L: ${correlation(distPDC, pnls)}`);
  console.log(`  PD Range vs P&L:          ${correlation(ranges, pnls)}`);

  // Compile results
  const results = {
    analysis: 'Prior Day Levels Analysis',
    timestamp: new Date().toISOString(),
    summary: {
      totalTrades: tradesWithLevels.length,
      hypothesis: 'Institutional traders reference PDH/PDL/PDC heavily',
      finding: 'See recommendations'
    },
    correlations: {
      distPDHvsPnL: correlation(distPDH, pnls),
      distPDLvsPnL: correlation(distPDL, pnls),
      distPDCvsPnL: correlation(distPDC, pnls),
      pdRangevsPnL: correlation(ranges, pnls)
    },
    byPriceZone: zoneAnalysis.groups,
    byNearLevel: nearLevelAnalysis.groups,
    byDistFromPDH: pdhDistAnalysis.groups,
    byDistFromPDL: pdlDistAnalysis.groups,
    byGapType: gapAnalysis.groups,
    byPDRange: rangeAnalysis.groups,
    recommendations: []
  };

  // Generate recommendations
  const nearLevelGroups = nearLevelAnalysis.groups;
  const bestNearLevel = nearLevelGroups.reduce((best, g) =>
    g.totalPnL > best.totalPnL ? g : best, nearLevelGroups[0]);

  if (bestNearLevel.name !== 'none' && bestNearLevel.winRate > 30) {
    results.recommendations.push(`Best performance near ${bestNearLevel.name}: ${bestNearLevel.winRate}% WR`);
  }

  const bestZone = zoneAnalysis.groups[0];
  if (bestZone.winRate > 30) {
    results.recommendations.push(`Best price zone: ${bestZone.name} with ${bestZone.winRate}% WR`);
  }

  // Determine finding
  const nearLevelTrades = tradesWithLevels.filter(t => t.nearLevel !== 'none');
  const awayTrades = tradesWithLevels.filter(t => t.nearLevel === 'none');

  if (nearLevelTrades.length > 20 && awayTrades.length > 20) {
    const nearWR = calculatePerformance(nearLevelTrades).winRate;
    const awayWR = calculatePerformance(awayTrades).winRate;

    if (nearWR > awayWR + 3) {
      results.summary.finding = 'SUPPORTED - Trades near PD levels outperform';
    } else if (awayWR > nearWR + 3) {
      results.summary.finding = 'CONTRADICTED - Trades away from PD levels outperform';
    } else {
      results.summary.finding = 'INCONCLUSIVE - No clear PD level edge';
    }
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
  saveResults('03_prior_day_levels.json', results);

  return results;
}

runAnalysis().catch(console.error);
