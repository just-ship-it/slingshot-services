/**
 * Study 1: The Sweep Clock — PDH/PDL Liquidity Rotation
 *
 * Market Maker Logic: The two largest, most predictable liquidity pools each day
 * are the stops clustered beyond PDH and PDL. Market makers NEED those orders.
 * Price will hunt them.
 *
 * Core Questions:
 *  1. What % of RTH days does price touch PDH? PDL? Both?
 *  2. When both are swept, what's the sequence (PDH-first vs PDL-first)?
 *  3. After sweeping one side, what % does the second sweep follow within RTH?
 *  4. Time gap between first and second sweep?
 *  5. MFE/MAE for trading toward the unswept side after first sweep
 *  6. Does gap direction, overnight range, or PDH-PDL distance predict which side goes first?
 *  7. 1-second volume velocity analysis at sweep points
 *
 * Usage:
 *   node research/sweep-clock.js [--product NQ|ES] [--threshold 0|2|5]
 */

import {
  loadContinuousOHLCV,
  load1sRange,
  extractTradingDates,
  getRTHCandlesFromArray,
  getOvernightCandlesFromArray,
  getPrevDayLevelsFromArray,
  toET,
  fromET
} from './utils/data-loader.js';

import {
  round,
  bucket,
  saveResults,
  calculatePercentiles,
  correlation
} from './utils/analysis-helpers.js';

// --- CLI Args ---
const args = process.argv.slice(2);
const product = (args.find(a => a === '--product') ? args[args.indexOf('--product') + 1] : 'NQ').toUpperCase();
const thresholdArg = args.find(a => a === '--threshold') ? parseFloat(args[args.indexOf('--threshold') + 1]) : null;
const thresholds = thresholdArg !== null ? [thresholdArg] : [0, 2, 5];

console.log(`\n=== Sweep Clock Study: ${product} ===`);
console.log(`Touch thresholds: ${thresholds.join(', ')} points\n`);

// --- Main ---
(async () => {
  const startDate = '2021-01-01';
  const endDate = '2026-01-31';

  console.log('Loading continuous 1m data...');
  const candles = await loadContinuousOHLCV(product, '1m', startDate, endDate);
  const tradingDates = extractTradingDates(candles);
  console.log(`Found ${tradingDates.length} trading days\n`);

  // Pre-index candles by minute timestamp for fast lookup
  const candleByTs = new Map();
  for (const c of candles) candleByTs.set(c.timestamp, c);

  // Results per threshold
  const allResults = {};

  for (const threshold of thresholds) {
    console.log(`--- Analyzing with ${threshold}-point threshold ---`);
    const dayResults = [];
    let skipped = 0;

    for (let i = 0; i < tradingDates.length; i++) {
      const dateStr = tradingDates[i];
      const prevLevels = getPrevDayLevelsFromArray(candles, dateStr, tradingDates);
      if (!prevLevels) { skipped++; continue; }

      const pdh = prevLevels.high;
      const pdl = prevLevels.low;
      const pdc = prevLevels.close;
      const pdo = prevLevels.open;
      const pdRange = pdh - pdl;

      const rthCandles = getRTHCandlesFromArray(candles, dateStr);
      if (rthCandles.length < 10) { skipped++; continue; }

      const onCandles = getOvernightCandlesFromArray(candles, dateStr);
      const onHigh = onCandles.length > 0 ? Math.max(...onCandles.map(c => c.high)) : null;
      const onLow = onCandles.length > 0 ? Math.min(...onCandles.map(c => c.low)) : null;
      const onRange = onHigh && onLow ? onHigh - onLow : null;

      const rthOpen = rthCandles[0].open;
      const gap = rthOpen - pdc;

      // Detect sweeps
      let pdhSweepCandle = null;
      let pdlSweepCandle = null;
      let pdhSweepIdx = -1;
      let pdlSweepIdx = -1;

      for (let j = 0; j < rthCandles.length; j++) {
        const c = rthCandles[j];
        if (!pdhSweepCandle && c.high >= pdh - threshold) {
          pdhSweepCandle = c;
          pdhSweepIdx = j;
        }
        if (!pdlSweepCandle && c.low <= pdl + threshold) {
          pdlSweepCandle = c;
          pdlSweepIdx = j;
        }
      }

      const sweptPDH = !!pdhSweepCandle;
      const sweptPDL = !!pdlSweepCandle;
      const sweptBoth = sweptPDH && sweptPDL;

      let firstSwept = null;
      let secondSwept = null;
      let firstSweepCandle = null;
      let secondSweepCandle = null;
      let timeBetweenSweepsMin = null;

      if (sweptBoth) {
        if (pdhSweepIdx < pdlSweepIdx) {
          firstSwept = 'PDH';
          secondSwept = 'PDL';
          firstSweepCandle = pdhSweepCandle;
          secondSweepCandle = pdlSweepCandle;
        } else if (pdlSweepIdx < pdhSweepIdx) {
          firstSwept = 'PDL';
          secondSwept = 'PDH';
          firstSweepCandle = pdlSweepCandle;
          secondSweepCandle = pdhSweepCandle;
        } else {
          // Same candle
          firstSwept = 'simultaneous';
          firstSweepCandle = pdhSweepCandle;
        }
        if (firstSweepCandle && secondSweepCandle) {
          timeBetweenSweepsMin = round((secondSweepCandle.timestamp - firstSweepCandle.timestamp) / 60000, 1);
        }
      } else if (sweptPDH) {
        firstSwept = 'PDH_only';
        firstSweepCandle = pdhSweepCandle;
      } else if (sweptPDL) {
        firstSwept = 'PDL_only';
        firstSweepCandle = pdlSweepCandle;
      }

      // MFE/MAE after first sweep toward unswept side (60 min window)
      let mfe = null, mae = null;
      if (sweptBoth && firstSweepCandle && secondSweepCandle && firstSwept !== 'simultaneous') {
        const sweepIdx = firstSwept === 'PDH' ? pdhSweepIdx : pdlSweepIdx;
        const direction = firstSwept === 'PDH' ? -1 : 1; // After PDH sweep, expect move down; after PDL sweep, expect move up
        const entryPrice = firstSweepCandle.close;
        let maxFavorable = 0;
        let maxAdverse = 0;
        const lookAhead = Math.min(sweepIdx + 60, rthCandles.length);
        for (let j = sweepIdx + 1; j < lookAhead; j++) {
          const c = rthCandles[j];
          const moveHigh = (c.high - entryPrice) * direction;
          const moveLow = (c.low - entryPrice) * direction;
          maxFavorable = Math.max(maxFavorable, moveHigh, moveLow);
          maxAdverse = Math.min(maxAdverse, moveHigh, moveLow);
        }
        mfe = round(maxFavorable, 2);
        mae = round(Math.abs(maxAdverse), 2);
      }

      // Classify context
      const gapDirection = gap > 20 ? 'gap_up' : gap < -20 ? 'gap_down' : 'no_gap';
      const onRangeBucket = onRange !== null ? bucket(onRange, [30, 60, 100, 150]) : 'unknown';
      const pdRangeBucket = bucket(pdRange, [50, 100, 150, 250]);
      const dayOfWeek = new Date(dateStr).getUTCDay();

      dayResults.push({
        date: dateStr,
        pdh, pdl, pdc, pdRange: round(pdRange, 2),
        rthOpen, gap: round(gap, 2),
        sweptPDH, sweptPDL, sweptBoth,
        firstSwept,
        timeBetweenSweepsMin,
        mfe, mae,
        gapDirection, onRangeBucket, pdRangeBucket, dayOfWeek,
        pdhSweepTs: pdhSweepCandle?.timestamp || null,
        pdlSweepTs: pdlSweepCandle?.timestamp || null
      });
    }

    console.log(`  Analyzed ${dayResults.length} days (${skipped} skipped)\n`);

    // --- Aggregate Stats ---
    const total = dayResults.length;
    const sweptPDHCount = dayResults.filter(d => d.sweptPDH).length;
    const sweptPDLCount = dayResults.filter(d => d.sweptPDL).length;
    const sweptBothCount = dayResults.filter(d => d.sweptBoth).length;
    const sweptNeitherCount = dayResults.filter(d => !d.sweptPDH && !d.sweptPDL).length;

    const pdhFirstCount = dayResults.filter(d => d.firstSwept === 'PDH').length;
    const pdlFirstCount = dayResults.filter(d => d.firstSwept === 'PDL').length;
    const simultaneousCount = dayResults.filter(d => d.firstSwept === 'simultaneous').length;

    // Second sweep follow-through rate
    const firstSweepDays = dayResults.filter(d => d.sweptPDH !== d.sweptPDL || d.sweptBoth);
    const oneSideSweepDays = dayResults.filter(d => (d.sweptPDH || d.sweptPDL));
    const secondFollowRate = oneSideSweepDays.length > 0 ? round(sweptBothCount / oneSideSweepDays.length * 100, 1) : 0;

    // Time between sweeps
    const timeBetween = dayResults.filter(d => d.timeBetweenSweepsMin !== null).map(d => d.timeBetweenSweepsMin);
    const timePercentiles = calculatePercentiles(timeBetween, [25, 50, 75, 90]);

    // MFE/MAE stats
    const mfeValues = dayResults.filter(d => d.mfe !== null).map(d => d.mfe);
    const maeValues = dayResults.filter(d => d.mae !== null).map(d => d.mae);
    const mfePercentiles = calculatePercentiles(mfeValues, [25, 50, 75, 90]);
    const maePercentiles = calculatePercentiles(maeValues, [25, 50, 75, 90]);

    // --- Dimensional Analysis ---

    function analyzeBy(field, label) {
      const groups = {};
      for (const d of dayResults) {
        const key = d[field];
        if (key === undefined || key === null || key === 'unknown') continue;
        if (!groups[key]) groups[key] = { count: 0, sweptBoth: 0, pdhFirst: 0, pdlFirst: 0, mfe: [], mae: [] };
        groups[key].count++;
        if (d.sweptBoth) groups[key].sweptBoth++;
        if (d.firstSwept === 'PDH') groups[key].pdhFirst++;
        if (d.firstSwept === 'PDL') groups[key].pdlFirst++;
        if (d.mfe !== null) { groups[key].mfe.push(d.mfe); groups[key].mae.push(d.mae); }
      }
      return Object.entries(groups).map(([k, v]) => ({
        group: k,
        days: v.count,
        bothSweptPct: round(v.sweptBoth / v.count * 100, 1),
        pdhFirstPct: v.sweptBoth > 0 ? round(v.pdhFirst / (v.pdhFirst + v.pdlFirst || 1) * 100, 1) : null,
        avgMFE: v.mfe.length > 0 ? round(v.mfe.reduce((a, b) => a + b, 0) / v.mfe.length, 1) : null,
        avgMAE: v.mae.length > 0 ? round(v.mae.reduce((a, b) => a + b, 0) / v.mae.length, 1) : null
      }));
    }

    const byGap = analyzeBy('gapDirection', 'Gap Direction');
    const byONRange = analyzeBy('onRangeBucket', 'Overnight Range');
    const byPDRange = analyzeBy('pdRangeBucket', 'PD Range');
    const byDOW = analyzeBy('dayOfWeek', 'Day of Week');

    // Correlations
    const pdRanges = dayResults.map(d => d.pdRange);
    const gaps = dayResults.map(d => Math.abs(d.gap));
    const sweptBothBinary = dayResults.map(d => d.sweptBoth ? 1 : 0);
    const mfesAll = dayResults.map(d => d.mfe ?? 0);

    const corrPDRangeVsBoth = correlation(pdRanges, sweptBothBinary);
    const corrGapVsBoth = correlation(gaps, sweptBothBinary);
    const corrPDRangeVsMFE = correlation(pdRanges, mfesAll);

    // --- Console Summary ---
    console.log(`  Threshold: ${threshold} points`);
    console.log(`  PDH swept: ${sweptPDHCount}/${total} (${round(sweptPDHCount/total*100, 1)}%)`);
    console.log(`  PDL swept: ${sweptPDLCount}/${total} (${round(sweptPDLCount/total*100, 1)}%)`);
    console.log(`  Both swept: ${sweptBothCount}/${total} (${round(sweptBothCount/total*100, 1)}%)`);
    console.log(`  Neither swept: ${sweptNeitherCount}/${total} (${round(sweptNeitherCount/total*100, 1)}%)`);
    console.log(`  PDH first: ${pdhFirstCount} | PDL first: ${pdlFirstCount} | Simultaneous: ${simultaneousCount}`);
    console.log(`  Second sweep follow rate: ${secondFollowRate}%`);
    console.log(`  Time between sweeps (min): p25=${timePercentiles.p25} p50=${timePercentiles.p50} p75=${timePercentiles.p75} p90=${timePercentiles.p90}`);
    console.log(`  MFE toward unswept (pts): p25=${mfePercentiles.p25} p50=${mfePercentiles.p50} p75=${mfePercentiles.p75}`);
    console.log(`  MAE against (pts): p25=${maePercentiles.p25} p50=${maePercentiles.p50} p75=${maePercentiles.p75}`);
    console.log();

    allResults[`threshold_${threshold}`] = {
      threshold,
      totalDays: total,
      sweptPDH: { count: sweptPDHCount, pct: round(sweptPDHCount/total*100, 1) },
      sweptPDL: { count: sweptPDLCount, pct: round(sweptPDLCount/total*100, 1) },
      sweptBoth: { count: sweptBothCount, pct: round(sweptBothCount/total*100, 1) },
      sweptNeither: { count: sweptNeitherCount, pct: round(sweptNeitherCount/total*100, 1) },
      sequence: {
        pdhFirst: pdhFirstCount,
        pdlFirst: pdlFirstCount,
        simultaneous: simultaneousCount
      },
      secondFollowRate,
      timeBetweenSweeps: timePercentiles,
      mfe: { ...mfePercentiles, avg: mfeValues.length > 0 ? round(mfeValues.reduce((a, b) => a + b, 0) / mfeValues.length, 1) : 0 },
      mae: { ...maePercentiles, avg: maeValues.length > 0 ? round(maeValues.reduce((a, b) => a + b, 0) / maeValues.length, 1) : 0 },
      byGapDirection: byGap,
      byOvernightRange: byONRange,
      byPDRange: byPDRange,
      byDayOfWeek: byDOW,
      correlations: {
        pdRangeVsBothSwept: corrPDRangeVsBoth,
        gapSizeVsBothSwept: corrGapVsBoth,
        pdRangeVsMFE: corrPDRangeVsMFE
      }
    };
  }

  // --- 1-Second Volume Velocity at Sweeps (default threshold only) ---
  console.log('\n=== Volume Velocity Analysis (1s resolution) ===');
  console.log('Loading 1s data at sweep points...\n');

  const defaultThreshold = thresholds.includes(2) ? 2 : thresholds[0];
  const defaultKey = `threshold_${defaultThreshold}`;

  // Rebuild day results for 1s analysis (use same threshold)
  // We'll sample sweep events — analyze first 200 both-swept days for performance
  const dayResultsForVelocity = [];
  let velocityCount = 0;
  const MAX_VELOCITY_SAMPLES = 200;

  for (let i = 0; i < tradingDates.length && velocityCount < MAX_VELOCITY_SAMPLES; i++) {
    const dateStr = tradingDates[i];
    const prevLevels = getPrevDayLevelsFromArray(candles, dateStr, tradingDates);
    if (!prevLevels) continue;

    const pdh = prevLevels.high;
    const pdl = prevLevels.low;
    const rthCandles = getRTHCandlesFromArray(candles, dateStr);
    if (rthCandles.length < 10) continue;

    let pdhSweepCandle = null;
    let pdlSweepCandle = null;

    for (const c of rthCandles) {
      if (!pdhSweepCandle && c.high >= pdh - defaultThreshold) pdhSweepCandle = c;
      if (!pdlSweepCandle && c.low <= pdl + defaultThreshold) pdlSweepCandle = c;
    }

    if (!pdhSweepCandle && !pdlSweepCandle) continue;

    // Analyze first sweep that occurred
    const sweepCandle = pdhSweepCandle && pdlSweepCandle
      ? (pdhSweepCandle.timestamp <= pdlSweepCandle.timestamp ? pdhSweepCandle : pdlSweepCandle)
      : (pdhSweepCandle || pdlSweepCandle);

    const sweepSide = sweepCandle === pdhSweepCandle ? 'PDH' : 'PDL';
    const level = sweepSide === 'PDH' ? pdh : pdl;

    // Floor to minute
    const minuteTs = Math.floor(sweepCandle.timestamp / 60000) * 60000;

    try {
      const secondCandles = await load1sRange(product, minuteTs, 2, 2);
      if (secondCandles.length === 0) continue;

      // Find the exact sweep second
      let sweepSecond = null;
      for (const sc of secondCandles) {
        if (sweepSide === 'PDH' && sc.high >= level - defaultThreshold) {
          sweepSecond = sc;
          break;
        }
        if (sweepSide === 'PDL' && sc.low <= level + defaultThreshold) {
          sweepSecond = sc;
          break;
        }
      }

      if (!sweepSecond) continue;

      const sweepSecIdx = secondCandles.indexOf(sweepSecond);

      // Volume metrics
      const rollingWindow = secondCandles.slice(Math.max(0, sweepSecIdx - 60), sweepSecIdx);
      const avgVol60s = rollingWindow.length > 0
        ? rollingWindow.reduce((s, c) => s + c.volume, 0) / rollingWindow.length
        : 1;

      const sweepVol = sweepSecond.volume;
      const volumeSpike = avgVol60s > 0 ? round(sweepVol / avgVol60s, 1) : 0;

      // Absorption: volume in first 3 seconds of sweep vs total 10s
      const first3 = secondCandles.slice(sweepSecIdx, sweepSecIdx + 3);
      const next10 = secondCandles.slice(sweepSecIdx, sweepSecIdx + 10);
      const first3Vol = first3.reduce((s, c) => s + c.volume, 0);
      const next10Vol = next10.reduce((s, c) => s + c.volume, 0);
      const absorptionPct = next10Vol > 0 ? round(first3Vol / next10Vol * 100, 1) : 0;

      // Post-sweep decay: volume in seconds 5-10 vs sweep second
      const post5to10 = secondCandles.slice(sweepSecIdx + 5, sweepSecIdx + 10);
      const post5to10Vol = post5to10.length > 0
        ? post5to10.reduce((s, c) => s + c.volume, 0) / post5to10.length
        : 0;
      const decayRatio = sweepVol > 0 ? round(post5to10Vol / sweepVol, 2) : 0;

      // Sweep depth: max excursion beyond the level
      const sweepDirection = sweepSide === 'PDH' ? 1 : -1;
      let maxDepth = 0;
      for (let j = sweepSecIdx; j < Math.min(sweepSecIdx + 30, secondCandles.length); j++) {
        const sc = secondCandles[j];
        const depth = sweepSide === 'PDH' ? sc.high - level : level - sc.low;
        maxDepth = Math.max(maxDepth, depth);
      }

      // Reversal timing: seconds until first candle closes back inside level
      let reversalSeconds = null;
      for (let j = sweepSecIdx + 1; j < Math.min(sweepSecIdx + 60, secondCandles.length); j++) {
        const sc = secondCandles[j];
        const insideLevel = sweepSide === 'PDH' ? sc.close < level : sc.close > level;
        if (insideLevel) {
          reversalSeconds = j - sweepSecIdx;
          break;
        }
      }

      // Sweep velocity: points per second in 10s window around sweep
      const vel10s = secondCandles.slice(Math.max(0, sweepSecIdx - 5), sweepSecIdx + 5);
      let maxPriceMove = 0;
      if (vel10s.length >= 2) {
        const velHigh = Math.max(...vel10s.map(c => c.high));
        const velLow = Math.min(...vel10s.map(c => c.low));
        maxPriceMove = velHigh - velLow;
      }
      const sweepVelocity = vel10s.length > 0 ? round(maxPriceMove / vel10s.length, 2) : 0;

      // Did it reverse after the sweep?
      const reversed = reversalSeconds !== null && reversalSeconds <= 30;

      dayResultsForVelocity.push({
        date: dateStr,
        sweepSide,
        level: round(level, 2),
        volumeSpike,
        absorptionPct,
        decayRatio,
        sweepDepth: round(maxDepth, 2),
        reversalSeconds,
        reversed,
        sweepVelocity
      });
      velocityCount++;
    } catch (e) {
      // Skip if 1s data unavailable for this date
      continue;
    }
  }

  console.log(`  Analyzed ${dayResultsForVelocity.length} sweep events at 1s resolution\n`);

  // Volume velocity summary
  if (dayResultsForVelocity.length > 0) {
    const volSpikes = dayResultsForVelocity.map(d => d.volumeSpike);
    const depths = dayResultsForVelocity.map(d => d.sweepDepth);
    const reversals = dayResultsForVelocity.filter(d => d.reversed);
    const nonReversals = dayResultsForVelocity.filter(d => !d.reversed);

    console.log('  Volume Velocity Summary:');
    console.log(`    Volume spike at sweep: ${JSON.stringify(calculatePercentiles(volSpikes, [25, 50, 75, 90]))}`);
    console.log(`    Sweep depth (pts): ${JSON.stringify(calculatePercentiles(depths, [25, 50, 75, 90]))}`);
    console.log(`    Reversed within 30s: ${reversals.length}/${dayResultsForVelocity.length} (${round(reversals.length/dayResultsForVelocity.length*100, 1)}%)`);

    // Compare volume characteristics: reversals vs breakouts
    if (reversals.length > 5 && nonReversals.length > 5) {
      const revAvgSpike = round(reversals.reduce((s, d) => s + d.volumeSpike, 0) / reversals.length, 1);
      const noRevAvgSpike = round(nonReversals.reduce((s, d) => s + d.volumeSpike, 0) / nonReversals.length, 1);
      const revAvgDecay = round(reversals.reduce((s, d) => s + d.decayRatio, 0) / reversals.length, 2);
      const noRevAvgDecay = round(nonReversals.reduce((s, d) => s + d.decayRatio, 0) / nonReversals.length, 2);
      const revAvgDepth = round(reversals.reduce((s, d) => s + d.sweepDepth, 0) / reversals.length, 1);
      const noRevAvgDepth = round(nonReversals.reduce((s, d) => s + d.sweepDepth, 0) / nonReversals.length, 1);

      console.log('\n    Reversal vs Breakout comparison:');
      console.log(`      Avg volume spike: Reversal=${revAvgSpike}x | Breakout=${noRevAvgSpike}x`);
      console.log(`      Avg decay ratio: Reversal=${revAvgDecay} | Breakout=${noRevAvgDecay}`);
      console.log(`      Avg sweep depth: Reversal=${revAvgDepth} | Breakout=${noRevAvgDepth}`);
    }
  }

  // --- Save Results ---
  const results = {
    study: 'Sweep Clock - PDH/PDL Liquidity Rotation',
    product,
    dateRange: { start: startDate, end: endDate },
    tradingDays: tradingDates.length,
    timestamp: new Date().toISOString(),
    thresholdAnalysis: allResults,
    volumeVelocity: {
      sampleCount: dayResultsForVelocity.length,
      threshold: defaultThreshold,
      events: dayResultsForVelocity,
      summary: dayResultsForVelocity.length > 0 ? {
        volumeSpike: calculatePercentiles(dayResultsForVelocity.map(d => d.volumeSpike), [25, 50, 75, 90]),
        sweepDepth: calculatePercentiles(dayResultsForVelocity.map(d => d.sweepDepth), [25, 50, 75, 90]),
        absorptionPct: calculatePercentiles(dayResultsForVelocity.map(d => d.absorptionPct), [25, 50, 75, 90]),
        decayRatio: calculatePercentiles(dayResultsForVelocity.map(d => d.decayRatio), [25, 50, 75, 90]),
        reversalRate: round(dayResultsForVelocity.filter(d => d.reversed).length / dayResultsForVelocity.length * 100, 1),
        reversalWithHighSpike: (() => {
          const highSpike = dayResultsForVelocity.filter(d => d.volumeSpike >= 3);
          return highSpike.length > 0
            ? round(highSpike.filter(d => d.reversed).length / highSpike.length * 100, 1)
            : null;
        })(),
        reversalWithLowDecay: (() => {
          const lowDecay = dayResultsForVelocity.filter(d => d.decayRatio < 0.3);
          return lowDecay.length > 0
            ? round(lowDecay.filter(d => d.reversed).length / lowDecay.length * 100, 1)
            : null;
        })()
      } : null
    }
  };

  const filename = `sweep-clock-${product.toLowerCase()}.json`;
  saveResults(filename, results);

  console.log(`\nResults saved to results/research/${filename}`);
  console.log('Done.');
})();
