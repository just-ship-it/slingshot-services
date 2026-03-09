#!/usr/bin/env node
/**
 * Impulse Candle Phase 2: Edge Optimization
 *
 * Based on Phase 1 findings:
 *   - Impulse + FVG created → CONTINUE (enter in direction of impulse)
 *   - Impulse + NO FVG → FADE (enter against impulse)
 *   - FVG presence is the #1 differentiator
 *
 * This phase:
 * 1. Refines the FVG continuation setup — structural stops, optimal targets
 * 2. Refines the NO-FVG fade setup — stops above impulse, targets at mean reversion
 * 3. Adds additional filters (session, compression, day position) for highest-probability subset
 * 4. Tests structural stop placement (below FVG zone, below impulse low, etc.)
 * 5. Equity curve and drawdown analysis
 * 6. Finds the "1-per-day" money machine configuration
 *
 * Usage: node research/impulse-candle-phase2.js [--start 2024-01-01] [--end 2025-12-25]
 */

import fs from 'fs';
import path from 'path';
import { CSVLoader } from '../src/data/csv-loader.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

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
  const d = new Date(ts);
  const month = d.getUTCMonth();
  const offset = (month >= 2 && month <= 10) ? 4 : 5;
  return ((d.getUTCHours() - offset + 24) % 24) * 60 + d.getUTCMinutes();
}

function formatET(ts) {
  const m = getETMinutes(ts);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
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

function getDateKey(ts) { return new Date(ts).toISOString().slice(0, 10); }

const EVENT_WINDOWS = [
  { start: 8 * 60 + 25, end: 8 * 60 + 40 },
  { start: 9 * 60 + 28, end: 9 * 60 + 37 },
  { start: 9 * 60 + 58, end: 10 * 60 + 7 },
  { start: 13 * 60 + 58, end: 14 * 60 + 15 },
  { start: 14 * 60 + 28, end: 14 * 60 + 42 },
];

function isInEventWindow(ts) {
  const m = getETMinutes(ts);
  return EVENT_WINDOWS.some(w => m >= w.start && m <= w.end);
}

function round(v, d = 2) { return Math.round(v * 10 ** d) / 10 ** d; }

class RollingStats {
  constructor(size) { this.size = size; this.values = []; }
  push(val) { this.values.push(val); if (this.values.length > this.size) this.values.shift(); }
  get mean() { return this.values.length ? this.values.reduce((a, b) => a + b, 0) / this.values.length : 0; }
  get stddev() {
    if (this.values.length < 2) return 0;
    const m = this.mean;
    return Math.sqrt(this.values.reduce((s, v) => s + (v - m) ** 2, 0) / (this.values.length - 1));
  }
  zScore(val) {
    const sd = this.stddev;
    return (sd === 0 || this.values.length < this.size) ? 0 : (val - this.mean) / sd;
  }
  get isFull() { return this.values.length >= this.size; }
}

function detectFVG(c0, c1, c2) {
  if (!c0 || !c1 || !c2) return null;
  const bullGap = c2.low - c0.high;
  const bearGap = c0.low - c2.high;
  if (bullGap > 0) return { type: 'bullish', gapSize: bullGap, top: c2.low, bottom: c0.high };
  if (bearGap > 0) return { type: 'bearish', gapSize: bearGap, top: c0.low, bottom: c2.high };
  return null;
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`  IMPULSE CANDLE PHASE 2: EDGE OPTIMIZATION — ${TICKER}`);
  console.log(`  Period: ${START} to ${END}`);
  console.log(`${'='.repeat(72)}\n`);

  const defaultConfig = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf8'
  ));
  const loader = new CSVLoader(DATA_DIR, defaultConfig, { noContinuous: false });
  const { candles } = await loader.loadOHLCVData(TICKER, new Date(START), new Date(END));
  console.log(`Loaded ${candles.length.toLocaleString()} candles\n`);

  // ── Build features ───────────────────────────────────────────────
  const bodyStats = new RollingStats(20);
  const volStats = new RollingStats(20);
  const rangeShort = new RollingStats(5);
  const rangeLong = new RollingStats(50);

  let currentDay = '';
  let dayHigh = -Infinity, dayLow = Infinity;

  const features = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    const direction = c.close > c.open ? 'bull' : c.close < c.open ? 'bear' : 'doji';
    const bodyRangeRatio = range > 0 ? body / range : 0;
    const bodyZ = bodyStats.zScore(body);
    const volumeZ = volStats.zScore(c.volume);
    const compression = rangeLong.mean > 0 ? rangeShort.mean / rangeLong.mean : 1;

    const day = getDateKey(c.timestamp);
    if (day !== currentDay) { currentDay = day; dayHigh = c.high; dayLow = c.low; }
    else { dayHigh = Math.max(dayHigh, c.high); dayLow = Math.min(dayLow, c.low); }

    const dayRange = dayHigh - dayLow;
    const dayPosition = dayRange > 0 ? (c.close - dayLow) / dayRange : 0.5;
    const etMins = getETMinutes(c.timestamp);
    const trend20 = i >= 20 ? c.close - candles[i - 20].close : 0;

    features.push({
      index: i, timestamp: c.timestamp,
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      body, range, direction, bodyRangeRatio, bodyZ, volumeZ, compression,
      session: getSessionLabel(etMins), etMins,
      isEventWindow: isInEventWindow(c.timestamp),
      isRTH: etMins >= 9 * 60 + 30 && etMins < 16 * 60,
      dayPosition, dayRange, trend20,
    });

    bodyStats.push(body);
    volStats.push(c.volume);
    rangeShort.push(range);
    rangeLong.push(range);
  }

  // ── Identify impulses and classify FVG ───────────────────────────
  const impulses = features.filter(f =>
    !f.isEventWindow &&
    f.bodyZ >= 2.0 &&
    f.volumeZ >= 1.0 &&
    f.direction !== 'doji' &&
    f.index >= 50 &&
    f.index + 40 < candles.length
  );

  // Classify: does the next candle create an FVG?
  const fvgContinuation = []; // Impulse + FVG → continue
  const noFvgFade = [];       // Impulse + no FVG → fade

  for (const imp of impulses) {
    const i = imp.index;
    if (i + 1 >= candles.length || i < 1) continue;

    const fvg = detectFVG(candles[i - 1], candles[i], candles[i + 1]);
    const nextCandle = candles[i + 1];

    if (fvg) {
      fvgContinuation.push({
        ...imp,
        fvg,
        entryIndex: i + 1,           // enter at close of the candle that completes the FVG
        entryPrice: nextCandle.close,
        fvgTop: fvg.top,
        fvgBottom: fvg.bottom,
        fvgSize: fvg.gapSize,
      });
    } else {
      noFvgFade.push({
        ...imp,
        entryIndex: i + 1,
        entryPrice: nextCandle.close,
        // For fading: stop above impulse high (long) or below impulse low (short)
        impulseExtreme: imp.direction === 'bull' ? imp.high : imp.low,
      });
    }
  }

  console.log(`Total impulses: ${impulses.length}`);
  console.log(`FVG continuation setups: ${fvgContinuation.length} (${round(fvgContinuation.length / impulses.length * 100)}%)`);
  console.log(`No-FVG fade setups: ${noFvgFade.length} (${round(noFvgFade.length / impulses.length * 100)}%)`);

  // ══════════════════════════════════════════════════════════════════
  //  PART A: FVG CONTINUATION — Optimal Stop/Target
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  PART A: FVG CONTINUATION SETUP');
  console.log(`${'═'.repeat(60)}`);

  // A1: Structural stop = below FVG zone (for bull) / above FVG zone (for bear)
  console.log('\n  A1: Structural stop (below/above FVG zone) with buffer:');
  for (const buffer of [0, 2, 5, 8]) {
    for (const targetPts of [10, 15, 20, 25, 30, 40]) {
      const trades = [];
      for (const setup of fvgContinuation) {
        const isBull = setup.direction === 'bull';
        const stop = isBull
          ? setup.fvgBottom - buffer
          : setup.fvgTop + buffer;
        const risk = Math.abs(setup.entryPrice - stop);
        const target = isBull
          ? setup.entryPrice + targetPts
          : setup.entryPrice - targetPts;

        // Skip setups with unreasonable risk
        if (risk > 50 || risk < 1) continue;

        const result = simTrade(candles, setup.entryIndex, setup.entryPrice, isBull, stop, target, 30);
        trades.push({ ...result, risk });
      }

      if (trades.length < 50) continue;
      printTradeSummary(`buf=${buffer} tgt=${targetPts}`, trades);
    }
  }

  // A2: Fixed stop with various targets
  console.log('\n  A2: Fixed stop/target on FVG continuation:');
  for (const stopPts of [8, 10, 12, 15, 20]) {
    for (const targetPts of [10, 15, 20, 25, 30, 40]) {
      if (targetPts <= stopPts) continue;
      const trades = simTradeSet(fvgContinuation, candles, stopPts, targetPts, 30, 'continue');
      if (trades.length < 50) continue;
      printTradeSummary(`stop=${stopPts} tgt=${targetPts}`, trades);
    }
  }

  // A3: Trailing stop on FVG continuation
  console.log('\n  A3: Trailing stop on FVG continuation:');
  for (const [stop, trailAct, trailOff] of [
    [10, 8, 4], [10, 10, 5], [10, 12, 5], [10, 15, 6],
    [12, 10, 5], [12, 12, 5], [12, 15, 6],
    [15, 12, 5], [15, 15, 6], [15, 20, 8],
  ]) {
    const trades = simTrailingSet(fvgContinuation, candles, stop, trailAct, trailOff, 40, 'continue');
    if (trades.length < 50) continue;
    printTradeSummary(`stop=${stop} trail@${trailAct} off=${trailOff}`, trades);
  }

  // A4: Filter by session
  console.log('\n  A4: FVG continuation by session (stop=12, target=20):');
  for (const session of ['rth_open', 'rth_morning', 'rth_midday', 'rth_afternoon', 'premarket', 'overnight']) {
    const filtered = fvgContinuation.filter(f => f.session === session);
    if (filtered.length < 20) continue;
    const trades = simTradeSet(filtered, candles, 12, 20, 30, 'continue');
    printTradeSummary(session, trades);
  }

  // A5: Filter by FVG size
  console.log('\n  A5: FVG continuation by gap size (stop=12, target=20):');
  const fvgSizes = fvgContinuation.map(f => f.fvgSize).sort((a, b) => a - b);
  const fvgMedian = fvgSizes[Math.floor(fvgSizes.length / 2)];
  const fvgP75 = fvgSizes[Math.floor(fvgSizes.length * 0.75)];

  for (const [label, filter] of [
    [`Small FVG (<${round(fvgMedian)}pts)`, f => f.fvgSize < fvgMedian],
    [`Medium FVG (${round(fvgMedian)}-${round(fvgP75)}pts)`, f => f.fvgSize >= fvgMedian && f.fvgSize < fvgP75],
    [`Large FVG (>${round(fvgP75)}pts)`, f => f.fvgSize >= fvgP75],
  ]) {
    const filtered = fvgContinuation.filter(filter);
    if (filtered.length < 20) continue;
    const trades = simTradeSet(filtered, candles, 12, 20, 30, 'continue');
    printTradeSummary(label, trades);
  }

  // A6: Filter by body Z tier
  console.log('\n  A6: FVG continuation by impulse strength (stop=12, target=20):');
  for (const [label, minZ, maxZ] of [
    ['Moderate Z(2-2.5)', 2.0, 2.5],
    ['Strong Z(2.5-3)', 2.5, 3.0],
    ['Very strong Z(3-4)', 3.0, 4.0],
    ['Extreme Z(4+)', 4.0, 100],
  ]) {
    const filtered = fvgContinuation.filter(f => f.bodyZ >= minZ && f.bodyZ < maxZ);
    if (filtered.length < 20) continue;
    const trades = simTradeSet(filtered, candles, 12, 20, 30, 'continue');
    printTradeSummary(label, trades);
  }

  // A7: Compression + FVG
  console.log('\n  A7: Compression + FVG continuation (stop=12, target=20):');
  for (const compMax of [0.5, 0.6, 0.7, 0.8, 1.0]) {
    const filtered = fvgContinuation.filter(f => f.compression <= compMax && f.compression > 0);
    if (filtered.length < 20) continue;
    const trades = simTradeSet(filtered, candles, 12, 20, 30, 'continue');
    printTradeSummary(`comp<=${compMax}`, trades);
  }

  // ══════════════════════════════════════════════════════════════════
  //  PART B: NO-FVG FADE SETUP
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  PART B: NO-FVG FADE SETUP');
  console.log(`${'═'.repeat(60)}`);

  // B1: Structural stop = above/below impulse extreme + buffer
  console.log('\n  B1: Structural stop (beyond impulse extreme) with buffer:');
  for (const buffer of [0, 2, 5, 8]) {
    for (const targetPts of [10, 15, 20, 25, 30]) {
      const trades = [];
      for (const setup of noFvgFade) {
        // Fade = trade AGAINST the impulse direction
        const isBullEntry = setup.direction === 'bear'; // fade a bear impulse = go long
        const stop = isBullEntry
          ? setup.impulseExtreme - buffer // stop below the impulse low
          : setup.impulseExtreme + buffer; // stop above the impulse high
        const risk = Math.abs(setup.entryPrice - stop);
        const target = isBullEntry
          ? setup.entryPrice + targetPts
          : setup.entryPrice - targetPts;

        if (risk > 60 || risk < 1) continue;

        const result = simTrade(candles, setup.entryIndex, setup.entryPrice, isBullEntry, stop, target, 30);
        trades.push({ ...result, risk });
      }

      if (trades.length < 30) continue;
      printTradeSummary(`buf=${buffer} tgt=${targetPts}`, trades);
    }
  }

  // B2: Fixed stop/target fade
  console.log('\n  B2: Fixed stop/target on NO-FVG fade:');
  for (const stopPts of [8, 10, 12, 15, 20]) {
    for (const targetPts of [10, 15, 20, 25, 30]) {
      if (targetPts <= stopPts) continue;
      const trades = simTradeSet(noFvgFade, candles, stopPts, targetPts, 30, 'fade');
      if (trades.length < 30) continue;
      printTradeSummary(`stop=${stopPts} tgt=${targetPts}`, trades);
    }
  }

  // B3: Trailing stop on fade
  console.log('\n  B3: Trailing stop on NO-FVG fade:');
  for (const [stop, trailAct, trailOff] of [
    [10, 8, 4], [10, 10, 5], [10, 15, 6],
    [12, 10, 5], [12, 15, 6],
    [15, 12, 5], [15, 15, 6],
  ]) {
    const trades = simTrailingSet(noFvgFade, candles, stop, trailAct, trailOff, 40, 'fade');
    if (trades.length < 30) continue;
    printTradeSummary(`stop=${stop} trail@${trailAct} off=${trailOff}`, trades);
  }

  // B4: Fade by session
  console.log('\n  B4: NO-FVG fade by session (stop=12, target=20):');
  for (const session of ['rth_open', 'rth_morning', 'rth_midday', 'rth_afternoon', 'premarket', 'overnight']) {
    const filtered = noFvgFade.filter(f => f.session === session);
    if (filtered.length < 10) continue;
    const trades = simTradeSet(filtered, candles, 12, 20, 30, 'fade');
    printTradeSummary(session, trades);
  }

  // ══════════════════════════════════════════════════════════════════
  //  PART C: COMBINED STRATEGY — Best of both
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  PART C: COMBINED STRATEGY');
  console.log(`${'═'.repeat(60)}`);

  // Combine: continue when FVG, fade when no FVG
  console.log('\n  C1: Combined (FVG→continue, noFVG→fade) stop/target sweep:');
  for (const stopPts of [10, 12, 15]) {
    for (const targetPts of [15, 20, 25, 30]) {
      if (targetPts <= stopPts) continue;
      const contTrades = simTradeSet(fvgContinuation, candles, stopPts, targetPts, 30, 'continue');
      const fadeTrades = simTradeSet(noFvgFade, candles, stopPts, targetPts, 30, 'fade');
      const allTrades = [...contTrades, ...fadeTrades].sort((a, b) => a.timestamp - b.timestamp);
      printTradeSummary(`${stopPts}/${targetPts}`, allTrades);
    }
  }

  // C2: Combined with cooldown (max 1 trade per 15min)
  console.log('\n  C2: Combined with 15min cooldown:');
  for (const stopPts of [10, 12, 15]) {
    for (const targetPts of [15, 20, 25, 30]) {
      if (targetPts <= stopPts) continue;
      const contTrades = simTradeSet(fvgContinuation, candles, stopPts, targetPts, 30, 'continue');
      const fadeTrades = simTradeSet(noFvgFade, candles, stopPts, targetPts, 30, 'fade');
      const allTrades = [...contTrades, ...fadeTrades].sort((a, b) => a.timestamp - b.timestamp);

      // Apply cooldown
      const filtered = [];
      let lastTs = 0;
      for (const t of allTrades) {
        if (t.timestamp - lastTs >= 15 * 60 * 1000) {
          filtered.push(t);
          lastTs = t.timestamp;
        }
      }
      printTradeSummary(`${stopPts}/${targetPts} cd=15m`, filtered);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  PART D: "1 PER DAY" BEST SETUP
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  PART D: Best signal per day (max 1 trade/day)');
  console.log(`${'═'.repeat(60)}`);

  // For each day, take only the first impulse signal (highest bodyZ if tie)
  // Test with different session windows
  for (const sessionFilter of [
    { label: 'RTH only', filter: f => f.isRTH },
    { label: 'RTH morning (10-12)', filter: f => f.etMins >= 600 && f.etMins < 720 },
    { label: 'RTH morning+midday (10-14)', filter: f => f.etMins >= 600 && f.etMins < 840 },
    { label: 'All sessions', filter: () => true },
  ]) {
    // FVG continuation only (the clear winner)
    const dailySetups = {};
    for (const setup of fvgContinuation.filter(sessionFilter.filter)) {
      const day = getDateKey(setup.timestamp);
      if (!dailySetups[day] || setup.bodyZ > dailySetups[day].bodyZ) {
        dailySetups[day] = setup;
      }
    }
    const dailyBest = Object.values(dailySetups);

    if (dailyBest.length < 20) continue;

    console.log(`\n  ${sessionFilter.label} — FVG continuation, best per day:`);
    for (const stopPts of [10, 12, 15]) {
      for (const targetPts of [15, 20, 25, 30, 40]) {
        if (targetPts <= stopPts) continue;
        const trades = simTradeSet(dailyBest, candles, stopPts, targetPts, 30, 'continue');
        if (trades.length < 10) continue;
        printTradeSummary(`${stopPts}/${targetPts}`, trades, true);
      }
    }
  }

  // Same for fade
  console.log('\n  RTH only — NO-FVG fade, best per day:');
  const dailyFades = {};
  for (const setup of noFvgFade.filter(f => f.isRTH)) {
    const day = getDateKey(setup.timestamp);
    if (!dailyFades[day] || setup.bodyZ > dailyFades[day].bodyZ) {
      dailyFades[day] = setup;
    }
  }
  const dailyBestFade = Object.values(dailyFades);
  if (dailyBestFade.length >= 10) {
    for (const stopPts of [10, 12, 15]) {
      for (const targetPts of [15, 20, 25, 30]) {
        if (targetPts <= stopPts) continue;
        const trades = simTradeSet(dailyBestFade, candles, stopPts, targetPts, 30, 'fade');
        if (trades.length < 10) continue;
        printTradeSummary(`${stopPts}/${targetPts}`, trades, true);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  PART E: EQUITY CURVE for best configurations
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  PART E: Equity curves for top configurations');
  console.log(`${'═'.repeat(60)}`);

  // Config 1: FVG continuation, all signals, 12/20, 15min cooldown
  {
    const trades = simTradeSet(fvgContinuation, candles, 12, 20, 30, 'continue');
    const cooled = applyCooldown(trades, 15 * 60 * 1000);
    printEquityCurve('FVG Continue 12/20 cd=15m', cooled);
  }

  // Config 2: Combined (FVG continue + noFVG fade), 12/20, 15min cooldown
  {
    const cont = simTradeSet(fvgContinuation, candles, 12, 20, 30, 'continue');
    const fade = simTradeSet(noFvgFade, candles, 12, 20, 30, 'fade');
    const all = [...cont, ...fade].sort((a, b) => a.timestamp - b.timestamp);
    const cooled = applyCooldown(all, 15 * 60 * 1000);
    printEquityCurve('Combined 12/20 cd=15m', cooled);
  }

  // Config 3: FVG continuation, RTH morning only, best per day, 12/25
  {
    const dailySetups = {};
    for (const s of fvgContinuation.filter(f => f.etMins >= 600 && f.etMins < 720)) {
      const day = getDateKey(s.timestamp);
      if (!dailySetups[day] || s.bodyZ > dailySetups[day].bodyZ) dailySetups[day] = s;
    }
    const trades = simTradeSet(Object.values(dailySetups), candles, 12, 25, 30, 'continue');
    printEquityCurve('FVG RTH Morning best/day 12/25', trades);
  }

  // Config 4: FVG continuation, trailing stop
  {
    const trades = simTrailingSet(fvgContinuation, candles, 12, 12, 5, 40, 'continue');
    const cooled = applyCooldown(trades, 15 * 60 * 1000);
    printEquityCurve('FVG Continue trail 12/12/5 cd=15m', cooled);
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log('  PHASE 2 ANALYSIS COMPLETE');
  console.log(`${'═'.repeat(72)}\n`);
}

// ── Trade simulation ───────────────────────────────────────────────
function simTrade(candles, entryIdx, entryPrice, isBull, stopPrice, targetPrice, maxHold) {
  for (let j = 1; j <= maxHold && entryIdx + j < candles.length; j++) {
    const c = candles[entryIdx + j];
    if (isBull) {
      if (c.low <= stopPrice) return { pnl: stopPrice - entryPrice, reason: 'stop', bars: j };
      if (c.high >= targetPrice) return { pnl: targetPrice - entryPrice, reason: 'target', bars: j };
    } else {
      if (c.high >= stopPrice) return { pnl: entryPrice - stopPrice, reason: 'stop', bars: j };
      if (c.low <= targetPrice) return { pnl: entryPrice - targetPrice, reason: 'target', bars: j };
    }
  }
  const lastIdx = Math.min(entryIdx + maxHold, candles.length - 1);
  const exitPrice = candles[lastIdx].close;
  const pnl = isBull ? exitPrice - entryPrice : entryPrice - exitPrice;
  return { pnl, reason: 'time', bars: maxHold };
}

function simTradeSet(setups, candles, stopPts, targetPts, maxHold, mode) {
  const trades = [];
  for (const s of setups) {
    const isBull = mode === 'continue' ? s.direction === 'bull' : s.direction === 'bear';
    const entry = s.entryPrice;
    const stop = isBull ? entry - stopPts : entry + stopPts;
    const target = isBull ? entry + targetPts : entry - targetPts;
    const result = simTrade(candles, s.entryIndex, entry, isBull, stop, target, maxHold);
    trades.push({ ...result, timestamp: s.timestamp, direction: isBull ? 'bull' : 'bear' });
  }
  return trades;
}

function simTrailingSet(setups, candles, stopPts, trailActivate, trailOffset, maxHold, mode) {
  const trades = [];
  for (const s of setups) {
    const isBull = mode === 'continue' ? s.direction === 'bull' : s.direction === 'bear';
    const entry = s.entryPrice;
    let stop = isBull ? entry - stopPts : entry + stopPts;
    let bestPrice = entry;
    let trailActive = false;
    let exitPrice = null, exitReason = null, bars = 0;

    for (let j = 1; j <= maxHold && s.entryIndex + j < candles.length; j++) {
      const c = candles[s.entryIndex + j];
      bars = j;

      if (isBull) {
        if (c.high > bestPrice) bestPrice = c.high;
        if (!trailActive && bestPrice - entry >= trailActivate) trailActive = true;
        if (trailActive) { const ts = bestPrice - trailOffset; if (ts > stop) stop = ts; }
        if (c.low <= stop) { exitPrice = stop; exitReason = trailActive ? 'trail' : 'stop'; break; }
      } else {
        if (c.low < bestPrice) bestPrice = c.low;
        if (!trailActive && entry - bestPrice >= trailActivate) trailActive = true;
        if (trailActive) { const ts = bestPrice + trailOffset; if (ts < stop) stop = ts; }
        if (c.high >= stop) { exitPrice = stop; exitReason = trailActive ? 'trail' : 'stop'; break; }
      }
    }

    if (exitPrice === null) {
      const lastIdx = Math.min(s.entryIndex + maxHold, candles.length - 1);
      exitPrice = candles[lastIdx].close;
      exitReason = 'time';
    }

    const pnl = isBull ? exitPrice - entry : entry - exitPrice;
    trades.push({ pnl, reason: exitReason, bars, timestamp: s.timestamp, direction: isBull ? 'bull' : 'bear' });
  }
  return trades;
}

function applyCooldown(trades, cooldownMs) {
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const result = [];
  let lastTs = 0;
  for (const t of sorted) {
    if (t.timestamp - lastTs >= cooldownMs) {
      result.push(t);
      lastTs = t.timestamp;
    }
  }
  return result;
}

function printTradeSummary(label, trades, showDrawdown = false) {
  if (trades.length < 5) return;
  const wins = trades.filter(t => t.pnl > 0).length;
  const wr = wins / trades.length;
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const avg = total / trades.length;
  const avgWin = wins > 0 ? trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins : 0;
  const losses = trades.length - wins;
  const avgLoss = losses > 0 ? trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0) / losses : 0;
  const pf = (avgLoss !== 0 && wins > 0) ? Math.abs(avgWin * wins) / Math.abs(avgLoss * losses) : 0;

  let ddStr = '';
  if (showDrawdown) {
    let equity = 0, peak = 0, maxDD = 0;
    for (const t of trades) {
      equity += t.pnl;
      peak = Math.max(peak, equity);
      maxDD = Math.min(maxDD, equity - peak);
    }
    ddStr = `  maxDD=${round(maxDD).toFixed(0).padStart(6)}`;
  }

  console.log(`    ${label.padEnd(32)} n=${String(trades.length).padStart(5)}  ` +
    `WR=${round(wr * 100).toFixed(1).padStart(5)}%  ` +
    `avg=${round(avg).toFixed(1).padStart(6)}  total=${round(total).toFixed(0).padStart(8)}  ` +
    `PF=${round(pf).toFixed(2).padStart(5)}  ` +
    `avgW=${round(avgWin).toFixed(1).padStart(6)} avgL=${round(avgLoss).toFixed(1).padStart(6)}` +
    ddStr);
}

function printEquityCurve(label, trades) {
  console.log(`\n  ${label} (n=${trades.length}):`);

  if (trades.length < 5) { console.log('    Too few trades'); return; }

  // Monthly breakdown
  const months = {};
  let equity = 0, peak = 0, maxDD = 0;

  for (const t of trades) {
    const month = new Date(t.timestamp).toISOString().slice(0, 7);
    if (!months[month]) months[month] = { trades: 0, wins: 0, pnl: 0 };
    months[month].trades++;
    if (t.pnl > 0) months[month].wins++;
    months[month].pnl += t.pnl;

    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity - peak);
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  console.log(`    Total: ${round(totalPnl)}pts  WR=${round(wins / trades.length * 100)}%  MaxDD=${round(maxDD)}pts\n`);

  console.log('    Month      Trades  Wins  WR%     PnL    CumPnL');
  let cumPnl = 0;
  for (const [month, data] of Object.entries(months).sort()) {
    cumPnl += data.pnl;
    const wr = data.trades > 0 ? data.wins / data.trades * 100 : 0;
    console.log(`    ${month}    ${String(data.trades).padStart(4)}  ${String(data.wins).padStart(4)}  ${round(wr).toFixed(1).padStart(5)}%  ${round(data.pnl).toFixed(0).padStart(7)}  ${round(cumPnl).toFixed(0).padStart(8)}`);
  }
}

main().catch(console.error);
