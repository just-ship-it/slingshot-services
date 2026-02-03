/**
 * Data Loader Utilities for ICT-SMT Research
 *
 * Provides functions to load:
 * - ICT-SMT 2025 trade data with metadata
 * - NQ OHLCV 1-minute data
 * - QQQ OHLCV 1-minute data
 * - GEX levels (daily and intraday)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const RESULTS_DIR = path.join(__dirname, '..', '..', 'results');

/**
 * Load ICT-SMT 2025 trade data
 * @returns {Promise<Array>} Array of trade objects with metadata
 */
export async function loadTrades() {
  const filePath = path.join(RESULTS_DIR, 'ict_smt_2025.json');

  if (!fs.existsSync(filePath)) {
    throw new Error(`Trade file not found: ${filePath}`);
  }

  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  // Enhance trades with computed fields
  const trades = content.trades.map(trade => ({
    ...trade,
    // Add computed fields
    isWinner: trade.netPnL > 0,
    pointsPnL: trade.exitPrice - trade.entryPrice,
    holdDurationMinutes: (trade.exitTime - trade.entryTime) / (1000 * 60),
    entryDate: new Date(trade.entryTime).toISOString().split('T')[0],
    entryHour: new Date(trade.entryTime).getHours(),
    entryMinute: new Date(trade.entryTime).getMinutes(),
    exitReason: trade.exitReason || 'unknown'
  }));

  console.log(`Loaded ${trades.length} trades from ICT-SMT 2025 dataset`);

  return trades;
}

/**
 * Load NQ 1-minute OHLCV data for a date range
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Promise<Map>} Map of timestamp -> candle data
 */
export async function loadNQOHLCV(startDate = '2025-01-01', endDate = '2025-12-31') {
  const filePath = path.join(DATA_DIR, 'ohlcv', 'NQ_ohlcv_1m.csv');

  if (!fs.existsSync(filePath)) {
    throw new Error(`OHLCV file not found: ${filePath}`);
  }

  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime() + 24 * 60 * 60 * 1000; // Include end day

  const candles = new Map();

  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        // Skip calendar spreads
        if (row.symbol && row.symbol.includes('-')) return;

        const timestamp = new Date(row.ts_event).getTime();
        if (isNaN(timestamp)) return;

        // Filter to date range
        if (timestamp < start || timestamp > end) return;

        const candle = {
          timestamp,
          open: parseFloat(row.open),
          high: parseFloat(row.high),
          low: parseFloat(row.low),
          close: parseFloat(row.close),
          volume: parseFloat(row.volume) || 0,
          symbol: row.symbol
        };

        // Skip invalid candles
        if (isNaN(candle.open) || isNaN(candle.close)) return;

        candles.set(timestamp, candle);
      })
      .on('end', resolve)
      .on('error', reject);
  });

  console.log(`Loaded ${candles.size.toLocaleString()} NQ 1-minute candles`);

  return candles;
}

/**
 * Load QQQ 1-minute OHLCV data for a date range
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Promise<Map>} Map of timestamp -> candle data
 */
export async function loadQQQOHLCV(startDate = '2025-01-01', endDate = '2025-12-31') {
  const filePath = path.join(DATA_DIR, 'ohlcv', 'QQQ_ohlcv_1m.csv');

  if (!fs.existsSync(filePath)) {
    throw new Error(`QQQ OHLCV file not found: ${filePath}`);
  }

  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime() + 24 * 60 * 60 * 1000;

  const candles = new Map();

  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        const timestamp = new Date(row.ts_event).getTime();
        if (isNaN(timestamp)) return;

        if (timestamp < start || timestamp > end) return;

        const candle = {
          timestamp,
          open: parseFloat(row.open),
          high: parseFloat(row.high),
          low: parseFloat(row.low),
          close: parseFloat(row.close),
          volume: parseFloat(row.volume) || 0
        };

        if (isNaN(candle.open) || isNaN(candle.close)) return;

        candles.set(timestamp, candle);
      })
      .on('end', resolve)
      .on('error', reject);
  });

  console.log(`Loaded ${candles.size.toLocaleString()} QQQ 1-minute candles`);

  return candles;
}

/**
 * Load daily GEX levels
 * @returns {Promise<Map>} Map of date string -> GEX data
 */
export async function loadGEXDaily() {
  const filePath = path.join(DATA_DIR, 'gex', 'NQ_gex_levels.csv');

  if (!fs.existsSync(filePath)) {
    throw new Error(`GEX file not found: ${filePath}`);
  }

  const gexData = new Map();

  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        const date = row.date;
        if (!date) return;

        gexData.set(date, {
          date,
          gammaFlip: parseFloat(row.nq_gamma_flip),
          putWall1: parseFloat(row.nq_put_wall_1),
          putWall2: parseFloat(row.nq_put_wall_2),
          putWall3: parseFloat(row.nq_put_wall_3),
          callWall1: parseFloat(row.nq_call_wall_1),
          callWall2: parseFloat(row.nq_call_wall_2),
          callWall3: parseFloat(row.nq_call_wall_3),
          totalGex: parseFloat(row.total_gex),
          regime: row.regime
        });
      })
      .on('end', resolve)
      .on('error', reject);
  });

  console.log(`Loaded ${gexData.size} daily GEX records`);

  return gexData;
}

/**
 * Get candles around a specific timestamp
 * @param {Map} candleMap - Map of timestamp -> candle
 * @param {number} timestamp - Target timestamp
 * @param {number} before - Number of candles before
 * @param {number} after - Number of candles after
 * @returns {Array} Array of candles
 */
export function getCandlesAround(candleMap, timestamp, before = 20, after = 0) {
  // Get all timestamps and sort them
  const allTimestamps = Array.from(candleMap.keys()).sort((a, b) => a - b);

  // Find the index of the closest timestamp
  let targetIndex = allTimestamps.findIndex(ts => ts >= timestamp);

  if (targetIndex === -1) {
    targetIndex = allTimestamps.length - 1;
  }

  // Get the range of candles
  const startIndex = Math.max(0, targetIndex - before);
  const endIndex = Math.min(allTimestamps.length - 1, targetIndex + after);

  const candles = [];
  for (let i = startIndex; i <= endIndex; i++) {
    candles.push(candleMap.get(allTimestamps[i]));
  }

  return candles;
}

/**
 * Get candles for a specific trading day
 * @param {Map} candleMap - Map of timestamp -> candle
 * @param {Date} date - Target date
 * @returns {Array} Array of candles for that day
 */
export function getCandlesForDay(candleMap, date) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const candles = [];

  for (const [timestamp, candle] of candleMap) {
    if (timestamp >= startOfDay.getTime() && timestamp <= endOfDay.getTime()) {
      candles.push(candle);
    }
  }

  return candles.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Get RTH (Regular Trading Hours) candles for a day
 * RTH is 9:30 AM - 4:00 PM ET
 * @param {Map} candleMap - Map of timestamp -> candle
 * @param {Date} date - Target date
 * @returns {Array} Array of RTH candles
 */
export function getRTHCandles(candleMap, date) {
  const dayCandles = getCandlesForDay(candleMap, date);

  return dayCandles.filter(candle => {
    const candleDate = new Date(candle.timestamp);
    const hour = candleDate.getHours();
    const minute = candleDate.getMinutes();
    const timeInMinutes = hour * 60 + minute;

    // 9:30 AM = 570 minutes, 4:00 PM = 960 minutes
    return timeInMinutes >= 570 && timeInMinutes < 960;
  });
}

/**
 * Get overnight session candles (4 PM previous day to 9:30 AM)
 * @param {Map} candleMap - Map of timestamp -> candle
 * @param {Date} date - Target date
 * @returns {Array} Array of overnight candles
 */
export function getOvernightCandles(candleMap, date) {
  // Overnight starts at 4 PM previous day
  const prevDay = new Date(date);
  prevDay.setDate(prevDay.getDate() - 1);

  const overnightStart = new Date(prevDay);
  overnightStart.setHours(16, 0, 0, 0);

  const overnightEnd = new Date(date);
  overnightEnd.setHours(9, 30, 0, 0);

  const candles = [];

  for (const [timestamp, candle] of candleMap) {
    if (timestamp >= overnightStart.getTime() && timestamp < overnightEnd.getTime()) {
      candles.push(candle);
    }
  }

  return candles.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Get previous trading day's RTH data
 * @param {Map} candleMap - Map of timestamp -> candle
 * @param {Date} date - Current date
 * @returns {object|null} Previous day's high, low, close, or null
 */
export function getPreviousDayLevels(candleMap, date) {
  // Go back up to 7 days to find previous trading day
  for (let i = 1; i <= 7; i++) {
    const prevDate = new Date(date);
    prevDate.setDate(prevDate.getDate() - i);

    // Skip weekends
    const dayOfWeek = prevDate.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    const rthCandles = getRTHCandles(candleMap, prevDate);

    if (rthCandles.length > 0) {
      return {
        date: prevDate.toISOString().split('T')[0],
        open: rthCandles[0].open,
        high: Math.max(...rthCandles.map(c => c.high)),
        low: Math.min(...rthCandles.map(c => c.low)),
        close: rthCandles[rthCandles.length - 1].close
      };
    }
  }

  return null;
}

/**
 * Calculate average volume over N candles
 * @param {Array} candles - Array of candles
 * @param {number} period - Number of candles for average
 * @returns {number} Average volume
 */
export function calculateAverageVolume(candles, period = 20) {
  if (candles.length < period) return null;

  const recentCandles = candles.slice(-period);
  const totalVolume = recentCandles.reduce((sum, c) => sum + c.volume, 0);

  return totalVolume / period;
}

/**
 * Find candle index closest to a timestamp
 * @param {Array} candles - Sorted array of candles
 * @param {number} timestamp - Target timestamp
 * @returns {number} Index of closest candle
 */
export function findCandleIndex(candles, timestamp) {
  // Binary search for closest timestamp
  let left = 0;
  let right = candles.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);

    if (candles[mid].timestamp < timestamp) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  return left;
}

export default {
  loadTrades,
  loadNQOHLCV,
  loadQQQOHLCV,
  loadGEXDaily,
  getCandlesAround,
  getCandlesForDay,
  getRTHCandles,
  getOvernightCandles,
  getPreviousDayLevels,
  calculateAverageVolume,
  findCandleIndex
};
