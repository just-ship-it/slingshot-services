/**
 * Study A: Pre-Sweep Side Prediction
 *
 * Question: Before each session begins, can we predict whether the HIGH or LOW
 * side of the Asian range will be swept first?
 *
 * Features computed at session boundary (3 AM ET for Euro, 9:30 AM ET for RTH):
 *   - LT Configuration (5): level counts above/below, asymmetry, nearest distances
 *   - LT Migration (3): level movement, crossing count/direction over prior 2h
 *   - GEX Asymmetry (5): call/put wall distances, gamma flip position, regime
 *   - Overnight Context (5): range, bias, Asian range, gap from PDC, position in ON range
 *   - Early Session Volume (3): volume ratio, side bias, direction (RTH pass only)
 *
 * Two passes per day:
 *   1. Pre-European (3 AM ET) → predict Euro sweep direction
 *   2. Pre-RTH (9:30 AM ET) → predict RTH sweep direction (includes Euro result)
 *
 * Overfitting guardrails:
 *   - Min 50 samples per bucket
 *   - proportionZTest for significance
 *   - Out-of-sample: train 2023-2024, test 2025
 *   - Cross-validate NQ vs ES
 *
 * Usage:
 *   node research/pre-sweep-prediction.js [--product NQ|ES]
 */

import {
  loadContinuousOHLCV,
  extractTradingDates,
  getAsianCandles,
  getEuropeanCandles,
  getRTHCandlesFromArray,
  getOvernightCandlesFromArray,
  getPrevDayLevelsFromArray,
  loadIntradayGEX,
  getGEXSnapshotAt,
  loadLTLevels,
  getLTSnapshotAt,
  toET,
  fromET
} from './utils/data-loader.js';

import {
  round,
  bucket,
  saveResults,
  calculatePercentiles,
  correlation,
  proportionZTest
} from './utils/analysis-helpers.js';

// --- CLI Args ---
const args = process.argv.slice(2);
const product = (args.find(a => a === '--product') ? args[args.indexOf('--product') + 1] : 'NQ').toUpperCase();
const TOUCH_THRESHOLD = 2; // points

console.log(`\n=== Pre-Sweep Side Prediction: ${product} ===`);
console.log(`Touch threshold: ${TOUCH_THRESHOLD} points\n`);

// --- Feature Extraction Helpers ---

/**
 * Compute LT configuration features at a given timestamp
 */
function computeLTFeatures(ltLevels, price, timestamp) {
  const snap = getLTSnapshotAt(ltLevels, timestamp);
  if (!snap) return null;

  const levels = snap.levels;
  const above = levels.filter(l => l > price);
  const below = levels.filter(l => l <= price);

  const nearestAbove = above.length > 0 ? Math.min(...above.map(l => l - price)) : null;
  const nearestBelow = below.length > 0 ? Math.min(...below.map(l => price - l)) : null;

  return {
    lt_above_count: above.length,
    lt_below_count: below.length,
    lt_asymmetry: round((above.length - below.length) / 5, 2),
    lt_nearest_above_dist: nearestAbove !== null ? round(nearestAbove, 2) : null,
    lt_nearest_below_dist: nearestBelow !== null ? round(nearestBelow, 2) : null,
    lt_sentiment: snap.sentiment
  };
}

/**
 * Compute LT migration features over prior 2 hours
 */
function computeLTMigration(ltLevels, price, timestamp) {
  const current = getLTSnapshotAt(ltLevels, timestamp);
  const twoHoursAgo = getLTSnapshotAt(ltLevels, timestamp - 2 * 3600000);

  if (!current || !twoHoursAgo) return { lt_migration_direction: 0, lt_crossing_count: 0, lt_crossing_direction: 'none' };

  // Net migration: average level movement (negative = levels moved down)
  let totalMigration = 0;
  for (let i = 0; i < 5; i++) {
    totalMigration += current.levels[i] - twoHoursAgo.levels[i];
  }
  const avgMigration = totalMigration / 5;

  // Count crossings: levels that were on one side of price and are now on the other
  let bullishCrossings = 0; // level moved from above to below (support forming)
  let bearishCrossings = 0; // level moved from below to above (resistance forming)

  for (let i = 0; i < 5; i++) {
    const wasBelowPrice = twoHoursAgo.levels[i] <= price;
    const isNowBelowPrice = current.levels[i] <= price;
    if (!wasBelowPrice && isNowBelowPrice) bullishCrossings++;
    if (wasBelowPrice && !isNowBelowPrice) bearishCrossings++;
  }

  const totalCrossings = bullishCrossings + bearishCrossings;
  let crossingDirection = 'none';
  if (bullishCrossings > bearishCrossings) crossingDirection = 'bullish';
  else if (bearishCrossings > bullishCrossings) crossingDirection = 'bearish';

  return {
    lt_migration_direction: round(avgMigration, 2),
    lt_crossing_count: totalCrossings,
    lt_crossing_direction: crossingDirection
  };
}

/**
 * Compute GEX asymmetry features at a given timestamp
 */
function computeGEXFeatures(gexSnapshots, price, timestamp) {
  const snap = getGEXSnapshotAt(gexSnapshots, timestamp);
  if (!snap) return null;

  const callWall = snap.call_wall || snap.resistance?.[0] || null;
  const putWall = snap.put_wall || snap.support?.[0] || null;
  const gammaFlip = snap.gamma_flip || null;

  const callDist = callWall ? round(callWall - price, 2) : null;
  const putDist = putWall ? round(price - putWall, 2) : null;

  return {
    gex_call_wall_dist: callDist,
    gex_put_wall_dist: putDist,
    gex_wall_asymmetry: callDist !== null && putDist !== null ? round(callDist - putDist, 2) : null,
    gex_gamma_flip_position: gammaFlip !== null ? (gammaFlip < price ? 'below' : 'above') : null,
    gex_regime: snap.regime || null,
    gex_total_magnitude: snap.total_gex || null
  };
}

/**
 * Compute overnight context features
 */
function computeOvernightFeatures(asianCandles, overnightCandles, prevLevels, price) {
  const result = {
    overnight_range: null,
    overnight_bias: null,
    asian_range: null,
    gap_from_pdc: null,
    price_position_in_on_range: null
  };

  if (overnightCandles.length > 0) {
    const onHigh = Math.max(...overnightCandles.map(c => c.high));
    const onLow = Math.min(...overnightCandles.map(c => c.low));
    const onRange = onHigh - onLow;
    const onOpen = overnightCandles[0].open;
    const onClose = overnightCandles[overnightCandles.length - 1].close;

    result.overnight_range = round(onRange, 2);
    result.overnight_bias = onRange > 0 ? round((onClose - onOpen) / onRange, 2) : 0;
    result.price_position_in_on_range = onRange > 0 ? round((price - onLow) / onRange, 2) : 0.5;
  }

  if (asianCandles.length > 0) {
    const asianHigh = Math.max(...asianCandles.map(c => c.high));
    const asianLow = Math.min(...asianCandles.map(c => c.low));
    result.asian_range = round(asianHigh - asianLow, 2);
  }

  if (prevLevels) {
    result.gap_from_pdc = round(price - prevLevels.close, 2);
  }

  return result;
}

/**
 * Compute early session volume features (first 30 min of session candles)
 */
function computeEarlyVolumeFeatures(sessionCandles) {
  if (sessionCandles.length < 5) return { early_volume_ratio: null, early_volume_side_bias: null, early_direction: null };

  const first30 = sessionCandles.slice(0, 30);
  const totalVol = first30.reduce((s, c) => s + c.volume, 0);
  const avgVol = sessionCandles.length >= 50
    ? sessionCandles.slice(0, 50).reduce((s, c) => s + c.volume, 0) / 50
    : totalVol / first30.length;

  const earlyVolumeRatio = avgVol > 0 ? round((totalVol / first30.length) / avgVol, 2) : 1;

  // Volume on up vs down candles
  let upVol = 0, downVol = 0;
  for (const c of first30) {
    if (c.close >= c.open) upVol += c.volume;
    else downVol += c.volume;
  }
  const totalSided = upVol + downVol;
  const sideBias = totalSided > 0 ? round((upVol - downVol) / totalSided, 2) : 0;

  // First 30 min direction
  const earlyDirection = first30.length > 0
    ? (first30[first30.length - 1].close > first30[0].open ? 'up' : 'down')
    : null;

  return {
    early_volume_ratio: earlyVolumeRatio,
    early_volume_side_bias: sideBias,
    early_direction: earlyDirection
  };
}

/**
 * Detect which side of a range gets swept first in a set of candles
 */
function detectSweep(candles, high, low, threshold) {
  let highSweepIdx = -1;
  let lowSweepIdx = -1;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (highSweepIdx === -1 && c.high >= high - threshold) highSweepIdx = i;
    if (lowSweepIdx === -1 && c.low <= low + threshold) lowSweepIdx = i;
  }

  const sweptHigh = highSweepIdx !== -1;
  const sweptLow = lowSweepIdx !== -1;

  let firstSweptSide = null;
  if (sweptHigh && sweptLow) {
    firstSweptSide = highSweepIdx <= lowSweepIdx ? 'high' : 'low';
  } else if (sweptHigh) {
    firstSweptSide = 'high';
  } else if (sweptLow) {
    firstSweptSide = 'low';
  }

  return {
    sweptHigh, sweptLow,
    sweptBoth: sweptHigh && sweptLow,
    firstSweptSide,
    highSweepIdx, lowSweepIdx
  };
}

// --- Per-Feature Analysis ---

/**
 * Analyze a single feature's predictive power for sweep side
 */
function analyzeFeature(days, featureKey, minBucketSize = 50) {
  // Separate into high-first and low-first
  const highFirst = days.filter(d => d.firstSweptSide === 'high');
  const lowFirst = days.filter(d => d.firstSweptSide === 'low');

  // Get feature values
  const allValues = days.map(d => d.features[featureKey]).filter(v => v !== null && v !== undefined && typeof v === 'number');

  if (allValues.length < minBucketSize) return null;

  // Correlation with binary outcome (high=1, low=0)
  const paired = days
    .filter(d => d.features[featureKey] !== null && d.features[featureKey] !== undefined && typeof d.features[featureKey] === 'number')
    .map(d => ({ feature: d.features[featureKey], outcome: d.firstSweptSide === 'high' ? 1 : 0 }));

  if (paired.length < minBucketSize) return null;

  const corr = correlation(paired.map(p => p.feature), paired.map(p => p.outcome));

  // Quintile analysis
  const sorted = [...paired].sort((a, b) => a.feature - b.feature);
  const quintileSize = Math.floor(sorted.length / 5);
  const quintiles = [];

  for (let q = 0; q < 5; q++) {
    const start = q * quintileSize;
    const end = q === 4 ? sorted.length : (q + 1) * quintileSize;
    const slice = sorted.slice(start, end);

    if (slice.length < 10) continue;

    const highCount = slice.filter(s => s.outcome === 1).length;
    const highPct = round(highCount / slice.length * 100, 1);
    const featureMin = round(slice[0].feature, 2);
    const featureMax = round(slice[slice.length - 1].feature, 2);

    quintiles.push({
      quintile: q + 1,
      range: `${featureMin} - ${featureMax}`,
      count: slice.length,
      highFirstPct: highPct,
      lowFirstPct: round(100 - highPct, 1)
    });
  }

  // Best split point
  let bestSplit = null;
  let bestAccuracy = 0;
  const step = Math.max(1, Math.floor(sorted.length / 20));

  for (let i = step; i < sorted.length - step; i += step) {
    const threshold = sorted[i].feature;
    const belowHigh = sorted.slice(0, i).filter(s => s.outcome === 1).length;
    const aboveHigh = sorted.slice(i).filter(s => s.outcome === 1).length;

    // Try: below threshold → predict low, above → predict high
    const acc1 = ((i - belowHigh) + aboveHigh) / sorted.length;
    // Try: below threshold → predict high, above → predict low
    const acc2 = (belowHigh + (sorted.length - i - aboveHigh)) / sorted.length;

    const bestAcc = Math.max(acc1, acc2);
    if (bestAcc > bestAccuracy) {
      bestAccuracy = bestAcc;
      bestSplit = {
        threshold: round(threshold, 2),
        accuracy: round(bestAcc * 100, 1),
        direction: acc1 > acc2 ? 'above=high' : 'below=high'
      };
    }
  }

  return {
    feature: featureKey,
    sampleSize: paired.length,
    correlation: corr,
    quintiles,
    bestSplit
  };
}

/**
 * Analyze categorical feature
 */
function analyzeCategoricalFeature(days, featureKey, minBucketSize = 50) {
  const groups = {};
  for (const d of days) {
    const val = d.features[featureKey];
    if (val === null || val === undefined) continue;
    if (!groups[val]) groups[val] = { count: 0, highFirst: 0 };
    groups[val].count++;
    if (d.firstSweptSide === 'high') groups[val].highFirst++;
  }

  const result = Object.entries(groups)
    .filter(([, v]) => v.count >= 10)
    .map(([k, v]) => ({
      value: k,
      count: v.count,
      highFirstPct: round(v.highFirst / v.count * 100, 1),
      lowFirstPct: round((v.count - v.highFirst) / v.count * 100, 1)
    }));

  return result.length > 0 ? { feature: featureKey, groups: result } : null;
}

// --- Main ---
(async () => {
  const startDate = '2023-01-01';
  const endDate = '2026-01-31';

  console.log('Loading data...');
  const candles = await loadContinuousOHLCV(product, '1m', startDate, endDate);
  const tradingDates = extractTradingDates(candles);
  console.log(`Found ${tradingDates.length} trading days`);

  console.log('Loading LT levels...');
  const ltLevels = await loadLTLevels(product);

  console.log('');

  // ============================================================
  // PASS 1: Pre-European (3 AM ET) → Predict Euro sweep direction
  // ============================================================
  console.log('=== Pass 1: Pre-European Sweep Prediction ===\n');

  const euroDays = [];
  let euroSkipped = 0;

  for (const dateStr of tradingDates) {
    const asianCandles = getAsianCandles(candles, dateStr);
    const euroCandles = getEuropeanCandles(candles, dateStr);

    if (asianCandles.length < 5 || euroCandles.length < 5) { euroSkipped++; continue; }

    const asianHigh = Math.max(...asianCandles.map(c => c.high));
    const asianLow = Math.min(...asianCandles.map(c => c.low));
    const asianRange = asianHigh - asianLow;

    if (asianRange < 5) { euroSkipped++; continue; } // Skip if Asian range too tiny

    // Detect sweep in Euro session
    const sweep = detectSweep(euroCandles, asianHigh, asianLow, TOUCH_THRESHOLD);
    if (!sweep.firstSweptSide) { euroSkipped++; continue; } // Neither side swept

    // Price at 3 AM ET (start of Euro session)
    const price = euroCandles[0].open;
    const [year, month, day] = dateStr.split('-').map(Number);
    const euroStartTs = fromET(year, month - 1, day, 3, 0);

    // Compute features
    const ltFeatures = computeLTFeatures(ltLevels, price, euroStartTs);
    const ltMigration = computeLTMigration(ltLevels, price, euroStartTs);
    const overnightCandles = getOvernightCandlesFromArray(candles, dateStr);
    const prevLevels = getPrevDayLevelsFromArray(candles, dateStr, tradingDates);
    const overnightFeatures = computeOvernightFeatures(asianCandles, overnightCandles, prevLevels, price);

    // Load GEX for the date
    const gexSnapshots = loadIntradayGEX(product, dateStr);
    const gexFeatures = computeGEXFeatures(gexSnapshots, price, euroStartTs);

    const features = {
      ...(ltFeatures || {}),
      ...ltMigration,
      ...(gexFeatures || {}),
      ...overnightFeatures
    };

    euroDays.push({
      date: dateStr,
      session: 'european',
      asianHigh: round(asianHigh, 2),
      asianLow: round(asianLow, 2),
      asianRange: round(asianRange, 2),
      price: round(price, 2),
      firstSweptSide: sweep.firstSweptSide === 'high' ? 'high' : 'low',
      sweptBoth: sweep.sweptBoth,
      features
    });
  }

  console.log(`  Analyzed ${euroDays.length} Euro sessions (${euroSkipped} skipped)`);

  const euroHighFirst = euroDays.filter(d => d.firstSweptSide === 'high').length;
  const euroLowFirst = euroDays.filter(d => d.firstSweptSide === 'low').length;
  console.log(`  Baseline: High first ${round(euroHighFirst / euroDays.length * 100, 1)}% | Low first ${round(euroLowFirst / euroDays.length * 100, 1)}%\n`);

  // ============================================================
  // PASS 2: Pre-RTH (9:30 AM ET) → Predict RTH sweep direction
  // ============================================================
  console.log('=== Pass 2: Pre-RTH Sweep Prediction ===\n');

  const rthDays = [];
  let rthSkipped = 0;

  for (const dateStr of tradingDates) {
    const asianCandles = getAsianCandles(candles, dateStr);
    const euroCandles = getEuropeanCandles(candles, dateStr);
    const rthCandles = getRTHCandlesFromArray(candles, dateStr);

    if (asianCandles.length < 5 || rthCandles.length < 10) { rthSkipped++; continue; }

    const asianHigh = Math.max(...asianCandles.map(c => c.high));
    const asianLow = Math.min(...asianCandles.map(c => c.low));
    const asianRange = asianHigh - asianLow;

    if (asianRange < 5) { rthSkipped++; continue; }

    // Detect sweep in RTH session
    const sweep = detectSweep(rthCandles, asianHigh, asianLow, TOUCH_THRESHOLD);
    if (!sweep.firstSweptSide) { rthSkipped++; continue; }

    const price = rthCandles[0].open;
    const [year, month, day] = dateStr.split('-').map(Number);
    const rthStartTs = fromET(year, month - 1, day, 9, 30);

    // Compute all pre-Euro features PLUS Euro session result
    const ltFeatures = computeLTFeatures(ltLevels, price, rthStartTs);
    const ltMigration = computeLTMigration(ltLevels, price, rthStartTs);
    const overnightCandles = getOvernightCandlesFromArray(candles, dateStr);
    const prevLevels = getPrevDayLevelsFromArray(candles, dateStr, tradingDates);
    const overnightFeatures = computeOvernightFeatures(asianCandles, overnightCandles, prevLevels, price);

    const gexSnapshots = loadIntradayGEX(product, dateStr);
    const gexFeatures = computeGEXFeatures(gexSnapshots, price, rthStartTs);

    // Euro session result (additional info for RTH pass)
    let euroSweepResult = 'none';
    if (euroCandles.length >= 5) {
      const euroSweep = detectSweep(euroCandles, asianHigh, asianLow, TOUCH_THRESHOLD);
      if (euroSweep.sweptBoth) euroSweepResult = 'both';
      else if (euroSweep.firstSweptSide) euroSweepResult = euroSweep.firstSweptSide;
    }

    // Euro session range expansion
    let euroRangeExpansion = null;
    if (euroCandles.length >= 5) {
      const euroHigh = Math.max(...euroCandles.map(c => c.high));
      const euroLow = Math.min(...euroCandles.map(c => c.low));
      euroRangeExpansion = round((euroHigh - euroLow) / asianRange, 2);
    }

    // Early Euro volume features
    const earlyEuroVol = computeEarlyVolumeFeatures(euroCandles);

    const features = {
      ...(ltFeatures || {}),
      ...ltMigration,
      ...(gexFeatures || {}),
      ...overnightFeatures,
      ...earlyEuroVol,
      euro_sweep_result: euroSweepResult,
      euro_range_expansion: euroRangeExpansion
    };

    rthDays.push({
      date: dateStr,
      session: 'rth',
      asianHigh: round(asianHigh, 2),
      asianLow: round(asianLow, 2),
      asianRange: round(asianRange, 2),
      price: round(price, 2),
      firstSweptSide: sweep.firstSweptSide === 'high' ? 'high' : 'low',
      sweptBoth: sweep.sweptBoth,
      features
    });
  }

  console.log(`  Analyzed ${rthDays.length} RTH sessions (${rthSkipped} skipped)`);

  const rthHighFirst = rthDays.filter(d => d.firstSweptSide === 'high').length;
  const rthLowFirst = rthDays.filter(d => d.firstSweptSide === 'low').length;
  console.log(`  Baseline: High first ${round(rthHighFirst / rthDays.length * 100, 1)}% | Low first ${round(rthLowFirst / rthDays.length * 100, 1)}%\n`);

  // ============================================================
  // Feature Analysis
  // ============================================================
  function runFeatureAnalysis(days, label) {
    console.log(`\n--- ${label}: Feature Analysis ---\n`);

    const numericFeatures = [
      'lt_above_count', 'lt_below_count', 'lt_asymmetry',
      'lt_nearest_above_dist', 'lt_nearest_below_dist',
      'lt_migration_direction', 'lt_crossing_count',
      'gex_call_wall_dist', 'gex_put_wall_dist', 'gex_wall_asymmetry',
      'overnight_range', 'overnight_bias', 'asian_range',
      'gap_from_pdc', 'price_position_in_on_range',
      'early_volume_ratio', 'early_volume_side_bias',
      'gex_total_magnitude', 'euro_range_expansion'
    ];

    const categoricalFeatures = [
      'lt_crossing_direction', 'lt_sentiment',
      'gex_gamma_flip_position', 'gex_regime',
      'early_direction', 'euro_sweep_result'
    ];

    const numericResults = {};
    const categoricalResults = {};

    for (const feat of numericFeatures) {
      const result = analyzeFeature(days, feat);
      if (result) {
        numericResults[feat] = result;
        const corrStr = result.correlation !== null ? result.correlation.toFixed(4) : 'N/A';
        const splitStr = result.bestSplit ? `${result.bestSplit.accuracy}% (${result.bestSplit.direction} @ ${result.bestSplit.threshold})` : 'N/A';
        console.log(`  ${feat}: r=${corrStr} | best split=${splitStr} | n=${result.sampleSize}`);
      }
    }

    console.log('');

    for (const feat of categoricalFeatures) {
      const result = analyzeCategoricalFeature(days, feat);
      if (result) {
        categoricalResults[feat] = result;
        for (const g of result.groups) {
          console.log(`  ${feat}=${g.value}: high=${g.highFirstPct}% low=${g.lowFirstPct}% (n=${g.count})`);
        }
      }
    }

    // Combined signal: when 3+ features agree
    console.log(`\n  Combined Signal Analysis:`);
    const signalDays = days.map(d => {
      let bullishSignals = 0;
      let bearishSignals = 0;

      const f = d.features;
      // LT asymmetry: negative = more below = bullish (more support)
      if (f.lt_asymmetry !== null && f.lt_asymmetry !== undefined) {
        if (f.lt_asymmetry < -0.2) bullishSignals++;
        if (f.lt_asymmetry > 0.2) bearishSignals++;
      }
      // Gap: positive gap = bullish momentum → high first likely
      if (f.gap_from_pdc !== null && f.gap_from_pdc !== undefined) {
        if (f.gap_from_pdc > 20) bullishSignals++;
        if (f.gap_from_pdc < -20) bearishSignals++;
      }
      // Overnight bias: positive = bullish
      if (f.overnight_bias !== null && f.overnight_bias !== undefined) {
        if (f.overnight_bias > 0.3) bullishSignals++;
        if (f.overnight_bias < -0.3) bearishSignals++;
      }
      // GEX wall asymmetry: positive = more room up = high first likely
      if (f.gex_wall_asymmetry !== null && f.gex_wall_asymmetry !== undefined) {
        if (f.gex_wall_asymmetry > 50) bullishSignals++;
        if (f.gex_wall_asymmetry < -50) bearishSignals++;
      }
      // LT migration: positive = levels moving up = bearish (resistance building)
      if (f.lt_migration_direction !== null && f.lt_migration_direction !== undefined) {
        if (f.lt_migration_direction < -5) bullishSignals++;
        if (f.lt_migration_direction > 5) bearishSignals++;
      }
      // Price position in ON range: high = near top = high first likely
      if (f.price_position_in_on_range !== null && f.price_position_in_on_range !== undefined) {
        if (f.price_position_in_on_range > 0.7) bullishSignals++;
        if (f.price_position_in_on_range < 0.3) bearishSignals++;
      }

      const netSignal = bullishSignals - bearishSignals;
      const prediction = netSignal >= 2 ? 'high' : netSignal <= -2 ? 'low' : 'neutral';

      return { ...d, netSignal, prediction, bullishSignals, bearishSignals };
    });

    const predicted = signalDays.filter(d => d.prediction !== 'neutral');
    const correct = predicted.filter(d => d.prediction === d.firstSweptSide);

    console.log(`    Days with 2+ signal agreement: ${predicted.length}/${days.length} (${round(predicted.length / days.length * 100, 1)}%)`);
    if (predicted.length > 0) {
      console.log(`    Accuracy: ${correct.length}/${predicted.length} (${round(correct.length / predicted.length * 100, 1)}%)`);

      // Significance test vs random (50%)
      const zTest = proportionZTest(round(correct.length / predicted.length * 100, 1), predicted.length, 50, predicted.length);
      console.log(`    Z-test vs 50%: z=${zTest.zScore}, p=${zTest.pValue} ${zTest.significant ? '(SIGNIFICANT)' : '(not significant)'}`);
    }

    // Strong signal (3+)
    const strongPredicted = signalDays.filter(d => Math.abs(d.netSignal) >= 3);
    const strongCorrect = strongPredicted.filter(d => d.prediction === d.firstSweptSide);
    console.log(`    Days with 3+ signal agreement: ${strongPredicted.length}/${days.length}`);
    if (strongPredicted.length >= 20) {
      console.log(`    Strong signal accuracy: ${strongCorrect.length}/${strongPredicted.length} (${round(strongCorrect.length / strongPredicted.length * 100, 1)}%)`);
    }

    // Out-of-sample: train 2023-2024, test 2025
    const trainDays = days.filter(d => d.date < '2025-01-01');
    const testDays = days.filter(d => d.date >= '2025-01-01');

    let oosResult = null;
    if (trainDays.length >= 100 && testDays.length >= 50) {
      const trainPredicted = signalDays.filter(d => d.date < '2025-01-01' && d.prediction !== 'neutral');
      const testPredicted = signalDays.filter(d => d.date >= '2025-01-01' && d.prediction !== 'neutral');
      const trainCorrect = trainPredicted.filter(d => d.prediction === d.firstSweptSide);
      const testCorrect = testPredicted.filter(d => d.prediction === d.firstSweptSide);

      console.log(`\n    Out-of-Sample Split:`);
      console.log(`      Train (2023-2024): ${trainCorrect.length}/${trainPredicted.length} (${trainPredicted.length > 0 ? round(trainCorrect.length / trainPredicted.length * 100, 1) : 'N/A'}%)`);
      console.log(`      Test  (2025):      ${testCorrect.length}/${testPredicted.length} (${testPredicted.length > 0 ? round(testCorrect.length / testPredicted.length * 100, 1) : 'N/A'}%)`);

      oosResult = {
        train: {
          period: '2023-2024',
          total: trainPredicted.length,
          correct: trainCorrect.length,
          accuracy: trainPredicted.length > 0 ? round(trainCorrect.length / trainPredicted.length * 100, 1) : null
        },
        test: {
          period: '2025',
          total: testPredicted.length,
          correct: testCorrect.length,
          accuracy: testPredicted.length > 0 ? round(testCorrect.length / testPredicted.length * 100, 1) : null
        }
      };
    }

    return {
      numericFeatures: numericResults,
      categoricalFeatures: categoricalResults,
      combinedSignal: {
        totalDays: days.length,
        predictedDays: predicted.length,
        accuracy: predicted.length > 0 ? round(correct.length / predicted.length * 100, 1) : null,
        strongPredictedDays: strongPredicted.length,
        strongAccuracy: strongPredicted.length >= 20 ? round(strongCorrect.length / strongPredicted.length * 100, 1) : null
      },
      outOfSample: oosResult
    };
  }

  const euroAnalysis = runFeatureAnalysis(euroDays, 'Pre-European');
  const rthAnalysis = runFeatureAnalysis(rthDays, 'Pre-RTH');

  // --- Conditional MFE/MAE per feature bucket ---
  function computeConditionalMFE(days, allCandles) {
    const results = [];
    for (const d of days) {
      const sessionCandles = d.session === 'european'
        ? getEuropeanCandles(allCandles, d.date)
        : getRTHCandlesFromArray(allCandles, d.date);

      if (sessionCandles.length < 5) continue;

      const entryPrice = sessionCandles[0].open;
      // Trade in direction of predicted sweep
      const direction = d.firstSweptSide === 'high' ? 1 : -1;
      let maxFav = 0, maxAdv = 0;

      for (const c of sessionCandles) {
        const moveH = (c.high - entryPrice) * direction;
        const moveL = (c.low - entryPrice) * direction;
        maxFav = Math.max(maxFav, moveH, moveL);
        maxAdv = Math.min(maxAdv, moveH, moveL);
      }

      results.push({
        date: d.date,
        side: d.firstSweptSide,
        mfe: round(maxFav, 2),
        mae: round(Math.abs(maxAdv), 2),
        gapBucket: bucket(Math.abs(d.features.gap_from_pdc || 0), [10, 30, 60, 100]),
        asianRangeBucket: bucket(d.asianRange, [20, 40, 60, 100])
      });
    }

    return {
      count: results.length,
      mfe: calculatePercentiles(results.map(r => r.mfe), [25, 50, 75, 90]),
      mae: calculatePercentiles(results.map(r => r.mae), [25, 50, 75, 90]),
      avgMFE: results.length > 0 ? round(results.reduce((s, r) => s + r.mfe, 0) / results.length, 1) : 0,
      avgMAE: results.length > 0 ? round(results.reduce((s, r) => s + r.mae, 0) / results.length, 1) : 0
    };
  }

  const euroMFE = computeConditionalMFE(euroDays, candles);
  const rthMFE = computeConditionalMFE(rthDays, candles);

  console.log(`\n  Euro MFE/MAE: avg MFE=${euroMFE.avgMFE} avg MAE=${euroMFE.avgMAE} (n=${euroMFE.count})`);
  console.log(`  RTH MFE/MAE:  avg MFE=${rthMFE.avgMFE} avg MAE=${rthMFE.avgMAE} (n=${rthMFE.count})`);

  // --- Save Results ---
  const results = {
    study: 'Pre-Sweep Side Prediction',
    product,
    dateRange: { start: startDate, end: endDate },
    timestamp: new Date().toISOString(),
    touchThreshold: TOUCH_THRESHOLD,
    european: {
      totalDays: euroDays.length,
      skipped: euroSkipped,
      baseline: {
        highFirst: euroHighFirst,
        lowFirst: euroLowFirst,
        highFirstPct: round(euroHighFirst / euroDays.length * 100, 1),
        lowFirstPct: round(euroLowFirst / euroDays.length * 100, 1)
      },
      featureAnalysis: euroAnalysis,
      mfeMAE: euroMFE
    },
    rth: {
      totalDays: rthDays.length,
      skipped: rthSkipped,
      baseline: {
        highFirst: rthHighFirst,
        lowFirst: rthLowFirst,
        highFirstPct: round(rthHighFirst / rthDays.length * 100, 1),
        lowFirstPct: round(rthLowFirst / rthDays.length * 100, 1)
      },
      featureAnalysis: rthAnalysis,
      mfeMAE: rthMFE
    }
  };

  const filename = `pre-sweep-prediction-${product.toLowerCase()}.json`;
  saveResults(filename, results);

  console.log(`\nResults saved to results/research/${filename}`);
  console.log('Done.');
})();
