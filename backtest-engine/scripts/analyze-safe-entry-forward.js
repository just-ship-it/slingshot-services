#!/usr/bin/env node
/**
 * Safe Entry Forward-Looking Analysis
 *
 * Tests whether precursor conditions can PREDICT profitable entries.
 *
 * Approach:
 * 1. Identify precursor conditions in 30-min lookback window
 * 2. Signal entry at NEXT candle's open
 * 3. Track actual outcomes with defined stops/targets
 * 4. Calculate expectancy and edge
 *
 * Key Metrics:
 * - Win rate (hit target before stop)
 * - Expectancy = (win% × avg win) - (loss% × avg loss)
 * - Profit factor = gross wins / gross losses
 * - Max Adverse Excursion (MAE) distribution
 * - Max Favorable Excursion (MFE) distribution
 *
 * Usage:
 *   node scripts/analyze-safe-entry-forward.js \
 *     --start-date 2025-01-01 --end-date 2025-12-25 \
 *     --timeframe 5 --target 15 --stop 8 \
 *     --output results/safe-entry-forward.json
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
const endDateStr = getArg('end-date', '2025-12-25');
const timeframe = parseInt(getArg('timeframe', '5'));
const targetPoints = parseFloat(getArg('target', '15'));
const stopPoints = parseFloat(getArg('stop', '8'));
const outputPath = getArg('output', 'results/safe-entry-forward.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');

const dataDir = path.resolve(process.cwd(), 'data');

console.log('='.repeat(80));
console.log('SAFE ENTRY FORWARD-LOOKING ANALYSIS');
console.log('='.repeat(80));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log(`Timeframe: ${timeframe} minutes`);
console.log(`Target: ${targetPoints} points | Stop: ${stopPoints} points`);
console.log(`Risk/Reward: 1:${(targetPoints/stopPoints).toFixed(2)}`);
console.log(`Output: ${outputPath}`);
console.log();

// ============================================================================
// Data Loading Functions (same as before)
// ============================================================================

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

    if (candleDate < startDate || candleDate > endDate) continue;

    const symbol = parts[9];
    if (symbol && symbol.includes('-')) continue;

    const open = parseFloat(parts[4]);
    const high = parseFloat(parts[5]);
    const low = parseFloat(parts[6]);
    const close = parseFloat(parts[7]);
    const volume = parseInt(parts[8]);

    if (open === high && high === low && low === close) continue;

    candles.push({ timestamp, open, high, low, close, volume, symbol });
  }

  candles.sort((a, b) => a.timestamp - b.timestamp);
  const filtered = filterPrimaryContract(candles);
  console.log(`  Loaded ${filtered.length} candles (from ${candles.length} total)`);

  return filtered;
}

function filterPrimaryContract(candles) {
  if (candles.length === 0) return candles;

  const contractVolumes = new Map();
  const result = [];

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

async function loadGEXData() {
  const gexDir = path.join(dataDir, 'gex/nq');
  const snapshots = new Map();

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
    console.log(`  GEX directory not found`);
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
    } catch (e) {}
  }

  console.log(`  Loaded ${snapshots.size} GEX snapshots`);
  return snapshots;
}

async function loadLTData() {
  const filePath = path.join(dataDir, 'liquidity/nq/NQ_liquidity_levels.csv');
  console.log(`Loading LT levels...`);

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
    console.log(`  LT data not found`);
  }

  return levels;
}

// ============================================================================
// Precursor Feature Extraction
// ============================================================================

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

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squareDiffs = values.map(v => Math.pow(v - mean, 2));
  return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / values.length);
}

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

function findNearest(sortedData, targetTs, maxDiffMs = 15 * 60 * 1000) {
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
 * Extract precursor features from the 30-minute window BEFORE a candle
 */
function extractPrecursors(candle, prevCandle, oneMinCandles, gexSnapshots, ltLevels) {
  const candleTs = candle.timestamp;
  const lookbackStart = candleTs - 30 * 60 * 1000;
  const lookbackEnd = candleTs;

  const features = {
    // Price action precursors
    avgCandleRange: null,
    maxCandleRange: null,
    priceVolatility: null,
    trendSlope: null,
    prevCandleRange: prevCandle ? prevCandle.high - prevCandle.low : null,
    prevCandleDirection: prevCandle ? (prevCandle.close > prevCandle.open ? 'up' : 'down') : null,

    // GEX precursors
    gexRegime: null,
    nearGexLevel: false,
    distanceToNearestGex: null,
    belowGammaFlip: null,

    // LT precursors
    ltSentiment: null,
    ltSpacing: null
  };

  // Get 1-minute candles in lookback window
  const lookbackCandles = getDataInRange(oneMinCandles, lookbackStart, lookbackEnd);

  if (lookbackCandles.length > 0) {
    const closes = lookbackCandles.map(c => c.close);
    const ranges = lookbackCandles.map(c => c.high - c.low);

    features.avgCandleRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    features.maxCandleRange = Math.max(...ranges);
    features.priceVolatility = stdDev(closes);
    features.trendSlope = linearSlope(closes);
  }

  // Get GEX snapshot
  const gexTs = Math.floor(candleTs / (15 * 60 * 1000)) * (15 * 60 * 1000);
  const gexSnap = gexSnapshots.get(gexTs) || gexSnapshots.get(gexTs - 15 * 60 * 1000);

  if (gexSnap && lookbackCandles.length > 0) {
    const currentPrice = lookbackCandles[lookbackCandles.length - 1].close;

    features.gexRegime = gexSnap.regime || null;
    features.belowGammaFlip = gexSnap.gamma_flip ? currentPrice < gexSnap.gamma_flip : null;

    const allLevels = [
      gexSnap.gamma_flip,
      gexSnap.call_wall,
      gexSnap.put_wall,
      ...(gexSnap.support || []),
      ...(gexSnap.resistance || [])
    ].filter(l => l != null);

    if (allLevels.length > 0) {
      const distances = allLevels.map(l => Math.abs(currentPrice - l));
      features.distanceToNearestGex = Math.min(...distances);
      features.nearGexLevel = features.distanceToNearestGex <= 15;
    }
  }

  // Get LT levels
  const ltSnap = findNearest(ltLevels, candleTs);

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
  }

  return features;
}

// ============================================================================
// Signal Generation & Trade Simulation
// ============================================================================

/**
 * Check if precursor conditions are met (filter only, no direction)
 */
function meetsFilterConditions(precursors, config) {
  if (precursors.avgCandleRange === null) return false;

  const { minVolatility, requireNearGex, requireHighVolatility } = config;

  if (requireHighVolatility && precursors.avgCandleRange < minVolatility) {
    return false;
  }

  if (requireNearGex && !precursors.nearGexLevel) {
    return false;
  }

  return true;
}

/**
 * Generate signal direction based on directional factors
 * Returns 'long', 'short', or 'both' (test both directions)
 */
function getSignalDirection(precursors, config) {
  const { useLtSentiment, usePrevCandleDirection, useGexRegime } = config;

  // If no directional factors enabled, test both directions
  if (!useLtSentiment && !usePrevCandleDirection && !useGexRegime) {
    return 'both';
  }

  let longScore = 0;
  let shortScore = 0;

  if (useLtSentiment && precursors.ltSentiment) {
    if (precursors.ltSentiment === 'BULLISH') longScore += 1;
    if (precursors.ltSentiment === 'BEARISH') shortScore += 1;
  }

  if (usePrevCandleDirection && precursors.prevCandleDirection) {
    if (precursors.prevCandleDirection === 'up') longScore += 1;
    if (precursors.prevCandleDirection === 'down') shortScore += 1;
  }

  if (useGexRegime && precursors.gexRegime) {
    if (precursors.gexRegime.includes('positive')) longScore += 1;
    if (precursors.gexRegime.includes('negative')) shortScore += 1;
  }

  if (longScore > shortScore) return 'long';
  if (shortScore > longScore) return 'short';
  return 'both'; // Tie - test both
}

/**
 * Simulate trade outcome on the signal candle
 * Returns { result: 'win'|'loss'|'breakeven', pnl, mae, mfe }
 */
function simulateTrade(entryCandle, direction, target, stop) {
  const entry = entryCandle.open;

  let mae = 0; // Max adverse excursion
  let mfe = 0; // Max favorable excursion

  if (direction === 'long') {
    // For longs: adverse = price going down, favorable = price going up
    mae = entry - entryCandle.low;
    mfe = entryCandle.high - entry;

    // Check if stopped out (assume stop hit first if both would trigger)
    if (mae >= stop) {
      return { result: 'loss', pnl: -stop, mae, mfe, exitReason: 'stop' };
    }

    // Check if target hit
    if (mfe >= target) {
      return { result: 'win', pnl: target, mae, mfe, exitReason: 'target' };
    }

    // Neither hit - use close
    const pnl = entryCandle.close - entry;
    return { result: pnl > 0 ? 'win' : 'loss', pnl, mae, mfe, exitReason: 'close' };

  } else {
    // For shorts: adverse = price going up, favorable = price going down
    mae = entryCandle.high - entry;
    mfe = entry - entryCandle.low;

    // Check if stopped out
    if (mae >= stop) {
      return { result: 'loss', pnl: -stop, mae, mfe, exitReason: 'stop' };
    }

    // Check if target hit
    if (mfe >= target) {
      return { result: 'win', pnl: target, mae, mfe, exitReason: 'target' };
    }

    // Neither hit - use close
    const pnl = entry - entryCandle.close;
    return { result: pnl > 0 ? 'win' : 'loss', pnl, mae, mfe, exitReason: 'close' };
  }
}

// ============================================================================
// Statistical Analysis
// ============================================================================

function calculateStats(trades) {
  if (trades.length === 0) {
    return { count: 0, winRate: '0', expectancy: '0', profitFactor: '0', totalPnl: '0', avgMae: '0', avgMfe: '0', maxMae: '0', maxMfe: '0', wins: 0, losses: 0, avgWin: '0', avgLoss: '0' };
  }

  let winCount = 0, lossCount = 0;
  let grossWins = 0, grossLosses = 0;
  let totalPnl = 0;
  let totalMae = 0, totalMfe = 0;
  let maxMae = 0, maxMfe = 0;

  for (const t of trades) {
    totalPnl += t.pnl;
    totalMae += t.mae;
    totalMfe += t.mfe;
    if (t.mae > maxMae) maxMae = t.mae;
    if (t.mfe > maxMfe) maxMfe = t.mfe;

    if (t.pnl > 0) {
      winCount++;
      grossWins += t.pnl;
    } else if (t.pnl < 0) {
      lossCount++;
      grossLosses += Math.abs(t.pnl);
    }
  }

  const winRate = winCount / trades.length;
  const avgWin = winCount > 0 ? grossWins / winCount : 0;
  const avgLoss = lossCount > 0 ? grossLosses / lossCount : 0;

  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

  return {
    count: trades.length,
    wins: winCount,
    losses: lossCount,
    winRate: (winRate * 100).toFixed(2),
    avgWin: avgWin.toFixed(2),
    avgLoss: avgLoss.toFixed(2),
    expectancy: expectancy.toFixed(2),
    profitFactor: profitFactor.toFixed(2),
    totalPnl: totalPnl.toFixed(2),
    avgMae: (totalMae / trades.length).toFixed(2),
    avgMfe: (totalMfe / trades.length).toFixed(2),
    maxMae: maxMae.toFixed(2),
    maxMfe: maxMfe.toFixed(2)
  };
}

// ============================================================================
// Main Analysis
// ============================================================================

async function main() {
  try {
    // Load data
    console.log('\n--- LOADING DATA ---\n');

    const [oneMinCandles, gexSnapshots, ltLevels] = await Promise.all([
      loadOHLCVData(),
      loadGEXData(),
      loadLTData()
    ]);

    // Aggregate candles
    console.log(`\nAggregating to ${timeframe}-minute candles...`);
    const candles = aggregateToTimeframe(oneMinCandles, timeframe);
    console.log(`  Created ${candles.length} candles`);

    // Define strategy configurations to test
    const strategies = [
      {
        name: 'Baseline (Sampled 1:5)',
        config: {
          minVolatility: 0,
          requireNearGex: false,
          requireHighVolatility: false,
          useLtSentiment: false,
          usePrevCandleDirection: false,
          useGexRegime: false
        },
        sampleEveryN: 5 // Sample every 5th candle for baseline
      },
      {
        name: 'High Volatility (>10)',
        config: {
          minVolatility: 10,
          requireNearGex: false,
          requireHighVolatility: true,
          useLtSentiment: false,
          usePrevCandleDirection: false,
          useGexRegime: false
        }
      },
      {
        name: 'High Volatility (>15)',
        config: {
          minVolatility: 15,
          requireNearGex: false,
          requireHighVolatility: true,
          useLtSentiment: false,
          usePrevCandleDirection: false,
          useGexRegime: false
        }
      },
      {
        name: 'Near GEX Level (<15pts)',
        config: {
          minVolatility: 0,
          requireNearGex: true,
          requireHighVolatility: false,
          useLtSentiment: false,
          usePrevCandleDirection: false,
          useGexRegime: false
        }
      },
      {
        name: 'High Vol + Near GEX',
        config: {
          minVolatility: 10,
          requireNearGex: true,
          requireHighVolatility: true,
          useLtSentiment: false,
          usePrevCandleDirection: false,
          useGexRegime: false
        }
      },
      {
        name: 'High Vol + LT Bullish (Long)',
        config: {
          minVolatility: 10,
          requireNearGex: false,
          requireHighVolatility: true,
          useLtSentiment: true,
          usePrevCandleDirection: false,
          useGexRegime: false
        }
      },
      {
        name: 'High Vol + Prev Up (Long)',
        config: {
          minVolatility: 10,
          requireNearGex: false,
          requireHighVolatility: true,
          useLtSentiment: false,
          usePrevCandleDirection: true,
          useGexRegime: false
        }
      },
      {
        name: 'High Vol + Positive GEX (Long)',
        config: {
          minVolatility: 10,
          requireNearGex: false,
          requireHighVolatility: true,
          useLtSentiment: false,
          usePrevCandleDirection: false,
          useGexRegime: true
        }
      },
      {
        name: 'Near GEX + LT Sentiment',
        config: {
          minVolatility: 0,
          requireNearGex: true,
          requireHighVolatility: false,
          useLtSentiment: true,
          usePrevCandleDirection: false,
          useGexRegime: false
        }
      },
      {
        name: 'Full Confluence',
        config: {
          minVolatility: 10,
          requireNearGex: true,
          requireHighVolatility: true,
          useLtSentiment: true,
          usePrevCandleDirection: true,
          useGexRegime: true
        }
      }
    ];

    const results = {
      metadata: {
        startDate: startDateStr,
        endDate: endDateStr,
        timeframe,
        targetPoints,
        stopPoints,
        riskReward: (targetPoints / stopPoints).toFixed(2),
        totalCandles: candles.length,
        generated: new Date().toISOString()
      },
      strategies: {}
    };

    // Test each strategy
    console.log('\n' + '='.repeat(80));
    console.log('STRATEGY RESULTS');
    console.log('='.repeat(80));
    console.log(`\nTarget: ${targetPoints} pts | Stop: ${stopPoints} pts | R:R = 1:${(targetPoints/stopPoints).toFixed(2)}`);
    console.log(`Breakeven win rate needed: ${((stopPoints / (targetPoints + stopPoints)) * 100).toFixed(1)}%\n`);

    for (const strategy of strategies) {
      console.log(`\n--- ${strategy.name} ---`);

      const longTrades = [];
      const shortTrades = [];

      // Process each candle
      for (let i = 2; i < candles.length - 1; i++) {
        // Handle sampling for baseline
        if (strategy.sampleEveryN && i % strategy.sampleEveryN !== 0) {
          continue;
        }

        const signalCandle = candles[i];
        const prevCandle = candles[i - 1];
        const entryCandle = candles[i + 1]; // Enter on NEXT candle

        // Extract precursors from the signal candle's lookback
        const precursors = extractPrecursors(
          signalCandle,
          prevCandle,
          oneMinCandles,
          gexSnapshots,
          ltLevels
        );

        // Check filter conditions (baseline has all filters disabled, so passes)
        if (!meetsFilterConditions(precursors, strategy.config)) continue;

        // Get direction(s) to trade
        const direction = getSignalDirection(precursors, strategy.config);

        if (direction === 'both' || direction === 'long') {
          const trade = simulateTrade(entryCandle, 'long', targetPoints, stopPoints);
          trade.timestamp = entryCandle.timestamp;
          trade.direction = 'long';
          trade.precursors = precursors;
          longTrades.push(trade);
        }

        if (direction === 'both' || direction === 'short') {
          const trade = simulateTrade(entryCandle, 'short', targetPoints, stopPoints);
          trade.timestamp = entryCandle.timestamp;
          trade.direction = 'short';
          trade.precursors = precursors;
          shortTrades.push(trade);
        }
      }

      const allTrades = [...longTrades, ...shortTrades];
      const longStats = calculateStats(longTrades);
      const shortStats = calculateStats(shortTrades);
      const totalStats = calculateStats(allTrades);

      results.strategies[strategy.name] = {
        config: strategy.config,
        long: longStats,
        short: shortStats,
        total: totalStats
      };

      // Print results
      console.log(`  Total trades: ${totalStats.count} (${longStats.count} long, ${shortStats.count} short)`);
      console.log(`  Win rate: ${totalStats.winRate}% (Long: ${longStats.winRate}%, Short: ${shortStats.winRate}%)`);
      console.log(`  Expectancy: ${totalStats.expectancy} pts/trade`);
      console.log(`  Profit Factor: ${totalStats.profitFactor}`);
      console.log(`  Total P&L: ${totalStats.totalPnl} pts`);
      console.log(`  Avg MAE: ${totalStats.avgMae} pts | Avg MFE: ${totalStats.avgMfe} pts`);

      // Edge assessment
      const breakevenWinRate = (stopPoints / (targetPoints + stopPoints)) * 100;
      const actualWinRate = parseFloat(totalStats.winRate);
      const edge = actualWinRate - breakevenWinRate;

      if (edge > 5) {
        console.log(`  ✓ EDGE: +${edge.toFixed(1)}% above breakeven`);
      } else if (edge > 0) {
        console.log(`  ~ Marginal edge: +${edge.toFixed(1)}%`);
      } else {
        console.log(`  ✗ No edge: ${edge.toFixed(1)}% below breakeven`);
      }
    }

    // Summary comparison
    console.log('\n' + '='.repeat(80));
    console.log('STRATEGY COMPARISON');
    console.log('='.repeat(80));
    console.log('\n' + 'Strategy'.padEnd(35) + 'Trades'.padStart(8) + 'Win%'.padStart(8) + 'Expect'.padStart(10) + 'PF'.padStart(8) + 'Total P&L'.padStart(12));
    console.log('-'.repeat(81));

    const sortedStrategies = Object.entries(results.strategies)
      .sort((a, b) => parseFloat(b[1].total.expectancy) - parseFloat(a[1].total.expectancy));

    for (const [name, data] of sortedStrategies) {
      const t = data.total;
      console.log(
        name.padEnd(35) +
        t.count.toString().padStart(8) +
        (t.winRate + '%').padStart(8) +
        t.expectancy.padStart(10) +
        t.profitFactor.padStart(8) +
        t.totalPnl.padStart(12)
      );
    }

    // Find best strategy
    const best = sortedStrategies[0];
    console.log(`\nBest strategy: ${best[0]}`);
    console.log(`  Expectancy: ${best[1].total.expectancy} pts/trade`);
    console.log(`  Profit Factor: ${best[1].total.profitFactor}`);

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
