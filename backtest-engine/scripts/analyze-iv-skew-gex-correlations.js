#!/usr/bin/env node
/**
 * IV-Skew-GEX Loser Correlation Analysis
 *
 * Comprehensive analysis to identify patterns that distinguish losing trades from winners
 * in the IV-Skew-GEX strategy.
 *
 * Usage: node scripts/analyze-iv-skew-gex-correlations.js [results-file]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { GexLoader } from '../src/data-loaders/gex-loader.js';
import { IVLoader } from '../src/data-loaders/iv-loader.js';

// ============================================================================
// Configuration
// ============================================================================

const resultsPath = process.argv[2] || 'results/iv_skew_gex_1m.json';
const dataDir = path.resolve(process.cwd(), 'data');

// ============================================================================
// Statistical Functions
// ============================================================================

/**
 * Welch's t-test for unequal variances
 */
function welchTTest(arr1, arr2) {
  if (arr1.length < 2 || arr2.length < 2) return { t: NaN, p: NaN, significant: false };

  const mean1 = arr1.reduce((s, v) => s + v, 0) / arr1.length;
  const mean2 = arr2.reduce((s, v) => s + v, 0) / arr2.length;

  const var1 = arr1.reduce((s, v) => s + (v - mean1) ** 2, 0) / (arr1.length - 1);
  const var2 = arr2.reduce((s, v) => s + (v - mean2) ** 2, 0) / (arr2.length - 1);

  const se1 = var1 / arr1.length;
  const se2 = var2 / arr2.length;
  const se = Math.sqrt(se1 + se2);

  if (se === 0) return { t: 0, p: 1, significant: false };

  const t = (mean1 - mean2) / se;

  // Welch-Satterthwaite degrees of freedom
  const df = (se1 + se2) ** 2 / ((se1 ** 2) / (arr1.length - 1) + (se2 ** 2) / (arr2.length - 1));

  // Approximate p-value using t-distribution (two-tailed)
  const p = tDistributionPValue(Math.abs(t), df);

  return {
    t: t,
    p: p,
    significant: p < 0.05,
    highlySignificant: p < 0.01,
    veryHighlySignificant: p < 0.001
  };
}

/**
 * Approximate p-value from t-distribution
 */
function tDistributionPValue(t, df) {
  // Using approximation for large df
  if (df > 100) {
    // Normal approximation
    return 2 * (1 - normalCDF(Math.abs(t)));
  }

  // Beta function approximation for smaller df
  const x = df / (df + t * t);
  const a = df / 2;
  const b = 0.5;

  // Incomplete beta function approximation
  const p = incompleteBeta(x, a, b);
  return p;
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
 * Incomplete beta function approximation
 */
function incompleteBeta(x, a, b) {
  if (x === 0) return 0;
  if (x === 1) return 1;

  // Continued fraction approximation
  const bt = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) +
    a * Math.log(x) + b * Math.log(1 - x)
  );

  if (x < (a + 1) / (a + b + 2)) {
    return bt * betaCF(x, a, b) / a;
  } else {
    return 1 - bt * betaCF(1 - x, b, a) / b;
  }
}

/**
 * Continued fraction for beta function
 */
function betaCF(x, a, b) {
  const maxIterations = 100;
  const epsilon = 1e-10;

  let am = 1, bm = 1, az = 1;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let bz = 1 - qab * x / qap;

  for (let m = 1; m <= maxIterations; m++) {
    const em = m;
    const tem = em + em;
    let d = em * (b - m) * x / ((qam + tem) * (a + tem));
    const ap = az + d * am;
    const bp = bz + d * bm;
    d = -(a + em) * (qab + em) * x / ((a + tem) * (qap + tem));
    const app = ap + d * az;
    const bpp = bp + d * bz;
    const aold = az;
    am = ap / bpp;
    bm = bp / bpp;
    az = app / bpp;
    bz = 1;
    if (Math.abs(az - aold) < epsilon * Math.abs(az)) {
      return az;
    }
  }
  return az;
}

/**
 * Log gamma function approximation
 */
function lnGamma(x) {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5
  ];

  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;

  for (let j = 0; j < 6; j++) {
    ser += c[j] / ++y;
  }

  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

/**
 * Cohen's d effect size
 */
function cohensD(arr1, arr2) {
  if (arr1.length < 2 || arr2.length < 2) return NaN;

  const mean1 = arr1.reduce((s, v) => s + v, 0) / arr1.length;
  const mean2 = arr2.reduce((s, v) => s + v, 0) / arr2.length;

  const var1 = arr1.reduce((s, v) => s + (v - mean1) ** 2, 0) / (arr1.length - 1);
  const var2 = arr2.reduce((s, v) => s + (v - mean2) ** 2, 0) / (arr2.length - 1);

  // Pooled standard deviation
  const pooledSD = Math.sqrt(((arr1.length - 1) * var1 + (arr2.length - 1) * var2) / (arr1.length + arr2.length - 2));

  if (pooledSD === 0) return 0;
  return (mean1 - mean2) / pooledSD;
}

/**
 * Chi-squared test for categorical variables
 */
function chiSquaredTest(observed) {
  // observed is a 2D array: [[win_cat1, lose_cat1], [win_cat2, lose_cat2], ...]
  const rows = observed.length;
  if (rows < 2) return { chi2: NaN, p: NaN, significant: false };

  const rowSums = observed.map(row => row.reduce((s, v) => s + v, 0));
  const colSums = [0, 0];
  observed.forEach(row => {
    colSums[0] += row[0];
    colSums[1] += row[1];
  });
  const total = colSums[0] + colSums[1];

  if (total === 0) return { chi2: NaN, p: NaN, significant: false };

  let chi2 = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < 2; j++) {
      const expected = (rowSums[i] * colSums[j]) / total;
      if (expected > 0) {
        chi2 += (observed[i][j] - expected) ** 2 / expected;
      }
    }
  }

  const df = rows - 1;
  const p = 1 - chiSquaredCDF(chi2, df);

  return {
    chi2,
    p,
    df,
    significant: p < 0.05,
    highlySignificant: p < 0.01
  };
}

/**
 * Chi-squared CDF approximation
 */
function chiSquaredCDF(x, k) {
  return gammaCDF(x / 2, k / 2);
}

/**
 * Gamma CDF
 */
function gammaCDF(x, a) {
  if (x <= 0) return 0;
  if (x >= a + 40) return 1;

  return incompleteGamma(a, x);
}

/**
 * Incomplete gamma function
 */
function incompleteGamma(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;

  if (x < a + 1) {
    // Use series expansion
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 100; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < 1e-10 * Math.abs(sum)) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  } else {
    // Use continued fraction
    let f = 1, c = 1, d = 1 / (x - a + 1);
    let h = d;
    for (let i = 1; i < 100; i++) {
      const an = -i * (i - a);
      const bn = x - a + 1 + 2 * i;
      d = an * d + bn;
      if (Math.abs(d) < 1e-30) d = 1e-30;
      c = bn + an / c;
      if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-10) break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
  }
}

/**
 * Get significance markers
 */
function getSignificance(p) {
  if (p < 0.001) return '***';
  if (p < 0.01) return '**';
  if (p < 0.05) return '*';
  return '';
}

/**
 * Calculate basic statistics
 */
function calcStats(arr) {
  if (!arr || arr.length === 0) return { mean: NaN, std: NaN, min: NaN, max: NaN, median: NaN, count: 0 };

  const sorted = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  const std = Math.sqrt(variance);
  const median = arr.length % 2 === 0
    ? (sorted[arr.length / 2 - 1] + sorted[arr.length / 2]) / 2
    : sorted[Math.floor(arr.length / 2)];

  return {
    mean,
    std,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median,
    count: arr.length
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

function getHour(ts) { return new Date(ts).getUTCHours(); }
function getMinute(ts) { return new Date(ts).getUTCMinutes(); }
function getDayOfWeek(ts) { return new Date(ts).getUTCDay(); }
function formatDate(ts) { return new Date(ts).toISOString().split('T')[0]; }
function formatTime(ts) {
  const d = new Date(ts);
  return `${d.getUTCHours().toString().padStart(2,'0')}:${d.getUTCMinutes().toString().padStart(2,'0')}`;
}

function utcToEST(utcHour) {
  return (utcHour - 5 + 24) % 24;
}

const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function printSeparator(title) {
  console.log('\n' + '═'.repeat(80));
  console.log(title);
  console.log('═'.repeat(80));
}

function printSubsection(title) {
  console.log('\n' + '─'.repeat(60));
  console.log(title);
  console.log('─'.repeat(60));
}

/**
 * Format a comparison table row
 */
function formatRow(label, winVal, loseVal, tResult = null, effectSize = null) {
  const winStr = typeof winVal === 'number' ? winVal.toFixed(3) : winVal;
  const loseStr = typeof loseVal === 'number' ? loseVal.toFixed(3) : loseVal;
  let sig = '';
  let d = '';

  if (tResult && !isNaN(tResult.p)) {
    sig = getSignificance(tResult.p);
  }
  if (effectSize !== null && !isNaN(effectSize)) {
    d = `(d=${effectSize.toFixed(2)})`;
  }

  return `${label.padEnd(25)} │ ${String(winStr).padStart(12)} │ ${String(loseStr).padStart(12)} │ ${sig.padStart(3)} ${d}`;
}

// ============================================================================
// OHLCV Loader for Price Action Analysis
// ============================================================================

/**
 * Filter candles to use only the primary (most liquid) contract for each time period
 * This is critical for handling contract rollovers properly
 *
 * @param {Object[]} candles - Array of candle objects
 * @returns {Object[]} Filtered array with only primary contract candles
 */
function filterPrimaryContract(candles) {
  if (candles.length === 0) return candles;

  // Group candles by day and hour to detect contract transitions
  const contractVolumes = new Map();
  const result = [];

  // Calculate volume per contract symbol per hour
  candles.forEach(candle => {
    const hourKey = Math.floor(candle.timestamp / (60 * 60 * 1000)); // Hour buckets
    const symbol = candle.symbol;

    if (!contractVolumes.has(hourKey)) {
      contractVolumes.set(hourKey, new Map());
    }

    const hourData = contractVolumes.get(hourKey);
    const currentVol = hourData.get(symbol) || 0;
    hourData.set(symbol, currentVol + (candle.volume || 0));
  });

  // For each candle, check if it belongs to the primary contract for that time
  candles.forEach(candle => {
    const hourKey = Math.floor(candle.timestamp / (60 * 60 * 1000));
    const hourData = contractVolumes.get(hourKey);

    if (!hourData) {
      result.push(candle);
      return;
    }

    // Find the symbol with highest volume for this hour
    let primarySymbol = '';
    let maxVolume = 0;

    for (const [symbol, volume] of hourData.entries()) {
      if (volume > maxVolume) {
        maxVolume = volume;
        primarySymbol = symbol;
      }
    }

    // Only include candles from the primary contract
    if (candle.symbol === primarySymbol) {
      result.push(candle);
    }
  });

  return result;
}

async function loadOHLCV(startDate, endDate) {
  const ohlcvPath = path.join(dataDir, 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');

  if (!fs.existsSync(ohlcvPath)) {
    console.warn(`OHLCV file not found: ${ohlcvPath}`);
    return new Map();
  }

  const rawCandles = [];

  return new Promise((resolve, reject) => {
    let headers = null;
    const stream = fs.createReadStream(ohlcvPath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!headers) {
        headers = line.split(',');
        return;
      }

      const values = line.split(',');
      const record = {};
      headers.forEach((h, i) => record[h] = values[i]);

      const timestamp = new Date(record.ts_event).getTime();
      const date = new Date(timestamp);

      // Filter by date range
      if (date < startDate || date > endDate) return;

      // Filter out calendar spreads (contain dash in symbol)
      if (record.symbol && record.symbol.includes('-')) return;

      rawCandles.push({
        timestamp,
        symbol: record.symbol,
        open: parseFloat(record.open),
        high: parseFloat(record.high),
        low: parseFloat(record.low),
        close: parseFloat(record.close),
        volume: parseInt(record.volume)
      });
    });

    rl.on('close', () => {
      // Apply primary contract filtering to handle rollovers
      const filteredCandles = filterPrimaryContract(rawCandles);

      // Convert to Map for fast lookup
      const candles = new Map();
      filteredCandles.forEach(c => candles.set(c.timestamp, c));

      console.log(`Loaded ${candles.size} OHLCV candles (filtered from ${rawCandles.length} raw, excluding calendar spreads)`);
      resolve(candles);
    });

    rl.on('error', reject);
  });
}

/**
 * Get candles during a trade
 */
function getCandlesDuringTrade(candles, entryTime, exitTime) {
  const result = [];
  const sortedTimestamps = Array.from(candles.keys()).sort((a, b) => a - b);

  for (const ts of sortedTimestamps) {
    if (ts >= entryTime && ts <= exitTime) {
      result.push(candles.get(ts));
    }
    if (ts > exitTime) break;
  }

  return result;
}

/**
 * Calculate MAE (Max Adverse Excursion) and MFE (Max Favorable Excursion)
 */
function calculateMAEMFE(trade, candles) {
  const tradeCandles = getCandlesDuringTrade(candles, trade.entryTime, trade.exitTime);

  if (tradeCandles.length === 0) {
    return { mae: 0, mfe: 0, barsToMAE: 0, barsToMFE: 0 };
  }

  const entryPrice = trade.actualEntry;
  const isLong = trade.side === 'long';

  let mae = 0; // Max loss
  let mfe = 0; // Max profit
  let barsToMAE = 0;
  let barsToMFE = 0;

  for (let i = 0; i < tradeCandles.length; i++) {
    const candle = tradeCandles[i];

    // For longs: adverse = low below entry, favorable = high above entry
    // For shorts: adverse = high above entry, favorable = low below entry
    const adverse = isLong
      ? entryPrice - candle.low
      : candle.high - entryPrice;

    const favorable = isLong
      ? candle.high - entryPrice
      : entryPrice - candle.low;

    if (adverse > mae) {
      mae = adverse;
      barsToMAE = i + 1;
    }

    if (favorable > mfe) {
      mfe = favorable;
      barsToMFE = i + 1;
    }
  }

  return { mae, mfe, barsToMAE, barsToMFE };
}

/**
 * Calculate volume statistics during trade
 */
function calculateVolumeStats(trade, candles) {
  const tradeCandles = getCandlesDuringTrade(candles, trade.entryTime, trade.exitTime);

  if (tradeCandles.length === 0) {
    return { avgVolume: 0, entryVolume: 0, volumeRatio: 1 };
  }

  const volumes = tradeCandles.map(c => c.volume);
  const avgVolume = volumes.reduce((s, v) => s + v, 0) / volumes.length;
  const entryVolume = tradeCandles[0]?.volume || 0;

  return {
    avgVolume,
    entryVolume,
    volumeRatio: avgVolume > 0 ? entryVolume / avgVolume : 1
  };
}

// ============================================================================
// Analysis Functions
// ============================================================================

function analyzeAtEntryCorrelations(trades, winners, losers) {
  printSeparator('1. AT-ENTRY CORRELATIONS');

  console.log('\nComparing Winners vs Losers at entry time');
  console.log('─'.repeat(75));
  console.log(`${'Factor'.padEnd(25)} │ ${'Winners'.padStart(12)} │ ${'Losers'.padStart(12)} │ Significance`);
  console.log('─'.repeat(75));

  // IV Skew Magnitude
  const winSkews = winners.map(t => t.signal.ivSkew);
  const loseSkews = losers.map(t => t.signal.ivSkew);
  const skewTest = welchTTest(winSkews, loseSkews);
  const skewD = cohensD(winSkews, loseSkews);
  console.log(formatRow('IV Skew', calcStats(winSkews).mean, calcStats(loseSkews).mean, skewTest, skewD));

  // Absolute IV Skew
  const winAbsSkews = winners.map(t => Math.abs(t.signal.ivSkew));
  const loseAbsSkews = losers.map(t => Math.abs(t.signal.ivSkew));
  const absSkewTest = welchTTest(winAbsSkews, loseAbsSkews);
  const absSkewD = cohensD(winAbsSkews, loseAbsSkews);
  console.log(formatRow('|IV Skew| (magnitude)', calcStats(winAbsSkews).mean, calcStats(loseAbsSkews).mean, absSkewTest, absSkewD));

  // Level Distance
  const winDists = winners.map(t => t.signal.levelDistance);
  const loseDists = losers.map(t => t.signal.levelDistance);
  const distTest = welchTTest(winDists, loseDists);
  const distD = cohensD(winDists, loseDists);
  console.log(formatRow('Level Distance (pts)', calcStats(winDists).mean, calcStats(loseDists).mean, distTest, distD));

  // ATM IV Level
  const winIVs = winners.map(t => t.signal.ivValue);
  const loseIVs = losers.map(t => t.signal.ivValue);
  const ivTest = welchTTest(winIVs, loseIVs);
  const ivD = cohensD(winIVs, loseIVs);
  console.log(formatRow('ATM IV', calcStats(winIVs).mean, calcStats(loseIVs).mean, ivTest, ivD));

  // Call IV
  const winCallIVs = winners.map(t => t.signal.callIV);
  const loseCallIVs = losers.map(t => t.signal.callIV);
  const callIVTest = welchTTest(winCallIVs, loseCallIVs);
  const callIVD = cohensD(winCallIVs, loseCallIVs);
  console.log(formatRow('Call IV', calcStats(winCallIVs).mean, calcStats(loseCallIVs).mean, callIVTest, callIVD));

  // Put IV
  const winPutIVs = winners.map(t => t.signal.putIV);
  const losePutIVs = losers.map(t => t.signal.putIV);
  const putIVTest = welchTTest(winPutIVs, losePutIVs);
  const putIVD = cohensD(winPutIVs, losePutIVs);
  console.log(formatRow('Put IV', calcStats(winPutIVs).mean, calcStats(losePutIVs).mean, putIVTest, putIVD));

  console.log('─'.repeat(75));
  console.log('Significance: * p<0.05, ** p<0.01, *** p<0.001');

  // Level Type Analysis
  printSubsection('Level Type Performance');

  const levelTypes = [...new Set(trades.map(t => t.signal.levelType))].sort();
  const levelStats = [];

  console.log(`${'Level'.padEnd(12)} │ ${'Winners'.padStart(8)} │ ${'Losers'.padStart(8)} │ ${'Win Rate'.padStart(10)} │ ${'Avg P&L'.padStart(10)}`);
  console.log('─'.repeat(60));

  levelTypes.forEach(level => {
    const levelTrades = trades.filter(t => t.signal.levelType === level);
    const levelWins = levelTrades.filter(t => t.netPnL > 0).length;
    const levelLosses = levelTrades.filter(t => t.netPnL < 0).length;
    const avgPnL = levelTrades.reduce((s, t) => s + t.netPnL, 0) / levelTrades.length;
    const winRate = levelWins / levelTrades.length * 100;

    levelStats.push({ level, wins: levelWins, losses: levelLosses, winRate, avgPnL, total: levelTrades.length });

    console.log(`${level.padEnd(12)} │ ${String(levelWins).padStart(8)} │ ${String(levelLosses).padStart(8)} │ ${winRate.toFixed(1).padStart(9)}% │ $${avgPnL.toFixed(0).padStart(9)}`);
  });

  // Chi-squared test for level types
  const levelObserved = levelStats.map(s => [s.wins, s.losses]);
  const chiTest = chiSquaredTest(levelObserved);
  console.log(`\nChi-squared test: χ²=${chiTest.chi2.toFixed(2)}, df=${chiTest.df}, p=${chiTest.p.toFixed(4)} ${getSignificance(chiTest.p)}`);

  // Side Analysis
  printSubsection('Side Performance (Long vs Short)');

  const sides = ['long', 'short'];
  console.log(`${'Side'.padEnd(10)} │ ${'Winners'.padStart(8)} │ ${'Losers'.padStart(8)} │ ${'Win Rate'.padStart(10)} │ ${'Avg P&L'.padStart(10)}`);
  console.log('─'.repeat(60));

  sides.forEach(side => {
    const sideTrades = trades.filter(t => t.side === side);
    const sideWins = sideTrades.filter(t => t.netPnL > 0).length;
    const sideLosses = sideTrades.filter(t => t.netPnL < 0).length;
    const avgPnL = sideTrades.reduce((s, t) => s + t.netPnL, 0) / sideTrades.length;
    const winRate = sideWins / sideTrades.length * 100;

    console.log(`${side.padEnd(10)} │ ${String(sideWins).padStart(8)} │ ${String(sideLosses).padStart(8)} │ ${winRate.toFixed(1).padStart(9)}% │ $${avgPnL.toFixed(0).padStart(9)}`);
  });

  return {
    skewTest,
    distTest,
    ivTest,
    levelStats,
    chiTest
  };
}

async function analyzePostEntryDynamics(trades, winners, losers, gexLoader, ivLoader) {
  printSeparator('2. POST-ENTRY DYNAMICS');

  console.log('\nAnalyzing IV skew and GEX changes during trades...');

  const winnerDynamics = [];
  const loserDynamics = [];

  for (const trade of trades) {
    const entryGex = gexLoader.getGexLevels(new Date(trade.entryTime));
    const exitGex = gexLoader.getGexLevels(new Date(trade.exitTime));
    const entryIV = ivLoader.getIVAtTime(trade.entryTime);
    const exitIV = ivLoader.getIVAtTime(trade.exitTime);

    if (!entryGex || !exitGex || !entryIV || !exitIV) continue;

    const dynamics = {
      trade,
      // IV changes
      ivSkewChange: exitIV.skew - entryIV.skew,
      ivChange: exitIV.iv - entryIV.iv,
      callIVChange: exitIV.callIV - entryIV.callIV,
      putIVChange: exitIV.putIV - entryIV.putIV,
      // GEX changes
      totalGexChange: exitGex.total_gex - entryGex.total_gex,
      regimeAtEntry: entryGex.regime,
      regimeAtExit: exitGex.regime,
      regimeChanged: entryGex.regime !== exitGex.regime,
      // Level movements
      putWallChange: (exitGex.put_wall || 0) - (entryGex.put_wall || 0),
      callWallChange: (exitGex.call_wall || 0) - (entryGex.call_wall || 0),
      // Position relative to gamma flip
      gammaFlipAtEntry: entryGex.gamma_flip,
      gammaFlipAtExit: exitGex.gamma_flip,
      aboveGFAtEntry: entryGex.gamma_flip ? trade.actualEntry > entryGex.gamma_flip : null,
      aboveGFAtExit: exitGex.gamma_flip ? trade.actualExit > exitGex.gamma_flip : null
    };

    // Skew alignment: did skew move with or against trade direction?
    // For longs: we want skew to decrease (less fear)
    // For shorts: we want skew to increase (more fear)
    const skewAligned = trade.side === 'long'
      ? dynamics.ivSkewChange < 0
      : dynamics.ivSkewChange > 0;
    dynamics.skewAligned = skewAligned;

    if (trade.netPnL > 0) {
      winnerDynamics.push(dynamics);
    } else {
      loserDynamics.push(dynamics);
    }
  }

  console.log(`\nAnalyzed ${winnerDynamics.length} winners and ${loserDynamics.length} losers with IV/GEX data`);

  printSubsection('IV Skew Change During Trade');

  console.log(`${'Metric'.padEnd(25)} │ ${'Winners'.padStart(12)} │ ${'Losers'.padStart(12)} │ Significance`);
  console.log('─'.repeat(75));

  // IV Skew Change
  const winSkewChanges = winnerDynamics.map(d => d.ivSkewChange);
  const loseSkewChanges = loserDynamics.map(d => d.ivSkewChange);
  const skewChangeTest = welchTTest(winSkewChanges, loseSkewChanges);
  const skewChangeD = cohensD(winSkewChanges, loseSkewChanges);
  console.log(formatRow('IV Skew Change', calcStats(winSkewChanges).mean, calcStats(loseSkewChanges).mean, skewChangeTest, skewChangeD));

  // ATM IV Change
  const winIVChanges = winnerDynamics.map(d => d.ivChange);
  const loseIVChanges = loserDynamics.map(d => d.ivChange);
  const ivChangeTest = welchTTest(winIVChanges, loseIVChanges);
  const ivChangeD = cohensD(winIVChanges, loseIVChanges);
  console.log(formatRow('ATM IV Change', calcStats(winIVChanges).mean, calcStats(loseIVChanges).mean, ivChangeTest, ivChangeD));

  // Skew Alignment Rate
  const winAlignedRate = winnerDynamics.filter(d => d.skewAligned).length / winnerDynamics.length;
  const loseAlignedRate = loserDynamics.filter(d => d.skewAligned).length / loserDynamics.length;
  console.log(formatRow('Skew Aligned %', (winAlignedRate * 100).toFixed(1) + '%', (loseAlignedRate * 100).toFixed(1) + '%'));

  printSubsection('GEX Dynamics During Trade');

  // GEX Change
  const winGexChanges = winnerDynamics.map(d => d.totalGexChange);
  const loseGexChanges = loserDynamics.map(d => d.totalGexChange);
  const gexChangeTest = welchTTest(winGexChanges, loseGexChanges);
  console.log(formatRow('Total GEX Change', calcStats(winGexChanges).mean.toExponential(2), calcStats(loseGexChanges).mean.toExponential(2), gexChangeTest));

  // Put Wall Change
  const winPWChanges = winnerDynamics.map(d => d.putWallChange);
  const losePWChanges = loserDynamics.map(d => d.putWallChange);
  const pwChangeTest = welchTTest(winPWChanges, losePWChanges);
  console.log(formatRow('Put Wall Change (pts)', calcStats(winPWChanges).mean, calcStats(losePWChanges).mean, pwChangeTest));

  // Call Wall Change
  const winCWChanges = winnerDynamics.map(d => d.callWallChange);
  const loseCWChanges = loserDynamics.map(d => d.callWallChange);
  const cwChangeTest = welchTTest(winCWChanges, loseCWChanges);
  console.log(formatRow('Call Wall Change (pts)', calcStats(winCWChanges).mean, calcStats(loseCWChanges).mean, cwChangeTest));

  // Regime Change Rate
  const winRegimeChangeRate = winnerDynamics.filter(d => d.regimeChanged).length / winnerDynamics.length;
  const loseRegimeChangeRate = loserDynamics.filter(d => d.regimeChanged).length / loserDynamics.length;
  console.log(formatRow('Regime Changed %', (winRegimeChangeRate * 100).toFixed(1) + '%', (loseRegimeChangeRate * 100).toFixed(1) + '%'));

  console.log('─'.repeat(75));

  return {
    winnerDynamics,
    loserDynamics,
    skewChangeTest: { ...skewChangeTest, effectSize: Math.abs(skewChangeD) },
    ivChangeTest,
    gexChangeTest
  };
}

async function analyzePriceAction(trades, winners, losers, candles) {
  printSeparator('3. PRICE ACTION ANALYSIS (MAE/MFE)');

  const winnerMAE = [];
  const loserMAE = [];
  const winnerMFE = [];
  const loserMFE = [];
  const winnerBarsToMAE = [];
  const loserBarsToMAE = [];
  const winnerBarsToMFE = [];
  const loserBarsToMFE = [];

  let losersWithHighMFE = 0;

  for (const trade of trades) {
    const { mae, mfe, barsToMAE, barsToMFE } = calculateMAEMFE(trade, candles);

    if (trade.netPnL > 0) {
      winnerMAE.push(mae);
      winnerMFE.push(mfe);
      winnerBarsToMAE.push(barsToMAE);
      winnerBarsToMFE.push(barsToMFE);
    } else {
      loserMAE.push(mae);
      loserMFE.push(mfe);
      loserBarsToMAE.push(barsToMAE);
      loserBarsToMFE.push(barsToMFE);

      // Track losers that had significant favorable excursion
      if (mfe >= 30) losersWithHighMFE++;
    }
  }

  console.log(`\nAnalyzed ${winnerMAE.length} winners and ${loserMAE.length} losers`);

  console.log(`\n${'Metric'.padEnd(25)} │ ${'Winners'.padStart(12)} │ ${'Losers'.padStart(12)} │ Significance`);
  console.log('─'.repeat(75));

  // MAE
  const maeTest = welchTTest(winnerMAE, loserMAE);
  const maeD = cohensD(winnerMAE, loserMAE);
  console.log(formatRow('MAE (points)', calcStats(winnerMAE).mean, calcStats(loserMAE).mean, maeTest, maeD));

  // MFE
  const mfeTest = welchTTest(winnerMFE, loserMFE);
  const mfeD = cohensD(winnerMFE, loserMFE);
  console.log(formatRow('MFE (points)', calcStats(winnerMFE).mean, calcStats(loserMFE).mean, mfeTest, mfeD));

  // Bars to MAE
  const barsMAETest = welchTTest(winnerBarsToMAE, loserBarsToMAE);
  const barsMAED = cohensD(winnerBarsToMAE, loserBarsToMAE);
  console.log(formatRow('Bars to MAE', calcStats(winnerBarsToMAE).mean, calcStats(loserBarsToMAE).mean, barsMAETest, barsMAED));

  // Bars to MFE
  const barsMFETest = welchTTest(winnerBarsToMFE, loserBarsToMFE);
  const barsMFED = cohensD(winnerBarsToMFE, loserBarsToMFE);
  console.log(formatRow('Bars to MFE', calcStats(winnerBarsToMFE).mean, calcStats(loserBarsToMFE).mean, barsMFETest, barsMFED));

  console.log('─'.repeat(75));

  printSubsection('Losers That Were Profitable');
  console.log(`\nLosers with MFE >= 30 points: ${losersWithHighMFE} (${(losersWithHighMFE / loserMAE.length * 100).toFixed(1)}%)`);
  console.log('These trades went significantly in favor before reversing.');

  // Fast reversals analysis
  const fastMAEWinners = winnerBarsToMAE.filter(b => b <= 5).length;
  const fastMAELosers = loserBarsToMAE.filter(b => b <= 5).length;

  printSubsection('Fast Reversals (MAE within 5 bars)');
  console.log(`Winners with fast MAE: ${fastMAEWinners} (${(fastMAEWinners / winnerBarsToMAE.length * 100).toFixed(1)}%)`);
  console.log(`Losers with fast MAE: ${fastMAELosers} (${(fastMAELosers / loserBarsToMAE.length * 100).toFixed(1)}%)`);

  return {
    maeTest, mfeTest,
    barsToMAETest: { ...barsMAETest, effectSize: Math.abs(barsMAED) },
    barsToMFETest: { ...barsMFETest, effectSize: Math.abs(barsMFED) },
    losersWithHighMFE,
    winnerMAE, loserMAE,
    winnerMFE, loserMFE,
    winnerBarsToMAE, loserBarsToMAE,
    winnerBarsToMFE, loserBarsToMFE
  };
}

function analyzeTemporalPatterns(trades, winners, losers) {
  printSeparator('4. TEMPORAL PATTERNS');

  // Hour of day analysis
  printSubsection('Performance by Hour (UTC → EST)');

  const hourStats = {};
  for (let h = 13; h <= 21; h++) {
    const hourTrades = trades.filter(t => getHour(t.entryTime) === h);
    if (hourTrades.length === 0) continue;

    const wins = hourTrades.filter(t => t.netPnL > 0).length;
    const losses = hourTrades.filter(t => t.netPnL < 0).length;
    const totalPnL = hourTrades.reduce((s, t) => s + t.netPnL, 0);

    hourStats[h] = { wins, losses, total: hourTrades.length, totalPnL, winRate: wins / hourTrades.length };
  }

  console.log(`${'Hour (UTC→EST)'.padEnd(15)} │ ${'Wins'.padStart(6)} │ ${'Losses'.padStart(6)} │ ${'Win Rate'.padStart(10)} │ ${'Total P&L'.padStart(12)}`);
  console.log('─'.repeat(60));

  Object.entries(hourStats).sort((a, b) => parseInt(a[0]) - parseInt(b[0])).forEach(([h, s]) => {
    const estHour = utcToEST(parseInt(h));
    console.log(`${String(h).padStart(2)}:00 → ${String(estHour).padStart(2)}:00 EST │ ${String(s.wins).padStart(6)} │ ${String(s.losses).padStart(6)} │ ${(s.winRate * 100).toFixed(1).padStart(9)}% │ $${s.totalPnL.toFixed(0).padStart(11)}`);
  });

  // Day of week analysis
  printSubsection('Performance by Day of Week');

  const dayStats = {};
  for (let d = 0; d < 7; d++) {
    const dayTrades = trades.filter(t => getDayOfWeek(t.entryTime) === d);
    if (dayTrades.length === 0) continue;

    const wins = dayTrades.filter(t => t.netPnL > 0).length;
    const losses = dayTrades.filter(t => t.netPnL < 0).length;
    const totalPnL = dayTrades.reduce((s, t) => s + t.netPnL, 0);

    dayStats[d] = { wins, losses, total: dayTrades.length, totalPnL, winRate: wins / dayTrades.length };
  }

  console.log(`${'Day'.padEnd(10)} │ ${'Wins'.padStart(6)} │ ${'Losses'.padStart(6)} │ ${'Win Rate'.padStart(10)} │ ${'Total P&L'.padStart(12)}`);
  console.log('─'.repeat(55));

  Object.entries(dayStats).sort((a, b) => parseInt(a[0]) - parseInt(b[0])).forEach(([d, s]) => {
    console.log(`${dayNames[parseInt(d)].padEnd(10)} │ ${String(s.wins).padStart(6)} │ ${String(s.losses).padStart(6)} │ ${(s.winRate * 100).toFixed(1).padStart(9)}% │ $${s.totalPnL.toFixed(0).padStart(11)}`);
  });

  // Duration analysis
  printSubsection('Trade Duration Analysis');

  const winDurations = winners.map(t => t.barsSinceEntry);
  const loseDurations = losers.map(t => t.barsSinceEntry);

  console.log(`${'Metric'.padEnd(25)} │ ${'Winners'.padStart(12)} │ ${'Losers'.padStart(12)} │ Significance`);
  console.log('─'.repeat(75));

  const durationTest = welchTTest(winDurations, loseDurations);
  const durationD = cohensD(winDurations, loseDurations);
  console.log(formatRow('Avg Duration (bars)', calcStats(winDurations).mean, calcStats(loseDurations).mean, durationTest, durationD));
  console.log(formatRow('Median Duration', calcStats(winDurations).median, calcStats(loseDurations).median));
  console.log(formatRow('Max Duration', calcStats(winDurations).max, calcStats(loseDurations).max));

  return { hourStats, dayStats, durationTest };
}

function analyzeTimeInTradeRisk(trades, winners, losers) {
  printSeparator('5. TIME-IN-TRADE RISK EXPOSURE ANALYSIS');

  console.log('\nKey insight: Time in trade = increased risk exposure. Faster in/out = better.');

  // Duration distribution by outcome
  printSubsection('Duration Buckets by Outcome');

  const buckets = [
    { name: '0-5 bars', min: 0, max: 5 },
    { name: '5-15 bars', min: 5, max: 15 },
    { name: '15-30 bars', min: 15, max: 30 },
    { name: '30-45 bars', min: 30, max: 45 },
    { name: '45-60 bars', min: 45, max: 60 }
  ];

  console.log(`${'Duration'.padEnd(15)} │ ${'Winners'.padStart(8)} │ ${'Losers'.padStart(8)} │ ${'Win Rate'.padStart(10)} │ ${'Avg P&L'.padStart(10)}`);
  console.log('─'.repeat(60));

  buckets.forEach(bucket => {
    const bucketTrades = trades.filter(t => t.barsSinceEntry >= bucket.min && t.barsSinceEntry < bucket.max);
    if (bucketTrades.length === 0) return;

    const bucketWins = bucketTrades.filter(t => t.netPnL > 0).length;
    const bucketLosses = bucketTrades.filter(t => t.netPnL < 0).length;
    const avgPnL = bucketTrades.reduce((s, t) => s + t.netPnL, 0) / bucketTrades.length;
    const winRate = bucketWins / bucketTrades.length * 100;

    console.log(`${bucket.name.padEnd(15)} │ ${String(bucketWins).padStart(8)} │ ${String(bucketLosses).padStart(8)} │ ${winRate.toFixed(1).padStart(9)}% │ $${avgPnL.toFixed(0).padStart(9)}`);
  });

  // Exit reason analysis
  printSubsection('Exit Reason Analysis');

  const exitReasons = [...new Set(trades.map(t => t.exitReason))];

  console.log(`${'Exit Reason'.padEnd(18)} │ ${'Count'.padStart(8)} │ ${'Winners'.padStart(8)} │ ${'Losers'.padStart(8)} │ ${'Win Rate'.padStart(10)}`);
  console.log('─'.repeat(65));

  exitReasons.forEach(reason => {
    const reasonTrades = trades.filter(t => t.exitReason === reason);
    const reasonWins = reasonTrades.filter(t => t.netPnL > 0).length;
    const reasonLosses = reasonTrades.filter(t => t.netPnL < 0).length;
    const winRate = reasonWins / reasonTrades.length * 100;

    console.log(`${reason.padEnd(18)} │ ${String(reasonTrades.length).padStart(8)} │ ${String(reasonWins).padStart(8)} │ ${String(reasonLosses).padStart(8)} │ ${winRate.toFixed(1).padStart(9)}%`);
  });

  // Time-based stop tightening simulation
  printSubsection('TRAILING STOP TIGHTENING SIMULATION');

  console.log('\nSimulating effect of tightening stops over time...');

  const stopLossTrades = losers.filter(t => t.exitReason === 'stop_loss');
  const takeProfitTrades = winners.filter(t => t.exitReason === 'take_profit');

  const simulations = [
    { bars: 15, tighten: 10 },
    { bars: 20, tighten: 10 },
    { bars: 25, tighten: 10 },
    { bars: 30, tighten: 15 },
    { bars: 30, tighten: 20 },
    { bars: 45, tighten: 20 }
  ];

  console.log(`\n${'Scenario'.padEnd(35)} │ ${'Losers Cut'.padStart(12)} │ ${'Winners Hurt'.padStart(12)} │ ${'Net Trades'.padStart(12)}`);
  console.log('─'.repeat(80));

  simulations.forEach(sim => {
    // Losers that held longer than threshold
    const losersHeldLonger = stopLossTrades.filter(t => t.barsSinceEntry >= sim.bars).length;

    // Winners that might have been stopped out with tighter stop
    // This is an approximation - we assume some winners had drawdowns
    const winnersAtRisk = takeProfitTrades.filter(t => t.barsSinceEntry >= sim.bars).length;
    // Estimate ~10-20% of these might be affected
    const winnersHurt = Math.round(winnersAtRisk * 0.15);

    const scenario = `At ${sim.bars} bars, tighten ${sim.tighten}pts`;
    const netTrades = losersHeldLonger - winnersHurt;

    console.log(`${scenario.padEnd(35)} │ ${String(losersHeldLonger).padStart(12)} │ ${String(winnersHurt).padStart(12)} │ ${(netTrades > 0 ? '+' : '') + netTrades.toString().padStart(11)}`);
  });

  console.log('\n* Winners Hurt is estimated at 15% of winners held past threshold');
  console.log('* Net positive = would improve strategy');

  return { buckets, stopLossTrades, takeProfitTrades };
}

async function analyzeVolume(trades, winners, losers, candles) {
  printSeparator('6. VOLUME ANALYSIS');

  const winnerVolStats = [];
  const loserVolStats = [];

  for (const trade of trades) {
    const volStats = calculateVolumeStats(trade, candles);

    if (trade.netPnL > 0) {
      winnerVolStats.push(volStats);
    } else {
      loserVolStats.push(volStats);
    }
  }

  if (winnerVolStats.length === 0 || loserVolStats.length === 0) {
    console.log('\nInsufficient volume data for analysis');
    return {};
  }

  console.log(`\n${'Metric'.padEnd(25)} │ ${'Winners'.padStart(12)} │ ${'Losers'.padStart(12)} │ Significance`);
  console.log('─'.repeat(75));

  // Entry Volume
  const winEntryVols = winnerVolStats.map(v => v.entryVolume);
  const loseEntryVols = loserVolStats.map(v => v.entryVolume);
  const entryVolTest = welchTTest(winEntryVols, loseEntryVols);
  console.log(formatRow('Entry Candle Volume', calcStats(winEntryVols).mean, calcStats(loseEntryVols).mean, entryVolTest));

  // Average Volume During Trade
  const winAvgVols = winnerVolStats.map(v => v.avgVolume);
  const loseAvgVols = loserVolStats.map(v => v.avgVolume);
  const avgVolTest = welchTTest(winAvgVols, loseAvgVols);
  console.log(formatRow('Avg Volume During Trade', calcStats(winAvgVols).mean, calcStats(loseAvgVols).mean, avgVolTest));

  // Volume Ratio
  const winVolRatios = winnerVolStats.map(v => v.volumeRatio);
  const loseVolRatios = loserVolStats.map(v => v.volumeRatio);
  const volRatioTest = welchTTest(winVolRatios, loseVolRatios);
  console.log(formatRow('Entry/Avg Volume Ratio', calcStats(winVolRatios).mean, calcStats(loseVolRatios).mean, volRatioTest));

  console.log('─'.repeat(75));

  return { entryVolTest, avgVolTest, volRatioTest };
}

function analyzeConsecutiveTrades(trades, winners, losers) {
  printSeparator('7. CONSECUTIVE TRADE PATTERNS');

  // Streak analysis
  printSubsection('Streak Analysis');

  let currentStreak = 0;
  let maxWinStreak = 0;
  let maxLoseStreak = 0;
  const winStreaks = [];
  const loseStreaks = [];

  for (let i = 0; i < trades.length; i++) {
    const isWin = trades[i].netPnL > 0;
    const prevWin = i > 0 ? trades[i-1].netPnL > 0 : null;

    if (prevWin === null || isWin === prevWin) {
      currentStreak++;
    } else {
      // Streak ended
      if (prevWin) {
        winStreaks.push(currentStreak);
        maxWinStreak = Math.max(maxWinStreak, currentStreak);
      } else {
        loseStreaks.push(currentStreak);
        maxLoseStreak = Math.max(maxLoseStreak, currentStreak);
      }
      currentStreak = 1;
    }
  }
  // Don't forget the last streak
  if (trades.length > 0) {
    if (trades[trades.length - 1].netPnL > 0) {
      winStreaks.push(currentStreak);
      maxWinStreak = Math.max(maxWinStreak, currentStreak);
    } else {
      loseStreaks.push(currentStreak);
      maxLoseStreak = Math.max(maxLoseStreak, currentStreak);
    }
  }

  console.log(`Max Win Streak: ${maxWinStreak}`);
  console.log(`Max Lose Streak: ${maxLoseStreak}`);
  console.log(`Avg Win Streak: ${(winStreaks.reduce((s, v) => s + v, 0) / winStreaks.length).toFixed(1)}`);
  console.log(`Avg Lose Streak: ${(loseStreaks.reduce((s, v) => s + v, 0) / loseStreaks.length).toFixed(1)}`);

  // Post-loss recovery
  printSubsection('Post-Loss Recovery');

  let tradesAfterLoss = 0;
  let winsAfterLoss = 0;

  for (let i = 1; i < trades.length; i++) {
    if (trades[i-1].netPnL < 0) {
      tradesAfterLoss++;
      if (trades[i].netPnL > 0) winsAfterLoss++;
    }
  }

  const postLossWinRate = tradesAfterLoss > 0 ? winsAfterLoss / tradesAfterLoss : 0;
  const overallWinRate = winners.length / trades.length;

  console.log(`Trades immediately after a loss: ${tradesAfterLoss}`);
  console.log(`Wins after loss: ${winsAfterLoss} (${(postLossWinRate * 100).toFixed(1)}% win rate)`);
  console.log(`Overall win rate: ${(overallWinRate * 100).toFixed(1)}%`);
  console.log(`Difference: ${((postLossWinRate - overallWinRate) * 100).toFixed(1)} percentage points`);

  // Intraday clustering
  printSubsection('Intraday Loss Clustering');

  const losesByDate = {};
  losers.forEach(t => {
    const date = formatDate(t.entryTime);
    losesByDate[date] = (losesByDate[date] || 0) + 1;
  });

  const multiLossDays = Object.entries(losesByDate).filter(([d, c]) => c >= 2);

  console.log(`Days with 2+ losses: ${multiLossDays.length}`);
  console.log(`Days with single loss: ${Object.keys(losesByDate).length - multiLossDays.length}`);

  if (multiLossDays.length > 0) {
    console.log('\nDays with multiple losses:');
    multiLossDays.sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([date, count]) => {
      console.log(`  ${date}: ${count} losses`);
    });
  }

  return { maxWinStreak, maxLoseStreak, postLossWinRate, multiLossDays };
}

function generateFactorRanking(results) {
  printSeparator('8. FACTOR RANKING BY PREDICTIVE POWER');

  const factors = [];

  // Collect all factors with effect sizes and significance
  if (results.atEntry?.skewTest) {
    factors.push({
      name: 'IV Skew at Entry',
      effectSize: Math.abs(cohensD(
        results.trades.filter(t => t.netPnL > 0).map(t => t.signal.ivSkew),
        results.trades.filter(t => t.netPnL < 0).map(t => t.signal.ivSkew)
      )),
      pValue: results.atEntry.skewTest.p,
      direction: 'Lower skew → better'
    });
  }

  if (results.atEntry?.distTest) {
    factors.push({
      name: 'Level Distance',
      effectSize: Math.abs(cohensD(
        results.trades.filter(t => t.netPnL > 0).map(t => t.signal.levelDistance),
        results.trades.filter(t => t.netPnL < 0).map(t => t.signal.levelDistance)
      )),
      pValue: results.atEntry.distTest.p,
      direction: 'Varies by level type'
    });
  }

  if (results.temporal?.durationTest) {
    factors.push({
      name: 'Trade Duration',
      effectSize: Math.abs(cohensD(
        results.trades.filter(t => t.netPnL > 0).map(t => t.barsSinceEntry),
        results.trades.filter(t => t.netPnL < 0).map(t => t.barsSinceEntry)
      )),
      pValue: results.temporal.durationTest.p,
      direction: 'Shorter → better'
    });
  }

  if (results.priceAction?.maeTest) {
    factors.push({
      name: 'Max Adverse Excursion',
      effectSize: Math.abs(cohensD(results.priceAction.winnerMAE, results.priceAction.loserMAE)),
      pValue: results.priceAction.maeTest.p,
      direction: 'Lower MAE → better'
    });
  }

  if (results.priceAction?.mfeTest) {
    factors.push({
      name: 'Max Favorable Excursion',
      effectSize: Math.abs(cohensD(results.priceAction.winnerMFE, results.priceAction.loserMFE)),
      pValue: results.priceAction.mfeTest.p,
      direction: 'Higher MFE → better'
    });
  }

  // Add Bars to MAE and Bars to MFE if available
  if (results.priceAction?.barsToMAETest) {
    factors.push({
      name: 'Bars to MAE',
      effectSize: Math.abs(results.priceAction.barsToMAETest.effectSize || 0),
      pValue: results.priceAction.barsToMAETest.p,
      direction: 'Faster MAE → winner'
    });
  }

  if (results.priceAction?.barsToMFETest) {
    factors.push({
      name: 'Bars to MFE',
      effectSize: Math.abs(results.priceAction.barsToMFETest.effectSize || 0),
      pValue: results.priceAction.barsToMFETest.p,
      direction: 'Faster MFE → winner'
    });
  }

  // IV Skew Change during trade
  if (results.postEntry?.skewChangeTest) {
    factors.push({
      name: 'IV Skew Change',
      effectSize: Math.abs(results.postEntry.skewChangeTest.effectSize || 0),
      pValue: results.postEntry.skewChangeTest.p,
      direction: 'Less increase → better'
    });
  }

  // ATM IV at Entry
  if (results.atEntry?.ivTest) {
    factors.push({
      name: 'ATM IV at Entry',
      effectSize: Math.abs(cohensD(
        results.trades.filter(t => t.netPnL > 0).map(t => t.signal.ivValue),
        results.trades.filter(t => t.netPnL < 0).map(t => t.signal.ivValue)
      )),
      pValue: results.atEntry.ivTest.p,
      direction: 'Lower IV → better'
    });
  }

  // Calculate composite score: effect size * -log(p-value)
  factors.forEach(f => {
    const logP = f.pValue > 0 ? -Math.log10(f.pValue) : 3;
    f.compositeScore = (isNaN(f.effectSize) ? 0 : f.effectSize) * logP;
  });

  // Sort by composite score
  factors.sort((a, b) => b.compositeScore - a.compositeScore);

  console.log(`\n${'Rank'.padEnd(6)} │ ${'Factor'.padEnd(25)} │ ${'Effect Size'.padStart(12)} │ ${'p-value'.padStart(10)} │ ${'Score'.padStart(8)}`);
  console.log('─'.repeat(75));

  factors.forEach((f, i) => {
    const effectStr = isNaN(f.effectSize) ? 'N/A' : f.effectSize.toFixed(3);
    const pStr = isNaN(f.pValue) ? 'N/A' : f.pValue.toFixed(4);
    const scoreStr = isNaN(f.compositeScore) ? 'N/A' : f.compositeScore.toFixed(2);
    console.log(`${String(i + 1).padEnd(6)} │ ${f.name.padEnd(25)} │ ${effectStr.padStart(12)} │ ${pStr.padStart(10)} │ ${scoreStr.padStart(8)}`);
  });

  console.log('\nEffect size interpretation: 0.2=small, 0.5=medium, 0.8=large');
  console.log('Score = Effect Size × -log₁₀(p-value)');

  return factors;
}

function generateKeyFindings(results, trades, winners, losers) {
  printSeparator('KEY FINDINGS & RECOMMENDATIONS');

  console.log('\n📊 SUMMARY STATISTICS');
  console.log('─'.repeat(40));
  console.log(`Total Trades: ${trades.length}`);
  console.log(`Winners: ${winners.length} (${(winners.length / trades.length * 100).toFixed(1)}%)`);
  console.log(`Losers: ${losers.length} (${(losers.length / trades.length * 100).toFixed(1)}%)`);
  console.log(`Total P&L: $${trades.reduce((s, t) => s + t.netPnL, 0).toFixed(0)}`);
  console.log(`Avg Winner: $${(winners.reduce((s, t) => s + t.netPnL, 0) / winners.length).toFixed(0)}`);
  console.log(`Avg Loser: $${(losers.reduce((s, t) => s + t.netPnL, 0) / losers.length).toFixed(0)}`);

  console.log('\n🎯 ACTIONABLE FINDINGS');
  console.log('─'.repeat(40));

  // Finding 1: Level type performance
  if (results.atEntry?.levelStats) {
    const worstLevel = results.atEntry.levelStats.reduce((worst, curr) =>
      curr.winRate < worst.winRate ? curr : worst
    );
    const bestLevel = results.atEntry.levelStats.reduce((best, curr) =>
      curr.winRate > best.winRate ? curr : best
    );

    console.log(`\n1. LEVEL TYPE PERFORMANCE`);
    console.log(`   Best: ${bestLevel.level} (${bestLevel.winRate.toFixed(1)}% win rate)`);
    console.log(`   Worst: ${worstLevel.level} (${worstLevel.winRate.toFixed(1)}% win rate)`);
    if (worstLevel.winRate < 70) {
      console.log(`   → Consider filtering out ${worstLevel.level} entries`);
    }
  }

  // Finding 2: Time-based patterns
  if (results.temporal?.hourStats) {
    const hours = Object.entries(results.temporal.hourStats);
    const worstHour = hours.reduce((worst, [h, s]) => s.winRate < worst[1].winRate ? [h, s] : worst);

    console.log(`\n2. WORST TRADING HOUR`);
    console.log(`   Hour ${worstHour[0]} UTC (${utcToEST(parseInt(worstHour[0]))} EST): ${(worstHour[1].winRate * 100).toFixed(1)}% win rate`);
    console.log(`   P&L: $${worstHour[1].totalPnL.toFixed(0)}`);
    if (worstHour[1].winRate < 0.7) {
      console.log(`   → Consider avoiding entries at this hour`);
    }
  }

  // Finding 3: Duration insight
  const avgWinDuration = winners.reduce((s, t) => s + t.barsSinceEntry, 0) / winners.length;
  const avgLoseDuration = losers.reduce((s, t) => s + t.barsSinceEntry, 0) / losers.length;

  console.log(`\n3. DURATION INSIGHT`);
  console.log(`   Avg winner duration: ${avgWinDuration.toFixed(1)} bars`);
  console.log(`   Avg loser duration: ${avgLoseDuration.toFixed(1)} bars`);
  if (avgLoseDuration > avgWinDuration * 1.5) {
    console.log(`   → Losers hold ${((avgLoseDuration / avgWinDuration - 1) * 100).toFixed(0)}% longer than winners`);
    console.log(`   → Consider reducing max hold time or adding time-decay stops`);
  }

  // Finding 4: Losers that were profitable
  if (results.priceAction?.losersWithHighMFE) {
    const pct = (results.priceAction.losersWithHighMFE / losers.length * 100).toFixed(1);
    console.log(`\n4. MISSED PROFITS`);
    console.log(`   ${results.priceAction.losersWithHighMFE} losers (${pct}%) had MFE >= 30 points`);
    console.log(`   These trades were profitable at some point`);
    console.log(`   → Consider breakeven stop or tighter trailing stop`);
  }

  // Finding 5: Post-loss pattern
  if (results.consecutive?.postLossWinRate !== undefined) {
    const diff = (results.consecutive.postLossWinRate - winners.length / trades.length) * 100;
    console.log(`\n5. POST-LOSS BEHAVIOR`);
    console.log(`   Win rate after a loss: ${(results.consecutive.postLossWinRate * 100).toFixed(1)}%`);
    console.log(`   Difference from average: ${diff > 0 ? '+' : ''}${diff.toFixed(1)} percentage points`);
    if (Math.abs(diff) > 5) {
      console.log(`   → ${diff > 0 ? 'Losses may be followed by reversions' : 'Consider pausing after losses'}`);
    }
  }

  console.log('\n' + '═'.repeat(80));
}

// ============================================================================
// Main Execution
// ============================================================================

async function main() {
  console.log('═'.repeat(80));
  console.log('IV-SKEW-GEX LOSER CORRELATION ANALYSIS');
  console.log('═'.repeat(80));

  // Load trade results
  console.log(`\nLoading trade results from: ${resultsPath}`);
  const data = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), resultsPath), 'utf8'));

  const trades = data.trades.filter(t => t.status === 'completed');
  const winners = trades.filter(t => t.netPnL > 0);
  const losers = trades.filter(t => t.netPnL < 0);

  console.log(`Loaded ${trades.length} completed trades: ${winners.length} winners, ${losers.length} losers`);

  // Get date range from trades
  const timestamps = trades.map(t => t.entryTime);
  const startDate = new Date(Math.min(...timestamps));
  const endDate = new Date(Math.max(...timestamps));

  // Add buffer to dates
  startDate.setDate(startDate.getDate() - 1);
  endDate.setDate(endDate.getDate() + 1);

  console.log(`Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);

  // Load supporting data
  console.log('\nLoading GEX data...');
  const gexLoader = new GexLoader(path.join(dataDir, 'gex'), 'nq');
  await gexLoader.loadDateRange(startDate, endDate);

  console.log('Loading IV data...');
  const ivLoader = new IVLoader(dataDir);
  await ivLoader.load(startDate, endDate);
  console.log(`IV data: ${ivLoader.getStats().count} records`);

  console.log('Loading OHLCV data...');
  const candles = await loadOHLCV(startDate, endDate);

  // Store results for factor ranking
  const results = { trades, winners, losers };

  // Run analyses
  results.atEntry = analyzeAtEntryCorrelations(trades, winners, losers);
  results.postEntry = await analyzePostEntryDynamics(trades, winners, losers, gexLoader, ivLoader);
  results.priceAction = await analyzePriceAction(trades, winners, losers, candles);
  results.temporal = analyzeTemporalPatterns(trades, winners, losers);
  results.timeRisk = analyzeTimeInTradeRisk(trades, winners, losers);
  results.volume = await analyzeVolume(trades, winners, losers, candles);
  results.consecutive = analyzeConsecutiveTrades(trades, winners, losers);

  // Generate factor ranking
  results.factors = generateFactorRanking(results);

  // Generate key findings
  generateKeyFindings(results, trades, winners, losers);

  console.log('\nAnalysis complete.');
}

main().catch(console.error);
