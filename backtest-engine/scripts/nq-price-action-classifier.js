#!/usr/bin/env node
/**
 * NQ Price Action Classifier: Short-Side Exhaustion from 1-Second Microstructure
 *
 * Detects 1-minute bars where intra-bar "buy absorption" (dip bought, close near high)
 * predicts downward continuation — an exhaustion pattern. SHORT signals only.
 *
 * The absorption score measures how strongly the bar recovered from its low:
 *   - High score = close near high, early low, volume on recovery → strong exhaustion → SHORT
 *   - Bars with score <= 0 (sell absorption / rip sold) are excluded — longs don't work
 *
 * Streams 1-second NQ data, computes intra-bar features, derives absorption score,
 * validates short signals against forward returns with MFE/MAE, and sweeps thresholds.
 *
 * Usage:
 *   node scripts/nq-price-action-classifier.js [options]
 *
 * Options:
 *   --start YYYY-MM-DD          Start date (default: 2025-10-01)
 *   --end YYYY-MM-DD            End date (default: 2025-12-31)
 *   --strong-threshold N        Absorption score for "strong" short (default: 0.5)
 *   --moderate-threshold N      Absorption score for "moderate" short (default: 0.25)
 *   --horizons N,N,N            Forward return horizons in minutes (default: 1,5,15,30)
 *   --min-range N               Min bar range in points (default: 10)
 *   --sample-size N             Sample bars in output (default: 100)
 *   --session rth|all           Session filter (default: rth)
 *   --output FILE               Output JSON path
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

// ============================================================================
// CLI
// ============================================================================

const args = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : def; };

const startDateStr = getArg('start', '2025-10-01');
const endDateStr = getArg('end', '2025-12-31');
const strongThreshold = parseFloat(getArg('strong-threshold', '0.5'));
const moderateThreshold = parseFloat(getArg('moderate-threshold', '0.25'));
const horizonMinutes = getArg('horizons', '1,2,3,5').split(',').map(Number);
const minRange = parseFloat(getArg('min-range', '10'));
const sampleSize = parseInt(getArg('sample-size', '100'));
const sessionFilter = getArg('session', 'rth');
const outputPath = getArg('output', 'results/price-action-classifier/NQ-shorts-results.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');
const dataFile = path.join(dataDir, 'ohlcv/nq/NQ_ohlcv_1s.csv');
const MAX_HORIZON = Math.max(...horizonMinutes);

console.log('='.repeat(80));
console.log('NQ EXHAUSTION SHORTS: Buy-Absorption → Short Signal');
console.log('='.repeat(80));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log(`Thresholds: strong=${strongThreshold}, moderate=${moderateThreshold}`);
console.log(`Horizons: ${horizonMinutes.join('m, ')}m`);
console.log(`Min range: ${minRange} pts | Session: ${sessionFilter}`);
console.log();

// ============================================================================
// Helpers
// ============================================================================

function getColumnParser(headerLine) {
  const cols = headerLine.split(',').map(c => c.trim());
  const idx = {};
  cols.forEach((name, i) => { idx[name] = i; });
  return {
    tsIdx: idx['ts_event'] ?? 0,
    openIdx: idx['open'], highIdx: idx['high'], lowIdx: idx['low'],
    closeIdx: idx['close'], volumeIdx: idx['volume'], symbolIdx: idx['symbol'],
    minCols: Math.max(idx['open'], idx['high'], idx['low'], idx['close'], idx['volume'], idx['symbol']) + 1
  };
}

function getSession(timestampMs) {
  const date = new Date(timestampMs);
  const timeMin = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (timeMin >= 870 && timeMin < 1260) return 'rth';
  if (timeMin >= 780 && timeMin < 870) return 'premarket';
  if (timeMin >= 1260 && timeMin < 1380) return 'afterhours';
  return 'overnight';
}

function getMinuteKey(ms) { return Math.floor(ms / 60000); }

class WelfordTracker {
  constructor() { this.n = 0; this.mean = 0; this.M2 = 0; }
  update(v) { this.n++; const d = v - this.mean; this.mean += d / this.n; this.M2 += d * (v - this.mean); }
  get stddev() { return this.n < 2 ? 0 : Math.sqrt(this.M2 / (this.n - 1)); }
  zScore(v) { const s = this.stddev; return (s === 0 || this.n < 30) ? 0 : (v - this.mean) / s; }
}

class PrimaryContractTracker {
  constructor() { this.currentHour = null; this.hourVolumes = new Map(); this.primarySymbol = null; }
  processCandle(c) {
    const hk = Math.floor(c.timestamp / 3600000);
    if (hk !== this.currentHour) {
      if (this.currentHour !== null && this.hourVolumes.size > 0) {
        let mx = 0; for (const [s, v] of this.hourVolumes) { if (v > mx) { mx = v; this.primarySymbol = s; } }
      }
      this.currentHour = hk; this.hourVolumes = new Map();
    }
    this.hourVolumes.set(c.symbol, (this.hourVolumes.get(c.symbol) || 0) + c.volume);
    if (!this.primarySymbol) { let mx = 0; for (const [s, v] of this.hourVolumes) { if (v > mx) { mx = v; this.primarySymbol = s; } } }
    return c.symbol === this.primarySymbol;
  }
}

// ============================================================================
// Stats
// ============================================================================

function percentile(arr, pct) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = (pct / 100) * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function tTest(values) {
  if (values.length < 3) return { t: 0, p: 1.0 };
  const n = values.length, mean = values.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n);
  if (se === 0) return { t: 0, p: 1.0 };
  const t = mean / se, absT = Math.abs(t);
  // Abramowitz & Stegun normal CDF approximation
  const x = absT, k = 1 / (1 + 0.3275911 * x);
  const cdf = 1 - ((((1.061405429 * k - 1.453152027) * k + 1.421413741) * k - 0.284496736) * k + 0.254829592) * k * Math.exp(-x * x / 2);
  return { t: +t.toFixed(3), p: +(2 * (1 - (0.5 * (1 + (absT < 0 ? -1 : 1) * (2 * cdf - 1))))).toFixed(6) };
}

function pearsonR(xs, ys) {
  if (xs.length < 5) return 0;
  const n = xs.length;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sx2 += xs[i] ** 2; sy2 += ys[i] ** 2; }
  const den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  return den === 0 ? 0 : (n * sxy - sx * sy) / den;
}

// ============================================================================
// Intra-Bar Features
// ============================================================================

function computeBarFeatures(seconds) {
  if (seconds.length < 3) return null;
  const barOpen = seconds[0].open, barClose = seconds[seconds.length - 1].close;
  let barHigh = -Infinity, barLow = Infinity, totalVolume = 0;
  for (const s of seconds) { if (s.high > barHigh) barHigh = s.high; if (s.low < barLow) barLow = s.low; totalVolume += s.volume; }
  const barRange = barHigh - barLow;
  if (barRange < 0.001) return null;

  const closePosition = (barClose - barLow) / barRange;
  const netMove = barClose - barOpen;
  let pathLength = 0;
  for (let i = 1; i < seconds.length; i++) pathLength += Math.abs(seconds[i].close - seconds[i - 1].close);
  const pathEfficiency = pathLength > 0 ? netMove / pathLength : 0;

  let lowIdx = 0, highIdx = 0, minLow = seconds[0].low, maxHigh = seconds[0].high;
  for (let i = 1; i < seconds.length; i++) {
    if (seconds[i].low < minLow) { minLow = seconds[i].low; lowIdx = i; }
    if (seconds[i].high > maxHigh) { maxHigh = seconds[i].high; highIdx = i; }
  }
  const n = seconds.length - 1;
  const lowTiming = n > 0 ? lowIdx / n : 0.5;
  const highTiming = n > 0 ? highIdx / n : 0.5;

  const timeBefore = lowIdx, timeAfter = seconds.length - 1 - lowIdx;
  const dipSpeedAsymmetry = (timeBefore + timeAfter) > 0 ? (timeAfter - timeBefore) / (timeBefore + timeAfter) : 0;

  let volBeforeLow = 0, volAfterLow = 0;
  for (let i = 0; i < seconds.length; i++) { if (i <= lowIdx) volBeforeLow += seconds[i].volume; else volAfterLow += seconds[i].volume; }
  const dipVolumeRatio = volBeforeLow > 0 ? volAfterLow / volBeforeLow : 1;

  let volBeforeHigh = 0, volAfterHigh = 0;
  for (let i = 0; i < seconds.length; i++) { if (i <= highIdx) volBeforeHigh += seconds[i].volume; else volAfterHigh += seconds[i].volume; }
  const ripVolumeRatio = volBeforeHigh > 0 ? volAfterHigh / volBeforeHigh : 1;

  let vwapNum = 0, vwapDen = 0;
  for (const s of seconds) { const tp = (s.high + s.low + s.close) / 3; vwapNum += tp * s.volume; vwapDen += s.volume; }
  const vwap = vwapDen > 0 ? vwapNum / vwapDen : (barHigh + barLow) / 2;
  const vwapPosition = (vwap - barLow) / barRange;
  const closeVsVwap = barClose - vwap;

  let reversals = 0;
  for (let i = 2; i < seconds.length; i++) {
    const prev = seconds[i - 1].close - seconds[i - 2].close, curr = seconds[i].close - seconds[i - 1].close;
    if ((prev > 0 && curr < 0) || (prev < 0 && curr > 0)) reversals++;
  }
  const pathChoppiness = reversals / Math.max(seconds.length - 2, 1);

  return { barOpen, barClose, barHigh, barLow, barRange, totalVolume, netMove,
    closePosition, pathEfficiency, lowTiming, highTiming, dipSpeedAsymmetry,
    dipVolumeRatio, ripVolumeRatio, vwapPosition, closeVsVwap, pathChoppiness,
    secondCount: seconds.length };
}

// ============================================================================
// Absorption Score (positive = buy absorption = SHORT signal strength)
// ============================================================================

function computeAbsorptionScore(features, rangeZ) {
  const closeScore = features.closePosition * 2 - 1;
  const pathScore = features.pathEfficiency;
  const lowTimingScore = 1 - 2 * features.lowTiming;
  const highTimingScore = 2 * features.highTiming - 1;
  const timingScore = (lowTimingScore + highTimingScore) / 2;
  const vwapScore = features.vwapPosition * 2 - 1;
  const dipVolSignal = Math.min(Math.max((features.dipVolumeRatio - 1) / 2, -1), 1);
  const ripVolSignal = Math.min(Math.max((features.ripVolumeRatio - 1) / 2, -1), 1);
  const volumeScore = Math.min(Math.max(dipVolSignal - ripVolSignal, -1), 1);

  const rawScore = 0.30 * closeScore + 0.20 * pathScore + 0.20 * timingScore + 0.15 * vwapScore + 0.15 * volumeScore;

  const rangeSignificance = rangeZ <= -2 ? 0.2 : rangeZ <= -1 ? 0.5 : rangeZ <= 0 ? 0.8 : 1.0;
  const score = Math.min(Math.max(rawScore * rangeSignificance, -1), 1);

  return {
    score, rawScore, rangeSignificance,
    subScores: {
      close: +closeScore.toFixed(4), path: +pathScore.toFixed(4), timing: +timingScore.toFixed(4),
      vwap: +vwapScore.toFixed(4), volume: +volumeScore.toFixed(4)
    }
  };
}

// ============================================================================
// Labels (shorts only — positive absorption score)
// ============================================================================

function getLabel(score) {
  if (score >= strongThreshold) return 'strong_short';
  if (score >= moderateThreshold) return 'moderate_short';
  if (score > 0) return 'weak_short';
  return 'no_signal';
}

// ============================================================================
// Streaming Pipeline
// ============================================================================

async function runAnalysis() {
  if (!fs.existsSync(dataFile)) { console.error(`Data file not found: ${dataFile}`); process.exit(1); }
  const fileSize = fs.statSync(dataFile).size;
  console.log(`Loading: ${dataFile} (${(fileSize / 1e9).toFixed(2)} GB)\n`);

  const fileStream = fs.createReadStream(dataFile);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  let colParser = null;
  const contractTracker = new PrimaryContractTracker();
  const rangeTracker = new WelfordTracker(), volumeTracker = new WelfordTracker();

  let currentMinuteKey = null, currentMinuteCandles = [];
  const classifiedBars = [], pendingForwardReturns = [];

  // Rolling minute-bar buffer for forward returns (ALL minutes, not just classified)
  const minuteCloseBuffer = [];
  const MINUTE_BUFFER_SIZE = MAX_HORIZON + 10;
  let curBarHigh = -Infinity, curBarLow = Infinity, curBarClose = 0;

  let totalLines = 0, parsedCandles = 0, skippedCalendarSpread = 0, skippedNonPrimary = 0;
  let skippedDateRange = 0, skippedInvalid = 0;
  let minuteBarsProcessed = 0, minuteBarsClassified = 0, minuteBarsSkippedRange = 0, minuteBarsSkippedSession = 0;
  let lastProgressTime = Date.now();
  const startTime = Date.now();
  const sampleReservoir = [];
  let classifiedCount = 0;

  function flushMinuteBarToBuffer() {
    if (currentMinuteKey !== null && curBarClose !== 0) {
      minuteCloseBuffer.push({ minuteKey: currentMinuteKey, close: curBarClose, high: curBarHigh, low: curBarLow });
      if (minuteCloseBuffer.length > MINUTE_BUFFER_SIZE) minuteCloseBuffer.shift();
    }
  }

  function processAccumulatedMinute() {
    if (currentMinuteCandles.length < 3) return;
    minuteBarsProcessed++;
    const firstCandle = currentMinuteCandles[0];
    const session = getSession(firstCandle.timestamp);

    if (sessionFilter !== 'all' && session !== sessionFilter) { minuteBarsSkippedSession++; return; }

    const features = computeBarFeatures(currentMinuteCandles);
    if (!features) return;

    rangeTracker.update(features.barRange);
    volumeTracker.update(features.totalVolume);
    const rangeZ = rangeTracker.zScore(features.barRange);
    const relativeVolume = volumeTracker.zScore(features.totalVolume);

    if (features.barRange < minRange) { minuteBarsSkippedRange++; return; }

    const { score, rawScore, rangeSignificance, subScores } = computeAbsorptionScore(features, rangeZ);

    // Only keep short signals (positive absorption score = buy absorption = exhaustion short)
    if (score <= 0) return;

    const label = getLabel(score);
    minuteBarsClassified++;
    classifiedCount++;

    const bar = {
      timestamp: new Date(firstCandle.timestamp).toISOString(),
      timestampMs: firstCandle.timestamp,
      minuteKey: currentMinuteKey,
      session,
      day: new Date(firstCandle.timestamp).toISOString().slice(0, 10),
      price: features.barClose,
      open: features.barOpen, high: features.barHigh, low: features.barLow, close: features.barClose,
      volume: features.totalVolume,
      range: +features.barRange.toFixed(2),
      netMove: +features.netMove.toFixed(2),
      closePosition: +features.closePosition.toFixed(4),
      pathEfficiency: +features.pathEfficiency.toFixed(4),
      lowTiming: +features.lowTiming.toFixed(4),
      highTiming: +features.highTiming.toFixed(4),
      dipSpeedAsymmetry: +features.dipSpeedAsymmetry.toFixed(4),
      dipVolumeRatio: +features.dipVolumeRatio.toFixed(4),
      ripVolumeRatio: +features.ripVolumeRatio.toFixed(4),
      vwapPosition: +features.vwapPosition.toFixed(4),
      closeVsVwap: +features.closeVsVwap.toFixed(4),
      pathChoppiness: +features.pathChoppiness.toFixed(4),
      relativeVolume: +relativeVolume.toFixed(2),
      rangeZ: +rangeZ.toFixed(2),
      secondCount: features.secondCount,
      score: +score.toFixed(4),
      rawScore: +rawScore.toFixed(4),
      rangeSignificance: +rangeSignificance.toFixed(2),
      subScores,
      label,
      forwardReturns: {}
    };

    classifiedBars.push(bar);
    pendingForwardReturns.push(bar);

    if (sampleReservoir.length < sampleSize) sampleReservoir.push(bar);
    else { const j = Math.floor(Math.random() * classifiedCount); if (j < sampleSize) sampleReservoir[j] = bar; }
  }

  function resolveForwardReturns() {
    for (let p = pendingForwardReturns.length - 1; p >= 0; p--) {
      const bar = pendingForwardReturns[p];
      let allResolved = true;

      for (const horizon of horizonMinutes) {
        const hKey = `${horizon}m`;
        if (bar.forwardReturns[hKey] !== undefined) continue;

        const startKey = bar.minuteKey + 1, endKey = bar.minuteKey + horizon;
        const closeEntry = minuteCloseBuffer.find(e => e.minuteKey >= endKey);
        if (!closeEntry) { allResolved = false; continue; }

        // For SHORT: MFE = max(entry - low), MAE = max(high - entry) as negative
        let mfe = 0, mae = 0;
        for (const e of minuteCloseBuffer) {
          if (e.minuteKey < startKey) continue;
          if (e.minuteKey > endKey) break;
          const favorable = bar.close - e.low;   // price dropped below entry
          const adverse = -(e.high - bar.close);  // price went above entry (negative)
          if (favorable > mfe) mfe = favorable;
          if (adverse < mae) mae = adverse;
        }

        const rawReturn = closeEntry.close - bar.close;
        const shortReturn = -rawReturn; // short profits when price drops

        bar.forwardReturns[hKey] = {
          points: +rawReturn.toFixed(2),
          shortReturn: +shortReturn.toFixed(2),
          win: shortReturn > 0,
          mfe: +mfe.toFixed(2),
          mae: +mae.toFixed(2)
        };
      }

      if (allResolved) {
      // Build forward path for trailing stop simulation
      if (!bar.forwardPath) {
        bar.forwardPath = [];
        for (const e of minuteCloseBuffer) {
          if (e.minuteKey <= bar.minuteKey) continue;
          if (e.minuteKey > bar.minuteKey + MAX_HORIZON) break;
          bar.forwardPath.push({ offset: e.minuteKey - bar.minuteKey, high: e.high, low: e.low, close: e.close });
        }
      }
      pendingForwardReturns.splice(p, 1);
    }
    }
  }

  for await (const line of rl) {
    if (!colParser) { colParser = getColumnParser(line); continue; }
    totalLines++;

    if (Date.now() - lastProgressTime > 10000) {
      const pct = fileStream.bytesRead ? ((fileStream.bytesRead / fileSize) * 100).toFixed(1) : '?';
      console.log(`  ${pct}% | ${(totalLines / 1e6).toFixed(1)}M lines | ${minuteBarsClassified} short signals | ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
      lastProgressTime = Date.now();
    }

    const parts = line.split(',');
    if (parts.length < colParser.minCols) { skippedInvalid++; continue; }
    const timestamp = new Date(parts[colParser.tsIdx]).getTime();
    if (isNaN(timestamp)) { skippedInvalid++; continue; }
    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) { skippedDateRange++; continue; }
    const symbol = parts[colParser.symbolIdx]?.trim();
    if (symbol && symbol.includes('-')) { skippedCalendarSpread++; continue; }
    const open = parseFloat(parts[colParser.openIdx]), high = parseFloat(parts[colParser.highIdx]);
    const low = parseFloat(parts[colParser.lowIdx]), close = parseFloat(parts[colParser.closeIdx]);
    const volume = parseInt(parts[colParser.volumeIdx]) || 0;
    if (isNaN(open) || isNaN(close)) { skippedInvalid++; continue; }
    const candle = { timestamp, open, high, low, close, volume, symbol };
    if (!contractTracker.processCandle(candle)) { skippedNonPrimary++; continue; }
    parsedCandles++;

    const minuteKey = getMinuteKey(timestamp);
    if (minuteKey !== currentMinuteKey) {
      flushMinuteBarToBuffer();
      processAccumulatedMinute();
      resolveForwardReturns();
      currentMinuteKey = minuteKey;
      currentMinuteCandles = [];
      curBarHigh = -Infinity; curBarLow = Infinity; curBarClose = 0;
    }
    currentMinuteCandles.push(candle);
    if (high > curBarHigh) curBarHigh = high;
    if (low < curBarLow) curBarLow = low;
    curBarClose = close;
  }

  flushMinuteBarToBuffer();
  processAccumulatedMinute();
  resolveForwardReturns();

  for (const bar of pendingForwardReturns) {
    for (const h of horizonMinutes) {
      const hKey = `${h}m`;
      if (!bar.forwardReturns[hKey]) bar.forwardReturns[hKey] = { points: 0, shortReturn: 0, win: false, mfe: 0, mae: 0, incomplete: true };
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nStreaming complete in ${elapsed}s`);
  console.log(`  Lines: ${(totalLines / 1e6).toFixed(2)}M | Primary candles: ${(parsedCandles / 1e6).toFixed(2)}M`);
  console.log(`  Calendar spread: ${(skippedCalendarSpread / 1e6).toFixed(2)}M | Non-primary: ${(skippedNonPrimary / 1e6).toFixed(2)}M | Date range: ${(skippedDateRange / 1e6).toFixed(2)}M`);
  console.log(`  Minute bars: ${minuteBarsProcessed} | Short signals: ${minuteBarsClassified} | Skipped range: ${minuteBarsSkippedRange} | Skipped session: ${minuteBarsSkippedSession}`);

  return { classifiedBars, sampleReservoir };
}

// ============================================================================
// Analysis (shorts only)
// ============================================================================

function analyzeResults(bars) {
  if (!bars.length) { console.log('\nNo signals.'); return {}; }

  console.log('\n' + '='.repeat(80));
  console.log('SHORT SIGNAL ANALYSIS');
  console.log('='.repeat(80));

  // --- Label Distribution ---
  const labels = ['strong_short', 'moderate_short', 'weak_short'];
  const labelCounts = {};
  for (const l of labels) labelCounts[l] = 0;
  for (const b of bars) labelCounts[b.label] = (labelCounts[b.label] || 0) + 1;

  console.log('\n--- Signal Distribution ---');
  for (const l of labels) {
    console.log(`  ${l}: ${labelCounts[l] || 0} (${((labelCounts[l] || 0) / bars.length * 100).toFixed(1)}%)`);
  }

  // --- Per-Day Stats ---
  const dayMap = {};
  for (const b of bars) { if (!dayMap[b.day]) dayMap[b.day] = 0; dayMap[b.day]++; }
  const tradingDays = Object.keys(dayMap).length;
  const dailyCounts = Object.values(dayMap);
  console.log(`\n--- Per-Day Stats (${tradingDays} trading days) ---`);
  console.log(`  Total short signals/day: avg=${(bars.length / tradingDays).toFixed(1)} median=${percentile(dailyCounts, 50).toFixed(0)} p25=${percentile(dailyCounts, 25).toFixed(0)} p75=${percentile(dailyCounts, 75).toFixed(0)}`);

  // --- Helper: compute stats for a group of bars ---
  function groupStats(group, horizon) {
    const hKey = `${horizon}m`;
    const valid = group.filter(b => b.forwardReturns[hKey] && !b.forwardReturns[hKey].incomplete);
    if (valid.length < 10) return null;
    const rets = valid.map(b => b.forwardReturns[hKey].shortReturn);
    const wins = valid.filter(b => b.forwardReturns[hKey].win).length;
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    const med = percentile(rets, 50);
    let gp = 0, gl = 0;
    for (const r of rets) { if (r > 0) gp += r; else gl += Math.abs(r); }
    const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
    const { t, p } = tTest(rets);
    const mfes = valid.map(b => b.forwardReturns[hKey].mfe);
    const maes = valid.map(b => b.forwardReturns[hKey].mae);
    return {
      count: valid.length, winRate: +((wins / valid.length) * 100).toFixed(1),
      avgReturn: +avg.toFixed(2), medianReturn: +med.toFixed(2),
      profitFactor: pf === Infinity ? 'Inf' : +pf.toFixed(2),
      tStat: t, pValue: p,
      avgMfe: +(mfes.reduce((a, b) => a + b, 0) / mfes.length).toFixed(1),
      avgMae: +(maes.reduce((a, b) => a + b, 0) / maes.length).toFixed(1),
      p25: +percentile(rets, 25).toFixed(2), p75: +percentile(rets, 75).toFixed(2)
    };
  }

  // --- Forward Returns by Category ---
  console.log('\n--- Forward Returns by Signal Strength ---');
  const categoryResults = {};
  for (const label of labels) {
    const group = bars.filter(b => b.label === label);
    if (group.length < 10) { categoryResults[label] = { count: group.length }; continue; }
    const result = { count: group.length, horizons: {} };
    const parts = [`  ${label} (n=${group.length})`];
    for (const h of horizonMinutes) {
      const s = groupStats(group, h);
      if (!s) continue;
      result.horizons[`${h}m`] = s;
      const sig = s.pValue < 0.01 ? '**' : s.pValue < 0.05 ? '*' : s.pValue < 0.1 ? '.' : '';
      parts.push(`${h}m: ${s.winRate}%w avg=${s.avgReturn} med=${s.medianReturn} PF=${s.profitFactor} MFE=${s.avgMfe} MAE=${s.avgMae} p=${s.pValue}${sig}`);
    }
    categoryResults[label] = result;
    console.log(parts.join('\n    '));
  }

  // --- Threshold Sweep ---
  const scoreThresholds = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7];
  const rangeThresholds = [10, 15, 20, 25, 30];
  const sweepResults = {};

  for (const horizon of horizonMinutes) {
    const hKey = `${horizon}m`;
    sweepResults[hKey] = [];
    console.log(`\n--- Threshold Sweep: ${hKey} horizon ---`);
    console.log('  score | range |     n | /day  | win%  | avgRet | median |  PF   | MFE   | MAE    | p-val');
    console.log('  ' + '-'.repeat(95));

    for (const st of scoreThresholds) {
      for (const rt of rangeThresholds) {
        const filtered = bars.filter(b => b.score >= st && b.range >= rt);
        const s = groupStats(filtered, horizon);
        if (!s) continue;
        const row = { scoreThreshold: st, rangeMin: rt, ...s };
        sweepResults[hKey].push(row);
        const sig = s.pValue < 0.01 ? ' **' : s.pValue < 0.05 ? ' *' : s.pValue < 0.1 ? ' .' : '';
        const pfStr = s.profitFactor === 'Inf' ? '  Inf' : String(s.profitFactor).padStart(5);
        console.log(`  ${String(st).padStart(5)} | ${String(rt).padStart(5)} | ${String(s.count).padStart(5)} | ${(s.count / tradingDays).toFixed(1).padStart(5)} | ${String(s.winRate).padStart(5)}% | ${String(s.avgReturn).padStart(6)} | ${String(s.medianReturn).padStart(6)} | ${pfStr} | ${String(s.avgMfe).padStart(5)} | ${String(s.avgMae).padStart(6)} | ${s.pValue.toFixed(4)}${sig}`);
      }
    }
  }

  // --- Score-Return Correlations ---
  console.log('\n--- Score vs Short Return Correlations ---');
  const correlations = {};
  for (const h of horizonMinutes) {
    const hKey = `${h}m`;
    const valid = bars.filter(b => b.forwardReturns[hKey] && !b.forwardReturns[hKey].incomplete);
    if (valid.length < 20) continue;
    const r = pearsonR(valid.map(b => b.score), valid.map(b => b.forwardReturns[hKey].shortReturn));
    correlations[hKey] = +r.toFixed(4);
    console.log(`  ${hKey}: r = ${r.toFixed(4)} (n=${valid.length})`);
  }

  // --- Feature Quintile Analysis ---
  const quintileHorizon = '1m';
  console.log(`\n--- Feature Quintile Analysis (${quintileHorizon} short return) ---`);
  const featureNames = [
    'closePosition', 'pathEfficiency', 'lowTiming', 'highTiming',
    'dipSpeedAsymmetry', 'dipVolumeRatio', 'ripVolumeRatio',
    'vwapPosition', 'closeVsVwap', 'pathChoppiness', 'relativeVolume', 'rangeZ',
    'range', 'netMove', 'score'
  ];
  const featureQuintiles = {};

  for (const feat of featureNames) {
    const valid = bars.filter(b => b[feat] !== undefined && !isNaN(b[feat]) && b.forwardReturns[quintileHorizon] && !b.forwardReturns[quintileHorizon].incomplete);
    if (valid.length < 50) continue;
    const values = valid.map(b => b[feat]).sort((a, b) => a - b);
    const q20 = percentile(values, 20), q40 = percentile(values, 40), q60 = percentile(values, 60), q80 = percentile(values, 80);
    const quintBounds = [
      { label: 'Q1', test: v => v <= q20 }, { label: 'Q2', test: v => v > q20 && v <= q40 },
      { label: 'Q3', test: v => v > q40 && v <= q60 }, { label: 'Q4', test: v => v > q60 && v <= q80 },
      { label: 'Q5', test: v => v > q80 }
    ];
    featureQuintiles[feat] = { boundaries: { q20: +q20.toFixed(4), q40: +q40.toFixed(4), q60: +q60.toFixed(4), q80: +q80.toFixed(4) }, quintiles: {} };

    const parts = [`  ${feat}:`];
    for (const q of quintBounds) {
      const group = valid.filter(b => q.test(b[feat]));
      if (group.length < 5) continue;
      const rets = group.map(b => b.forwardReturns[quintileHorizon].shortReturn);
      const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
      const wins = group.filter(b => b.forwardReturns[quintileHorizon].win).length;
      featureQuintiles[feat].quintiles[q.label] = {
        count: group.length, avgShortReturn: +avg.toFixed(2),
        winRate: +((wins / group.length) * 100).toFixed(1)
      };
      parts.push(`${q.label}(n=${group.length}): ret=${avg.toFixed(1)} win=${((wins / group.length) * 100).toFixed(0)}%`);
    }
    console.log(parts.join(' '));
  }

  // --- Score Distribution ---
  const scores = bars.map(b => b.score);
  const scoreDist = {
    mean: +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4),
    median: +percentile(scores, 50).toFixed(4),
    stddev: +Math.sqrt(scores.reduce((s, v) => s + (v - scores.reduce((a, b) => a + b, 0) / scores.length) ** 2, 0) / (scores.length - 1)).toFixed(4),
    p5: +percentile(scores, 5).toFixed(4), p95: +percentile(scores, 95).toFixed(4)
  };
  console.log(`\n--- Absorption Score Distribution (short signals only, all > 0) ---`);
  console.log(`  mean=${scoreDist.mean} median=${scoreDist.median} std=${scoreDist.stddev} p5=${scoreDist.p5} p95=${scoreDist.p95}`);

  return { labelDistribution: labelCounts, perDayStats: { tradingDays, avgPerDay: +(bars.length / tradingDays).toFixed(1) },
    categoryResults, sweepResults, correlations, featureQuintiles, scoreDistribution: scoreDist };
}

// ============================================================================
// Scalp Optimization: Feature Filters + Trailing Stop Simulation
// ============================================================================

function simulateExit(bar, initialStop, trailTrigger, trailOffset, maxBars) {
  const entry = bar.close;
  let currentStop = entry + initialStop; // above entry for short
  let bestPrice = entry;
  let trailActive = false;

  for (const p of (bar.forwardPath || [])) {
    if (p.offset > maxBars) break;

    // Check stop first (conservative — if both stop and target in same bar, count stop)
    if (p.high >= currentStop) {
      const pnl = -(currentStop - entry);
      return { pnl: +pnl.toFixed(2), exit: 'stop', bars: p.offset };
    }

    // Update best price (lowest for short = most favorable)
    if (p.low < bestPrice) bestPrice = p.low;
    const profit = entry - bestPrice;

    // Activate trailing: move to breakeven, then trail
    if (!trailActive && profit >= trailTrigger) {
      currentStop = entry; // breakeven
      trailActive = true;
    }

    if (trailActive) {
      const trailStop = bestPrice + trailOffset;
      if (trailStop < currentStop) currentStop = trailStop;

      // Check if trailing stop hit within this bar
      if (p.high >= currentStop) {
        const pnl = entry - currentStop;
        return { pnl: +pnl.toFixed(2), exit: 'trail', bars: p.offset };
      }
    }
  }

  // Time exit at last available bar
  const lastBar = (bar.forwardPath || []).filter(p => p.offset <= maxBars).pop();
  if (lastBar) {
    const pnl = entry - lastBar.close;
    return { pnl: +pnl.toFixed(2), exit: 'time', bars: lastBar.offset };
  }
  return { pnl: 0, exit: 'no_data', bars: 0 };
}

function scalpOptimization(bars, tradingDays) {
  console.log('\n' + '='.repeat(80));
  console.log('SCALP OPTIMIZATION: 1m Fast Exit + Trailing Stop');
  console.log('='.repeat(80));

  function quickStats(group, hKey) {
    const valid = group.filter(b => b.forwardReturns[hKey] && !b.forwardReturns[hKey].incomplete);
    if (valid.length < 10) return null;
    const rets = valid.map(b => b.forwardReturns[hKey].shortReturn);
    const wins = valid.filter(b => b.forwardReturns[hKey].win).length;
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    const med = percentile(rets, 50);
    let gp = 0, gl = 0;
    for (const r of rets) { if (r > 0) gp += r; else gl += Math.abs(r); }
    const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
    const { p } = tTest(rets);
    const mfes = valid.map(b => b.forwardReturns[hKey].mfe);
    const maes = valid.map(b => b.forwardReturns[hKey].mae);
    return {
      n: valid.length, winRate: +((wins / valid.length) * 100).toFixed(1),
      avg: +avg.toFixed(2), med: +med.toFixed(2),
      pf: pf === Infinity ? 'Inf' : +pf.toFixed(2), p: +p.toFixed(4),
      avgMfe: +(mfes.reduce((a, b) => a + b, 0) / mfes.length).toFixed(1),
      avgMae: +(maes.reduce((a, b) => a + b, 0) / maes.length).toFixed(1),
      perDay: +(valid.length / tradingDays).toFixed(1)
    };
  }

  // ---- 1. Fine score threshold sweep at 1m ----
  console.log('\n--- Fine Score Thresholds at 1m (range >= 10) ---');
  console.log('  score |   n | /day | win% |   avg | med  |  PF  | MFE  | MAE   | p-val');
  console.log('  ' + '-'.repeat(78));
  const fineScores = [0.55, 0.58, 0.60, 0.62, 0.64, 0.65, 0.66, 0.68, 0.70, 0.72, 0.74, 0.76, 0.78, 0.80];
  const fineResults = [];
  for (const sc of fineScores) {
    const grp = bars.filter(b => b.score >= sc);
    const s = quickStats(grp, '1m');
    if (!s) continue;
    fineResults.push({ score: sc, ...s });
    const sig = s.p < 0.01 ? ' **' : s.p < 0.05 ? ' *' : s.p < 0.1 ? ' .' : '';
    console.log(`  ${sc.toFixed(2).padStart(5)} | ${String(s.n).padStart(3)} | ${s.perDay.toFixed(1).padStart(4)} | ${String(s.winRate).padStart(4)}% | ${String(s.avg).padStart(5)} | ${String(s.med).padStart(4)} | ${String(s.pf).padStart(4)} | ${String(s.avgMfe).padStart(4)} | ${String(s.avgMae).padStart(5)} | ${s.p.toFixed(4)}${sig}`);
  }

  const bestFine = fineResults.filter(r => r.n >= 30).sort((a, b) => a.p - b.p)[0];
  const bestThreshold = bestFine ? bestFine.score : 0.70;
  console.log(`\n  Best threshold: >= ${bestThreshold} (n=${bestFine?.n}, p=${bestFine?.p})`);

  const elite = bars.filter(b => b.score >= bestThreshold);
  if (elite.length < 20) { console.log('  Not enough signals.'); return { fineResults, bestThreshold }; }

  // ---- 2. Feature binary splits ----
  console.log(`\n--- Feature Splits within score >= ${bestThreshold} (n=${elite.length}, 1m horizon) ---`);
  console.log('  feature             | split  | above: n  win%    avg | below: n  win%    avg | delta');
  console.log('  ' + '-'.repeat(90));

  const splitFeatures = [
    'relativeVolume', 'rangeZ', 'pathChoppiness', 'closePosition', 'pathEfficiency',
    'lowTiming', 'highTiming', 'dipSpeedAsymmetry', 'dipVolumeRatio', 'ripVolumeRatio',
    'vwapPosition', 'closeVsVwap', 'range', 'volume', 'netMove'
  ];

  const featureSplitResults = {};
  for (const feat of splitFeatures) {
    const vals = elite.map(b => b[feat]).filter(v => v !== undefined && !isNaN(v));
    if (vals.length < 20) continue;
    const med = percentile(vals.sort((a, b) => a - b), 50);
    const above = elite.filter(b => b[feat] > med);
    const below = elite.filter(b => b[feat] <= med);
    const sAbove = quickStats(above, '1m');
    const sBelow = quickStats(below, '1m');
    if (!sAbove || !sBelow) continue;
    const delta = sAbove.avg - sBelow.avg;
    featureSplitResults[feat] = { median: +med.toFixed(4), above: sAbove, below: sBelow, delta: +delta.toFixed(2) };
    const arrow = delta > 1 ? ' ^' : delta < -1 ? ' v' : '';
    console.log(`  ${feat.padEnd(20)} | ${med.toFixed(2).padStart(6)} | ${String(sAbove.n).padStart(4)} ${String(sAbove.winRate).padStart(5)}% ${String(sAbove.avg).padStart(6)} | ${String(sBelow.n).padStart(4)} ${String(sBelow.winRate).padStart(5)}% ${String(sBelow.avg).padStart(6)} | ${delta > 0 ? '+' : ''}${delta.toFixed(2)}${arrow}`);
  }

  const rankedFeatures = Object.entries(featureSplitResults)
    .map(([f, r]) => ({ feature: f, delta: r.delta, median: r.median }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  console.log('\n  Ranked by 1m impact:');
  for (const rf of rankedFeatures.slice(0, 5)) {
    const dir = rf.delta > 0 ? 'above' : 'below';
    console.log(`    ${rf.feature}: keep ${dir} ${rf.median.toFixed(2)} -> ${rf.delta > 0 ? '+' : ''}${rf.delta.toFixed(2)} pts/trade`);
  }

  // ---- 3. Feature combo filters ----
  const topN = Math.min(4, rankedFeatures.length);
  const filterDefs = rankedFeatures.slice(0, topN).map(rf => ({
    name: rf.feature,
    short: rf.feature.length > 14 ? rf.feature.slice(0, 14) : rf.feature,
    fn: rf.delta > 0 ? (b => b[rf.feature] > rf.median) : (b => b[rf.feature] <= rf.median),
    dir: rf.delta > 0 ? '>' : '<=', median: rf.median
  }));

  console.log(`\n--- Feature Combo Filters at 1m (score >= ${bestThreshold}) ---`);
  console.log('  combo                                  |   n | /day | win% |   avg |  PF  | p-val');
  console.log('  ' + '-'.repeat(84));

  const baseS = quickStats(elite, '1m');
  if (baseS) {
    const sig = baseS.p < 0.01 ? ' **' : baseS.p < 0.05 ? ' *' : baseS.p < 0.1 ? ' .' : '';
    console.log(`  ${'(baseline: score only)'.padEnd(39)} | ${String(baseS.n).padStart(3)} | ${baseS.perDay.toFixed(1).padStart(4)} | ${String(baseS.winRate).padStart(4)}% | ${String(baseS.avg).padStart(5)} | ${String(baseS.pf).padStart(4)} | ${baseS.p.toFixed(4)}${sig}`);
  }

  const comboResults = [];
  for (const fd of filterDefs) {
    const filtered = elite.filter(fd.fn);
    const s = quickStats(filtered, '1m');
    if (!s) continue;
    const sig = s.p < 0.01 ? ' **' : s.p < 0.05 ? ' *' : s.p < 0.1 ? ' .' : '';
    const label = `+ ${fd.name} ${fd.dir} ${fd.median.toFixed(1)}`;
    console.log(`  ${label.padEnd(39)} | ${String(s.n).padStart(3)} | ${s.perDay.toFixed(1).padStart(4)} | ${String(s.winRate).padStart(4)}% | ${String(s.avg).padStart(5)} | ${String(s.pf).padStart(4)} | ${s.p.toFixed(4)}${sig}`);
    comboResults.push({ label, ...s });
  }

  if (filterDefs.length >= 2) {
    console.log('  --- pairs ---');
    for (let i = 0; i < Math.min(4, filterDefs.length); i++) {
      for (let j = i + 1; j < Math.min(4, filterDefs.length); j++) {
        const filtered = elite.filter(b => filterDefs[i].fn(b) && filterDefs[j].fn(b));
        const s = quickStats(filtered, '1m');
        if (!s) continue;
        const sig = s.p < 0.01 ? ' **' : s.p < 0.05 ? ' *' : s.p < 0.1 ? ' .' : '';
        const label = `+ ${filterDefs[i].short} + ${filterDefs[j].short}`;
        console.log(`  ${label.padEnd(39)} | ${String(s.n).padStart(3)} | ${s.perDay.toFixed(1).padStart(4)} | ${String(s.winRate).padStart(4)}% | ${String(s.avg).padStart(5)} | ${String(s.pf).padStart(4)} | ${s.p.toFixed(4)}${sig}`);
        comboResults.push({ label, ...s });
      }
    }
  }

  if (filterDefs.length >= 3) {
    console.log('  --- triples ---');
    for (let i = 0; i < Math.min(3, filterDefs.length); i++) {
      for (let j = i + 1; j < Math.min(3, filterDefs.length); j++) {
        for (let k = j + 1; k < Math.min(3, filterDefs.length); k++) {
          const filtered = elite.filter(b => filterDefs[i].fn(b) && filterDefs[j].fn(b) && filterDefs[k].fn(b));
          const s = quickStats(filtered, '1m');
          if (!s) continue;
          const sig = s.p < 0.01 ? ' **' : s.p < 0.05 ? ' *' : s.p < 0.1 ? ' .' : '';
          const label = `+ ${filterDefs[i].short} + ${filterDefs[j].short} + ${filterDefs[k].short}`;
          console.log(`  ${label.padEnd(39)} | ${String(s.n).padStart(3)} | ${s.perDay.toFixed(1).padStart(4)} | ${String(s.winRate).padStart(4)}% | ${String(s.avg).padStart(5)} | ${String(s.pf).padStart(4)} | ${s.p.toFixed(4)}${sig}`);
          comboResults.push({ label, ...s });
        }
      }
    }
  }

  // ---- 4. MFE/MAE distributions at each horizon ----
  console.log(`\n--- MFE/MAE Distributions (score >= ${bestThreshold}) ---`);
  const mfeResults = {};
  for (const h of horizonMinutes) {
    const hKey = `${h}m`;
    const valid = elite.filter(b => b.forwardReturns[hKey] && !b.forwardReturns[hKey].incomplete);
    if (valid.length < 10) continue;
    const mfes = valid.map(b => b.forwardReturns[hKey].mfe).sort((a, b) => a - b);
    const maes = valid.map(b => Math.abs(b.forwardReturns[hKey].mae)).sort((a, b) => a - b);
    mfeResults[hKey] = {
      mfe: { p10: +percentile(mfes, 10).toFixed(1), p25: +percentile(mfes, 25).toFixed(1), p50: +percentile(mfes, 50).toFixed(1), p75: +percentile(mfes, 75).toFixed(1), p90: +percentile(mfes, 90).toFixed(1) },
      mae: { p10: +percentile(maes, 10).toFixed(1), p25: +percentile(maes, 25).toFixed(1), p50: +percentile(maes, 50).toFixed(1), p75: +percentile(maes, 75).toFixed(1), p90: +percentile(maes, 90).toFixed(1) }
    };
    console.log(`  ${hKey} (n=${valid.length}):`);
    console.log(`    MFE: p10=${mfeResults[hKey].mfe.p10} p25=${mfeResults[hKey].mfe.p25} p50=${mfeResults[hKey].mfe.p50} p75=${mfeResults[hKey].mfe.p75} p90=${mfeResults[hKey].mfe.p90}`);
    console.log(`    MAE: p10=${mfeResults[hKey].mae.p10} p25=${mfeResults[hKey].mae.p25} p50=${mfeResults[hKey].mae.p50} p75=${mfeResults[hKey].mae.p75} p90=${mfeResults[hKey].mae.p90}`);
  }

  // ---- 5. Fixed stop/target expectancy grid ----
  const gridHorizon = horizonMinutes.includes(5) ? '5m' : `${horizonMinutes[horizonMinutes.length - 1]}m`;
  const gridBars = elite.filter(b => b.forwardReturns[gridHorizon] && !b.forwardReturns[gridHorizon].incomplete);

  let bestGridResult = null;
  if (gridBars.length >= 20) {
    console.log(`\n--- Fixed Stop/Target Grid (${gridHorizon} max hold, n=${gridBars.length}) ---`);
    console.log('  (pts/trade, conservative: ambiguous bars = stop-out)');
    const stops = [2, 3, 4, 5, 6, 8, 10, 12];
    const targets = [2, 3, 4, 5, 6, 8, 10, 12];
    console.log('         ' + targets.map(t => `  T=${t}`.padStart(7)).join(''));
    const gridResults = [];
    let bestExp = -Infinity;

    for (const stop of stops) {
      const row = [`  S=${String(stop).padStart(2)} |`];
      for (const target of targets) {
        let totalReturn = 0, wins = 0;
        for (const b of gridBars) {
          const fr = b.forwardReturns[gridHorizon];
          const mfe = fr.mfe, mae = Math.abs(fr.mae);
          const stopHit = mae >= stop, targetHit = mfe >= target;
          if (targetHit && !stopHit) { totalReturn += target; wins++; }
          else if (stopHit && !targetHit) { totalReturn -= stop; }
          else if (stopHit && targetHit) { totalReturn -= stop; }
          else { totalReturn += fr.shortReturn; if (fr.shortReturn > 0) wins++; }
        }
        const exp = totalReturn / gridBars.length;
        const wr = wins / gridBars.length * 100;
        gridResults.push({ stop, target, exp: +exp.toFixed(2), wr: +wr.toFixed(1) });
        if (exp > bestExp) { bestExp = exp; bestGridResult = { stop, target, exp: +exp.toFixed(2), wr: +wr.toFixed(1) }; }
        row.push((exp >= 0 ? `+${exp.toFixed(1)}` : exp.toFixed(1)).padStart(7));
      }
      console.log(row.join(''));
    }
    if (bestGridResult) console.log(`\n  Best fixed: S=${bestGridResult.stop} T=${bestGridResult.target} -> ${bestGridResult.exp} pts/trade, ${bestGridResult.wr}% win`);
  }

  // ---- 6. Trailing stop simulation ----
  const trailBars = elite.filter(b => b.forwardPath && b.forwardPath.length > 0);
  if (trailBars.length >= 20) {
    console.log(`\n--- Trailing Stop Simulation (n=${trailBars.length}) ---`);
    console.log('  Entry at signal bar close. Stop moves to breakeven at trigger, then trails.');
    console.log('  initStop | trigger | trailOff | maxBars |   n | win% |   avg |  med  |  PF  | exit distribution');
    console.log('  ' + '-'.repeat(100));

    const initStops = [3, 4, 5, 6, 8, 10];
    const triggers = [2, 3, 4, 5];
    const trailOffsets = [2, 3, 4];
    const maxHolds = [3, 5];
    const trailResults = [];

    for (const maxBars of maxHolds) {
      for (const initStop of initStops) {
        for (const trigger of triggers) {
          if (trigger >= initStop) continue; // trigger must be less than stop
          for (const trailOff of trailOffsets) {
            const outcomes = trailBars.map(b => simulateExit(b, initStop, trigger, trailOff, maxBars));
            const pnls = outcomes.map(o => o.pnl);
            const wins = pnls.filter(p => p > 0).length;
            const avg = pnls.reduce((a, b) => a + b, 0) / pnls.length;
            const med = percentile(pnls.sort((a, b) => a - b), 50);
            let gp = 0, gl = 0;
            for (const p of pnls) { if (p > 0) gp += p; else gl += Math.abs(p); }
            const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
            const exits = { stop: 0, trail: 0, time: 0 };
            for (const o of outcomes) exits[o.exit] = (exits[o.exit] || 0) + 1;

            trailResults.push({ initStop, trigger, trailOff, maxBars, n: pnls.length,
              winRate: +((wins / pnls.length) * 100).toFixed(1), avg: +avg.toFixed(2), med: +med.toFixed(2),
              pf: pf === Infinity ? 'Inf' : +pf.toFixed(2), exits });

            if (avg > 0.5 || (initStop <= 5 && maxBars <= 3)) { // only show interesting rows
              const pfStr = pf === Infinity ? '  Inf' : pf.toFixed(2).padStart(5);
              const exitDist = `S=${exits.stop || 0} T=${exits.trail || 0} X=${exits.time || 0}`;
              console.log(`  ${String(initStop).padStart(8)} | ${String(trigger).padStart(7)} | ${String(trailOff).padStart(8)} | ${String(maxBars).padStart(7)} | ${String(pnls.length).padStart(3)} | ${((wins / pnls.length) * 100).toFixed(1).padStart(4)}% | ${avg.toFixed(2).padStart(5)} | ${med.toFixed(2).padStart(5)} | ${pfStr} | ${exitDist}`);
            }
          }
        }
      }
    }

    // Find best trailing config
    const bestTrail = trailResults.sort((a, b) => b.avg - a.avg)[0];
    if (bestTrail) {
      console.log(`\n  Best trailing: stop=${bestTrail.initStop} trigger=${bestTrail.trigger} trail=${bestTrail.trailOff} hold=${bestTrail.maxBars}m`);
      console.log(`    -> ${bestTrail.avg} pts/trade, ${bestTrail.winRate}% win, PF=${bestTrail.pf}`);
      console.log(`    Exits: stopped=${bestTrail.exits.stop} trailed=${bestTrail.exits.trail} timed=${bestTrail.exits.time}`);
    }

    // ---- 7. Best trailing config with feature filters ----
    if (bestTrail && filterDefs.length > 0) {
      console.log(`\n--- Trailing Stop + Feature Filters ---`);
      console.log('  combo                                  |   n | /day | win% |   avg |  PF  | exits');
      console.log('  ' + '-'.repeat(84));

      // Baseline with best trail params
      const baseOutcomes = trailBars.map(b => simulateExit(b, bestTrail.initStop, bestTrail.trigger, bestTrail.trailOff, bestTrail.maxBars));
      const basePnls = baseOutcomes.map(o => o.pnl);
      const baseWins = basePnls.filter(p => p > 0).length;
      const baseAvg = basePnls.reduce((a, b) => a + b, 0) / basePnls.length;
      let bgp = 0, bgl = 0;
      for (const p of basePnls) { if (p > 0) bgp += p; else bgl += Math.abs(p); }
      const bExits = {};
      for (const o of baseOutcomes) bExits[o.exit] = (bExits[o.exit] || 0) + 1;
      console.log(`  ${'(baseline: score only)'.padEnd(39)} | ${String(basePnls.length).padStart(3)} | ${(basePnls.length / tradingDays).toFixed(1).padStart(4)} | ${((baseWins / basePnls.length) * 100).toFixed(1).padStart(4)}% | ${baseAvg.toFixed(2).padStart(5)} | ${(bgl > 0 ? bgp / bgl : 0).toFixed(2).padStart(4)} | S=${bExits.stop || 0} T=${bExits.trail || 0} X=${bExits.time || 0}`);

      // Apply each feature filter
      for (const fd of filterDefs) {
        const filtered = trailBars.filter(fd.fn);
        if (filtered.length < 10) continue;
        const outcomes = filtered.map(b => simulateExit(b, bestTrail.initStop, bestTrail.trigger, bestTrail.trailOff, bestTrail.maxBars));
        const pnls = outcomes.map(o => o.pnl);
        const wins = pnls.filter(p => p > 0).length;
        const avg = pnls.reduce((a, b) => a + b, 0) / pnls.length;
        let gp = 0, gl = 0;
        for (const p of pnls) { if (p > 0) gp += p; else gl += Math.abs(p); }
        const exits = {};
        for (const o of outcomes) exits[o.exit] = (exits[o.exit] || 0) + 1;
        const label = `+ ${fd.name} ${fd.dir} ${fd.median.toFixed(1)}`;
        console.log(`  ${label.padEnd(39)} | ${String(pnls.length).padStart(3)} | ${(pnls.length / tradingDays).toFixed(1).padStart(4)} | ${((wins / pnls.length) * 100).toFixed(1).padStart(4)}% | ${avg.toFixed(2).padStart(5)} | ${(gl > 0 ? gp / gl : 0).toFixed(2).padStart(4)} | S=${exits.stop || 0} T=${exits.trail || 0} X=${exits.time || 0}`);
      }

      // Pairs
      if (filterDefs.length >= 2) {
        for (let i = 0; i < Math.min(4, filterDefs.length); i++) {
          for (let j = i + 1; j < Math.min(4, filterDefs.length); j++) {
            const filtered = trailBars.filter(b => filterDefs[i].fn(b) && filterDefs[j].fn(b));
            if (filtered.length < 10) continue;
            const outcomes = filtered.map(b => simulateExit(b, bestTrail.initStop, bestTrail.trigger, bestTrail.trailOff, bestTrail.maxBars));
            const pnls = outcomes.map(o => o.pnl);
            const wins = pnls.filter(p => p > 0).length;
            const avg = pnls.reduce((a, b) => a + b, 0) / pnls.length;
            let gp = 0, gl = 0;
            for (const p of pnls) { if (p > 0) gp += p; else gl += Math.abs(p); }
            const exits = {};
            for (const o of outcomes) exits[o.exit] = (exits[o.exit] || 0) + 1;
            const label = `+ ${filterDefs[i].short} + ${filterDefs[j].short}`;
            console.log(`  ${label.padEnd(39)} | ${String(pnls.length).padStart(3)} | ${(pnls.length / tradingDays).toFixed(1).padStart(4)} | ${((wins / pnls.length) * 100).toFixed(1).padStart(4)}% | ${avg.toFixed(2).padStart(5)} | ${(gl > 0 ? gp / gl : 0).toFixed(2).padStart(4)} | S=${exits.stop || 0} T=${exits.trail || 0} X=${exits.time || 0}`);
          }
        }
      }
    }
  }

  // ---- Summary ----
  console.log('\n--- Scalp Configuration Summary ---');
  console.log(`  Score threshold: >= ${bestThreshold}`);
  console.log(`  Signal frequency: ~${(elite.length / tradingDays).toFixed(1)}/day`);
  if (rankedFeatures.length > 0) {
    const top = rankedFeatures[0];
    console.log(`  Top feature filter: ${top.feature} ${top.delta > 0 ? '>' : '<='} ${top.median.toFixed(2)}`);
  }
  if (bestGridResult) console.log(`  Best fixed exit: S=${bestGridResult.stop} T=${bestGridResult.target} -> ${bestGridResult.exp} pts/trade`);

  return { fineResults, bestThreshold, featureSplitResults: Object.fromEntries(
    Object.entries(featureSplitResults).map(([k, v]) => [k, { median: v.median, delta: v.delta }])
  ), rankedFeatures: rankedFeatures.slice(0, 6), mfeResults, bestGrid: bestGridResult };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { classifiedBars, sampleReservoir } = await runAnalysis();
  const analysis = analyzeResults(classifiedBars);
  const td = analysis.perDayStats?.tradingDays || 1;
  const scalpAnalysis = scalpOptimization(classifiedBars, td);

  const results = {
    metadata: {
      ticker: 'NQ', model: 'exhaustion_shorts_scalp',
      startDate: startDateStr, endDate: endDateStr,
      totalShortSignals: classifiedBars.length,
      parameters: { strongThreshold, moderateThreshold, horizonMinutes, minRange, sessionFilter },
      generatedAt: new Date().toISOString()
    },
    ...analysis,
    scalpOptimization: scalpAnalysis,
    sampleBars: sampleReservoir.map(b => ({
      timestamp: b.timestamp, session: b.session, day: b.day, label: b.label,
      open: b.open, high: b.high, low: b.low, close: b.close,
      volume: b.volume, range: b.range, netMove: b.netMove,
      closePosition: b.closePosition, pathEfficiency: b.pathEfficiency,
      lowTiming: b.lowTiming, highTiming: b.highTiming,
      dipSpeedAsymmetry: b.dipSpeedAsymmetry, dipVolumeRatio: b.dipVolumeRatio,
      ripVolumeRatio: b.ripVolumeRatio, vwapPosition: b.vwapPosition,
      closeVsVwap: b.closeVsVwap, pathChoppiness: b.pathChoppiness,
      relativeVolume: b.relativeVolume, rangeZ: b.rangeZ,
      score: b.score, subScores: b.subScores,
      forwardReturns: b.forwardReturns
    }))
  };

  const outDir = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outputPath}`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
