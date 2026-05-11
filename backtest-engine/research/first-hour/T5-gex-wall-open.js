#!/usr/bin/env node
/**
 * T5: GEX wall reaction at the open (first-hour RTH).
 *
 * Hypothesis: When NQ opens within X points of a GEX wall (call_wall, put_wall,
 * gamma_flip, or any S/R level), the first-hour move is biased — either rejection
 * (price reverses off wall) or breakthrough (price rips through). This bias is
 * exploitable as a first-hour entry.
 *
 * Pipeline:
 *   1. For each trading day 2025-01-13 → 2026-04-23: load 9:30 GEX snapshot from
 *      data/gex/nq-cbbo/nq_gex_<date>.json. Find nearest level above and below
 *      the 9:30 NQ open (raw contract price).
 *   2. Bucket by distance to nearest level: <10pt, 10-25, 25-50, 50-100, >100.
 *      Bucket by level type (call_wall, put_wall, gamma_flip, support, resistance, any).
 *   3. For each bucket, compute P(reject) — price reverses off level by ≥30pt
 *      within 60 min before crossing through; P(break) — price closes ≥20pt
 *      beyond level on a 5m bar within 60 min; MFE/MAE distributions.
 *   4. Build two candidate strategies (rejection + break), grid-search params,
 *      report top configs by PF/Sharpe with last 2 months OOS.
 *
 * Output:
 *   - Data: research/first-hour/output/T5-gex-wall-open.json
 *   - Findings: research/first-hour/T5-FINDINGS.md (separate writer)
 */

import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';
import {
  toET,
  fromET,
  loadIntradayGEX,
  extractTradingDates,
  getRTHCandlesFromArray,
} from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.join(__dirname, 'output');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'T5-gex-wall-open.json');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const ROLLOVER_PATH = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_rollover_log.csv');

const START_DATE = '2025-01-13';
const END_DATE = '2026-04-23';
const OOS_CUTOFF_DATE = '2026-02-23'; // last 2 months OOS

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Load NQ raw 1m candles from CSV in date range, drop calendar spreads,
 * apply primary-contract filter (max-volume contract per hour).
 */
async function loadNQRawPrimary(startDate, endDate) {
  const filePath = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
  if (!fs.existsSync(filePath)) throw new Error(`Not found: ${filePath}`);

  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime() + 24 * 3600 * 1000;

  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        if (!row.symbol || row.symbol.includes('-')) return; // drop calendar spreads
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < start || ts > end) return;
        const open = parseFloat(row.open);
        const high = parseFloat(row.high);
        const low = parseFloat(row.low);
        const close = parseFloat(row.close);
        const volume = parseFloat(row.volume) || 0;
        if (![open, high, low, close].every(Number.isFinite)) return;
        // Filter corrupted single-tick candles where all OHLC equal AND volume tiny
        if (open === high && high === low && low === close && volume <= 2) return;
        candles.push({ timestamp: ts, open, high, low, close, volume, symbol: row.symbol });
      })
      .on('end', resolve)
      .on('error', reject);
  });
  candles.sort((a, b) => a.timestamp - b.timestamp);

  // Primary-contract filter: per hour, pick the highest-volume symbol; drop other.
  const hourVol = new Map();
  for (const c of candles) {
    const hourKey = Math.floor(c.timestamp / 3600000);
    if (!hourVol.has(hourKey)) hourVol.set(hourKey, new Map());
    const m = hourVol.get(hourKey);
    m.set(c.symbol, (m.get(c.symbol) || 0) + c.volume);
  }
  const primarySymbol = new Map();
  for (const [hourKey, m] of hourVol) {
    let best = null, bestVol = -1;
    for (const [sym, v] of m) {
      if (v > bestVol) { bestVol = v; best = sym; }
    }
    primarySymbol.set(hourKey, best);
  }
  const filtered = candles.filter(c => primarySymbol.get(Math.floor(c.timestamp / 3600000)) === c.symbol);
  return filtered;
}

function loadRolloverDates() {
  const txt = fs.readFileSync(ROLLOVER_PATH, 'utf-8');
  const lines = txt.trim().split('\n').slice(1);
  const dates = new Set();
  for (const line of lines) {
    const [date] = line.split(',');
    if (date) dates.add(date);
  }
  return dates;
}

function pctile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

function mean(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr) {
  return pctile(arr, 0.5);
}

function distanceBucket(absDist) {
  if (absDist < 10) return '<10';
  if (absDist < 25) return '10-25';
  if (absDist < 50) return '25-50';
  if (absDist < 100) return '50-100';
  return '>100';
}

// ----------------------------------------------------------------------------
// Identify wall structure at the open
// ----------------------------------------------------------------------------

/**
 * Build a flat array of {price, type, label} for a snapshot. Types:
 * 'call_wall', 'put_wall', 'gamma_flip', 'support', 'resistance'.
 * Note: call_wall typically equals resistance[0]; put_wall typically equals
 * support[0]. We tag the named-wall designation (call_wall / put_wall) where
 * applicable, with the support/resistance entries also kept (so we can study
 * the deeper S2-S5 / R2-R5).
 */
function flattenLevels(snap) {
  const out = [];
  if (snap.call_wall != null && Number.isFinite(snap.call_wall)) {
    out.push({ price: snap.call_wall, type: 'call_wall', label: 'call_wall' });
  }
  if (snap.put_wall != null && Number.isFinite(snap.put_wall)) {
    out.push({ price: snap.put_wall, type: 'put_wall', label: 'put_wall' });
  }
  if (snap.gamma_flip != null && Number.isFinite(snap.gamma_flip)) {
    out.push({ price: snap.gamma_flip, type: 'gamma_flip', label: 'gamma_flip' });
  }
  if (Array.isArray(snap.resistance)) {
    snap.resistance.forEach((p, i) => {
      if (Number.isFinite(p)) out.push({ price: p, type: 'resistance', label: `R${i + 1}` });
    });
  }
  if (Array.isArray(snap.support)) {
    snap.support.forEach((p, i) => {
      if (Number.isFinite(p)) out.push({ price: p, type: 'support', label: `S${i + 1}` });
    });
  }
  // Deduplicate identical (price,type) entries (call_wall vs R1 will have same price often;
  // we keep both because their semantics differ — but two identical R1+R1 entries should not occur).
  return out;
}

function findNearest(levels, price) {
  let nearest = null;
  let nearestAbs = Infinity;
  for (const lvl of levels) {
    const d = lvl.price - price;
    const ad = Math.abs(d);
    if (ad < nearestAbs) {
      nearestAbs = ad;
      nearest = { ...lvl, dist: d, absDist: ad };
    }
  }
  return nearest;
}

function findNearestAboveBelow(levels, price) {
  let above = null, below = null;
  for (const lvl of levels) {
    const d = lvl.price - price;
    if (d > 0 && (!above || d < above.dist)) above = { ...lvl, dist: d };
    if (d < 0 && (!below || d > below.dist)) below = { ...lvl, dist: d };
  }
  return { above, below };
}

// ----------------------------------------------------------------------------
// Trade simulation
// ----------------------------------------------------------------------------

/**
 * For a given level price + entry side ("long" or "short"), simulate a trade
 * over the first 60 min using 1m candles. Stop and target are point distances
 * from entry. Returns:
 *   { entered, entryTime, entryPrice, exitTime, exitPrice, pnlPts, exitReason,
 *     mfe, mae, holdMin }
 */
function simulateTrade({
  candles1m,
  entryStartIdx,
  entryEndIdx, // inclusive
  level,
  side, // 'long' | 'short' for rejection; for breakouts side is the breakout direction
  entryMode, // 'limit_at_level' | 'market_at_open' | 'stop_break'
  stopPts,
  targetPts,
  maxHoldBars,
}) {
  // Determine entry
  let entryIdx = -1;
  let entryPrice = null;

  if (entryMode === 'limit_at_level') {
    // Place a limit at the level price; fill when reached
    for (let i = entryStartIdx; i <= entryEndIdx && i < candles1m.length; i++) {
      const c = candles1m[i];
      if (side === 'long' && c.low <= level) {
        entryIdx = i; entryPrice = level; break;
      }
      if (side === 'short' && c.high >= level) {
        entryIdx = i; entryPrice = level; break;
      }
    }
  } else if (entryMode === 'market_at_open') {
    // Enter at start candle's open (no fill check)
    if (entryStartIdx < candles1m.length) {
      entryIdx = entryStartIdx;
      entryPrice = candles1m[entryStartIdx].open;
    }
  } else if (entryMode === 'stop_break') {
    // Confirmed break: require a 1m candle to CLOSE past the level by ≥`brkBuffer`
    // points (default 10). Enter at the OPEN of the next 1m bar (not the breaking
    // bar itself — avoids the "entry bar's whole range counts" pathology).
    const brkBuffer = 10;
    for (let i = entryStartIdx; i <= entryEndIdx && i < candles1m.length; i++) {
      const c = candles1m[i];
      const triggered =
        (side === 'long' && c.close >= level + brkBuffer) ||
        (side === 'short' && c.close <= level - brkBuffer);
      if (triggered && i + 1 < candles1m.length) {
        entryIdx = i + 1;
        entryPrice = candles1m[i + 1].open;
        break;
      }
    }
  }

  if (entryIdx < 0) {
    return { entered: false };
  }

  const stopPrice = side === 'long' ? entryPrice - stopPts : entryPrice + stopPts;
  const targetPrice = side === 'long' ? entryPrice + targetPts : entryPrice - targetPts;

  let mfe = 0, mae = 0;
  let exitIdx = -1;
  let exitPrice = null;
  let exitReason = null;

  const lastIdx = Math.min(candles1m.length - 1, entryIdx + maxHoldBars);

  // Step through bars from entry (use entry candle's remainder as bar 0)
  for (let i = entryIdx; i <= lastIdx; i++) {
    const c = candles1m[i];
    // Update MFE/MAE
    if (side === 'long') {
      const high = c.high - entryPrice;
      const low = c.low - entryPrice;
      if (high > mfe) mfe = high;
      if (low < mae) mae = low;
    } else {
      const high = entryPrice - c.low;
      const low = entryPrice - c.high;
      if (high > mfe) mfe = high;
      if (low < mae) mae = low;
    }

    // Stop / target check (stop priority — pessimistic)
    if (side === 'long') {
      if (c.low <= stopPrice) {
        exitIdx = i; exitPrice = stopPrice; exitReason = 'stop'; break;
      }
      if (c.high >= targetPrice) {
        exitIdx = i; exitPrice = targetPrice; exitReason = 'target'; break;
      }
    } else {
      if (c.high >= stopPrice) {
        exitIdx = i; exitPrice = stopPrice; exitReason = 'stop'; break;
      }
      if (c.low <= targetPrice) {
        exitIdx = i; exitPrice = targetPrice; exitReason = 'target'; break;
      }
    }
  }

  if (exitIdx < 0) {
    exitIdx = lastIdx;
    exitPrice = candles1m[lastIdx].close;
    exitReason = 'time';
  }

  const pnlPts = side === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
  const holdMin = (candles1m[exitIdx].timestamp - candles1m[entryIdx].timestamp) / 60000;
  return {
    entered: true,
    entryTime: candles1m[entryIdx].timestamp,
    entryPrice,
    exitTime: candles1m[exitIdx].timestamp,
    exitPrice,
    pnlPts,
    exitReason,
    mfe,
    mae,
    holdMin,
  };
}

// ----------------------------------------------------------------------------
// Per-day analysis
// ----------------------------------------------------------------------------

/**
 * For a single date, identify the open snapshot and analyze level interactions
 * over the first 60 min.
 */
function analyzeDay(dateStr, candles1m, allTradingDates) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const rthOpenTs = fromET(y, m - 1, d, 9, 30);
  const rthEndTs = fromET(y, m - 1, d, 16, 0);

  // Get RTH candles for the day
  const rthCandles = candles1m.filter(c => c.timestamp >= rthOpenTs && c.timestamp < rthEndTs);
  if (rthCandles.length < 30) return null; // need at least 30 min

  // Find the 9:30 ET candle (the open candle)
  const openCandle = rthCandles[0];
  const openET = toET(openCandle.timestamp);
  // Sanity: openCandle should be exactly 9:30 ET
  if (openET.hour !== 9 || openET.minute !== 30) {
    return null;
  }

  // Load GEX snapshots
  const snaps = loadIntradayGEX('NQ', dateStr);
  if (!snaps || snaps.length === 0) return null;

  // Find snapshot with timestamp == 9:30 ET (UTC equivalent — DST aware)
  // 9:30 ET in EST = 14:30 UTC, in EDT = 13:30 UTC. We pick the snapshot whose
  // timestamp matches rthOpenTs exactly (post-relabel snapshots are at 15-min
  // grid points; 9:30 falls on a 15-min boundary).
  let openSnap = null;
  for (const s of snaps) {
    const sts = new Date(s.timestamp).getTime();
    if (sts === rthOpenTs) { openSnap = s; break; }
  }
  // Fallback: nearest snapshot ≤ rthOpenTs
  if (!openSnap) {
    let best = null, bestDiff = Infinity;
    for (const s of snaps) {
      const sts = new Date(s.timestamp).getTime();
      if (sts <= rthOpenTs) {
        const diff = rthOpenTs - sts;
        if (diff < bestDiff) { bestDiff = diff; best = s; }
      }
    }
    openSnap = best;
  }
  if (!openSnap) return null;

  const openPrice = openCandle.open;
  const multiplier = openSnap.multiplier;

  // Extract levels (in NQ price space)
  const levels = flattenLevels(openSnap);
  if (levels.length === 0) return null;

  // Analyze each level individually for first-hour interaction
  const firstHourCandles = rthCandles.slice(0, 60); // 60 1-min bars
  if (firstHourCandles.length < 30) return null;

  const fhHigh = Math.max(...firstHourCandles.map(c => c.high));
  const fhLow = Math.min(...firstHourCandles.map(c => c.low));
  const fhClose = firstHourCandles[firstHourCandles.length - 1].close;
  const sessionHigh60 = fhHigh;
  const sessionLow60 = fhLow;

  const { above, below } = findNearestAboveBelow(levels, openPrice);
  const nearest = findNearest(levels, openPrice);

  // ----- Per-day "reaction" study -----
  // For each level, determine: did price touch it in 60 min? Did it reject (≥30pt
  // reversal off level before breaking through)? Did it break (≥20pt beyond)?
  const reactions = [];
  for (const lvl of levels) {
    const distFromOpen = lvl.price - openPrice;
    // We only care about levels within 100pt of open (close enough to react to).
    if (Math.abs(distFromOpen) > 100) continue;

    const r = analyzeLevelReaction(firstHourCandles, lvl, openPrice);
    reactions.push({
      type: lvl.type,
      label: lvl.label,
      price: lvl.price,
      distFromOpen,
      ...r,
    });
  }

  return {
    date: dateStr,
    rthOpenTs,
    openPrice,
    openSymbol: openCandle.symbol,
    multiplier,
    regime: openSnap.regime,
    fhHigh, fhLow, fhClose,
    nearestAbove: above ? { ...above } : null,
    nearestBelow: below ? { ...below } : null,
    nearestLevel: nearest ? { ...nearest } : null,
    reactions,
    snapshotTime: openSnap.timestamp,
  };
}

/**
 * For a single level, determine first-hour reaction:
 *  - touched (price reached level)
 *  - first touch index
 *  - rejection: price touched level then reversed ≥30pt before continuing through
 *  - breakthrough: price closed ≥20pt beyond level on a 5m bar
 *  - mfe/mae distance from level after touch
 */
function analyzeLevelReaction(candles1m, level, openPrice) {
  // We need to know if open is below or above the level
  const startBelow = openPrice < level.price;
  let touchIdx = -1;
  for (let i = 0; i < candles1m.length; i++) {
    const c = candles1m[i];
    if (startBelow && c.high >= level.price) { touchIdx = i; break; }
    if (!startBelow && c.low <= level.price) { touchIdx = i; break; }
  }
  if (touchIdx === -1) {
    return {
      touched: false,
      rejected: false,
      brokeThrough: false,
      maxRejection: 0,
      maxBreakthrough: 0,
    };
  }

  // After touch, track the maximum reversal (back toward open) and the maximum
  // continuation beyond the level. Determine which threshold hits first.
  let maxRej = 0; // max distance back toward open (positive)
  let maxBrk = 0; // max distance beyond level (positive)
  let rejected = false; // ≥30pt reversal off level before breakthrough
  let brokeThrough = false; // 5m bar closes ≥20pt beyond level
  let firstResolution = null; // 'reject' | 'break'

  // Build 5m closes incrementally (5 consecutive 1m bars from touchIdx onwards)
  for (let i = touchIdx; i < candles1m.length; i++) {
    const c = candles1m[i];
    // Reversal magnitude (distance from level back toward starting side)
    const rev = startBelow ? (level.price - c.low) : (c.high - level.price);
    if (rev > maxRej) maxRej = rev;
    // Breakthrough magnitude (distance beyond level in continuation direction)
    const brk = startBelow ? (c.high - level.price) : (level.price - c.low);
    if (brk > maxBrk) maxBrk = brk;

    // Check breakthrough on 5m bar close: aggregate close of bar (i-4..i)
    if (i - touchIdx >= 4) {
      const close5m = candles1m[i].close;
      const beyond = startBelow ? (close5m - level.price) : (level.price - close5m);
      if (beyond >= 20) {
        brokeThrough = true;
        if (!firstResolution) firstResolution = 'break';
      }
    }
    if (rev >= 30 && !rejected) {
      rejected = true;
      if (!firstResolution) firstResolution = 'reject';
    }

    if (firstResolution) break;
  }

  return {
    touched: true,
    touchIdx,
    rejected,
    brokeThrough,
    maxRejection: maxRej,
    maxBreakthrough: maxBrk,
    firstResolution,
  };
}

// ----------------------------------------------------------------------------
// Aggregate stats by (type × distance bucket)
// ----------------------------------------------------------------------------

function aggregateReactions(perDay) {
  // Bucket by type × distance bucket
  const buckets = {}; // key = `${type}|${distBucket}` → arrays
  for (const day of perDay) {
    if (!day) continue;
    for (const r of day.reactions) {
      const ad = Math.abs(r.distFromOpen);
      const db = distanceBucket(ad);
      const key = `${r.type}|${db}`;
      if (!buckets[key]) {
        buckets[key] = {
          type: r.type,
          distBucket: db,
          n: 0,
          touched: 0,
          rejected: 0,
          brokeThrough: 0,
          maxRejections: [],
          maxBreakthroughs: [],
        };
      }
      const b = buckets[key];
      b.n++;
      if (r.touched) b.touched++;
      if (r.rejected) b.rejected++;
      if (r.brokeThrough) b.brokeThrough++;
      if (r.touched) {
        b.maxRejections.push(r.maxRejection);
        b.maxBreakthroughs.push(r.maxBreakthrough);
      }
    }
  }
  // Compute summary
  const out = [];
  for (const key in buckets) {
    const b = buckets[key];
    out.push({
      type: b.type,
      distBucket: b.distBucket,
      n: b.n,
      touchedPct: b.touched / b.n,
      rejectGivenTouch: b.touched ? b.rejected / b.touched : null,
      breakGivenTouch: b.touched ? b.brokeThrough / b.touched : null,
      rejectVsBreak: (b.rejected + b.brokeThrough) ? b.rejected / (b.rejected + b.brokeThrough) : null,
      maxRej_p50: median(b.maxRejections),
      maxRej_p75: pctile(b.maxRejections, 0.75),
      maxRej_p90: pctile(b.maxRejections, 0.90),
      maxBrk_p50: median(b.maxBreakthroughs),
      maxBrk_p75: pctile(b.maxBreakthroughs, 0.75),
      maxBrk_p90: pctile(b.maxBreakthroughs, 0.90),
    });
  }
  return out.sort((a, b) => a.type.localeCompare(b.type) || a.distBucket.localeCompare(b.distBucket));
}

// ----------------------------------------------------------------------------
// Strategy backtests
// ----------------------------------------------------------------------------

function runStrategyBacktest({
  perDay,
  candlesByDate,
  variant, // 'rejection' | 'break'
  levelTypes, // array of types to consider, or 'any'
  maxDistFromOpen, // only consider levels within this many points of open
  stopPts,
  targetPts,
  maxHoldBars,
  oosCutoffDate,
}) {
  const trades = [];
  for (const day of perDay) {
    if (!day) continue;
    const cs = candlesByDate.get(day.date);
    if (!cs) continue;

    // Find 1st RTH candle index
    const startIdx = cs.findIndex(c => c.timestamp === day.rthOpenTs);
    if (startIdx < 0) continue;

    // Choose nearest qualifying level (closest to open, within maxDistFromOpen)
    let candidates = day.reactions.filter(r => Math.abs(r.distFromOpen) <= maxDistFromOpen);
    if (levelTypes !== 'any') {
      candidates = candidates.filter(r => levelTypes.includes(r.type));
    }
    if (candidates.length === 0) continue;
    // Sort by absolute distance ascending
    candidates.sort((a, b) => Math.abs(a.distFromOpen) - Math.abs(b.distFromOpen));
    const lvl = candidates[0];

    // Decide side based on variant + level position
    let side, entryMode;
    const startBelow = day.openPrice < lvl.price;
    if (variant === 'rejection') {
      // Wall-rejection: enter against the level (reverse off it).
      // If level is above open (resistance role) → SHORT at the level (limit).
      // If level is below open (support role) → LONG at the level (limit).
      side = startBelow ? 'short' : 'long';
      entryMode = 'limit_at_level';
    } else {
      // Breakout: enter in direction price is approaching the level from.
      // Open below level → LONG on break above; open above → SHORT on break below.
      side = startBelow ? 'long' : 'short';
      entryMode = 'stop_break';
    }

    const entryEndIdx = Math.min(cs.length - 1, startIdx + 60); // first-hour entry window only
    const tr = simulateTrade({
      candles1m: cs,
      entryStartIdx: startIdx,
      entryEndIdx,
      level: lvl.price,
      side,
      entryMode,
      stopPts,
      targetPts,
      maxHoldBars,
    });
    if (!tr.entered) continue;

    trades.push({
      date: day.date,
      side,
      level: lvl.price,
      levelType: lvl.type,
      levelLabel: lvl.label,
      distFromOpen: lvl.distFromOpen,
      regime: day.regime,
      ...tr,
    });
  }
  return summarizeTrades(trades, oosCutoffDate);
}

function summarizeTrades(trades, oosCutoffDate) {
  if (trades.length === 0) {
    return { trades: [], n: 0 };
  }
  const compute = (sub) => {
    if (sub.length === 0) return { n: 0 };
    const wins = sub.filter(t => t.pnlPts > 0);
    const losses = sub.filter(t => t.pnlPts <= 0);
    const grossWin = wins.reduce((s, t) => s + t.pnlPts, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPts, 0));
    const totalPts = sub.reduce((s, t) => s + t.pnlPts, 0);
    const ptsArr = sub.map(t => t.pnlPts);
    const m = mean(ptsArr);
    const variance = ptsArr.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, ptsArr.length - 1);
    const sd = Math.sqrt(variance);
    // Equity curve and max DD
    let eq = 0, peak = 0, maxDD = 0;
    for (const t of sub) {
      eq += t.pnlPts;
      if (eq > peak) peak = eq;
      const dd = peak - eq;
      if (dd > maxDD) maxDD = dd;
    }
    return {
      n: sub.length,
      winRate: wins.length / sub.length,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? -grossLoss / losses.length : 0,
      pf: grossLoss === 0 ? Infinity : grossWin / grossLoss,
      totalPts,
      avgPts: m,
      sdPts: sd,
      sharpe: sd === 0 ? 0 : (m / sd) * Math.sqrt(252), // approximate annualized
      maxDDpts: maxDD,
      maxDDpctOfPeak: peak > 0 ? maxDD / peak : null,
    };
  };
  const allStats = compute(trades);
  const isTrades = trades.filter(t => t.date < oosCutoffDate);
  const oosTrades = trades.filter(t => t.date >= oosCutoffDate);
  return {
    trades,
    all: allStats,
    is: compute(isTrades),
    oos: compute(oosTrades),
  };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  console.log('T5: GEX wall reaction at the open');
  console.log(`Range: ${START_DATE} → ${END_DATE} (OOS cutoff: ${OOS_CUTOFF_DATE})`);

  // --- Load NQ raw 1m
  console.log('\n[1/5] Loading NQ raw 1m candles + filtering primary contract...');
  const allCandles = await loadNQRawPrimary(START_DATE, END_DATE);
  console.log(`Loaded ${allCandles.length.toLocaleString()} primary-contract NQ candles`);

  // Build a lookup by date string
  const candlesByDate = new Map();
  for (const c of allCandles) {
    const et = toET(c.timestamp);
    if (!candlesByDate.has(et.date)) candlesByDate.set(et.date, []);
    candlesByDate.get(et.date).push(c);
  }
  for (const [k, arr] of candlesByDate) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
  }

  const tradingDates = extractTradingDates(allCandles).filter(d => d >= START_DATE && d <= END_DATE);
  console.log(`Trading days: ${tradingDates.length}`);

  // Rollover dates to skip
  const rolloverDates = loadRolloverDates();

  // --- Per-day analysis
  console.log('\n[2/5] Analyzing per-day GEX wall structure at 9:30 ET...');
  const perDay = [];
  let skippedRoll = 0, skippedNoSnap = 0, skippedNoOpen = 0;
  for (const date of tradingDates) {
    if (rolloverDates.has(date)) { skippedRoll++; continue; }
    const cs = candlesByDate.get(date) || [];
    const day = analyzeDay(date, cs, tradingDates);
    if (!day) {
      // Distinguish skip reasons quickly
      const snaps = loadIntradayGEX('NQ', date);
      if (!snaps || snaps.length === 0) skippedNoSnap++;
      else skippedNoOpen++;
      continue;
    }
    perDay.push(day);
  }
  console.log(`Analyzed ${perDay.length} days; skipped: roll=${skippedRoll}, no-snap=${skippedNoSnap}, no-open-candle=${skippedNoOpen}`);

  // --- Aggregate reactions
  console.log('\n[3/5] Aggregating reactions by type × distance bucket...');
  const reactionStats = aggregateReactions(perDay);

  // Print top buckets (n >= 20)
  console.log('\nKey buckets (n≥20):');
  console.log('type'.padEnd(14), 'dist'.padEnd(8), 'n'.padStart(4), 'touch%'.padStart(8),
    'rejGT'.padStart(8), 'brkGT'.padStart(8), 'rej/(rej+brk)'.padStart(14),
    'maxRejP75'.padStart(10), 'maxBrkP75'.padStart(10));
  for (const r of reactionStats.filter(x => x.n >= 20)) {
    console.log(
      r.type.padEnd(14),
      r.distBucket.padEnd(8),
      String(r.n).padStart(4),
      ((r.touchedPct ?? 0) * 100).toFixed(1).padStart(8),
      r.rejectGivenTouch != null ? (r.rejectGivenTouch * 100).toFixed(1).padStart(8) : '   N/A',
      r.breakGivenTouch != null ? (r.breakGivenTouch * 100).toFixed(1).padStart(8) : '   N/A',
      r.rejectVsBreak != null ? (r.rejectVsBreak * 100).toFixed(1).padStart(14) : '         N/A',
      r.maxRej_p75 != null ? r.maxRej_p75.toFixed(1).padStart(10) : '       N/A',
      r.maxBrk_p75 != null ? r.maxBrk_p75.toFixed(1).padStart(10) : '       N/A',
    );
  }

  // --- Strategy grid search
  console.log('\n[4/5] Running strategy grid search...');
  const grid = {
    rejection: [],
    break: [],
  };

  // Level type sets to test
  const typeSetMap = {
    any: 'any',
    call_wall: ['call_wall'],
    put_wall: ['put_wall'],
    gamma_flip: ['gamma_flip'],
    walls: ['call_wall', 'put_wall'],
    walls_flip: ['call_wall', 'put_wall', 'gamma_flip'],
    support: ['support'],
    resistance: ['resistance'],
    s_r: ['support', 'resistance'],
    all_named: ['call_wall', 'put_wall', 'gamma_flip', 'support', 'resistance'],
  };
  const distSet = [10, 25, 50];
  const stopSet = [10, 15, 20, 25, 30];
  const targetSet = [20, 30, 40, 50, 60];
  const holdSet = [60]; // 60 1m bars = first-hour cap

  let combos = 0;
  const totalCombos = Object.keys(typeSetMap).length * distSet.length * stopSet.length * targetSet.length * holdSet.length;

  for (const [typeName, types] of Object.entries(typeSetMap)) {
    for (const dist of distSet) {
      for (const stop of stopSet) {
        for (const tgt of targetSet) {
          for (const hold of holdSet) {
            for (const variant of ['rejection', 'break']) {
              const r = runStrategyBacktest({
                perDay,
                candlesByDate,
                variant,
                levelTypes: types,
                maxDistFromOpen: dist,
                stopPts: stop,
                targetPts: tgt,
                maxHoldBars: hold,
                oosCutoffDate: OOS_CUTOFF_DATE,
              });
              if (r.all && r.all.n >= 30) {
                grid[variant].push({
                  typeName,
                  maxDistFromOpen: dist,
                  stopPts: stop,
                  targetPts: tgt,
                  maxHoldBars: hold,
                  n: r.all.n,
                  winRate: r.all.winRate,
                  pf: r.all.pf,
                  sharpe: r.all.sharpe,
                  totalPts: r.all.totalPts,
                  avgPts: r.all.avgPts,
                  maxDDpts: r.all.maxDDpts,
                  is_n: r.is.n, is_pf: r.is.pf, is_sharpe: r.is.sharpe, is_totalPts: r.is.totalPts,
                  oos_n: r.oos.n, oos_pf: r.oos.pf, oos_sharpe: r.oos.sharpe, oos_totalPts: r.oos.totalPts,
                });
              }
            }
          }
          combos += 2;
        }
      }
    }
  }
  console.log(`Tested ${combos} parameter combinations × 2 variants. Kept ${grid.rejection.length + grid.break.length} with n≥30.`);

  // Sort by Sharpe (and PF tiebreak)
  const sortFn = (a, b) => (b.sharpe ?? 0) - (a.sharpe ?? 0) || (b.pf ?? 0) - (a.pf ?? 0);
  grid.rejection.sort(sortFn);
  grid.break.sort(sortFn);

  console.log('\nTop 10 REJECTION variants by Sharpe:');
  console.log('type'.padEnd(14), 'dist'.padStart(4), 'stop'.padStart(5), 'tgt'.padStart(4),
    'n'.padStart(4), 'WR%'.padStart(6), 'PF'.padStart(6), 'Sharpe'.padStart(8),
    'TotPts'.padStart(8), 'OOS_n'.padStart(6), 'OOS_PF'.padStart(7));
  for (const g of grid.rejection.slice(0, 10)) {
    console.log(
      g.typeName.padEnd(14),
      String(g.maxDistFromOpen).padStart(4),
      String(g.stopPts).padStart(5),
      String(g.targetPts).padStart(4),
      String(g.n).padStart(4),
      (g.winRate * 100).toFixed(1).padStart(6),
      (g.pf === Infinity ? 'INF' : g.pf.toFixed(2)).padStart(6),
      g.sharpe.toFixed(2).padStart(8),
      g.totalPts.toFixed(0).padStart(8),
      String(g.oos_n).padStart(6),
      (g.oos_pf === Infinity ? 'INF' : (g.oos_pf ?? 0).toFixed(2)).padStart(7),
    );
  }

  console.log('\nTop 10 BREAK variants by Sharpe:');
  console.log('type'.padEnd(14), 'dist'.padStart(4), 'stop'.padStart(5), 'tgt'.padStart(4),
    'n'.padStart(4), 'WR%'.padStart(6), 'PF'.padStart(6), 'Sharpe'.padStart(8),
    'TotPts'.padStart(8), 'OOS_n'.padStart(6), 'OOS_PF'.padStart(7));
  for (const g of grid.break.slice(0, 10)) {
    console.log(
      g.typeName.padEnd(14),
      String(g.maxDistFromOpen).padStart(4),
      String(g.stopPts).padStart(5),
      String(g.targetPts).padStart(4),
      String(g.n).padStart(4),
      (g.winRate * 100).toFixed(1).padStart(6),
      (g.pf === Infinity ? 'INF' : g.pf.toFixed(2)).padStart(6),
      g.sharpe.toFixed(2).padStart(8),
      g.totalPts.toFixed(0).padStart(8),
      String(g.oos_n).padStart(6),
      (g.oos_pf === Infinity ? 'INF' : (g.oos_pf ?? 0).toFixed(2)).padStart(7),
    );
  }

  // --- Persist
  console.log('\n[5/5] Writing output...');
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Pull example trade lists for top 3 of each variant for inspection
  const topRej = grid.rejection.slice(0, 3);
  const topBrk = grid.break.slice(0, 3);
  const enriched = async (variant, list) => {
    const out = [];
    for (const g of list) {
      const r = runStrategyBacktest({
        perDay,
        candlesByDate,
        variant,
        levelTypes: typeSetMap[g.typeName],
        maxDistFromOpen: g.maxDistFromOpen,
        stopPts: g.stopPts,
        targetPts: g.targetPts,
        maxHoldBars: g.maxHoldBars,
        oosCutoffDate: OOS_CUTOFF_DATE,
      });
      out.push({ params: g, all: r.all, is: r.is, oos: r.oos, sampleTrades: r.trades.slice(0, 20) });
    }
    return out;
  };

  const output = {
    config: {
      startDate: START_DATE, endDate: END_DATE, oosCutoffDate: OOS_CUTOFF_DATE,
      generated: new Date().toISOString(),
    },
    summary: {
      tradingDays: tradingDates.length,
      analyzedDays: perDay.length,
      skippedRollover: skippedRoll,
      skippedNoSnap: skippedNoSnap,
      skippedNoOpenCandle: skippedNoOpen,
    },
    reactionStats,
    grid: {
      rejection: grid.rejection.slice(0, 50),
      break: grid.break.slice(0, 50),
    },
    topDetails: {
      rejection: await enriched('rejection', topRej),
      break: await enriched('break', topBrk),
    },
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log('Done.');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
