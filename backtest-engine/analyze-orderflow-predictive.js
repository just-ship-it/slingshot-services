#!/usr/bin/env node
/**
 * Order Flow Predictive Analysis
 *
 * Analyzes whether order flow signals actually predict future price movement.
 * This is a research tool - no trading logic, just measuring correlations.
 *
 * Questions we're answering:
 * 1. When CVD slope turns positive, does price tend to rise over the next N minutes?
 * 2. When book imbalance is strongly bullish, does price tend to rise?
 * 3. What's the optimal lookforward window (10min, 30min, 60min)?
 *
 * Usage:
 *   node analyze-orderflow-predictive.js --start 2025-01-01 --end 2025-03-31
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG = {
  ohlcvFile: path.join(__dirname, 'data/ohlcv/nq/NQ_ohlcv_1m.csv'),
  precomputedImbalance: path.join(__dirname, 'data/orderflow/nq/book-imbalance-1m.csv'),
  tradesDir: path.join(__dirname, 'data/orderflow/nq/trades'),

  // Analysis windows (minutes after signal)
  lookforwardWindows: [5, 10, 15, 30, 60],

  // Thresholds to test
  cvdSlopeThresholds: [0.25, 0.5, 1.0, 2.0, 5.0],
  imbalanceThresholds: [0.03, 0.05, 0.10, 0.15, 0.20],

  // Point thresholds for "significant" move
  moveThresholds: [5, 10, 15, 20, 30, 40, 50]
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

      // Filter by date and exclude spreads
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
 * Load precomputed book imbalance
 */
async function loadBookImbalance() {
  return new Promise((resolve, reject) => {
    const imbalanceMap = new Map();
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
      imbalanceMap.set(timestamp, {
        sizeImbalance: parseFloat(record.sizeImbalance),
        bidAskRatio: parseFloat(record.bidAskRatio),
        updates: parseInt(record.updates)
      });
    });

    rl.on('close', () => resolve(imbalanceMap));
    rl.on('error', reject);
  });
}

/**
 * Calculate CVD from trades (simplified - sums buy vs sell volume)
 */
async function loadCVDFromTrades(startDate, endDate, candles) {
  // For simplicity, we'll compute CVD incrementally from the candles
  // In a full implementation, we'd load actual trade data
  // For now, use a proxy: (close - open) * volume as delta indicator

  const cvdMap = new Map();
  let cumulativeDelta = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    // Simple proxy: if candle closed up, assume net buying
    const delta = (c.close - c.open) * c.volume / 100; // Normalized
    cumulativeDelta += delta;

    // Calculate slope over last 5 candles
    let slope = 0;
    if (i >= 5) {
      const prevCvd = cvdMap.get(candles[i - 5].timestamp)?.cvd || 0;
      slope = (cumulativeDelta - prevCvd) / 5;
    }

    cvdMap.set(c.timestamp, {
      cvd: cumulativeDelta,
      slope: slope,
      delta: delta
    });
  }

  return cvdMap;
}

/**
 * Calculate future price move from a given candle
 */
function calculateFutureMove(candles, startIndex, windowMinutes) {
  const startCandle = candles[startIndex];
  const endIndex = startIndex + windowMinutes;

  if (endIndex >= candles.length) return null;

  const endCandle = candles[endIndex];

  // Simple return: close to close
  const move = endCandle.close - startCandle.close;

  // Also track max favorable excursion (MFE) and max adverse excursion (MAE)
  let maxUp = 0;
  let maxDown = 0;

  for (let i = startIndex + 1; i <= endIndex; i++) {
    const c = candles[i];
    maxUp = Math.max(maxUp, c.high - startCandle.close);
    maxDown = Math.min(maxDown, c.low - startCandle.close);
  }

  return { move, maxUp, maxDown: Math.abs(maxDown) };
}

/**
 * Analyze CVD slope as predictor
 */
function analyzeCVDSlope(candles, cvdMap, threshold, lookforward) {
  const results = {
    bullishSignals: 0,
    bearishSignals: 0,
    bullishCorrect: 0,
    bearishCorrect: 0,
    bullishMoves: [],
    bearishMoves: []
  };

  let lastSlope = null;

  for (let i = 5; i < candles.length - lookforward; i++) {
    const cvd = cvdMap.get(candles[i].timestamp);
    if (!cvd) continue;

    const currentSlope = cvd.slope;

    // Detect slope reversal
    if (lastSlope !== null) {
      // Bullish reversal: slope crosses from negative to positive
      if (lastSlope < -threshold && currentSlope > threshold) {
        results.bullishSignals++;
        const futureMove = calculateFutureMove(candles, i, lookforward);
        if (futureMove) {
          results.bullishMoves.push(futureMove.move);
          if (futureMove.move > 0) results.bullishCorrect++;
        }
      }

      // Bearish reversal: slope crosses from positive to negative
      if (lastSlope > threshold && currentSlope < -threshold) {
        results.bearishSignals++;
        const futureMove = calculateFutureMove(candles, i, lookforward);
        if (futureMove) {
          results.bearishMoves.push(-futureMove.move); // Negate for consistency
          if (futureMove.move < 0) results.bearishCorrect++;
        }
      }
    }

    lastSlope = currentSlope;
  }

  return results;
}

/**
 * Analyze book imbalance as predictor
 */
function analyzeImbalance(candles, imbalanceMap, threshold, lookforward) {
  const results = {
    bullishSignals: 0,
    bearishSignals: 0,
    bullishCorrect: 0,
    bearishCorrect: 0,
    bullishMoves: [],
    bearishMoves: []
  };

  for (let i = 0; i < candles.length - lookforward; i++) {
    const imb = imbalanceMap.get(candles[i].timestamp);
    if (!imb || imb.updates < 100) continue; // Need sufficient data

    const futureMove = calculateFutureMove(candles, i, lookforward);
    if (!futureMove) continue;

    // Strong bullish imbalance
    if (imb.sizeImbalance > threshold) {
      results.bullishSignals++;
      results.bullishMoves.push(futureMove.move);
      if (futureMove.move > 0) results.bullishCorrect++;
    }

    // Strong bearish imbalance
    if (imb.sizeImbalance < -threshold) {
      results.bearishSignals++;
      results.bearishMoves.push(-futureMove.move);
      if (futureMove.move < 0) results.bearishCorrect++;
    }
  }

  return results;
}

/**
 * Calculate statistics for moves
 */
function calculateStats(moves) {
  if (moves.length === 0) return { mean: 0, median: 0, stdDev: 0, n: 0 };

  const sorted = [...moves].sort((a, b) => a - b);
  const n = moves.length;
  const mean = moves.reduce((a, b) => a + b, 0) / n;
  const median = sorted[Math.floor(n / 2)];
  const variance = moves.reduce((sum, m) => sum + Math.pow(m - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  return { mean, median, stdDev, n };
}

/**
 * Main analysis
 */
async function main() {
  const args = process.argv.slice(2);
  let startDate = new Date('2025-01-01');
  let endDate = new Date('2025-03-31');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start') startDate = new Date(args[++i]);
    if (args[i] === '--end') endDate = new Date(args[++i]);
  }

  console.log('=== Order Flow Predictive Analysis ===\n');
  console.log(`Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}\n`);

  console.log('Loading data...');
  const candles = await loadOHLCV(startDate, endDate);
  console.log(`  Loaded ${candles.length.toLocaleString()} candles`);

  const imbalanceMap = await loadBookImbalance();
  console.log(`  Loaded ${imbalanceMap.size.toLocaleString()} imbalance records`);

  const cvdMap = await loadCVDFromTrades(startDate, endDate, candles);
  console.log(`  Computed CVD for ${cvdMap.size.toLocaleString()} candles`);

  console.log('\n' + '='.repeat(80));
  console.log('CVD SLOPE REVERSAL ANALYSIS');
  console.log('Question: When CVD slope reverses, does price follow?');
  console.log('='.repeat(80) + '\n');

  // Test different thresholds and lookforward windows
  console.log('Lookforward | Threshold | Bull Signals | Bull Win% | Bear Signals | Bear Win% | Avg Move');
  console.log('-'.repeat(100));

  for (const lookforward of [10, 30, 60]) {
    for (const threshold of [0.5, 1.0, 2.0]) {
      const results = analyzeCVDSlope(candles, cvdMap, threshold, lookforward);

      const bullWinRate = results.bullishSignals > 0
        ? (results.bullishCorrect / results.bullishSignals * 100).toFixed(1)
        : 'N/A';
      const bearWinRate = results.bearishSignals > 0
        ? (results.bearishCorrect / results.bearishSignals * 100).toFixed(1)
        : 'N/A';

      const allMoves = [...results.bullishMoves, ...results.bearishMoves];
      const avgMove = allMoves.length > 0
        ? (allMoves.reduce((a, b) => a + b, 0) / allMoves.length).toFixed(2)
        : 'N/A';

      console.log(
        `${String(lookforward).padStart(10)}m | ` +
        `${threshold.toFixed(2).padStart(9)} | ` +
        `${String(results.bullishSignals).padStart(12)} | ` +
        `${bullWinRate.toString().padStart(9)}% | ` +
        `${String(results.bearishSignals).padStart(12)} | ` +
        `${bearWinRate.toString().padStart(9)}% | ` +
        `${avgMove.toString().padStart(7)} pts`
      );
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('BOOK IMBALANCE ANALYSIS');
  console.log('Question: When bid/ask imbalance is strong, does price follow?');
  console.log('='.repeat(80) + '\n');

  console.log('Lookforward | Threshold | Bull Signals | Bull Win% | Bear Signals | Bear Win% | Avg Move');
  console.log('-'.repeat(100));

  for (const lookforward of [10, 30, 60]) {
    for (const threshold of [0.05, 0.10, 0.15]) {
      const results = analyzeImbalance(candles, imbalanceMap, threshold, lookforward);

      const bullWinRate = results.bullishSignals > 0
        ? (results.bullishCorrect / results.bullishSignals * 100).toFixed(1)
        : 'N/A';
      const bearWinRate = results.bearishSignals > 0
        ? (results.bearishCorrect / results.bearishSignals * 100).toFixed(1)
        : 'N/A';

      const allMoves = [...results.bullishMoves, ...results.bearishMoves];
      const avgMove = allMoves.length > 0
        ? (allMoves.reduce((a, b) => a + b, 0) / allMoves.length).toFixed(2)
        : 'N/A';

      console.log(
        `${String(lookforward).padStart(10)}m | ` +
        `${threshold.toFixed(2).padStart(9)} | ` +
        `${String(results.bullishSignals).padStart(12)} | ` +
        `${bullWinRate.toString().padStart(9)}% | ` +
        `${String(results.bearishSignals).padStart(12)} | ` +
        `${bearWinRate.toString().padStart(9)}% | ` +
        `${avgMove.toString().padStart(7)} pts`
      );
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('SYMMETRIC TARGET ANALYSIS');
  console.log('Question: What % of signals reach X points before -X points?');
  console.log('='.repeat(80) + '\n');

  // Analyze MFE/MAE for imbalance signals
  const mfeMaeResults = [];
  const threshold = 0.10;

  for (let i = 0; i < candles.length - 60; i++) {
    const imb = imbalanceMap.get(candles[i].timestamp);
    if (!imb || imb.updates < 100) continue;
    if (Math.abs(imb.sizeImbalance) < threshold) continue;

    const direction = imb.sizeImbalance > 0 ? 1 : -1;
    const futureMove = calculateFutureMove(candles, i, 60);
    if (!futureMove) continue;

    mfeMaeResults.push({
      direction,
      move: futureMove.move * direction, // Normalized to signal direction
      maxFavorable: direction > 0 ? futureMove.maxUp : futureMove.maxDown,
      maxAdverse: direction > 0 ? futureMove.maxDown : futureMove.maxUp
    });
  }

  console.log(`Analyzed ${mfeMaeResults.length} imbalance signals (threshold: ${threshold})\n`);
  console.log('Target | % Hit Target First | % Hit Stop First | Expectancy');
  console.log('-'.repeat(60));

  for (const target of [10, 20, 30, 40, 50]) {
    let hitTarget = 0;
    let hitStop = 0;
    let neither = 0;

    for (const r of mfeMaeResults) {
      if (r.maxFavorable >= target && r.maxAdverse < target) {
        hitTarget++;
      } else if (r.maxAdverse >= target && r.maxFavorable < target) {
        hitStop++;
      } else if (r.maxFavorable >= target && r.maxAdverse >= target) {
        // Both hit - check which came first (approximate with final move)
        if (r.move > 0) hitTarget++;
        else hitStop++;
      } else {
        neither++;
      }
    }

    const total = mfeMaeResults.length;
    const targetPct = (hitTarget / total * 100).toFixed(1);
    const stopPct = (hitStop / total * 100).toFixed(1);
    const winRate = hitTarget / (hitTarget + hitStop);
    const expectancy = (winRate * target - (1 - winRate) * target).toFixed(2);

    console.log(
      `${String(target).padStart(6)} pts | ` +
      `${targetPct.padStart(18)}% | ` +
      `${stopPct.padStart(16)}% | ` +
      `${expectancy.padStart(10)} pts`
    );
  }

  console.log('\n=== Analysis Complete ===');
}

main().catch(console.error);
