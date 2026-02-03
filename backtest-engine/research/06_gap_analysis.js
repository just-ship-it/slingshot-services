#!/usr/bin/env node
/**
 * Gap Analysis
 *
 * Goal: Determine if gap days behave differently
 *
 * Analysis:
 * 1. Classify days by gap type (gap up, gap down, no gap)
 * 2. Define gap size buckets (small <20pts, medium 20-50, large >50)
 * 3. Track gap fill rate and timing
 * 4. Analyze strategy performance on gap vs non-gap days
 * 5. Check if gap direction predicts daily trend
 *
 * Hypothesis: Gap fills are high-probability setups.
 */

import {
  loadTrades,
  loadNQOHLCV,
  getRTHCandles,
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
  console.log('  Gap Analysis');
  console.log('='.repeat(70));
  console.log();

  // Load data
  console.log('Loading data...');
  const trades = await loadTrades();
  const ohlcv = await loadNQOHLCV('2025-01-01', '2025-12-31');

  console.log();

  // Build gap data for each trading day
  const gapData = new Map(); // date -> gap info

  const tradeDates = new Set(trades.map(t => t.entryDate));

  for (const dateStr of tradeDates) {
    const date = new Date(dateStr);
    const rthCandles = getRTHCandles(ohlcv, date);
    const prevDay = getPreviousDayLevels(ohlcv, date);

    if (rthCandles.length < 10 || !prevDay) continue;

    const todayOpen = rthCandles[0].open;
    const todayHigh = Math.max(...rthCandles.map(c => c.high));
    const todayLow = Math.min(...rthCandles.map(c => c.low));
    const todayClose = rthCandles[rthCandles.length - 1].close;

    const pdc = prevDay.close;
    const pdh = prevDay.high;
    const pdl = prevDay.low;

    // Calculate gap
    const gapSize = todayOpen - pdc;
    const gapPercent = (gapSize / pdc) * 100;

    // Classify gap
    let gapType = 'no_gap';
    let gapCategory = 'none';

    if (gapSize > 20) {
      gapType = 'gap_up';
      if (gapSize > 50) gapCategory = 'large_gap_up';
      else gapCategory = 'small_gap_up';
    } else if (gapSize < -20) {
      gapType = 'gap_down';
      if (gapSize < -50) gapCategory = 'large_gap_down';
      else gapCategory = 'small_gap_down';
    }

    // Check if gap filled
    let gapFilled = false;
    let gapFillTime = null;
    let gapFillMinutes = null;

    if (gapType === 'gap_up') {
      // Gap fill = price touches previous close
      for (let i = 0; i < rthCandles.length; i++) {
        if (rthCandles[i].low <= pdc) {
          gapFilled = true;
          gapFillTime = rthCandles[i].timestamp;
          gapFillMinutes = i; // Approximate minutes (1 candle = 1 min for 1m data)
          break;
        }
      }
    } else if (gapType === 'gap_down') {
      for (let i = 0; i < rthCandles.length; i++) {
        if (rthCandles[i].high >= pdc) {
          gapFilled = true;
          gapFillTime = rthCandles[i].timestamp;
          gapFillMinutes = i;
          break;
        }
      }
    }

    // Day direction
    const dayDirection = todayClose > todayOpen ? 'up' : todayClose < todayOpen ? 'down' : 'flat';
    const dayChange = todayClose - todayOpen;

    // Gap and day alignment
    const gapDayAligned = (gapType === 'gap_up' && dayDirection === 'up') ||
                          (gapType === 'gap_down' && dayDirection === 'down');

    gapData.set(dateStr, {
      date: dateStr,
      todayOpen,
      pdc,
      gapSize: round(gapSize, 2),
      gapPercent: round(gapPercent, 3),
      gapType,
      gapCategory,
      gapFilled,
      gapFillMinutes,
      dayDirection,
      dayChange: round(dayChange, 2),
      gapDayAligned
    });
  }

  console.log(`Analyzed gaps for ${gapData.size} trading days\n`);

  // Calculate gap fill statistics
  let gapUpDays = 0, gapDownDays = 0;
  let gapUpFilled = 0, gapDownFilled = 0;
  let gapUpFillTimes = [], gapDownFillTimes = [];

  for (const [_, gap] of gapData) {
    if (gap.gapType === 'gap_up') {
      gapUpDays++;
      if (gap.gapFilled) {
        gapUpFilled++;
        gapUpFillTimes.push(gap.gapFillMinutes);
      }
    } else if (gap.gapType === 'gap_down') {
      gapDownDays++;
      if (gap.gapFilled) {
        gapDownFilled++;
        gapDownFillTimes.push(gap.gapFillMinutes);
      }
    }
  }

  console.log('1. Gap Fill Statistics');
  console.log('-'.repeat(50));
  console.log(`  Gap Up Days:   ${gapUpDays}`);
  console.log(`    Filled:      ${gapUpFilled} (${round(gapUpFilled / gapUpDays * 100, 1)}%)`);
  if (gapUpFillTimes.length > 0) {
    console.log(`    Avg Fill Time: ${round(gapUpFillTimes.reduce((a, b) => a + b, 0) / gapUpFillTimes.length, 0)} minutes`);
  }
  console.log(`  Gap Down Days: ${gapDownDays}`);
  console.log(`    Filled:      ${gapDownFilled} (${round(gapDownFilled / gapDownDays * 100, 1)}%)`);
  if (gapDownFillTimes.length > 0) {
    console.log(`    Avg Fill Time: ${round(gapDownFillTimes.reduce((a, b) => a + b, 0) / gapDownFillTimes.length, 0)} minutes`);
  }

  // Analyze trades with gap context
  const tradesWithGap = [];

  for (const trade of trades) {
    const gap = gapData.get(trade.entryDate);
    if (!gap) continue;

    // Determine if trade aligns with gap
    let gapAlignment = 'no_gap';
    if (gap.gapType === 'gap_up' && trade.side === 'sell') {
      gapAlignment = 'fading_gap'; // Selling into gap up (betting on fill)
    } else if (gap.gapType === 'gap_down' && trade.side === 'buy') {
      gapAlignment = 'fading_gap'; // Buying into gap down
    } else if (gap.gapType === 'gap_up' && trade.side === 'buy') {
      gapAlignment = 'trading_with_gap';
    } else if (gap.gapType === 'gap_down' && trade.side === 'sell') {
      gapAlignment = 'trading_with_gap';
    }

    // Was entry before or after gap fill?
    let entryVsFill = 'no_gap';
    if (gap.gapType !== 'no_gap') {
      if (!gap.gapFilled) {
        entryVsFill = 'before_fill_no_fill';
      } else if (trade.entryTime < gap.gapFillTime) {
        entryVsFill = 'before_fill';
      } else {
        entryVsFill = 'after_fill';
      }
    }

    tradesWithGap.push({
      ...trade,
      gapSize: gap.gapSize,
      gapType: gap.gapType,
      gapCategory: gap.gapCategory,
      gapFilled: gap.gapFilled,
      gapAlignment,
      entryVsFill,
      dayDirection: gap.dayDirection,
      gapDayAligned: gap.gapDayAligned
    });
  }

  console.log(`\nAnalyzed ${tradesWithGap.length} trades with gap context\n`);

  // Analysis 2: Performance by Gap Type
  console.log('2. Performance by Gap Type');
  console.log('-'.repeat(50));

  const gapTypeAnalysis = analyzeDimension(tradesWithGap, 'gapType', 'Gap Type');

  gapTypeAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(12)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 3: Performance by Gap Category
  console.log('\n3. Performance by Gap Size Category');
  console.log('-'.repeat(50));

  const gapCatAnalysis = analyzeDimension(tradesWithGap, 'gapCategory', 'Gap Category');

  gapCatAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(18)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 4: Fading Gap vs Trading With
  console.log('\n4. Performance by Gap Alignment (Fade vs Follow)');
  console.log('-'.repeat(50));

  const gapAlignAnalysis = analyzeDimension(tradesWithGap, 'gapAlignment', 'Gap Alignment');

  gapAlignAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(18)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.totalPnL)} total`);
  });

  // Analysis 5: Entry Timing vs Gap Fill
  console.log('\n5. Performance by Entry Timing vs Gap Fill');
  console.log('-'.repeat(50));

  const fillTimingAnalysis = analyzeDimension(tradesWithGap, 'entryVsFill', 'Entry vs Fill');

  fillTimingAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(20)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 6: Direction Analysis by Gap Type
  console.log('\n6. Direction Analysis by Gap Type');
  console.log('-'.repeat(50));

  for (const gapType of ['gap_up', 'gap_down', 'no_gap']) {
    const subset = tradesWithGap.filter(t => t.gapType === gapType);
    if (subset.length < 20) continue;

    const longs = subset.filter(t => t.side === 'buy');
    const shorts = subset.filter(t => t.side === 'sell');

    console.log(`  ${gapType}:`);
    if (longs.length >= 10) {
      const perf = calculatePerformance(longs);
      console.log(`    Longs:  ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.avgPnL)} avg`);
    }
    if (shorts.length >= 10) {
      const perf = calculatePerformance(shorts);
      console.log(`    Shorts: ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.avgPnL)} avg`);
    }
  }

  // Analysis 7: Gap Day Direction Prediction
  console.log('\n7. Gap Direction vs Day Direction');
  console.log('-'.repeat(50));

  let gapUpDayUp = 0, gapUpDayDown = 0;
  let gapDownDayUp = 0, gapDownDayDown = 0;

  for (const [_, gap] of gapData) {
    if (gap.gapType === 'gap_up') {
      if (gap.dayDirection === 'up') gapUpDayUp++;
      else if (gap.dayDirection === 'down') gapUpDayDown++;
    } else if (gap.gapType === 'gap_down') {
      if (gap.dayDirection === 'up') gapDownDayUp++;
      else if (gap.dayDirection === 'down') gapDownDayDown++;
    }
  }

  const gapUpContinuation = gapUpDays > 0 ? round(gapUpDayUp / (gapUpDayUp + gapUpDayDown) * 100, 1) : 0;
  const gapDownContinuation = gapDownDays > 0 ? round(gapDownDayDown / (gapDownDayUp + gapDownDayDown) * 100, 1) : 0;

  console.log(`  Gap Up -> Day Up:     ${gapUpContinuation}% (${gapUpDayUp}/${gapUpDayUp + gapUpDayDown})`);
  console.log(`  Gap Down -> Day Down: ${gapDownContinuation}% (${gapDownDayDown}/${gapDownDayUp + gapDownDayDown})`);

  // Compile results
  const results = {
    analysis: 'Gap Analysis',
    timestamp: new Date().toISOString(),
    summary: {
      totalTrades: tradesWithGap.length,
      totalDays: gapData.size,
      hypothesis: 'Gap fills are high-probability setups',
      finding: 'See recommendations'
    },
    gapFillStats: {
      gapUpDays,
      gapUpFilled,
      gapUpFillRate: round(gapUpFilled / gapUpDays * 100, 1),
      gapDownDays,
      gapDownFilled,
      gapDownFillRate: round(gapDownFilled / gapDownDays * 100, 1)
    },
    gapContinuation: {
      gapUpContinuation,
      gapDownContinuation
    },
    byGapType: gapTypeAnalysis.groups,
    byGapCategory: gapCatAnalysis.groups,
    byGapAlignment: gapAlignAnalysis.groups,
    byEntryVsFill: fillTimingAnalysis.groups,
    recommendations: []
  };

  // Generate recommendations
  const gapUpFillRate = round(gapUpFilled / gapUpDays * 100, 1);
  const gapDownFillRate = round(gapDownFilled / gapDownDays * 100, 1);

  if (gapUpFillRate > 60 || gapDownFillRate > 60) {
    results.summary.finding = 'SUPPORTED - Gaps fill frequently';
    results.recommendations.push(`Gap fill rates: Up ${gapUpFillRate}%, Down ${gapDownFillRate}%`);
  }

  const fadingGap = gapAlignAnalysis.groups.find(g => g.name === 'fading_gap');
  const withGap = gapAlignAnalysis.groups.find(g => g.name === 'trading_with_gap');

  if (fadingGap && withGap && fadingGap.winRate > withGap.winRate + 5) {
    results.recommendations.push(`Fading gaps outperforms: ${fadingGap.winRate}% vs ${withGap.winRate}% WR`);
  } else if (fadingGap && withGap && withGap.winRate > fadingGap.winRate + 5) {
    results.recommendations.push(`Trading with gaps outperforms: ${withGap.winRate}% vs ${fadingGap.winRate}% WR`);
  }

  const bestGapCat = gapCatAnalysis.groups[0];
  if (bestGapCat.winRate > 35) {
    results.recommendations.push(`Best gap type: ${bestGapCat.name} with ${bestGapCat.winRate}% WR`);
  }

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('  SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Hypothesis: ${results.summary.hypothesis}`);
  console.log(`  Gap Up Fill Rate:   ${gapUpFillRate}%`);
  console.log(`  Gap Down Fill Rate: ${gapDownFillRate}%`);
  console.log(`  Finding: ${results.summary.finding}`);
  console.log();

  if (results.recommendations.length > 0) {
    console.log('  Recommendations:');
    results.recommendations.forEach(r => console.log(`    - ${r}`));
  }

  // Save results
  saveResults('06_gap_analysis.json', results);

  return results;
}

runAnalysis().catch(console.error);
