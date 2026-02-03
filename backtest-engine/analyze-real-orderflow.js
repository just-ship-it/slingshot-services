#!/usr/bin/env node
/**
 * Real Order Flow Pattern Analysis
 *
 * Uses ACTUAL Databento data:
 * - CVD from trades (buy/sell volume delta)
 * - Book imbalance from MBP-1 (bid/ask size imbalance)
 *
 * Finds patterns and correlates with future price action.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { DatabentoTradeLoader } from './src/data/databento-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  ohlcvFile: path.join(__dirname, 'data/ohlcv/nq/NQ_ohlcv_1m.csv'),
  precomputedImbalance: path.join(__dirname, 'data/orderflow/nq/book-imbalance-1m.csv'),
  tradesDir: path.join(__dirname, 'data/orderflow/nq/trades'),
  lookforwardWindows: [5, 10, 15, 30, 60]
};

/**
 * Load OHLCV data
 */
async function loadOHLCV(startDate, endDate) {
  return new Promise((resolve, reject) => {
    const candles = [];
    let headers = null;

    const stream = fs.createReadStream(CONFIG.ohlcvFile);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!headers) {
        headers = line.split(',');
        return;
      }

      const values = line.split(',');
      const record = {};
      headers.forEach((h, i) => record[h] = values[i]);

      if (record.symbol?.includes('-')) return;

      const timestamp = new Date(record.ts_event).getTime();
      const date = new Date(timestamp);
      if (date < startDate || date > endDate) return;

      candles.push({
        timestamp,
        open: parseFloat(record.open),
        high: parseFloat(record.high),
        low: parseFloat(record.low),
        close: parseFloat(record.close),
        volume: parseInt(record.volume)
      });
    });

    rl.on('close', () => {
      candles.sort((a, b) => a.timestamp - b.timestamp);
      resolve(candles);
    });

    rl.on('error', reject);
  });
}

/**
 * Load precomputed book imbalance from MBP-1
 */
async function loadBookImbalance() {
  return new Promise((resolve, reject) => {
    const map = new Map();
    let headers = null;

    const stream = fs.createReadStream(CONFIG.precomputedImbalance);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!headers) {
        headers = line.split(',');
        return;
      }

      const values = line.split(',');
      const record = {};
      headers.forEach((h, i) => record[h] = values[i]);

      const timestamp = new Date(record.timestamp).getTime();
      map.set(timestamp, {
        sizeImbalance: parseFloat(record.sizeImbalance),
        countImbalance: parseFloat(record.countImbalance),
        avgSizeImbalance: parseFloat(record.avgSizeImbalance),
        bidAskRatio: parseFloat(record.bidAskRatio),
        totalBidSize: parseInt(record.totalBidSize),
        totalAskSize: parseInt(record.totalAskSize),
        updates: parseInt(record.updates)
      });
    });

    rl.on('close', () => resolve(map));
    rl.on('error', reject);
  });
}

/**
 * Load REAL CVD from Databento trade data
 */
async function loadRealCVD(startDate, endDate, candles) {
  const loader = new DatabentoTradeLoader({
    dataDir: CONFIG.tradesDir,
    symbolFilter: 'NQ'
  });

  console.log('  Loading CVD from Databento trades (this may take a few minutes)...');

  const cvdMap = await loader.computeCVDForCandlesStreaming(
    startDate,
    endDate,
    candles,
    (days, trades) => {
      if (days % 10 === 0) {
        process.stdout.write(`\r    Day ${days}: ${trades.toLocaleString()} trades processed`);
      }
    }
  );

  process.stdout.write('\r' + ' '.repeat(60) + '\r');
  return cvdMap;
}

/**
 * Calculate future price move
 */
function getFutureMove(candles, candleMap, startTimestamp, windowMinutes) {
  const startIdx = candleMap.get(startTimestamp);
  if (startIdx === undefined) return null;

  const endIdx = startIdx + windowMinutes;
  if (endIdx >= candles.length) return null;

  const startCandle = candles[startIdx];
  const endCandle = candles[endIdx];

  // Track MFE/MAE
  let maxUp = 0, maxDown = 0;
  for (let i = startIdx + 1; i <= endIdx; i++) {
    maxUp = Math.max(maxUp, candles[i].high - startCandle.close);
    maxDown = Math.min(maxDown, candles[i].low - startCandle.close);
  }

  return {
    move: endCandle.close - startCandle.close,
    maxUp,
    maxDown: Math.abs(maxDown)
  };
}

/**
 * Analyze CVD patterns
 */
function analyzeCVDPatterns(candles, candleMap, cvdMap, lookforward) {
  const results = {
    // Extreme CVD levels
    highCVD: { signals: 0, correct: 0, moves: [] },
    lowCVD: { signals: 0, correct: 0, moves: [] },

    // CVD slope (momentum)
    risingCVD: { signals: 0, correct: 0, moves: [] },
    fallingCVD: { signals: 0, correct: 0, moves: [] },

    // CVD acceleration (change in slope)
    accelerating: { signals: 0, correct: 0, moves: [] },
    decelerating: { signals: 0, correct: 0, moves: [] },

    // CVD divergence from price
    bullishDiv: { signals: 0, correct: 0, moves: [] },
    bearishDiv: { signals: 0, correct: 0, moves: [] }
  };

  // Need history for slope calculations
  const cvdHistory = [];
  const priceHistory = [];

  for (const candle of candles) {
    const cvdData = cvdMap.get(candle.timestamp);
    if (!cvdData) continue;

    cvdHistory.push({ timestamp: candle.timestamp, cvd: cvdData.cumulativeDelta });
    priceHistory.push({ timestamp: candle.timestamp, close: candle.close });

    if (cvdHistory.length < 20) continue;

    // Calculate CVD metrics
    const cvd5 = cvdHistory.slice(-5);
    const cvd20 = cvdHistory.slice(-20);

    const shortSlope = (cvd5[4].cvd - cvd5[0].cvd) / 5;
    const longSlope = (cvd20[19].cvd - cvd20[0].cvd) / 20;

    // Acceleration = change in slope
    if (cvdHistory.length >= 25) {
      const prevCvd5 = cvdHistory.slice(-10, -5);
      const prevShortSlope = (prevCvd5[4].cvd - prevCvd5[0].cvd) / 5;
      const acceleration = shortSlope - prevShortSlope;

      const futureMove = getFutureMove(candles, candleMap, candle.timestamp, lookforward);
      if (!futureMove) continue;

      // Strong rising CVD (momentum)
      if (shortSlope > 100) {
        results.risingCVD.signals++;
        results.risingCVD.moves.push(futureMove.move);
        if (futureMove.move > 0) results.risingCVD.correct++;
      }

      // Strong falling CVD
      if (shortSlope < -100) {
        results.fallingCVD.signals++;
        results.fallingCVD.moves.push(futureMove.move);
        if (futureMove.move < 0) results.fallingCVD.correct++;
      }

      // CVD accelerating (buying pressure increasing)
      if (acceleration > 50 && shortSlope > 0) {
        results.accelerating.signals++;
        results.accelerating.moves.push(futureMove.move);
        if (futureMove.move > 0) results.accelerating.correct++;
      }

      // CVD decelerating (selling pressure increasing)
      if (acceleration < -50 && shortSlope < 0) {
        results.decelerating.signals++;
        results.decelerating.moves.push(futureMove.move);
        if (futureMove.move < 0) results.decelerating.correct++;
      }

      // Price/CVD divergence
      const price5 = priceHistory.slice(-5);
      const priceSlope = (price5[4].close - price5[0].close) / 5;

      // Bullish divergence: price falling but CVD rising
      if (priceSlope < -0.5 && shortSlope > 50) {
        results.bullishDiv.signals++;
        results.bullishDiv.moves.push(futureMove.move);
        if (futureMove.move > 0) results.bullishDiv.correct++;
      }

      // Bearish divergence: price rising but CVD falling
      if (priceSlope > 0.5 && shortSlope < -50) {
        results.bearishDiv.signals++;
        results.bearishDiv.moves.push(futureMove.move);
        if (futureMove.move < 0) results.bearishDiv.correct++;
      }
    }
  }

  return results;
}

/**
 * Analyze book imbalance patterns
 */
function analyzeImbalancePatterns(candles, candleMap, imbalanceMap, lookforward) {
  const results = {
    // Strong imbalance levels
    strongBullish: { signals: 0, correct: 0, moves: [] },
    strongBearish: { signals: 0, correct: 0, moves: [] },

    // Imbalance regime change
    turningBullish: { signals: 0, correct: 0, moves: [] },
    turningBearish: { signals: 0, correct: 0, moves: [] },

    // Absorption patterns (large size but small imbalance = absorption)
    bidAbsorption: { signals: 0, correct: 0, moves: [] },
    askAbsorption: { signals: 0, correct: 0, moves: [] }
  };

  const imbalanceHistory = [];

  for (const candle of candles) {
    const imbData = imbalanceMap.get(candle.timestamp);
    if (!imbData || imbData.updates < 100) continue;

    imbalanceHistory.push({ timestamp: candle.timestamp, ...imbData });
    if (imbalanceHistory.length < 10) continue;

    const futureMove = getFutureMove(candles, candleMap, candle.timestamp, lookforward);
    if (!futureMove) continue;

    const current = imbData;
    const prev5 = imbalanceHistory.slice(-6, -1);
    const avgPrevImbalance = prev5.reduce((s, d) => s + d.sizeImbalance, 0) / 5;

    // Strong bullish imbalance
    if (current.sizeImbalance > 0.15) {
      results.strongBullish.signals++;
      results.strongBullish.moves.push(futureMove.move);
      if (futureMove.move > 0) results.strongBullish.correct++;
    }

    // Strong bearish imbalance
    if (current.sizeImbalance < -0.15) {
      results.strongBearish.signals++;
      results.strongBearish.moves.push(futureMove.move);
      if (futureMove.move < 0) results.strongBearish.correct++;
    }

    // Regime turning bullish (was bearish, now bullish)
    if (avgPrevImbalance < -0.05 && current.sizeImbalance > 0.10) {
      results.turningBullish.signals++;
      results.turningBullish.moves.push(futureMove.move);
      if (futureMove.move > 0) results.turningBullish.correct++;
    }

    // Regime turning bearish
    if (avgPrevImbalance > 0.05 && current.sizeImbalance < -0.10) {
      results.turningBearish.signals++;
      results.turningBearish.moves.push(futureMove.move);
      if (futureMove.move < 0) results.turningBearish.correct++;
    }

    // Absorption detection: large total size but small imbalance
    const totalSize = current.totalBidSize + current.totalAskSize;
    if (totalSize > 100000 && Math.abs(current.sizeImbalance) < 0.03) {
      // Price was falling, bid absorbed (bullish)
      const priceChange = candle.close - candles[candleMap.get(candle.timestamp) - 5]?.close || 0;
      if (priceChange < -3) {
        results.bidAbsorption.signals++;
        results.bidAbsorption.moves.push(futureMove.move);
        if (futureMove.move > 0) results.bidAbsorption.correct++;
      }
      // Price was rising, ask absorbed (bearish)
      if (priceChange > 3) {
        results.askAbsorption.signals++;
        results.askAbsorption.moves.push(futureMove.move);
        if (futureMove.move < 0) results.askAbsorption.correct++;
      }
    }
  }

  return results;
}

/**
 * Print results table
 */
function printResults(name, results) {
  console.log(`\n${name}:`);
  console.log('-'.repeat(80));
  console.log('Pattern              | Signals | Win Rate | Avg Move | Edge?');
  console.log('-'.repeat(80));

  for (const [pattern, data] of Object.entries(results)) {
    if (data.signals < 10) continue;

    const winRate = (data.correct / data.signals * 100).toFixed(1);
    const avgMove = data.moves.length > 0
      ? (data.moves.reduce((a, b) => a + b, 0) / data.moves.length).toFixed(2)
      : '0.00';

    const edge = parseFloat(winRate) > 55 ? '✅ YES' :
                 parseFloat(winRate) > 52 ? '⚠️ MAYBE' : '❌ NO';

    console.log(
      `${pattern.padEnd(20)} | ${String(data.signals).padStart(7)} | ${winRate.padStart(7)}% | ${avgMove.padStart(8)} pts | ${edge}`
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  let startDate = new Date('2025-01-01');
  let endDate = new Date('2025-03-31');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start') startDate = new Date(args[++i]);
    if (args[i] === '--end') endDate = new Date(args[++i]);
  }

  console.log('=== Real Order Flow Pattern Analysis ===\n');
  console.log(`Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}\n`);

  console.log('Loading data...');

  const candles = await loadOHLCV(startDate, endDate);
  console.log(`  Loaded ${candles.length.toLocaleString()} candles`);

  // Create timestamp -> index map for fast lookup
  const candleMap = new Map();
  candles.forEach((c, i) => candleMap.set(c.timestamp, i));

  const imbalanceMap = await loadBookImbalance();
  console.log(`  Loaded ${imbalanceMap.size.toLocaleString()} book imbalance records`);

  const cvdMap = await loadRealCVD(startDate, endDate, candles);
  console.log(`  Loaded ${cvdMap.size.toLocaleString()} CVD records from Databento trades`);

  for (const lookforward of [15, 30, 60]) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`ANALYSIS: ${lookforward}-minute lookforward window`);
    console.log('='.repeat(80));

    const cvdResults = analyzeCVDPatterns(candles, candleMap, cvdMap, lookforward);
    printResults('CVD Patterns (from real Databento trade data)', cvdResults);

    const imbResults = analyzeImbalancePatterns(candles, candleMap, imbalanceMap, lookforward);
    printResults('Book Imbalance Patterns (from real MBP-1 data)', imbResults);
  }

  console.log('\n=== Analysis Complete ===');
}

main().catch(console.error);
