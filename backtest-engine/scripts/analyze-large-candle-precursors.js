#!/usr/bin/env node
/**
 * Large Candle Precursor Analysis
 *
 * Analyzes all 15-minute NQ candles larger than specified thresholds (50, 75, 100, 150 points)
 * to find correlations in backtesting data in the 30 minutes leading up to them.
 *
 * Data Sources (30-min lookback window):
 * - OHLCV: 1-minute candles
 * - GEX Intraday: 15-minute snapshots (regime, levels, distances)
 * - LT Levels: 15-minute snapshots (sentiment, level crossings, spacing)
 * - Order Flow: 1-minute trade OFI (net volume, volume imbalance)
 * - Book Imbalance: 1-minute book data (size imbalance, bid-ask ratio)
 *
 * Usage:
 *   node scripts/analyze-large-candle-precursors.js \
 *     --start-date 2025-01-01 --end-date 2025-12-31 \
 *     --thresholds 50,75,100,150 \
 *     --output results/large-candle-precursors.json
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
};

const startDateStr = getArg('start-date', '2025-01-01');
const endDateStr = getArg('end-date', '2025-12-31');
const thresholdsStr = getArg('thresholds', '50,75,100,150');
const outputPath = getArg('output', 'results/large-candle-precursors.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const thresholds = thresholdsStr.split(',').map(t => parseInt(t.trim()));

const dataDir = path.resolve(process.cwd(), 'data');

console.log('=' .repeat(80));
console.log('LARGE CANDLE PRECURSOR ANALYSIS');
console.log('='.repeat(80));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log(`Thresholds: ${thresholds.join(', ')} points`);
console.log(`Output: ${outputPath}`);
console.log();

// ============================================================================
// Data Loading Functions
// ============================================================================

/**
 * Load 1-minute OHLCV data from CSV file with streaming for memory efficiency
 */
async function loadOHLCVData() {
  const filePath = path.join(dataDir, 'ohlcv/nq/NQ_ohlcv_1m.csv');
  console.log(`Loading OHLCV data from ${filePath}...`);

  const candles = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let headerSkipped = false;

  for await (const line of rl) {
    if (!headerSkipped) {
      headerSkipped = true;
      continue;
    }

    const parts = line.split(',');
    if (parts.length < 10) continue;

    const timestamp = new Date(parts[0]).getTime();
    const candleDate = new Date(timestamp);

    // Date filter
    if (candleDate < startDate || candleDate > endDate) continue;

    const symbol = parts[9];

    // Skip calendar spreads (contain '-')
    if (symbol && symbol.includes('-')) continue;

    const open = parseFloat(parts[4]);
    const high = parseFloat(parts[5]);
    const low = parseFloat(parts[6]);
    const close = parseFloat(parts[7]);
    const volume = parseInt(parts[8]);

    // Filter out corrupted candles
    if (open === high && high === low && low === close) continue;

    candles.push({ timestamp, open, high, low, close, volume, symbol });
  }

  // Sort by timestamp
  candles.sort((a, b) => a.timestamp - b.timestamp);

  // Filter to primary contract
  const filtered = filterPrimaryContract(candles);
  console.log(`  Loaded ${filtered.length} candles (from ${candles.length} total)`);

  return filtered;
}

/**
 * Filter candles to use only the primary (most liquid) contract for each time period
 */
function filterPrimaryContract(candles) {
  if (candles.length === 0) return candles;

  const contractVolumes = new Map();
  const result = [];

  // Calculate volume per contract symbol per hour
  candles.forEach(candle => {
    const hourKey = Math.floor(candle.timestamp / (60 * 60 * 1000));
    const symbol = candle.symbol;

    if (!contractVolumes.has(hourKey)) {
      contractVolumes.set(hourKey, new Map());
    }

    const hourData = contractVolumes.get(hourKey);
    const currentVol = hourData.get(symbol) || 0;
    hourData.set(symbol, currentVol + (candle.volume || 0));
  });

  // For each candle, check if it belongs to the primary contract
  candles.forEach(candle => {
    const hourKey = Math.floor(candle.timestamp / (60 * 60 * 1000));
    const hourData = contractVolumes.get(hourKey);

    if (!hourData) {
      result.push(candle);
      return;
    }

    let primarySymbol = '';
    let maxVolume = 0;

    for (const [symbol, volume] of hourData.entries()) {
      if (volume > maxVolume) {
        maxVolume = volume;
        primarySymbol = symbol;
      }
    }

    if (candle.symbol === primarySymbol) {
      result.push(candle);
    }
  });

  return result;
}

/**
 * Aggregate 1-minute candles to 15-minute candles
 */
function aggregateTo15Min(candles) {
  const fifteenMinCandles = [];
  const grouped = new Map();

  candles.forEach(candle => {
    // Round down to 15-minute boundary
    const period = Math.floor(candle.timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);

    if (!grouped.has(period)) {
      grouped.set(period, []);
    }
    grouped.get(period).push(candle);
  });

  for (const [period, periodCandles] of grouped.entries()) {
    if (periodCandles.length === 0) continue;

    // Sort by timestamp within period
    periodCandles.sort((a, b) => a.timestamp - b.timestamp);

    const open = periodCandles[0].open;
    const close = periodCandles[periodCandles.length - 1].close;
    const high = Math.max(...periodCandles.map(c => c.high));
    const low = Math.min(...periodCandles.map(c => c.low));
    const volume = periodCandles.reduce((sum, c) => sum + c.volume, 0);

    fifteenMinCandles.push({
      timestamp: period,
      open,
      high,
      low,
      close,
      volume,
      range: high - low,
      oneMinCandles: periodCandles
    });
  }

  fifteenMinCandles.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  Aggregated to ${fifteenMinCandles.length} 15-minute candles`);

  return fifteenMinCandles;
}

/**
 * Load GEX intraday snapshots
 */
async function loadGEXData() {
  const gexDir = path.join(dataDir, 'gex/nq');
  const snapshots = new Map();

  // Get all GEX files in date range
  const files = fs.readdirSync(gexDir)
    .filter(f => f.startsWith('nq_gex_') && f.endsWith('.json'))
    .filter(f => {
      const dateMatch = f.match(/nq_gex_(\d{4}-\d{2}-\d{2})\.json/);
      if (!dateMatch) return false;
      const fileDate = new Date(dateMatch[1]);
      return fileDate >= startDate && fileDate <= endDate;
    });

  console.log(`Loading GEX data from ${files.length} files...`);

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(gexDir, file), 'utf8'));
      data.data.forEach(snap => {
        const ts = new Date(snap.timestamp).getTime();
        snapshots.set(ts, snap);
      });
    } catch (e) {
      // Skip files with errors
    }
  }

  console.log(`  Loaded ${snapshots.size} GEX snapshots`);
  return snapshots;
}

/**
 * Load LT levels from CSV
 */
async function loadLTData() {
  const filePath = path.join(dataDir, 'liquidity/nq/NQ_liquidity_levels.csv');
  console.log(`Loading LT levels from ${filePath}...`);

  const levels = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let headerSkipped = false;

  for await (const line of rl) {
    if (!headerSkipped) {
      headerSkipped = true;
      continue;
    }

    const parts = line.split(',');
    if (parts.length < 7) continue;

    const timestamp = parseInt(parts[1]);
    const date = new Date(timestamp);

    if (date < startDate || date > endDate) continue;

    levels.push({
      timestamp,
      sentiment: parts[2],
      level_1: parseFloat(parts[3]),
      level_2: parseFloat(parts[4]),
      level_3: parseFloat(parts[5]),
      level_4: parseFloat(parts[6]),
      level_5: parseFloat(parts[7])
    });
  }

  levels.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  Loaded ${levels.length} LT snapshots`);

  return levels;
}

/**
 * Load order flow (trade OFI) data
 */
async function loadOrderFlowData() {
  const filePath = path.join(dataDir, 'orderflow/nq/trade-ofi-1m.csv');
  console.log(`Loading order flow data from ${filePath}...`);

  const data = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let headerSkipped = false;

  for await (const line of rl) {
    if (!headerSkipped) {
      headerSkipped = true;
      continue;
    }

    const parts = line.split(',');
    if (parts.length < 10) continue;

    const timestamp = new Date(parts[0]).getTime();
    const date = new Date(timestamp);

    if (date < startDate || date > endDate) continue;

    data.push({
      timestamp,
      netVolume: parseInt(parts[3]),
      totalVolume: parseInt(parts[4]),
      volumeImbalance: parseFloat(parts[8]),
      tradeImbalance: parseFloat(parts[9])
    });
  }

  data.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  Loaded ${data.length} order flow records`);

  return data;
}

/**
 * Load book imbalance data
 */
async function loadBookImbalanceData() {
  const filePath = path.join(dataDir, 'orderflow/nq/book-imbalance-1m.csv');
  console.log(`Loading book imbalance data from ${filePath}...`);

  const data = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let headerSkipped = false;

  for await (const line of rl) {
    if (!headerSkipped) {
      headerSkipped = true;
      continue;
    }

    const parts = line.split(',');
    if (parts.length < 10) continue;

    const timestamp = new Date(parts[0]).getTime();
    const date = new Date(timestamp);

    if (date < startDate || date > endDate) continue;

    data.push({
      timestamp,
      sizeImbalance: parseFloat(parts[6]),
      countImbalance: parseFloat(parts[7]),
      bidAskRatio: parseFloat(parts[10])
    });
  }

  data.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  Loaded ${data.length} book imbalance records`);

  return data;
}

// ============================================================================
// Feature Extraction Functions
// ============================================================================

/**
 * Find data point nearest to timestamp using binary search
 */
function findNearest(sortedData, targetTs, maxDiffMs = 60 * 1000) {
  if (sortedData.length === 0) return null;

  let left = 0;
  let right = sortedData.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (sortedData[mid].timestamp < targetTs) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  // Check nearby indices for closest match
  let best = null;
  let bestDiff = Infinity;

  for (let i = Math.max(0, left - 1); i <= Math.min(sortedData.length - 1, left + 1); i++) {
    const diff = Math.abs(sortedData[i].timestamp - targetTs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = sortedData[i];
    }
  }

  return bestDiff <= maxDiffMs ? best : null;
}

/**
 * Get data points in a time range
 */
function getDataInRange(sortedData, startTs, endTs) {
  const result = [];
  for (const item of sortedData) {
    if (item.timestamp >= startTs && item.timestamp < endTs) {
      result.push(item);
    }
    if (item.timestamp >= endTs) break;
  }
  return result;
}

/**
 * Calculate standard deviation
 */
function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squareDiffs = values.map(v => Math.pow(v - mean, 2));
  return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * Calculate linear regression slope
 */
function linearSlope(values) {
  if (values.length < 2) return 0;
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}

/**
 * Extract features for a 15-minute candle from the 30-minute lookback window
 */
function extractFeatures(candle, oneMinCandles, gexSnapshots, ltLevels, orderFlowData, bookImbalanceData) {
  const candleTs = candle.timestamp;
  const lookbackStart = candleTs - 30 * 60 * 1000; // 30 minutes before
  const lookbackEnd = candleTs;

  const features = {
    timestamp: candleTs,
    candleRange: candle.range,
    candleDirection: candle.close > candle.open ? 'up' : 'down',

    // Price features
    priceVolatility30m: null,
    priceRangeRatio: null,
    trendSlope: null,
    avgCandleRange: null,
    maxCandleRange: null,

    // GEX features
    gexRegime: null,
    distanceToGammaFlip: null,
    distanceToS1: null,
    distanceToR1: null,
    minGexDistance: null,
    nearGexLevel: false,

    // LT features
    ltSentiment: null,
    ltSpacing: null,
    ltLevelCrossings: 0,

    // Order flow features
    cumNetVolume: null,
    avgVolumeImbalance: null,
    volumeImbalanceTrend: null,

    // Book imbalance features
    avgSizeImbalance: null,
    sizeImbalanceTrend: null,
    avgBidAskRatio: null
  };

  // Get 1-minute candles in lookback window
  const lookbackCandles = getDataInRange(oneMinCandles, lookbackStart, lookbackEnd);

  if (lookbackCandles.length > 0) {
    const closes = lookbackCandles.map(c => c.close);
    const ranges = lookbackCandles.map(c => c.high - c.low);

    features.priceVolatility30m = stdDev(closes);
    features.avgCandleRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    features.maxCandleRange = Math.max(...ranges);
    features.trendSlope = linearSlope(closes);

    // Range ratio: lookback range vs candle range
    const lookbackHigh = Math.max(...lookbackCandles.map(c => c.high));
    const lookbackLow = Math.min(...lookbackCandles.map(c => c.low));
    const lookbackRange = lookbackHigh - lookbackLow;
    features.priceRangeRatio = lookbackRange > 0 ? candle.range / lookbackRange : 0;
  }

  // Get GEX snapshot (15-min boundary nearest to candle start)
  const gexTs = Math.floor(candleTs / (15 * 60 * 1000)) * (15 * 60 * 1000);
  const gexSnap = gexSnapshots.get(gexTs) || gexSnapshots.get(gexTs - 15 * 60 * 1000);

  if (gexSnap && lookbackCandles.length > 0) {
    const currentPrice = lookbackCandles[lookbackCandles.length - 1].close;

    features.gexRegime = gexSnap.regime || null;
    features.distanceToGammaFlip = gexSnap.gamma_flip ? currentPrice - gexSnap.gamma_flip : null;

    const s1 = gexSnap.support?.[0];
    const r1 = gexSnap.resistance?.[0];

    features.distanceToS1 = s1 ? currentPrice - s1 : null;
    features.distanceToR1 = r1 ? currentPrice - r1 : null;

    // Calculate minimum distance to any GEX level
    const allLevels = [
      gexSnap.gamma_flip,
      gexSnap.call_wall,
      gexSnap.put_wall,
      ...(gexSnap.support || []),
      ...(gexSnap.resistance || [])
    ].filter(l => l != null);

    if (allLevels.length > 0) {
      const distances = allLevels.map(l => Math.abs(currentPrice - l));
      features.minGexDistance = Math.min(...distances);
      features.nearGexLevel = features.minGexDistance <= 10;
    }
  }

  // Get LT levels
  const ltSnap = findNearest(ltLevels, candleTs, 15 * 60 * 1000);

  if (ltSnap) {
    features.ltSentiment = ltSnap.sentiment;

    const levels = [ltSnap.level_1, ltSnap.level_2, ltSnap.level_3, ltSnap.level_4, ltSnap.level_5];
    const validLevels = levels.filter(l => !isNaN(l));

    if (validLevels.length > 1) {
      const sortedLevels = [...validLevels].sort((a, b) => a - b);
      const spacings = [];
      for (let i = 1; i < sortedLevels.length; i++) {
        spacings.push(sortedLevels[i] - sortedLevels[i - 1]);
      }
      features.ltSpacing = spacings.reduce((a, b) => a + b, 0) / spacings.length;
    }

    // Count level crossings in lookback window
    if (lookbackCandles.length > 1) {
      const levels = [ltSnap.level_1, ltSnap.level_2, ltSnap.level_3, ltSnap.level_4, ltSnap.level_5];
      let crossings = 0;

      for (let i = 1; i < lookbackCandles.length; i++) {
        const prevClose = lookbackCandles[i - 1].close;
        const currClose = lookbackCandles[i].close;

        for (const level of levels) {
          if (isNaN(level)) continue;
          if ((prevClose < level && currClose >= level) || (prevClose > level && currClose <= level)) {
            crossings++;
          }
        }
      }
      features.ltLevelCrossings = crossings;
    }
  }

  // Get order flow data
  const lookbackOF = getDataInRange(orderFlowData, lookbackStart, lookbackEnd);

  if (lookbackOF.length > 0) {
    features.cumNetVolume = lookbackOF.reduce((sum, d) => sum + d.netVolume, 0);
    features.avgVolumeImbalance = lookbackOF.reduce((sum, d) => sum + d.volumeImbalance, 0) / lookbackOF.length;

    const imbalances = lookbackOF.map(d => d.volumeImbalance);
    features.volumeImbalanceTrend = linearSlope(imbalances);
  }

  // Get book imbalance data
  const lookbackBook = getDataInRange(bookImbalanceData, lookbackStart, lookbackEnd);

  if (lookbackBook.length > 0) {
    features.avgSizeImbalance = lookbackBook.reduce((sum, d) => sum + d.sizeImbalance, 0) / lookbackBook.length;
    features.avgBidAskRatio = lookbackBook.reduce((sum, d) => sum + d.bidAskRatio, 0) / lookbackBook.length;

    const sizeImbalances = lookbackBook.map(d => d.sizeImbalance);
    features.sizeImbalanceTrend = linearSlope(sizeImbalances);
  }

  return features;
}

// ============================================================================
// Statistical Analysis Functions
// ============================================================================

/**
 * Calculate Pearson correlation coefficient
 */
function pearsonCorrelation(x, y) {
  if (x.length !== y.length || x.length < 3) return { r: null, p: null };

  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  if (denominator === 0) return { r: 0, p: 1 };

  const r = numerator / denominator;

  // Calculate t-statistic and p-value
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  const df = n - 2;

  // Approximate p-value using t-distribution
  // For large n, t approaches normal distribution
  const p = 2 * (1 - normalCDF(Math.abs(t)));

  return { r, p };
}

/**
 * Standard normal CDF approximation
 */
function normalCDF(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Calculate statistics for a group
 */
function groupStats(values) {
  if (values.length === 0) return { mean: null, std: null, count: 0 };

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const std = stdDev(values);

  return { mean, std, count: values.length };
}

// ============================================================================
// Main Analysis
// ============================================================================

async function main() {
  try {
    // Load all data
    console.log('\n--- LOADING DATA ---\n');

    const [oneMinCandles, gexSnapshots, ltLevels, orderFlowData, bookImbalanceData] = await Promise.all([
      loadOHLCVData(),
      loadGEXData(),
      loadLTData(),
      loadOrderFlowData(),
      loadBookImbalanceData()
    ]);

    // Aggregate to 15-minute candles
    console.log('\n--- AGGREGATING TO 15-MINUTE CANDLES ---\n');
    const fifteenMinCandles = aggregateTo15Min(oneMinCandles);

    // Extract features for all candles
    console.log('\n--- EXTRACTING FEATURES ---\n');
    console.log('Processing candles...');

    const allFeatures = [];
    let processed = 0;

    for (const candle of fifteenMinCandles) {
      const features = extractFeatures(
        candle,
        oneMinCandles,
        gexSnapshots,
        ltLevels,
        orderFlowData,
        bookImbalanceData
      );
      allFeatures.push(features);

      processed++;
      if (processed % 5000 === 0) {
        console.log(`  Processed ${processed}/${fifteenMinCandles.length} candles...`);
      }
    }

    console.log(`  Extracted features for ${allFeatures.length} candles`);

    // Analyze by threshold
    console.log('\n' + '='.repeat(80));
    console.log('LARGE CANDLE PRECURSOR ANALYSIS RESULTS');
    console.log('='.repeat(80));

    const results = {
      metadata: {
        startDate: startDateStr,
        endDate: endDateStr,
        totalCandles: allFeatures.length,
        thresholds,
        generated: new Date().toISOString()
      },
      counts: {},
      correlations: {},
      categoricalPatterns: {},
      topPredictors: {}
    };

    // Count candles by threshold
    console.log('\n## COUNTS BY THRESHOLD');
    console.log(`Total 15-minute candles: ${allFeatures.length.toLocaleString()}`);

    for (const threshold of thresholds) {
      const count = allFeatures.filter(f => f.candleRange >= threshold).length;
      const pct = (count / allFeatures.length * 100).toFixed(2);
      console.log(`  ${threshold}+ pts: ${count.toLocaleString()} candles (${pct}%)`);
      results.counts[`${threshold}+`] = { count, percentage: parseFloat(pct) };
    }

    // Analyze correlations for each threshold
    const numericFeatures = [
      'priceVolatility30m',
      'avgCandleRange',
      'maxCandleRange',
      'trendSlope',
      'priceRangeRatio',
      'distanceToGammaFlip',
      'distanceToS1',
      'distanceToR1',
      'minGexDistance',
      'cumNetVolume',
      'avgVolumeImbalance',
      'volumeImbalanceTrend',
      'avgSizeImbalance',
      'sizeImbalanceTrend',
      'avgBidAskRatio',
      'ltSpacing',
      'ltLevelCrossings'
    ];

    const categoricalFeatures = ['gexRegime', 'ltSentiment', 'nearGexLevel'];

    for (const threshold of thresholds) {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`ANALYSIS FOR ${threshold}+ POINT CANDLES`);
      console.log('='.repeat(80));

      const large = allFeatures.filter(f => f.candleRange >= threshold);
      const normal = allFeatures.filter(f => f.candleRange < threshold);

      results.correlations[`${threshold}+`] = {};
      results.categoricalPatterns[`${threshold}+`] = {};
      results.topPredictors[`${threshold}+`] = [];

      // Numeric correlations
      console.log('\n## NUMERIC FEATURE CORRELATIONS (Pearson r, p-value)');

      const significantCorrelations = [];

      for (const feature of numericFeatures) {
        const largeValues = large.map(f => f[feature]).filter(v => v !== null && !isNaN(v));
        const normalValues = normal.map(f => f[feature]).filter(v => v !== null && !isNaN(v));

        if (largeValues.length < 10 || normalValues.length < 10) continue;

        const largeStats = groupStats(largeValues);
        const normalStats = groupStats(normalValues);

        // Create binary target (1 = large candle, 0 = normal)
        const x = [];
        const y = [];

        for (const f of allFeatures) {
          if (f[feature] !== null && !isNaN(f[feature])) {
            x.push(f[feature]);
            y.push(f.candleRange >= threshold ? 1 : 0);
          }
        }

        const { r, p } = pearsonCorrelation(x, y);

        results.correlations[`${threshold}+`][feature] = {
          r: r?.toFixed(4),
          p: p?.toFixed(6),
          largeMean: largeStats.mean?.toFixed(2),
          normalMean: normalStats.mean?.toFixed(2),
          largeCount: largeStats.count,
          normalCount: normalStats.count
        };

        if (p !== null && p < 0.05 && r !== null) {
          significantCorrelations.push({
            feature,
            r,
            p,
            largeMean: largeStats.mean,
            normalMean: normalStats.mean,
            direction: r > 0 ? 'HIGHER before large' : 'LOWER before large'
          });
        }
      }

      // Sort by absolute correlation
      significantCorrelations.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

      console.log('\nSignificant correlations (p < 0.05), sorted by |r|:');
      for (const corr of significantCorrelations.slice(0, 10)) {
        const sign = corr.r > 0 ? '+' : '';
        console.log(`  ${corr.feature.padEnd(25)}: r=${sign}${corr.r.toFixed(4)}, p=${corr.p.toFixed(4)}`);
        console.log(`      Large: ${corr.largeMean?.toFixed(2)}, Normal: ${corr.normalMean?.toFixed(2)} - ${corr.direction}`);
      }

      results.topPredictors[`${threshold}+`] = significantCorrelations.slice(0, 10).map(c => ({
        feature: c.feature,
        r: c.r.toFixed(4),
        p: c.p.toFixed(6),
        direction: c.direction
      }));

      // Categorical patterns
      console.log('\n## CATEGORICAL PATTERNS');

      for (const feature of categoricalFeatures) {
        const categories = {};
        const baselines = {};

        // Count occurrences
        for (const f of allFeatures) {
          const val = String(f[feature]);
          if (val === 'null' || val === 'undefined') continue;

          if (!categories[val]) {
            categories[val] = { large: 0, normal: 0 };
          }

          if (f.candleRange >= threshold) {
            categories[val].large++;
          } else {
            categories[val].normal++;
          }
        }

        // Calculate rates
        const rates = {};
        for (const [val, counts] of Object.entries(categories)) {
          const total = counts.large + counts.normal;
          const largeRate = counts.large / total;
          const baselineRate = large.length / allFeatures.length;

          rates[val] = {
            largeRate: (largeRate * 100).toFixed(2),
            baseline: (baselineRate * 100).toFixed(2),
            elevated: largeRate > baselineRate * 1.2,
            count: total
          };
        }

        results.categoricalPatterns[`${threshold}+`][feature] = rates;

        console.log(`\n  ${feature}:`);
        for (const [val, rate] of Object.entries(rates)) {
          const indicator = rate.elevated ? ' ** ELEVATED' : '';
          console.log(`    ${val.padEnd(20)}: ${rate.largeRate}% (baseline ${rate.baseline}%, n=${rate.count})${indicator}`);
        }
      }

      // Direction analysis
      console.log('\n## DIRECTION ANALYSIS');
      const upLarge = large.filter(f => f.candleDirection === 'up');
      const downLarge = large.filter(f => f.candleDirection === 'down');

      console.log(`  Up candles ${threshold}+ pts: ${upLarge.length} (${(upLarge.length/large.length*100).toFixed(1)}%)`);
      console.log(`  Down candles ${threshold}+ pts: ${downLarge.length} (${(downLarge.length/large.length*100).toFixed(1)}%)`);

      results.categoricalPatterns[`${threshold}+`].direction = {
        up: { count: upLarge.length, percentage: (upLarge.length/large.length*100).toFixed(1) },
        down: { count: downLarge.length, percentage: (downLarge.length/large.length*100).toFixed(1) }
      };
    }

    // Summary recommendations
    console.log('\n' + '='.repeat(80));
    console.log('KEY FINDINGS & RECOMMENDATIONS');
    console.log('='.repeat(80));

    const primaryThreshold = 75;
    const topCorr = results.topPredictors[`${primaryThreshold}+`] || [];

    console.log(`\nTop predictors for ${primaryThreshold}+ point candles:`);
    for (const pred of topCorr.slice(0, 5)) {
      console.log(`  - ${pred.feature}: ${pred.direction} (r=${pred.r})`);
    }

    console.log('\nActionable patterns to watch:');

    // Check for volatility buildup
    const volCorr = topCorr.find(c => c.feature.includes('Volatility') || c.feature.includes('Range'));
    if (volCorr) {
      console.log(`  1. VOLATILITY BUILDUP: ${volCorr.feature} shows ${volCorr.direction}`);
    }

    // Check for order flow
    const ofCorr = topCorr.find(c => c.feature.includes('Volume') || c.feature.includes('Imbalance'));
    if (ofCorr) {
      console.log(`  2. ORDER FLOW: ${ofCorr.feature} shows ${ofCorr.direction}`);
    }

    // Check for GEX proximity
    const gexCorr = topCorr.find(c => c.feature.includes('Gex') || c.feature.includes('Distance'));
    if (gexCorr) {
      console.log(`  3. GEX LEVELS: ${gexCorr.feature} shows ${gexCorr.direction}`);
    }

    // Save results to JSON
    const outputDir = path.dirname(path.resolve(process.cwd(), outputPath));
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(
      path.resolve(process.cwd(), outputPath),
      JSON.stringify(results, null, 2)
    );

    console.log(`\nResults saved to: ${outputPath}`);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
