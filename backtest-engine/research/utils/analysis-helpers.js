/**
 * Analysis Helper Utilities
 *
 * Common functions for research analysis:
 * - Performance metrics (win rate, P&L, expectancy)
 * - Data bucketing and grouping
 * - Statistical calculations
 * - Report generation
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RESULTS_DIR = path.join(__dirname, '..', '..', 'results', 'research');

/**
 * Calculate performance metrics for a set of trades
 * @param {Array} trades - Array of trade objects with netPnL
 * @returns {object} Performance metrics
 */
export function calculatePerformance(trades) {
  if (!trades || trades.length === 0) {
    return {
      tradeCount: 0,
      winners: 0,
      losers: 0,
      winRate: 0,
      totalPnL: 0,
      avgPnL: 0,
      avgWin: 0,
      avgLoss: 0,
      largestWin: 0,
      largestLoss: 0,
      profitFactor: 0,
      expectancy: 0
    };
  }

  const winners = trades.filter(t => t.netPnL > 0);
  const losers = trades.filter(t => t.netPnL <= 0);

  const totalPnL = trades.reduce((sum, t) => sum + t.netPnL, 0);
  const avgPnL = totalPnL / trades.length;

  const totalWins = winners.reduce((sum, t) => sum + t.netPnL, 0);
  const totalLosses = Math.abs(losers.reduce((sum, t) => sum + t.netPnL, 0));

  const avgWin = winners.length > 0 ? totalWins / winners.length : 0;
  const avgLoss = losers.length > 0 ? totalLosses / losers.length : 0;

  const winRate = trades.length > 0 ? (winners.length / trades.length) * 100 : 0;
  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

  // Expectancy = (Win% * Avg Win) - (Loss% * Avg Loss)
  const expectancy = (winRate / 100 * avgWin) - ((100 - winRate) / 100 * avgLoss);

  // Calculate points P&L if available
  const avgPoints = trades[0]?.pointsPnL !== undefined
    ? trades.reduce((sum, t) => sum + (t.pointsPnL || 0), 0) / trades.length
    : null;

  return {
    tradeCount: trades.length,
    winners: winners.length,
    losers: losers.length,
    winRate: round(winRate, 2),
    totalPnL: round(totalPnL, 2),
    avgPnL: round(avgPnL, 2),
    avgWin: round(avgWin, 2),
    avgLoss: round(avgLoss, 2),
    largestWin: round(Math.max(0, ...winners.map(t => t.netPnL)), 2),
    largestLoss: round(Math.min(0, ...losers.map(t => t.netPnL)), 2),
    profitFactor: round(profitFactor, 2),
    expectancy: round(expectancy, 2),
    avgPoints: avgPoints !== null ? round(avgPoints, 2) : null
  };
}

/**
 * Group trades by a given field
 * @param {Array} trades - Array of trades
 * @param {string|function} groupBy - Field name or function to group by
 * @returns {Map} Map of group -> trades array
 */
export function groupTrades(trades, groupBy) {
  const groups = new Map();

  trades.forEach(trade => {
    const key = typeof groupBy === 'function' ? groupBy(trade) : trade[groupBy];

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(trade);
  });

  return groups;
}

/**
 * Bucket numeric values into ranges
 * @param {number} value - Value to bucket
 * @param {Array} buckets - Array of {min, max, label} or just numbers for boundaries
 * @returns {string} Bucket label
 */
export function bucket(value, buckets) {
  if (typeof buckets[0] === 'number') {
    // Simple number boundaries
    for (let i = 0; i < buckets.length; i++) {
      if (value < buckets[i]) {
        return i === 0 ? `< ${buckets[i]}` : `${buckets[i - 1]} - ${buckets[i]}`;
      }
    }
    return `>= ${buckets[buckets.length - 1]}`;
  }

  // Object boundaries with labels
  for (const b of buckets) {
    if (value >= b.min && value < b.max) {
      return b.label;
    }
  }
  return 'unknown';
}

/**
 * Create numeric buckets automatically
 * @param {Array} values - Array of numeric values
 * @param {number} numBuckets - Number of buckets to create
 * @returns {Array} Array of bucket boundaries
 */
export function createAutoBuckets(values, numBuckets = 5) {
  if (values.length === 0) return [];

  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const range = max - min;
  const step = range / numBuckets;

  const buckets = [];
  for (let i = 1; i <= numBuckets; i++) {
    buckets.push(round(min + (step * i), 2));
  }

  return buckets;
}

/**
 * Calculate correlation between two arrays
 * @param {Array} x - First array of values
 * @param {Array} y - Second array of values
 * @returns {number} Pearson correlation coefficient (-1 to 1)
 */
export function correlation(x, y) {
  if (x.length !== y.length || x.length === 0) return null;

  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((total, xi, i) => total + xi * y[i], 0);
  const sumX2 = x.reduce((total, xi) => total + xi * xi, 0);
  const sumY2 = y.reduce((total, yi) => total + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  if (denominator === 0) return 0;

  return round(numerator / denominator, 4);
}

/**
 * Calculate percentiles
 * @param {Array} values - Array of numeric values
 * @param {Array} percentiles - Array of percentiles to calculate (0-100)
 * @returns {object} Map of percentile -> value
 */
export function calculatePercentiles(values, percentiles = [25, 50, 75]) {
  if (values.length === 0) return {};

  const sorted = [...values].sort((a, b) => a - b);
  const result = {};

  percentiles.forEach(p => {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    result[`p${p}`] = sorted[Math.max(0, index)];
  });

  return result;
}

/**
 * Simple moving average
 * @param {Array} values - Array of values
 * @param {number} period - SMA period
 * @returns {number|null} SMA value
 */
export function sma(values, period) {
  if (!values || values.length < period) return null;

  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Rate of change
 * @param {Array} values - Array of values
 * @param {number} period - ROC period
 * @returns {number|null} ROC as percentage
 */
export function roc(values, period) {
  if (!values || values.length < period + 1) return null;

  const current = values[values.length - 1];
  const previous = values[values.length - 1 - period];

  if (previous === 0) return null;

  return ((current - previous) / previous) * 100;
}

/**
 * Round a number to specified decimal places
 * @param {number} value - Value to round
 * @param {number} decimals - Number of decimal places
 * @returns {number} Rounded value
 */
export function round(value, decimals = 2) {
  if (typeof value !== 'number' || isNaN(value)) return 0;

  const multiplier = Math.pow(10, decimals);
  return Math.round(value * multiplier) / multiplier;
}

/**
 * Format currency for display
 * @param {number} value - Value to format
 * @returns {string} Formatted string
 */
export function formatCurrency(value) {
  const sign = value >= 0 ? '' : '-';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Format percentage for display
 * @param {number} value - Value to format
 * @returns {string} Formatted string
 */
export function formatPercent(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/**
 * Save analysis results to JSON file
 * @param {string} filename - Output filename
 * @param {object} data - Data to save
 */
export function saveResults(filename, data) {
  const filePath = path.join(RESULTS_DIR, filename);

  // Ensure directory exists
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`Results saved to: ${filePath}`);
}

/**
 * Load analysis results from JSON file
 * @param {string} filename - Filename to load
 * @returns {object|null} Loaded data or null
 */
export function loadResults(filename) {
  const filePath = path.join(RESULTS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * Generate a summary comparison table
 * @param {Array} groups - Array of {name, performance} objects
 * @returns {string} Formatted table string
 */
export function generateComparisonTable(groups) {
  if (groups.length === 0) return 'No data';

  const headers = ['Group', 'Trades', 'Win Rate', 'Avg P&L', 'Total P&L', 'PF'];

  const maxLengths = headers.map(h => h.length);
  const rows = groups.map(g => {
    const row = [
      g.name,
      g.performance.tradeCount.toString(),
      `${g.performance.winRate}%`,
      formatCurrency(g.performance.avgPnL),
      formatCurrency(g.performance.totalPnL),
      g.performance.profitFactor.toFixed(2)
    ];

    row.forEach((cell, i) => {
      maxLengths[i] = Math.max(maxLengths[i], cell.length);
    });

    return row;
  });

  // Build table
  const separator = maxLengths.map(len => '-'.repeat(len + 2)).join('+');
  const headerRow = headers.map((h, i) => h.padEnd(maxLengths[i])).join(' | ');

  let table = `${separator}\n${headerRow}\n${separator}\n`;

  rows.forEach(row => {
    table += row.map((cell, i) => cell.padEnd(maxLengths[i])).join(' | ') + '\n';
  });

  table += separator;

  return table;
}

/**
 * Analyze trades by a dimension and return comparison
 * @param {Array} trades - Array of trades
 * @param {string|function} dimension - Field or function to group by
 * @param {string} name - Name of the dimension for reporting
 * @returns {object} Analysis results
 */
export function analyzeDimension(trades, dimension, name) {
  const groups = groupTrades(trades, dimension);

  const results = [];
  for (const [key, groupTrades] of groups) {
    const perf = calculatePerformance(groupTrades);
    results.push({
      name: String(key),
      ...perf
    });
  }

  // Sort by total P&L
  results.sort((a, b) => b.totalPnL - a.totalPnL);

  return {
    dimension: name,
    groupCount: results.length,
    groups: results,
    best: results[0],
    worst: results[results.length - 1],
    baselineWinRate: calculatePerformance(trades).winRate,
    baselinePnL: calculatePerformance(trades).totalPnL
  };
}

/**
 * Calculate statistical significance (simple z-test for proportions)
 * @param {number} winRate1 - First win rate (0-100)
 * @param {number} n1 - First sample size
 * @param {number} winRate2 - Second win rate (0-100)
 * @param {number} n2 - Second sample size
 * @returns {object} Z-score and p-value
 */
export function proportionZTest(winRate1, n1, winRate2, n2) {
  const p1 = winRate1 / 100;
  const p2 = winRate2 / 100;

  const pPooled = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / n1 + 1 / n2));

  if (se === 0) return { zScore: 0, pValue: 1, significant: false };

  const z = (p1 - p2) / se;

  // Approximate p-value using normal distribution
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));

  return {
    zScore: round(z, 3),
    pValue: round(pValue, 4),
    significant: pValue < 0.05
  };
}

/**
 * Normal CDF approximation
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

export default {
  calculatePerformance,
  groupTrades,
  bucket,
  createAutoBuckets,
  correlation,
  calculatePercentiles,
  sma,
  roc,
  round,
  formatCurrency,
  formatPercent,
  saveResults,
  loadResults,
  generateComparisonTable,
  analyzeDimension,
  proportionZTest
};
