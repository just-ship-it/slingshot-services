#!/usr/bin/env node
/**
 * Impulse Candle & Imbalance Analysis
 *
 * Finds abnormal 1m candles on NQ that occur OUTSIDE of scheduled news windows.
 * These are the "organic" institutional moves — algorithmic executions that leave
 * footprints in price action at random times like 2:47 PM.
 *
 * Analyzes:
 * 1. Abnormal candle detection (body Z-score + volume Z-score)
 * 2. Fair Value Gap (FVG) creation — did the impulse leave an imbalance?
 * 3. Prior FVG context — did the impulse fill a previous FVG?
 * 4. Wick imbalances between adjacent candles
 * 5. Day context — position in day range, prior trend
 * 6. Continuation vs fade — does the move continue or reverse?
 * 7. FVG fill rates — how often do created FVGs get filled?
 *
 * Event windows excluded (ET):
 *   8:25-8:40  (CPI, PPI, NFP, GDP, PCE, Jobless Claims)
 *   9:28-9:37  (Market open)
 *   9:58-10:07 (ISM, Consumer Confidence, JOLTS, Home Sales)
 *   1:58-2:15  (FOMC rate decision, 2pm releases)
 *   2:28-2:42  (FOMC press conference)
 *
 * Usage: node research/impulse-candle-analysis.js [--start 2024-01-01] [--end 2025-12-25] [--ticker NQ]
 */

import fs from 'fs';
import path from 'path';
import { CSVLoader } from '../src/data/csv-loader.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// ── CLI args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
const START = getArg('start', '2024-01-01');
const END = getArg('end', '2025-12-25');
const TICKER = getArg('ticker', 'NQ');

// ── Time helpers ───────────────────────────────────────────────────
function getETMinutes(ts) {
  // Returns minutes since midnight ET (approximate EDT/EST)
  const d = new Date(ts);
  const month = d.getUTCMonth();
  const offset = (month >= 2 && month <= 10) ? 4 : 5; // EDT Mar-Nov, EST otherwise
  const etHours = (d.getUTCHours() - offset + 24) % 24;
  return etHours * 60 + d.getUTCMinutes();
}

function getETHour(ts) {
  return Math.floor(getETMinutes(ts) / 60);
}

function formatET(ts) {
  const mins = getETMinutes(ts);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function getSessionLabel(etMins) {
  const h = Math.floor(etMins / 60);
  if (h >= 18 || h < 4) return 'overnight';
  if (h >= 4 && h < 9) return 'premarket';
  if (h >= 9 && h < 10) return 'rth_open';
  if (h >= 10 && h < 12) return 'rth_morning';
  if (h >= 12 && h < 14) return 'rth_midday';
  if (h >= 14 && h < 16) return 'rth_afternoon';
  return 'afterhours';
}

function getDateKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// ── Event exclusion windows (ET minutes since midnight) ────────────
const EVENT_WINDOWS = [
  { start: 8 * 60 + 25, end: 8 * 60 + 40, label: '8:30 economic release' },
  { start: 9 * 60 + 28, end: 9 * 60 + 37, label: 'market open' },
  { start: 9 * 60 + 58, end: 10 * 60 + 7, label: '10:00 economic release' },
  { start: 13 * 60 + 58, end: 14 * 60 + 15, label: 'FOMC / 2pm release' },
  { start: 14 * 60 + 28, end: 14 * 60 + 42, label: 'FOMC press conference' },
];

function isInEventWindow(ts) {
  const etMins = getETMinutes(ts);
  for (const w of EVENT_WINDOWS) {
    if (etMins >= w.start && etMins <= w.end) return true;
  }
  return false;
}

function isWeekday(ts) {
  const d = new Date(ts);
  const day = d.getUTCDay();
  return day >= 1 && day <= 5;
}

// ── Rolling stats ──────────────────────────────────────────────────
class RollingStats {
  constructor(size) {
    this.size = size;
    this.values = [];
  }
  push(val) {
    this.values.push(val);
    if (this.values.length > this.size) this.values.shift();
  }
  get mean() {
    if (!this.values.length) return 0;
    return this.values.reduce((a, b) => a + b, 0) / this.values.length;
  }
  get stddev() {
    if (this.values.length < 2) return 0;
    const m = this.mean;
    return Math.sqrt(this.values.reduce((s, v) => s + (v - m) ** 2, 0) / (this.values.length - 1));
  }
  zScore(val) {
    const sd = this.stddev;
    if (sd === 0 || this.values.length < this.size) return 0;
    return (val - this.mean) / sd;
  }
  get isFull() { return this.values.length >= this.size; }
  get last() { return this.values[this.values.length - 1]; }
}

function round(v, d = 2) { return Math.round(v * 10 ** d) / 10 ** d; }

// ── FVG detection ──────────────────────────────────────────────────
// Bullish FVG: candle[i-2].high < candle[i].low (gap up through middle candle)
// Bearish FVG: candle[i-2].low > candle[i].high (gap down through middle candle)
function detectFVG(candleMinus2, candleMinus1, candle) {
  if (!candleMinus2 || !candleMinus1 || !candle) return null;

  const bullGap = candle.low - candleMinus2.high;
  const bearGap = candleMinus2.low - candle.high;

  if (bullGap > 0) {
    return {
      type: 'bullish',
      gapSize: bullGap,
      top: candle.low,
      bottom: candleMinus2.high,
      middleBody: Math.abs(candleMinus1.close - candleMinus1.open),
      middleRange: candleMinus1.high - candleMinus1.low,
    };
  }
  if (bearGap > 0) {
    return {
      type: 'bearish',
      gapSize: bearGap,
      top: candleMinus2.low,
      bottom: candle.high,
      middleBody: Math.abs(candleMinus1.close - candleMinus1.open),
      middleRange: candleMinus1.high - candleMinus1.low,
    };
  }
  return null;
}

// ── Wick imbalance between adjacent candles ────────────────────────
// Volume imbalance: no wick overlap at all between two adjacent candles
// Wick imbalance: wicks overlap but bodies don't (softer signal)
function detectWickImbalance(prev, curr) {
  if (!prev || !curr) return null;

  // Full gap (no wick overlap)
  if (curr.low > prev.high) {
    return { type: 'gap_up', size: curr.low - prev.high };
  }
  if (curr.high < prev.low) {
    return { type: 'gap_down', size: prev.low - curr.high };
  }

  // Body gap but wick overlap
  const prevBodyHigh = Math.max(prev.open, prev.close);
  const prevBodyLow = Math.min(prev.open, prev.close);
  const currBodyHigh = Math.max(curr.open, curr.close);
  const currBodyLow = Math.min(curr.open, curr.close);

  if (currBodyLow > prevBodyHigh) {
    return { type: 'body_gap_up', size: currBodyLow - prevBodyHigh };
  }
  if (currBodyHigh < prevBodyLow) {
    return { type: 'body_gap_down', size: prevBodyLow - currBodyHigh };
  }

  return null;
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`  IMPULSE CANDLE & IMBALANCE ANALYSIS — ${TICKER}`);
  console.log(`  Period: ${START} to ${END}`);
  console.log(`  Event windows excluded: ${EVENT_WINDOWS.map(w => w.label).join(', ')}`);
  console.log(`${'='.repeat(72)}\n`);

  // Load data
  const defaultConfig = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf8'
  ));
  const loader = new CSVLoader(DATA_DIR, defaultConfig, { noContinuous: false });
  const { candles } = await loader.loadOHLCVData(TICKER, new Date(START), new Date(END));
  console.log(`Loaded ${candles.length.toLocaleString()} candles\n`);

  // ── Build features for every candle ──────────────────────────────
  const bodyStats = new RollingStats(20);
  const rangeStats = new RollingStats(20);
  const volStats = new RollingStats(20);
  const rangeShort = new RollingStats(5);  // compression detection
  const rangeLong = new RollingStats(50);

  // Track active FVGs for fill analysis
  const activeFVGs = []; // { type, top, bottom, createdAt, createdIndex }
  const MAX_ACTIVE_FVGS = 50;

  // Per-day tracking for day context
  let currentDay = '';
  let dayHigh = -Infinity;
  let dayLow = Infinity;
  let dayOpen = 0;
  let rthHigh = -Infinity;
  let rthLow = Infinity;

  const allFeatures = [];
  let totalExcluded = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    const direction = c.close > c.open ? 'bull' : c.close < c.open ? 'bear' : 'doji';
    const bodyRangeRatio = range > 0 ? body / range : 0;

    // Day tracking
    const day = getDateKey(c.timestamp);
    if (day !== currentDay) {
      currentDay = day;
      dayHigh = c.high;
      dayLow = c.low;
      dayOpen = c.open;
      rthHigh = -Infinity;
      rthLow = Infinity;
    } else {
      dayHigh = Math.max(dayHigh, c.high);
      dayLow = Math.min(dayLow, c.low);
    }

    const etMins = getETMinutes(c.timestamp);
    const isRTH = etMins >= 9 * 60 + 30 && etMins < 16 * 60;
    if (isRTH) {
      rthHigh = Math.max(rthHigh, c.high);
      rthLow = Math.min(rthLow, c.low);
    }

    // Z-scores
    const bodyZ = bodyStats.zScore(body);
    const volumeZ = volStats.zScore(c.volume);

    // Compression
    const shortRange = rangeShort.mean;
    const longRange = rangeLong.mean;
    const compression = longRange > 0 ? shortRange / longRange : 1;

    // FVG detection (this candle completes a potential FVG)
    let fvgCreated = null;
    if (i >= 2) {
      fvgCreated = detectFVG(candles[i - 2], candles[i - 1], c);
    }

    // Track FVG creation
    if (fvgCreated) {
      activeFVGs.push({
        ...fvgCreated,
        createdAt: c.timestamp,
        createdIndex: i,
        filled: false,
        filledAt: null,
      });
      // Prune old FVGs
      while (activeFVGs.length > MAX_ACTIVE_FVGS) activeFVGs.shift();
    }

    // Check if this candle fills any active FVGs
    let fvgsFilled = 0;
    let nearestUnfilledFVG = null;
    for (const fvg of activeFVGs) {
      if (fvg.filled) continue;
      // Check if price entered the FVG zone
      if (fvg.type === 'bullish' && c.low <= fvg.top && c.low >= fvg.bottom) {
        fvg.filled = true;
        fvg.filledAt = c.timestamp;
        fvg.filledIndex = i;
        fvgsFilled++;
      } else if (fvg.type === 'bearish' && c.high >= fvg.bottom && c.high <= fvg.top) {
        fvg.filled = true;
        fvg.filledAt = c.timestamp;
        fvg.filledIndex = i;
        fvgsFilled++;
      }

      // Track nearest unfilled FVG
      if (!fvg.filled) {
        const dist = fvg.type === 'bullish'
          ? c.close - fvg.top  // positive = above FVG
          : fvg.bottom - c.close;
        if (!nearestUnfilledFVG || Math.abs(dist) < Math.abs(nearestUnfilledFVG.distance)) {
          nearestUnfilledFVG = { ...fvg, distance: dist };
        }
      }
    }

    // Wick imbalance with previous candle
    const wickImbalance = i > 0 ? detectWickImbalance(candles[i - 1], c) : null;

    // Prior trend (20-bar close change)
    const trend20 = i >= 20 ? c.close - candles[i - 20].close : 0;
    const trend5 = i >= 5 ? c.close - candles[i - 5].close : 0;

    // Position in day range
    const dayRange = dayHigh - dayLow;
    const dayPosition = dayRange > 0 ? (c.close - dayLow) / dayRange : 0.5;

    const isEventWindow = isInEventWindow(c.timestamp);
    if (isEventWindow) totalExcluded++;

    allFeatures.push({
      index: i,
      timestamp: c.timestamp,
      open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume,
      body, range, direction, bodyRangeRatio,
      bodyZ, volumeZ, compression,
      session: getSessionLabel(etMins),
      etMins,
      isEventWindow,
      isRTH,
      fvgCreated,
      fvgsFilled,
      nearestUnfilledFVG,
      wickImbalance,
      trend20, trend5,
      dayPosition,
      dayRange,
    });

    // Update rolling stats
    bodyStats.push(body);
    rangeStats.push(range);
    volStats.push(c.volume);
    rangeShort.push(range);
    rangeLong.push(range);
  }

  console.log(`Total candles excluded by event windows: ${totalExcluded.toLocaleString()}\n`);

  // ── Filter to organic impulse candles ────────────────────────────
  // These are the abnormal candles OUTSIDE of scheduled events
  const BODY_Z_THRESH = 2.0;
  const VOL_Z_THRESH = 1.0;

  const organicImpulses = allFeatures.filter(f =>
    !f.isEventWindow &&
    f.bodyZ >= BODY_Z_THRESH &&
    f.volumeZ >= VOL_Z_THRESH &&
    f.direction !== 'doji' &&
    f.index + 30 < candles.length &&
    f.index >= 50  // need history
  );

  console.log(`${'─'.repeat(60)}`);
  console.log(`ORGANIC IMPULSE CANDLES (BodyZ >= ${BODY_Z_THRESH}, VolZ >= ${VOL_Z_THRESH}, no events)`);
  console.log(`Found: ${organicImpulses.length} impulses out of ${allFeatures.length.toLocaleString()} candles`);
  console.log(`${'─'.repeat(60)}`);

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 1: Basic follow-through for organic impulses
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 1: Raw follow-through (continuation vs fade)');
  console.log(`${'═'.repeat(60)}`);

  printFollowThrough('All organic impulses', organicImpulses, candles);

  // Bull vs Bear
  const bulls = organicImpulses.filter(f => f.direction === 'bull');
  const bears = organicImpulses.filter(f => f.direction === 'bear');
  printFollowThrough('Bullish impulses', bulls, candles);
  printFollowThrough('Bearish impulses', bears, candles);

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 2: FVG analysis — did the impulse create an FVG?
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 2: FVG creation context');
  console.log(`${'═'.repeat(60)}`);

  // Check if the impulse candle is the MIDDLE candle of an FVG
  // (i.e., candle at index+1 will complete the FVG pattern)
  const impulseCreatesFVG = [];
  const impulseNoFVG = [];

  for (const imp of organicImpulses) {
    // Check if candle at imp.index+1 creates an FVG where imp is the middle
    if (imp.index + 1 < candles.length && imp.index >= 1) {
      const fvg = detectFVG(candles[imp.index - 1], candles[imp.index], candles[imp.index + 1]);
      if (fvg) {
        impulseCreatesFVG.push({ ...imp, createdFVG: fvg });
      } else {
        impulseNoFVG.push(imp);
      }
    }
  }

  console.log(`\n  Impulses that ARE the middle of an FVG: ${impulseCreatesFVG.length} (${round(impulseCreatesFVG.length / organicImpulses.length * 100)}%)`);
  console.log(`  Impulses with NO FVG created: ${impulseNoFVG.length}`);

  printFollowThrough('Impulse + FVG created', impulseCreatesFVG, candles);
  printFollowThrough('Impulse + NO FVG', impulseNoFVG, candles);

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 3: Wick imbalance analysis
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 3: Wick imbalance context');
  console.log(`${'═'.repeat(60)}`);

  const withWickImbalance = organicImpulses.filter(f => f.wickImbalance !== null);
  const withGap = organicImpulses.filter(f => f.wickImbalance && (f.wickImbalance.type === 'gap_up' || f.wickImbalance.type === 'gap_down'));
  const withBodyGap = organicImpulses.filter(f => f.wickImbalance && (f.wickImbalance.type === 'body_gap_up' || f.wickImbalance.type === 'body_gap_down'));
  const noImbalance = organicImpulses.filter(f => f.wickImbalance === null);

  console.log(`\n  With full wick gap: ${withGap.length}`);
  console.log(`  With body gap only: ${withBodyGap.length}`);
  console.log(`  No imbalance: ${noImbalance.length}`);

  if (withGap.length >= 10) printFollowThrough('Full wick gap', withGap, candles);
  if (withBodyGap.length >= 10) printFollowThrough('Body gap only', withBodyGap, candles);
  printFollowThrough('No wick imbalance', noImbalance, candles);

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 4: Compression before impulse
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 4: Compression -> Expansion (the spring)');
  console.log(`${'═'.repeat(60)}`);

  for (const compThresh of [0.4, 0.5, 0.6, 0.7, 0.8]) {
    const compressed = organicImpulses.filter(f => f.compression <= compThresh && f.compression > 0);
    if (compressed.length < 10) continue;

    const ft = measureFollowThrough(compressed, candles, [3, 5, 10]);
    const r5 = ft[5];
    console.log(`  Compression <= ${compThresh} (n=${compressed.length}): ` +
      `5bar cont=${round(r5.continuationRate * 100)}%  MFE=${round(r5.avgMFE)}  MAE=${round(r5.avgMAE)}  ` +
      `ratio=${round(r5.avgMFE / Math.max(r5.avgMAE, 0.01))}`);
  }

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 5: Day position context — fade vs continue
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 5: Day position — do impulses at extremes fade?');
  console.log(`${'═'.repeat(60)}`);

  // Bull impulses at different day positions
  console.log('\n  BULL impulses by day position:');
  for (const [label, minPos, maxPos] of [
    ['Bottom 20% of day range', 0, 0.2],
    ['Lower middle (20-40%)', 0.2, 0.4],
    ['Middle (40-60%)', 0.4, 0.6],
    ['Upper middle (60-80%)', 0.6, 0.8],
    ['Top 20% of day range', 0.8, 1.0],
  ]) {
    const filtered = bulls.filter(f => f.dayPosition >= minPos && f.dayPosition < maxPos);
    if (filtered.length < 10) continue;
    const ft = measureFollowThrough(filtered, candles, [3, 5, 10]);
    const r5 = ft[5];
    console.log(`    ${label.padEnd(30)} (n=${String(filtered.length).padStart(4)}): ` +
      `5bar cont=${round(r5.continuationRate * 100).toFixed(1).padStart(5)}%  ` +
      `MFE=${round(r5.avgMFE).toFixed(1).padStart(6)}  MAE=${round(r5.avgMAE).toFixed(1).padStart(6)}  ` +
      `net=${round(r5.avgNet).toFixed(1).padStart(6)}`);
  }

  console.log('\n  BEAR impulses by day position:');
  for (const [label, minPos, maxPos] of [
    ['Bottom 20% of day range', 0, 0.2],
    ['Lower middle (20-40%)', 0.2, 0.4],
    ['Middle (40-60%)', 0.4, 0.6],
    ['Upper middle (60-80%)', 0.6, 0.8],
    ['Top 20% of day range', 0.8, 1.0],
  ]) {
    const filtered = bears.filter(f => f.dayPosition >= minPos && f.dayPosition < maxPos);
    if (filtered.length < 10) continue;
    const ft = measureFollowThrough(filtered, candles, [3, 5, 10]);
    const r5 = ft[5];
    console.log(`    ${label.padEnd(30)} (n=${String(filtered.length).padStart(4)}): ` +
      `5bar cont=${round(r5.continuationRate * 100).toFixed(1).padStart(5)}%  ` +
      `MFE=${round(r5.avgMFE).toFixed(1).padStart(6)}  MAE=${round(r5.avgMAE).toFixed(1).padStart(6)}  ` +
      `net=${round(r5.avgNet).toFixed(1).padStart(6)}`);
  }

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 6: Prior trend context
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 6: Prior trend — impulse with vs against trend');
  console.log(`${'═'.repeat(60)}`);

  // Bull impulse after bullish trend (continuation) vs bearish trend (reversal)
  const bullWithTrend = bulls.filter(f => f.trend20 > 0);
  const bullAgainstTrend = bulls.filter(f => f.trend20 < 0);
  const bearWithTrend = bears.filter(f => f.trend20 < 0);
  const bearAgainstTrend = bears.filter(f => f.trend20 > 0);

  console.log('\n  WITH trend (impulse confirms prior direction):');
  printFollowThrough('Bull impulse + bullish 20bar', bullWithTrend, candles, [3, 5, 10]);
  printFollowThrough('Bear impulse + bearish 20bar', bearWithTrend, candles, [3, 5, 10]);

  console.log('\n  AGAINST trend (impulse reverses prior direction):');
  printFollowThrough('Bull impulse + bearish 20bar', bullAgainstTrend, candles, [3, 5, 10]);
  printFollowThrough('Bear impulse + bullish 20bar', bearAgainstTrend, candles, [3, 5, 10]);

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 7: Session breakdown
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 7: Session effects');
  console.log(`${'═'.repeat(60)}`);

  const sessions = {};
  for (const imp of organicImpulses) {
    if (!sessions[imp.session]) sessions[imp.session] = [];
    sessions[imp.session].push(imp);
  }

  for (const [session, imps] of Object.entries(sessions).sort((a, b) => b[1].length - a[1].length)) {
    if (imps.length < 10) continue;
    const ft = measureFollowThrough(imps, candles, [3, 5, 10]);
    const r5 = ft[5];
    console.log(`  ${session.padEnd(16)} (n=${String(imps.length).padStart(5)}): ` +
      `5bar cont=${round(r5.continuationRate * 100)}%  MFE=${round(r5.avgMFE)}  MAE=${round(r5.avgMAE)}  ` +
      `net=${round(r5.avgNet)}`);
  }

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 8: Body/range ratio (conviction) tiers
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 8: Conviction tiers (body/range ratio)');
  console.log(`${'═'.repeat(60)}`);

  for (const [label, minBRR, maxBRR] of [
    ['Low conviction (BRR 0.3-0.5)', 0.3, 0.5],
    ['Medium conviction (BRR 0.5-0.7)', 0.5, 0.7],
    ['High conviction (BRR 0.7-0.85)', 0.7, 0.85],
    ['Very high conviction (BRR > 0.85)', 0.85, 1.01],
  ]) {
    const filtered = organicImpulses.filter(f => f.bodyRangeRatio >= minBRR && f.bodyRangeRatio < maxBRR);
    if (filtered.length < 10) continue;
    const ft = measureFollowThrough(filtered, candles, [1, 3, 5, 10]);
    const r5 = ft[5];
    const r1 = ft[1];
    console.log(`  ${label.padEnd(38)} (n=${String(filtered.length).padStart(4)}): ` +
      `1bar=${round(r1.continuationRate * 100)}%  5bar=${round(r5.continuationRate * 100)}%  ` +
      `MFE5=${round(r5.avgMFE)}  MAE5=${round(r5.avgMAE)}  net5=${round(r5.avgNet)}`);
  }

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 9: Body Z-score tiers
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 9: Body Z-score tiers (how abnormal)');
  console.log(`${'═'.repeat(60)}`);

  for (const [label, minZ, maxZ] of [
    ['Moderate (Z 2.0-2.5)', 2.0, 2.5],
    ['Strong (Z 2.5-3.0)', 2.5, 3.0],
    ['Very strong (Z 3.0-4.0)', 3.0, 4.0],
    ['Extreme (Z > 4.0)', 4.0, 100],
  ]) {
    const filtered = organicImpulses.filter(f => f.bodyZ >= minZ && f.bodyZ < maxZ);
    if (filtered.length < 10) continue;
    const ft = measureFollowThrough(filtered, candles, [1, 3, 5, 10, 20]);
    const r5 = ft[5];
    const r10 = ft[10];
    console.log(`  ${label.padEnd(28)} (n=${String(filtered.length).padStart(4)}): ` +
      `5bar cont=${round(r5.continuationRate * 100)}%  10bar cont=${round(r10.continuationRate * 100)}%  ` +
      `MFE5=${round(r5.avgMFE)}  MAE5=${round(r5.avgMAE)}  net10=${round(r10.avgNet)}`);
  }

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 10: FVG fill analysis — do created FVGs get filled?
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 10: FVG fill rates');
  console.log(`${'═'.repeat(60)}`);

  // Re-scan all FVGs in the dataset
  const allFVGs = [];
  for (let i = 2; i < candles.length - 60; i++) {
    const fvg = detectFVG(candles[i - 2], candles[i - 1], candles[i]);
    if (!fvg) continue;

    // Skip event windows
    if (isInEventWindow(candles[i - 1].timestamp)) continue;

    // Is the middle candle an impulse? (check body size)
    const midBody = Math.abs(candles[i - 1].close - candles[i - 1].open);
    const midRange = candles[i - 1].high - candles[i - 1].low;

    // Check fill over next N candles
    let fillBars = null;
    for (let j = 1; j <= 60; j++) {
      if (i + j >= candles.length) break;
      const fc = candles[i + j];
      if (fvg.type === 'bullish' && fc.low <= fvg.top) {
        fillBars = j;
        break;
      }
      if (fvg.type === 'bearish' && fc.high >= fvg.bottom) {
        fillBars = j;
        break;
      }
    }

    allFVGs.push({
      type: fvg.type,
      gapSize: fvg.gapSize,
      midBody, midRange,
      timestamp: candles[i - 1].timestamp,
      fillBars,
      filled: fillBars !== null,
    });
  }

  console.log(`\n  Total non-event FVGs found: ${allFVGs.length.toLocaleString()}`);

  const bullFVGs = allFVGs.filter(f => f.type === 'bullish');
  const bearFVGs = allFVGs.filter(f => f.type === 'bearish');

  for (const [label, fvgs] of [['Bullish FVGs', bullFVGs], ['Bearish FVGs', bearFVGs]]) {
    if (fvgs.length < 10) continue;
    const filled = fvgs.filter(f => f.filled);
    const fillRates = {};
    for (const window of [5, 10, 20, 30, 60]) {
      fillRates[window] = fvgs.filter(f => f.fillBars !== null && f.fillBars <= window).length / fvgs.length;
    }
    console.log(`\n  ${label} (n=${fvgs.length}):`);
    console.log(`    Fill rate: 5bar=${round(fillRates[5] * 100)}%  10bar=${round(fillRates[10] * 100)}%  ` +
      `20bar=${round(fillRates[20] * 100)}%  30bar=${round(fillRates[30] * 100)}%  60bar=${round(fillRates[60] * 100)}%`);
    console.log(`    Avg gap size: ${round(fvgs.reduce((s, f) => s + f.gapSize, 0) / fvgs.length)} pts`);

    // Large FVGs vs small
    const medianGap = sorted(fvgs.map(f => f.gapSize))[Math.floor(fvgs.length / 2)];
    const largeFVGs = fvgs.filter(f => f.gapSize > medianGap);
    const smallFVGs = fvgs.filter(f => f.gapSize <= medianGap);

    const largeFillRate30 = largeFVGs.filter(f => f.fillBars !== null && f.fillBars <= 30).length / largeFVGs.length;
    const smallFillRate30 = smallFVGs.filter(f => f.fillBars !== null && f.fillBars <= 30).length / smallFVGs.length;
    console.log(`    Large gaps (>${round(medianGap)}pts): 30bar fill=${round(largeFillRate30 * 100)}%`);
    console.log(`    Small gaps (<=${round(medianGap)}pts): 30bar fill=${round(smallFillRate30 * 100)}%`);
  }

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 11: Simulated trades — continuation entry
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 11: Simulated trading — ride the impulse');
  console.log(`${'═'.repeat(60)}`);

  // Entry at impulse candle close, in the direction of the impulse
  const rrConfigs = [
    { stop: 8, target: 16, label: '8/16 (2R)' },
    { stop: 10, target: 15, label: '10/15 (1.5R)' },
    { stop: 10, target: 20, label: '10/20 (2R)' },
    { stop: 10, target: 30, label: '10/30 (3R)' },
    { stop: 15, target: 22, label: '15/22 (1.5R)' },
    { stop: 15, target: 30, label: '15/30 (2R)' },
    { stop: 20, target: 30, label: '20/30 (1.5R)' },
    { stop: 20, target: 40, label: '20/40 (2R)' },
  ];

  console.log('\n  CONTINUATION trades (enter in direction of impulse):');
  for (const rr of rrConfigs) {
    const res = simulateTrades(organicImpulses, candles, rr.stop, rr.target, 20, 'continue');
    printTradeResults(rr.label, res);
  }

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 12: Simulated trades — FADE the impulse
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 12: Simulated trading — FADE the impulse');
  console.log(`${'═'.repeat(60)}`);

  console.log('\n  FADE trades (enter AGAINST the impulse direction):');
  for (const rr of rrConfigs) {
    const res = simulateTrades(organicImpulses, candles, rr.stop, rr.target, 20, 'fade');
    printTradeResults(rr.label, res);
  }

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 13: Continuation vs Fade by context
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 13: When to continue vs when to fade');
  console.log(`${'═'.repeat(60)}`);

  const stopPts = 12;
  const targetPts = 20;

  console.log(`\n  Using ${stopPts}/${targetPts} stop/target for comparison:\n`);

  // By day position
  console.log('  BY DAY POSITION:');
  for (const [label, minPos, maxPos] of [
    ['Bottom 25%', 0, 0.25],
    ['Middle 50%', 0.25, 0.75],
    ['Top 25%', 0.75, 1.0],
  ]) {
    const filtered = organicImpulses.filter(f => f.dayPosition >= minPos && f.dayPosition < maxPos);
    if (filtered.length < 10) continue;

    const contRes = simulateTrades(filtered, candles, stopPts, targetPts, 20, 'continue');
    const fadeRes = simulateTrades(filtered, candles, stopPts, targetPts, 20, 'fade');

    const contWR = contRes.trades.length > 0 ? contRes.trades.filter(t => t.pnl > 0).length / contRes.trades.length : 0;
    const fadeWR = fadeRes.trades.length > 0 ? fadeRes.trades.filter(t => t.pnl > 0).length / fadeRes.trades.length : 0;
    const contPnl = contRes.trades.reduce((s, t) => s + t.pnl, 0);
    const fadePnl = fadeRes.trades.reduce((s, t) => s + t.pnl, 0);

    console.log(`    ${label.padEnd(14)} (n=${String(filtered.length).padStart(4)}): ` +
      `CONTINUE WR=${round(contWR * 100)}% PnL=${round(contPnl)}  |  ` +
      `FADE WR=${round(fadeWR * 100)}% PnL=${round(fadePnl)}  |  ` +
      `${contPnl > fadePnl ? 'CONTINUE wins' : 'FADE wins'}`);
  }

  // By prior trend
  console.log('\n  BY PRIOR TREND (20-bar):');
  for (const [label, filter] of [
    ['Strong down trend', f => f.trend20 < -30],
    ['Mild down trend', f => f.trend20 >= -30 && f.trend20 < 0],
    ['Mild up trend', f => f.trend20 >= 0 && f.trend20 < 30],
    ['Strong up trend', f => f.trend20 >= 30],
  ]) {
    const filtered = organicImpulses.filter(filter);
    if (filtered.length < 10) continue;

    const contRes = simulateTrades(filtered, candles, stopPts, targetPts, 20, 'continue');
    const fadeRes = simulateTrades(filtered, candles, stopPts, targetPts, 20, 'fade');

    const contWR = contRes.trades.length > 0 ? contRes.trades.filter(t => t.pnl > 0).length / contRes.trades.length : 0;
    const fadeWR = fadeRes.trades.length > 0 ? fadeRes.trades.filter(t => t.pnl > 0).length / fadeRes.trades.length : 0;
    const contPnl = contRes.trades.reduce((s, t) => s + t.pnl, 0);
    const fadePnl = fadeRes.trades.reduce((s, t) => s + t.pnl, 0);

    console.log(`    ${label.padEnd(20)} (n=${String(filtered.length).padStart(4)}): ` +
      `CONTINUE WR=${round(contWR * 100)}% PnL=${round(contPnl)}  |  ` +
      `FADE WR=${round(fadeWR * 100)}% PnL=${round(fadePnl)}`);
  }

  // By session
  console.log('\n  BY SESSION:');
  for (const session of ['rth_open', 'rth_morning', 'rth_midday', 'rth_afternoon', 'premarket', 'overnight']) {
    const filtered = organicImpulses.filter(f => f.session === session);
    if (filtered.length < 10) continue;

    const contRes = simulateTrades(filtered, candles, stopPts, targetPts, 20, 'continue');
    const fadeRes = simulateTrades(filtered, candles, stopPts, targetPts, 20, 'fade');

    const contWR = contRes.trades.length > 0 ? contRes.trades.filter(t => t.pnl > 0).length / contRes.trades.length : 0;
    const fadeWR = fadeRes.trades.length > 0 ? fadeRes.trades.filter(t => t.pnl > 0).length / fadeRes.trades.length : 0;
    const contPnl = contRes.trades.reduce((s, t) => s + t.pnl, 0);
    const fadePnl = fadeRes.trades.reduce((s, t) => s + t.pnl, 0);

    console.log(`    ${session.padEnd(16)} (n=${String(filtered.length).padStart(4)}): ` +
      `CONTINUE WR=${round(contWR * 100)}% PnL=${round(contPnl)}  |  ` +
      `FADE WR=${round(fadeWR * 100)}% PnL=${round(fadePnl)}`);
  }

  // By FVG context
  console.log('\n  BY FVG CONTEXT:');
  const withFVG = impulseCreatesFVG;
  const withoutFVG = impulseNoFVG;

  if (withFVG.length >= 10) {
    const contRes = simulateTrades(withFVG, candles, stopPts, targetPts, 20, 'continue');
    const fadeRes = simulateTrades(withFVG, candles, stopPts, targetPts, 20, 'fade');
    const contWR = contRes.trades.filter(t => t.pnl > 0).length / contRes.trades.length;
    const fadeWR = fadeRes.trades.filter(t => t.pnl > 0).length / fadeRes.trades.length;
    const contPnl = contRes.trades.reduce((s, t) => s + t.pnl, 0);
    const fadePnl = fadeRes.trades.reduce((s, t) => s + t.pnl, 0);
    console.log(`    FVG created     (n=${String(withFVG.length).padStart(4)}): ` +
      `CONTINUE WR=${round(contWR * 100)}% PnL=${round(contPnl)}  |  ` +
      `FADE WR=${round(fadeWR * 100)}% PnL=${round(fadePnl)}`);
  }

  if (withoutFVG.length >= 10) {
    const contRes = simulateTrades(withoutFVG, candles, stopPts, targetPts, 20, 'continue');
    const fadeRes = simulateTrades(withoutFVG, candles, stopPts, targetPts, 20, 'fade');
    const contWR = contRes.trades.filter(t => t.pnl > 0).length / contRes.trades.length;
    const fadeWR = fadeRes.trades.filter(t => t.pnl > 0).length / fadeRes.trades.length;
    const contPnl = contRes.trades.reduce((s, t) => s + t.pnl, 0);
    const fadePnl = fadeRes.trades.reduce((s, t) => s + t.pnl, 0);
    console.log(`    No FVG created  (n=${String(withoutFVG.length).padStart(4)}): ` +
      `CONTINUE WR=${round(contWR * 100)}% PnL=${round(contPnl)}  |  ` +
      `FADE WR=${round(fadeWR * 100)}% PnL=${round(fadePnl)}`);
  }

  // By conviction (body/range ratio)
  console.log('\n  BY CONVICTION:');
  for (const [label, minBRR, maxBRR] of [
    ['Low (BRR < 0.5)', 0, 0.5],
    ['Medium (BRR 0.5-0.7)', 0.5, 0.7],
    ['High (BRR >= 0.7)', 0.7, 1.01],
  ]) {
    const filtered = organicImpulses.filter(f => f.bodyRangeRatio >= minBRR && f.bodyRangeRatio < maxBRR);
    if (filtered.length < 10) continue;

    const contRes = simulateTrades(filtered, candles, stopPts, targetPts, 20, 'continue');
    const fadeRes = simulateTrades(filtered, candles, stopPts, targetPts, 20, 'fade');
    const contWR = contRes.trades.filter(t => t.pnl > 0).length / contRes.trades.length;
    const fadeWR = fadeRes.trades.filter(t => t.pnl > 0).length / fadeRes.trades.length;
    const contPnl = contRes.trades.reduce((s, t) => s + t.pnl, 0);
    const fadePnl = fadeRes.trades.reduce((s, t) => s + t.pnl, 0);
    console.log(`    ${label.padEnd(22)} (n=${String(filtered.length).padStart(4)}): ` +
      `CONTINUE WR=${round(contWR * 100)}% PnL=${round(contPnl)}  |  ` +
      `FADE WR=${round(fadeWR * 100)}% PnL=${round(fadePnl)}`);
  }

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 14: Confirmation bar pattern
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 14: Confirmation bar — wait for non-retrace');
  console.log(`${'═'.repeat(60)}`);

  for (const retracePct of [0.25, 0.33, 0.5]) {
    const confirmed = [];
    for (const imp of organicImpulses) {
      if (imp.index + 21 >= candles.length) continue;
      const next = candles[imp.index + 1];
      if (imp.direction === 'bull') {
        const limit = imp.close - imp.body * retracePct;
        if (next.low >= limit) {
          confirmed.push({ ...imp, entryIndex: imp.index + 1, entryPrice: next.close });
        }
      } else {
        const limit = imp.close + imp.body * retracePct;
        if (next.high <= limit) {
          confirmed.push({ ...imp, entryIndex: imp.index + 1, entryPrice: next.close });
        }
      }
    }

    if (confirmed.length < 10) continue;

    const contRes = simulateTrades(confirmed, candles, stopPts, targetPts, 20, 'continue', 'entryIndex', 'entryPrice');
    const wins = contRes.trades.filter(t => t.pnl > 0).length;
    const wr = wins / contRes.trades.length;
    const totalPnl = contRes.trades.reduce((s, t) => s + t.pnl, 0);
    const passRate = round(confirmed.length / organicImpulses.length * 100);

    console.log(`  Retrace < ${(retracePct * 100).toFixed(0)}% (n=${confirmed.length}, ${passRate}% pass): ` +
      `WR=${round(wr * 100)}%  totalPnl=${round(totalPnl)}pts  ` +
      `pnl/trade=${round(totalPnl / confirmed.length)}pts`);
  }

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 15: Year-over-year consistency
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 15: Year-over-year consistency');
  console.log(`${'═'.repeat(60)}`);

  const yearGroups = {};
  for (const imp of organicImpulses) {
    const yr = new Date(imp.timestamp).getUTCFullYear();
    if (!yearGroups[yr]) yearGroups[yr] = [];
    yearGroups[yr].push(imp);
  }

  for (const [year, imps] of Object.entries(yearGroups).sort()) {
    const ft = measureFollowThrough(imps, candles, [5]);
    const r5 = ft[5];

    const contRes = simulateTrades(imps, candles, stopPts, targetPts, 20, 'continue');
    const wins = contRes.trades.filter(t => t.pnl > 0).length;
    const wr = contRes.trades.length > 0 ? wins / contRes.trades.length : 0;
    const totalPnl = contRes.trades.reduce((s, t) => s + t.pnl, 0);

    console.log(`  ${year}: n=${String(imps.length).padStart(5)}  ` +
      `5bar cont=${round(r5.continuationRate * 100)}%  MFE=${round(r5.avgMFE)}  MAE=${round(r5.avgMAE)}  ` +
      `simWR=${round(wr * 100)}%  simPnl=${round(totalPnl)}pts`);
  }

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 16: Sample impulse candles for manual review
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 16: Sample impulse candles (for manual review)');
  console.log(`${'═'.repeat(60)}`);

  // Show 20 random examples
  const samples = organicImpulses
    .filter(f => f.isRTH)
    .sort(() => Math.random() - 0.5)
    .slice(0, 20)
    .sort((a, b) => a.timestamp - b.timestamp);

  console.log('\n  Time (ET)       Dir   Body   Range  BRR   BodyZ  VolZ   Comp   DayPos  FVG?    5bar_net');
  for (const s of samples) {
    const date = new Date(s.timestamp).toISOString().slice(0, 10);
    const et = formatET(s.timestamp);
    const hasFVG = impulseCreatesFVG.find(f => f.index === s.index) ? 'YES' : 'no';

    // 5-bar net
    let net5 = 0;
    if (s.index + 5 < candles.length) {
      const exit = candles[s.index + 5].close;
      net5 = s.direction === 'bull' ? exit - s.close : s.close - exit;
    }

    console.log(`  ${date} ${et.padStart(5)}  ${s.direction.padEnd(5)} ` +
      `${round(s.body).toFixed(1).padStart(6)} ${round(s.range).toFixed(1).padStart(6)} ` +
      `${round(s.bodyRangeRatio).toFixed(2).padStart(5)} ` +
      `${round(s.bodyZ).toFixed(1).padStart(5)}  ${round(s.volumeZ).toFixed(1).padStart(5)}  ` +
      `${round(s.compression).toFixed(2).padStart(5)}  ${round(s.dayPosition).toFixed(2).padStart(5)}   ` +
      `${hasFVG.padEnd(5)}  ${round(net5).toFixed(1).padStart(7)}`);
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log('  ANALYSIS COMPLETE');
  console.log(`${'═'.repeat(72)}\n`);
}

// ── Follow-through measurement ─────────────────────────────────────
function measureFollowThrough(impulses, candles, windows = [1, 2, 3, 5, 10, 15, 20]) {
  const results = {};

  for (const w of windows) {
    const measurements = [];

    for (const imp of impulses) {
      const idx = imp.entryIndex ?? imp.index;
      const entry = imp.entryPrice ?? imp.close;
      const isBull = imp.direction === 'bull';

      if (idx + w >= candles.length) continue;

      let mfe = 0, mae = 0;
      for (let j = 1; j <= w; j++) {
        const c = candles[idx + j];
        if (isBull) {
          mfe = Math.max(mfe, c.high - entry);
          mae = Math.max(mae, entry - c.low);
        } else {
          mfe = Math.max(mfe, entry - c.low);
          mae = Math.max(mae, c.high - entry);
        }
      }

      const exitClose = candles[idx + w].close;
      const net = isBull ? exitClose - entry : entry - exitClose;

      measurements.push({ mfe, mae, net, continued: net > 0 });
    }

    if (!measurements.length) continue;
    const n = measurements.length;

    results[w] = {
      count: n,
      continuationRate: measurements.filter(m => m.continued).length / n,
      avgMFE: measurements.reduce((s, m) => s + m.mfe, 0) / n,
      avgMAE: measurements.reduce((s, m) => s + m.mae, 0) / n,
      avgNet: measurements.reduce((s, m) => s + m.net, 0) / n,
      medianNet: sorted(measurements.map(m => m.net))[Math.floor(n / 2)],
    };
  }

  return results;
}

function sorted(arr) { return [...arr].sort((a, b) => a - b); }

function printFollowThrough(label, impulses, candles, windows = [1, 3, 5, 10, 20]) {
  if (impulses.length < 5) {
    console.log(`\n  ${label} (n=${impulses.length}): too few samples`);
    return;
  }

  const results = measureFollowThrough(impulses, candles, windows);
  console.log(`\n  ${label} (n=${impulses.length}):`);
  for (const w of windows) {
    const r = results[w];
    if (!r) continue;
    console.log(`    ${String(w).padStart(2)}bar: cont=${round(r.continuationRate * 100).toFixed(1).padStart(5)}%  ` +
      `MFE=${round(r.avgMFE).toFixed(1).padStart(6)}  MAE=${round(r.avgMAE).toFixed(1).padStart(6)}  ` +
      `net=${round(r.avgNet).toFixed(1).padStart(6)}  ratio=${round(r.avgMFE / Math.max(r.avgMAE, 0.01)).toFixed(2).padStart(5)}`);
  }
}

// ── Trade simulation ───────────────────────────────────────────────
function simulateTrades(impulses, candles, stopPts, targetPts, maxHold, mode = 'continue', indexField = 'index', priceField = null) {
  const trades = [];

  for (const imp of impulses) {
    const entryIdx = imp[indexField] ?? imp.index;
    const entryPrice = priceField ? imp[priceField] : imp.close;

    // Direction: 'continue' trades in impulse direction, 'fade' trades against
    const isBullEntry = mode === 'continue'
      ? imp.direction === 'bull'
      : imp.direction === 'bear';

    const stop = isBullEntry ? entryPrice - stopPts : entryPrice + stopPts;
    const target = isBullEntry ? entryPrice + targetPts : entryPrice - targetPts;

    let exitPrice = null;
    let exitReason = null;

    for (let j = 1; j <= maxHold && entryIdx + j < candles.length; j++) {
      const c = candles[entryIdx + j];

      if (isBullEntry) {
        if (c.low <= stop) { exitPrice = stop; exitReason = 'stop'; break; }
        if (c.high >= target) { exitPrice = target; exitReason = 'target'; break; }
      } else {
        if (c.high >= stop) { exitPrice = stop; exitReason = 'stop'; break; }
        if (c.low <= target) { exitPrice = target; exitReason = 'target'; break; }
      }
    }

    if (exitPrice === null) {
      const lastIdx = Math.min(entryIdx + maxHold, candles.length - 1);
      exitPrice = candles[lastIdx].close;
      exitReason = 'time';
    }

    const pnl = isBullEntry ? exitPrice - entryPrice : entryPrice - exitPrice;
    trades.push({ timestamp: imp.timestamp, pnl, exitReason, direction: isBullEntry ? 'bull' : 'bear' });
  }

  return { trades };
}

function printTradeResults(label, res) {
  if (res.trades.length < 5) return;
  const wins = res.trades.filter(t => t.pnl > 0).length;
  const wr = wins / res.trades.length;
  const total = res.trades.reduce((s, t) => s + t.pnl, 0);
  const avg = total / res.trades.length;
  const stops = res.trades.filter(t => t.exitReason === 'stop').length;
  const targets = res.trades.filter(t => t.exitReason === 'target').length;
  const time = res.trades.filter(t => t.exitReason === 'time').length;

  console.log(`    ${label.padEnd(16)} (n=${String(res.trades.length).padStart(5)}): ` +
    `WR=${round(wr * 100).toFixed(1).padStart(5)}%  avg=${round(avg).toFixed(1).padStart(6)}  ` +
    `total=${round(total).toFixed(0).padStart(8)}  ` +
    `[target=${targets} stop=${stops} time=${time}]`);
}

main().catch(console.error);
