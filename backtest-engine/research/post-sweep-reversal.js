/**
 * Study B: Post-First-Sweep Reversal Detection
 *
 * Question: After the first sweep of the Asian range, can we detect whether price
 * will reverse to sweep the opposite side?
 *
 * Features computed AT the sweep moment:
 *   - Volume Velocity (5): spike ratio, decay, depth, wick ratio, reversion speed
 *   - GEX at Sweep (5): hit GEX level, level type, regime, magnitude, distance to opposite
 *   - LT at Sweep (4): crossing, support count, cluster, fib level crossed
 *   - GEX Change After (2): regime change, level migration
 *   - Post-Sweep Price Action (3): range contraction, reclaimed level, 5min trend
 *
 * Targets:
 *   - Primary: reversed_to_opposite_side (boolean)
 *   - Secondary: reversal_mfe, reversal_mae, time_to_opposite_sweep_min
 *
 * Usage:
 *   node research/post-sweep-reversal.js [--product NQ|ES]
 */

import {
  loadContinuousOHLCV,
  load1sRange,
  extractTradingDates,
  getAsianCandles,
  getEuropeanCandles,
  getRTHCandlesFromArray,
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
const TOUCH_THRESHOLD = 2;

console.log(`\n=== Post-Sweep Reversal Detection: ${product} ===`);
console.log(`Touch threshold: ${TOUCH_THRESHOLD} points\n`);

// --- Feature Extraction ---

/**
 * Compute volume velocity features at sweep moment using 1s data
 */
function computeVolumeFeatures(secondCandles, sweepSecIdx, sweepSide, level) {
  if (!secondCandles || secondCandles.length === 0 || sweepSecIdx < 0) return null;

  const sweepSec = secondCandles[sweepSecIdx];

  // 1. Volume spike ratio (sweep vol / 60s rolling avg)
  const pre60 = secondCandles.slice(Math.max(0, sweepSecIdx - 60), sweepSecIdx);
  const avgVol60 = pre60.length > 0 ? pre60.reduce((s, c) => s + c.volume, 0) / pre60.length : 1;
  const volumeSpikeRatio = avgVol60 > 0 ? round(sweepSec.volume / avgVol60, 1) : 0;

  // 2. Volume decay ratio (avg vol 5-10s post / sweep vol)
  const post5to10 = secondCandles.slice(sweepSecIdx + 5, sweepSecIdx + 10);
  const post5to10Avg = post5to10.length > 0 ? post5to10.reduce((s, c) => s + c.volume, 0) / post5to10.length : 0;
  const volumeDecayRatio = sweepSec.volume > 0 ? round(post5to10Avg / sweepSec.volume, 2) : 0;

  // 3. Sweep depth: max penetration past the level (30s window)
  let sweepDepth = 0;
  for (let j = sweepSecIdx; j < Math.min(sweepSecIdx + 30, secondCandles.length); j++) {
    const sc = secondCandles[j];
    const depth = sweepSide === 'high' ? sc.high - level : level - sc.low;
    sweepDepth = Math.max(sweepDepth, depth);
  }

  // 4. Wick ratio of sweep candle
  const range = sweepSec.high - sweepSec.low;
  let wickRatio = 0;
  if (range > 0) {
    if (sweepSide === 'high') {
      // Upper wick for high sweep
      wickRatio = round((sweepSec.high - Math.max(sweepSec.open, sweepSec.close)) / range, 2);
    } else {
      // Lower wick for low sweep
      wickRatio = round((Math.min(sweepSec.open, sweepSec.close) - sweepSec.low) / range, 2);
    }
  }

  // 5. Post-sweep reversion speed (pts/sec in first 30s)
  let reversionSpeed = 0;
  const post30s = secondCandles.slice(sweepSecIdx, Math.min(sweepSecIdx + 30, secondCandles.length));
  if (post30s.length >= 2) {
    const sweepExtreme = sweepSide === 'high'
      ? Math.max(...post30s.slice(0, 5).map(c => c.high))
      : Math.min(...post30s.slice(0, 5).map(c => c.low));

    const endPrice = post30s[post30s.length - 1].close;
    const reversion = sweepSide === 'high' ? sweepExtreme - endPrice : endPrice - sweepExtreme;
    reversionSpeed = round(reversion / post30s.length, 2);
  }

  return {
    volume_spike_ratio: volumeSpikeRatio,
    volume_decay_ratio: volumeDecayRatio,
    sweep_depth_pts: round(sweepDepth, 2),
    wick_ratio: wickRatio,
    post_sweep_reversion_speed: reversionSpeed
  };
}

/**
 * Compute GEX features at sweep moment
 */
function computeGEXAtSweep(gexSnapshots, price, sweepSide, timestamp) {
  const snap = getGEXSnapshotAt(gexSnapshots, timestamp);
  if (!snap) return null;

  // Check if sweep hit a GEX level (within 5 pts)
  const GEX_PROXIMITY = 5;
  const allLevels = [];

  // Collect all support/resistance levels from snapshot
  if (snap.put_wall) allLevels.push({ type: 'put_wall', price: snap.put_wall });
  if (snap.call_wall) allLevels.push({ type: 'call_wall', price: snap.call_wall });
  if (snap.gamma_flip) allLevels.push({ type: 'gamma_flip', price: snap.gamma_flip });

  // Support and resistance arrays
  for (let i = 0; i < 5; i++) {
    if (snap.support && snap.support[i]) allLevels.push({ type: `S${i + 1}`, price: snap.support[i] });
    if (snap.resistance && snap.resistance[i]) allLevels.push({ type: `R${i + 1}`, price: snap.resistance[i] });
  }

  let hitGEXLevel = false;
  let hitLevelType = null;
  let minDist = Infinity;

  for (const lvl of allLevels) {
    const dist = Math.abs(price - lvl.price);
    if (dist <= GEX_PROXIMITY && dist < minDist) {
      hitGEXLevel = true;
      hitLevelType = lvl.type;
      minDist = dist;
    }
  }

  // Distance to opposite wall
  const callWall = snap.call_wall || (snap.resistance && snap.resistance[0]);
  const putWall = snap.put_wall || (snap.support && snap.support[0]);
  const oppositeWallDist = sweepSide === 'high'
    ? (putWall ? round(price - putWall, 2) : null)
    : (callWall ? round(callWall - price, 2) : null);

  return {
    sweep_hit_gex_level: hitGEXLevel,
    gex_level_type_hit: hitLevelType,
    gex_regime_at_sweep: snap.regime || null,
    gex_total_magnitude: snap.total_gex || null,
    gex_distance_to_opposite_wall: oppositeWallDist
  };
}

/**
 * Compute LT features at sweep moment
 */
function computeLTAtSweep(ltLevels, price, sweepSide, timestamp) {
  const snap = getLTSnapshotAt(ltLevels, timestamp);
  if (!snap) return { lt_crossing_at_sweep: false, lt_support_count_after_sweep: 0, lt_cluster_at_sweep: false, lt_fib_level_crossed: null };

  const prevSnap = getLTSnapshotAt(ltLevels, timestamp - 15 * 60000); // 15 min earlier

  // Crossing: did any LT level cross through price recently?
  let crossingAtSweep = false;
  let fibLevelCrossed = null;
  const fibLabels = [34, 55, 144, 377, 610];

  if (prevSnap) {
    for (let i = 0; i < 5; i++) {
      const wasBelowPrice = prevSnap.levels[i] <= price;
      const isNowBelowPrice = snap.levels[i] <= price;
      if (wasBelowPrice !== isNowBelowPrice) {
        crossingAtSweep = true;
        fibLevelCrossed = fibLabels[i];
        break; // first crossing
      }
    }
  }

  // Support count: how many levels below price after downside sweep?
  const supportCount = snap.levels.filter(l => l < price).length;

  // Cluster: multiple LT levels within 25pts of sweep price?
  const nearbyLevels = snap.levels.filter(l => Math.abs(l - price) <= 25);
  const cluster = nearbyLevels.length >= 2;

  return {
    lt_crossing_at_sweep: crossingAtSweep,
    lt_support_count_after_sweep: supportCount,
    lt_cluster_at_sweep: cluster,
    lt_fib_level_crossed: fibLevelCrossed
  };
}

/**
 * Compute GEX change features (15m after sweep)
 */
function computeGEXChange(gexSnapshots, timestamp) {
  const snapBefore = getGEXSnapshotAt(gexSnapshots, timestamp);
  const snapAfter = getGEXSnapshotAt(gexSnapshots, timestamp + 15 * 60000);

  if (!snapBefore || !snapAfter) return { gex_regime_change_15m: false, gex_level_migration_post: null };

  const regimeChange = snapBefore.regime !== snapAfter.regime;

  // Level migration: did S/R levels move toward or away from price?
  let migration = null;
  if (snapBefore.support && snapAfter.support && snapBefore.support[0] && snapAfter.support[0]) {
    const s1Before = snapBefore.support[0];
    const s1After = snapAfter.support[0];
    const r1Before = snapBefore.resistance ? snapBefore.resistance[0] : null;
    const r1After = snapAfter.resistance ? snapAfter.resistance[0] : null;

    // Levels converging = tightening = absorption
    if (r1Before && r1After) {
      const widthBefore = r1Before - s1Before;
      const widthAfter = r1After - s1After;
      migration = round(widthAfter - widthBefore, 2); // Negative = contracting
    }
  }

  return {
    gex_regime_change_15m: regimeChange,
    gex_level_migration_post: migration
  };
}

/**
 * Compute post-sweep price action features from 1m candles
 */
function computePostSweepPriceAction(sessionCandles, sweepIdx, sweepSide, level) {
  if (sweepIdx < 0 || sweepIdx >= sessionCandles.length) return null;

  // Range contraction: are candles after sweep shrinking?
  const postCandles = sessionCandles.slice(sweepIdx + 1, sweepIdx + 6);
  const preCandles = sessionCandles.slice(Math.max(0, sweepIdx - 4), sweepIdx + 1);

  let rangeContraction = null;
  if (postCandles.length >= 3 && preCandles.length >= 3) {
    const preAvgRange = preCandles.reduce((s, c) => s + (c.high - c.low), 0) / preCandles.length;
    const postAvgRange = postCandles.reduce((s, c) => s + (c.high - c.low), 0) / postCandles.length;
    rangeContraction = preAvgRange > 0 ? round(postAvgRange / preAvgRange, 2) : 1;
  }

  // Price reclaimed level: 3 candles after sweep, is close back inside?
  let priceReclaimedLevel = false;
  if (postCandles.length >= 3) {
    const thirdClose = postCandles[2].close;
    priceReclaimedLevel = sweepSide === 'high' ? thirdClose < level : thirdClose > level;
  }

  // Post-sweep 5-min trend: slope of closes
  let postSweep5minTrend = null;
  if (postCandles.length >= 5) {
    const closes = postCandles.slice(0, 5).map(c => c.close);
    // Simple slope: (last - first) / 4
    postSweep5minTrend = round((closes[4] - closes[0]) / 4, 2);
  } else if (postCandles.length >= 2) {
    postSweep5minTrend = round((postCandles[postCandles.length - 1].close - postCandles[0].close) / (postCandles.length - 1), 2);
  }

  return {
    post_sweep_range_contraction: rangeContraction,
    price_reclaimed_level: priceReclaimedLevel,
    post_sweep_5min_trend: postSweep5minTrend
  };
}

// --- Analysis Helpers ---

function analyzeFeature(events, featureKey, minBucketSize = 50) {
  const paired = events
    .filter(e => e.features[featureKey] !== null && e.features[featureKey] !== undefined && typeof e.features[featureKey] === 'number')
    .map(e => ({ feature: e.features[featureKey], outcome: e.reversed ? 1 : 0 }));

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

    const reversalCount = slice.filter(s => s.outcome === 1).length;
    quintiles.push({
      quintile: q + 1,
      range: `${round(slice[0].feature, 2)} - ${round(slice[slice.length - 1].feature, 2)}`,
      count: slice.length,
      reversalPct: round(reversalCount / slice.length * 100, 1)
    });
  }

  // Best single-feature threshold
  let bestSplit = null;
  let bestAccuracy = 0;
  const step = Math.max(1, Math.floor(sorted.length / 20));

  for (let i = step; i < sorted.length - step; i += step) {
    const threshold = sorted[i].feature;
    const belowReversals = sorted.slice(0, i).filter(s => s.outcome === 1).length;
    const aboveReversals = sorted.slice(i).filter(s => s.outcome === 1).length;

    // Try: below → reversal, above → no reversal
    const acc1 = (belowReversals + (sorted.length - i - aboveReversals)) / sorted.length;
    // Try: above → reversal, below → no reversal
    const acc2 = ((i - belowReversals) + aboveReversals) / sorted.length;

    const bestAcc = Math.max(acc1, acc2);
    if (bestAcc > bestAccuracy) {
      bestAccuracy = bestAcc;
      bestSplit = {
        threshold: round(threshold, 2),
        accuracy: round(bestAcc * 100, 1),
        direction: acc1 > acc2 ? 'below=reversal' : 'above=reversal'
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

function analyzeCategoricalFeature(events, featureKey) {
  const groups = {};
  for (const e of events) {
    const val = e.features[featureKey];
    if (val === null || val === undefined) continue;
    if (!groups[val]) groups[val] = { count: 0, reversals: 0 };
    groups[val].count++;
    if (e.reversed) groups[val].reversals++;
  }

  return Object.entries(groups)
    .filter(([, v]) => v.count >= 10)
    .map(([k, v]) => ({
      value: k,
      count: v.count,
      reversalPct: round(v.reversals / v.count * 100, 1)
    }));
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

  const sweepEvents = [];
  let skipped = 0;
  let no1sData = 0;
  const MAX_EVENTS = 500; // Cap for 1s data loading performance

  for (let i = 0; i < tradingDates.length && sweepEvents.length < MAX_EVENTS; i++) {
    const dateStr = tradingDates[i];

    const asianCandles = getAsianCandles(candles, dateStr);
    const euroCandles = getEuropeanCandles(candles, dateStr);
    const rthCandles = getRTHCandlesFromArray(candles, dateStr);

    if (asianCandles.length < 5 || rthCandles.length < 10) { skipped++; continue; }

    const asianHigh = Math.max(...asianCandles.map(c => c.high));
    const asianLow = Math.min(...asianCandles.map(c => c.low));
    const asianRange = asianHigh - asianLow;
    if (asianRange < 5) { skipped++; continue; }

    // Combine Euro + RTH for full post-Asian analysis
    const postAsianCandles = [...euroCandles, ...rthCandles].sort((a, b) => a.timestamp - b.timestamp);

    // Find first sweep
    let firstSweepIdx = -1;
    let firstSweepSide = null;

    for (let j = 0; j < postAsianCandles.length; j++) {
      const c = postAsianCandles[j];
      if (c.high >= asianHigh - TOUCH_THRESHOLD) {
        if (firstSweepIdx === -1 || j < firstSweepIdx) {
          firstSweepIdx = j;
          firstSweepSide = 'high';
        }
        break;
      }
    }

    let lowSweepIdx = -1;
    for (let j = 0; j < postAsianCandles.length; j++) {
      const c = postAsianCandles[j];
      if (c.low <= asianLow + TOUCH_THRESHOLD) {
        lowSweepIdx = j;
        break;
      }
    }

    if (lowSweepIdx !== -1 && (firstSweepIdx === -1 || lowSweepIdx < firstSweepIdx)) {
      firstSweepIdx = lowSweepIdx;
      firstSweepSide = 'low';
    }

    if (firstSweepIdx === -1) { skipped++; continue; }

    const sweepCandle = postAsianCandles[firstSweepIdx];
    const sweepPrice = firstSweepSide === 'high' ? sweepCandle.high : sweepCandle.low;
    const level = firstSweepSide === 'high' ? asianHigh : asianLow;

    // Did opposite side get swept afterward (in remaining candles)?
    let oppositeSwept = false;
    let timeToOpposite = null;
    const oppositeLevel = firstSweepSide === 'high' ? asianLow : asianHigh;

    for (let j = firstSweepIdx + 1; j < postAsianCandles.length; j++) {
      const c = postAsianCandles[j];
      if (firstSweepSide === 'high' && c.low <= asianLow + TOUCH_THRESHOLD) {
        oppositeSwept = true;
        timeToOpposite = round((c.timestamp - sweepCandle.timestamp) / 60000, 1);
        break;
      }
      if (firstSweepSide === 'low' && c.high >= asianHigh - TOUCH_THRESHOLD) {
        oppositeSwept = true;
        timeToOpposite = round((c.timestamp - sweepCandle.timestamp) / 60000, 1);
        break;
      }
    }

    // MFE/MAE for reversal trade (trade toward opposite side after first sweep)
    const direction = firstSweepSide === 'high' ? -1 : 1; // After high sweep, expect reversal down
    const entryPrice = sweepCandle.close;
    let reversalMFE = 0, reversalMAE = 0;

    for (let j = firstSweepIdx + 1; j < postAsianCandles.length; j++) {
      const c = postAsianCandles[j];
      const moveH = (c.high - entryPrice) * direction;
      const moveL = (c.low - entryPrice) * direction;
      reversalMFE = Math.max(reversalMFE, moveH, moveL);
      reversalMAE = Math.min(reversalMAE, moveH, moveL);
    }

    // --- Load 1s data for volume velocity ---
    const minuteTs = Math.floor(sweepCandle.timestamp / 60000) * 60000;
    let volumeFeatures = null;

    try {
      const secondCandles = await load1sRange(product, minuteTs, 2, 2);
      if (secondCandles.length > 0) {
        // Find sweep second
        let sweepSecIdx = -1;
        for (let j = 0; j < secondCandles.length; j++) {
          const sc = secondCandles[j];
          if (firstSweepSide === 'high' && sc.high >= level - TOUCH_THRESHOLD) { sweepSecIdx = j; break; }
          if (firstSweepSide === 'low' && sc.low <= level + TOUCH_THRESHOLD) { sweepSecIdx = j; break; }
        }

        if (sweepSecIdx >= 0) {
          volumeFeatures = computeVolumeFeatures(secondCandles, sweepSecIdx, firstSweepSide, level);
        }
      } else {
        no1sData++;
      }
    } catch (e) {
      no1sData++;
    }

    // --- GEX features ---
    const gexSnapshots = loadIntradayGEX(product, dateStr);
    const gexAtSweep = computeGEXAtSweep(gexSnapshots, sweepPrice, firstSweepSide, sweepCandle.timestamp);
    const gexChange = computeGEXChange(gexSnapshots, sweepCandle.timestamp);

    // --- LT features ---
    const ltAtSweep = computeLTAtSweep(ltLevels, sweepPrice, firstSweepSide, sweepCandle.timestamp);

    // --- Post-sweep price action (1m) ---
    const priceAction = computePostSweepPriceAction(postAsianCandles, firstSweepIdx, firstSweepSide, level);

    const features = {
      ...(volumeFeatures || {}),
      ...(gexAtSweep || {}),
      ...ltAtSweep,
      ...gexChange,
      ...(priceAction || {})
    };

    sweepEvents.push({
      date: dateStr,
      sweepSide: firstSweepSide,
      sweepPrice: round(sweepPrice, 2),
      level: round(level, 2),
      asianRange: round(asianRange, 2),
      reversed: oppositeSwept,
      reversal_mfe: round(reversalMFE, 2),
      reversal_mae: round(Math.abs(reversalMAE), 2),
      time_to_opposite_sweep_min: timeToOpposite,
      features
    });
  }

  console.log(`Analyzed ${sweepEvents.length} first-sweep events (${skipped} skipped, ${no1sData} missing 1s data)\n`);

  // --- Aggregate Stats ---
  const reversed = sweepEvents.filter(e => e.reversed);
  const notReversed = sweepEvents.filter(e => !e.reversed);
  const baseReversalRate = round(reversed.length / sweepEvents.length * 100, 1);

  console.log(`Baseline reversal rate: ${reversed.length}/${sweepEvents.length} (${baseReversalRate}%)`);
  console.log(`  Reversed MFE: avg=${round(reversed.reduce((s, e) => s + e.reversal_mfe, 0) / (reversed.length || 1), 1)} | p50=${calculatePercentiles(reversed.map(e => e.reversal_mfe), [50]).p50 || 0}`);
  console.log(`  Reversed MAE: avg=${round(reversed.reduce((s, e) => s + e.reversal_mae, 0) / (reversed.length || 1), 1)} | p50=${calculatePercentiles(reversed.map(e => e.reversal_mae), [50]).p50 || 0}`);
  console.log(`  Time to opposite sweep: p50=${calculatePercentiles(reversed.filter(e => e.time_to_opposite_sweep_min).map(e => e.time_to_opposite_sweep_min), [50]).p50 || 'N/A'} min`);
  console.log(`  Not reversed MFE: avg=${round(notReversed.reduce((s, e) => s + e.reversal_mfe, 0) / (notReversed.length || 1), 1)}`);
  console.log(`  Not reversed MAE: avg=${round(notReversed.reduce((s, e) => s + e.reversal_mae, 0) / (notReversed.length || 1), 1)}`);

  // --- Feature Analysis ---
  console.log('\n--- Numeric Feature Analysis ---\n');

  const numericFeatures = [
    'volume_spike_ratio', 'volume_decay_ratio', 'sweep_depth_pts',
    'wick_ratio', 'post_sweep_reversion_speed',
    'gex_total_magnitude', 'gex_distance_to_opposite_wall',
    'gex_level_migration_post',
    'post_sweep_range_contraction', 'post_sweep_5min_trend',
    'lt_support_count_after_sweep'
  ];

  const categoricalFeatures = [
    'sweep_hit_gex_level', 'gex_level_type_hit', 'gex_regime_at_sweep',
    'gex_regime_change_15m',
    'lt_crossing_at_sweep', 'lt_cluster_at_sweep', 'lt_fib_level_crossed',
    'price_reclaimed_level'
  ];

  const numericResults = {};
  const categoricalResults = {};

  for (const feat of numericFeatures) {
    const result = analyzeFeature(sweepEvents, feat);
    if (result) {
      numericResults[feat] = result;
      const corrStr = result.correlation !== null ? result.correlation.toFixed(4) : 'N/A';
      const splitStr = result.bestSplit ? `${result.bestSplit.accuracy}% (${result.bestSplit.direction} @ ${result.bestSplit.threshold})` : 'N/A';
      console.log(`  ${feat}: r=${corrStr} | best split=${splitStr} | n=${result.sampleSize}`);
    }
  }

  console.log('\n--- Categorical Feature Analysis ---\n');

  for (const feat of categoricalFeatures) {
    const groups = analyzeCategoricalFeature(sweepEvents, feat);
    if (groups.length > 0) {
      categoricalResults[feat] = groups;
      for (const g of groups) {
        console.log(`  ${feat}=${g.value}: reversal=${g.reversalPct}% (n=${g.count})`);
      }
    }
  }

  // --- Combined Feature Scoring ---
  console.log('\n--- Combined Feature Scoring ---\n');

  const scoredEvents = sweepEvents.map(e => {
    let reversalScore = 0;
    const f = e.features;

    // Volume: low spike = reversal (MM absorbed, not breakout)
    if (f.volume_spike_ratio !== undefined && f.volume_spike_ratio !== null) {
      if (f.volume_spike_ratio < 15) reversalScore++;
      if (f.volume_spike_ratio > 50) reversalScore--;
    }

    // High decay = reversal (volume exhausting)
    if (f.volume_decay_ratio !== undefined && f.volume_decay_ratio !== null) {
      if (f.volume_decay_ratio > 0.4) reversalScore++;
      if (f.volume_decay_ratio < 0.15) reversalScore--;
    }

    // Shallow depth = stop hunt
    if (f.sweep_depth_pts !== undefined && f.sweep_depth_pts !== null) {
      if (f.sweep_depth_pts < 5) reversalScore++;
      if (f.sweep_depth_pts > 20) reversalScore--;
    }

    // High wick = rejection
    if (f.wick_ratio !== undefined && f.wick_ratio !== null) {
      if (f.wick_ratio > 0.6) reversalScore++;
    }

    // Fast reversion = immediate rejection
    if (f.post_sweep_reversion_speed !== undefined && f.post_sweep_reversion_speed !== null) {
      if (f.post_sweep_reversion_speed > 0.5) reversalScore++;
    }

    // GEX support: hit GEX level = more likely reversal at that level
    if (f.sweep_hit_gex_level) reversalScore++;

    // Positive gamma regime = mean-reversion favored
    if (f.gex_regime_at_sweep === 'strong_positive' || f.gex_regime_at_sweep === 'positive') {
      reversalScore++;
    }
    if (f.gex_regime_at_sweep === 'strong_negative' || f.gex_regime_at_sweep === 'negative') {
      reversalScore--;
    }

    // LT cluster at sweep = confluence support
    if (f.lt_cluster_at_sweep) reversalScore++;

    // Price reclaimed level = reversal in progress
    if (f.price_reclaimed_level) reversalScore++;

    // Range contraction = absorption
    if (f.post_sweep_range_contraction !== undefined && f.post_sweep_range_contraction !== null) {
      if (f.post_sweep_range_contraction < 0.6) reversalScore++;
    }

    return { ...e, reversalScore };
  });

  // Accuracy at different score thresholds
  for (const threshold of [2, 3, 4, 5]) {
    const predicted = scoredEvents.filter(e => e.reversalScore >= threshold);
    const correct = predicted.filter(e => e.reversed);
    const predictedNot = scoredEvents.filter(e => e.reversalScore < threshold);
    const correctNot = predictedNot.filter(e => !e.reversed);

    if (predicted.length >= 20) {
      const precision = round(correct.length / predicted.length * 100, 1);
      const recall = reversed.length > 0 ? round(correct.length / reversed.length * 100, 1) : 0;
      const avgMFE = correct.length > 0 ? round(correct.reduce((s, e) => s + e.reversal_mfe, 0) / correct.length, 1) : 0;
      const avgMAE = correct.length > 0 ? round(correct.reduce((s, e) => s + e.reversal_mae, 0) / correct.length, 1) : 0;

      const zTest = proportionZTest(precision, predicted.length, baseReversalRate, sweepEvents.length);

      console.log(`  Score >= ${threshold}: ${correct.length}/${predicted.length} reversed (${precision}%) | recall=${recall}% | MFE=${avgMFE} MAE=${avgMAE} | z=${zTest.zScore} p=${zTest.pValue} ${zTest.significant ? '*' : ''}`);

      // Profit factor: if trading reversals at this score
      const pfWins = predicted.filter(e => e.reversed).reduce((s, e) => s + e.reversal_mfe, 0);
      const pfLosses = predicted.filter(e => !e.reversed).reduce((s, e) => s + e.reversal_mae, 0);
      if (pfLosses > 0) {
        console.log(`    Profit factor: ${round(pfWins / pfLosses, 2)}`);
      }
    } else {
      console.log(`  Score >= ${threshold}: ${predicted.length} events (too few)`);
    }
  }

  // --- Out-of-Sample ---
  const trainEvents = scoredEvents.filter(e => e.date < '2025-01-01');
  const testEvents = scoredEvents.filter(e => e.date >= '2025-01-01');

  let oosResult = null;
  if (trainEvents.length >= 100 && testEvents.length >= 30) {
    console.log('\n--- Out-of-Sample Split ---');
    const bestThreshold = 3; // Use score >= 3 as reference

    const trainPredicted = trainEvents.filter(e => e.reversalScore >= bestThreshold);
    const testPredicted = testEvents.filter(e => e.reversalScore >= bestThreshold);
    const trainCorrect = trainPredicted.filter(e => e.reversed);
    const testCorrect = testPredicted.filter(e => e.reversed);

    const trainAcc = trainPredicted.length > 0 ? round(trainCorrect.length / trainPredicted.length * 100, 1) : null;
    const testAcc = testPredicted.length > 0 ? round(testCorrect.length / testPredicted.length * 100, 1) : null;

    console.log(`  Train (2023-2024): ${trainCorrect.length}/${trainPredicted.length} (${trainAcc}%)`);
    console.log(`  Test  (2025):      ${testCorrect.length}/${testPredicted.length} (${testAcc}%)`);

    oosResult = {
      scoreThreshold: bestThreshold,
      train: { period: '2023-2024', total: trainPredicted.length, correct: trainCorrect.length, accuracy: trainAcc },
      test: { period: '2025', total: testPredicted.length, correct: testCorrect.length, accuracy: testAcc }
    };
  }

  // --- Best 2-3 Feature Combinations ---
  console.log('\n--- Best Feature Combinations ---\n');

  const comboFeatures = numericFeatures.filter(f => numericResults[f]);
  const combos = [];

  // Try all 2-feature combinations
  for (let i = 0; i < comboFeatures.length; i++) {
    for (let j = i + 1; j < comboFeatures.length; j++) {
      const f1 = comboFeatures[i];
      const f2 = comboFeatures[j];
      const r1 = numericResults[f1];
      const r2 = numericResults[f2];

      if (!r1.bestSplit || !r2.bestSplit) continue;

      // Apply both features' best splits
      const predicted = sweepEvents.filter(e => {
        const v1 = e.features[f1];
        const v2 = e.features[f2];
        if (v1 === null || v1 === undefined || v2 === null || v2 === undefined) return false;

        const pass1 = r1.bestSplit.direction === 'above=reversal' ? v1 >= r1.bestSplit.threshold : v1 < r1.bestSplit.threshold;
        const pass2 = r2.bestSplit.direction === 'above=reversal' ? v2 >= r2.bestSplit.threshold : v2 < r2.bestSplit.threshold;
        return pass1 && pass2;
      });

      if (predicted.length >= 30) {
        const correct = predicted.filter(e => e.reversed);
        const accuracy = round(correct.length / predicted.length * 100, 1);
        combos.push({
          features: [f1, f2],
          predicted: predicted.length,
          correct: correct.length,
          accuracy,
          avgMFE: correct.length > 0 ? round(correct.reduce((s, e) => s + e.reversal_mfe, 0) / correct.length, 1) : 0,
          avgMAE: predicted.length > 0 ? round(predicted.reduce((s, e) => s + e.reversal_mae, 0) / predicted.length, 1) : 0
        });
      }
    }
  }

  // Sort by accuracy descending
  combos.sort((a, b) => b.accuracy - a.accuracy);
  const topCombos = combos.slice(0, 10);

  for (const combo of topCombos) {
    console.log(`  ${combo.features.join(' + ')}: ${combo.correct}/${combo.predicted} (${combo.accuracy}%) MFE=${combo.avgMFE} MAE=${combo.avgMAE}`);
  }

  // --- Save Results ---
  const results = {
    study: 'Post-First-Sweep Reversal Detection',
    product,
    dateRange: { start: startDate, end: endDate },
    timestamp: new Date().toISOString(),
    touchThreshold: TOUCH_THRESHOLD,
    totalEvents: sweepEvents.length,
    skipped,
    missing1sData: no1sData,
    baseline: {
      reversalRate: baseReversalRate,
      reversalCount: reversed.length,
      noReversalCount: notReversed.length,
      reversalMFE: calculatePercentiles(reversed.map(e => e.reversal_mfe), [25, 50, 75, 90]),
      reversalMAE: calculatePercentiles(reversed.map(e => e.reversal_mae), [25, 50, 75, 90]),
      timeToOpposite: calculatePercentiles(
        reversed.filter(e => e.time_to_opposite_sweep_min).map(e => e.time_to_opposite_sweep_min),
        [25, 50, 75, 90]
      ),
      avgReversalMFE: reversed.length > 0 ? round(reversed.reduce((s, e) => s + e.reversal_mfe, 0) / reversed.length, 1) : 0,
      avgReversalMAE: reversed.length > 0 ? round(reversed.reduce((s, e) => s + e.reversal_mae, 0) / reversed.length, 1) : 0
    },
    featureAnalysis: {
      numeric: numericResults,
      categorical: categoricalResults
    },
    combinedScoring: {
      thresholds: [2, 3, 4, 5].map(t => {
        const pred = scoredEvents.filter(e => e.reversalScore >= t);
        const correct = pred.filter(e => e.reversed);
        return {
          threshold: t,
          predicted: pred.length,
          correct: correct.length,
          precision: pred.length > 0 ? round(correct.length / pred.length * 100, 1) : null,
          recall: reversed.length > 0 ? round(correct.length / reversed.length * 100, 1) : null,
          avgMFE: correct.length > 0 ? round(correct.reduce((s, e) => s + e.reversal_mfe, 0) / correct.length, 1) : 0,
          avgMAE: correct.length > 0 ? round(correct.reduce((s, e) => s + e.reversal_mae, 0) / correct.length, 1) : 0
        };
      })
    },
    bestCombinations: topCombos,
    outOfSample: oosResult
  };

  const filename = `post-sweep-reversal-${product.toLowerCase()}.json`;
  saveResults(filename, results);

  console.log(`\nResults saved to results/research/${filename}`);
  console.log('Done.');
})();
