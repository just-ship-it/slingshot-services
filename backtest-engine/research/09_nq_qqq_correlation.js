#!/usr/bin/env node
/**
 * NQ/QQQ Correlation Analysis
 *
 * Goal: Determine if NQ-QQQ divergence predicts moves
 *
 * Analysis:
 * 1. Load QQQ 1-minute data alongside NQ
 * 2. Calculate NQ/QQQ ratio at entry
 * 3. Track divergences (NQ up, QQQ down or vice versa)
 * 4. Correlate divergence with trade outcome
 * 5. Check if divergence resolution direction is predictable
 *
 * Hypothesis: Divergences resolve, providing trading edge.
 */

import {
  loadTrades,
  loadNQOHLCV,
  loadQQQOHLCV,
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
  console.log('  NQ/QQQ Correlation Analysis');
  console.log('='.repeat(70));
  console.log();

  // Load data
  console.log('Loading data...');
  const trades = await loadTrades();
  const nqOhlcv = await loadNQOHLCV('2025-01-01', '2025-12-31');
  const qqqOhlcv = await loadQQQOHLCV('2025-01-01', '2025-12-31');

  console.log();

  // Convert to arrays for easier processing
  const nqArray = Array.from(nqOhlcv.values()).sort((a, b) => a.timestamp - b.timestamp);
  const qqqArray = Array.from(qqqOhlcv.values()).sort((a, b) => a.timestamp - b.timestamp);

  // Build timestamp -> QQQ lookup
  const qqqByTime = new Map();
  qqqArray.forEach(c => qqqByTime.set(c.timestamp, c));

  // Analyze NQ/QQQ relationship at each trade entry
  const tradesWithCorrelation = [];

  for (const trade of trades) {
    // Get NQ candles around entry
    const nqCandles = getCandlesAround(nqOhlcv, trade.entryTime, 20, 0);
    if (nqCandles.length < 20) continue;

    // Get corresponding QQQ candles
    const qqqCandles = [];
    let hasQQQData = true;

    for (const nqCandle of nqCandles) {
      // Find QQQ candle at same timestamp (or closest)
      let qqqCandle = qqqByTime.get(nqCandle.timestamp);

      // If no exact match, try within 1 minute
      if (!qqqCandle) {
        for (let offset = -60000; offset <= 60000; offset += 60000) {
          qqqCandle = qqqByTime.get(nqCandle.timestamp + offset);
          if (qqqCandle) break;
        }
      }

      if (qqqCandle) {
        qqqCandles.push(qqqCandle);
      } else {
        hasQQQData = false;
        break;
      }
    }

    if (!hasQQQData || qqqCandles.length < 20) continue;

    // Calculate ROC for both
    const nqCloses = nqCandles.map(c => c.close);
    const qqqCloses = qqqCandles.map(c => c.close);

    const nqRoc5 = roc(nqCloses, 5);
    const qqqRoc5 = roc(qqqCloses, 5);
    const nqRoc10 = roc(nqCloses, 10);
    const qqqRoc10 = roc(qqqCloses, 10);

    if (nqRoc5 === null || qqqRoc5 === null) continue;

    // Calculate NQ/QQQ ratio
    const nqPrice = nqCandles[nqCandles.length - 1].close;
    const qqqPrice = qqqCandles[qqqCandles.length - 1].close;
    const ratio = nqPrice / qqqPrice;

    // Calculate ratio change
    const prevRatio = nqCandles[nqCandles.length - 6].close / qqqCandles[qqqCandles.length - 6].close;
    const ratioChange = ratio - prevRatio;
    const ratioChangePercent = (ratioChange / prevRatio) * 100;

    // Detect divergence
    let divergence = 'none';
    const threshold = 0.1; // 0.1% divergence threshold

    if (nqRoc5 > threshold && qqqRoc5 < -threshold) {
      divergence = 'nq_leading_up'; // NQ up, QQQ down
    } else if (nqRoc5 < -threshold && qqqRoc5 > threshold) {
      divergence = 'qqq_leading_up'; // QQQ up, NQ down
    } else if (nqRoc5 > qqqRoc5 + threshold) {
      divergence = 'nq_outperforming'; // Both same direction but NQ stronger
    } else if (qqqRoc5 > nqRoc5 + threshold) {
      divergence = 'qqq_outperforming'; // Both same direction but QQQ stronger
    } else {
      divergence = 'in_sync';
    }

    // Categorize ratio level
    let ratioZone = 'normal';
    if (ratio > 82) ratioZone = 'high_nq';
    else if (ratio < 78) ratioZone = 'low_nq';

    // Divergence alignment with trade
    let divAlignment = 'neutral';
    if ((divergence === 'nq_leading_up' || divergence === 'nq_outperforming') && trade.side === 'buy') {
      divAlignment = 'with_nq_strength';
    } else if ((divergence === 'qqq_leading_up' || divergence === 'qqq_outperforming') && trade.side === 'sell') {
      divAlignment = 'with_qqq_strength';
    } else if (divergence !== 'in_sync' && divergence !== 'none') {
      divAlignment = 'against_divergence';
    }

    tradesWithCorrelation.push({
      ...trade,
      nqRoc5: round(nqRoc5, 3),
      qqqRoc5: round(qqqRoc5, 3),
      nqRoc10: round(nqRoc10, 3),
      qqqRoc10: round(qqqRoc10, 3),
      ratio: round(ratio, 2),
      ratioChange: round(ratioChange, 4),
      ratioChangePercent: round(ratioChangePercent, 3),
      divergence,
      ratioZone,
      divAlignment
    });
  }

  console.log(`Analyzed NQ/QQQ correlation for ${tradesWithCorrelation.length} trades\n`);

  // Analysis 1: Divergence Performance
  console.log('1. Performance by Divergence Type');
  console.log('-'.repeat(50));

  const divAnalysis = analyzeDimension(tradesWithCorrelation, 'divergence', 'Divergence');

  divAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(20)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 2: Divergence Alignment
  console.log('\n2. Performance by Divergence Alignment');
  console.log('-'.repeat(50));

  const alignAnalysis = analyzeDimension(tradesWithCorrelation, 'divAlignment', 'Divergence Alignment');

  alignAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(22)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.totalPnL)} total`);
  });

  // Analysis 3: Ratio Zone Performance
  console.log('\n3. Performance by NQ/QQQ Ratio Zone');
  console.log('-'.repeat(50));

  const ratioAnalysis = analyzeDimension(tradesWithCorrelation, 'ratioZone', 'Ratio Zone');

  ratioAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(12)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 4: ROC Difference Impact
  console.log('\n4. Performance by NQ-QQQ ROC Difference');
  console.log('-'.repeat(50));

  const rocDiffBuckets = [
    { min: -2, max: -0.3, label: 'QQQ much stronger' },
    { min: -0.3, max: -0.1, label: 'QQQ slightly stronger' },
    { min: -0.1, max: 0.1, label: 'In sync' },
    { min: 0.1, max: 0.3, label: 'NQ slightly stronger' },
    { min: 0.3, max: 2, label: 'NQ much stronger' }
  ];

  const rocDiffAnalysis = analyzeDimension(
    tradesWithCorrelation,
    trade => bucket(trade.nqRoc5 - trade.qqqRoc5, rocDiffBuckets),
    'ROC Difference'
  );

  rocDiffAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(22)}: ${g.tradeCount} trades, ${g.winRate}% WR`);
  });

  // Analysis 5: Direction-specific divergence analysis
  console.log('\n5. Divergence Analysis by Trade Direction');
  console.log('-'.repeat(50));

  for (const direction of ['buy', 'sell']) {
    const subset = tradesWithCorrelation.filter(t => t.side === direction);

    console.log(`  ${direction.toUpperCase()}S:`);

    for (const div of ['nq_leading_up', 'qqq_leading_up', 'nq_outperforming', 'qqq_outperforming', 'in_sync']) {
      const divSubset = subset.filter(t => t.divergence === div);
      if (divSubset.length >= 10) {
        const perf = calculatePerformance(divSubset);
        console.log(`    ${div.padEnd(18)}: ${perf.tradeCount} trades, ${perf.winRate}% WR`);
      }
    }
  }

  // Analysis 6: Ratio Change Impact
  console.log('\n6. Performance by Ratio Change');
  console.log('-'.repeat(50));

  const ratioChangeBuckets = [
    { min: -0.5, max: -0.05, label: 'Ratio falling' },
    { min: -0.05, max: 0.05, label: 'Ratio stable' },
    { min: 0.05, max: 0.5, label: 'Ratio rising' }
  ];

  const ratioChangeAnalysis = analyzeDimension(
    tradesWithCorrelation,
    trade => bucket(trade.ratioChangePercent, ratioChangeBuckets),
    'Ratio Change'
  );

  ratioChangeAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(15)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Correlations
  console.log('\n7. Correlation Analysis');
  console.log('-'.repeat(50));

  const nqRocs = tradesWithCorrelation.map(t => t.nqRoc5);
  const qqqRocs = tradesWithCorrelation.map(t => t.qqqRoc5);
  const ratioChanges = tradesWithCorrelation.map(t => t.ratioChangePercent);
  const pnls = tradesWithCorrelation.map(t => t.netPnL);

  const nqQqqCorr = correlation(nqRocs, qqqRocs);

  console.log(`  NQ ROC vs QQQ ROC (should be high): ${nqQqqCorr}`);
  console.log(`  NQ ROC vs P&L:                      ${correlation(nqRocs, pnls)}`);
  console.log(`  QQQ ROC vs P&L:                     ${correlation(qqqRocs, pnls)}`);
  console.log(`  Ratio Change vs P&L:                ${correlation(ratioChanges, pnls)}`);

  // Compile results
  const results = {
    analysis: 'NQ/QQQ Correlation Analysis',
    timestamp: new Date().toISOString(),
    summary: {
      totalTrades: tradesWithCorrelation.length,
      hypothesis: 'Divergences resolve, providing trading edge',
      nqQqqCorrelation: nqQqqCorr,
      finding: 'See recommendations'
    },
    correlations: {
      nqQqqROC: nqQqqCorr,
      nqROCvsPnL: correlation(nqRocs, pnls),
      qqqROCvsPnL: correlation(qqqRocs, pnls),
      ratioChangeVsPnL: correlation(ratioChanges, pnls)
    },
    byDivergence: divAnalysis.groups,
    byDivAlignment: alignAnalysis.groups,
    byRatioZone: ratioAnalysis.groups,
    byROCDiff: rocDiffAnalysis.groups,
    byRatioChange: ratioChangeAnalysis.groups,
    recommendations: []
  };

  // Generate recommendations
  // Check if trading with divergence outperforms
  const withNQStrength = alignAnalysis.groups.find(g => g.name === 'with_nq_strength');
  const againstDiv = alignAnalysis.groups.find(g => g.name === 'against_divergence');

  if (withNQStrength && againstDiv) {
    if (withNQStrength.winRate > againstDiv.winRate + 5) {
      results.summary.finding = 'SUPPORTED - Trading with NQ relative strength outperforms';
      results.recommendations.push(`Trade with NQ strength: ${withNQStrength.winRate}% vs ${againstDiv.winRate}% WR`);
    }
  }

  // Check if in-sync performs best
  const inSync = divAnalysis.groups.find(g => g.name === 'in_sync');
  const hasDiv = divAnalysis.groups.filter(g => g.name !== 'in_sync' && g.name !== 'none');

  if (inSync && hasDiv.length > 0) {
    const avgDivWR = hasDiv.reduce((s, g) => s + g.winRate, 0) / hasDiv.length;
    if (inSync.winRate > avgDivWR + 5) {
      results.recommendations.push(`In-sync condition outperforms: ${inSync.winRate}% vs ${round(avgDivWR, 1)}% WR`);
    }
  }

  const bestDiv = divAnalysis.groups[0];
  if (bestDiv.winRate > 35) {
    results.recommendations.push(`Best divergence state: ${bestDiv.name} with ${bestDiv.winRate}% WR`);
  }

  if (!results.summary.finding.includes('SUPPORTED') && !results.summary.finding.includes('CONTRADICTED')) {
    results.summary.finding = 'INCONCLUSIVE - No clear divergence edge detected';
  }

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('  SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Hypothesis: ${results.summary.hypothesis}`);
  console.log(`  NQ-QQQ Correlation: ${nqQqqCorr}`);
  console.log(`  Finding: ${results.summary.finding}`);
  console.log();

  if (results.recommendations.length > 0) {
    console.log('  Recommendations:');
    results.recommendations.forEach(r => console.log(`    - ${r}`));
  }

  // Save results
  saveResults('09_nq_qqq_correlation.json', results);

  return results;
}

runAnalysis().catch(console.error);
