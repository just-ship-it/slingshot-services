#!/usr/bin/env node
/**
 * Safe Entry Candle Pattern Analysis
 *
 * Finds 5-minute and 15-minute candles that represent "safe entry" patterns -
 * candles that don't violate the previous candle's extreme before moving
 * significantly in the intended direction. Analyzes the 30 minutes preceding
 * these patterns for predictive correlations.
 *
 * Pattern Definitions:
 *
 * Long Side ("Safe Long Entry"):
 *   - candle.low >= prev_candle.low (price never goes below prior bar's low)
 *   - candle.high - candle.open >= minPoints (max potential return)
 *
 * Short Side ("Safe Short Entry"):
 *   - candle.high <= prev_candle.high (price never exceeds prior bar's high)
 *   - candle.open - candle.low >= minPoints (max potential return)
 *
 * Usage:
 *   node scripts/analyze-safe-entry-candles.js \
 *     --start-date 2023-03-01 --end-date 2025-12-25 \
 *     --timeframes 5,15 --min-points 20 \
 *     --output results/safe-entry-analysis.json
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

const startDateStr = getArg('start-date', '2023-03-01');
const endDateStr = getArg('end-date', '2025-12-25');
const timeframesStr = getArg('timeframes', '5,15');
const minPoints = parseInt(getArg('min-points', '20'));
const outputPath = getArg('output', 'results/safe-entry-analysis.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const timeframes = timeframesStr.split(',').map(t => parseInt(t.trim()));

const dataDir = path.resolve(process.cwd(), 'data');

console.log('='.repeat(80));
console.log('SAFE ENTRY CANDLE PATTERN ANALYSIS');
console.log('='.repeat(80));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log(`Timeframes: ${timeframes.join(', ')} minutes`);
console.log(`Minimum points for valid pattern: ${minPoints}`);
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

    // Filter out corrupted/zero-range candles
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
 * Aggregate 1-minute candles to specified timeframe
 */
function aggregateToTimeframe(candles, minutes) {
  const aggregated = [];
  const grouped = new Map();
  const periodMs = minutes * 60 * 1000;

  candles.forEach(candle => {
    const period = Math.floor(candle.timestamp / periodMs) * periodMs;

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

    aggregated.push({
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

  aggregated.sort((a, b) => a.timestamp - b.timestamp);
  return aggregated;
}

/**
 * Load GEX intraday snapshots
 */
async function loadGEXData() {
  const gexDir = path.join(dataDir, 'gex/nq');
  const snapshots = new Map();

  // Get all GEX files in date range
  let files;
  try {
    files = fs.readdirSync(gexDir)
      .filter(f => f.startsWith('nq_gex_') && f.endsWith('.json'))
      .filter(f => {
        const dateMatch = f.match(/nq_gex_(\d{4}-\d{2}-\d{2})\.json/);
        if (!dateMatch) return false;
        const fileDate = new Date(dateMatch[1]);
        return fileDate >= startDate && fileDate <= endDate;
      });
  } catch (e) {
    console.log(`  GEX directory not found or empty: ${gexDir}`);
    return snapshots;
  }

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

  try {
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
  } catch (e) {
    console.log(`  LT data file not found: ${filePath}`);
  }

  return levels;
}

/**
 * Load order flow (trade OFI) data
 */
async function loadOrderFlowData() {
  const filePath = path.join(dataDir, 'orderflow/nq/trade-ofi-1m.csv');
  console.log(`Loading order flow data from ${filePath}...`);

  const data = [];

  try {
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
        buyVolume: parseInt(parts[1]),
        sellVolume: parseInt(parts[2]),
        netVolume: parseInt(parts[3]),
        totalVolume: parseInt(parts[4]),
        volumeImbalance: parseFloat(parts[8]),
        tradeImbalance: parseFloat(parts[9])
      });
    }

    data.sort((a, b) => a.timestamp - b.timestamp);
    console.log(`  Loaded ${data.length} order flow records`);
  } catch (e) {
    console.log(`  Order flow data file not found: ${filePath}`);
  }

  return data;
}

/**
 * Load book imbalance data
 */
async function loadBookImbalanceData() {
  const filePath = path.join(dataDir, 'orderflow/nq/book-imbalance-1m.csv');
  console.log(`Loading book imbalance data from ${filePath}...`);

  const data = [];

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let headerSkipped = false;

    for await (const line of rl) {
      if (!headerSkipped) {
        headerSkipped = true;
        continue;
      }

      const parts = line.split(',');
      if (parts.length < 11) continue;

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
  } catch (e) {
    console.log(`  Book imbalance data file not found: ${filePath}`);
  }

  return data;
}

/**
 * Load ATM IV data
 */
async function loadIVData() {
  const filePath = path.join(dataDir, 'iv/qqq/qqq_atm_iv_15m.csv');
  console.log(`Loading ATM IV data from ${filePath}...`);

  const data = [];

  try {
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

      const timestamp = new Date(parts[0]).getTime();
      const date = new Date(timestamp);

      if (date < startDate || date > endDate) continue;

      data.push({
        timestamp,
        iv: parseFloat(parts[1]),
        spotPrice: parseFloat(parts[2]),
        callIv: parseFloat(parts[4]),
        putIv: parseFloat(parts[5]),
        dte: parseInt(parts[6])
      });
    }

    data.sort((a, b) => a.timestamp - b.timestamp);
    console.log(`  Loaded ${data.length} IV records`);
  } catch (e) {
    console.log(`  IV data file not found: ${filePath}`);
  }

  return data;
}

// ============================================================================
// Pattern Detection Functions
// ============================================================================

/**
 * Identify safe entry candles in the given candle array
 * @param {Array} candles - Aggregated candles with open, high, low, close
 * @param {number} minPts - Minimum points for valid pattern
 * @returns {Object} - { long: [...], short: [...] }
 */
function identifySafeEntryCandles(candles, minPts = 20) {
  const safeEntries = { long: [], short: [] };

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];

    // Long: Low doesn't violate previous low, AND max potential return >= minPts
    if (curr.low >= prev.low) {
      const maxReturn = curr.high - curr.open; // Max potential return from open to high
      if (maxReturn >= minPts) {
        safeEntries.long.push({
          index: i,
          candle: curr,
          prev,
          returnPoints: maxReturn,
          lowBuffer: curr.low - prev.low // How much buffer above prev low
        });
      }
    }

    // Short: High doesn't violate previous high, AND max potential return >= minPts
    if (curr.high <= prev.high) {
      const maxReturn = curr.open - curr.low; // Max potential return from open to low
      if (maxReturn >= minPts) {
        safeEntries.short.push({
          index: i,
          candle: curr,
          prev,
          returnPoints: maxReturn,
          highBuffer: prev.high - curr.high // How much buffer below prev high
        });
      }
    }
  }

  return safeEntries;
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
 * Extract features for a candle from the 30-minute lookback window
 */
function extractFeatures(candle, side, oneMinCandles, gexSnapshots, ltLevels, orderFlowData, bookImbalanceData, ivData) {
  const candleTs = candle.timestamp;
  const lookbackStart = candleTs - 30 * 60 * 1000; // 30 minutes before
  const lookbackEnd = candleTs;

  const features = {
    timestamp: candleTs,
    side,
    candleRange: candle.range,
    returnPoints: side === 'long' ? (candle.high - candle.open) : (candle.open - candle.low),

    // Price features
    priceVolatility30m: null,
    avgCandleRange: null,
    maxCandleRange: null,
    trendSlope: null,
    rangeBuildupRatio: null,
    prevCandleSize: null,
    prevCandleDirection: null,

    // GEX features
    gexRegime: null,
    distanceToGammaFlip: null,
    distanceToS1: null,
    distanceToR1: null,
    minGexDistance: null,
    nearGexLevel: false,
    totalGex: null,

    // LT features
    ltSentiment: null,
    ltSpacing: null,
    ltLevelCrossings: 0,
    ltConfiguration: null,

    // Order flow features (2025+ only)
    cumNetVolume: null,
    avgVolumeImbalance: null,
    volumeImbalanceTrend: null,
    netVolumeDirection: null,

    // Book imbalance features (2025+ only)
    avgSizeImbalance: null,
    sizeImbalanceTrend: null,
    avgBidAskRatio: null,

    // IV features (2025+ only)
    atmIv: null,
    ivChange: null,
    ivPutCallSkew: null
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

    // Range buildup ratio - are ranges increasing or decreasing?
    if (ranges.length >= 6) {
      const firstHalf = ranges.slice(0, Math.floor(ranges.length / 2));
      const secondHalf = ranges.slice(Math.floor(ranges.length / 2));
      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
      features.rangeBuildupRatio = firstAvg > 0 ? secondAvg / firstAvg : 1;
    }

    // Previous candle characteristics
    const lastLookback = lookbackCandles[lookbackCandles.length - 1];
    features.prevCandleSize = lastLookback.high - lastLookback.low;
    features.prevCandleDirection = lastLookback.close > lastLookback.open ? 'up' : 'down';
  }

  // Get GEX snapshot (15-min boundary nearest to candle start)
  const gexTs = Math.floor(candleTs / (15 * 60 * 1000)) * (15 * 60 * 1000);
  const gexSnap = gexSnapshots.get(gexTs) || gexSnapshots.get(gexTs - 15 * 60 * 1000);

  if (gexSnap && lookbackCandles.length > 0) {
    const currentPrice = lookbackCandles[lookbackCandles.length - 1].close;

    features.gexRegime = gexSnap.regime || null;
    features.distanceToGammaFlip = gexSnap.gamma_flip ? currentPrice - gexSnap.gamma_flip : null;
    features.totalGex = gexSnap.total_gex || null;

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
      features.nearGexLevel = features.minGexDistance <= 15;
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

      // Determine LT configuration (WIDE, NARROW, MIXED)
      const avgSpacing = features.ltSpacing;
      if (avgSpacing > 50) {
        features.ltConfiguration = 'WIDE';
      } else if (avgSpacing < 20) {
        features.ltConfiguration = 'NARROW';
      } else {
        features.ltConfiguration = 'MEDIUM';
      }
    }

    // Count level crossings in lookback window
    if (lookbackCandles.length > 1) {
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

    // Net volume direction alignment
    features.netVolumeDirection = features.cumNetVolume > 0 ? 'bullish' : 'bearish';
  }

  // Get book imbalance data
  const lookbackBook = getDataInRange(bookImbalanceData, lookbackStart, lookbackEnd);

  if (lookbackBook.length > 0) {
    features.avgSizeImbalance = lookbackBook.reduce((sum, d) => sum + d.sizeImbalance, 0) / lookbackBook.length;
    features.avgBidAskRatio = lookbackBook.reduce((sum, d) => sum + d.bidAskRatio, 0) / lookbackBook.length;

    const sizeImbalances = lookbackBook.map(d => d.sizeImbalance);
    features.sizeImbalanceTrend = linearSlope(sizeImbalances);
  }

  // Get IV data
  const ivSnap = findNearest(ivData, candleTs, 15 * 60 * 1000);
  const ivSnapPrev = findNearest(ivData, candleTs - 30 * 60 * 1000, 15 * 60 * 1000);

  if (ivSnap) {
    features.atmIv = ivSnap.iv;
    if (ivSnapPrev) {
      features.ivChange = ivSnap.iv - ivSnapPrev.iv;
    }
    if (ivSnap.callIv && ivSnap.putIv) {
      features.ivPutCallSkew = ivSnap.putIv - ivSnap.callIv;
    }
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

  // Approximate p-value using normal distribution
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

    const [oneMinCandles, gexSnapshots, ltLevels, orderFlowData, bookImbalanceData, ivData] = await Promise.all([
      loadOHLCVData(),
      loadGEXData(),
      loadLTData(),
      loadOrderFlowData(),
      loadBookImbalanceData(),
      loadIVData()
    ]);

    const results = {
      metadata: {
        startDate: startDateStr,
        endDate: endDateStr,
        timeframes,
        minPoints,
        generated: new Date().toISOString()
      },
      counts: {},
      correlations: {},
      categoricalPatterns: {},
      topPredictors: {},
      samplePatterns: {}
    };

    // Process each timeframe
    for (const tf of timeframes) {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`ANALYZING ${tf}-MINUTE TIMEFRAME`);
      console.log('='.repeat(80));

      // Aggregate candles
      console.log(`\nAggregating to ${tf}-minute candles...`);
      const aggregated = aggregateToTimeframe(oneMinCandles, tf);
      console.log(`  Created ${aggregated.length} ${tf}-minute candles`);

      // Find safe entry patterns
      console.log(`\nIdentifying safe entry patterns (min ${minPoints} points)...`);
      const patterns = identifySafeEntryCandles(aggregated, minPoints);
      console.log(`  Long patterns: ${patterns.long.length}`);
      console.log(`  Short patterns: ${patterns.short.length}`);

      // Store counts
      results.counts[`${tf}m`] = {
        totalCandles: aggregated.length,
        longPatterns: patterns.long.length,
        shortPatterns: patterns.short.length,
        longPct: ((patterns.long.length / aggregated.length) * 100).toFixed(2),
        shortPct: ((patterns.short.length / aggregated.length) * 100).toFixed(2)
      };

      // Extract features for all candles (patterns and non-patterns)
      console.log(`\nExtracting features...`);

      // Create a set of pattern indices for quick lookup
      const longIndices = new Set(patterns.long.map(p => p.index));
      const shortIndices = new Set(patterns.short.map(p => p.index));

      const allFeatures = [];
      let processed = 0;

      for (let i = 1; i < aggregated.length; i++) {
        const candle = aggregated[i];
        const isLongPattern = longIndices.has(i);
        const isShortPattern = shortIndices.has(i);

        // Determine side for feature extraction
        let side = 'none';
        if (isLongPattern && isShortPattern) {
          // Both patterns - classify by which had larger move
          const longMove = candle.high - candle.open;
          const shortMove = candle.open - candle.low;
          side = longMove > shortMove ? 'long' : 'short';
        } else if (isLongPattern) {
          side = 'long';
        } else if (isShortPattern) {
          side = 'short';
        }

        const features = extractFeatures(
          candle,
          side,
          oneMinCandles,
          gexSnapshots,
          ltLevels,
          orderFlowData,
          bookImbalanceData,
          ivData
        );

        features.isLongPattern = isLongPattern;
        features.isShortPattern = isShortPattern;
        features.isPattern = isLongPattern || isShortPattern;

        allFeatures.push(features);

        processed++;
        if (processed % 5000 === 0) {
          console.log(`  Processed ${processed}/${aggregated.length - 1} candles...`);
        }
      }

      console.log(`  Extracted features for ${allFeatures.length} candles`);

      // Analyze patterns separately for long and short
      for (const side of ['long', 'short']) {
        const key = `${tf}m_${side}`;
        const patternFeatures = allFeatures.filter(f => side === 'long' ? f.isLongPattern : f.isShortPattern);
        const normalFeatures = allFeatures.filter(f => side === 'long' ? !f.isLongPattern : !f.isShortPattern);

        console.log(`\n--- ${tf}m ${side.toUpperCase()} PATTERNS (n=${patternFeatures.length}) ---`);

        results.correlations[key] = {};
        results.categoricalPatterns[key] = {};
        results.topPredictors[key] = [];

        // Numeric correlations
        const numericFeatures = [
          'priceVolatility30m',
          'avgCandleRange',
          'maxCandleRange',
          'trendSlope',
          'rangeBuildupRatio',
          'prevCandleSize',
          'distanceToGammaFlip',
          'distanceToS1',
          'distanceToR1',
          'minGexDistance',
          'totalGex',
          'ltSpacing',
          'ltLevelCrossings',
          'cumNetVolume',
          'avgVolumeImbalance',
          'volumeImbalanceTrend',
          'avgSizeImbalance',
          'sizeImbalanceTrend',
          'avgBidAskRatio',
          'atmIv',
          'ivChange',
          'ivPutCallSkew'
        ];

        const significantCorrelations = [];

        for (const feature of numericFeatures) {
          const patternValues = patternFeatures.map(f => f[feature]).filter(v => v !== null && !isNaN(v));
          const normalValues = normalFeatures.map(f => f[feature]).filter(v => v !== null && !isNaN(v));

          if (patternValues.length < 10 || normalValues.length < 10) continue;

          const patternStats = groupStats(patternValues);
          const normalStats = groupStats(normalValues);

          // Create binary target (1 = pattern, 0 = normal)
          const x = [];
          const y = [];

          for (const f of allFeatures) {
            if (f[feature] !== null && !isNaN(f[feature])) {
              x.push(f[feature]);
              y.push((side === 'long' ? f.isLongPattern : f.isShortPattern) ? 1 : 0);
            }
          }

          const { r, p } = pearsonCorrelation(x, y);

          results.correlations[key][feature] = {
            r: r?.toFixed(4),
            p: p?.toFixed(6),
            patternMean: patternStats.mean?.toFixed(2),
            normalMean: normalStats.mean?.toFixed(2),
            patternCount: patternStats.count,
            normalCount: normalStats.count
          };

          if (p !== null && p < 0.05 && r !== null) {
            significantCorrelations.push({
              feature,
              r,
              p,
              patternMean: patternStats.mean,
              normalMean: normalStats.mean,
              direction: r > 0 ? 'HIGHER before pattern' : 'LOWER before pattern'
            });
          }
        }

        // Sort by absolute correlation
        significantCorrelations.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

        console.log('\nSignificant correlations (p < 0.05), sorted by |r|:');
        for (const corr of significantCorrelations.slice(0, 10)) {
          const sign = corr.r > 0 ? '+' : '';
          console.log(`  ${corr.feature.padEnd(25)}: r=${sign}${corr.r.toFixed(4)}, p=${corr.p.toFixed(4)}`);
          console.log(`      Pattern: ${corr.patternMean?.toFixed(2)}, Normal: ${corr.normalMean?.toFixed(2)} - ${corr.direction}`);
        }

        results.topPredictors[key] = significantCorrelations.slice(0, 10).map(c => ({
          feature: c.feature,
          r: c.r.toFixed(4),
          p: c.p.toFixed(6),
          direction: c.direction
        }));

        // Categorical patterns
        const categoricalFeatures = ['gexRegime', 'ltSentiment', 'ltConfiguration', 'nearGexLevel', 'prevCandleDirection', 'netVolumeDirection'];

        console.log('\n## CATEGORICAL PATTERNS');

        for (const feature of categoricalFeatures) {
          const categories = {};

          // Count occurrences
          for (const f of allFeatures) {
            const val = String(f[feature]);
            if (val === 'null' || val === 'undefined') continue;

            if (!categories[val]) {
              categories[val] = { pattern: 0, normal: 0 };
            }

            const isPattern = side === 'long' ? f.isLongPattern : f.isShortPattern;
            if (isPattern) {
              categories[val].pattern++;
            } else {
              categories[val].normal++;
            }
          }

          // Calculate rates
          const rates = {};
          const totalPatterns = patternFeatures.length;
          const baselineRate = totalPatterns / allFeatures.length;

          for (const [val, counts] of Object.entries(categories)) {
            const total = counts.pattern + counts.normal;
            const patternRate = counts.pattern / total;

            rates[val] = {
              patternRate: (patternRate * 100).toFixed(2),
              baseline: (baselineRate * 100).toFixed(2),
              elevated: patternRate > baselineRate * 1.2,
              count: total,
              patternCount: counts.pattern
            };
          }

          results.categoricalPatterns[key][feature] = rates;

          console.log(`\n  ${feature}:`);
          for (const [val, rate] of Object.entries(rates)) {
            const indicator = rate.elevated ? ' ** ELEVATED' : '';
            console.log(`    ${val.padEnd(20)}: ${rate.patternRate}% pattern rate (baseline ${rate.baseline}%, n=${rate.count})${indicator}`);
          }
        }

        // Sample patterns for verification
        results.samplePatterns[key] = patternFeatures.slice(0, 5).map(f => ({
          timestamp: new Date(f.timestamp).toISOString(),
          returnPoints: f.returnPoints?.toFixed(1),
          priceVolatility30m: f.priceVolatility30m?.toFixed(2),
          gexRegime: f.gexRegime,
          ltSentiment: f.ltSentiment,
          cumNetVolume: f.cumNetVolume
        }));
      }
    }

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));

    for (const tf of timeframes) {
      const counts = results.counts[`${tf}m`];
      console.log(`\n${tf}-minute timeframe:`);
      console.log(`  Total candles: ${counts.totalCandles.toLocaleString()}`);
      console.log(`  Long patterns: ${counts.longPatterns.toLocaleString()} (${counts.longPct}%)`);
      console.log(`  Short patterns: ${counts.shortPatterns.toLocaleString()} (${counts.shortPct}%)`);

      for (const side of ['long', 'short']) {
        const key = `${tf}m_${side}`;
        const top = results.topPredictors[key]?.[0];
        if (top) {
          console.log(`  Top ${side} predictor: ${top.feature} (r=${top.r})`);
        }
      }
    }

    // Save results
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
