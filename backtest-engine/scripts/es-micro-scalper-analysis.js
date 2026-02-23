#!/usr/bin/env node

/**
 * ES Micro-Scalper Pattern Discovery Analysis
 *
 * Focused on symmetric target/stop (1/1, 2/2, 3/3 points) first-passage
 * probability. Finds patterns where price hits target before stop >60% of
 * the time — the only setups worth trading.
 *
 * Fee reality: ES = $50/point, $5 round-trip commission = 0.1 points.
 * At symmetric 1/1 need >55% win rate to break even.
 * At symmetric 2/2 need >52.5% win rate to break even.
 * At symmetric 3/3 need >51.7% win rate to break even.
 *
 * Usage:
 *   node es-micro-scalper-analysis.js [options]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { CSVLoader } from '../src/data/csv-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..', 'data');

// ─── Command Line Arguments ────────────────────────────────────────────

async function parseArgs() {
  return yargs(hideBin(process.argv))
    .usage('Usage: $0 [options]')
    .option('start', { type: 'string', description: 'Start date', default: '2024-01-01' })
    .option('end', { type: 'string', description: 'End date', default: '2026-01-25' })
    .option('is-start', { type: 'string', description: 'In-sample start', default: '2024-01-01' })
    .option('is-end', { type: 'string', description: 'In-sample end', default: '2024-12-31' })
    .option('oos-start', { type: 'string', description: 'Out-of-sample start', default: '2025-01-01' })
    .option('oos-end', { type: 'string', description: 'Out-of-sample end', default: '2026-01-25' })
    .option('output', { type: 'string', description: 'Output JSON file', default: 'es-micro-scalper-results.json' })
    .option('commission', { type: 'number', description: 'RT commission in points', default: 0.10 })
    .option('max-hold', { type: 'number', description: 'Max bars forward', default: 60 })
    .option('min-win-rate', { type: 'number', description: 'Min win% to highlight', default: 60 })
    .option('verbose', { alias: 'v', type: 'boolean', default: false })
    .help()
    .parse();
}

// ─── Session Utilities ─────────────────────────────────────────────────

// Fast session lookup using UTC offset (avoids slow toLocaleString)
// EST = UTC-5, EDT = UTC-4. For simplicity, approximate with -5.
function getSession(timestamp) {
  const ms = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  // EST hours: UTC hour - 5 (mod 24)
  const utcHour = Math.floor((ms % 86400000) / 3600000);
  const utcMin = Math.floor((ms % 3600000) / 60000);
  let estHour = utcHour - 5;
  if (estHour < 0) estHour += 24;
  const td = estHour + utcMin / 60;
  if (td >= 18 || td < 4) return 'overnight';
  if (td < 9.5) return 'premarket';
  if (td < 16) return 'rth';
  return 'afterhours';
}

// ─── Rolling Indicator State ───────────────────────────────────────────

class IndicatorState {
  constructor() {
    this.rsi3 = { period: 3, avgGain: 0, avgLoss: 0, count: 0, value: 50 };
    this.rsi6 = { period: 6, avgGain: 0, avgLoss: 0, count: 0, value: 50 };
    this.rsi14 = { period: 14, avgGain: 0, avgLoss: 0, count: 0, value: 50 };
    this.ema9 = { period: 9, value: null, k: 2 / 10 };
    this.ema20 = { period: 20, value: null, k: 2 / 21 };
    this.ema50 = { period: 50, value: null, k: 2 / 51 };
    this.bbWindow = [];
    this.bbPeriod = 20;
    this.atr14 = { period: 14, value: 0, count: 0 };
    this.volWindow = [];
    this.volPeriod = 20;
    this.avgVolume = 0;
    this.consecutiveGreen = 0;
    this.consecutiveRed = 0;
    this.totalBars = 0;
    this.warmUpComplete = false;
  }

  update(candle, prevCandle) {
    this.totalBars++;
    const close = candle.close;
    const prevClose = prevCandle ? prevCandle.close : close;
    const change = close - prevClose;

    this._updateRSI(this.rsi3, change);
    this._updateRSI(this.rsi6, change);
    this._updateRSI(this.rsi14, change);
    this._updateEMA(this.ema9, close);
    this._updateEMA(this.ema20, close);
    this._updateEMA(this.ema50, close);

    this.bbWindow.push(close);
    if (this.bbWindow.length > this.bbPeriod) this.bbWindow.shift();

    if (prevCandle) {
      const tr = Math.max(candle.high - candle.low, Math.abs(candle.high - prevClose), Math.abs(candle.low - prevClose));
      this._updateATR(tr);
    }

    this.volWindow.push(candle.volume);
    if (this.volWindow.length > this.volPeriod) this.volWindow.shift();
    this.avgVolume = this.volWindow.reduce((s, v) => s + v, 0) / this.volWindow.length;

    if (close > candle.open) { this.consecutiveGreen++; this.consecutiveRed = 0; }
    else if (close < candle.open) { this.consecutiveRed++; this.consecutiveGreen = 0; }

    if (this.totalBars >= 50) this.warmUpComplete = true;
  }

  _updateRSI(state, change) {
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    state.count++;
    if (state.count <= state.period) {
      state.avgGain += gain / state.period;
      state.avgLoss += loss / state.period;
      if (state.count === state.period) {
        state.value = state.avgLoss === 0 ? 100 : 100 - (100 / (1 + state.avgGain / state.avgLoss));
      }
    } else {
      state.avgGain = (state.avgGain * (state.period - 1) + gain) / state.period;
      state.avgLoss = (state.avgLoss * (state.period - 1) + loss) / state.period;
      state.value = state.avgLoss === 0 ? 100 : 100 - (100 / (1 + state.avgGain / state.avgLoss));
    }
  }

  _updateEMA(state, close) {
    state.value = state.value === null ? close : close * state.k + state.value * (1 - state.k);
  }

  _updateATR(tr) {
    this.atr14.count++;
    if (this.atr14.count <= this.atr14.period) this.atr14.value += tr / this.atr14.period;
    else this.atr14.value = (this.atr14.value * (this.atr14.period - 1) + tr) / this.atr14.period;
  }

  getBB() {
    if (this.bbWindow.length < this.bbPeriod) return { upper: null, middle: null, lower: null };
    const mean = this.bbWindow.reduce((s, v) => s + v, 0) / this.bbPeriod;
    const variance = this.bbWindow.reduce((s, v) => s + (v - mean) ** 2, 0) / this.bbPeriod;
    const std = Math.sqrt(variance);
    return { upper: mean + 2 * std, middle: mean, lower: mean - 2 * std };
  }
}

// ─── LT Level Loader ───────────────────────────────────────────────────

async function loadLtLevels(startDate, endDate) {
  const ltFile = path.join(dataDir, 'liquidity', 'es', 'ES_liquidity_levels_15m.csv');
  if (!fs.existsSync(ltFile)) {
    console.log('  No ES LT data found, LT patterns will be skipped');
    return new Map();
  }
  const loader = new CSVLoader(dataDir);
  const rows = await loader.loadCSV(ltFile);
  const ltMap = new Map();
  for (const row of rows) {
    const ts = new Date(row.datetime).getTime();
    if (isNaN(ts) || ts < startDate.getTime() || ts > endDate.getTime()) continue;
    const bucket = Math.floor(ts / (15 * 60 * 1000)) * (15 * 60 * 1000);
    const levels = [];
    for (let i = 1; i <= 5; i++) {
      const val = parseFloat(row[`level_${i}`]);
      if (!isNaN(val)) levels.push(val);
    }
    if (levels.length > 0) ltMap.set(bucket, { levels, sentiment: row.sentiment });
  }
  console.log(`  Loaded ${ltMap.size} ES LT snapshots`);
  return ltMap;
}

// ─── GEX Level Loader ──────────────────────────────────────────────────

async function loadGexLevels(startDate, endDate) {
  const gexDir = path.join(dataDir, 'gex', 'es');
  if (!fs.existsSync(gexDir)) {
    console.log('  No ES GEX data found, GEX patterns will be skipped');
    return new Map();
  }
  const files = fs.readdirSync(gexDir).filter(f => f.endsWith('.json')).sort();
  const gexMap = new Map();
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(gexDir, file), 'utf-8'));
    if (!Array.isArray(data)) continue;
    for (const snap of data) {
      const ts = new Date(snap.timestamp).getTime();
      if (ts < startDate.getTime() || ts > endDate.getTime()) continue;
      const bucket = Math.floor(ts / (15 * 60 * 1000)) * (15 * 60 * 1000);
      gexMap.set(bucket, { support: snap.support || [], resistance: snap.resistance || [], regime: snap.regime });
    }
  }
  console.log(`  Loaded ${gexMap.size} ES GEX snapshots`);
  return gexMap;
}

// ─── Pattern Detection ─────────────────────────────────────────────────

function detectPatterns(candle, prevCandle, ind, gexLevels, ltLevels) {
  const patterns = [];
  if (!ind.warmUpComplete) return patterns;
  const price = candle.close;

  // 1. RSI(3) extreme
  if (ind.rsi3.value < 10) patterns.push({ name: 'rsi3_oversold', side: 'long', tag: `rsi3=${ind.rsi3.value.toFixed(1)}` });
  if (ind.rsi3.value > 90) patterns.push({ name: 'rsi3_overbought', side: 'short', tag: `rsi3=${ind.rsi3.value.toFixed(1)}` });
  // Deep RSI(3): more extreme
  if (ind.rsi3.value < 5) patterns.push({ name: 'rsi3_deep_oversold', side: 'long', tag: `rsi3=${ind.rsi3.value.toFixed(1)}` });
  if (ind.rsi3.value > 95) patterns.push({ name: 'rsi3_deep_overbought', side: 'short', tag: `rsi3=${ind.rsi3.value.toFixed(1)}` });

  // 2. RSI(6) extreme
  if (ind.rsi6.value < 15) patterns.push({ name: 'rsi6_oversold', side: 'long', tag: `rsi6=${ind.rsi6.value.toFixed(1)}` });
  if (ind.rsi6.value > 85) patterns.push({ name: 'rsi6_overbought', side: 'short', tag: `rsi6=${ind.rsi6.value.toFixed(1)}` });

  // 3. Consecutive candles — test each N separately
  if (ind.consecutiveGreen === 3) patterns.push({ name: 'consec_green_3', side: 'short', tag: '' });
  if (ind.consecutiveGreen === 4) patterns.push({ name: 'consec_green_4', side: 'short', tag: '' });
  if (ind.consecutiveGreen >= 5) patterns.push({ name: 'consec_green_5+', side: 'short', tag: `n=${ind.consecutiveGreen}` });
  if (ind.consecutiveRed === 3) patterns.push({ name: 'consec_red_3', side: 'long', tag: '' });
  if (ind.consecutiveRed === 4) patterns.push({ name: 'consec_red_4', side: 'long', tag: '' });
  if (ind.consecutiveRed >= 5) patterns.push({ name: 'consec_red_5+', side: 'long', tag: `n=${ind.consecutiveRed}` });

  // 4. Bollinger Band touch/pierce
  const bb = ind.getBB();
  if (bb.lower !== null) {
    if (price <= bb.lower) patterns.push({ name: 'bb_lower_touch', side: 'long', tag: `dev=${(bb.lower - price).toFixed(2)}` });
    if (price >= bb.upper) patterns.push({ name: 'bb_upper_touch', side: 'short', tag: `dev=${(price - bb.upper).toFixed(2)}` });
    // Deep pierce: >1pt beyond band
    if (price <= bb.lower - 1) patterns.push({ name: 'bb_lower_pierce', side: 'long', tag: `dev=${(bb.lower - price).toFixed(2)}` });
    if (price >= bb.upper + 1) patterns.push({ name: 'bb_upper_pierce', side: 'short', tag: `dev=${(price - bb.upper).toFixed(2)}` });
  }

  // 5. EMA(20) deviation — test at 2, 3, 4, 5 pts
  if (ind.ema20.value !== null) {
    const dev = price - ind.ema20.value;
    for (const pts of [2, 3, 4, 5]) {
      if (dev > pts && dev <= pts + 1) patterns.push({ name: `ema20_above_${pts}pt`, side: 'short', tag: `dev=${dev.toFixed(2)}` });
      if (dev < -pts && dev >= -(pts + 1)) patterns.push({ name: `ema20_below_${pts}pt`, side: 'long', tag: `dev=${dev.toFixed(2)}` });
    }
    // Also catch extreme deviation (>5)
    if (dev > 5) patterns.push({ name: 'ema20_above_5pt+', side: 'short', tag: `dev=${dev.toFixed(2)}` });
    if (dev < -5) patterns.push({ name: 'ema20_below_5pt+', side: 'long', tag: `dev=${dev.toFixed(2)}` });
  }

  // 6. Large candle fade (body > 2*ATR)
  if (ind.atr14.value > 0) {
    const body = Math.abs(candle.close - candle.open);
    if (body > 2 * ind.atr14.value) {
      if (candle.close > candle.open) patterns.push({ name: 'large_bull_candle_fade', side: 'short', tag: `body/atr=${(body/ind.atr14.value).toFixed(1)}` });
      else patterns.push({ name: 'large_bear_candle_fade', side: 'long', tag: `body/atr=${(body/ind.atr14.value).toFixed(1)}` });
    }
    // Also 3x ATR
    if (body > 3 * ind.atr14.value) {
      if (candle.close > candle.open) patterns.push({ name: 'huge_bull_candle_fade', side: 'short', tag: `body/atr=${(body/ind.atr14.value).toFixed(1)}` });
      else patterns.push({ name: 'huge_bear_candle_fade', side: 'long', tag: `body/atr=${(body/ind.atr14.value).toFixed(1)}` });
    }
  }

  // 7. GEX S1/R1 proximity (within 2pts)
  if (gexLevels) {
    const s1 = gexLevels.support?.[0];
    const r1 = gexLevels.resistance?.[0];
    if (s1 != null && Math.abs(price - s1) <= 2) patterns.push({ name: 'gex_s1_bounce', side: 'long', tag: `dist=${(price-s1).toFixed(2)}` });
    if (r1 != null && Math.abs(price - r1) <= 2) patterns.push({ name: 'gex_r1_bounce', side: 'short', tag: `dist=${(price-r1).toFixed(2)}` });
    // Tighter: within 1pt
    if (s1 != null && Math.abs(price - s1) <= 1) patterns.push({ name: 'gex_s1_tight', side: 'long', tag: `dist=${(price-s1).toFixed(2)}` });
    if (r1 != null && Math.abs(price - r1) <= 1) patterns.push({ name: 'gex_r1_tight', side: 'short', tag: `dist=${(price-r1).toFixed(2)}` });
  }

  // 8. LT level proximity (any level within 2pts)
  if (ltLevels) {
    let closestDist = Infinity;
    let closestSide = null;
    for (const level of ltLevels.levels) {
      const dist = Math.abs(price - level);
      if (dist < closestDist) {
        closestDist = dist;
        closestSide = price >= level ? 'long' : 'short';
      }
    }
    if (closestDist <= 2) patterns.push({ name: 'lt_level_bounce', side: closestSide, tag: `dist=${closestDist.toFixed(2)}` });
    if (closestDist <= 1) patterns.push({ name: 'lt_level_tight', side: closestSide, tag: `dist=${closestDist.toFixed(2)}` });
  }

  // 9. Volume spike + rejection wick
  if (ind.avgVolume > 0 && candle.volume > 2 * ind.avgVolume) {
    const range = candle.high - candle.low;
    if (range > 0) {
      const upperWick = candle.high - Math.max(candle.open, candle.close);
      const lowerWick = Math.min(candle.open, candle.close) - candle.low;
      if (upperWick / range > 0.6) patterns.push({ name: 'vol_spike_reject_top', side: 'short', tag: `vol=${(candle.volume/ind.avgVolume).toFixed(1)}x` });
      if (lowerWick / range > 0.6) patterns.push({ name: 'vol_spike_reject_bot', side: 'long', tag: `vol=${(candle.volume/ind.avgVolume).toFixed(1)}x` });
    }
  }

  // 10. Combo patterns: RSI(3) extreme + BB touch
  if (ind.rsi3.value < 10 && bb.lower !== null && price <= bb.lower) {
    patterns.push({ name: 'COMBO_rsi3os_bb_lower', side: 'long', tag: '' });
  }
  if (ind.rsi3.value > 90 && bb.upper !== null && price >= bb.upper) {
    patterns.push({ name: 'COMBO_rsi3ob_bb_upper', side: 'short', tag: '' });
  }

  // 11. Combo: RSI(3) extreme + consecutive candles
  if (ind.rsi3.value < 10 && ind.consecutiveRed >= 3) {
    patterns.push({ name: 'COMBO_rsi3os_consec_red', side: 'long', tag: '' });
  }
  if (ind.rsi3.value > 90 && ind.consecutiveGreen >= 3) {
    patterns.push({ name: 'COMBO_rsi3ob_consec_green', side: 'short', tag: '' });
  }

  // 12. Combo: BB touch + volume spike
  if (bb.lower !== null && price <= bb.lower && ind.avgVolume > 0 && candle.volume > 2 * ind.avgVolume) {
    patterns.push({ name: 'COMBO_bb_lower_vol_spike', side: 'long', tag: '' });
  }
  if (bb.upper !== null && price >= bb.upper && ind.avgVolume > 0 && candle.volume > 2 * ind.avgVolume) {
    patterns.push({ name: 'COMBO_bb_upper_vol_spike', side: 'short', tag: '' });
  }

  return patterns;
}

// ─── Symmetric First-Passage ───────────────────────────────────────────

const SYMMETRIC_GRID = [1, 2, 3]; // 1/1, 2/2, 3/3

function runFirstPassage(candles, entryIndex, side, maxHold) {
  const entryPrice = candles[entryIndex].close;
  const results = {};
  let mfe = 0, mae = 0;

  for (const pts of SYMMETRIC_GRID) {
    results[pts] = { hit: null, barsToExit: maxHold };
  }

  for (let i = 1; i <= maxHold; i++) {
    const idx = entryIndex + i;
    if (idx >= candles.length) break;
    const bar = candles[idx];

    const favorable = side === 'long' ? bar.high - entryPrice : entryPrice - bar.low;
    const adverse = side === 'long' ? entryPrice - bar.low : bar.high - entryPrice;

    if (favorable > mfe) mfe = favorable;
    if (adverse > mae) mae = adverse;

    for (const pts of SYMMETRIC_GRID) {
      if (results[pts].hit !== null) continue;
      const tHit = favorable >= pts;
      const sHit = adverse >= pts;
      if (tHit && sHit) { results[pts] = { hit: 'stop', barsToExit: i }; }
      else if (tHit) { results[pts] = { hit: 'target', barsToExit: i }; }
      else if (sHit) { results[pts] = { hit: 'stop', barsToExit: i }; }
    }
  }

  for (const pts of SYMMETRIC_GRID) {
    if (results[pts].hit === null) results[pts].hit = 'timeout';
  }

  return { results, mfe, mae };
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = await parseArgs();
  const startDate = new Date(args.start);
  const endDate = new Date(args.end);
  const isStart = new Date(args.isStart);
  const isEnd = new Date(args.isEnd);
  const oosStart = new Date(args.oosStart);
  const oosEnd = new Date(args.oosEnd);
  const commission = args.commission;
  const maxHold = args.maxHold;
  const minWR = args.minWinRate;

  console.log('');
  console.log('  ES Micro-Scalper: Symmetric First-Passage Analysis');
  console.log('  ═══════════════════════════════════════════════════');
  console.log(`  Data:        ${args.start} to ${args.end}`);
  console.log(`  In-sample:   ${args.isStart} to ${args.isEnd}`);
  console.log(`  OOS:         ${args.oosStart} to ${args.oosEnd}`);
  console.log(`  Targets:     1/1, 2/2, 3/3 pts (symmetric)`);
  console.log(`  Commission:  ${commission} pts ($${(commission * 50).toFixed(2)}/RT)`);
  console.log(`  Max hold:    ${maxHold} bars`);
  console.log(`  Min WR:      ${minWR}%`);
  console.log('');

  // Load data
  const defaultConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf-8'));
  const loader = new CSVLoader(dataDir, defaultConfig);
  const { candles } = await loader.loadOHLCVData('ES', startDate, endDate);
  console.log(`  Loaded ${candles.length.toLocaleString()} ES 1m candles`);

  const gexMap = await loadGexLevels(startDate, endDate);
  const ltMap = await loadLtLevels(startDate, endDate);
  console.log('');

  // Pattern accumulators
  // patternName -> { is: { wins/losses/timeouts per pts, mfeSum, maeSum, count, sessions }, oos: ... }
  const data = {};

  function ensure(name) {
    if (!data[name]) {
      data[name] = {};
      for (const period of ['is', 'oos']) {
        data[name][period] = { count: 0, mfeSum: 0, maeSum: 0, sessions: {} };
        for (const pts of SYMMETRIC_GRID) {
          data[name][period][pts] = { wins: 0, losses: 0, timeouts: 0, totalBars: 0 };
        }
      }
    }
    return data[name];
  }

  // Process - with FP cache: only run forward scan once per (index, side)
  const indicators = new IndicatorState();
  let prevCandle = null;
  let totalPatterns = 0;
  let fpCacheHits = 0;
  const progressEvery = Math.floor(candles.length / 20);
  const startTime = Date.now();

  // Pre-convert all timestamps to numbers for speed
  const isStartMs = isStart.getTime();
  const isEndMs = isEnd.getTime();
  const oosStartMs = oosStart.getTime();
  const oosEndMs = oosEnd.getTime();

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    if (i > 0 && i % progressEvery === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = Math.floor(i / elapsed);
      const eta = Math.floor((candles.length - i) / rate);
      console.log(`  ${((i / candles.length) * 100).toFixed(0)}% | ${rate}/s | ETA: ${eta}s | ${totalPatterns.toLocaleString()} patterns (${fpCacheHits} cache hits)`);
    }

    indicators.update(candle, prevCandle);

    if (!indicators.warmUpComplete || i + maxHold >= candles.length) {
      prevCandle = candle;
      continue;
    }

    const candleTs = typeof candle.timestamp === 'number' ? candle.timestamp : new Date(candle.timestamp).getTime();
    const isIS = candleTs >= isStartMs && candleTs <= isEndMs;
    const isOOS = candleTs >= oosStartMs && candleTs <= oosEndMs;
    if (!isIS && !isOOS) { prevCandle = candle; continue; }

    const period = isIS ? 'is' : 'oos';
    const gexBucket = Math.floor(candleTs / (15 * 60 * 1000)) * (15 * 60 * 1000);
    const gexLevels = gexMap.get(gexBucket) || null;
    const ltLevels = ltMap.get(gexBucket) || null;

    const detected = detectPatterns(candle, prevCandle, indicators, gexLevels, ltLevels);

    if (detected.length === 0) { prevCandle = candle; continue; }

    // Compute session ONCE per candle (not per pattern)
    const session = getSession(candleTs);

    // Cache FP results per (index, side) - many patterns share same scan
    let fpLong = null, fpShort = null;

    for (const pattern of detected) {
      // Reuse cached FP result for same side
      let fp;
      if (pattern.side === 'long') {
        if (!fpLong) fpLong = runFirstPassage(candles, i, 'long', maxHold);
        else fpCacheHits++;
        fp = fpLong;
      } else {
        if (!fpShort) fpShort = runFirstPassage(candles, i, 'short', maxHold);
        else fpCacheHits++;
        fp = fpShort;
      }

      const d = ensure(pattern.name)[period];
      d.count++;
      d.mfeSum += fp.mfe;
      d.maeSum += fp.mae;

      for (const pts of SYMMETRIC_GRID) {
        const r = fp.results[pts];
        if (r.hit === 'target') d[pts].wins++;
        else if (r.hit === 'stop') d[pts].losses++;
        else d[pts].timeouts++;
        d[pts].totalBars += r.barsToExit;
      }

      // Session tracking (session already computed above)
      if (!d.sessions[session]) {
        d.sessions[session] = { count: 0 };
        for (const pts of SYMMETRIC_GRID) d.sessions[session][pts] = { wins: 0, losses: 0, timeouts: 0 };
      }
      d.sessions[session].count++;
      for (const pts of SYMMETRIC_GRID) {
        const r = fp.results[pts];
        if (r.hit === 'target') d.sessions[session][pts].wins++;
        else if (r.hit === 'stop') d.sessions[session][pts].losses++;
        else d.sessions[session][pts].timeouts++;
      }

      totalPatterns++;
    }

    prevCandle = candle;
  }

  console.log(`\n  Done: ${totalPatterns.toLocaleString()} total pattern occurrences\n`);

  // ─── Output ──────────────────────────────────────────────────────────

  function wr(wins, losses, timeouts) {
    const total = wins + losses + timeouts;
    return total === 0 ? 0 : (wins / total) * 100;
  }

  function epnl(wins, losses, timeouts, pts, comm) {
    const total = wins + losses + timeouts;
    if (total === 0) return 0;
    const w = wins / total;
    return (w * pts - (1 - w) * pts - comm) * 50; // dollars
  }

  // Build sorted results for each symmetric level
  const results = { metadata: { commission, maxHold, totalPatterns }, patterns: {} };

  for (const [name, pd] of Object.entries(data)) {
    results.patterns[name] = {};
    for (const period of ['is', 'oos']) {
      const d = pd[period];
      results.patterns[name][period] = { count: d.count, avgMFE: d.count ? +(d.mfeSum / d.count).toFixed(3) : 0, avgMAE: d.count ? +(d.maeSum / d.count).toFixed(3) : 0 };
      for (const pts of SYMMETRIC_GRID) {
        const s = d[pts];
        const total = s.wins + s.losses + s.timeouts;
        results.patterns[name][period][`${pts}pt`] = {
          total, wins: s.wins, losses: s.losses, timeouts: s.timeouts,
          winRate: +(wr(s.wins, s.losses, s.timeouts)).toFixed(2),
          epnl: +(epnl(s.wins, s.losses, s.timeouts, pts, commission)).toFixed(2),
          avgBars: total ? +(s.totalBars / total).toFixed(1) : 0
        };
      }
      // Session breakdown
      results.patterns[name][period].sessions = {};
      for (const [session, sd] of Object.entries(d.sessions)) {
        results.patterns[name][period].sessions[session] = { count: sd.count };
        for (const pts of SYMMETRIC_GRID) {
          results.patterns[name][period].sessions[session][`${pts}pt`] = {
            winRate: +(wr(sd[pts].wins, sd[pts].losses, sd[pts].timeouts)).toFixed(2)
          };
        }
      }
    }
  }

  // Print tables for each symmetric target
  for (const pts of SYMMETRIC_GRID) {
    console.log(`  ═══════════════════════════════════════════════════════════════════════════════════`);
    console.log(`  ${pts}pt / ${pts}pt SYMMETRIC  (breakeven: ${((pts + commission) / (2 * pts) * 100).toFixed(1)}%)`);
    console.log(`  ═══════════════════════════════════════════════════════════════════════════════════`);

    const rows = Object.entries(data)
      .map(([name, pd]) => {
        const is = pd.is[pts];
        const oos = pd.oos[pts];
        const isTotal = is.wins + is.losses + is.timeouts;
        const oosTotal = oos.wins + oos.losses + oos.timeouts;
        return {
          name,
          isCount: pd.is.count,
          oosCount: pd.oos.count,
          isWR: wr(is.wins, is.losses, is.timeouts),
          oosWR: wr(oos.wins, oos.losses, oos.timeouts),
          isEpnl: epnl(is.wins, is.losses, is.timeouts, pts, commission),
          oosEpnl: epnl(oos.wins, oos.losses, oos.timeouts, pts, commission),
          isTotal, oosTotal,
          avgMFE: pd.is.count ? pd.is.mfeSum / pd.is.count : 0,
          avgMAE: pd.is.count ? pd.is.maeSum / pd.is.count : 0
        };
      })
      .filter(r => r.isTotal >= 30) // min sample
      .sort((a, b) => b.isWR - a.isWR);

    const hdr = `  ${'Pattern'.padEnd(30)} ${'IS n'.padStart(6)} ${'IS WR%'.padStart(7)} ${'IS E[$]'.padStart(8)} ${'OOS n'.padStart(6)} ${'OOS WR%'.padStart(8)} ${'OOS E[$]'.padStart(9)} ${'MFE'.padStart(6)} ${'MAE'.padStart(6)}`;
    console.log(hdr);
    console.log('  ' + '─'.repeat(hdr.length - 2));

    let foundEdge = false;
    for (const r of rows) {
      const marker = (r.isWR >= minWR && r.oosWR >= minWR) ? ' ***' : (r.isWR >= minWR ? ' *' : '');
      if (r.isWR >= minWR) foundEdge = true;
      const isE = r.isEpnl >= 0 ? `+$${r.isEpnl.toFixed(0)}` : `-$${Math.abs(r.isEpnl).toFixed(0)}`;
      const oosE = r.oosEpnl >= 0 ? `+$${r.oosEpnl.toFixed(0)}` : `-$${Math.abs(r.oosEpnl).toFixed(0)}`;
      console.log(`  ${name30(r.name)} ${r.isTotal.toString().padStart(6)} ${r.isWR.toFixed(1).padStart(6)}% ${isE.padStart(8)} ${r.oosTotal.toString().padStart(6)} ${r.oosWR.toFixed(1).padStart(7)}% ${oosE.padStart(9)} ${r.avgMFE.toFixed(1).padStart(6)} ${r.avgMAE.toFixed(1).padStart(6)}${marker}`);
    }

    if (!foundEdge) console.log('  (no patterns reached ' + minWR + '% win rate at this target)');
    console.log('');
  }

  // Session breakdown for top patterns
  console.log('  ═══════════════════════════════════════════════════════════════════════════════════');
  console.log('  SESSION BREAKDOWN (top patterns by IS win rate at 2pt/2pt)');
  console.log('  ═══════════════════════════════════════════════════════════════════════════════════');

  const topByIS2 = Object.entries(data)
    .map(([name, pd]) => {
      const s = pd.is[2];
      const total = s.wins + s.losses + s.timeouts;
      return { name, wrIS: wr(s.wins, s.losses, s.timeouts), total, sessions: pd.is.sessions };
    })
    .filter(r => r.total >= 30)
    .sort((a, b) => b.wrIS - a.wrIS)
    .slice(0, 15);

  console.log(`  ${'Pattern'.padEnd(30)} ${'Overall'.padStart(8)} ${'RTH'.padStart(8)} ${'Premarket'.padStart(10)} ${'Overnight'.padStart(10)} ${'AH'.padStart(8)}`);
  console.log('  ' + '─'.repeat(80));

  for (const r of topByIS2) {
    const sessWR = {};
    for (const session of ['rth', 'premarket', 'overnight', 'afterhours']) {
      const sd = r.sessions[session];
      if (sd) sessWR[session] = wr(sd[2].wins, sd[2].losses, sd[2].timeouts);
      else sessWR[session] = null;
    }
    const fmt = (v) => v === null ? '   n/a' : `${v.toFixed(1)}%`;
    console.log(`  ${name30(r.name)} ${r.wrIS.toFixed(1).padStart(7)}% ${fmt(sessWR.rth).padStart(8)} ${fmt(sessWR.premarket).padStart(10)} ${fmt(sessWR.overnight).padStart(10)} ${fmt(sessWR.afterhours).padStart(8)}`);
  }

  console.log('');
  console.log('  Legend: *** = >' + minWR + '% in BOTH IS and OOS | * = >' + minWR + '% in IS only');
  console.log('');

  // Save JSON
  fs.writeFileSync(args.output, JSON.stringify(results, null, 2));
  console.log(`  Results saved to ${args.output}`);
}

function name30(s) { return s.length > 30 ? s.substring(0, 27) + '...' : s.padEnd(30); }

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
