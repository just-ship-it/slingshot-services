/**
 * LT Candle Structure Deep Analysis
 *
 * Research Question: What happens when LT levels cross relative to full candle
 * structures (not just midpoints)? Specifically:
 *
 *   - "Full candle above LT" = candle.low > LT level (entire structure above)
 *   - "Full candle below LT" = candle.high < LT level (entire structure below)
 *   - "Candle straddling LT" = candle.low <= LT <= candle.high
 *
 * When these STATES TRANSITION (e.g., straddling → full-above), what are the
 * forward returns? We measure without long/short bias — just "what does price
 * do after this structural event?"
 *
 * Analysis dimensions:
 *   - All 5 LT levels independently (Fib 34, 55, 144, 377, 610)
 *   - All transition types (6 possible: AB→BL, AB→ST, ST→AB, ST→BL, BL→AB, BL→ST)
 *   - Forward returns at 5m, 15m, 30m, 1h, 2h, 4h
 *   - MFE/MAE at each horizon
 *   - Sentiment filter (BULLISH vs BEARISH at time of transition)
 *   - Session breakdown (overnight, premarket, RTH)
 *   - Rollover-safe: uses raw contracts + detects contract changes
 *
 * CRITICAL: Uses raw contract OHLCV data (not continuous) because LT levels
 * are in raw contract price space. See CLAUDE.md for details.
 *
 * Usage: cd backtest-engine && node research/lt-candle-structure-analysis.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CSVLoader } from '../src/data/csv-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf-8'));

// ============================================================================
// CONFIGURATION
// ============================================================================
const FORWARD_WINDOWS = [5, 15, 30, 60, 120, 240]; // minutes
const LEVEL_NAMES = ['LT34', 'LT55', 'LT144', 'LT377', 'LT610'];
const LEVEL_KEYS = ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];
const MIN_EVENTS_FOR_STATS = 15;
// Cooldown: after a transition event, ignore same level for this many minutes
const EVENT_COOLDOWN_MINUTES = 15;

// Padding helper (JS doesn't have Python's :>8 syntax)
const R = (v, w) => String(v).padStart(w);
const L = (v, w) => String(v).padEnd(w);

// Date range — use overlap period where both LT and OHLCV data exist
const START_DATE = new Date('2023-04-01');
const END_DATE = new Date('2025-12-25');

// ============================================================================
// TIMEZONE HELPERS
// ============================================================================
function isDST(ms) {
  const d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (m >= 3 && m <= 9) return true;
  if (m === 0 || m === 1 || m === 11) return false;
  if (m === 2) { const fd = new Date(Date.UTC(y, 2, 1)).getUTCDay(); return ms >= Date.UTC(y, 2, fd === 0 ? 8 : 15 - fd, 7); }
  if (m === 10) { const fd = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return ms < Date.UTC(y, 10, fd === 0 ? 1 : 8 - fd, 6); }
  return false;
}
function toEST(ts) { return ts + (isDST(ts) ? -4 : -5) * 3600000; }
function getESTHour(ts) { const d = new Date(toEST(ts)); return d.getUTCHours() + d.getUTCMinutes() / 60; }

function getSession(ts) {
  const h = getESTHour(ts);
  if (h >= 18 || h < 4) return 'overnight';
  if (h >= 4 && h < 9.5) return 'premarket';
  if (h >= 9.5 && h < 16) return 'rth';
  return 'afterhours'; // 16-18
}

function isRollWeek(ts) {
  const d = new Date(toEST(ts));
  const month = d.getUTCMonth();
  if (month !== 2 && month !== 5 && month !== 8 && month !== 11) return false;
  const day = d.getUTCDate();
  return day >= 7 && day <= 21; // Wider window to be safe
}

// ============================================================================
// DATA LOADING
// ============================================================================
async function loadData() {
  console.log('Loading data (raw contracts)...');
  const csvLoader = new CSVLoader(DATA_DIR, CONFIG, { noContinuous: true });

  const { candles: raw } = await csvLoader.loadOHLCVData('NQ', START_DATE, END_DATE);
  const candles = csvLoader.filterPrimaryContract(raw);
  const ltRecords = await csvLoader.loadLiquidityData('NQ', START_DATE, END_DATE);

  console.log(`  ${candles.length.toLocaleString()} candles (1m, primary contract filtered)`);
  console.log(`  ${ltRecords.length.toLocaleString()} LT records (15m)`);
  console.log(`  OHLCV range: ${new Date(candles[0].timestamp).toISOString().slice(0, 10)} to ${new Date(candles[candles.length - 1].timestamp).toISOString().slice(0, 10)}`);
  console.log(`  LT range: ${new Date(ltRecords[0].timestamp).toISOString().slice(0, 10)} to ${new Date(ltRecords[ltRecords.length - 1].timestamp).toISOString().slice(0, 10)}`);

  // Load rollover log for contract transition detection
  const rolloverPath = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_rollover_log.csv');
  const rolloverDates = new Set();
  if (fs.existsSync(rolloverPath)) {
    const lines = fs.readFileSync(rolloverPath, 'utf-8').trim().split('\n').slice(1);
    for (const line of lines) {
      const [date] = line.split(',');
      // Mark rollover date and surrounding days
      const d = new Date(date);
      for (let offset = -1; offset <= 1; offset++) {
        const rd = new Date(d.getTime() + offset * 86400000);
        rolloverDates.add(rd.toISOString().slice(0, 10));
      }
    }
    console.log(`  ${rolloverDates.size} rollover boundary dates flagged`);
  }

  return { candles, ltRecords, rolloverDates };
}

// ============================================================================
// CANDLE STRUCTURE STATE RELATIVE TO LT LEVEL
// ============================================================================
// Returns: 'ABOVE' (full candle above level), 'BELOW' (full candle below), 'STRADDLE'
function getCandleState(candle, levelPrice) {
  if (levelPrice == null || isNaN(levelPrice)) return null;
  if (candle.low > levelPrice) return 'ABOVE';   // Entire candle above LT
  if (candle.high < levelPrice) return 'BELOW';   // Entire candle below LT
  return 'STRADDLE';                               // LT is within candle range
}

// ============================================================================
// TRANSITION DETECTION
// ============================================================================
function detectTransitions(candles, ltRecords, rolloverDates) {
  console.log('\nDetecting candle structure transitions...');

  // Build candle lookup by timestamp
  const candleByTs = new Map();
  const candleArray = []; // sorted array for forward lookups
  for (const c of candles) {
    candleByTs.set(c.timestamp, c);
    candleArray.push(c);
  }

  // Build candle index for binary search
  const candleTimestamps = candleArray.map(c => c.timestamp);

  function findCandleIndex(ts) {
    let lo = 0, hi = candleTimestamps.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candleTimestamps[mid] < ts) lo = mid + 1;
      else hi = mid - 1;
    }
    return lo;
  }

  // Get candle closest to a timestamp (within 2 min tolerance)
  function getCandleAt(ts) {
    const idx = findCandleIndex(ts);
    for (let d = 0; d <= 2; d++) {
      if (idx + d < candleArray.length && Math.abs(candleArray[idx + d].timestamp - ts) <= 120000) return { candle: candleArray[idx + d], idx: idx + d };
      if (idx - d >= 0 && d > 0 && Math.abs(candleArray[idx - d].timestamp - ts) <= 120000) return { candle: candleArray[idx - d], idx: idx - d };
    }
    return null;
  }

  // Measure forward returns from a candle index
  function measureForwardReturns(startIdx, refPrice) {
    const results = {};
    for (const window of FORWARD_WINDOWS) {
      const endIdx = Math.min(startIdx + window, candleArray.length - 1);
      if (endIdx <= startIdx) { results[window] = null; continue; }

      // Actual bars we have in this window
      const actualBars = endIdx - startIdx;
      if (actualBars < window * 0.5) { results[window] = null; continue; } // Not enough data

      // Check for contract rollover in window
      const startSymbol = candleArray[startIdx].symbol;
      let rolledOver = false;
      for (let i = startIdx + 1; i <= endIdx; i++) {
        if (candleArray[i].symbol !== startSymbol) { rolledOver = true; break; }
      }
      if (rolledOver) { results[window] = null; continue; } // Skip — rollover in measurement window

      const endCandle = candleArray[endIdx];
      const returnPts = endCandle.close - refPrice;

      // MFE / MAE over window
      let mfe = 0, mae = 0; // unsigned — we track both directions
      let mfeUp = 0, mfeDn = 0; // signed
      for (let i = startIdx + 1; i <= endIdx; i++) {
        const c = candleArray[i];
        const highDelta = c.high - refPrice;
        const lowDelta = c.low - refPrice;
        if (highDelta > mfeUp) mfeUp = highDelta;
        if (lowDelta < mfeDn) mfeDn = lowDelta;
      }
      mfe = Math.max(mfeUp, -mfeDn); // Largest move in either direction
      mae = Math.min(mfeUp, -mfeDn); // This doesn't quite make sense unsigned... let's track both

      results[window] = {
        returnPts,
        mfeUp,   // max upside from ref
        mfeDn,   // max downside from ref (negative)
        endPrice: endCandle.close,
      };
    }
    return results;
  }

  // Track previous state per level
  const prevState = {};   // levelKey -> state
  const lastEventTs = {}; // levelKey -> last event timestamp (cooldown)

  const events = [];
  let skippedRoll = 0, skippedCooldown = 0, skippedNoCandle = 0;

  for (let i = 1; i < ltRecords.length; i++) {
    const prevLT = ltRecords[i - 1];
    const currLT = ltRecords[i];

    // Skip if gap between snapshots > 30 min (data gap or session break)
    if (currLT.timestamp - prevLT.timestamp > 30 * 60000) {
      // Reset state tracking
      for (const k of LEVEL_KEYS) prevState[k] = null;
      continue;
    }

    // Get candles at both LT timestamps
    const prevMatch = getCandleAt(prevLT.timestamp);
    const currMatch = getCandleAt(currLT.timestamp);
    if (!prevMatch || !currMatch) { skippedNoCandle++; continue; }

    const prevCandle = prevMatch.candle;
    const currCandle = currMatch.candle;

    // Skip rollover dates
    const dateStr = new Date(currLT.timestamp).toISOString().slice(0, 10);
    if (rolloverDates.has(dateStr)) { skippedRoll++; continue; }

    // Skip roll weeks entirely for cleaner data
    if (isRollWeek(currLT.timestamp)) { skippedRoll++; continue; }

    // Skip afterhours dead zone (4-6 PM EST)
    const session = getSession(currLT.timestamp);
    if (session === 'afterhours') continue;

    // Check each level
    for (let li = 0; li < LEVEL_KEYS.length; li++) {
      const levelKey = LEVEL_KEYS[li];
      const levelName = LEVEL_NAMES[li];

      const prevLevel = prevLT[levelKey];
      const currLevel = currLT[levelKey];
      if (prevLevel == null || currLevel == null) continue;

      // Get candle structure states
      const pState = getCandleState(prevCandle, prevLevel);
      const cState = getCandleState(currCandle, currLevel);
      if (!pState || !cState) continue;

      // Initialize state tracking
      if (prevState[levelKey] == null) {
        prevState[levelKey] = pState;
      }

      const fromState = prevState[levelKey];
      const toState = cState;
      prevState[levelKey] = toState;

      // Skip if no transition
      if (fromState === toState) continue;

      // Cooldown check
      if (lastEventTs[levelKey] && (currLT.timestamp - lastEventTs[levelKey]) < EVENT_COOLDOWN_MINUTES * 60000) {
        skippedCooldown++;
        continue;
      }
      lastEventTs[levelKey] = currLT.timestamp;

      // Record transition event
      const refPrice = currCandle.close;
      const forwardReturns = measureForwardReturns(currMatch.idx, refPrice);

      events.push({
        timestamp: currLT.timestamp,
        dateStr,
        session,
        estHour: getESTHour(currLT.timestamp),
        level: levelName,
        levelKey,
        levelPrice: currLevel,
        sentiment: currLT.sentiment,
        transition: `${fromState}→${toState}`,
        fromState,
        toState,
        refPrice,
        candleHigh: currCandle.high,
        candleLow: currCandle.low,
        candleRange: currCandle.high - currCandle.low,
        // How far is the level from the candle?
        levelDistFromClose: currLevel - refPrice,
        levelDistPct: ((currLevel - refPrice) / refPrice) * 100,
        // Level movement
        levelDelta: currLevel - prevLevel,
        forwardReturns,
        symbol: currCandle.symbol,
      });
    }
  }

  console.log(`  ${events.length.toLocaleString()} transition events detected`);
  console.log(`  Skipped: ${skippedRoll} (roll periods), ${skippedCooldown} (cooldown), ${skippedNoCandle} (no candle match)`);
  return events;
}

// ============================================================================
// STATISTICAL HELPERS
// ============================================================================
function calcStats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  const p25 = sorted[Math.floor(n * 0.25)];
  const p75 = sorted[Math.floor(n * 0.75)];
  const skew = n > 2 ? (sorted.reduce((s, v) => s + ((v - mean) / stddev) ** 3, 0) / n) : 0;
  const upCount = values.filter(v => v > 0).length;
  const dnCount = values.filter(v => v < 0).length;
  const upPct = (upCount / n * 100);
  const dnPct = (dnCount / n * 100);
  const tStat = mean / (stddev / Math.sqrt(n));

  return { n, mean, median, stddev, p25, p75, skew, upPct, dnPct, tStat, min: sorted[0], max: sorted[n - 1] };
}

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

function analyzeByTransition(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 1: FORWARD RETURNS BY TRANSITION TYPE (ALL LEVELS COMBINED)');
  console.log('='.repeat(100));
  console.log('Transition notation: ABOVE/BELOW/STRADDLE relative to candle structure');
  console.log('  ABOVE = full candle above LT level (candle.low > LT)');
  console.log('  BELOW = full candle below LT level (candle.high < LT)');
  console.log('  STRADDLE = LT level within candle range\n');

  // Group by transition type
  const byTransition = {};
  for (const e of events) {
    if (!byTransition[e.transition]) byTransition[e.transition] = [];
    byTransition[e.transition].push(e);
  }

  for (const transition of Object.keys(byTransition).sort()) {
    const group = byTransition[transition];
    if (group.length < MIN_EVENTS_FOR_STATS) continue;

    console.log(`\n--- ${transition} (n=${group.length}) ---`);
    console.log(`${R('Window',8)} | ${R('Mean',8)} ${R('Median',8)} ${R('StdDev',8)} | ${R('Up%',6)} ${R('Down%',6)} | ${R('t-stat',7)} | ${R('MFE↑',7)} ${R('MFE↓',7)} | ${R('p25',7)} ${R('p75',7)}`);

    for (const window of FORWARD_WINDOWS) {
      const returns = group.map(e => e.forwardReturns[window]?.returnPts).filter(v => v != null);
      const mfeUps = group.map(e => e.forwardReturns[window]?.mfeUp).filter(v => v != null);
      const mfeDns = group.map(e => e.forwardReturns[window]?.mfeDn).filter(v => v != null);
      if (returns.length < MIN_EVENTS_FOR_STATS) continue;

      const stats = calcStats(returns);
      const avgMfeUp = mfeUps.reduce((s, v) => s + v, 0) / mfeUps.length;
      const avgMfeDn = mfeDns.reduce((s, v) => s + v, 0) / mfeDns.length;

      const sig = Math.abs(stats.tStat) >= 2 ? ' **' : Math.abs(stats.tStat) >= 1.5 ? ' *' : '';
      console.log(`${R(window + 'm',8)} | ${R(stats.mean.toFixed(2),8)} ${R(stats.median.toFixed(2),8)} ${R(stats.stddev.toFixed(2),8)} | ${R(stats.upPct.toFixed(1),6)} ${R(stats.dnPct.toFixed(1),6)} | ${R(stats.tStat.toFixed(2),7)} | ${R(avgMfeUp.toFixed(1),7)} ${R(avgMfeDn.toFixed(1),7)} | ${R(stats.p25.toFixed(1),7)} ${R(stats.p75.toFixed(1),7)}${sig}`);
    }
  }
}

function analyzeByLevel(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 2: FORWARD RETURNS BY LT LEVEL (STRONGEST TRANSITIONS ONLY)');
  console.log('='.repeat(100));
  console.log('Focusing on clean transitions: STRADDLE→ABOVE and STRADDLE→BELOW');
  console.log('(These are "breakout" events where price structure cleanly separates from LT)\n');

  const cleanTransitions = ['STRADDLE→ABOVE', 'STRADDLE→BELOW'];

  for (const levelName of LEVEL_NAMES) {
    console.log(`\n${'#'.repeat(60)}`);
    console.log(`  ${levelName}`);
    console.log(`${'#'.repeat(60)}`);

    for (const transition of cleanTransitions) {
      const group = events.filter(e => e.level === levelName && e.transition === transition);
      if (group.length < MIN_EVENTS_FOR_STATS) {
        console.log(`  ${transition}: n=${group.length} (insufficient data)`);
        continue;
      }

      console.log(`\n  ${transition} (n=${group.length})`);
      console.log(`  ${R('Window',8)} | ${R('Mean',8)} ${R('Median',8)} ${R('StdDev',8)} | ${R('Up%',6)} ${R('Down%',6)} | ${R('t-stat',7)} | ${R('MFE↑',7)} ${R('MFE↓',7)}`);

      for (const window of FORWARD_WINDOWS) {
        const returns = group.map(e => e.forwardReturns[window]?.returnPts).filter(v => v != null);
        const mfeUps = group.map(e => e.forwardReturns[window]?.mfeUp).filter(v => v != null);
        const mfeDns = group.map(e => e.forwardReturns[window]?.mfeDn).filter(v => v != null);
        if (returns.length < MIN_EVENTS_FOR_STATS) continue;

        const stats = calcStats(returns);
        const avgMfeUp = mfeUps.reduce((s, v) => s + v, 0) / mfeUps.length;
        const avgMfeDn = mfeDns.reduce((s, v) => s + v, 0) / mfeDns.length;

        const sig = Math.abs(stats.tStat) >= 2 ? ' **' : Math.abs(stats.tStat) >= 1.5 ? ' *' : '';
        console.log(`  ${R(window + 'm',8)} | ${R(stats.mean.toFixed(2),8)} ${R(stats.median.toFixed(2),8)} ${R(stats.stddev.toFixed(2),8)} | ${R(stats.upPct.toFixed(1),6)} ${R(stats.dnPct.toFixed(1),6)} | ${R(stats.tStat.toFixed(2),7)} | ${R(avgMfeUp.toFixed(1),7)} ${R(avgMfeDn.toFixed(1),7)}${sig}`);
      }
    }
  }
}

function analyzeBySentiment(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 3: SENTIMENT FILTER ANALYSIS');
  console.log('='.repeat(100));
  console.log('Does LT sentiment at time of transition predict direction?\n');

  const cleanTransitions = ['STRADDLE→ABOVE', 'STRADDLE→BELOW', 'BELOW→STRADDLE', 'ABOVE→STRADDLE'];

  for (const sentiment of ['BULLISH', 'BEARISH']) {
    console.log(`\n--- ${sentiment} Sentiment ---`);

    for (const transition of cleanTransitions) {
      const group = events.filter(e => e.sentiment === sentiment && e.transition === transition);
      if (group.length < MIN_EVENTS_FOR_STATS) continue;

      const returns30 = group.map(e => e.forwardReturns[30]?.returnPts).filter(v => v != null);
      const returns60 = group.map(e => e.forwardReturns[60]?.returnPts).filter(v => v != null);
      if (returns30.length < MIN_EVENTS_FOR_STATS) continue;

      const s30 = calcStats(returns30);
      const s60 = returns60.length >= MIN_EVENTS_FOR_STATS ? calcStats(returns60) : null;

      console.log(`  ${transition} (n=${group.length}): 30m mean=${s30.mean.toFixed(2)}pts up=${s30.upPct.toFixed(0)}% t=${s30.tStat.toFixed(2)}${s60 ? ` | 60m mean=${s60.mean.toFixed(2)}pts up=${s60.upPct.toFixed(0)}% t=${s60.tStat.toFixed(2)}` : ''}`);
    }
  }
}

function analyzeBySession(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 4: SESSION BREAKDOWN');
  console.log('='.repeat(100));
  console.log('Which sessions have the strongest edge on structure transitions?\n');

  const sessions = ['overnight', 'premarket', 'rth'];
  const keyTransitions = ['STRADDLE→ABOVE', 'STRADDLE→BELOW', 'BELOW→ABOVE', 'ABOVE→BELOW'];

  for (const session of sessions) {
    console.log(`\n--- ${session.toUpperCase()} ---`);

    for (const transition of keyTransitions) {
      const group = events.filter(e => e.session === session && e.transition === transition);
      if (group.length < MIN_EVENTS_FOR_STATS) continue;

      console.log(`  ${transition} (n=${group.length})`);
      console.log(`  ${R('Window',8)} | ${R('Mean',8)} ${R('Median',8)} | ${R('Up%',6)} | ${R('t-stat',7)} | ${R('MFE↑',7)} ${R('MFE↓',7)}`);

      for (const window of [15, 30, 60, 120]) {
        const returns = group.map(e => e.forwardReturns[window]?.returnPts).filter(v => v != null);
        const mfeUps = group.map(e => e.forwardReturns[window]?.mfeUp).filter(v => v != null);
        const mfeDns = group.map(e => e.forwardReturns[window]?.mfeDn).filter(v => v != null);
        if (returns.length < MIN_EVENTS_FOR_STATS) continue;

        const stats = calcStats(returns);
        const avgMfeUp = mfeUps.reduce((s, v) => s + v, 0) / mfeUps.length;
        const avgMfeDn = mfeDns.reduce((s, v) => s + v, 0) / mfeDns.length;

        const sig = Math.abs(stats.tStat) >= 2 ? ' **' : Math.abs(stats.tStat) >= 1.5 ? ' *' : '';
        console.log(`  ${R(window + 'm',8)} | ${R(stats.mean.toFixed(2),8)} ${R(stats.median.toFixed(2),8)} | ${R(stats.upPct.toFixed(1),6)} | ${R(stats.tStat.toFixed(2),7)} | ${R(avgMfeUp.toFixed(1),7)} ${R(avgMfeDn.toFixed(1),7)}${sig}`);
      }
    }
  }
}

function analyzeCleanSeparation(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 5: CLEAN SEPARATION EVENTS (FULL CANDLE CLEAR OF LT)');
  console.log('='.repeat(100));
  console.log('BELOW→ABOVE: candle was fully below LT, now fully above (price exploded through)');
  console.log('ABOVE→BELOW: candle was fully above LT, now fully below (price collapsed through)\n');
  console.log('These are the strongest structural events — complete regime changes.\n');

  const extremeTransitions = ['BELOW→ABOVE', 'ABOVE→BELOW'];

  for (const transition of extremeTransitions) {
    const group = events.filter(e => e.transition === transition);
    console.log(`\n=== ${transition} (n=${group.length}) ===`);

    if (group.length < MIN_EVENTS_FOR_STATS) {
      console.log('  Insufficient data');
      continue;
    }

    // Overall stats
    console.log(`\n  Overall:`);
    console.log(`  ${R('Window',8)} | ${R('Mean',8)} ${R('Median',8)} ${R('StdDev',8)} | ${R('Up%',6)} | ${R('t-stat',7)} | ${R('MFE↑',7)} ${R('MFE↓',7)} | ${R('Skew',6)}`);

    for (const window of FORWARD_WINDOWS) {
      const returns = group.map(e => e.forwardReturns[window]?.returnPts).filter(v => v != null);
      const mfeUps = group.map(e => e.forwardReturns[window]?.mfeUp).filter(v => v != null);
      const mfeDns = group.map(e => e.forwardReturns[window]?.mfeDn).filter(v => v != null);
      if (returns.length < MIN_EVENTS_FOR_STATS) continue;

      const stats = calcStats(returns);
      const avgMfeUp = mfeUps.reduce((s, v) => s + v, 0) / mfeUps.length;
      const avgMfeDn = mfeDns.reduce((s, v) => s + v, 0) / mfeDns.length;

      const sig = Math.abs(stats.tStat) >= 2 ? ' **' : Math.abs(stats.tStat) >= 1.5 ? ' *' : '';
      console.log(`  ${R(window + 'm',8)} | ${R(stats.mean.toFixed(2),8)} ${R(stats.median.toFixed(2),8)} ${R(stats.stddev.toFixed(2),8)} | ${R(stats.upPct.toFixed(1),6)} | ${R(stats.tStat.toFixed(2),7)} | ${R(avgMfeUp.toFixed(1),7)} ${R(avgMfeDn.toFixed(1),7)} | ${R(stats.skew.toFixed(2),6)}${sig}`);
    }

    // By level
    console.log(`\n  By Level (30m forward return):`);
    for (const levelName of LEVEL_NAMES) {
      const subgroup = group.filter(e => e.level === levelName);
      const returns = subgroup.map(e => e.forwardReturns[30]?.returnPts).filter(v => v != null);
      if (returns.length < MIN_EVENTS_FOR_STATS) {
        console.log(`    ${levelName}: n=${subgroup.length} (insufficient)`);
        continue;
      }
      const stats = calcStats(returns);
      const sig = Math.abs(stats.tStat) >= 2 ? ' **' : Math.abs(stats.tStat) >= 1.5 ? ' *' : '';
      console.log(`    ${levelName}: n=${returns.length} mean=${stats.mean.toFixed(2)} median=${stats.median.toFixed(2)} up=${stats.upPct.toFixed(0)}% t=${stats.tStat.toFixed(2)}${sig}`);
    }
  }
}

function analyzeMultiLevelConfluence(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 6: MULTI-LEVEL CONFLUENCE');
  console.log('='.repeat(100));
  console.log('When multiple LT levels transition in the same direction within a 15m window,');
  console.log('is the signal stronger?\n');

  // Group events by 15m window
  const windowMs = 15 * 60000;
  const windows = new Map(); // windowKey -> events[]

  for (const e of events) {
    const windowKey = Math.floor(e.timestamp / windowMs);
    if (!windows.has(windowKey)) windows.set(windowKey, []);
    windows.get(windowKey).push(e);
  }

  // Classify windows by how many levels transition in same direction
  const singleEvents = []; // 1 level transitions
  const multiEvents = [];  // 2+ levels transition same direction

  for (const [, windowEvents] of windows) {
    if (windowEvents.length === 1) {
      singleEvents.push(windowEvents[0]);
    } else {
      // Check if multiple levels are moving in the same direction
      const aboveCount = windowEvents.filter(e => e.toState === 'ABOVE').length;
      const belowCount = windowEvents.filter(e => e.toState === 'BELOW').length;

      if (aboveCount >= 2 || belowCount >= 2) {
        // Pick the first event as representative
        const dominant = aboveCount >= belowCount ? 'ABOVE' : 'BELOW';
        const rep = windowEvents.find(e => e.toState === dominant) || windowEvents[0];
        multiEvents.push({ ...rep, confluenceCount: Math.max(aboveCount, belowCount), confluenceDir: dominant });
      } else {
        // Mixed directions — still single events
        for (const e of windowEvents) singleEvents.push(e);
      }
    }
  }

  console.log(`Single-level events: ${singleEvents.length}`);
  console.log(`Multi-level confluence events (2+ same direction): ${multiEvents.length}`);

  // Compare forward returns
  for (const [label, group] of [['Single Level', singleEvents], ['Multi-Level Confluence', multiEvents]]) {
    if (group.length < MIN_EVENTS_FOR_STATS) continue;

    console.log(`\n--- ${label} (n=${group.length}) ---`);
    console.log(`  ${R('Window',8)} | ${R('Mean',8)} ${R('Median',8)} ${R('StdDev',8)} | ${R('Up%',6)} | ${R('t-stat',7)}`);

    for (const window of [15, 30, 60, 120]) {
      const returns = group.map(e => e.forwardReturns[window]?.returnPts).filter(v => v != null);
      if (returns.length < MIN_EVENTS_FOR_STATS) continue;

      const stats = calcStats(returns);
      const sig = Math.abs(stats.tStat) >= 2 ? ' **' : Math.abs(stats.tStat) >= 1.5 ? ' *' : '';
      console.log(`  ${R(window + 'm',8)} | ${R(stats.mean.toFixed(2),8)} ${R(stats.median.toFixed(2),8)} ${R(stats.stddev.toFixed(2),8)} | ${R(stats.upPct.toFixed(1),6)} | ${R(stats.tStat.toFixed(2),7)}${sig}`);
    }
  }
}

function analyzeLevelDistanceAtTransition(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 7: LEVEL DISTANCE & CANDLE SIZE AT TRANSITION');
  console.log('='.repeat(100));
  console.log('Does the distance between LT level and price at transition predict move size?');
  console.log('Does candle range (volatility) at transition matter?\n');

  // Focus on the most interesting transitions
  const keyTransitions = ['STRADDLE→ABOVE', 'STRADDLE→BELOW'];

  for (const transition of keyTransitions) {
    const group = events.filter(e => e.transition === transition);
    if (group.length < 30) continue;

    console.log(`\n--- ${transition} (n=${group.length}) ---`);

    // Split into terciles by candle range (volatility at transition)
    const withRange = group.filter(e => e.forwardReturns[30]?.returnPts != null);
    withRange.sort((a, b) => a.candleRange - b.candleRange);
    const tercile = Math.floor(withRange.length / 3);

    const smallCandle = withRange.slice(0, tercile);
    const medCandle = withRange.slice(tercile, tercile * 2);
    const largeCandle = withRange.slice(tercile * 2);

    console.log(`\n  By Candle Range (volatility at transition) — 30m forward return:`);
    for (const [label, subgroup] of [['Small candle', smallCandle], ['Medium candle', medCandle], ['Large candle', largeCandle]]) {
      const returns = subgroup.map(e => e.forwardReturns[30].returnPts);
      if (returns.length < MIN_EVENTS_FOR_STATS) continue;
      const stats = calcStats(returns);
      const avgRange = subgroup.reduce((s, e) => s + e.candleRange, 0) / subgroup.length;
      const sig = Math.abs(stats.tStat) >= 2 ? ' **' : Math.abs(stats.tStat) >= 1.5 ? ' *' : '';
      console.log(`    ${label} (avg range ${avgRange.toFixed(1)}pts): n=${returns.length} mean=${stats.mean.toFixed(2)} median=${stats.median.toFixed(2)} up=${stats.upPct.toFixed(0)}% t=${stats.tStat.toFixed(2)}${sig}`);
    }

    // Split by level distance
    const withDist = group.filter(e => e.forwardReturns[30]?.returnPts != null);
    withDist.sort((a, b) => Math.abs(a.levelDistFromClose) - Math.abs(b.levelDistFromClose));
    const dt = Math.floor(withDist.length / 3);

    const closeDist = withDist.slice(0, dt);
    const medDist = withDist.slice(dt, dt * 2);
    const farDist = withDist.slice(dt * 2);

    console.log(`\n  By Level Distance from Close — 30m forward return:`);
    for (const [label, subgroup] of [['Close to LT', closeDist], ['Medium dist', medDist], ['Far from LT', farDist]]) {
      const returns = subgroup.map(e => e.forwardReturns[30].returnPts);
      if (returns.length < MIN_EVENTS_FOR_STATS) continue;
      const stats = calcStats(returns);
      const avgDist = subgroup.reduce((s, e) => s + Math.abs(e.levelDistFromClose), 0) / subgroup.length;
      const sig = Math.abs(stats.tStat) >= 2 ? ' **' : Math.abs(stats.tStat) >= 1.5 ? ' *' : '';
      console.log(`    ${label} (avg dist ${avgDist.toFixed(1)}pts): n=${returns.length} mean=${stats.mean.toFixed(2)} median=${stats.median.toFixed(2)} up=${stats.upPct.toFixed(0)}% t=${stats.tStat.toFixed(2)}${sig}`);
    }
  }
}

function analyzeHourOfDay(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 8: HOUR-OF-DAY HEATMAP');
  console.log('='.repeat(100));
  console.log('Mean 30m forward return by hour of day (EST) for key transitions\n');

  const keyTransitions = ['STRADDLE→ABOVE', 'STRADDLE→BELOW', 'BELOW→ABOVE', 'ABOVE→BELOW'];

  for (const transition of keyTransitions) {
    const group = events.filter(e => e.transition === transition);
    if (group.length < 30) continue;

    console.log(`\n  ${transition}:`);
    console.log(`  ${R('Hour',6)} | ${R('n',5)} | ${R('Mean30m',8)} ${R('Up%',6)} | ${R('t-stat',7)}`);

    // Group by integer hour
    const byHour = {};
    for (const e of group) {
      const hour = Math.floor(e.estHour);
      if (!byHour[hour]) byHour[hour] = [];
      byHour[hour].push(e);
    }

    for (let h = 18; h < 42; h++) {
      const hour = h % 24;
      const hourGroup = byHour[hour];
      if (!hourGroup || hourGroup.length < 5) continue;

      const returns = hourGroup.map(e => e.forwardReturns[30]?.returnPts).filter(v => v != null);
      if (returns.length < 5) continue;

      const stats = calcStats(returns);
      const sig = Math.abs(stats.tStat) >= 2 ? ' **' : Math.abs(stats.tStat) >= 1.5 ? ' *' : '';
      const bar = stats.mean > 0 ? '+'.repeat(Math.min(20, Math.round(stats.mean))) : '-'.repeat(Math.min(20, Math.round(-stats.mean)));
      console.log(`  ${hour.toString().padStart(2, '0')}:00 | ${returns.length.toString().padStart(5)} | ${stats.mean.toFixed(2).padStart(8)} ${stats.upPct.toFixed(0).padStart(5)}% | ${stats.tStat.toFixed(2).padStart(7)} ${bar}${sig}`);
    }
  }
}

function analyzeFadeVsFollow(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 9: FADE vs FOLLOW ANALYSIS');
  console.log('='.repeat(100));
  console.log('When price structure moves ABOVE LT, should you fade it (expect reversion)');
  console.log('or follow it (expect continuation)?\n');
  console.log('STRADDLE→ABOVE: Price cleared above LT. Does it continue UP or revert DOWN?');
  console.log('STRADDLE→BELOW: Price cleared below LT. Does it continue DOWN or revert UP?\n');

  for (const transition of ['STRADDLE→ABOVE', 'STRADDLE→BELOW']) {
    const group = events.filter(e => e.transition === transition);
    if (group.length < MIN_EVENTS_FOR_STATS) continue;

    console.log(`\n=== ${transition} (n=${group.length}) ===`);
    console.log(`  If STRADDLE→ABOVE: "follow" = price goes UP, "fade" = price goes DOWN`);
    console.log(`  If STRADDLE→BELOW: "follow" = price goes DOWN, "fade" = price goes UP\n`);

    const followSign = transition === 'STRADDLE→ABOVE' ? 1 : -1;

    for (const window of FORWARD_WINDOWS) {
      const valid = group.filter(e => e.forwardReturns[window]?.returnPts != null);
      if (valid.length < MIN_EVENTS_FOR_STATS) continue;

      const returns = valid.map(e => e.forwardReturns[window].returnPts);
      const mfeFollow = valid.map(e => followSign > 0 ? e.forwardReturns[window].mfeUp : -e.forwardReturns[window].mfeDn).filter(v => v != null);
      const mfeFade = valid.map(e => followSign > 0 ? -e.forwardReturns[window].mfeDn : e.forwardReturns[window].mfeUp).filter(v => v != null);

      const followWins = returns.filter(r => r * followSign > 0).length;
      const fadeWins = returns.filter(r => r * followSign < 0).length;
      const followPct = (followWins / valid.length * 100).toFixed(1);
      const fadePct = (fadeWins / valid.length * 100).toFixed(1);
      const avgReturn = returns.reduce((s, v) => s + v, 0) / returns.length;
      const avgFollowMFE = mfeFollow.length > 0 ? mfeFollow.reduce((s, v) => s + v, 0) / mfeFollow.length : 0;
      const avgFadeMFE = mfeFade.length > 0 ? mfeFade.reduce((s, v) => s + v, 0) / mfeFade.length : 0;

      console.log(`  ${(window + 'm').padStart(5)}: Follow=${followPct}% Fade=${fadePct}% | AvgReturn=${(avgReturn * followSign).toFixed(2)}pts | FollowMFE=${avgFollowMFE.toFixed(1)}pts FadeMFE=${avgFadeMFE.toFixed(1)}pts`);
    }
  }
}

function printSummary(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 10: SUMMARY — STRONGEST SIGNALS');
  console.log('='.repeat(100));
  console.log('Events with |t-stat| >= 1.5 at 30m horizon (sorted by absolute t-stat)\n');

  const results = [];

  // Test all combinations: transition × level × session × sentiment
  const transitions = [...new Set(events.map(e => e.transition))];
  const sentiments = ['BULLISH', 'BEARISH', 'ALL'];
  const sessions = ['overnight', 'premarket', 'rth', 'ALL'];

  for (const transition of transitions) {
    for (const level of [...LEVEL_NAMES, 'ALL']) {
      for (const session of sessions) {
        for (const sentiment of sentiments) {
          let group = events.filter(e => e.transition === transition);
          if (level !== 'ALL') group = group.filter(e => e.level === level);
          if (session !== 'ALL') group = group.filter(e => e.session === session);
          if (sentiment !== 'ALL') group = group.filter(e => e.sentiment === sentiment);

          if (group.length < MIN_EVENTS_FOR_STATS) continue;

          const returns = group.map(e => e.forwardReturns[30]?.returnPts).filter(v => v != null);
          if (returns.length < MIN_EVENTS_FOR_STATS) continue;

          const stats = calcStats(returns);
          if (Math.abs(stats.tStat) >= 1.5) {
            results.push({
              transition,
              level,
              session,
              sentiment,
              n: returns.length,
              mean: stats.mean,
              median: stats.median,
              upPct: stats.upPct,
              tStat: stats.tStat,
              stddev: stats.stddev,
            });
          }
        }
      }
    }
  }

  results.sort((a, b) => Math.abs(b.tStat) - Math.abs(a.tStat));

  console.log(`${R('Transition',18)} | ${R('Level',6)} | ${R('Session',10)} | ${R('Sent',8)} | ${R('n',5)} | ${R('Mean',8)} ${R('Med',7)} ${R('Up%',5)} | ${R('t-stat',7)}`);
  console.log('-'.repeat(110));

  for (const r of results.slice(0, 40)) {
    const sig = Math.abs(r.tStat) >= 2 ? ' **' : ' *';
    console.log(`${r.transition.padStart(18)} | ${r.level.padStart(6)} | ${r.session.padStart(10)} | ${r.sentiment.padStart(8)} | ${String(r.n).padStart(5)} | ${r.mean.toFixed(2).padStart(8)} ${r.median.toFixed(2).padStart(7)} ${r.upPct.toFixed(0).padStart(4)}% | ${r.tStat.toFixed(2).padStart(7)}${sig}`);
  }

  console.log(`\nTotal combinations tested with sufficient data: ${results.length}`);
  console.log(`Significant at |t| >= 2.0: ${results.filter(r => Math.abs(r.tStat) >= 2).length}`);
  console.log(`Significant at |t| >= 1.5: ${results.length}`);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('LT Candle Structure Deep Analysis');
  console.log('=' .repeat(60));
  console.log('Research: Correlations between LT level position relative to');
  console.log('full candle structures and forward price movement.');
  console.log('Using RAW contract data (not continuous) for price space alignment.');
  console.log('=' .repeat(60));

  const { candles, ltRecords, rolloverDates } = await loadData();
  const events = detectTransitions(candles, ltRecords, rolloverDates);

  if (events.length === 0) {
    console.log('No transition events found. Check data alignment.');
    return;
  }

  // Event distribution
  console.log('\nEvent Distribution:');
  const byTransition = {};
  for (const e of events) {
    byTransition[e.transition] = (byTransition[e.transition] || 0) + 1;
  }
  for (const [t, n] of Object.entries(byTransition).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${n}`);
  }

  // Run all analyses
  analyzeByTransition(events);
  analyzeByLevel(events);
  analyzeBySentiment(events);
  analyzeBySession(events);
  analyzeCleanSeparation(events);
  analyzeMultiLevelConfluence(events);
  analyzeLevelDistanceAtTransition(events);
  analyzeHourOfDay(events);
  analyzeFadeVsFollow(events);
  printSummary(events);

  // Save raw events for follow-up analysis
  const outputPath = path.join(__dirname, '..', 'results', 'lt-candle-structure-events.json');
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // Save compact version (no overnight candle arrays)
  const compact = events.map(({ timestamp, dateStr, session, estHour, level, sentiment, transition, fromState, toState, refPrice, candleRange, levelDistFromClose, levelDelta, forwardReturns, symbol }) => ({
    timestamp, dateStr, session, estHour, level, sentiment, transition, fromState, toState, refPrice, candleRange, levelDistFromClose, levelDelta, forwardReturns, symbol
  }));
  fs.writeFileSync(outputPath, JSON.stringify(compact, null, 2));
  console.log(`\nRaw events saved to ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
