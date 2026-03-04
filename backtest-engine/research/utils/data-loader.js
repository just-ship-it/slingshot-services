/**
 * Data Loader Utilities for Research
 *
 * Provides functions to load:
 * - ICT-SMT 2025 trade data with metadata
 * - NQ/ES OHLCV 1-minute data (raw and continuous)
 * - QQQ OHLCV 1-minute data
 * - 1-second data windows via index files
 * - GEX levels (daily and intraday JSON)
 * - Session-based candle slicing (Asian, European, RTH)
 * - UTC to ET conversion with DST handling
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
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

// --- DST Handling ---

// US DST transitions: 2nd Sunday March 2:00 AM → 3:00 AM, 1st Sunday November 2:00 AM → 1:00 AM
const DST_TRANSITIONS = {};

function getDSTTransitions(year) {
  if (DST_TRANSITIONS[year]) return DST_TRANSITIONS[year];

  // 2nd Sunday of March
  const march1 = new Date(Date.UTC(year, 2, 1));
  let sundayCount = 0;
  let dstStart;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(year, 2, d));
    if (dt.getUTCDay() === 0) {
      sundayCount++;
      if (sundayCount === 2) {
        // DST starts at 2 AM ET = 7 AM UTC (EST offset -5)
        dstStart = Date.UTC(year, 2, d, 7, 0, 0);
        break;
      }
    }
  }

  // 1st Sunday of November
  let dstEnd;
  for (let d = 1; d <= 30; d++) {
    const dt = new Date(Date.UTC(year, 10, d));
    if (dt.getUTCDay() === 0) {
      // DST ends at 2 AM EDT = 6 AM UTC (EDT offset -4)
      dstEnd = Date.UTC(year, 10, d, 6, 0, 0);
      break;
    }
  }

  DST_TRANSITIONS[year] = { dstStart, dstEnd };
  return DST_TRANSITIONS[year];
}

/**
 * Check if a UTC timestamp is during US Eastern Daylight Time
 * @param {number} utcMs - UTC timestamp in milliseconds
 * @returns {boolean} True if EDT (UTC-4), false if EST (UTC-5)
 */
export function isDST(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  const { dstStart, dstEnd } = getDSTTransitions(year);
  return utcMs >= dstStart && utcMs < dstEnd;
}

/**
 * Convert UTC timestamp to ET (Eastern Time) components
 * Handles DST transitions correctly
 * @param {number} utcMs - UTC timestamp in milliseconds
 * @returns {{ year, month, day, hour, minute, second, offset, timeInMinutes, date }}
 */
export function toET(utcMs) {
  const offset = isDST(utcMs) ? -4 : -5;
  const etMs = utcMs + offset * 3600000;
  const d = new Date(etMs);
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour,
    minute,
    second: d.getUTCSeconds(),
    offset,
    timeInMinutes: hour * 60 + minute,
    dayOfWeek: d.getUTCDay(),
    // YYYY-MM-DD string in ET
    date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  };
}

/**
 * Create a UTC timestamp from ET date components
 * @param {number} year
 * @param {number} month - 0-indexed
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @returns {number} UTC timestamp in ms
 */
export function fromET(year, month, day, hour, minute = 0) {
  // First guess with EST offset
  let utcMs = Date.UTC(year, month, day, hour + 5, minute);
  // Check if that time is actually in DST
  if (isDST(utcMs)) {
    utcMs = Date.UTC(year, month, day, hour + 4, minute);
  }
  return utcMs;
}

// --- Continuous OHLCV Loading ---

/**
 * Load continuous OHLCV data (pre-rolled, no filtering needed)
 * @param {'NQ'|'ES'} product - Product to load
 * @param {'1m'|'1s'} resolution - Resolution (default 1m)
 * @param {string} startDate - Start date YYYY-MM-DD
 * @param {string} endDate - End date YYYY-MM-DD
 * @returns {Promise<Array>} Sorted array of candle objects
 */
export async function loadContinuousOHLCV(product = 'NQ', resolution = '1m', startDate = '2021-01-01', endDate = '2026-01-31') {
  const filename = `${product.toUpperCase()}_ohlcv_${resolution}_continuous.csv`;
  const filePath = path.join(DATA_DIR, 'ohlcv', product.toLowerCase(), filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Continuous OHLCV file not found: ${filePath}`);
  }

  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime() + 24 * 3600000;

  const candles = [];

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
          volume: parseFloat(row.volume) || 0,
          symbol: row.symbol || row.contract
        };

        if (isNaN(candle.open) || isNaN(candle.close)) return;

        candles.push(candle);
      })
      .on('end', resolve)
      .on('error', reject);
  });

  candles.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Loaded ${candles.length.toLocaleString()} ${product} ${resolution} continuous candles (${startDate} to ${endDate})`);

  return candles;
}

// --- 1-Second Window Loading via Index ---

/**
 * Load 1-second candles for a specific minute using the index file for fast seeking
 * @param {'NQ'|'ES'} product - Product
 * @param {number} minuteTimestamp - Timestamp of the minute (ms, floored to minute)
 * @returns {Promise<Array>} Array of 1s candles for that minute
 */
export async function load1sWindow(product = 'NQ', minuteTimestamp) {
  const indexPath = path.join(DATA_DIR, 'ohlcv', product.toLowerCase(), `${product.toUpperCase()}_ohlcv_1s_continuous.index.json`);
  const dataPath = path.join(DATA_DIR, 'ohlcv', product.toLowerCase(), `${product.toUpperCase()}_ohlcv_1s_continuous.csv`);

  if (!fs.existsSync(indexPath) || !fs.existsSync(dataPath)) {
    return [];
  }

  // Load index lazily (cache it)
  if (!load1sWindow._indexCache) load1sWindow._indexCache = {};
  if (!load1sWindow._indexCache[product]) {
    const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    load1sWindow._indexCache[product] = indexData.minutes;
  }

  const index = load1sWindow._indexCache[product];
  const key = String(minuteTimestamp);
  const entry = index[key];

  if (!entry) return [];

  // Read bytes from the data file
  const buffer = Buffer.alloc(entry.length);
  const fd = fs.openSync(dataPath, 'r');
  fs.readSync(fd, buffer, 0, entry.length, entry.offset);
  fs.closeSync(fd);

  const text = buffer.toString('utf-8');
  const lines = text.split('\n').filter(l => l.trim());
  const candles = [];

  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 6) continue;
    const timestamp = new Date(parts[0]).getTime();
    if (isNaN(timestamp)) continue;
    candles.push({
      timestamp,
      open: parseFloat(parts[1]),
      high: parseFloat(parts[2]),
      low: parseFloat(parts[3]),
      close: parseFloat(parts[4]),
      volume: parseFloat(parts[5]) || 0
    });
  }

  return candles.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Load 1-second candles for a range of minutes (e.g., sweep ± 2 minutes)
 * @param {'NQ'|'ES'} product
 * @param {number} centerMinuteTs - Center minute timestamp (ms)
 * @param {number} minutesBefore - Minutes before center to load
 * @param {number} minutesAfter - Minutes after center to load
 * @returns {Promise<Array>} Sorted array of 1s candles
 */
export async function load1sRange(product, centerMinuteTs, minutesBefore = 2, minutesAfter = 2) {
  const all = [];
  for (let m = -minutesBefore; m <= minutesAfter; m++) {
    const minuteTs = centerMinuteTs + m * 60000;
    const candles = await load1sWindow(product, minuteTs);
    all.push(...candles);
  }
  return all.sort((a, b) => a.timestamp - b.timestamp);
}

// --- Session Candle Helpers (UTC-aware with DST) ---

/**
 * Get Asian session candles (7:00 PM - 3:00 AM ET)
 * Note: Asian session spans two calendar days (evening before → early morning)
 * @param {Array} candles - Sorted array of candles
 * @param {string} dateStr - The RTH date (YYYY-MM-DD) — Asian session starts the evening before
 * @returns {Array} Asian session candles
 */
export function getAsianCandles(candles, dateStr) {
  // Asian session for "today's" RTH starts at 7 PM ET the previous calendar day
  const [year, month, day] = dateStr.split('-').map(Number);
  const prevDay = new Date(Date.UTC(year, month - 1, day));
  prevDay.setUTCDate(prevDay.getUTCDate() - 1);

  const asianStart = fromET(prevDay.getUTCFullYear(), prevDay.getUTCMonth(), prevDay.getUTCDate(), 19, 0);
  const asianEnd = fromET(year, month - 1, day, 3, 0);

  return candles.filter(c => c.timestamp >= asianStart && c.timestamp < asianEnd);
}

/**
 * Get European session candles (3:00 AM - 9:30 AM ET)
 * @param {Array} candles - Sorted array of candles
 * @param {string} dateStr - RTH date (YYYY-MM-DD)
 * @returns {Array} European session candles
 */
export function getEuropeanCandles(candles, dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const euroStart = fromET(year, month - 1, day, 3, 0);
  const euroEnd = fromET(year, month - 1, day, 9, 30);

  return candles.filter(c => c.timestamp >= euroStart && c.timestamp < euroEnd);
}

/**
 * Get RTH candles using proper UTC-to-ET conversion
 * @param {Array} candles - Sorted array of candles
 * @param {string} dateStr - RTH date (YYYY-MM-DD)
 * @returns {Array} RTH candles (9:30 AM - 4:00 PM ET)
 */
export function getRTHCandlesFromArray(candles, dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const rthStart = fromET(year, month - 1, day, 9, 30);
  const rthEnd = fromET(year, month - 1, day, 16, 0);

  return candles.filter(c => c.timestamp >= rthStart && c.timestamp < rthEnd);
}

/**
 * Get overnight candles (6:00 PM previous day to 9:30 AM ET)
 * This is the full overnight session including Asian + European
 * @param {Array} candles - Sorted array of candles
 * @param {string} dateStr - RTH date (YYYY-MM-DD)
 * @returns {Array} Overnight candles
 */
export function getOvernightCandlesFromArray(candles, dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const prevDay = new Date(Date.UTC(year, month - 1, day));
  prevDay.setUTCDate(prevDay.getUTCDate() - 1);

  const onStart = fromET(prevDay.getUTCFullYear(), prevDay.getUTCMonth(), prevDay.getUTCDate(), 18, 0);
  const onEnd = fromET(year, month - 1, day, 9, 30);

  return candles.filter(c => c.timestamp >= onStart && c.timestamp < onEnd);
}

// --- Liquidity Trigger Level Loading ---

/**
 * Load LT (Liquidity Trigger) levels from CSV
 * @param {'NQ'|'ES'} product - Product to load
 * @returns {Promise<Array>} Sorted array of { timestamp, sentiment, levels: [l1..l5] }
 */
export async function loadLTLevels(product = 'NQ') {
  const filePath = product.toUpperCase() === 'NQ'
    ? path.join(DATA_DIR, 'liquidity', 'nq', 'NQ_liquidity_levels.csv')
    : path.join(DATA_DIR, 'liquidity', 'es', 'ES_liquidity_levels_15m.csv');

  if (!fs.existsSync(filePath)) {
    throw new Error(`LT levels file not found: ${filePath}`);
  }

  const records = [];

  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        const timestamp = parseInt(row.unix_timestamp);
        if (isNaN(timestamp)) return;

        const levels = [
          parseFloat(row.level_1),
          parseFloat(row.level_2),
          parseFloat(row.level_3),
          parseFloat(row.level_4),
          parseFloat(row.level_5)
        ];

        // Skip if any level is NaN
        if (levels.some(l => isNaN(l))) return;

        records.push({
          timestamp,
          sentiment: row.sentiment || 'UNKNOWN',
          levels
        });
      })
      .on('end', resolve)
      .on('error', reject);
  });

  records.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Loaded ${records.length.toLocaleString()} ${product} LT level snapshots`);

  return records;
}

/**
 * Get the most recent LT snapshot at or before a given timestamp (binary search)
 * @param {Array} ltLevels - Sorted array from loadLTLevels()
 * @param {number} timestamp - Target timestamp in ms
 * @returns {object|null} Most recent LT record ≤ timestamp, or null
 */
export function getLTSnapshotAt(ltLevels, timestamp) {
  if (!ltLevels || ltLevels.length === 0) return null;

  let lo = 0;
  let hi = ltLevels.length - 1;

  // If target is before all records
  if (timestamp < ltLevels[0].timestamp) return null;

  // Binary search for largest index where ltLevels[idx].timestamp <= timestamp
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ltLevels[mid].timestamp <= timestamp) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return ltLevels[lo];
}

// --- Intraday GEX Loading ---

/**
 * Load intraday GEX snapshots for a specific date
 * @param {'NQ'|'ES'} product
 * @param {string} dateStr - Date string YYYY-MM-DD
 * @returns {Array|null} Array of GEX snapshots or null if file doesn't exist
 */
export function loadIntradayGEX(product = 'NQ', dateStr) {
  const filename = `${product.toLowerCase()}_gex_${dateStr}.json`;
  const filePath = path.join(DATA_DIR, 'gex', product.toLowerCase(), filename);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return content.data || [];
}

/**
 * Get the GEX snapshot closest to a given time
 * @param {Array} snapshots - Array of GEX snapshots (from loadIntradayGEX)
 * @param {number} targetTimestamp - UTC timestamp in ms
 * @returns {object|null} Closest snapshot
 */
export function getGEXSnapshotAt(snapshots, targetTimestamp) {
  if (!snapshots || snapshots.length === 0) return null;

  let closest = null;
  let minDiff = Infinity;

  for (const snap of snapshots) {
    const snapTs = new Date(snap.timestamp).getTime();
    const diff = Math.abs(snapTs - targetTimestamp);
    if (diff < minDiff) {
      minDiff = diff;
      closest = snap;
    }
  }

  return closest;
}

/**
 * Extract unique trading dates from a sorted candle array
 * Only returns weekday dates that have RTH candles
 * @param {Array} candles - Sorted array of candles
 * @returns {string[]} Array of YYYY-MM-DD date strings
 */
export function extractTradingDates(candles) {
  const dates = new Set();
  for (const c of candles) {
    const et = toET(c.timestamp);
    // Only count if in RTH range (9:30-16:00)
    if (et.timeInMinutes >= 570 && et.timeInMinutes < 960 && et.dayOfWeek >= 1 && et.dayOfWeek <= 5) {
      dates.add(et.date);
    }
  }
  return Array.from(dates).sort();
}

/**
 * Get previous trading day's RTH levels from a sorted candle array
 * @param {Array} candles - Full sorted candle array
 * @param {string} dateStr - Current date YYYY-MM-DD
 * @param {string[]} tradingDates - Pre-computed sorted trading dates
 * @returns {{ date, open, high, low, close }|null}
 */
export function getPrevDayLevelsFromArray(candles, dateStr, tradingDates) {
  const idx = tradingDates.indexOf(dateStr);
  if (idx <= 0) return null;
  const prevDate = tradingDates[idx - 1];
  const rthCandles = getRTHCandlesFromArray(candles, prevDate);
  if (rthCandles.length === 0) return null;
  return {
    date: prevDate,
    open: rthCandles[0].open,
    high: Math.max(...rthCandles.map(c => c.high)),
    low: Math.min(...rthCandles.map(c => c.low)),
    close: rthCandles[rthCandles.length - 1].close
  };
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
  findCandleIndex,
  // New exports
  isDST,
  toET,
  fromET,
  loadContinuousOHLCV,
  load1sWindow,
  load1sRange,
  getAsianCandles,
  getEuropeanCandles,
  getRTHCandlesFromArray,
  getOvernightCandlesFromArray,
  loadIntradayGEX,
  getGEXSnapshotAt,
  extractTradingDates,
  getPrevDayLevelsFromArray,
  loadLTLevels,
  getLTSnapshotAt
};
