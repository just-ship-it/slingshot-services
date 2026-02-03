#!/usr/bin/env node
/**
 * Session Context Analysis
 *
 * Goal: Determine if overnight action predicts RTH direction
 *
 * Analysis:
 * 1. Calculate overnight range and direction
 * 2. Track overnight high/low relative to prior day
 * 3. Correlate overnight action with RTH direction
 * 4. Analyze trades entering with vs against overnight trend
 * 5. Check if overnight range expansion predicts volatility
 *
 * Hypothesis: Overnight direction provides context for RTH trading.
 */

import {
  loadTrades,
  loadNQOHLCV,
  getRTHCandles,
  getOvernightCandles,
  getPreviousDayLevels
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
  console.log('  Session Context Analysis (Overnight Action)');
  console.log('='.repeat(70));
  console.log();

  // Load data
  console.log('Loading data...');
  const trades = await loadTrades();
  const ohlcv = await loadNQOHLCV('2025-01-01', '2025-12-31');

  console.log();

  // Build session data for each trading day
  const sessionData = new Map();

  const tradeDates = new Set(trades.map(t => t.entryDate));

  for (const dateStr of tradeDates) {
    const date = new Date(dateStr);
    const overnightCandles = getOvernightCandles(ohlcv, date);
    const rthCandles = getRTHCandles(ohlcv, date);
    const prevDay = getPreviousDayLevels(ohlcv, date);

    if (overnightCandles.length < 30 || rthCandles.length < 30 || !prevDay) continue;

    // Overnight session analysis
    const onHigh = Math.max(...overnightCandles.map(c => c.high));
    const onLow = Math.min(...overnightCandles.map(c => c.low));
    const onOpen = overnightCandles[0].open;
    const onClose = overnightCandles[overnightCandles.length - 1].close;
    const onRange = onHigh - onLow;
    const onChange = onClose - onOpen;
    const onDirection = onChange > 5 ? 'up' : onChange < -5 ? 'down' : 'flat';

    // Overnight vs previous day levels
    const onVsPDH = onHigh - prevDay.high;
    const onVsPDL = onLow - prevDay.low;

    // Overnight range classification
    let onRangeCategory = 'normal';
    if (onRange < 30) onRangeCategory = 'tight';
    else if (onRange > 80) onRangeCategory = 'wide';

    // RTH session analysis
    const rthOpen = rthCandles[0].open;
    const rthHigh = Math.max(...rthCandles.map(c => c.high));
    const rthLow = Math.min(...rthCandles.map(c => c.low));
    const rthClose = rthCandles[rthCandles.length - 1].close;
    const rthChange = rthClose - rthOpen;
    const rthDirection = rthChange > 5 ? 'up' : rthChange < -5 ? 'down' : 'flat';
    const rthRange = rthHigh - rthLow;

    // Alignment between overnight and RTH
    const onRthAligned = (onDirection === 'up' && rthDirection === 'up') ||
                         (onDirection === 'down' && rthDirection === 'down');

    // Opening position relative to overnight
    let openVsOn = 'inside';
    if (rthOpen > onHigh) openVsOn = 'above_on';
    else if (rthOpen < onLow) openVsOn = 'below_on';

    sessionData.set(dateStr, {
      date: dateStr,
      onHigh: round(onHigh, 2),
      onLow: round(onLow, 2),
      onRange: round(onRange, 2),
      onDirection,
      onRangeCategory,
      onChange: round(onChange, 2),
      onVsPDH: round(onVsPDH, 2),
      onVsPDL: round(onVsPDL, 2),
      rthDirection,
      rthRange: round(rthRange, 2),
      rthChange: round(rthChange, 2),
      onRthAligned,
      openVsOn
    });
  }

  console.log(`Analyzed session context for ${sessionData.size} trading days\n`);

  // Session alignment statistics
  let onUpRthUp = 0, onUpRthDown = 0;
  let onDownRthUp = 0, onDownRthDown = 0;

  for (const [_, session] of sessionData) {
    if (session.onDirection === 'up') {
      if (session.rthDirection === 'up') onUpRthUp++;
      else if (session.rthDirection === 'down') onUpRthDown++;
    } else if (session.onDirection === 'down') {
      if (session.rthDirection === 'up') onDownRthUp++;
      else if (session.rthDirection === 'down') onDownRthDown++;
    }
  }

  console.log('1. Overnight to RTH Direction Alignment');
  console.log('-'.repeat(50));
  console.log(`  Overnight Up -> RTH Up:     ${round(onUpRthUp / (onUpRthUp + onUpRthDown) * 100, 1)}% (${onUpRthUp}/${onUpRthUp + onUpRthDown})`);
  console.log(`  Overnight Down -> RTH Down: ${round(onDownRthDown / (onDownRthUp + onDownRthDown) * 100, 1)}% (${onDownRthDown}/${onDownRthUp + onDownRthDown})`);

  // Analyze trades with session context
  const tradesWithSession = [];

  for (const trade of trades) {
    const session = sessionData.get(trade.entryDate);
    if (!session) continue;

    // Trade alignment with overnight
    let onAlignment = 'neutral';
    if (session.onDirection === 'up' && trade.side === 'buy') onAlignment = 'with_overnight';
    else if (session.onDirection === 'down' && trade.side === 'sell') onAlignment = 'with_overnight';
    else if (session.onDirection !== 'flat') onAlignment = 'against_overnight';

    // Entry position relative to overnight range
    const entryPrice = trade.entryPrice;
    let entryVsOn = 'inside_on';
    if (entryPrice > session.onHigh) entryVsOn = 'above_on';
    else if (entryPrice < session.onLow) entryVsOn = 'below_on';

    // Distance from overnight levels
    const distFromOnHigh = entryPrice - session.onHigh;
    const distFromOnLow = entryPrice - session.onLow;

    tradesWithSession.push({
      ...trade,
      onDirection: session.onDirection,
      onRange: session.onRange,
      onRangeCategory: session.onRangeCategory,
      onAlignment,
      entryVsOn,
      rthDirection: session.rthDirection,
      onRthAligned: session.onRthAligned,
      distFromOnHigh: round(distFromOnHigh, 2),
      distFromOnLow: round(distFromOnLow, 2)
    });
  }

  console.log(`\nAnalyzed ${tradesWithSession.length} trades with session context\n`);

  // Analysis 2: Performance by Overnight Direction
  console.log('2. Performance by Overnight Direction');
  console.log('-'.repeat(50));

  const onDirAnalysis = analyzeDimension(tradesWithSession, 'onDirection', 'ON Direction');

  onDirAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(10)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 3: Overnight Alignment
  console.log('\n3. Performance by Overnight Alignment');
  console.log('-'.repeat(50));

  const onAlignAnalysis = analyzeDimension(tradesWithSession, 'onAlignment', 'ON Alignment');

  onAlignAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(18)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.totalPnL)} total`);
  });

  // Analysis 4: Entry vs Overnight Range
  console.log('\n4. Performance by Entry Position vs Overnight Range');
  console.log('-'.repeat(50));

  const entryVsOnAnalysis = analyzeDimension(tradesWithSession, 'entryVsOn', 'Entry vs ON');

  entryVsOnAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(12)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 5: Overnight Range Size Impact
  console.log('\n5. Performance by Overnight Range Size');
  console.log('-'.repeat(50));

  const onRangeAnalysis = analyzeDimension(tradesWithSession, 'onRangeCategory', 'ON Range');

  onRangeAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(10)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 6: Direction Analysis by ON Direction
  console.log('\n6. Direction Analysis by Overnight Direction');
  console.log('-'.repeat(50));

  for (const onDir of ['up', 'down', 'flat']) {
    const subset = tradesWithSession.filter(t => t.onDirection === onDir);
    if (subset.length < 20) continue;

    const longs = subset.filter(t => t.side === 'buy');
    const shorts = subset.filter(t => t.side === 'sell');

    console.log(`  Overnight ${onDir}:`);
    if (longs.length >= 10) {
      const perf = calculatePerformance(longs);
      console.log(`    Longs:  ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.avgPnL)} avg`);
    }
    if (shorts.length >= 10) {
      const perf = calculatePerformance(shorts);
      console.log(`    Shorts: ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.avgPnL)} avg`);
    }
  }

  // Analysis 7: ON-RTH Alignment Impact
  console.log('\n7. Performance on Aligned vs Non-Aligned Days');
  console.log('-'.repeat(50));

  const alignedDays = tradesWithSession.filter(t => t.onRthAligned);
  const notAlignedDays = tradesWithSession.filter(t => !t.onRthAligned);

  if (alignedDays.length >= 10) {
    const perf = calculatePerformance(alignedDays);
    console.log(`  ON-RTH Aligned:     ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.avgPnL)} avg`);
  }
  if (notAlignedDays.length >= 10) {
    const perf = calculatePerformance(notAlignedDays);
    console.log(`  ON-RTH Not Aligned: ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.avgPnL)} avg`);
  }

  // Correlations
  console.log('\n8. Correlation Analysis');
  console.log('-'.repeat(50));

  const onRanges = tradesWithSession.map(t => t.onRange);
  const pnls = tradesWithSession.map(t => t.netPnL);
  const distHighs = tradesWithSession.map(t => t.distFromOnHigh);
  const distLows = tradesWithSession.map(t => t.distFromOnLow);

  console.log(`  ON Range vs P&L:        ${correlation(onRanges, pnls)}`);
  console.log(`  Dist from ON High vs P&L: ${correlation(distHighs, pnls)}`);
  console.log(`  Dist from ON Low vs P&L:  ${correlation(distLows, pnls)}`);

  // Compile results
  const results = {
    analysis: 'Session Context Analysis',
    timestamp: new Date().toISOString(),
    summary: {
      totalTrades: tradesWithSession.length,
      totalDays: sessionData.size,
      hypothesis: 'Overnight direction provides context for RTH trading',
      finding: 'See recommendations'
    },
    sessionAlignment: {
      onUpRthUp,
      onUpRthDown,
      onDownRthUp,
      onDownRthDown,
      onUpContinuation: round(onUpRthUp / (onUpRthUp + onUpRthDown) * 100, 1),
      onDownContinuation: round(onDownRthDown / (onDownRthUp + onDownRthDown) * 100, 1)
    },
    correlations: {
      onRangeVsPnL: correlation(onRanges, pnls),
      distOnHighVsPnL: correlation(distHighs, pnls),
      distOnLowVsPnL: correlation(distLows, pnls)
    },
    byONDirection: onDirAnalysis.groups,
    byONAlignment: onAlignAnalysis.groups,
    byEntryVsON: entryVsOnAnalysis.groups,
    byONRangeSize: onRangeAnalysis.groups,
    recommendations: []
  };

  // Generate recommendations
  const onUpCont = round(onUpRthUp / (onUpRthUp + onUpRthDown) * 100, 1);
  const onDownCont = round(onDownRthDown / (onDownRthUp + onDownRthDown) * 100, 1);

  if (onUpCont > 55 || onDownCont > 55) {
    results.summary.finding = 'SUPPORTED - Overnight trend predicts RTH';
    results.recommendations.push(`Overnight continuation: Up ${onUpCont}%, Down ${onDownCont}%`);
  } else if (onUpCont < 45 && onDownCont < 45) {
    results.summary.finding = 'CONTRADICTED - Overnight trend reverses in RTH';
    results.recommendations.push(`Consider fading overnight direction`);
  } else {
    results.summary.finding = 'INCONCLUSIVE - Mixed overnight-RTH relationship';
  }

  const withON = onAlignAnalysis.groups.find(g => g.name === 'with_overnight');
  const againstON = onAlignAnalysis.groups.find(g => g.name === 'against_overnight');

  if (withON && againstON && withON.winRate > againstON.winRate + 5) {
    results.recommendations.push(`Trade with overnight: ${withON.winRate}% vs ${againstON.winRate}% WR`);
  } else if (withON && againstON && againstON.winRate > withON.winRate + 5) {
    results.recommendations.push(`Fade overnight: ${againstON.winRate}% vs ${withON.winRate}% WR`);
  }

  const bestEntryVsOn = entryVsOnAnalysis.groups[0];
  if (bestEntryVsOn.winRate > 35) {
    results.recommendations.push(`Best entry zone: ${bestEntryVsOn.name} with ${bestEntryVsOn.winRate}% WR`);
  }

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('  SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Hypothesis: ${results.summary.hypothesis}`);
  console.log(`  ON Up -> RTH Up: ${onUpCont}%`);
  console.log(`  ON Down -> RTH Down: ${onDownCont}%`);
  console.log(`  Finding: ${results.summary.finding}`);
  console.log();

  if (results.recommendations.length > 0) {
    console.log('  Recommendations:');
    results.recommendations.forEach(r => console.log(`    - ${r}`));
  }

  // Save results
  saveResults('07_session_context.json', results);

  return results;
}

runAnalysis().catch(console.error);
