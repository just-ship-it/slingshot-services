#!/usr/bin/env node

/**
 * NQ Overnight Move Analysis
 *
 * Analyzes overnight NQ futures moves (6PM-8:30AM EST) conditioned on:
 * - EOD GEX positioning (regime, level proximity, total GEX)
 * - GEX level first touches (with time-decay analysis)
 * - LT level dynamics
 * - Session window returns
 * - Day of week / OpEx cycle
 *
 * Data sources:
 * - NQ OHLCV 1m (backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m.csv)
 * - GEX daily levels (backtest-engine/data/gex/nq/NQ_gex_levels.csv)
 * - GEX intraday JSON (backtest-engine/data/gex/nq/nq_gex_*.json)
 * - LT levels (backtest-engine/data/liquidity/nq/NQ_liquidity_levels.csv)
 */

import fs from 'fs';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'backtest-engine/data');

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  // GEX level proximity for "touch" detection (points)
  touchProximity: 5,
  // Overnight move thresholds (points) for classification
  upThreshold: 10,
  downThreshold: -10,
  // Analysis date range (aligned with GEX data availability)
  startDate: '2023-03-28',
  endDate: '2026-01-28',
  // First-touch bounce/break analysis window (minutes after touch)
  touchOutcomeWindow: 60,
  // Bounce = price moves X pts favorable from touch level
  bounceThreshold: 7,
  // Break = price moves X pts through the level
  breakThreshold: 5,
};

// ─── Timezone Helpers ────────────────────────────────────────────────────────

/**
 * Determine if a UTC date falls within US Eastern Daylight Time
 * DST: Second Sunday of March 2AM → First Sunday of November 2AM
 */
function isDST(utcDate) {
  const year = utcDate.getUTCFullYear();
  // Second Sunday of March
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const marchSecondSunday = new Date(Date.UTC(year, 2, 8 + (7 - marchFirst.getUTCDay()) % 7));
  marchSecondSunday.setUTCHours(7); // 2AM EST = 7AM UTC
  // First Sunday of November
  const novFirst = new Date(Date.UTC(year, 10, 1));
  const novFirstSunday = new Date(Date.UTC(year, 10, 1 + (7 - novFirst.getUTCDay()) % 7));
  novFirstSunday.setUTCHours(6); // 2AM EDT = 6AM UTC
  return utcDate >= marchSecondSunday && utcDate < novFirstSunday;
}

/**
 * Get EST decimal hours (0-24) from a UTC timestamp
 */
function getESTHour(utcTimestamp) {
  const d = new Date(utcTimestamp);
  const offset = isDST(d) ? -4 : -5;
  const estMs = utcTimestamp + offset * 3600000;
  const estDate = new Date(estMs);
  return estDate.getUTCHours() + estDate.getUTCMinutes() / 60;
}

/**
 * Get EST Date object from UTC timestamp
 */
function toESTDate(utcTimestamp) {
  const d = new Date(utcTimestamp);
  const offset = isDST(d) ? -4 : -5;
  return new Date(utcTimestamp + offset * 3600000);
}

/**
 * Get the trading date string (YYYY-MM-DD) for a UTC timestamp.
 * Trading day starts at 6PM EST previous calendar day.
 * e.g., 7PM EST on March 28 belongs to the March 28 trading date.
 * e.g., 2AM EST on March 29 belongs to the March 28 trading date (overnight).
 */
function getTradingDate(utcTimestamp) {
  const estDate = toESTDate(utcTimestamp);
  const hour = estDate.getUTCHours();
  // If before 5PM EST, it belongs to the current calendar date's trading day
  // If after 5PM EST, it belongs to the current calendar date's trading day (overnight start)
  // The key boundary: 5PM EST marks end of one trading day, 6PM starts the next session
  if (hour < 17) {
    // Before 5PM: this is part of today's trading day (RTH or early overnight)
    // But if it's between midnight and 5PM, it's the previous day's overnight
    if (hour < 9.5) {
      // Before 9:30 AM — this is overnight/premarket from PREVIOUS trading date
      const prevDay = new Date(estDate.getTime() - 86400000);
      return prevDay.toISOString().split('T')[0];
    }
    return estDate.toISOString().split('T')[0];
  }
  // After 5PM: this is the start of tonight's overnight
  return estDate.toISOString().split('T')[0];
}

/**
 * Classify session window for a UTC timestamp
 */
function getSession(utcTimestamp) {
  const estHour = getESTHour(utcTimestamp);
  if (estHour >= 16 && estHour < 18) return 'afterhours';
  if (estHour >= 18 && estHour < 20) return 'evening';
  if (estHour >= 20 || estHour < 2) return 'dead_zone';
  if (estHour >= 2 && estHour < 5) return 'european';
  if (estHour >= 5 && estHour < 9.5) return 'premarket';
  if (estHour >= 9.5 && estHour < 16) return 'rth';
  return 'unknown';
}

/**
 * Get day of week name from EST date
 */
function getDayOfWeek(utcTimestamp) {
  const estDate = toESTDate(utcTimestamp);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[estDate.getUTCDay()];
}

// ─── Data Loading ────────────────────────────────────────────────────────────

/**
 * Load NQ OHLCV 1m data using streaming (memory efficient)
 *
 * Contract rollover handling:
 * The per-hour primary contract filter causes false price jumps during rollover
 * weeks when volume oscillates between old/new contracts in thin overnight liquidity.
 * Instead, we determine the primary contract from RTH volume (high volume, clean
 * selection) and apply it to the entire overnight session. This prevents mid-overnight
 * contract switches that would create artificial 100-250pt price discontinuities.
 */
async function loadOHLCV() {
  const filePath = path.join(DATA_DIR, 'ohlcv/nq/NQ_ohlcv_1m.csv');
  console.log(`Loading OHLCV data from ${filePath}...`);

  const startMs = new Date(CONFIG.startDate + 'T00:00:00Z').getTime() - 2 * 86400000; // 2 days before for context
  const endMs = new Date(CONFIG.endDate + 'T23:59:59Z').getTime() + 2 * 86400000;

  // Pass 1: Collect all candles in range
  const rawCandles = [];

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  let isHeader = true;
  let totalRead = 0;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    totalRead++;

    const parts = line.split(',');
    if (parts.length < 10) continue;

    const symbol = parts[9]?.trim();
    // Skip calendar spreads
    if (!symbol || symbol.includes('-')) continue;

    const timestamp = new Date(parts[0]).getTime();
    if (isNaN(timestamp) || timestamp < startMs || timestamp > endMs) continue;

    const open = parseFloat(parts[4]);
    const high = parseFloat(parts[5]);
    const low = parseFloat(parts[6]);
    const close = parseFloat(parts[7]);
    const volume = parseFloat(parts[8]);

    // Skip corrupted candles
    if (isNaN(open) || isNaN(close)) continue;
    if (open === high && high === low && low === close && volume <= 2) continue;

    rawCandles.push({ timestamp, open, high, low, close, volume, symbol });

    if (totalRead % 500000 === 0) {
      console.log(`  Read ${(totalRead / 1e6).toFixed(1)}M lines...`);
    }
  }

  console.log(`  Read ${rawCandles.length.toLocaleString()} valid candles from ${(totalRead / 1e6).toFixed(1)}M total lines`);

  // Pass 2: Determine primary contract per TRADING DAY using RTH volume only
  // RTH hours: 9:30 AM - 4:00 PM EST (13:30 - 21:00 UTC winter, 13:30 - 20:00 UTC summer)
  // We use the calendar date (EST) of the RTH session as the key
  const rthVolumeByDate = new Map(); // dateStr -> Map<symbol, totalVolume>

  for (const candle of rawCandles) {
    const estHour = getESTHour(candle.timestamp);
    if (estHour < 9.5 || estHour >= 16) continue; // RTH only

    const estDate = toESTDate(candle.timestamp);
    const dateStr = estDate.toISOString().split('T')[0];

    if (!rthVolumeByDate.has(dateStr)) rthVolumeByDate.set(dateStr, new Map());
    const dv = rthVolumeByDate.get(dateStr);
    dv.set(candle.symbol, (dv.get(candle.symbol) || 0) + candle.volume);
  }

  // Build map of dateStr -> primary contract symbol
  const primaryByDate = new Map();
  for (const [dateStr, symbolVols] of rthVolumeByDate) {
    let primarySymbol = '';
    let maxVol = 0;
    for (const [sym, vol] of symbolVols) {
      if (vol > maxVol) { maxVol = vol; primarySymbol = sym; }
    }
    primaryByDate.set(dateStr, primarySymbol);
  }

  console.log(`  Identified primary contracts for ${primaryByDate.size} trading dates`);

  // Log rollover dates
  let prevPrimary = null;
  for (const [dateStr, sym] of [...primaryByDate.entries()].sort()) {
    if (prevPrimary && sym !== prevPrimary) {
      console.log(`  Rollover: ${prevPrimary} -> ${sym} on ${dateStr}`);
    }
    prevPrimary = sym;
  }

  // Pass 3: Filter candles — use RTH primary contract for entire trading day + overnight
  // Overnight candles (6PM-9:30AM) use the SAME contract as the preceding RTH session
  const candles = [];
  for (const candle of rawCandles) {
    const estHour = getESTHour(candle.timestamp);
    const estDate = toESTDate(candle.timestamp);

    let tradingDateStr;
    if (estHour >= 9.5 && estHour < 18) {
      // RTH + afterhours: use today's date
      tradingDateStr = estDate.toISOString().split('T')[0];
    } else if (estHour >= 18) {
      // Evening/overnight start: use today's date (overnight belongs to today's trading day)
      tradingDateStr = estDate.toISOString().split('T')[0];
    } else {
      // Before 9:30 AM (overnight continuation / premarket): belongs to PREVIOUS day's trading session
      const prevDay = new Date(estDate.getTime() - 86400000);
      tradingDateStr = prevDay.toISOString().split('T')[0];
    }

    const primary = primaryByDate.get(tradingDateStr);
    if (!primary) {
      // No RTH data for this trading date (weekend/holiday) — try adjacent days
      // Look back up to 3 days to find the most recent primary
      for (let offset = 1; offset <= 3; offset++) {
        const lookback = new Date(new Date(tradingDateStr).getTime() - offset * 86400000).toISOString().split('T')[0];
        const fallback = primaryByDate.get(lookback);
        if (fallback) {
          if (candle.symbol === fallback) candles.push(candle);
          break;
        }
      }
      continue;
    }

    if (candle.symbol === primary) candles.push(candle);
  }

  // Sort by timestamp
  candles.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  ${candles.length.toLocaleString()} candles after trading-day primary contract filter`);

  // Verify no mid-overnight contract switches
  let switchCount = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].symbol !== candles[i - 1].symbol) {
      const gap = Math.abs(candles[i].open - candles[i - 1].close);
      const session = getSession(candles[i].timestamp);
      if (session !== 'rth' && session !== 'afterhours' && gap > 50) {
        switchCount++;
      }
    }
  }
  if (switchCount > 0) {
    console.log(`  ⚠️  ${switchCount} overnight contract switches with >50pt gap detected (investigate)`);
  } else {
    console.log(`  ✅ No overnight contract switches with large gaps`);
  }

  return candles;
}

/**
 * Load GEX daily levels from CSV
 */
async function loadGEXDaily() {
  const filePath = path.join(DATA_DIR, 'gex/nq/NQ_gex_levels.csv');
  console.log(`Loading GEX daily levels from ${filePath}...`);

  const data = new Map();
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  let isHeader = true;
  let headers = [];

  for await (const line of rl) {
    if (isHeader) {
      headers = line.split(',');
      isHeader = false;
      continue;
    }
    const parts = line.split(',');
    const date = parts[0];
    data.set(date, {
      date,
      gamma_flip: parseFloat(parts[1]) || null,
      put_wall_1: parseFloat(parts[2]) || null,
      put_wall_2: parseFloat(parts[3]) || null,
      put_wall_3: parseFloat(parts[4]) || null,
      call_wall_1: parseFloat(parts[5]) || null,
      call_wall_2: parseFloat(parts[6]) || null,
      call_wall_3: parseFloat(parts[7]) || null,
      total_gex: parseFloat(parts[10]) || null,
      regime: parts[11]?.trim() || null,
    });
  }

  console.log(`  Loaded ${data.size} daily GEX records`);
  return data;
}

/**
 * Load the last GEX intraday snapshot for each date (EOD state)
 */
async function loadGEXIntraday() {
  const dir = path.join(DATA_DIR, 'gex/nq');
  console.log(`Loading GEX intraday snapshots from ${dir}...`);

  const files = fs.readdirSync(dir).filter(f => f.match(/^nq_gex_\d{4}-\d{2}-\d{2}\.json$/));
  const data = new Map();

  for (const file of files) {
    const date = file.match(/(\d{4}-\d{2}-\d{2})/)[1];
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
      if (json.data && json.data.length > 0) {
        // Get the last snapshot (closest to EOD)
        const lastSnapshot = json.data[json.data.length - 1];
        data.set(date, {
          timestamp: lastSnapshot.timestamp,
          gamma_flip: lastSnapshot.gamma_flip,
          call_wall: lastSnapshot.call_wall,
          put_wall: lastSnapshot.put_wall,
          total_gex: lastSnapshot.total_gex,
          regime: lastSnapshot.regime,
          resistance: lastSnapshot.resistance || [],
          support: lastSnapshot.support || [],
          nq_spot: lastSnapshot.nq_spot,
        });
      }
    } catch (e) {
      // Skip corrupt files
    }
  }

  console.log(`  Loaded ${data.size} intraday EOD snapshots`);
  return data;
}

/**
 * Load LT levels from CSV, indexed by 15-min bucket
 */
async function loadLTLevels() {
  const filePath = path.join(DATA_DIR, 'liquidity/nq/NQ_liquidity_levels.csv');
  console.log(`Loading LT levels from ${filePath}...`);

  const data = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  let isHeader = true;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    const parts = line.split(',');
    const datetime = parts[0];
    // Parse as UTC (LT data appears to be in UTC based on timestamps)
    const timestamp = new Date(datetime.replace(' ', 'T') + 'Z').getTime();
    if (isNaN(timestamp)) continue;

    data.push({
      timestamp,
      sentiment: parts[2],
      levels: [
        parseFloat(parts[3]) || null,
        parseFloat(parts[4]) || null,
        parseFloat(parts[5]) || null,
        parseFloat(parts[6]) || null,
        parseFloat(parts[7]) || null,
      ],
    });
  }

  // Sort by timestamp
  data.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  Loaded ${data.length.toLocaleString()} LT level records`);
  return data;
}

// ─── Analysis Core ───────────────────────────────────────────────────────────

/**
 * Build overnight sessions from OHLCV candles
 * Each session: 6PM EST Day N → 8:30AM EST Day N+1
 * Returns Map<tradingDate, OvernightSession>
 */
function buildOvernightSessions(candles, gexDaily, gexIntraday) {
  console.log('\nBuilding overnight sessions...');

  // First, find RTH close and overnight candles per trading date
  // A trading date's RTH: 9:30AM-4PM EST on that date
  // A trading date's overnight: 6PM EST on that date → 8:30AM EST next date

  const sessions = new Map();

  for (const candle of candles) {
    const estHour = getESTHour(candle.timestamp);
    const session = getSession(candle.timestamp);

    if (session === 'rth') {
      // Find which trading date this belongs to
      const estDate = toESTDate(candle.timestamp);
      const dateStr = estDate.toISOString().split('T')[0];
      if (!sessions.has(dateStr)) {
        sessions.set(dateStr, {
          date: dateStr,
          rthCandles: [],
          overnightCandles: [],
          rthClose: null,
          rthCloseTime: null,
        });
      }
      sessions.get(dateStr).rthCandles.push(candle);
    }

    if (session === 'evening' || session === 'dead_zone' || session === 'european' || session === 'premarket') {
      // Determine which trading date's overnight this belongs to
      // Evening (6-8PM) → same calendar date
      // Dead zone (8PM-midnight) → same calendar date
      // Dead zone (midnight-2AM) → previous calendar date
      // European (2-5AM) → previous calendar date
      // Premarket (5-8:30AM) → previous calendar date
      const estDate = toESTDate(candle.timestamp);
      let dateStr;
      if (estHour >= 18) {
        // 6PM+ on same day
        dateStr = estDate.toISOString().split('T')[0];
      } else {
        // Before 6PM (but in overnight session) = previous day's overnight
        const prevDay = new Date(estDate.getTime() - 86400000);
        dateStr = prevDay.toISOString().split('T')[0];
      }

      if (!sessions.has(dateStr)) {
        sessions.set(dateStr, {
          date: dateStr,
          rthCandles: [],
          overnightCandles: [],
          rthClose: null,
          rthCloseTime: null,
        });
      }
      sessions.get(dateStr).overnightCandles.push(candle);
    }
  }

  // For each session, compute RTH close
  for (const [dateStr, sess] of sessions) {
    if (sess.rthCandles.length > 0) {
      // Sort RTH candles by timestamp, take the last one
      sess.rthCandles.sort((a, b) => a.timestamp - b.timestamp);
      const lastRTH = sess.rthCandles[sess.rthCandles.length - 1];
      sess.rthClose = lastRTH.close;
      sess.rthCloseTime = lastRTH.timestamp;
    }
    // Sort overnight candles
    sess.overnightCandles.sort((a, b) => a.timestamp - b.timestamp);
  }

  // Filter to only dates with both RTH close and overnight data
  const validSessions = new Map();
  const startMs = new Date(CONFIG.startDate).getTime();
  const endMs = new Date(CONFIG.endDate).getTime();

  for (const [dateStr, sess] of sessions) {
    const dateMs = new Date(dateStr).getTime();
    if (dateMs < startMs || dateMs > endMs) continue;
    if (sess.rthClose === null || sess.overnightCandles.length < 10) continue;
    validSessions.set(dateStr, sess);
  }

  console.log(`  Built ${validSessions.size} valid overnight sessions`);
  return validSessions;
}

/**
 * Analyze a single overnight session
 */
function analyzeNight(sess, gexDaily, gexIntraday, ltLevels) {
  const { date, rthClose, overnightCandles } = sess;
  if (overnightCandles.length === 0) return null;

  const firstCandle = overnightCandles[0];
  const lastCandle = overnightCandles[overnightCandles.length - 1];

  // Overnight open = first overnight candle's open
  const overnightOpen = firstCandle.open;
  // Overnight final = last candle's close (at ~8:30AM)
  const overnightFinal = lastCandle.close;
  // Overnight return from RTH close
  const overnightReturn = overnightFinal - rthClose;
  // Return from overnight open (6PM)
  const returnFrom6pm = overnightFinal - overnightOpen;

  // Overnight high/low
  let overnightHigh = -Infinity;
  let overnightLow = Infinity;
  for (const c of overnightCandles) {
    if (c.high > overnightHigh) overnightHigh = c.high;
    if (c.low < overnightLow) overnightLow = c.low;
  }
  const overnightRange = overnightHigh - overnightLow;

  // Max favorable / adverse excursion from RTH close
  const maxUp = overnightHigh - rthClose;
  const maxDown = rthClose - overnightLow;

  // Session window returns
  const windowReturns = computeSessionWindowReturns(overnightCandles, rthClose);

  // GEX data for this date
  const gex = gexIntraday.get(date) || gexDaily.get(date) || null;

  // GEX level first-touch analysis
  const gexTouches = gex ? analyzeGEXTouches(overnightCandles, gex, rthClose) : null;

  // LT level analysis at overnight start
  const ltAtStart = findLTSnapshot(ltLevels, firstCandle.timestamp);

  // Day of week (of the RTH date)
  const dayOfWeek = getDayOfWeek(sess.rthCloseTime || firstCandle.timestamp);

  // Classification
  let direction;
  if (overnightReturn > CONFIG.upThreshold) direction = 'UP';
  else if (overnightReturn < CONFIG.downThreshold) direction = 'DOWN';
  else direction = 'RANGE';

  return {
    date,
    dayOfWeek,
    rthClose,
    overnightOpen,
    overnightFinal,
    overnightReturn,
    returnFrom6pm,
    overnightHigh,
    overnightLow,
    overnightRange,
    maxUp,
    maxDown,
    direction,
    gex: gex ? {
      regime: gex.regime,
      total_gex: gex.total_gex,
      gamma_flip: gex.gamma_flip,
      put_wall: gex.put_wall || gex.put_wall_1,
      call_wall: gex.call_wall || gex.call_wall_1,
      support: gex.support || [gex.put_wall_1, gex.put_wall_2, gex.put_wall_3].filter(Boolean),
      resistance: gex.resistance || [gex.call_wall_1, gex.call_wall_2, gex.call_wall_3].filter(Boolean),
      gfDistFromClose: gex.gamma_flip ? rthClose - gex.gamma_flip : null,
      s1DistFromClose: (gex.support?.[0] || gex.put_wall_1) ? rthClose - (gex.support?.[0] || gex.put_wall_1) : null,
      r1DistFromClose: (gex.resistance?.[0] || gex.call_wall_1) ? (gex.resistance?.[0] || gex.call_wall_1) - rthClose : null,
    } : null,
    gexTouches,
    ltAtStart: ltAtStart ? {
      sentiment: ltAtStart.sentiment,
      levels: ltAtStart.levels,
    } : null,
    windowReturns,
    candleCount: overnightCandles.length,
  };
}

/**
 * Compute returns for each session window
 */
function computeSessionWindowReturns(overnightCandles, rthClose) {
  const windows = {
    evening: { candles: [], start: null, end: null },     // 6-8 PM
    dead_zone: { candles: [], start: null, end: null },   // 8 PM - 2 AM
    european: { candles: [], start: null, end: null },    // 2-5 AM
    premarket: { candles: [], start: null, end: null },   // 5-8:30 AM
  };

  for (const c of overnightCandles) {
    const session = getSession(c.timestamp);
    if (windows[session]) {
      windows[session].candles.push(c);
    }
  }

  const result = {};
  let prevWindowEnd = rthClose;

  for (const [name, w] of Object.entries(windows)) {
    if (w.candles.length > 0) {
      w.candles.sort((a, b) => a.timestamp - b.timestamp);
      const first = w.candles[0];
      const last = w.candles[w.candles.length - 1];
      result[name] = {
        return: last.close - first.open,
        returnFromClose: last.close - rthClose,
        open: first.open,
        close: last.close,
        high: Math.max(...w.candles.map(c => c.high)),
        low: Math.min(...w.candles.map(c => c.low)),
        candles: w.candles.length,
      };
      prevWindowEnd = last.close;
    } else {
      result[name] = null;
    }
  }

  return result;
}

/**
 * Analyze GEX level touches during overnight session.
 * Tracks first touch (highest signal) and subsequent touches to measure absorption.
 * Key insight: first touch since market close is the strongest signal — subsequent
 * touches get absorbed as the level acts as a liquidity sponge.
 */
function analyzeGEXTouches(overnightCandles, gex, rthClose) {
  const proximity = CONFIG.touchProximity;
  const levels = {};

  // Build level map
  const allLevels = [];
  if (gex.gamma_flip) allLevels.push({ name: 'gamma_flip', price: gex.gamma_flip, type: 'neutral' });

  const support = gex.support || [gex.put_wall_1, gex.put_wall_2, gex.put_wall_3].filter(Boolean);
  const resistance = gex.resistance || [gex.call_wall_1, gex.call_wall_2, gex.call_wall_3].filter(Boolean);

  support.forEach((p, i) => { if (p) allLevels.push({ name: `S${i + 1}`, price: p, type: 'support' }); });
  resistance.forEach((p, i) => { if (p) allLevels.push({ name: `R${i + 1}`, price: p, type: 'resistance' }); });

  for (const level of allLevels) {
    const distFromClose = Math.abs(rthClose - level.price);

    // Skip levels that are extremely far from close (>500 pts)
    if (distFromClose > 500) continue;

    // Track ALL touches (episodes where price enters proximity zone)
    // A "touch episode" starts when price enters the zone and ends when it leaves
    const touches = [];
    let inZone = false;
    let episodeStart = null;
    let episodeCandles = [];

    for (let i = 0; i < overnightCandles.length; i++) {
      const c = overnightCandles[i];
      const inProximity = c.low <= level.price + proximity && c.high >= level.price - proximity;

      if (inProximity && !inZone) {
        // Entering zone — new touch episode
        inZone = true;
        episodeStart = i;
        episodeCandles = [c];
      } else if (inProximity && inZone) {
        // Still in zone
        episodeCandles.push(c);
      } else if (!inProximity && inZone) {
        // Left zone — close this episode
        inZone = false;
        touches.push({
          startIdx: episodeStart,
          endIdx: i - 1,
          startCandle: overnightCandles[episodeStart],
          durationMinutes: episodeCandles.length,
          minutesIntoSession: (overnightCandles[episodeStart].timestamp - overnightCandles[0].timestamp) / 60000,
          session: getSession(overnightCandles[episodeStart].timestamp),
        });
        episodeCandles = [];
      }
    }
    // Close final episode if still in zone at end
    if (inZone && episodeCandles.length > 0) {
      touches.push({
        startIdx: episodeStart,
        endIdx: overnightCandles.length - 1,
        startCandle: overnightCandles[episodeStart],
        durationMinutes: episodeCandles.length,
        minutesIntoSession: (overnightCandles[episodeStart].timestamp - overnightCandles[0].timestamp) / 60000,
        session: getSession(overnightCandles[episodeStart].timestamp),
      });
    }

    if (touches.length === 0) {
      levels[level.name] = { price: level.price, type: level.type, distFromClose, touched: false, touchCount: 0 };
      continue;
    }

    // Analyze FIRST touch outcome (highest signal)
    const firstTouch = touches[0];
    const firstTouchOutcome = analyzeTouchOutcome(overnightCandles, firstTouch.startIdx, level);

    // Analyze subsequent touches to measure absorption
    const subsequentBounces = [];
    for (let t = 1; t < touches.length; t++) {
      const outcome = analyzeTouchOutcome(overnightCandles, touches[t].startIdx, level);
      subsequentBounces.push(outcome);
    }

    const subsequentBounceRate = subsequentBounces.length > 0
      ? subsequentBounces.filter(o => o.bounced).length / subsequentBounces.length
      : null;

    levels[level.name] = {
      price: level.price,
      type: level.type,
      distFromClose,
      touched: true,
      touchCount: touches.length,
      // First touch details
      firstTouchTime: new Date(firstTouch.startCandle.timestamp).toISOString(),
      firstTouchSession: firstTouch.session,
      minutesIntoSession: Math.round(firstTouch.minutesIntoSession),
      bounced: firstTouchOutcome.bounced,
      broke: firstTouchOutcome.broke,
      maxFavorable: firstTouchOutcome.maxFavorable,
      maxAdverse: firstTouchOutcome.maxAdverse,
      // Absorption analysis
      avgTouchDuration: Math.round(mean(touches.map(t => t.durationMinutes))),
      subsequentTouchCount: touches.length - 1,
      subsequentBounceRate: subsequentBounceRate !== null ? Math.round(subsequentBounceRate * 100) : null,
      // First touch is stronger signal than subsequent touches?
      firstTouchVsSubsequent: subsequentBounceRate !== null
        ? (firstTouchOutcome.bounced ? 1 : 0) > subsequentBounceRate ? 'first_stronger' : 'absorbed'
        : 'only_touch',
    };
  }

  return levels;
}

/**
 * Analyze the outcome of a specific touch episode
 */
function analyzeTouchOutcome(candles, touchIdx, level) {
  const postTouchCandles = candles.slice(touchIdx, touchIdx + CONFIG.touchOutcomeWindow);
  let maxFavorable = 0;
  let maxAdverse = 0;
  let bounced = false;
  let broke = false;

  for (const pc of postTouchCandles) {
    if (level.type === 'support') {
      const favorable = pc.high - level.price;
      const adverse = level.price - pc.low;
      if (favorable > maxFavorable) maxFavorable = favorable;
      if (adverse > maxAdverse) maxAdverse = adverse;
      if (favorable >= CONFIG.bounceThreshold) bounced = true;
      if (adverse >= CONFIG.breakThreshold) broke = true;
    } else if (level.type === 'resistance') {
      const favorable = level.price - pc.low;
      const adverse = pc.high - level.price;
      if (favorable > maxFavorable) maxFavorable = favorable;
      if (adverse > maxAdverse) maxAdverse = adverse;
      if (favorable >= CONFIG.bounceThreshold) bounced = true;
      if (adverse >= CONFIG.breakThreshold) broke = true;
    } else {
      const moveUp = pc.high - level.price;
      const moveDown = level.price - pc.low;
      maxFavorable = Math.max(moveUp, moveDown);
    }
  }

  return {
    bounced,
    broke,
    maxFavorable: Math.round(maxFavorable * 100) / 100,
    maxAdverse: Math.round(maxAdverse * 100) / 100,
  };
}

/**
 * Find the LT snapshot closest to (but not after) a given timestamp
 */
function findLTSnapshot(ltLevels, timestamp) {
  // Binary search for the closest LT snapshot at or before timestamp
  let lo = 0, hi = ltLevels.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ltLevels[mid].timestamp <= timestamp) {
      best = ltLevels[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// ─── Statistics Helpers ──────────────────────────────────────────────────────

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / (arr.length - 1));
}
function pctPositive(arr) { return arr.length ? (arr.filter(x => x > 0).length / arr.length * 100) : 0; }
function winRate(arr, threshold = 0) { return arr.length ? (arr.filter(x => x > threshold).length / arr.length * 100) : 0; }

function formatPts(n) { return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2); }
function formatPct(n) { return `${n.toFixed(1)}%`; }

function printStats(label, returns) {
  if (returns.length === 0) { console.log(`  ${label}: NO DATA`); return; }
  console.log(`  ${label} (N=${returns.length}):`);
  console.log(`    Mean: ${formatPts(mean(returns))} | Median: ${formatPts(median(returns))} | StdDev: ${stddev(returns).toFixed(2)}`);
  console.log(`    Positive: ${formatPct(pctPositive(returns))} | Range: [${formatPts(Math.min(...returns))}, ${formatPts(Math.max(...returns))}]`);
}

// ─── Report Generation ───────────────────────────────────────────────────────

function generateReport(nights) {
  console.log('\n' + '═'.repeat(80));
  console.log('  NQ OVERNIGHT MOVE ANALYSIS');
  console.log('  Period: ' + CONFIG.startDate + ' to ' + CONFIG.endDate);
  console.log('  Nights analyzed: ' + nights.length);
  console.log('═'.repeat(80));

  const returns = nights.map(n => n.overnightReturn);
  const returnsFrom6pm = nights.map(n => n.returnFrom6pm);
  const ranges = nights.map(n => n.overnightRange);

  // ── 1. Baseline Stats ──
  console.log('\n── BASELINE OVERNIGHT STATS (RTH Close → 8:30AM) ──');
  printStats('All nights', returns);
  console.log(`    UP (>${CONFIG.upThreshold}pts): ${formatPct(nights.filter(n => n.direction === 'UP').length / nights.length * 100)} (${nights.filter(n => n.direction === 'UP').length})`);
  console.log(`    DOWN (<${CONFIG.downThreshold}pts): ${formatPct(nights.filter(n => n.direction === 'DOWN').length / nights.length * 100)} (${nights.filter(n => n.direction === 'DOWN').length})`);
  console.log(`    RANGE: ${formatPct(nights.filter(n => n.direction === 'RANGE').length / nights.length * 100)} (${nights.filter(n => n.direction === 'RANGE').length})`);
  console.log(`    Avg overnight range: ${mean(ranges).toFixed(1)} pts`);

  // ── 2. GEX Regime Conditioning ──
  console.log('\n── BY GEX REGIME ──');
  const withGex = nights.filter(n => n.gex);
  const posGex = withGex.filter(n => n.gex.regime === 'positive');
  const negGex = withGex.filter(n => n.gex.regime === 'negative');
  printStats('Positive GEX', posGex.map(n => n.overnightReturn));
  console.log(`    Avg range: ${mean(posGex.map(n => n.overnightRange)).toFixed(1)} pts`);
  console.log(`    UP: ${formatPct(posGex.filter(n => n.direction === 'UP').length / posGex.length * 100)} | DOWN: ${formatPct(posGex.filter(n => n.direction === 'DOWN').length / posGex.length * 100)} | RANGE: ${formatPct(posGex.filter(n => n.direction === 'RANGE').length / posGex.length * 100)}`);
  printStats('Negative GEX', negGex.map(n => n.overnightReturn));
  console.log(`    Avg range: ${mean(negGex.map(n => n.overnightRange)).toFixed(1)} pts`);
  console.log(`    UP: ${formatPct(negGex.filter(n => n.direction === 'UP').length / negGex.length * 100)} | DOWN: ${formatPct(negGex.filter(n => n.direction === 'DOWN').length / negGex.length * 100)} | RANGE: ${formatPct(negGex.filter(n => n.direction === 'RANGE').length / negGex.length * 100)}`);

  // ── 3. GEX Total GEX Quartiles ──
  console.log('\n── BY TOTAL GEX MAGNITUDE ──');
  const gexVals = withGex.map(n => n.gex.total_gex).filter(v => v !== null).sort((a, b) => a - b);
  if (gexVals.length >= 4) {
    const q1 = gexVals[Math.floor(gexVals.length * 0.25)];
    const q2 = gexVals[Math.floor(gexVals.length * 0.50)];
    const q3 = gexVals[Math.floor(gexVals.length * 0.75)];

    const gexQ1 = withGex.filter(n => n.gex.total_gex !== null && n.gex.total_gex <= q1);
    const gexQ2 = withGex.filter(n => n.gex.total_gex > q1 && n.gex.total_gex <= q2);
    const gexQ3 = withGex.filter(n => n.gex.total_gex > q2 && n.gex.total_gex <= q3);
    const gexQ4 = withGex.filter(n => n.gex.total_gex > q3);

    printStats(`Q1 (lowest GEX, <${(q1 / 1e9).toFixed(1)}B)`, gexQ1.map(n => n.overnightReturn));
    printStats(`Q2 (${(q1 / 1e9).toFixed(1)}B to ${(q2 / 1e9).toFixed(1)}B)`, gexQ2.map(n => n.overnightReturn));
    printStats(`Q3 (${(q2 / 1e9).toFixed(1)}B to ${(q3 / 1e9).toFixed(1)}B)`, gexQ3.map(n => n.overnightReturn));
    printStats(`Q4 (highest GEX, >${(q3 / 1e9).toFixed(1)}B)`, gexQ4.map(n => n.overnightReturn));
  }

  // ── 4. GEX Level Proximity at Close ──
  console.log('\n── GEX LEVEL PROXIMITY AT CLOSE ──');
  const proximityBins = [25, 50, 100, 200];

  for (const levelName of ['S1', 'gamma_flip', 'R1']) {
    console.log(`\n  ${levelName} proximity:`);
    for (const bin of proximityBins) {
      let binNights;
      if (levelName === 'S1') {
        binNights = withGex.filter(n => n.gex.s1DistFromClose !== null && n.gex.s1DistFromClose >= 0 && n.gex.s1DistFromClose <= bin);
      } else if (levelName === 'R1') {
        binNights = withGex.filter(n => n.gex.r1DistFromClose !== null && n.gex.r1DistFromClose >= 0 && n.gex.r1DistFromClose <= bin);
      } else {
        binNights = withGex.filter(n => n.gex.gfDistFromClose !== null && Math.abs(n.gex.gfDistFromClose) <= bin);
      }
      if (binNights.length >= 5) {
        const rets = binNights.map(n => n.overnightReturn);
        console.log(`    Within ${bin}pts (N=${binNights.length}): Mean ${formatPts(mean(rets))} | ${formatPct(pctPositive(rets))} positive | Range: ${mean(binNights.map(n => n.overnightRange)).toFixed(0)}pts`);
      }
    }
  }

  // ── 5. GEX Level First Touches & Absorption ──
  console.log('\n── GEX LEVEL FIRST TOUCHES & ABSORPTION ──');
  console.log('  (First touch = first time price reaches level since RTH close)');
  console.log('  (Absorption = subsequent touches have weaker bounces as level gets "used up")');
  for (const levelName of ['S1', 'S2', 'R1', 'R2', 'gamma_flip']) {
    const touchedNights = withGex.filter(n => n.gexTouches && n.gexTouches[levelName]?.touched);
    const untouchedNights = withGex.filter(n => n.gexTouches && n.gexTouches[levelName] && !n.gexTouches[levelName].touched);

    if (touchedNights.length < 3) continue;

    const touchData = touchedNights.map(n => n.gexTouches[levelName]);
    const bounceRate = touchData.filter(t => t.bounced).length / touchData.length * 100;
    const breakRate = touchData.filter(t => t.broke).length / touchData.length * 100;
    const avgTouchCount = mean(touchData.map(t => t.touchCount));

    console.log(`\n  ${levelName}: Touched ${touchedNights.length}/${touchedNights.length + untouchedNights.length} nights (${(touchedNights.length / (touchedNights.length + untouchedNights.length) * 100).toFixed(0)}%)`);
    console.log(`    FIRST TOUCH bounce: ${formatPct(bounceRate)} | break: ${formatPct(breakRate)}`);
    console.log(`    Avg max favorable: ${mean(touchData.map(t => t.maxFavorable)).toFixed(1)}pts | Avg max adverse: ${mean(touchData.map(t => t.maxAdverse)).toFixed(1)}pts`);
    console.log(`    Avg total touches per night: ${avgTouchCount.toFixed(1)}`);

    // Absorption analysis: first touch vs subsequent touches
    const withSubsequent = touchData.filter(t => t.subsequentBounceRate !== null);
    if (withSubsequent.length >= 5) {
      const firstBounceRate = withSubsequent.filter(t => t.bounced).length / withSubsequent.length * 100;
      const avgSubBounceRate = mean(withSubsequent.map(t => t.subsequentBounceRate));
      const absorbedPct = withSubsequent.filter(t => t.firstTouchVsSubsequent === 'absorbed').length / withSubsequent.length * 100;
      console.log(`    ABSORPTION (nights with 2+ touches, N=${withSubsequent.length}):`);
      console.log(`      First touch bounce: ${formatPct(firstBounceRate)}`);
      console.log(`      Subsequent touch bounce: ${formatPct(avgSubBounceRate)} (${formatPct(absorbedPct)} show absorption)`);
      console.log(`      → ${firstBounceRate > avgSubBounceRate ? 'CONFIRMS: first touch is stronger signal' : 'No clear decay pattern'}`);
    }

    // First touch by session window
    const bySession = {};
    for (const t of touchData) {
      bySession[t.firstTouchSession] = bySession[t.firstTouchSession] || [];
      bySession[t.firstTouchSession].push(t);
    }

    console.log('    First touch by session:');
    for (const [sess, touches] of Object.entries(bySession).sort()) {
      const sessBouncePct = touches.filter(t => t.bounced).length / touches.length * 100;
      console.log(`      ${sess}: ${touches.length} touches | Bounce: ${formatPct(sessBouncePct)} | Avg mins in: ${mean(touches.map(t => t.minutesIntoSession)).toFixed(0)}`);
    }

    // Time decay: early vs late first touches
    const earlyTouches = touchData.filter(t => t.minutesIntoSession <= 120); // first 2 hours
    const lateTouches = touchData.filter(t => t.minutesIntoSession > 120);
    if (earlyTouches.length >= 3 && lateTouches.length >= 3) {
      console.log(`    First touch timing:`);
      console.log(`      Early (first 2hrs): Bounce ${formatPct(earlyTouches.filter(t => t.bounced).length / earlyTouches.length * 100)} (N=${earlyTouches.length})`);
      console.log(`      Late (after 2hrs):  Bounce ${formatPct(lateTouches.filter(t => t.bounced).length / lateTouches.length * 100)} (N=${lateTouches.length})`);
    }
  }

  // ── 6. Session Window Returns ──
  console.log('\n── SESSION WINDOW RETURNS ──');
  for (const window of ['evening', 'dead_zone', 'european', 'premarket']) {
    const windowNights = nights.filter(n => n.windowReturns[window]);
    const windowRets = windowNights.map(n => n.windowReturns[window].return);
    if (windowRets.length > 0) {
      const labels = { evening: '6PM-8PM', dead_zone: '8PM-2AM', european: '2AM-5AM', premarket: '5AM-8:30AM' };
      printStats(labels[window], windowRets);
    }
  }

  // ── 7. Day of Week ──
  console.log('\n── DAY OF WEEK ──');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  for (const day of days) {
    const dayNights = nights.filter(n => n.dayOfWeek === day);
    if (dayNights.length >= 5) {
      const rets = dayNights.map(n => n.overnightReturn);
      console.log(`  ${day} overnight (N=${dayNights.length}): Mean ${formatPts(mean(rets))} | ${formatPct(pctPositive(rets))} positive | Range: ${mean(dayNights.map(n => n.overnightRange)).toFixed(0)}pts`);
    }
  }

  // ── 8. LT Sentiment at Overnight Start ──
  console.log('\n── LT SENTIMENT AT OVERNIGHT START ──');
  const bullishLT = nights.filter(n => n.ltAtStart?.sentiment === 'BULLISH');
  const bearishLT = nights.filter(n => n.ltAtStart?.sentiment === 'BEARISH');
  printStats('BULLISH LT sentiment', bullishLT.map(n => n.overnightReturn));
  printStats('BEARISH LT sentiment', bearishLT.map(n => n.overnightReturn));

  // ── 9. Combined Signal Analysis ──
  console.log('\n── COMBINED SIGNAL ANALYSIS (looking for 60%+ directional accuracy) ──');
  const combos = [];

  // Test various combinations
  const conditions = {
    'Pos GEX': n => n.gex?.regime === 'positive',
    'Neg GEX': n => n.gex?.regime === 'negative',
    'Close near S1 (<50pts)': n => n.gex?.s1DistFromClose >= 0 && n.gex?.s1DistFromClose < 50,
    'Close near R1 (<50pts)': n => n.gex?.r1DistFromClose >= 0 && n.gex?.r1DistFromClose < 50,
    'Close above GF': n => n.gex?.gfDistFromClose > 0,
    'Close below GF': n => n.gex?.gfDistFromClose < 0,
    'Bullish LT': n => n.ltAtStart?.sentiment === 'BULLISH',
    'Bearish LT': n => n.ltAtStart?.sentiment === 'BEARISH',
    'Monday': n => n.dayOfWeek === 'Sunday', // Sunday evening = Monday overnight
    'High GEX (Q4)': n => {
      if (!n.gex?.total_gex || gexVals.length < 4) return false;
      return n.gex.total_gex > gexVals[Math.floor(gexVals.length * 0.75)];
    },
    'Low GEX (Q1)': n => {
      if (!n.gex?.total_gex || gexVals.length < 4) return false;
      return n.gex.total_gex <= gexVals[Math.floor(gexVals.length * 0.25)];
    },
  };

  // Single conditions
  console.log('\n  Single conditions:');
  for (const [name, filter] of Object.entries(conditions)) {
    const filtered = nights.filter(filter);
    if (filtered.length >= 10) {
      const rets = filtered.map(n => n.overnightReturn);
      const upPct = filtered.filter(n => n.direction === 'UP').length / filtered.length * 100;
      const downPct = filtered.filter(n => n.direction === 'DOWN').length / filtered.length * 100;
      const posPct = pctPositive(rets);
      combos.push({ name, n: filtered.length, meanRet: mean(rets), posPct, upPct, downPct });
      const marker = posPct >= 60 ? ' ★' : posPct <= 40 ? ' ★(short)' : '';
      console.log(`    ${name} (N=${filtered.length}): Mean ${formatPts(mean(rets))} | Pos: ${formatPct(posPct)} | UP: ${formatPct(upPct)} | DOWN: ${formatPct(downPct)}${marker}`);
    }
  }

  // Pairwise combinations
  console.log('\n  Pairwise combinations (N>=10, sorted by directional accuracy):');
  const pairResults = [];
  const condNames = Object.keys(conditions);
  for (let i = 0; i < condNames.length; i++) {
    for (let j = i + 1; j < condNames.length; j++) {
      const filtered = nights.filter(n => conditions[condNames[i]](n) && conditions[condNames[j]](n));
      if (filtered.length >= 10) {
        const rets = filtered.map(n => n.overnightReturn);
        const posPct = pctPositive(rets);
        const upPct = filtered.filter(n => n.direction === 'UP').length / filtered.length * 100;
        const downPct = filtered.filter(n => n.direction === 'DOWN').length / filtered.length * 100;
        pairResults.push({
          name: `${condNames[i]} + ${condNames[j]}`,
          n: filtered.length,
          meanRet: mean(rets),
          medianRet: median(rets),
          posPct,
          upPct,
          downPct,
          stdDev: stddev(rets),
        });
      }
    }
  }

  pairResults.sort((a, b) => Math.max(b.posPct, 100 - b.posPct) - Math.max(a.posPct, 100 - a.posPct));
  for (const r of pairResults.slice(0, 20)) {
    const bias = r.posPct >= 60 ? 'LONG' : r.posPct <= 40 ? 'SHORT' : 'neutral';
    const marker = (r.posPct >= 60 || r.posPct <= 40) ? ' ★' : '';
    console.log(`    ${r.name} (N=${r.n}): Mean ${formatPts(r.meanRet)} | Pos: ${formatPct(r.posPct)} | Bias: ${bias}${marker}`);
  }

  // Triple combinations (selective)
  console.log('\n  Triple combinations (N>=10, 60%+ directional only):');
  const tripleResults = [];
  for (let i = 0; i < condNames.length; i++) {
    for (let j = i + 1; j < condNames.length; j++) {
      for (let k = j + 1; k < condNames.length; k++) {
        const filtered = nights.filter(n =>
          conditions[condNames[i]](n) && conditions[condNames[j]](n) && conditions[condNames[k]](n)
        );
        if (filtered.length >= 10) {
          const rets = filtered.map(n => n.overnightReturn);
          const posPct = pctPositive(rets);
          if (posPct >= 60 || posPct <= 40) {
            tripleResults.push({
              name: `${condNames[i]} + ${condNames[j]} + ${condNames[k]}`,
              n: filtered.length,
              meanRet: mean(rets),
              posPct,
              upPct: filtered.filter(n => n.direction === 'UP').length / filtered.length * 100,
              downPct: filtered.filter(n => n.direction === 'DOWN').length / filtered.length * 100,
            });
          }
        }
      }
    }
  }

  tripleResults.sort((a, b) => Math.max(b.posPct, 100 - b.posPct) - Math.max(a.posPct, 100 - a.posPct));
  for (const r of tripleResults.slice(0, 15)) {
    const bias = r.posPct >= 60 ? 'LONG' : 'SHORT';
    console.log(`    ${r.name} (N=${r.n}): Mean ${formatPts(r.meanRet)} | Pos: ${formatPct(r.posPct)} | Bias: ${bias} ★`);
  }

  // ── 10. Summary ──
  console.log('\n── SUMMARY: TOP PREDICTIVE CONDITIONS ──');
  const allResults = [...pairResults, ...tripleResults].filter(r => r.posPct >= 60 || r.posPct <= 40);
  allResults.sort((a, b) => {
    const aStrength = Math.max(a.posPct, 100 - a.posPct);
    const bStrength = Math.max(b.posPct, 100 - b.posPct);
    if (Math.abs(aStrength - bStrength) < 2) return b.n - a.n; // tie-break by sample size
    return bStrength - aStrength;
  });

  for (let i = 0; i < Math.min(10, allResults.length); i++) {
    const r = allResults[i];
    const bias = r.posPct >= 60 ? 'LONG' : 'SHORT';
    const strength = Math.max(r.posPct, 100 - r.posPct);
    console.log(`  ${i + 1}. ${r.name}`);
    console.log(`     Directional: ${formatPct(strength)} ${bias} | Mean: ${formatPts(r.meanRet)} | N=${r.n}`);
  }

  console.log('\n' + '═'.repeat(80));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('NQ Overnight Move Analysis');
  console.log('='.repeat(40));
  console.log(`Analysis period: ${CONFIG.startDate} to ${CONFIG.endDate}\n`);

  // Load all data sources
  const candles = await loadOHLCV();
  const gexDaily = await loadGEXDaily();
  const gexIntraday = await loadGEXIntraday();
  const ltLevels = await loadLTLevels();

  // Build overnight sessions
  const sessions = buildOvernightSessions(candles, gexDaily, gexIntraday);

  // Analyze each night
  console.log('\nAnalyzing overnight sessions...');
  const nights = [];
  let analyzed = 0;

  for (const [dateStr, sess] of sessions) {
    const result = analyzeNight(sess, gexDaily, gexIntraday, ltLevels);
    if (result) {
      nights.push(result);
      analyzed++;
    }
  }

  console.log(`Analyzed ${analyzed} overnight sessions`);

  // Sort by date
  nights.sort((a, b) => a.date.localeCompare(b.date));

  // Generate report
  generateReport(nights);

  // Save detailed data to JSON
  const outputPath = path.join(PROJECT_ROOT, 'scripts/overnight-analysis-results.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    config: CONFIG,
    generated: new Date().toISOString(),
    nightCount: nights.length,
    nights: nights,
  }, null, 2));
  console.log(`\nDetailed results saved to: ${outputPath}`);

  // Save summary CSV
  const csvPath = path.join(PROJECT_ROOT, 'scripts/overnight-analysis-summary.csv');
  const csvHeader = 'date,day_of_week,rth_close,overnight_return,direction,overnight_range,max_up,max_down,gex_regime,total_gex,gf_dist,s1_dist,r1_dist,lt_sentiment,evening_ret,dead_zone_ret,european_ret,premarket_ret';
  const csvRows = nights.map(n => [
    n.date,
    n.dayOfWeek,
    n.rthClose.toFixed(2),
    n.overnightReturn.toFixed(2),
    n.direction,
    n.overnightRange.toFixed(2),
    n.maxUp.toFixed(2),
    n.maxDown.toFixed(2),
    n.gex?.regime || '',
    n.gex?.total_gex ? (n.gex.total_gex / 1e9).toFixed(2) : '',
    n.gex?.gfDistFromClose?.toFixed(2) || '',
    n.gex?.s1DistFromClose?.toFixed(2) || '',
    n.gex?.r1DistFromClose?.toFixed(2) || '',
    n.ltAtStart?.sentiment || '',
    n.windowReturns.evening?.return?.toFixed(2) || '',
    n.windowReturns.dead_zone?.return?.toFixed(2) || '',
    n.windowReturns.european?.return?.toFixed(2) || '',
    n.windowReturns.premarket?.return?.toFixed(2) || '',
  ].join(','));

  fs.writeFileSync(csvPath, csvHeader + '\n' + csvRows.join('\n'));
  console.log(`Summary CSV saved to: ${csvPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
