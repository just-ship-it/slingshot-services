/**
 * Study 2: Session Liquidity Rotation (Asia → Europe → US)
 *
 * Market Maker Logic: Each session's participants hunt the previous session's liquidity.
 * Asian traders build a range. European traders sweep one side (hunting Asian stops).
 * US traders sweep the other (what's left).
 *
 * Core Questions:
 *  1. What % of days does European session sweep the Asian high? Low? Both?
 *  2. When Europe sweeps one side, what % does US RTH sweep the other?
 *  3. Rotation vs continuation rate (Europe and US sweep same vs opposite side)
 *  4. Does Asian range size affect rotation reliability?
 *  5. MFE/MAE for positioning after European sweep, targeting US sweep of opposite side
 *  6. Volume characteristics at each session's sweep (1s analysis)
 *
 * Session Definitions (ET):
 *   Asian:    7:00 PM – 3:00 AM (previous evening → early morning)
 *   European: 3:00 AM – 9:30 AM
 *   US RTH:   9:30 AM – 4:00 PM
 *
 * Usage:
 *   node research/session-rotation.js [--product NQ|ES]
 */

import {
  loadContinuousOHLCV,
  load1sRange,
  extractTradingDates,
  getAsianCandles,
  getEuropeanCandles,
  getRTHCandlesFromArray,
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
const TOUCH_THRESHOLD = 2; // points

console.log(`\n=== Session Rotation Study: ${product} ===`);
console.log(`Touch threshold: ${TOUCH_THRESHOLD} points\n`);

// --- Main ---
(async () => {
  const startDate = '2021-01-01';
  const endDate = '2026-01-31';

  console.log('Loading continuous 1m data...');
  const candles = await loadContinuousOHLCV(product, '1m', startDate, endDate);
  const tradingDates = extractTradingDates(candles);
  console.log(`Found ${tradingDates.length} trading days\n`);

  const dayResults = [];
  let skipped = 0;

  for (let i = 0; i < tradingDates.length; i++) {
    const dateStr = tradingDates[i];

    // Get session candles
    const asianCandles = getAsianCandles(candles, dateStr);
    const euroCandles = getEuropeanCandles(candles, dateStr);
    const rthCandles = getRTHCandlesFromArray(candles, dateStr);

    if (asianCandles.length < 5 || euroCandles.length < 5 || rthCandles.length < 10) {
      skipped++;
      continue;
    }

    // Asian session range
    const asianHigh = Math.max(...asianCandles.map(c => c.high));
    const asianLow = Math.min(...asianCandles.map(c => c.low));
    const asianRange = asianHigh - asianLow;
    const asianClose = asianCandles[asianCandles.length - 1].close;

    // European session: did it sweep Asian high/low?
    let euroSweptHigh = false, euroSweptLow = false;
    let euroHighSweepCandle = null, euroLowSweepCandle = null;
    let euroHighSweepIdx = -1, euroLowSweepIdx = -1;

    for (let j = 0; j < euroCandles.length; j++) {
      const c = euroCandles[j];
      if (!euroSweptHigh && c.high >= asianHigh - TOUCH_THRESHOLD) {
        euroSweptHigh = true;
        euroHighSweepCandle = c;
        euroHighSweepIdx = j;
      }
      if (!euroSweptLow && c.low <= asianLow + TOUCH_THRESHOLD) {
        euroSweptLow = true;
        euroLowSweepCandle = c;
        euroLowSweepIdx = j;
      }
    }

    const euroSweptBoth = euroSweptHigh && euroSweptLow;
    let euroFirstSwept = null;
    if (euroSweptBoth) {
      euroFirstSwept = euroHighSweepIdx <= euroLowSweepIdx ? 'high' : 'low';
    } else if (euroSweptHigh) {
      euroFirstSwept = 'high_only';
    } else if (euroSweptLow) {
      euroFirstSwept = 'low_only';
    }

    // European close price (or last candle)
    const euroClose = euroCandles[euroCandles.length - 1].close;

    // US RTH: did it sweep the OPPOSITE side from Europe?
    let rthSweptHigh = false, rthSweptLow = false;
    let rthHighSweepCandle = null, rthLowSweepCandle = null;

    for (const c of rthCandles) {
      if (!rthSweptHigh && c.high >= asianHigh - TOUCH_THRESHOLD) {
        rthSweptHigh = true;
        rthHighSweepCandle = c;
      }
      if (!rthSweptLow && c.low <= asianLow + TOUCH_THRESHOLD) {
        rthSweptLow = true;
        rthLowSweepCandle = c;
      }
    }

    // Rotation classification
    let rotationType = 'none';
    if (euroSweptHigh && !euroSweptLow && rthSweptLow) {
      rotationType = 'euro_high_rth_low'; // Classic rotation
    } else if (euroSweptLow && !euroSweptHigh && rthSweptHigh) {
      rotationType = 'euro_low_rth_high'; // Classic rotation
    } else if (euroSweptHigh && !euroSweptLow && rthSweptHigh && !rthSweptLow) {
      rotationType = 'continuation_up'; // Both sessions push up
    } else if (euroSweptLow && !euroSweptHigh && rthSweptLow && !rthSweptHigh) {
      rotationType = 'continuation_down'; // Both sessions push down
    } else if (euroSweptBoth) {
      rotationType = 'euro_both';
    } else if (!euroSweptHigh && !euroSweptLow) {
      rotationType = 'euro_neither';
    } else {
      rotationType = 'other';
    }

    const isRotation = rotationType === 'euro_high_rth_low' || rotationType === 'euro_low_rth_high';
    const isContinuation = rotationType === 'continuation_up' || rotationType === 'continuation_down';

    // MFE/MAE: If Europe swept one side, simulate positioning at Euro close toward opposite side
    let mfe = null, mae = null;
    if ((euroSweptHigh && !euroSweptLow) || (euroSweptLow && !euroSweptHigh)) {
      const direction = euroSweptHigh ? -1 : 1; // After high sweep, expect rotation down; after low sweep, up
      const entryPrice = rthCandles[0].open; // Enter at RTH open
      let maxFavorable = 0, maxAdverse = 0;

      for (const c of rthCandles) {
        const moveHigh = (c.high - entryPrice) * direction;
        const moveLow = (c.low - entryPrice) * direction;
        maxFavorable = Math.max(maxFavorable, moveHigh, moveLow);
        maxAdverse = Math.min(maxAdverse, moveHigh, moveLow);
      }
      mfe = round(maxFavorable, 2);
      mae = round(Math.abs(maxAdverse), 2);
    }

    // Gap at RTH open from Euro close
    const rthOpen = rthCandles[0].open;
    const gapFromEuro = round(rthOpen - euroClose, 2);

    // Context buckets
    const asianRangeBucket = bucket(asianRange, [20, 40, 60, 100, 150]);
    const dayOfWeek = new Date(dateStr).getUTCDay();

    dayResults.push({
      date: dateStr,
      asianHigh: round(asianHigh, 2),
      asianLow: round(asianLow, 2),
      asianRange: round(asianRange, 2),
      asianRangeBucket,
      euroSweptHigh,
      euroSweptLow,
      euroSweptBoth,
      euroFirstSwept,
      rthSweptHigh,
      rthSweptLow,
      rotationType,
      isRotation,
      isContinuation,
      mfe, mae,
      gapFromEuro,
      dayOfWeek,
      euroHighSweepTs: euroHighSweepCandle?.timestamp || null,
      euroLowSweepTs: euroLowSweepCandle?.timestamp || null,
      rthHighSweepTs: rthHighSweepCandle?.timestamp || null,
      rthLowSweepTs: rthLowSweepCandle?.timestamp || null
    });
  }

  console.log(`Analyzed ${dayResults.length} days (${skipped} skipped)\n`);

  // --- Aggregate Stats ---
  const total = dayResults.length;

  // European sweep rates
  const euroSweptHighCount = dayResults.filter(d => d.euroSweptHigh).length;
  const euroSweptLowCount = dayResults.filter(d => d.euroSweptLow).length;
  const euroSweptBothCount = dayResults.filter(d => d.euroSweptBoth).length;
  const euroSweptNeitherCount = dayResults.filter(d => !d.euroSweptHigh && !d.euroSweptLow).length;

  // RTH sweep of opposite side (rotation)
  const euroOneSide = dayResults.filter(d => (d.euroSweptHigh || d.euroSweptLow) && !d.euroSweptBoth);
  const rotationCount = dayResults.filter(d => d.isRotation).length;
  const continuationCount = dayResults.filter(d => d.isContinuation).length;
  const rotationRate = euroOneSide.length > 0 ? round(rotationCount / euroOneSide.length * 100, 1) : 0;
  const continuationRate = euroOneSide.length > 0 ? round(continuationCount / euroOneSide.length * 100, 1) : 0;

  // Rotation types breakdown
  const rotationTypes = {};
  for (const d of dayResults) {
    rotationTypes[d.rotationType] = (rotationTypes[d.rotationType] || 0) + 1;
  }

  // MFE/MAE for rotation trades
  const mfeValues = dayResults.filter(d => d.mfe !== null).map(d => d.mfe);
  const maeValues = dayResults.filter(d => d.mae !== null).map(d => d.mae);
  const rotationMFE = dayResults.filter(d => d.isRotation && d.mfe !== null).map(d => d.mfe);
  const rotationMAE = dayResults.filter(d => d.isRotation && d.mae !== null).map(d => d.mae);
  const contMFE = dayResults.filter(d => d.isContinuation && d.mfe !== null).map(d => d.mfe);
  const contMAE = dayResults.filter(d => d.isContinuation && d.mae !== null).map(d => d.mae);

  // By Asian range
  function analyzeBy(field, label) {
    const groups = {};
    for (const d of dayResults) {
      const key = d[field];
      if (key === undefined || key === null || key === 'unknown') continue;
      if (!groups[key]) groups[key] = { count: 0, rotation: 0, continuation: 0, mfe: [], mae: [] };
      groups[key].count++;
      if (d.isRotation) groups[key].rotation++;
      if (d.isContinuation) groups[key].continuation++;
      if (d.mfe !== null) { groups[key].mfe.push(d.mfe); groups[key].mae.push(d.mae); }
    }
    return Object.entries(groups).map(([k, v]) => ({
      group: k,
      days: v.count,
      rotationPct: round(v.rotation / v.count * 100, 1),
      continuationPct: round(v.continuation / v.count * 100, 1),
      avgMFE: v.mfe.length > 0 ? round(v.mfe.reduce((a, b) => a + b, 0) / v.mfe.length, 1) : null,
      avgMAE: v.mae.length > 0 ? round(v.mae.reduce((a, b) => a + b, 0) / v.mae.length, 1) : null
    }));
  }

  const byAsianRange = analyzeBy('asianRangeBucket', 'Asian Range');
  const byDOW = analyzeBy('dayOfWeek', 'Day of Week');

  // Correlations
  const asianRanges = dayResults.map(d => d.asianRange);
  const rotationBinary = dayResults.map(d => d.isRotation ? 1 : 0);
  const corrRangeVsRotation = correlation(asianRanges, rotationBinary);

  // --- Console Summary ---
  console.log('European Session Sweep of Asian Range:');
  console.log(`  Swept Asian High: ${euroSweptHighCount}/${total} (${round(euroSweptHighCount/total*100, 1)}%)`);
  console.log(`  Swept Asian Low:  ${euroSweptLowCount}/${total} (${round(euroSweptLowCount/total*100, 1)}%)`);
  console.log(`  Swept Both:       ${euroSweptBothCount}/${total} (${round(euroSweptBothCount/total*100, 1)}%)`);
  console.log(`  Swept Neither:    ${euroSweptNeitherCount}/${total} (${round(euroSweptNeitherCount/total*100, 1)}%)`);
  console.log();
  console.log('Session Rotation (Europe one side → RTH opposite):');
  console.log(`  Euro one-side sweep days: ${euroOneSide.length}`);
  console.log(`  Rotation rate: ${rotationRate}% (${rotationCount}/${euroOneSide.length})`);
  console.log(`  Continuation rate: ${continuationRate}% (${continuationCount}/${euroOneSide.length})`);
  console.log();
  console.log('Rotation Types:', JSON.stringify(rotationTypes, null, 2));
  console.log();
  console.log('MFE/MAE (positioning at RTH open after Euro one-side sweep):');
  console.log(`  All: MFE p50=${calculatePercentiles(mfeValues, [50]).p50} MAE p50=${calculatePercentiles(maeValues, [50]).p50} (n=${mfeValues.length})`);
  if (rotationMFE.length > 0)
    console.log(`  Rotation days: MFE avg=${round(rotationMFE.reduce((a, b) => a + b, 0) / rotationMFE.length, 1)} MAE avg=${round(rotationMAE.reduce((a, b) => a + b, 0) / rotationMAE.length, 1)} (n=${rotationMFE.length})`);
  if (contMFE.length > 0)
    console.log(`  Continuation days: MFE avg=${round(contMFE.reduce((a, b) => a + b, 0) / contMFE.length, 1)} MAE avg=${round(contMAE.reduce((a, b) => a + b, 0) / contMAE.length, 1)} (n=${contMFE.length})`);
  console.log();
  console.log('By Asian Range Size:');
  for (const g of byAsianRange) {
    console.log(`  ${g.group}: ${g.days} days, rotation=${g.rotationPct}%, continuation=${g.continuationPct}%, MFE=${g.avgMFE}, MAE=${g.avgMAE}`);
  }

  // --- 1-Second Volume Velocity at Session Sweeps ---
  console.log('\n=== Volume Velocity at Session Sweeps (1s) ===');

  const velocityEvents = [];
  const MAX_SAMPLES = 150;

  for (let i = 0; i < dayResults.length && velocityEvents.length < MAX_SAMPLES; i++) {
    const d = dayResults[i];
    // Analyze European sweep of Asian range
    const sweepTs = d.euroHighSweepTs || d.euroLowSweepTs;
    if (!sweepTs) continue;
    const sweepSide = d.euroHighSweepTs ? 'high' : 'low';
    const level = sweepSide === 'high' ? d.asianHigh : d.asianLow;

    const minuteTs = Math.floor(sweepTs / 60000) * 60000;
    try {
      const secs = await load1sRange(product, minuteTs, 2, 2);
      if (secs.length === 0) continue;

      // Find sweep second
      let sweepSec = null;
      for (const sc of secs) {
        if (sweepSide === 'high' && sc.high >= level - TOUCH_THRESHOLD) { sweepSec = sc; break; }
        if (sweepSide === 'low' && sc.low <= level + TOUCH_THRESHOLD) { sweepSec = sc; break; }
      }
      if (!sweepSec) continue;

      const idx = secs.indexOf(sweepSec);
      const pre60 = secs.slice(Math.max(0, idx - 60), idx);
      const avgVol = pre60.length > 0 ? pre60.reduce((s, c) => s + c.volume, 0) / pre60.length : 1;
      const spike = avgVol > 0 ? round(sweepSec.volume / avgVol, 1) : 0;

      const post5to10 = secs.slice(idx + 5, idx + 10);
      const decayVol = post5to10.length > 0 ? post5to10.reduce((s, c) => s + c.volume, 0) / post5to10.length : 0;
      const decay = sweepSec.volume > 0 ? round(decayVol / sweepSec.volume, 2) : 0;

      // Sweep depth
      let depth = 0;
      for (let j = idx; j < Math.min(idx + 30, secs.length); j++) {
        const d2 = sweepSide === 'high' ? secs[j].high - level : level - secs[j].low;
        depth = Math.max(depth, d2);
      }

      velocityEvents.push({
        date: d.date,
        session: 'european',
        sweepSide,
        volumeSpike: spike,
        decayRatio: decay,
        sweepDepth: round(depth, 2),
        isRotationDay: d.isRotation
      });
    } catch (e) { continue; }
  }

  if (velocityEvents.length > 0) {
    console.log(`  Analyzed ${velocityEvents.length} European sweep events`);
    const rotEvents = velocityEvents.filter(v => v.isRotationDay);
    const noRotEvents = velocityEvents.filter(v => !v.isRotationDay);
    console.log(`  Rotation days avg spike: ${rotEvents.length > 0 ? round(rotEvents.reduce((s, v) => s + v.volumeSpike, 0) / rotEvents.length, 1) : 'N/A'}x`);
    console.log(`  Non-rotation days avg spike: ${noRotEvents.length > 0 ? round(noRotEvents.reduce((s, v) => s + v.volumeSpike, 0) / noRotEvents.length, 1) : 'N/A'}x`);
    console.log(`  Rotation days avg decay: ${rotEvents.length > 0 ? round(rotEvents.reduce((s, v) => s + v.decayRatio, 0) / rotEvents.length, 2) : 'N/A'}`);
    console.log(`  Non-rotation days avg decay: ${noRotEvents.length > 0 ? round(noRotEvents.reduce((s, v) => s + v.decayRatio, 0) / noRotEvents.length, 2) : 'N/A'}`);
  }

  // --- Save Results ---
  const results = {
    study: 'Session Rotation - Asia → Europe → US Liquidity Rotation',
    product,
    dateRange: { start: startDate, end: endDate },
    tradingDays: total,
    timestamp: new Date().toISOString(),
    touchThreshold: TOUCH_THRESHOLD,
    europeanSweep: {
      sweptHigh: { count: euroSweptHighCount, pct: round(euroSweptHighCount/total*100, 1) },
      sweptLow: { count: euroSweptLowCount, pct: round(euroSweptLowCount/total*100, 1) },
      sweptBoth: { count: euroSweptBothCount, pct: round(euroSweptBothCount/total*100, 1) },
      sweptNeither: { count: euroSweptNeitherCount, pct: round(euroSweptNeitherCount/total*100, 1) }
    },
    rotation: {
      euroOneSideDays: euroOneSide.length,
      rotationRate,
      continuationRate,
      rotationCount,
      continuationCount,
      types: rotationTypes
    },
    mfeMAE: {
      all: {
        count: mfeValues.length,
        mfe: calculatePercentiles(mfeValues, [25, 50, 75, 90]),
        mae: calculatePercentiles(maeValues, [25, 50, 75, 90]),
        avgMFE: mfeValues.length > 0 ? round(mfeValues.reduce((a, b) => a + b, 0) / mfeValues.length, 1) : 0,
        avgMAE: maeValues.length > 0 ? round(maeValues.reduce((a, b) => a + b, 0) / maeValues.length, 1) : 0
      },
      rotation: {
        count: rotationMFE.length,
        avgMFE: rotationMFE.length > 0 ? round(rotationMFE.reduce((a, b) => a + b, 0) / rotationMFE.length, 1) : 0,
        avgMAE: rotationMAE.length > 0 ? round(rotationMAE.reduce((a, b) => a + b, 0) / rotationMAE.length, 1) : 0
      },
      continuation: {
        count: contMFE.length,
        avgMFE: contMFE.length > 0 ? round(contMFE.reduce((a, b) => a + b, 0) / contMFE.length, 1) : 0,
        avgMAE: contMAE.length > 0 ? round(contMAE.reduce((a, b) => a + b, 0) / contMAE.length, 1) : 0
      }
    },
    byAsianRange,
    byDayOfWeek: byDOW,
    correlations: {
      asianRangeVsRotation: corrRangeVsRotation
    },
    volumeVelocity: {
      sampleCount: velocityEvents.length,
      events: velocityEvents
    }
  };

  const filename = `session-rotation-${product.toLowerCase()}.json`;
  saveResults(filename, results);

  console.log(`\nResults saved to results/research/${filename}`);
  console.log('Done.');
})();
