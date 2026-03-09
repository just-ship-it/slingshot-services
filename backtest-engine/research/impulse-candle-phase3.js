#!/usr/bin/env node
/**
 * Impulse Candle Phase 3: Rare High-Conviction Setups
 *
 * The problem with Phase 1-2: too many signals (25K over 2 years).
 * We need the RARE candles — 20-50 point bodies that happen 1-5x per day
 * at random times, outside of news.
 *
 * This phase:
 * 1. Uses ABSOLUTE body/range thresholds (not Z-scores) to find genuinely large candles
 * 2. Combines with FVG/no-FVG classification
 * 3. Adds multi-bar momentum context (was this part of a run or isolated?)
 * 4. Tests "second chance" entries (wait for pullback into FVG before continuing)
 * 5. Narrows to 1-5 signals per day for realistic trading
 * 6. Detailed equity curves and per-trade logs for best configs
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
const START = getArg('start', '2023-06-01');
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

function detectFVG(c0, c1, c2) {
  if (!c0 || !c1 || !c2) return null;
  const bullGap = c2.low - c0.high;
  const bearGap = c0.low - c2.high;
  if (bullGap > 0) return { type: 'bullish', gapSize: bullGap, top: c2.low, bottom: c0.high };
  if (bearGap > 0) return { type: 'bearish', gapSize: bearGap, top: c0.low, bottom: c2.high };
  return null;
}

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
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`  IMPULSE CANDLE PHASE 3: RARE HIGH-CONVICTION SETUPS — ${TICKER}`);
  console.log(`  Period: ${START} to ${END}`);
  console.log(`${'='.repeat(72)}\n`);

  const defaultConfig = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf8'
  ));
  const loader = new CSVLoader(DATA_DIR, defaultConfig, { noContinuous: false });
  const { candles } = await loader.loadOHLCVData(TICKER, new Date(START), new Date(END));
  console.log(`Loaded ${candles.length.toLocaleString()} candles\n`);

  const volStats = new RollingStats(60);
  const rangeShort = new RollingStats(5);
  const rangeLong = new RollingStats(60);

  let currentDay = '', dayHigh = -Infinity, dayLow = Infinity;

  // ── Build features ───────────────────────────────────────────────
  const features = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    const direction = c.close > c.open ? 'bull' : c.close < c.open ? 'bear' : 'doji';
    const bodyRangeRatio = range > 0 ? body / range : 0;
    const volumeZ = volStats.zScore(c.volume);
    const compression = rangeLong.mean > 0 ? rangeShort.mean / rangeLong.mean : 1;
    const etMins = getETMinutes(c.timestamp);

    const day = getDateKey(c.timestamp);
    if (day !== currentDay) { currentDay = day; dayHigh = c.high; dayLow = c.low; }
    else { dayHigh = Math.max(dayHigh, c.high); dayLow = Math.min(dayLow, c.low); }
    const dayRange = dayHigh - dayLow;
    const dayPosition = dayRange > 0 ? (c.close - dayLow) / dayRange : 0.5;

    // Multi-bar momentum: net move over prior 3 bars in same direction
    let priorMomentum = 0;
    if (i >= 3) {
      priorMomentum = c.open - candles[i - 3].open; // signed
    }
    // Did prior 3 candles also move in this direction?
    let priorAligned = 0;
    if (i >= 3) {
      for (let k = 1; k <= 3; k++) {
        const pc = candles[i - k];
        if ((direction === 'bull' && pc.close > pc.open) || (direction === 'bear' && pc.close < pc.open)) {
          priorAligned++;
        }
      }
    }

    // Swing high/low context: is this candle making a new 20-bar high or low?
    let isSwingExtreme = false;
    if (i >= 20) {
      let highest = -Infinity, lowest = Infinity;
      for (let k = 1; k <= 20; k++) {
        highest = Math.max(highest, candles[i - k].high);
        lowest = Math.min(lowest, candles[i - k].low);
      }
      isSwingExtreme = c.high > highest || c.low < lowest;
    }

    features.push({
      index: i, timestamp: c.timestamp,
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      body, range, direction, bodyRangeRatio, volumeZ, compression,
      etMins,
      isEventWindow: isInEventWindow(c.timestamp),
      isRTH: etMins >= 9 * 60 + 30 && etMins < 16 * 60,
      dayPosition, dayRange,
      priorMomentum, priorAligned, isSwingExtreme,
    });

    volStats.push(c.volume);
    rangeShort.push(range);
    rangeLong.push(range);
  }

  // ── SECTION 1: Absolute body size distribution ───────────────────
  console.log(`${'═'.repeat(60)}`);
  console.log('  SECTION 1: Absolute body size — how many candles per threshold?');
  console.log(`${'═'.repeat(60)}`);

  const nonEvent = features.filter(f => !f.isEventWindow && f.direction !== 'doji' && f.index >= 60 && f.index + 40 < candles.length);
  const totalDays = new Set(nonEvent.map(f => getDateKey(f.timestamp))).size;

  for (const minBody of [10, 15, 20, 25, 30, 40, 50]) {
    const matching = nonEvent.filter(f => f.body >= minBody);
    const perDay = matching.length / totalDays;
    const rthMatching = matching.filter(f => f.isRTH);
    const rthPerDay = rthMatching.length / totalDays;
    console.log(`  Body >= ${String(minBody).padStart(2)}pts: ${String(matching.length).padStart(6)} total (${round(perDay, 1)}/day)  RTH: ${String(rthMatching.length).padStart(5)} (${round(rthPerDay, 1)}/day)`);
  }

  // ── SECTION 2: Absolute body + FVG split ─────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 2: Absolute body thresholds + FVG/no-FVG split');
  console.log(`${'═'.repeat(60)}`);

  for (const minBody of [15, 20, 25, 30]) {
    const bigCandles = nonEvent.filter(f => f.body >= minBody);

    // Classify FVG
    const fvgCont = [];
    const noFvgFade = [];

    for (const imp of bigCandles) {
      const i = imp.index;
      if (i < 1 || i + 1 >= candles.length) continue;
      const fvg = detectFVG(candles[i - 1], candles[i], candles[i + 1]);
      const next = candles[i + 1];

      if (fvg) {
        fvgCont.push({ ...imp, fvg, entryIndex: i + 1, entryPrice: next.close });
      } else {
        noFvgFade.push({
          ...imp,
          entryIndex: i + 1,
          entryPrice: next.close,
          impulseExtreme: imp.direction === 'bull' ? imp.high : imp.low,
        });
      }
    }

    console.log(`\n  Body >= ${minBody}pts: ${bigCandles.length} total, FVG: ${fvgCont.length}, No-FVG: ${noFvgFade.length}`);
    console.log(`    Per day: ${round(bigCandles.length / totalDays, 1)} total, ${round(fvgCont.length / totalDays, 1)} FVG, ${round(noFvgFade.length / totalDays, 1)} fade`);

    // FVG continuation follow-through
    if (fvgCont.length >= 20) {
      const ft = measureFollowThrough(fvgCont, candles, [1, 3, 5, 10, 20]);
      console.log(`    FVG CONTINUE (n=${fvgCont.length}):`);
      for (const w of [1, 3, 5, 10, 20]) {
        const r = ft[w];
        if (!r) continue;
        console.log(`      ${String(w).padStart(2)}bar: cont=${round(r.contRate * 100).toFixed(1)}%  MFE=${round(r.avgMFE).toFixed(1)}  MAE=${round(r.avgMAE).toFixed(1)}  net=${round(r.avgNet).toFixed(1)}  ratio=${round(r.avgMFE / Math.max(r.avgMAE, 0.01)).toFixed(2)}`);
      }

      // Trade sim
      console.log('    FVG CONTINUE trades:');
      for (const [stop, tgt] of [[10, 20], [12, 25], [15, 30], [15, 20]]) {
        const trades = simTradeSet(fvgCont, candles, stop, tgt, 30, 'continue');
        printLine(`      ${stop}/${tgt}`, trades);
      }

      // Structural stop (behind FVG)
      console.log('    FVG CONTINUE structural stop:');
      for (const [buf, tgt] of [[0, 15], [0, 20], [0, 25], [2, 20], [2, 25], [5, 25]]) {
        const trades = simStructuralFVG(fvgCont, candles, buf, tgt, 30);
        printLine(`      buf=${buf} tgt=${tgt}`, trades);
      }
    }

    // No-FVG fade
    if (noFvgFade.length >= 20) {
      const ft = measureFollowThrough(noFvgFade, candles, [1, 3, 5, 10, 20], 'fade');
      console.log(`    NO-FVG FADE (n=${noFvgFade.length}):`);
      for (const w of [1, 3, 5, 10, 20]) {
        const r = ft[w];
        if (!r) continue;
        console.log(`      ${String(w).padStart(2)}bar: cont=${round(r.contRate * 100).toFixed(1)}%  MFE=${round(r.avgMFE).toFixed(1)}  MAE=${round(r.avgMAE).toFixed(1)}  net=${round(r.avgNet).toFixed(1)}  ratio=${round(r.avgMFE / Math.max(r.avgMAE, 0.01)).toFixed(2)}`);
      }

      // Trade sim — structural stop (behind impulse extreme)
      console.log('    NO-FVG FADE structural stop:');
      for (const [buf, tgt] of [[0, 10], [0, 15], [0, 20], [0, 25], [2, 15], [2, 20], [5, 20]]) {
        const trades = simStructuralFade(noFvgFade, candles, buf, tgt, 30);
        printLine(`      buf=${buf} tgt=${tgt}`, trades);
      }

      // Fixed stop
      console.log('    NO-FVG FADE fixed stop:');
      for (const [stop, tgt] of [[8, 15], [8, 20], [10, 15], [10, 20], [12, 20], [12, 25]]) {
        const trades = simTradeSet(noFvgFade, candles, stop, tgt, 30, 'fade');
        printLine(`      ${stop}/${tgt}`, trades);
      }
    }
  }

  // ── SECTION 3: "Second chance" — FVG pullback entry ──────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 3: FVG pullback entry (wait for price to retrace INTO the FVG)');
  console.log(`${'═'.repeat(60)}`);

  for (const minBody of [15, 20, 25]) {
    const bigCandles = nonEvent.filter(f => f.body >= minBody);

    const pullbackEntries = [];
    for (const imp of bigCandles) {
      const i = imp.index;
      if (i < 1 || i + 30 >= candles.length) continue;
      const fvg = detectFVG(candles[i - 1], candles[i], candles[i + 1]);
      if (!fvg) continue;

      // Wait for price to retrace INTO the FVG zone (the "second chance")
      for (let j = 2; j <= 20; j++) {
        const c = candles[i + j];
        const isBull = imp.direction === 'bull';

        let entered = false;
        if (isBull && c.low <= fvg.top && c.low >= fvg.bottom) {
          // Price pulled back into bullish FVG — enter long
          pullbackEntries.push({
            ...imp,
            entryIndex: i + j,
            entryPrice: fvg.top,  // enter at the FVG boundary (limit order)
            fvg,
            pullbackBars: j,
            stopPrice: fvg.bottom - 2, // stop below FVG
          });
          entered = true;
        } else if (!isBull && c.high >= fvg.bottom && c.high <= fvg.top) {
          pullbackEntries.push({
            ...imp,
            entryIndex: i + j,
            entryPrice: fvg.bottom,
            fvg,
            pullbackBars: j,
            stopPrice: fvg.top + 2,
          });
          entered = true;
        }

        if (entered) break;

        // If price goes too far past the FVG without retesting, skip
        if (isBull && c.close > imp.high + 20) break;
        if (!isBull && c.close < imp.low - 20) break;
      }
    }

    if (pullbackEntries.length < 10) continue;

    console.log(`\n  Body >= ${minBody}pts FVG pullback entries: ${pullbackEntries.length} (${round(pullbackEntries.length / totalDays, 1)}/day)`);
    console.log(`  Avg pullback wait: ${round(pullbackEntries.reduce((s, e) => s + e.pullbackBars, 0) / pullbackEntries.length)} bars`);

    // Follow-through from pullback entry
    const ft = measureFollowThrough(pullbackEntries, candles, [1, 3, 5, 10, 20], 'continue', 'entryIndex', 'entryPrice');
    for (const w of [1, 3, 5, 10, 20]) {
      const r = ft[w];
      if (!r) continue;
      console.log(`    ${String(w).padStart(2)}bar: cont=${round(r.contRate * 100).toFixed(1)}%  MFE=${round(r.avgMFE).toFixed(1)}  MAE=${round(r.avgMAE).toFixed(1)}  net=${round(r.avgNet).toFixed(1)}  ratio=${round(r.avgMFE / Math.max(r.avgMAE, 0.01)).toFixed(2)}`);
    }

    // Trade sim with structural stop (below FVG)
    console.log('    Structural stop (below FVG):');
    for (const tgt of [10, 15, 20, 25, 30]) {
      const trades = [];
      for (const e of pullbackEntries) {
        const isBull = e.direction === 'bull';
        const target = isBull ? e.entryPrice + tgt : e.entryPrice - tgt;
        const result = simTrade(candles, e.entryIndex, e.entryPrice, isBull, e.stopPrice, target, 30);
        trades.push({ ...result, timestamp: e.timestamp });
      }
      printLine(`      tgt=${tgt}`, trades);
    }
  }

  // ── SECTION 4: Multi-bar momentum context ────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 4: Multi-bar momentum — isolated vs part of a run');
  console.log(`${'═'.repeat(60)}`);

  const big20 = nonEvent.filter(f => f.body >= 20);

  // Isolated: prior 3 bars mostly OPPOSITE direction
  const isolated = big20.filter(f => f.priorAligned <= 1);
  const partOfRun = big20.filter(f => f.priorAligned >= 2);

  for (const [label, subset] of [['Isolated impulse (0-1 prior aligned)', isolated], ['Part of run (2-3 prior aligned)', partOfRun]]) {
    if (subset.length < 20) continue;

    // FVG classification
    const fvgSub = [];
    const noFvgSub = [];
    for (const imp of subset) {
      const i = imp.index;
      if (i < 1 || i + 1 >= candles.length) continue;
      const fvg = detectFVG(candles[i - 1], candles[i], candles[i + 1]);
      if (fvg) fvgSub.push({ ...imp, fvg, entryIndex: i + 1, entryPrice: candles[i + 1].close });
      else noFvgSub.push({ ...imp, entryIndex: i + 1, entryPrice: candles[i + 1].close, impulseExtreme: imp.direction === 'bull' ? imp.high : imp.low });
    }

    console.log(`\n  ${label} (n=${subset.length}, FVG: ${fvgSub.length}, NoFVG: ${noFvgSub.length})`);

    if (fvgSub.length >= 10) {
      const ft = measureFollowThrough(fvgSub, candles, [3, 5, 10]);
      console.log(`    FVG continue: 5bar cont=${round(ft[5].contRate * 100)}% MFE=${round(ft[5].avgMFE)} MAE=${round(ft[5].avgMAE)} ratio=${round(ft[5].avgMFE / Math.max(ft[5].avgMAE, 0.01))}`);
      // Best trade configs
      for (const [s, t] of [[10, 20], [12, 25]]) {
        const trades = simTradeSet(fvgSub, candles, s, t, 30, 'continue');
        printLine(`      cont ${s}/${t}`, trades);
      }
    }

    if (noFvgSub.length >= 10) {
      const ft = measureFollowThrough(noFvgSub, candles, [3, 5, 10], 'fade');
      console.log(`    NoFVG fade: 5bar cont=${round(ft[5].contRate * 100)}% MFE=${round(ft[5].avgMFE)} MAE=${round(ft[5].avgMAE)} ratio=${round(ft[5].avgMFE / Math.max(ft[5].avgMAE, 0.01))}`);
      for (const [s, t] of [[10, 15], [12, 20]]) {
        const trades = simTradeSet(noFvgSub, candles, s, t, 30, 'fade');
        printLine(`      fade ${s}/${t}`, trades);
      }
    }
  }

  // ── SECTION 5: Swing extreme context ─────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 5: Swing extreme — impulse at new 20-bar high/low');
  console.log(`${'═'.repeat(60)}`);

  const atExtreme = big20.filter(f => f.isSwingExtreme);
  const notExtreme = big20.filter(f => !f.isSwingExtreme);

  for (const [label, subset] of [['At swing extreme', atExtreme], ['NOT at swing extreme', notExtreme]]) {
    if (subset.length < 20) continue;

    const fvgSub = [];
    const noFvgSub = [];
    for (const imp of subset) {
      const i = imp.index;
      if (i < 1 || i + 1 >= candles.length) continue;
      const fvg = detectFVG(candles[i - 1], candles[i], candles[i + 1]);
      if (fvg) fvgSub.push({ ...imp, fvg, entryIndex: i + 1, entryPrice: candles[i + 1].close });
      else noFvgSub.push({ ...imp, entryIndex: i + 1, entryPrice: candles[i + 1].close, impulseExtreme: imp.direction === 'bull' ? imp.high : imp.low });
    }

    console.log(`\n  ${label} (n=${subset.length}, FVG: ${fvgSub.length}, NoFVG: ${noFvgSub.length})`);

    if (fvgSub.length >= 10) {
      console.log('    FVG continue trades:');
      for (const [s, t] of [[10, 20], [12, 25], [15, 30]]) {
        const trades = simTradeSet(fvgSub, candles, s, t, 30, 'continue');
        printLine(`      ${s}/${t}`, trades);
      }
    }
    if (noFvgSub.length >= 10) {
      console.log('    NoFVG fade trades:');
      for (const [s, t] of [[10, 15], [10, 20], [12, 20]]) {
        const trades = simTradeSet(noFvgSub, candles, s, t, 30, 'fade');
        printLine(`      ${s}/${t}`, trades);
      }
      console.log('    NoFVG fade structural stop:');
      for (const [buf, tgt] of [[0, 15], [0, 20], [0, 25]]) {
        const trades = simStructuralFade(noFvgSub, candles, buf, tgt, 30);
        printLine(`      buf=${buf} tgt=${tgt}`, trades);
      }
    }
  }

  // ── SECTION 6: RTH-only combined best configs with equity curves ─
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SECTION 6: RTH-only best configs — equity curves');
  console.log(`${'═'.repeat(60)}`);

  // Config A: Body >= 20, No-FVG, structural fade, RTH, buf=0 tgt=15
  {
    const setups = nonEvent.filter(f => f.body >= 20 && f.isRTH);
    const noFvg = [];
    for (const imp of setups) {
      const i = imp.index;
      if (i < 1 || i + 1 >= candles.length) continue;
      const fvg = detectFVG(candles[i - 1], candles[i], candles[i + 1]);
      if (!fvg) {
        noFvg.push({
          ...imp, entryIndex: i + 1, entryPrice: candles[i + 1].close,
          impulseExtreme: imp.direction === 'bull' ? imp.high : imp.low,
        });
      }
    }

    if (noFvg.length >= 20) {
      const trades = simStructuralFade(noFvg, candles, 0, 15, 30);
      const cooled = applyCooldown(trades, 30 * 60 * 1000);
      printEquity('A: Body>=20 NoFVG structural fade buf=0 tgt=15 RTH cd=30m', cooled);
    }
  }

  // Config B: Body >= 20, FVG, continuation, RTH, 12/25
  {
    const setups = nonEvent.filter(f => f.body >= 20 && f.isRTH);
    const fvgSetups = [];
    for (const imp of setups) {
      const i = imp.index;
      if (i < 1 || i + 1 >= candles.length) continue;
      const fvg = detectFVG(candles[i - 1], candles[i], candles[i + 1]);
      if (fvg) {
        fvgSetups.push({ ...imp, fvg, entryIndex: i + 1, entryPrice: candles[i + 1].close });
      }
    }

    if (fvgSetups.length >= 20) {
      const trades = simTradeSet(fvgSetups, candles, 12, 25, 30, 'continue');
      const cooled = applyCooldown(trades, 30 * 60 * 1000);
      printEquity('B: Body>=20 FVG continue 12/25 RTH cd=30m', cooled);
    }
  }

  // Config C: Body >= 20, FVG pullback, RTH
  {
    const setups = nonEvent.filter(f => f.body >= 20 && f.isRTH);
    const pullbacks = [];
    for (const imp of setups) {
      const i = imp.index;
      if (i < 1 || i + 30 >= candles.length) continue;
      const fvg = detectFVG(candles[i - 1], candles[i], candles[i + 1]);
      if (!fvg) continue;

      for (let j = 2; j <= 15; j++) {
        const c = candles[i + j];
        const isBull = imp.direction === 'bull';
        if (isBull && c.low <= fvg.top && c.low >= fvg.bottom) {
          pullbacks.push({
            ...imp, entryIndex: i + j, entryPrice: fvg.top, fvg,
            stopPrice: fvg.bottom - 2,
          });
          break;
        } else if (!isBull && c.high >= fvg.bottom && c.high <= fvg.top) {
          pullbacks.push({
            ...imp, entryIndex: i + j, entryPrice: fvg.bottom, fvg,
            stopPrice: fvg.top + 2,
          });
          break;
        }
        if (isBull && c.close > imp.high + 15) break;
        if (!isBull && c.close < imp.low - 15) break;
      }
    }

    if (pullbacks.length >= 20) {
      const trades = [];
      for (const e of pullbacks) {
        const isBull = e.direction === 'bull';
        const tgt = isBull ? e.entryPrice + 20 : e.entryPrice - 20;
        const result = simTrade(candles, e.entryIndex, e.entryPrice, isBull, e.stopPrice, tgt, 30);
        trades.push({ ...result, timestamp: e.timestamp });
      }
      const cooled = applyCooldown(trades, 30 * 60 * 1000);
      printEquity('C: Body>=20 FVG pullback entry tgt=20 RTH cd=30m', cooled);
    }
  }

  // Config D: Combined — both setups
  {
    const setups = nonEvent.filter(f => f.body >= 20 && f.isRTH);
    const allTrades = [];

    for (const imp of setups) {
      const i = imp.index;
      if (i < 1 || i + 1 >= candles.length) continue;
      const fvg = detectFVG(candles[i - 1], candles[i], candles[i + 1]);
      const next = candles[i + 1];

      if (fvg) {
        // Continue
        const isBull = imp.direction === 'bull';
        const stop = isBull ? next.close - 12 : next.close + 12;
        const target = isBull ? next.close + 25 : next.close - 25;
        const result = simTrade(candles, i + 1, next.close, isBull, stop, target, 30);
        allTrades.push({ ...result, timestamp: imp.timestamp, type: 'continue' });
      } else {
        // Fade with structural stop
        const isBullEntry = imp.direction === 'bear';
        const extreme = imp.direction === 'bull' ? imp.high : imp.low;
        const stop = isBullEntry ? extreme - 0 : extreme + 0;
        const target = isBullEntry ? next.close + 15 : next.close - 15;
        const risk = Math.abs(next.close - stop);
        if (risk > 50 || risk < 1) continue;
        const result = simTrade(candles, i + 1, next.close, isBullEntry, stop, target, 30);
        allTrades.push({ ...result, timestamp: imp.timestamp, type: 'fade' });
      }
    }

    allTrades.sort((a, b) => a.timestamp - b.timestamp);
    const cooled = applyCooldown(allTrades, 30 * 60 * 1000);
    printEquity('D: Combined (FVG=continue12/25, NoFVG=structural-fade/15) RTH cd=30m', cooled);
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log('  PHASE 3 ANALYSIS COMPLETE');
  console.log(`${'═'.repeat(72)}\n`);
}

// ── Helpers ────────────────────────────────────────────────────────
function measureFollowThrough(setups, candles, windows, mode = 'continue', idxField = 'entryIndex', priceField = 'entryPrice') {
  const results = {};
  for (const w of windows) {
    const m = [];
    for (const s of setups) {
      const idx = s[idxField] ?? s.index;
      const entry = s[priceField] ?? s.close;
      // For fade mode, direction is reversed
      const isBull = mode === 'continue' ? s.direction === 'bull' : s.direction === 'bear';
      if (idx + w >= candles.length) continue;

      let mfe = 0, mae = 0;
      for (let j = 1; j <= w; j++) {
        const c = candles[idx + j];
        if (isBull) { mfe = Math.max(mfe, c.high - entry); mae = Math.max(mae, entry - c.low); }
        else { mfe = Math.max(mfe, entry - c.low); mae = Math.max(mae, c.high - entry); }
      }
      const exitClose = candles[idx + w].close;
      const net = isBull ? exitClose - entry : entry - exitClose;
      m.push({ mfe, mae, net });
    }
    if (!m.length) continue;
    results[w] = {
      contRate: m.filter(x => x.net > 0).length / m.length,
      avgMFE: m.reduce((s, x) => s + x.mfe, 0) / m.length,
      avgMAE: m.reduce((s, x) => s + x.mae, 0) / m.length,
      avgNet: m.reduce((s, x) => s + x.net, 0) / m.length,
    };
  }
  return results;
}

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
  const last = candles[Math.min(entryIdx + maxHold, candles.length - 1)];
  return { pnl: isBull ? last.close - entryPrice : entryPrice - last.close, reason: 'time', bars: maxHold };
}

function simTradeSet(setups, candles, stopPts, targetPts, maxHold, mode) {
  return setups.map(s => {
    const isBull = mode === 'continue' ? s.direction === 'bull' : s.direction === 'bear';
    const entry = s.entryPrice ?? s.close;
    const stop = isBull ? entry - stopPts : entry + stopPts;
    const target = isBull ? entry + targetPts : entry - targetPts;
    return { ...simTrade(candles, s.entryIndex ?? s.index, entry, isBull, stop, target, maxHold), timestamp: s.timestamp };
  });
}

function simStructuralFVG(setups, candles, buffer, targetPts, maxHold) {
  return setups.map(s => {
    const isBull = s.direction === 'bull';
    const entry = s.entryPrice;
    const stop = isBull ? s.fvg.bottom - buffer : s.fvg.top + buffer;
    const target = isBull ? entry + targetPts : entry - targetPts;
    const risk = Math.abs(entry - stop);
    if (risk > 50 || risk < 1) return { pnl: 0, reason: 'skip', bars: 0, timestamp: s.timestamp };
    return { ...simTrade(candles, s.entryIndex, entry, isBull, stop, target, maxHold), timestamp: s.timestamp };
  }).filter(t => t.reason !== 'skip');
}

function simStructuralFade(setups, candles, buffer, targetPts, maxHold) {
  return setups.map(s => {
    const isBullEntry = s.direction === 'bear'; // fade
    const entry = s.entryPrice;
    const stop = isBullEntry ? s.impulseExtreme - buffer : s.impulseExtreme + buffer;
    const target = isBullEntry ? entry + targetPts : entry - targetPts;
    const risk = Math.abs(entry - stop);
    if (risk > 50 || risk < 1) return { pnl: 0, reason: 'skip', bars: 0, timestamp: s.timestamp };
    return { ...simTrade(candles, s.entryIndex, entry, isBullEntry, stop, target, maxHold), timestamp: s.timestamp };
  }).filter(t => t.reason !== 'skip');
}

function applyCooldown(trades, ms) {
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const out = [];
  let last = 0;
  for (const t of sorted) {
    if (t.timestamp - last >= ms) { out.push(t); last = t.timestamp; }
  }
  return out;
}

function printLine(label, trades) {
  if (trades.length < 5) { console.log(`${label}: n<5`); return; }
  const wins = trades.filter(t => t.pnl > 0).length;
  const wr = wins / trades.length;
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const avg = total / trades.length;
  const pf = profitFactor(trades);
  console.log(`${label.padEnd(36)} n=${String(trades.length).padStart(5)}  WR=${round(wr * 100).toFixed(1).padStart(5)}%  avg=${round(avg).toFixed(1).padStart(6)}  total=${round(total).toFixed(0).padStart(7)}  PF=${round(pf).toFixed(2).padStart(5)}`);
}

function profitFactor(trades) {
  const grossWin = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  return grossLoss > 0 ? grossWin / grossLoss : 0;
}

function printEquity(label, trades) {
  console.log(`\n  ${label} (n=${trades.length}):`);
  if (trades.length < 5) { console.log('    Too few'); return; }

  const months = {};
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    const m = new Date(t.timestamp).toISOString().slice(0, 7);
    if (!months[m]) months[m] = { n: 0, w: 0, pnl: 0 };
    months[m].n++; if (t.pnl > 0) months[m].w++;
    months[m].pnl += t.pnl;
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity - peak);
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const pf = profitFactor(trades);
  const perDay = total / (new Set(trades.map(t => getDateKey(t.timestamp))).size || 1);

  console.log(`    Total: ${round(total)}pts  WR=${round(wins / trades.length * 100)}%  PF=${round(pf)}  MaxDD=${round(maxDD)}pts  PnL/day=${round(perDay)}pts`);
  console.log(`    Month      N  Wins  WR%     PnL    Cum`);
  let cum = 0;
  for (const [m, d] of Object.entries(months).sort()) {
    cum += d.pnl;
    console.log(`    ${m}  ${String(d.n).padStart(3)}  ${String(d.w).padStart(3)}  ${round(d.n > 0 ? d.w / d.n * 100 : 0).toFixed(0).padStart(4)}%  ${round(d.pnl).toFixed(0).padStart(7)}  ${round(cum).toFixed(0).padStart(7)}`);
  }
}

main().catch(console.error);
