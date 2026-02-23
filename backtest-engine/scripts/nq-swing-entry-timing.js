#!/usr/bin/env node
/**
 * NQ Swing Entry Timing Analysis
 *
 * Tests how much swing-point edge survives when using realistic entry timing.
 *
 * A lookback-8 swing is only CONFIRMED 8 bars after the swing candle.
 * This script compares:
 *   - "Ideal" entry: bar i+1 (what the confluence script measured)
 *   - "Confirmed" entry: bar i+LOOKBACK+1 (when you'd actually know it's a swing)
 *
 * For each entry mode, computes MFE and applies the top feature filters from
 * the confluence analysis to see how much lift survives.
 *
 * Usage:
 *   node scripts/nq-swing-entry-timing.js [--start YYYY-MM-DD] [--end YYYY-MM-DD]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { SecondDataProvider } from '../src/data/csv-loader.js';

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
};

const startDateStr = getArg('start', '2025-01-01');
const endDateStr = getArg('end', '2025-07-31');
const outputPath = getArg('output', 'nq-swing-entry-timing-results.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

const LOOKBACK = 8;
const MAX_STOP = 30;
const MFE_THRESHOLDS = [20, 30, 40, 50, 75];

console.log('='.repeat(80));
console.log('NQ SWING ENTRY TIMING ANALYSIS');
console.log('='.repeat(80));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log(`Lookback: ${LOOKBACK}, Max stop: ${MAX_STOP}pts`);
console.log();

// ============================================================================
// Helpers
// ============================================================================

function formatNum(n, d = 1) { return n === null || isNaN(n) ? 'N/A' : n.toFixed(d); }
function formatPct(n, d = 1) { return n === null || isNaN(n) ? 'N/A' : (n * 100).toFixed(d) + '%'; }
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = (p / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) { return percentile(arr, 50); }

const round15m = ts => Math.floor(ts / (15 * 60 * 1000)) * (15 * 60 * 1000);

function getSession(timestamp) {
  const d = new Date(timestamp);
  const est = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false });
  const [h, m] = est.split(':').map(Number);
  const td = h + m / 60;
  if (td >= 18 || td < 4) return 'overnight';
  if (td >= 4 && td < 9.5) return 'premarket';
  if (td >= 9.5 && td < 16) return 'rth';
  return 'afterhours';
}

// ============================================================================
// Data Loading (reused from confluence script)
// ============================================================================

function filterPrimaryContract(candles) {
  if (!candles.length) return candles;
  const cv = new Map();
  candles.forEach(c => {
    const hk = Math.floor(c.timestamp / 3600000);
    if (!cv.has(hk)) cv.set(hk, new Map());
    const hd = cv.get(hk);
    hd.set(c.symbol, (hd.get(c.symbol) || 0) + (c.volume || 0));
  });
  return candles.filter(c => {
    const hk = Math.floor(c.timestamp / 3600000);
    const hd = cv.get(hk);
    if (!hd) return true;
    let ps = '', mv = 0;
    for (const [s, v] of hd) { if (v > mv) { mv = v; ps = s; } }
    return c.symbol === ps;
  });
}

async function loadOHLCVData() {
  const filePath = path.join(dataDir, 'ohlcv/nq/NQ_ohlcv_1m.csv');
  console.log('Loading NQ 1m OHLCV data...');
  const candles = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const timestamp = new Date(parts[0]).getTime();
    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) continue;
    const symbol = parts[9]?.trim();
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
  console.log(`  Loaded ${filtered.length} candles`);
  return filtered;
}

async function loadGEXData() {
  const gexDir = path.join(dataDir, 'gex/nq');
  console.log('Loading GEX data...');
  const gexMap = new Map();
  const files = fs.readdirSync(gexDir).filter(f => f.startsWith('nq_gex_') && f.endsWith('.json'));
  let loaded = 0;
  for (const file of files) {
    const dateStr = file.replace('nq_gex_', '').replace('.json', '');
    const fileDate = new Date(dateStr + 'T00:00:00Z');
    if (fileDate < new Date(startDateStr + 'T00:00:00Z') || fileDate > new Date(endDateStr + 'T23:59:59Z')) continue;
    const content = JSON.parse(fs.readFileSync(path.join(gexDir, file), 'utf-8'));
    for (const snap of content.data) {
      const ts = new Date(snap.timestamp).getTime();
      gexMap.set(round15m(ts), snap);
    }
    loaded++;
  }
  console.log(`  Loaded ${loaded} GEX files, ${gexMap.size} snapshots`);
  return gexMap;
}

async function loadLTData() {
  const filePath = path.join(dataDir, 'liquidity/nq/NQ_liquidity_levels.csv');
  console.log('Loading LT levels...');
  const ltMap = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 8) continue;
    const ts = parseInt(parts[1]);
    if (ts < startDate.getTime() || ts > endDate.getTime()) continue;
    ltMap.set(round15m(ts), {
      sentiment: parts[2]?.trim(),
      levels: [parseFloat(parts[3]), parseFloat(parts[4]), parseFloat(parts[5]),
               parseFloat(parts[6]), parseFloat(parts[7])]
    });
  }
  console.log(`  Loaded ${ltMap.size} LT snapshots`);
  return ltMap;
}

// ============================================================================
// Swing Detection
// ============================================================================

function findSwingHighs(candles, lookback) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let ok = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && candles[j].high >= c.high) { ok = false; break; }
    }
    if (ok) swings.push({ price: c.high, close: c.close, open: c.open, low: c.low,
      high: c.high, volume: c.volume, timestamp: c.timestamp, index: i });
  }
  return swings;
}

function findSwingLows(candles, lookback) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let ok = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && candles[j].low <= c.low) { ok = false; break; }
    }
    if (ok) swings.push({ price: c.low, close: c.close, open: c.open, low: c.low,
      high: c.high, volume: c.volume, timestamp: c.timestamp, index: i });
  }
  return swings;
}

// ============================================================================
// MFE Analysis — Dual Entry Modes
// ============================================================================

/**
 * Analyze MFE from two entry points:
 *   ideal: entry at bar i+1 (close of swing candle as entry price)
 *   confirmed: entry at bar i+LOOKBACK+1 (open of first bar after confirmation)
 *
 * Also tracks what happens BETWEEN bar i+1 and i+LOOKBACK (the "gap"):
 *   - Was the swing invalidated before confirmation?
 *   - How far did price move in the favorable direction during the gap?
 *   - What's the distance between ideal entry and confirmed entry?
 */
function analyzeSwingDualEntry(candles, swing, type, lookback) {
  const idealEntryIdx = swing.index + 1;
  const confirmedEntryIdx = swing.index + lookback + 1;

  if (confirmedEntryIdx >= candles.length) return null;

  const swingPrice = swing.price;
  const idealEntry = swing.close;
  const confirmedEntry = candles[confirmedEntryIdx].open;

  // Check if swing was invalidated during the confirmation window
  let invalidatedDuringGap = false;
  let gapFavorable = 0; // Max favorable move during gap
  for (let i = idealEntryIdx; i <= swing.index + lookback; i++) {
    if (i >= candles.length) break;
    const c = candles[i];
    if (type === 'high') {
      if (c.high > swingPrice) { invalidatedDuringGap = true; break; }
      gapFavorable = Math.max(gapFavorable, idealEntry - c.low);
    } else {
      if (c.low < swingPrice) { invalidatedDuringGap = true; break; }
      gapFavorable = Math.max(gapFavorable, c.high - idealEntry);
    }
  }

  // Entry distance: how far price moved from ideal entry to confirmed entry
  const entrySlippage = type === 'high'
    ? idealEntry - confirmedEntry  // positive = price moved in our favor (down for short)
    : confirmedEntry - idealEntry; // positive = price moved against us (up for long)

  // Compute MFE from IDEAL entry (bar i+1)
  const idealResult = computeMFE(candles, swingPrice, idealEntry, idealEntryIdx, type);

  // Compute MFE from CONFIRMED entry (bar i+LOOKBACK+1)
  let confirmedResult = null;
  if (!invalidatedDuringGap) {
    // Risk for confirmed entry: distance from swing price to confirmed entry
    const confirmedRisk = Math.abs(swingPrice - confirmedEntry);
    confirmedResult = computeMFE(candles, swingPrice, confirmedEntry, confirmedEntryIdx, type);
    confirmedResult.risk = confirmedRisk;
  }

  return {
    type,
    swingPrice,
    idealEntry,
    confirmedEntry,
    entrySlippage,
    invalidatedDuringGap,
    gapFavorable,
    ideal: idealResult,
    confirmed: confirmedResult,
    session: getSession(swing.timestamp),
    timestamp: swing.timestamp,
    index: swing.index,
  };
}

function computeMFE(candles, swingPrice, entryPrice, entryIdx, type) {
  let mfe = 0, barsToMFE = 0, barsToInval = null, runningMFE = 0;
  const risk = Math.abs(swingPrice - entryPrice);

  for (let i = entryIdx; i < candles.length; i++) {
    const c = candles[i];
    const bars = i - entryIdx;
    if (type === 'high') {
      const fav = entryPrice - c.low;
      if (fav > runningMFE) { runningMFE = fav; barsToMFE = bars; }
      if (c.high > swingPrice) { barsToInval = bars; break; }
    } else {
      const fav = c.high - entryPrice;
      if (fav > runningMFE) { runningMFE = fav; barsToMFE = bars; }
      if (c.low < swingPrice) { barsToInval = bars; break; }
    }
  }

  return { mfe: runningMFE, barsToMFE, barsToInval, risk };
}

// ============================================================================
// Feature Extraction (top features only — for filtering analysis)
// ============================================================================

function extractTopFeatures(candles, swing, type, gexMap, ltMap, secondProvider) {
  const i = swing.index;
  const c = candles[i];
  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);

  // ATR 20
  let atr20 = 0;
  if (i >= 20) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) {
      sum += Math.max(candles[j].high - candles[j].low,
        Math.abs(candles[j].high - candles[j - 1].close),
        Math.abs(candles[j].low - candles[j - 1].close));
    }
    atr20 = sum / 20;
  }

  // Volume concentration — need 1s data
  let volConcentration = null;
  // Will be set async later

  // GEX regime
  let gexRegime = null;
  const gexKey = round15m(swing.timestamp);
  for (let off = 0; off <= 4; off++) {
    const snap = gexMap.get(gexKey - off * 15 * 60 * 1000);
    if (snap) {
      const map = { strong_negative: -2, negative: -1, neutral: 0, positive: 1, strong_positive: 2 };
      gexRegime = map[snap.regime] ?? null;
      break;
    }
  }

  // LT levels within 30pts
  let ltWithin30 = null;
  const ltKey = round15m(swing.timestamp);
  for (let off = 0; off <= 4; off++) {
    const snap = ltMap.get(ltKey - off * 15 * 60 * 1000);
    if (snap) {
      const levels = snap.levels.filter(l => !isNaN(l) && l > 0);
      ltWithin30 = levels.filter(l => Math.abs(swing.price - l) <= 30).length;
      break;
    }
  }

  return {
    atr_20bar: atr20,
    candle_range: range,
    body_size: body,
    gex_regime: gexRegime,
    lt_levels_within_30pts: ltWithin30,
    // These need async computation
    intrabar_range: null,
    volume_concentration_5s: null,
    sweep_speed_sec: null,
  };
}

async function addSecondFeatures(features, secondProvider, swing, type) {
  const minuteTs = Math.floor(swing.timestamp / 60000) * 60000;
  const seconds = await secondProvider.getSecondsForMinute(minuteTs);

  if (seconds.length === 0) return;

  let extremePrice, extremeIdx;
  if (type === 'high') {
    extremePrice = -Infinity;
    for (let j = 0; j < seconds.length; j++) {
      if (seconds[j].high > extremePrice) { extremePrice = seconds[j].high; extremeIdx = j; }
    }
  } else {
    extremePrice = Infinity;
    for (let j = 0; j < seconds.length; j++) {
      if (seconds[j].low < extremePrice) { extremePrice = seconds[j].low; extremeIdx = j; }
    }
  }

  let secHigh = -Infinity, secLow = Infinity;
  for (const s of seconds) {
    if (s.high > secHigh) secHigh = s.high;
    if (s.low < secLow) secLow = s.low;
  }
  features.intrabar_range = secHigh - secLow;

  const totalVol = seconds.reduce((sum, s) => sum + s.volume, 0);
  let windowVol = 0;
  for (let j = Math.max(0, extremeIdx - 2); j <= Math.min(seconds.length - 1, extremeIdx + 2); j++) {
    windowVol += seconds[j].volume;
  }
  features.volume_concentration_5s = totalVol > 0 ? windowVol / totalVol : 0;
  features.sweep_speed_sec = extremeIdx;
}

// ============================================================================
// Analysis & Output
// ============================================================================

async function main() {
  const t0 = Date.now();

  // Load data
  console.log('PHASE 1: Loading data...\n');
  const candles = await loadOHLCVData();
  if (!candles.length) { console.error('No candles.'); process.exit(1); }

  const secondPath = path.join(dataDir, 'ohlcv/nq/NQ_ohlcv_1s.csv');
  const secondProvider = new SecondDataProvider(secondPath);
  await secondProvider.initialize();

  const gexMap = await loadGEXData();
  const ltMap = await loadLTData();

  console.log(`\nData loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Detect swings
  console.log('PHASE 2: Detecting swings & computing dual-entry MFE...\n');
  const highs = findSwingHighs(candles, LOOKBACK).filter(s => Math.abs(s.price - s.close) <= MAX_STOP);
  const lows = findSwingLows(candles, LOOKBACK).filter(s => Math.abs(s.price - s.close) <= MAX_STOP);
  console.log(`  ${highs.length} swing highs, ${lows.length} swing lows after risk filter`);

  const events = [];
  const allSwings = [
    ...highs.map(s => ({ swing: s, type: 'high' })),
    ...lows.map(s => ({ swing: s, type: 'low' }))
  ];

  const progressInterval = Math.max(1, Math.floor(allSwings.length / 20));

  for (let ei = 0; ei < allSwings.length; ei++) {
    const { swing, type } = allSwings[ei];
    const result = analyzeSwingDualEntry(candles, swing, type, LOOKBACK);
    if (!result) continue;

    const features = extractTopFeatures(candles, swing, type, gexMap, ltMap);
    await addSecondFeatures(features, secondProvider, swing, type);

    events.push({ ...result, features });

    if ((ei + 1) % progressInterval === 0) {
      process.stdout.write(`  ${ei + 1}/${allSwings.length} processed\r`);
    }
  }
  console.log(`  ${events.length} swings analyzed                        `);

  // ============================================================================
  // Results
  // ============================================================================

  console.log('\n' + '='.repeat(100));
  console.log('ENTRY TIMING COMPARISON');
  console.log('='.repeat(100));

  // Ideal vs Confirmed — overall stats
  const idealMFEs = events.map(e => e.ideal.mfe);
  const confirmedEvents = events.filter(e => !e.invalidatedDuringGap);
  const confirmedMFEs = confirmedEvents.map(e => e.confirmed.mfe);
  const invalidatedCount = events.length - confirmedEvents.length;

  console.log(`\n  Total swings: ${events.length}`);
  console.log(`  Invalidated before confirmation (bars i+1 to i+${LOOKBACK}): ${invalidatedCount} (${formatPct(invalidatedCount / events.length)})`);
  console.log(`  Surviving to confirmed entry: ${confirmedEvents.length} (${formatPct(confirmedEvents.length / events.length)})`);

  console.log(`\n  Entry slippage (ideal→confirmed):`);
  const slippages = confirmedEvents.map(e => e.entrySlippage);
  console.log(`    Mean: ${formatNum(mean(slippages))} pts | Median: ${formatNum(median(slippages))} pts`);
  console.log(`    P25: ${formatNum(percentile(slippages, 25))} | P75: ${formatNum(percentile(slippages, 75))}`);

  // Win rates at each threshold
  console.log(`\n  ${''.padEnd(22)} ${'Ideal Entry'.padStart(38)} ${'Confirmed Entry'.padStart(38)}`);
  console.log(`  ${'MFE Threshold'.padEnd(22)} ${'Win Rate'.padStart(10)} ${'Count'.padStart(7)} ${'Avg MFE'.padStart(9)} ${'Med MFE'.padStart(9)} ${'Win Rate'.padStart(10)} ${'Count'.padStart(7)} ${'Avg MFE'.padStart(9)} ${'Med MFE'.padStart(9)}`);
  console.log(`  ${'─'.repeat(96)}`);

  for (const thresh of MFE_THRESHOLDS) {
    const idealWins = events.filter(e => e.ideal.mfe >= thresh);
    const confirmedWins = confirmedEvents.filter(e => e.confirmed.mfe >= thresh);
    console.log(`  ${(thresh + '+ pts').padEnd(22)} ${formatPct(idealWins.length / events.length).padStart(10)} ${String(idealWins.length).padStart(7)} ${formatNum(mean(idealMFEs)).padStart(9)} ${formatNum(median(idealMFEs)).padStart(9)} ${formatPct(confirmedWins.length / confirmedEvents.length).padStart(10)} ${String(confirmedWins.length).padStart(7)} ${formatNum(mean(confirmedMFEs)).padStart(9)} ${formatNum(median(confirmedMFEs)).padStart(9)}`);
  }

  // Time to MFE comparison
  console.log(`\n  Bars to MFE:`);
  console.log(`    Ideal:     avg ${formatNum(mean(events.map(e => e.ideal.barsToMFE)))} | median ${formatNum(median(events.map(e => e.ideal.barsToMFE)))}`);
  console.log(`    Confirmed: avg ${formatNum(mean(confirmedEvents.map(e => e.confirmed.barsToMFE)))} | median ${formatNum(median(confirmedEvents.map(e => e.confirmed.barsToMFE)))}`);

  // ============================================================================
  // Feature filtering with confirmed entry
  // ============================================================================

  console.log('\n' + '='.repeat(100));
  console.log('FEATURE FILTERS — CONFIRMED ENTRY');
  console.log('='.repeat(100));

  const baseWR_ideal = events.filter(e => e.ideal.mfe >= 30).length / events.length;
  const baseWR_confirmed = confirmedEvents.filter(e => e.confirmed.mfe >= 30).length / confirmedEvents.length;
  console.log(`\n  Base win rate (MFE ≥ 30pts):`);
  console.log(`    Ideal entry:     ${formatPct(baseWR_ideal)} (${events.length} swings)`);
  console.log(`    Confirmed entry: ${formatPct(baseWR_confirmed)} (${confirmedEvents.length} swings)`);

  // Define filters based on in-sample findings
  const filters = [
    { name: 'High ATR (≥ 6.83)', test: f => f.atr_20bar >= 6.83 },
    { name: 'Large candle (≥ 8.75)', test: f => f.candle_range >= 8.75 },
    { name: 'High intrabar range (≥ 12)', test: f => f.intrabar_range !== null && f.intrabar_range >= 12 },
    { name: 'Low vol concentration (< 0.19)', test: f => f.volume_concentration_5s !== null && f.volume_concentration_5s < 0.19 },
    { name: 'Neg GEX regime (< 0)', test: f => f.gex_regime !== null && f.gex_regime < 0 },
    { name: 'No LT levels within 30pts (= 0)', test: f => f.lt_levels_within_30pts !== null && f.lt_levels_within_30pts === 0 },
    { name: 'Slow sweep (≥ 14s)', test: f => f.sweep_speed_sec !== null && f.sweep_speed_sec >= 14 },
    { name: 'Large body (≥ 3.25)', test: f => f.body_size >= 3.25 },
  ];

  console.log(`\n  ${'Filter'.padEnd(38)} ${'Ideal'.padStart(24)} ${'Confirmed'.padStart(30)}`);
  console.log(`  ${''.padEnd(38)} ${'WR'.padStart(8)} ${'Count'.padStart(7)} ${'Lift'.padStart(7)} ${'WR'.padStart(8)} ${'Count'.padStart(7)} ${'Lift'.padStart(7)} ${'Surv%'.padStart(7)}`);
  console.log(`  ${'─'.repeat(92)}`);

  for (const filter of filters) {
    const idealFiltered = events.filter(e => filter.test(e.features));
    const confirmedFiltered = confirmedEvents.filter(e => filter.test(e.features));

    const idealWR = idealFiltered.length > 0 ? idealFiltered.filter(e => e.ideal.mfe >= 30).length / idealFiltered.length : 0;
    const confirmedWR = confirmedFiltered.length > 0 ? confirmedFiltered.filter(e => e.confirmed.mfe >= 30).length / confirmedFiltered.length : 0;
    const survival = confirmedFiltered.length > 0 && idealFiltered.length > 0
      ? confirmedFiltered.length / idealFiltered.length : 0;

    console.log(`  ${filter.name.padEnd(38)} ${formatPct(idealWR).padStart(8)} ${String(idealFiltered.length).padStart(7)} ${('+' + formatPct(idealWR - baseWR_ideal)).padStart(7)} ${formatPct(confirmedWR).padStart(8)} ${String(confirmedFiltered.length).padStart(7)} ${('+' + formatPct(confirmedWR - baseWR_confirmed)).padStart(7)} ${formatPct(survival).padStart(7)}`);
  }

  // Top combinations with confirmed entry
  console.log('\n' + '='.repeat(100));
  console.log('TOP COMBINATIONS — CONFIRMED ENTRY (MFE ≥ 30pts)');
  console.log('='.repeat(100));

  const combos = [
    { name: 'ATR + candle_range', test: f => f.atr_20bar >= 6.83 && f.candle_range >= 8.75 },
    { name: 'ATR + intrabar_range', test: f => f.atr_20bar >= 6.83 && f.intrabar_range !== null && f.intrabar_range >= 12 },
    { name: 'ATR + low vol_conc', test: f => f.atr_20bar >= 6.83 && f.volume_concentration_5s !== null && f.volume_concentration_5s < 0.19 },
    { name: 'ATR + neg GEX regime', test: f => f.atr_20bar >= 6.83 && f.gex_regime !== null && f.gex_regime < 0 },
    { name: 'ATR + no LT within 30', test: f => f.atr_20bar >= 6.83 && f.lt_levels_within_30pts !== null && f.lt_levels_within_30pts === 0 },
    { name: 'candle_range + neg GEX', test: f => f.candle_range >= 8.75 && f.gex_regime !== null && f.gex_regime < 0 },
    { name: 'ATR + intrabar + low vol_conc', test: f => f.atr_20bar >= 6.83 && f.intrabar_range !== null && f.intrabar_range >= 12 && f.volume_concentration_5s !== null && f.volume_concentration_5s < 0.19 },
    { name: 'ATR + candle + neg GEX', test: f => f.atr_20bar >= 6.83 && f.candle_range >= 8.75 && f.gex_regime !== null && f.gex_regime < 0 },
    { name: 'ATR + candle + no LT', test: f => f.atr_20bar >= 6.83 && f.candle_range >= 8.75 && f.lt_levels_within_30pts !== null && f.lt_levels_within_30pts === 0 },
    { name: 'ATR + intrabar + neg GEX', test: f => f.atr_20bar >= 6.83 && f.intrabar_range !== null && f.intrabar_range >= 12 && f.gex_regime !== null && f.gex_regime < 0 },
    { name: 'ATR + intrabar + no LT', test: f => f.atr_20bar >= 6.83 && f.intrabar_range !== null && f.intrabar_range >= 12 && f.lt_levels_within_30pts !== null && f.lt_levels_within_30pts === 0 },
    { name: 'candle + neg GEX + no LT', test: f => f.candle_range >= 8.75 && f.gex_regime !== null && f.gex_regime < 0 && f.lt_levels_within_30pts !== null && f.lt_levels_within_30pts === 0 },
  ];

  console.log(`\n  ${'Combination'.padEnd(40)} ${'Ideal'.padStart(24)} ${'Confirmed'.padStart(30)}`);
  console.log(`  ${''.padEnd(40)} ${'WR'.padStart(8)} ${'Count'.padStart(7)} ${'Lift'.padStart(7)} ${'WR'.padStart(8)} ${'Count'.padStart(7)} ${'Lift'.padStart(7)} ${'Surv%'.padStart(7)}`);
  console.log(`  ${'─'.repeat(94)}`);

  const comboResults = [];
  for (const combo of combos) {
    const idealF = events.filter(e => combo.test(e.features));
    const confirmedF = confirmedEvents.filter(e => combo.test(e.features));
    if (idealF.length < 20) continue;

    const idealWR = idealF.filter(e => e.ideal.mfe >= 30).length / idealF.length;
    const confirmedWR = confirmedF.length > 0 ? confirmedF.filter(e => e.confirmed.mfe >= 30).length / confirmedF.length : 0;
    const survival = confirmedF.length > 0 ? confirmedF.length / idealF.length : 0;

    comboResults.push({ name: combo.name, idealWR, idealCount: idealF.length, confirmedWR, confirmedCount: confirmedF.length, survival });

    console.log(`  ${combo.name.padEnd(40)} ${formatPct(idealWR).padStart(8)} ${String(idealF.length).padStart(7)} ${('+' + formatPct(idealWR - baseWR_ideal)).padStart(7)} ${formatPct(confirmedWR).padStart(8)} ${String(confirmedF.length).padStart(7)} ${('+' + formatPct(confirmedWR - baseWR_confirmed)).padStart(7)} ${formatPct(survival).padStart(7)}`);
  }

  // ============================================================================
  // Long vs Short breakdown
  // ============================================================================

  console.log('\n' + '='.repeat(100));
  console.log('LONG vs SHORT — CONFIRMED ENTRY');
  console.log('='.repeat(100));

  for (const side of ['high', 'low']) {
    const label = side === 'high' ? 'SHORT (swing highs)' : 'LONG (swing lows)';
    const sideEvents = events.filter(e => e.type === side);
    const sideConfirmed = confirmedEvents.filter(e => e.type === side);

    console.log(`\n  ${label}:`);
    console.log(`    Total: ${sideEvents.length} | Confirmed: ${sideConfirmed.length} (${formatPct(sideConfirmed.length / sideEvents.length)} survival)`);

    for (const thresh of [20, 30, 50]) {
      const idealWR = sideEvents.filter(e => e.ideal.mfe >= thresh).length / sideEvents.length;
      const confirmedWR = sideConfirmed.length > 0 ? sideConfirmed.filter(e => e.confirmed.mfe >= thresh).length / sideConfirmed.length : 0;
      console.log(`    MFE ≥ ${thresh}: ideal ${formatPct(idealWR)} → confirmed ${formatPct(confirmedWR)}`);
    }
  }

  // ============================================================================
  // Session breakdown — confirmed entry
  // ============================================================================

  console.log('\n' + '='.repeat(100));
  console.log('SESSION BREAKDOWN — CONFIRMED ENTRY (MFE ≥ 30pts)');
  console.log('='.repeat(100));

  const sessions = ['rth', 'premarket', 'overnight', 'afterhours'];
  console.log(`\n  ${'Session'.padEnd(14)} ${'Ideal'.padStart(20)} ${'Confirmed'.padStart(24)}`);
  console.log(`  ${''.padEnd(14)} ${'WR'.padStart(8)} ${'Count'.padStart(7)} ${'WR'.padStart(8)} ${'Count'.padStart(7)} ${'Surv%'.padStart(7)}`);
  console.log(`  ${'─'.repeat(56)}`);

  for (const sess of sessions) {
    const sIdeal = events.filter(e => e.session === sess);
    const sConf = confirmedEvents.filter(e => e.session === sess);
    if (!sIdeal.length) continue;
    const idealWR = sIdeal.filter(e => e.ideal.mfe >= 30).length / sIdeal.length;
    const confWR = sConf.length > 0 ? sConf.filter(e => e.confirmed.mfe >= 30).length / sConf.length : 0;
    console.log(`  ${sess.padEnd(14)} ${formatPct(idealWR).padStart(8)} ${String(sIdeal.length).padStart(7)} ${formatPct(confWR).padStart(8)} ${String(sConf.length).padStart(7)} ${formatPct(sConf.length / sIdeal.length).padStart(7)}`);
  }

  // Summary
  console.log('\n' + '='.repeat(100));
  console.log('SUMMARY');
  console.log('='.repeat(100));

  console.log(`\n  Swing invalidation during ${LOOKBACK}-bar confirmation window: ${formatPct(invalidatedCount / events.length)}`);
  console.log(`  Entry slippage (mean): ${formatNum(mean(slippages))} pts`);
  console.log(`\n  Base win rate (MFE ≥ 30pts):`);
  console.log(`    Ideal:     ${formatPct(baseWR_ideal)}`);
  console.log(`    Confirmed: ${formatPct(baseWR_confirmed)}`);
  console.log(`    Degradation: ${formatPct(baseWR_ideal - baseWR_confirmed)}`);

  const bestCombo = comboResults.sort((a, b) =>
    (b.confirmedWR * Math.log(b.confirmedCount + 1)) - (a.confirmedWR * Math.log(a.confirmedCount + 1))
  )[0];
  if (bestCombo) {
    console.log(`\n  Best combo (confirmed entry): ${bestCombo.name}`);
    console.log(`    Ideal WR: ${formatPct(bestCombo.idealWR)} on ${bestCombo.idealCount} swings`);
    console.log(`    Confirmed WR: ${formatPct(bestCombo.confirmedWR)} on ${bestCombo.confirmedCount} swings`);
  }

  // Save
  const outputData = {
    config: { startDate: startDateStr, endDate: endDateStr, lookback: LOOKBACK, maxStop: MAX_STOP },
    summary: {
      totalSwings: events.length,
      invalidatedBeforeConfirmation: invalidatedCount,
      confirmedSwings: confirmedEvents.length,
      baseWR_ideal: baseWR_ideal,
      baseWR_confirmed: baseWR_confirmed,
      entrySlippage: { mean: mean(slippages), median: median(slippages) },
    },
    comboResults,
  };
  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  console.log(`\nResults saved to ${outputPath}`);
  console.log(`Runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
