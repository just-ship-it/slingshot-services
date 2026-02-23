#!/usr/bin/env node
/**
 * Momentum Microstructure Analysis: 1-Second Candle Velocity & Continuation
 *
 * Detects momentum ignition from 1-second candle microstructure in ES and NQ futures.
 * Within a 1m/5m candle, the 1-second data reveals whether a move has "conviction" —
 * volume acceleration + directional efficiency + strong close position predicts
 * continuation into subsequent candles.
 *
 * Uses only OHLCV data — no GEX, no OFI — giving 5 full years (Jan 2021 – Jan 2026).
 *
 * Architecture: Streaming pipeline with bounded rolling window (<50MB memory).
 *
 * Usage:
 *   node scripts/es-nq-momentum-microstructure.js [options]
 *
 * Options:
 *   --ticker ES|NQ              Ticker symbol (default: ES)
 *   --start YYYY-MM-DD          Start date (default: 2021-01-01)
 *   --end YYYY-MM-DD            End date (default: 2026-01-31)
 *   --velocity-threshold N      Min pts/sec for velocity (default: auto per ticker)
 *   --volume-ratio N            Volume surge vs 300s baseline (default: 2.0)
 *   --efficiency-threshold N    Min move efficiency 0-1 (default: 0.6)
 *   --cooldown N                Seconds between events (default: 30)
 *   --windows N,N,N             Window sizes in seconds (default: 15,30,60)
 *   --grid-search               Run threshold grid search (slower)
 *   --output FILE               Output JSON path
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
};
const hasFlag = (name) => args.includes(`--${name}`);

const ticker = (getArg('ticker', 'ES')).toUpperCase();
const startDateStr = getArg('start', '2021-01-01');
const endDateStr = getArg('end', '2026-01-31');
const gridSearch = hasFlag('grid-search');

const VELOCITY_DEFAULTS = { ES: 0.5, NQ: 2.0 };
const velocityThreshold = parseFloat(getArg('velocity-threshold', VELOCITY_DEFAULTS[ticker] || 0.5));
const volumeRatioThreshold = parseFloat(getArg('volume-ratio', '2.0'));
const efficiencyThreshold = parseFloat(getArg('efficiency-threshold', '0.6'));
const cooldownSeconds = parseInt(getArg('cooldown', '30'));
const windowSizes = getArg('windows', '15,30,60').split(',').map(Number);

const defaultOutput = `results/momentum-microstructure/${ticker}-results.json`;
const outputPath = getArg('output', defaultOutput);

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

// Forward return horizons in seconds
const FORWARD_HORIZONS = [30, 60, 120, 300, 600];
const MAX_FORWARD = Math.max(...FORWARD_HORIZONS);
const BASELINE_WINDOW = 300; // 300s rolling baseline for volume rate
const MAX_WINDOW = Math.max(...windowSizes);
const ROLLING_BUFFER_SIZE = Math.max(MAX_WINDOW, BASELINE_WINDOW, MAX_FORWARD) + 60; // extra padding

console.log('='.repeat(80));
console.log('MOMENTUM MICROSTRUCTURE ANALYSIS: 1-Second Candle Velocity & Continuation');
console.log('='.repeat(80));
console.log(`Ticker: ${ticker}`);
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log(`Windows: ${windowSizes.join('s, ')}s`);
console.log(`Velocity threshold: ${velocityThreshold} pts/s`);
console.log(`Volume ratio threshold: ${volumeRatioThreshold}x`);
console.log(`Efficiency threshold: ${efficiencyThreshold}`);
console.log(`Cooldown: ${cooldownSeconds}s`);
console.log(`Grid search: ${gridSearch ? 'YES' : 'no'}`);
console.log();

// ============================================================================
// Data File Resolution
// ============================================================================

function getDataFilePath() {
  if (ticker === 'ES') {
    // ES uses continuous (back-adjusted) file — no contract filtering needed
    return path.join(dataDir, 'ohlcv/es/ES_ohlcv_1s_continuous.csv');
  }
  // NQ uses raw file — needs calendar spread + primary contract filtering
  return path.join(dataDir, 'ohlcv/nq/NQ_ohlcv_1s.csv');
}

function getColumnParser(headerLine) {
  const cols = headerLine.split(',').map(c => c.trim());
  const idx = {};
  cols.forEach((name, i) => { idx[name] = i; });

  // ES continuous: ts_event,open,high,low,close,volume,symbol,contract
  // NQ raw: ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
  return {
    tsIdx: idx['ts_event'] ?? 0,
    openIdx: idx['open'],
    highIdx: idx['high'],
    lowIdx: idx['low'],
    closeIdx: idx['close'],
    volumeIdx: idx['volume'],
    symbolIdx: idx['symbol'],
    contractIdx: idx['contract'], // only ES continuous
    minCols: Math.max(idx['open'], idx['high'], idx['low'], idx['close'], idx['volume'], idx['symbol']) + 1
  };
}

// ============================================================================
// Session Detection
// ============================================================================

function getSession(timestampMs) {
  const date = new Date(timestampMs);
  const timeMin = date.getUTCHours() * 60 + date.getUTCMinutes();
  // EST = UTC-5; 9:30 EST = 14:30 UTC = 870min, 16:00 EST = 21:00 UTC = 1260min
  if (timeMin >= 870 && timeMin < 1260) return 'rth';
  if (timeMin >= 780 && timeMin < 870) return 'premarket';
  if (timeMin >= 1260 && timeMin < 1380) return 'afterhours';
  return 'overnight';
}

function get30minBucket(timestampMs) {
  const date = new Date(timestampMs);
  const h = date.getUTCHours();
  const m = date.getUTCMinutes() < 30 ? '00' : '30';
  return `${String(h).padStart(2, '0')}:${m}`;
}

// ============================================================================
// Welford's Online Algorithm for Rolling Z-Scores
// ============================================================================

class WelfordTracker {
  constructor() {
    this.n = 0;
    this.mean = 0;
    this.M2 = 0;
  }

  update(value) {
    this.n++;
    const delta = value - this.mean;
    this.mean += delta / this.n;
    const delta2 = value - this.mean;
    this.M2 += delta * delta2;
  }

  get variance() {
    return this.n < 2 ? 0 : this.M2 / (this.n - 1);
  }

  get stddev() {
    return Math.sqrt(this.variance);
  }

  zScore(value) {
    const sd = this.stddev;
    if (sd === 0 || this.n < 30) return 0;
    return (value - this.mean) / sd;
  }
}

// ============================================================================
// NQ Primary Contract Tracker (adaptive per-hour)
// ============================================================================

class PrimaryContractTracker {
  constructor() {
    this.currentHour = null;
    this.hourVolumes = new Map(); // symbol -> volume for current hour
    this.primarySymbol = null;    // determined from previous hour
  }

  processCandle(candle) {
    const hourKey = Math.floor(candle.timestamp / 3600000);

    if (hourKey !== this.currentHour) {
      // Hour boundary: determine primary from completed hour
      if (this.currentHour !== null && this.hourVolumes.size > 0) {
        let maxVol = 0;
        for (const [sym, vol] of this.hourVolumes) {
          if (vol > maxVol) { maxVol = vol; this.primarySymbol = sym; }
        }
      }
      this.currentHour = hourKey;
      this.hourVolumes = new Map();
    }

    const sym = candle.symbol;
    this.hourVolumes.set(sym, (this.hourVolumes.get(sym) || 0) + candle.volume);

    // During first hour or if no primary yet, accept the highest-volume contract so far
    if (!this.primarySymbol) {
      let maxVol = 0;
      for (const [s, v] of this.hourVolumes) {
        if (v > maxVol) { maxVol = v; this.primarySymbol = s; }
      }
    }

    return candle.symbol === this.primarySymbol;
  }
}

// ============================================================================
// Microstructure Metrics Computation
// ============================================================================

function computeMetrics(window, windowSize) {
  // window is an array of 1s candles sorted by time, covering windowSize seconds
  if (window.length < 3) return null;

  const first = window[0];
  const last = window[window.length - 1];
  const netMove = last.close - first.open;
  const elapsed = (last.timestamp - first.timestamp) / 1000;
  if (elapsed < windowSize * 0.5) return null; // not enough coverage

  // Price velocity (pts/sec)
  const velocity = netMove / Math.max(elapsed, 1);

  // Volume
  let totalVolume = 0;
  for (let i = 0; i < window.length; i++) totalVolume += window[i].volume;

  // Move efficiency: |net| / sum(|tick-to-tick|)
  let pathLength = 0;
  for (let i = 1; i < window.length; i++) {
    pathLength += Math.abs(window[i].close - window[i - 1].close);
  }
  const efficiency = pathLength > 0 ? Math.abs(netMove) / pathLength : 0;

  // Close position: where price settles within the window's range
  let windowHigh = -Infinity, windowLow = Infinity;
  for (let i = 0; i < window.length; i++) {
    if (window[i].high > windowHigh) windowHigh = window[i].high;
    if (window[i].low < windowLow) windowLow = window[i].low;
  }
  const range = windowHigh - windowLow;
  const closePosition = range > 0 ? (last.close - windowLow) / range : 0.5;

  // Tick direction ratio: fraction of seconds closing up
  let upTicks = 0, downTicks = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i].close > window[i - 1].close) upTicks++;
    else if (window[i].close < window[i - 1].close) downTicks++;
  }
  const totalTicks = upTicks + downTicks;
  const tickDirectionRatio = totalTicks > 0 ? upTicks / totalTicks : 0.5;

  // Volume acceleration: second half volume / first half volume
  const midIdx = Math.floor(window.length / 2);
  let firstHalfVol = 0, secondHalfVol = 0;
  for (let i = 0; i < midIdx; i++) firstHalfVol += window[i].volume;
  for (let i = midIdx; i < window.length; i++) secondHalfVol += window[i].volume;
  const volumeAcceleration = firstHalfVol > 0 ? secondHalfVol / firstHalfVol : 1;

  return {
    velocity,
    totalVolume,
    efficiency,
    closePosition,
    tickDirectionRatio,
    volumeAcceleration,
    netMove,
    range,
    windowHigh,
    windowLow,
    candleCount: window.length
  };
}

// ============================================================================
// Event Detection
// ============================================================================

function checkMomentumBurst(metrics, volumeRate, baselineVolumeRate, thresholds) {
  if (!metrics) return null;

  const absVelocity = Math.abs(metrics.velocity);
  if (absVelocity < thresholds.velocity) return null;

  // Volume ratio vs baseline
  const volumeRatio = baselineVolumeRate > 0 ? volumeRate / baselineVolumeRate : 0;
  if (volumeRatio < thresholds.volumeRatio) return null;

  if (metrics.efficiency < thresholds.efficiency) return null;

  // Direction
  const isBullish = metrics.velocity > 0;

  // Close position confirms direction
  if (isBullish && metrics.closePosition < 0.7) return null;
  if (!isBullish && metrics.closePosition > 0.3) return null;

  // Tick direction confirms
  if (isBullish && metrics.tickDirectionRatio < 0.65) return null;
  if (!isBullish && metrics.tickDirectionRatio > 0.35) return null;

  return {
    direction: isBullish ? 'long' : 'short',
    velocity: metrics.velocity,
    absVelocity,
    volumeRatio,
    efficiency: metrics.efficiency,
    closePosition: metrics.closePosition,
    tickDirectionRatio: metrics.tickDirectionRatio,
    volumeAcceleration: metrics.volumeAcceleration,
    netMove: metrics.netMove,
    range: metrics.range
  };
}

// ============================================================================
// Streaming Pipeline
// ============================================================================

async function runAnalysis() {
  const filePath = getDataFilePath();
  if (!fs.existsSync(filePath)) {
    console.error(`Data file not found: ${filePath}`);
    process.exit(1);
  }
  console.log(`Loading from: ${filePath}`);
  const fileSize = fs.statSync(filePath).size;
  console.log(`File size: ${(fileSize / 1e9).toFixed(2)} GB`);
  console.log();

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let colParser = null;
  const isES = ticker === 'ES';
  const contractTracker = isES ? null : new PrimaryContractTracker();

  // Rolling window buffer — we keep last ROLLING_BUFFER_SIZE seconds of candles.
  // Uses a compact array with periodic splice to prevent unbounded growth.
  const rollingBuffer = [];
  let bufferStartIdx = 0;

  // Incremental baseline volume: track running sum over BASELINE_WINDOW.
  // We maintain a pointer into the buffer marking the baseline start, and
  // add/subtract volume as candles enter/leave the window. O(1) per candle.
  let baselineVolume = 0;
  let baselineStartPtr = 0; // index into rollingBuffer

  // Z-score trackers per window size per metric (updated every Nth candle to save CPU)
  const zTrackers = {};
  for (const ws of windowSizes) {
    zTrackers[ws] = {
      velocity: new WelfordTracker(),
      volumeRatio: new WelfordTracker(),
      efficiency: new WelfordTracker()
    };
  }
  let zUpdateCounter = 0;
  const Z_UPDATE_INTERVAL = 5; // update z-scores every N candles

  // Event detection state
  const events = [];
  const pendingForwardReturns = [];
  let lastEventTimestamp = 0;

  // Grid search storage
  const gridCandidates = gridSearch ? [] : null;

  // Stats
  let totalLines = 0;
  let parsedCandles = 0;
  let skippedCalendarSpread = 0;
  let skippedNonPrimary = 0;
  let skippedDateRange = 0;
  let skippedInvalid = 0;
  let lastProgressTime = Date.now();
  let lastProgressLines = 0;
  const startTime = Date.now();

  const eventDays = new Set();

  for await (const line of rl) {
    if (!colParser) {
      colParser = getColumnParser(line);
      continue;
    }

    totalLines++;

    // Progress every 10 seconds
    if (Date.now() - lastProgressTime > 10000) {
      const elapsed = (Date.now() - startTime) / 1000;
      const lps = ((totalLines - lastProgressLines) / ((Date.now() - lastProgressTime) / 1000)).toFixed(0);
      const pct = fileStream.bytesRead ? ((fileStream.bytesRead / fileSize) * 100).toFixed(1) : '?';
      console.log(`  ${pct}% | ${(totalLines / 1e6).toFixed(1)}M lines | ${lps} lines/s | ${events.length} events | ${elapsed.toFixed(0)}s elapsed`);
      lastProgressTime = Date.now();
      lastProgressLines = totalLines;
    }

    // Parse line — inline for speed (no function call overhead)
    const parts = line.split(',');
    if (parts.length < colParser.minCols) { skippedInvalid++; continue; }

    const timestamp = new Date(parts[colParser.tsIdx]).getTime();
    if (isNaN(timestamp)) { skippedInvalid++; continue; }

    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) {
      skippedDateRange++;
      continue;
    }

    const symbol = parts[colParser.symbolIdx]?.trim();
    if (!isES && symbol && symbol.includes('-')) { skippedCalendarSpread++; continue; }

    const open = parseFloat(parts[colParser.openIdx]);
    const high = parseFloat(parts[colParser.highIdx]);
    const low = parseFloat(parts[colParser.lowIdx]);
    const close = parseFloat(parts[colParser.closeIdx]);
    const volume = parseInt(parts[colParser.volumeIdx]) || 0;

    if (isNaN(open) || isNaN(close)) { skippedInvalid++; continue; }
    if (open === high && high === low && low === close) { skippedInvalid++; continue; }

    const candle = { timestamp, open, high, low, close, volume, symbol };

    if (!isES) {
      if (!contractTracker.processCandle(candle)) { skippedNonPrimary++; continue; }
    }

    parsedCandles++;

    // Add to rolling buffer + update baseline volume
    rollingBuffer.push(candle);
    baselineVolume += volume;

    // Trim buffer: remove candles older than ROLLING_BUFFER_SIZE seconds
    const cutoffTs = timestamp - ROLLING_BUFFER_SIZE * 1000;
    while (bufferStartIdx < rollingBuffer.length && rollingBuffer[bufferStartIdx].timestamp < cutoffTs) {
      bufferStartIdx++;
    }

    // Advance baseline pointer: remove candles older than BASELINE_WINDOW from running sum
    const baselineCutoff = timestamp - BASELINE_WINDOW * 1000;
    while (baselineStartPtr < rollingBuffer.length && rollingBuffer[baselineStartPtr].timestamp < baselineCutoff) {
      baselineVolume -= rollingBuffer[baselineStartPtr].volume;
      baselineStartPtr++;
    }

    // Periodically compact buffer to prevent memory growth
    if (bufferStartIdx > 10000) {
      const minPtr = Math.min(bufferStartIdx, baselineStartPtr);
      rollingBuffer.splice(0, minPtr);
      bufferStartIdx -= minPtr;
      baselineStartPtr -= minPtr;
    }

    const activeStart = bufferStartIdx;
    const activeEnd = rollingBuffer.length;
    const activeLen = activeEnd - activeStart;

    // Resolve pending forward returns (only a few events pending at any time)
    for (let p = pendingForwardReturns.length - 1; p >= 0; p--) {
      const pending = pendingForwardReturns[p];
      const age = (timestamp - pending.eventTimestamp) / 1000;

      const move = (close - pending.entryPrice) * pending.directionSign;
      if (move > pending.mfe) pending.mfe = move;
      if (move < pending.mae) pending.mae = move;

      // Track per-horizon MFE/MAE
      for (const horizon of FORWARD_HORIZONS) {
        const hKey = `${horizon}s`;
        if (pending.forwardReturns[hKey] !== undefined) continue;

        if (age <= horizon) {
          // Still within this horizon — track MFE/MAE
          if (!pending._tempMfe) pending._tempMfe = {};
          if (!pending._tempMae) pending._tempMae = {};
          if (move > (pending._tempMfe[hKey] || 0)) pending._tempMfe[hKey] = move;
          if (move < (pending._tempMae[hKey] || 0)) pending._tempMae[hKey] = move;
        } else {
          // Horizon reached — record forward return
          const ret = (close - pending.entryPrice) * pending.directionSign;
          pending.forwardReturns[hKey] = {
            points: +(close - pending.entryPrice).toFixed(4),
            directedPoints: +ret.toFixed(4),
            win: ret > 0,
            mfe: +(pending._tempMfe?.[hKey] || 0).toFixed(4),
            mae: +(pending._tempMae?.[hKey] || 0).toFixed(4)
          };
          pending.horizonMfe[hKey] = pending._tempMfe?.[hKey] || 0;
          pending.horizonMae[hKey] = pending._tempMae?.[hKey] || 0;
        }
      }

      // Fully resolved?
      if (age > MAX_FORWARD + 5) {
        for (const horizon of FORWARD_HORIZONS) {
          const hKey = `${horizon}s`;
          if (pending.forwardReturns[hKey] === undefined) {
            pending.forwardReturns[hKey] = { points: 0, directedPoints: 0, win: false, mfe: 0, mae: 0 };
          }
        }
        pending.mfe = +pending.mfe.toFixed(4);
        pending.mae = +pending.mae.toFixed(4);
        delete pending._tempMfe;
        delete pending._tempMae;
        pendingForwardReturns.splice(p, 1);
      }
    }

    // Need enough data for baseline
    if (activeLen < 100) continue;

    // Baseline volume rate (O(1) — already tracked incrementally)
    const baselineVolumeRate = baselineVolume / BASELINE_WINDOW;

    // Compute metrics for each window size
    let bestBurst = null;
    let triggeredWindows = [];

    for (const ws of windowSizes) {
      // Extract window of last ws seconds — scan backward from end
      const wsCutoff = timestamp - ws * 1000;
      const windowCandles = [];
      for (let b = activeEnd - 1; b >= activeStart; b--) {
        if (rollingBuffer[b].timestamp < wsCutoff) break;
        windowCandles.push(rollingBuffer[b]);
      }
      windowCandles.reverse();

      if (windowCandles.length < 3) continue;

      const metrics = computeMetrics(windowCandles, ws);
      if (!metrics) continue;

      const windowVolumeRate = metrics.totalVolume / ws;

      // Update z-score trackers (every N candles to reduce overhead)
      if (zUpdateCounter % Z_UPDATE_INTERVAL === 0) {
        zTrackers[ws].velocity.update(Math.abs(metrics.velocity));
        zTrackers[ws].efficiency.update(metrics.efficiency);
        if (baselineVolumeRate > 0) {
          zTrackers[ws].volumeRatio.update(windowVolumeRate / baselineVolumeRate);
        }
      }

      const burst = checkMomentumBurst(
        metrics,
        windowVolumeRate,
        baselineVolumeRate,
        { velocity: velocityThreshold, volumeRatio: volumeRatioThreshold, efficiency: efficiencyThreshold }
      );

      if (burst) {
        triggeredWindows.push(ws);
        if (!bestBurst || burst.absVelocity > bestBurst.absVelocity) {
          bestBurst = { ...burst, windowSize: ws, volumeRate: windowVolumeRate };
        }
      }

      if (gridSearch && ws === windowSizes[windowSizes.length - 1] && metrics) {
        const volumeRatio = baselineVolumeRate > 0 ? windowVolumeRate / baselineVolumeRate : 0;
        gridCandidates.push({
          timestamp, price: close,
          velocity: Math.abs(metrics.velocity), volumeRatio,
          efficiency: metrics.efficiency, closePosition: metrics.closePosition,
          tickDirectionRatio: metrics.tickDirectionRatio,
          direction: metrics.velocity > 0 ? 'long' : 'short',
          directionSign: metrics.velocity > 0 ? 1 : -1,
          netMove: metrics.netMove
        });
      }
    }

    zUpdateCounter++;

    if (!bestBurst) continue;

    // Cooldown check
    if (timestamp - lastEventTimestamp < cooldownSeconds * 1000) continue;
    lastEventTimestamp = timestamp;

    // Record event
    const session = getSession(timestamp);
    const bucket = get30minBucket(timestamp);
    const dayKey = new Date(timestamp).toISOString().slice(0, 10);
    eventDays.add(dayKey);

    const event = {
      timestamp: new Date(timestamp).toISOString(),
      timestampMs: timestamp,
      price: close,
      direction: bestBurst.direction,
      directionSign: bestBurst.direction === 'long' ? 1 : -1,
      session,
      timeBucket: bucket,
      triggeredWindows,
      multiWindow: triggeredWindows.length > 1,
      windowCount: triggeredWindows.length,
      bestWindow: bestBurst.windowSize,
      velocity: +bestBurst.velocity.toFixed(4),
      absVelocity: +bestBurst.absVelocity.toFixed(4),
      volumeRatio: +bestBurst.volumeRatio.toFixed(2),
      efficiency: +bestBurst.efficiency.toFixed(4),
      closePosition: +bestBurst.closePosition.toFixed(4),
      tickDirectionRatio: +bestBurst.tickDirectionRatio.toFixed(4),
      volumeAcceleration: +bestBurst.volumeAcceleration.toFixed(2),
      netMove: +bestBurst.netMove.toFixed(4),
      range: +bestBurst.range.toFixed(4),
      // Z-scores (from the best window)
      velocityZ: +zTrackers[bestBurst.windowSize].velocity.zScore(bestBurst.absVelocity).toFixed(2),
      efficiencyZ: +zTrackers[bestBurst.windowSize].efficiency.zScore(bestBurst.efficiency).toFixed(2),
      volumeRatioZ: +zTrackers[bestBurst.windowSize].volumeRatio.zScore(bestBurst.volumeRatio).toFixed(2),
      // Forward returns (filled later)
      forwardReturns: {},
      horizonMfe: {},
      horizonMae: {},
      mfe: 0,
      mae: 0,
      entryPrice: close,
      eventTimestamp: timestamp
    };

    events.push(event);
    pendingForwardReturns.push(event);
  }

  // Finalize any remaining pending events
  for (const pending of pendingForwardReturns) {
    for (const horizon of FORWARD_HORIZONS) {
      const hKey = `${horizon}s`;
      if (pending.forwardReturns[hKey] === undefined) {
        pending.forwardReturns[hKey] = { points: 0, directedPoints: 0, win: false, mfe: 0, mae: 0 };
      }
    }
    pending.mfe = +pending.mfe.toFixed(4);
    pending.mae = +pending.mae.toFixed(4);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log();
  console.log(`Streaming complete in ${elapsed}s`);
  console.log(`  Total lines: ${(totalLines / 1e6).toFixed(2)}M`);
  console.log(`  Parsed candles: ${(parsedCandles / 1e6).toFixed(2)}M`);
  if (!isES) {
    console.log(`  Skipped calendar spreads: ${(skippedCalendarSpread / 1e6).toFixed(2)}M`);
    console.log(`  Skipped non-primary: ${(skippedNonPrimary / 1e6).toFixed(2)}M`);
  }
  console.log(`  Skipped date range: ${(skippedDateRange / 1e6).toFixed(2)}M`);
  console.log(`  Skipped invalid: ${skippedInvalid}`);
  console.log(`  Events detected: ${events.length}`);
  console.log(`  Trading days with events: ${eventDays.size}`);
  console.log(`  Avg events/day: ${eventDays.size > 0 ? (events.length / eventDays.size).toFixed(1) : 0}`);

  return { events, gridCandidates };
}

// ============================================================================
// Grid Search (sweep thresholds)
// ============================================================================

function runGridSearch(gridCandidates) {
  if (!gridCandidates || gridCandidates.length === 0) return null;

  console.log('\nRunning threshold grid search...');
  console.log(`  Candidates to evaluate: ${gridCandidates.length}`);

  // We can't track forward returns for grid candidates in the same pass,
  // so this is an approximation: we use the events that DID get detected
  // and measure how threshold changes affect event count and quality.
  // For a proper grid search with forward returns, we'd need a second pass.

  // Instead, analyze the existing events by their metric values
  return null; // Grid search handled in analysis via metric bucketing
}

// ============================================================================
// Statistical Analysis
// ============================================================================

function analyzeEvents(events) {
  if (events.length === 0) {
    console.log('\nNo events to analyze.');
    return {};
  }

  console.log('\n' + '='.repeat(80));
  console.log('STATISTICAL ANALYSIS');
  console.log('='.repeat(80));

  // Helper: analyze a group of events
  const analyzeGroup = (group, label) => {
    if (!group || group.length === 0) return null;
    const result = { label, count: group.length };

    for (const horizon of FORWARD_HORIZONS) {
      const hKey = `${horizon}s`;
      const hLabel = horizon >= 60 ? `${horizon / 60}m` : `${horizon}s`;
      const withData = group.filter(e => e.forwardReturns[hKey] && e.forwardReturns[hKey].points !== undefined);
      if (withData.length === 0) continue;

      const wins = withData.filter(e => e.forwardReturns[hKey].win).length;
      const directedPts = withData.map(e => e.forwardReturns[hKey].directedPoints);
      const rawPts = withData.map(e => e.forwardReturns[hKey].points);
      const avgDirected = directedPts.reduce((a, b) => a + b, 0) / directedPts.length;
      const medianDirected = percentile(directedPts, 50);

      // Profit factor
      let grossProfit = 0, grossLoss = 0;
      for (const p of directedPts) {
        if (p > 0) grossProfit += p;
        else grossLoss += Math.abs(p);
      }
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

      // MFE/MAE for this horizon
      const mfes = withData.map(e => e.forwardReturns[hKey].mfe || 0);
      const maes = withData.map(e => e.forwardReturns[hKey].mae || 0);

      result[hLabel] = {
        count: withData.length,
        winRate: +((wins / withData.length) * 100).toFixed(1),
        avgReturn: +avgDirected.toFixed(2),
        medianReturn: +medianDirected.toFixed(2),
        profitFactor: profitFactor === Infinity ? 'Inf' : +profitFactor.toFixed(2),
        avgMFE: +(mfes.reduce((a, b) => a + b, 0) / mfes.length).toFixed(2),
        avgMAE: +(maes.reduce((a, b) => a + b, 0) / maes.length).toFixed(2),
        p25: +percentile(directedPts, 25).toFixed(2),
        p75: +percentile(directedPts, 75).toFixed(2)
      };
    }

    // Average metrics
    result.avgVelocity = +(group.reduce((s, e) => s + e.absVelocity, 0) / group.length).toFixed(4);
    result.avgVolumeRatio = +(group.reduce((s, e) => s + e.volumeRatio, 0) / group.length).toFixed(2);
    result.avgEfficiency = +(group.reduce((s, e) => s + e.efficiency, 0) / group.length).toFixed(4);
    result.avgVolumeAccel = +(group.reduce((s, e) => s + e.volumeAcceleration, 0) / group.length).toFixed(2);
    result.multiWindowPct = +((group.filter(e => e.multiWindow).length / group.length) * 100).toFixed(1);

    // Overall MFE/MAE (over full MAX_FORWARD window)
    result.avgMFE = +(group.reduce((s, e) => s + e.mfe, 0) / group.length).toFixed(2);
    result.avgMAE = +(group.reduce((s, e) => s + e.mae, 0) / group.length).toFixed(2);

    return result;
  };

  // 1. Overall
  const overall = analyzeGroup(events, 'all');
  printGroup(overall);

  // 2. By direction
  console.log('\n--- By Direction ---');
  const byDirection = {
    long: analyzeGroup(events.filter(e => e.direction === 'long'), 'long'),
    short: analyzeGroup(events.filter(e => e.direction === 'short'), 'short')
  };
  printGroup(byDirection.long);
  printGroup(byDirection.short);

  // 3. By session
  console.log('\n--- By Session ---');
  const bySession = {};
  for (const session of ['rth', 'premarket', 'overnight', 'afterhours']) {
    const group = events.filter(e => e.session === session);
    if (group.length > 0) {
      bySession[session] = analyzeGroup(group, session);
      printGroup(bySession[session]);
    }
  }

  // 4. Multi-window confirmation
  console.log('\n--- Multi-Window Confirmation ---');
  const single = events.filter(e => e.windowCount === 1);
  const multi2 = events.filter(e => e.windowCount === 2);
  const multi3 = events.filter(e => e.windowCount >= 3);
  const multiWindowAnalysis = {
    singleWindow: analyzeGroup(single, '1 window'),
    twoWindows: analyzeGroup(multi2, '2 windows'),
    threeWindows: analyzeGroup(multi3, '3+ windows')
  };
  printGroup(multiWindowAnalysis.singleWindow);
  printGroup(multiWindowAnalysis.twoWindows);
  printGroup(multiWindowAnalysis.threeWindows);

  // 5. Time-of-day: 30-min buckets
  console.log('\n--- Time of Day (30-min buckets, top 10 by event count) ---');
  const byTimeBucket = {};
  const buckets = [...new Set(events.map(e => e.timeBucket))].sort();
  for (const bucket of buckets) {
    const group = events.filter(e => e.timeBucket === bucket);
    if (group.length >= 5) {
      byTimeBucket[bucket] = analyzeGroup(group, `${bucket} UTC`);
    }
  }
  const sortedBuckets = Object.values(byTimeBucket).sort((a, b) => b.count - a.count).slice(0, 10);
  for (const g of sortedBuckets) printGroup(g);

  // 6. Metric bucketing — for each metric, divide into quartiles and report forward returns
  console.log('\n--- Metric Bucketing (quartile analysis) ---');
  const metricBuckets = {};
  const metricsToAnalyze = [
    { name: 'absVelocity', label: 'Velocity' },
    { name: 'volumeRatio', label: 'Volume Ratio' },
    { name: 'efficiency', label: 'Efficiency' },
    { name: 'volumeAcceleration', label: 'Volume Acceleration' },
    { name: 'velocityZ', label: 'Velocity Z-Score' }
  ];

  for (const { name, label } of metricsToAnalyze) {
    const values = events.map(e => e[name]).filter(v => v !== undefined && !isNaN(v)).sort((a, b) => a - b);
    if (values.length < 20) continue;

    const q1 = percentile(values, 25);
    const q2 = percentile(values, 50);
    const q3 = percentile(values, 75);

    const quartiles = [
      { label: `Q1 (≤${q1.toFixed(2)})`, filter: e => e[name] <= q1 },
      { label: `Q2 (${q1.toFixed(2)}-${q2.toFixed(2)})`, filter: e => e[name] > q1 && e[name] <= q2 },
      { label: `Q3 (${q2.toFixed(2)}-${q3.toFixed(2)})`, filter: e => e[name] > q2 && e[name] <= q3 },
      { label: `Q4 (>${q3.toFixed(2)})`, filter: e => e[name] > q3 }
    ];

    console.log(`\n  ${label}:`);
    metricBuckets[name] = {};
    for (const q of quartiles) {
      const group = events.filter(q.filter);
      if (group.length > 0) {
        metricBuckets[name][q.label] = analyzeGroup(group, `  ${q.label}`);
        printGroup(metricBuckets[name][q.label]);
      }
    }
  }

  // 7. By year
  console.log('\n--- By Year ---');
  const byYear = {};
  const years = [...new Set(events.map(e => new Date(e.timestampMs).getUTCFullYear()))].sort();
  for (const year of years) {
    const group = events.filter(e => new Date(e.timestampMs).getUTCFullYear() === year);
    if (group.length > 0) {
      byYear[year] = analyzeGroup(group, `${year}`);
      printGroup(byYear[year]);
    }
  }

  return {
    overall,
    byDirection,
    bySession,
    multiWindowAnalysis,
    byTimeBucket,
    metricBuckets,
    byYear
  };
}

// ============================================================================
// Print Helpers
// ============================================================================

function printGroup(g) {
  if (!g) return;
  const parts = [`  ${g.label} (n=${g.count})`];

  // Show 1m and 5m horizons
  for (const hLabel of ['30s', '1m', '2m', '5m', '10m']) {
    if (g[hLabel]) {
      parts.push(`${hLabel}: ${g[hLabel].winRate}% win, avg ${g[hLabel].avgReturn}pts, PF ${g[hLabel].profitFactor}`);
    }
  }

  if (g.avgMFE !== undefined) parts.push(`MFE: ${g.avgMFE}, MAE: ${g.avgMAE}`);
  if (g.multiWindowPct !== undefined) parts.push(`multi: ${g.multiWindowPct}%`);

  console.log(parts.join(' | '));
}

function percentile(sortedArray, pct) {
  if (sortedArray.length === 0) return 0;
  const sorted = [...sortedArray].sort((a, b) => a - b);
  const idx = (pct / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { events, gridCandidates } = await runAnalysis();

  const analysis = analyzeEvents(events);

  // Compile results
  const results = {
    metadata: {
      ticker,
      startDate: startDateStr,
      endDate: endDateStr,
      totalEvents: events.length,
      parameters: {
        velocityThreshold,
        volumeRatioThreshold,
        efficiencyThreshold,
        cooldownSeconds,
        windowSizes,
        forwardHorizons: FORWARD_HORIZONS,
        baselineWindow: BASELINE_WINDOW
      },
      generatedAt: new Date().toISOString()
    },
    ...analysis,
    sampleEvents: events.slice(0, 30).map(e => ({
      timestamp: e.timestamp,
      price: e.price,
      direction: e.direction,
      session: e.session,
      triggeredWindows: e.triggeredWindows,
      velocity: e.velocity,
      absVelocity: e.absVelocity,
      volumeRatio: e.volumeRatio,
      efficiency: e.efficiency,
      closePosition: e.closePosition,
      tickDirectionRatio: e.tickDirectionRatio,
      volumeAcceleration: e.volumeAcceleration,
      velocityZ: e.velocityZ,
      forwardReturns: e.forwardReturns,
      mfe: e.mfe,
      mae: e.mae
    }))
  };

  // Write output
  const outDir = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
