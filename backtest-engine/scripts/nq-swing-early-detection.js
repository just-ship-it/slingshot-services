#!/usr/bin/env node
/**
 * NQ Early Swing Detection Analysis
 *
 * Instead of waiting 8 bars to confirm a swing, detect swing-forming conditions
 * in real-time and enter immediately with tight stops.
 *
 * Detection logic:
 *   1. "Left-side extreme" — candle's high/low is the most extreme in last N bars
 *   2. Feature filters — the OOS-validated features that predict real swings
 *   3. Enter at next bar's open, stop at extreme + buffer
 *
 * Measures:
 *   - What % of flagged candles become true swings (lookback 8)?
 *   - MFE from early entry vs confirmed entry
 *   - Actual P&L with fixed stop levels (5, 8, 10, 12, 15 pts)
 *   - False positive rate and cost
 *
 * Usage:
 *   node scripts/nq-swing-early-detection.js [--start YYYY-MM-DD] [--end YYYY-MM-DD]
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
const outputPath = getArg('output', 'nq-swing-early-detection-results.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

const LEFT_LOOKBACK = 8;  // bars to check on the left side
const FULL_LOOKBACK = 8;  // for verifying true swings
const STOP_LEVELS = [5, 8, 10, 12, 15]; // stop distances to test
const MFE_THRESHOLDS = [15, 20, 25, 30, 40, 50];
const TARGET_LEVELS = [10, 15, 20, 25, 30]; // fixed target distances to test

console.log('='.repeat(90));
console.log('NQ EARLY SWING DETECTION ANALYSIS');
console.log('='.repeat(90));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log(`Left lookback: ${LEFT_LOOKBACK}, Full lookback for verification: ${FULL_LOOKBACK}`);
console.log();

// ============================================================================
// Helpers
// ============================================================================

function formatNum(n, d = 1) { return n === null || isNaN(n) ? 'N/A' : n.toFixed(d); }
function formatPct(n, d = 1) { return n === null || isNaN(n) ? 'N/A' : (n * 100).toFixed(d) + '%'; }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = (p / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

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
// Data Loading
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
    candles.push({
      timestamp, symbol,
      open: parseFloat(parts[4]), high: parseFloat(parts[5]),
      low: parseFloat(parts[6]), close: parseFloat(parts[7]),
      volume: parseInt(parts[8]),
    });
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
    for (const snap of content.data) gexMap.set(round15m(new Date(snap.timestamp).getTime()), snap);
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
      levels: [parseFloat(parts[3]), parseFloat(parts[4]), parseFloat(parts[5]),
               parseFloat(parts[6]), parseFloat(parts[7])]
    });
  }
  console.log(`  Loaded ${ltMap.size} LT snapshots`);
  return ltMap;
}

// ============================================================================
// Early Detection — Candidate Identification
// ============================================================================

/**
 * Scan for "left-side extreme" candles — potential swing points detectable in real-time.
 *
 * A candle at index i is a swing HIGH candidate if:
 *   - candle.high is the highest high of bars [i - LEFT_LOOKBACK, i]
 *   - The swing-side wick shows rejection (upper wick > 0)
 *
 * A candle at index i is a swing LOW candidate if:
 *   - candle.low is the lowest low of bars [i - LEFT_LOOKBACK, i]
 *   - The swing-side wick shows rejection (lower wick > 0)
 */
function findCandidates(candles) {
  const candidates = [];

  for (let i = LEFT_LOOKBACK; i < candles.length - FULL_LOOKBACK - 1; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    if (range < 0.5) continue; // skip near-zero range

    // Check left-side high extreme
    let isLeftHigh = true;
    for (let j = i - LEFT_LOOKBACK; j < i; j++) {
      if (candles[j].high >= c.high) { isLeftHigh = false; break; }
    }

    // Check left-side low extreme
    let isLeftLow = true;
    for (let j = i - LEFT_LOOKBACK; j < i; j++) {
      if (candles[j].low <= c.low) { isLeftLow = false; break; }
    }

    // Compute features for this candle
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const body = Math.abs(c.close - c.open);
    const bodyRatio = range > 0 ? body / range : 0;

    // ATR 20
    let atr20 = 0;
    if (i >= 21) {
      let sum = 0;
      for (let j = i - 20; j < i; j++) {
        sum += Math.max(candles[j].high - candles[j].low,
          Math.abs(candles[j].high - candles[j - 1].close),
          Math.abs(candles[j].low - candles[j - 1].close));
      }
      atr20 = sum / 20;
    }

    // Volume: 20-bar avg
    let avgVol20 = 0;
    if (i >= 20) {
      let sum = 0;
      for (let j = i - 19; j <= i; j++) sum += candles[j].volume;
      avgVol20 = sum / 20;
    }
    const rvol = avgVol20 > 0 ? c.volume / avgVol20 : 1;

    // GEX/LT loaded externally — pass null, set later
    const features = {
      range, body, upperWick, lowerWick, bodyRatio,
      atr20, rvol, volume: c.volume,
    };

    if (isLeftHigh && upperWick > 0) {
      candidates.push({
        index: i, type: 'high', timestamp: c.timestamp,
        swingPrice: c.high, close: c.close, open: c.open,
        risk: upperWick, // distance from close to extreme (for bearish candle)
        features,
      });
    }

    if (isLeftLow && lowerWick > 0) {
      candidates.push({
        index: i, type: 'low', timestamp: c.timestamp,
        swingPrice: c.low, close: c.close, open: c.open,
        risk: lowerWick,
        features,
      });
    }
  }

  return candidates;
}

/**
 * Check if a candidate actually becomes a true lookback-8 swing
 */
function verifyTrueSwing(candles, candidate) {
  const i = candidate.index;
  if (i + FULL_LOOKBACK >= candles.length) return false;

  if (candidate.type === 'high') {
    for (let j = i + 1; j <= i + FULL_LOOKBACK; j++) {
      if (candles[j].high >= candles[i].high) return false;
    }
    return true;
  } else {
    for (let j = i + 1; j <= i + FULL_LOOKBACK; j++) {
      if (candles[j].low <= candles[i].low) return false;
    }
    return true;
  }
}

/**
 * Simulate a trade from early entry with fixed stop and measure outcomes.
 *
 * Entry: next bar's open (bar i+1)
 * Stop: swing extreme + buffer
 * Track: MFE, MAE, P&L at various fixed targets, time to invalidation
 */
function simulateTrade(candles, candidate, stopBuffer) {
  const entryIdx = candidate.index + 1;
  if (entryIdx >= candles.length) return null;

  const entryPrice = candles[entryIdx].open;
  const swingPrice = candidate.swingPrice;

  // Stop level
  const stopPrice = candidate.type === 'high'
    ? swingPrice + stopBuffer
    : swingPrice - stopBuffer;

  const stopDist = candidate.type === 'high'
    ? stopPrice - entryPrice
    : entryPrice - stopPrice;

  let mfe = 0, mae = 0, barsToMFE = 0;
  let exitBar = null, exitPrice = null, exitReason = null;

  // Track target hits
  const targetHits = {};
  for (const t of TARGET_LEVELS) targetHits[t] = null; // bar when target hit

  for (let i = entryIdx; i < candles.length; i++) {
    const c = candles[i];
    const bars = i - entryIdx;

    if (candidate.type === 'high') {
      // SHORT trade
      const favorable = entryPrice - c.low;
      const adverse = c.high - entryPrice;
      if (favorable > mfe) { mfe = favorable; barsToMFE = bars; }
      if (adverse > mae) mae = adverse;

      // Check targets
      for (const t of TARGET_LEVELS) {
        if (targetHits[t] === null && favorable >= t) targetHits[t] = bars;
      }

      // Check stop
      if (c.high >= stopPrice) {
        exitBar = bars;
        exitPrice = stopPrice; // stopped out at stop level
        exitReason = 'stop';
        break;
      }

      // Check invalidation (original swing taken out)
      if (c.high > swingPrice && exitReason !== 'stop') {
        // Price exceeded swing but not stop — still in trade if stop has buffer
      }
    } else {
      // LONG trade
      const favorable = c.high - entryPrice;
      const adverse = entryPrice - c.low;
      if (favorable > mfe) { mfe = favorable; barsToMFE = bars; }
      if (adverse > mae) mae = adverse;

      for (const t of TARGET_LEVELS) {
        if (targetHits[t] === null && favorable >= t) targetHits[t] = bars;
      }

      if (c.low <= stopPrice) {
        exitBar = bars;
        exitPrice = stopPrice;
        exitReason = 'stop';
        break;
      }
    }

    // Max hold: 500 bars (prevent infinite loops)
    if (bars >= 500) {
      exitBar = bars;
      exitPrice = c.close;
      exitReason = 'max_hold';
      break;
    }
  }

  // If never stopped out or max-held, the swing held through end of data
  if (exitReason === null) {
    exitReason = 'end_of_data';
    exitBar = candles.length - 1 - entryIdx;
    exitPrice = candles[candles.length - 1].close;
  }

  return {
    entryPrice, stopPrice, stopDist,
    mfe, mae, barsToMFE,
    exitBar, exitPrice, exitReason,
    targetHits,
    pnl: candidate.type === 'high'
      ? entryPrice - exitPrice
      : exitPrice - entryPrice,
  };
}

// ============================================================================
// Filter Definitions
// ============================================================================

function buildFilterTiers(candles) {
  // Compute median values across all candles for adaptive thresholds
  // Use the candidates' feature distributions from the confluence analysis findings

  return [
    {
      name: 'T0: Left extreme only (no filter)',
      test: (cand, gex, lt) => true,
    },
    {
      name: 'T1: Range ≥ 6 (above-avg candle)',
      test: (cand, gex, lt) => cand.features.range >= 6,
    },
    {
      name: 'T2: Range ≥ 6 + ATR ≥ 5',
      test: (cand, gex, lt) => cand.features.range >= 6 && cand.features.atr20 >= 5,
    },
    {
      name: 'T3: Range ≥ 8.75 + ATR ≥ 6.83',
      test: (cand, gex, lt) =>
        cand.features.range >= 8.75 && cand.features.atr20 >= 6.83,
    },
    {
      name: 'T4: T3 + swing wick ≤ 8pts',
      test: (cand, gex, lt) =>
        cand.features.range >= 8.75 && cand.features.atr20 >= 6.83 &&
        cand.risk <= 8,
    },
    {
      name: 'T5: T3 + body ratio ≥ 0.5 (decisive)',
      test: (cand, gex, lt) =>
        cand.features.range >= 8.75 && cand.features.atr20 >= 6.83 &&
        cand.features.bodyRatio >= 0.5,
    },
    {
      name: 'T6: T3 + neg GEX regime',
      test: (cand, gex, lt) => {
        if (cand.features.range < 8.75 || cand.features.atr20 < 6.83) return false;
        if (!gex) return false;
        const regimeMap = { strong_negative: -2, negative: -1, neutral: 0, positive: 1, strong_positive: 2 };
        return (regimeMap[gex.regime] ?? 0) < 0;
      },
    },
    {
      name: 'T7: T3 + no LT within 30pts',
      test: (cand, gex, lt) => {
        if (cand.features.range < 8.75 || cand.features.atr20 < 6.83) return false;
        if (!lt) return false;
        const levels = lt.levels.filter(l => !isNaN(l) && l > 0);
        return levels.filter(l => Math.abs(cand.swingPrice - l) <= 30).length === 0;
      },
    },
    {
      name: 'T8: T5 + wick ≤ 8 + neg GEX',
      test: (cand, gex, lt) => {
        if (cand.features.range < 8.75 || cand.features.atr20 < 6.83) return false;
        if (cand.features.bodyRatio < 0.5 || cand.risk > 8) return false;
        if (!gex) return false;
        const regimeMap = { strong_negative: -2, negative: -1, neutral: 0, positive: 1, strong_positive: 2 };
        return (regimeMap[gex.regime] ?? 0) < 0;
      },
    },
    {
      name: 'T9: T5 + wick ≤ 10 + no LT near',
      test: (cand, gex, lt) => {
        if (cand.features.range < 8.75 || cand.features.atr20 < 6.83) return false;
        if (cand.features.bodyRatio < 0.5 || cand.risk > 10) return false;
        if (!lt) return true; // allow if no LT data
        const levels = lt.levels.filter(l => !isNaN(l) && l > 0);
        return levels.filter(l => Math.abs(cand.swingPrice - l) <= 30).length === 0;
      },
    },
  ];
}

// ============================================================================
// Add 1s micro features
// ============================================================================

async function addSecondFeatures(candidate, secondProvider) {
  const minuteTs = Math.floor(candidate.timestamp / 60000) * 60000;
  const seconds = await secondProvider.getSecondsForMinute(minuteTs);
  if (seconds.length === 0) return;

  let extremeIdx;
  if (candidate.type === 'high') {
    let best = -Infinity;
    for (let j = 0; j < seconds.length; j++) {
      if (seconds[j].high > best) { best = seconds[j].high; extremeIdx = j; }
    }
  } else {
    let best = Infinity;
    for (let j = 0; j < seconds.length; j++) {
      if (seconds[j].low < best) { best = seconds[j].low; extremeIdx = j; }
    }
  }

  const totalVol = seconds.reduce((sum, s) => sum + s.volume, 0);
  let windowVol = 0;
  for (let j = Math.max(0, extremeIdx - 2); j <= Math.min(seconds.length - 1, extremeIdx + 2); j++) {
    windowVol += seconds[j].volume;
  }

  let secHigh = -Infinity, secLow = Infinity;
  for (const s of seconds) {
    if (s.high > secHigh) secHigh = s.high;
    if (s.low < secLow) secLow = s.low;
  }

  candidate.features.volConcentration = totalVol > 0 ? windowVol / totalVol : 0;
  candidate.features.sweepSpeed = extremeIdx;
  candidate.features.intrabarRange = secHigh - secLow;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const t0 = Date.now();

  console.log('PHASE 1: Loading data...\n');
  const candles = await loadOHLCVData();
  if (!candles.length) { console.error('No candles.'); process.exit(1); }

  const secondPath = path.join(dataDir, 'ohlcv/nq/NQ_ohlcv_1s.csv');
  const secondProvider = new SecondDataProvider(secondPath);
  await secondProvider.initialize();

  const gexMap = await loadGEXData();
  const ltMap = await loadLTData();

  console.log(`\nData loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Find all candidates
  console.log('PHASE 2: Finding left-side extreme candidates...\n');
  const candidates = findCandidates(candles);
  console.log(`  Found ${candidates.length} left-side extreme candidates`);

  // Add 1s features
  console.log('  Adding 1s micro features...');
  const progressInterval = Math.max(1, Math.floor(candidates.length / 10));
  for (let i = 0; i < candidates.length; i++) {
    await addSecondFeatures(candidates[i], secondProvider);
    if ((i + 1) % progressInterval === 0) process.stdout.write(`    ${i + 1}/${candidates.length}\r`);
  }
  console.log(`    Done.                            `);

  // Verify which are true swings
  console.log('\n  Verifying true swings...');
  for (const cand of candidates) {
    cand.isTrueSwing = verifyTrueSwing(candles, cand);
  }
  const trueSwings = candidates.filter(c => c.isTrueSwing);
  console.log(`  True swings: ${trueSwings.length} / ${candidates.length} (${formatPct(trueSwings.length / candidates.length)})`);

  // Build filter tiers
  const filterTiers = buildFilterTiers(candles);

  // ============================================================================
  // PHASE 3: Analyze each filter tier
  // ============================================================================

  console.log('\nPHASE 3: Analyzing filter tiers...\n');

  console.log('='.repeat(130));
  console.log('FILTER TIER OVERVIEW');
  console.log('='.repeat(130));

  console.log(`\n  ${'Tier'.padEnd(42)} ${'Cands'.padStart(7)} ${'True%'.padStart(7)} ${'Swings'.padStart(7)} ${'Wick med'.padStart(9)} ${'Wick P75'.padStart(9)} ${'Range med'.padStart(10)}`);
  console.log(`  ${'─'.repeat(95)}`);

  const tierResults = [];

  for (const tier of filterTiers) {
    const filtered = candidates.filter(c => {
      const gexKey = round15m(c.timestamp);
      let gex = null;
      for (let off = 0; off <= 4; off++) {
        gex = gexMap.get(gexKey - off * 15 * 60 * 1000);
        if (gex) break;
      }
      let lt = null;
      for (let off = 0; off <= 4; off++) {
        lt = ltMap.get(gexKey - off * 15 * 60 * 1000);
        if (lt) break;
      }
      return tier.test(c, gex, lt);
    });

    if (filtered.length === 0) {
      tierResults.push({ name: tier.name, count: 0 });
      continue;
    }

    const trueCount = filtered.filter(c => c.isTrueSwing).length;
    const trueRate = trueCount / filtered.length;
    const wicks = filtered.map(c => c.risk);
    const ranges = filtered.map(c => c.features.range);

    console.log(`  ${tier.name.padEnd(42)} ${String(filtered.length).padStart(7)} ${formatPct(trueRate).padStart(7)} ${String(trueCount).padStart(7)} ${formatNum(median(wicks)).padStart(9)} ${formatNum(percentile(wicks, 75)).padStart(9)} ${formatNum(median(ranges)).padStart(10)}`);

    tierResults.push({
      name: tier.name,
      count: filtered.length,
      trueCount,
      trueRate,
      wickMedian: median(wicks),
      wickP75: percentile(wicks, 75),
      filtered,
    });
  }

  // ============================================================================
  // PHASE 4: P&L simulation for each tier × stop level
  // ============================================================================

  console.log('\n' + '='.repeat(130));
  console.log('P&L SIMULATION: STOP LEVEL × FILTER TIER (MFE ≥ 30pts win rate + avg P&L per trade)');
  console.log('='.repeat(130));

  // For each meaningful tier, simulate trades at each stop level
  const significantTiers = tierResults.filter(t => t.count >= 50);

  for (const stopLevel of STOP_LEVELS) {
    console.log(`\n  STOP = ${stopLevel} pts`);
    console.log(`  ${'Tier'.padEnd(42)} ${'Trades'.padStart(7)} ${'MFE≥30'.padStart(8)} ${'Win%'.padStart(7)} ${'Stopped'.padStart(8)} ${'Avg P&L'.padStart(8)} ${'Med P&L'.padStart(8)} ${'Total'.padStart(10)} ${'PF'.padStart(6)}`);
    console.log(`  ${'─'.repeat(108)}`);

    for (const tier of significantTiers) {
      // Filter candidates that pass this tier AND have swing-side wick ≤ stop
      // (otherwise the stop would be hit immediately at entry)
      const eligible = tier.filtered.filter(c => c.risk <= stopLevel);
      if (eligible.length < 20) continue;

      const trades = [];
      for (const cand of eligible) {
        const trade = simulateTrade(candles, cand, stopLevel - cand.risk); // buffer = stop - wick
        if (trade) trades.push({ ...trade, isTrueSwing: cand.isTrueSwing, type: cand.type });
      }

      if (trades.length === 0) continue;

      const mfe30 = trades.filter(t => t.mfe >= 30).length;
      const stopped = trades.filter(t => t.exitReason === 'stop').length;
      const pnls = trades.map(t => t.pnl);
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      const grossWin = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
      const grossLoss = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
      const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;

      console.log(`  ${tier.name.padEnd(42)} ${String(trades.length).padStart(7)} ${String(mfe30).padStart(8)} ${formatPct(mfe30 / trades.length).padStart(7)} ${formatPct(stopped / trades.length).padStart(8)} ${formatNum(mean(pnls)).padStart(8)} ${formatNum(median(pnls)).padStart(8)} ${formatNum(totalPnl, 0).padStart(10)} ${formatNum(pf).padStart(6)}`);
    }
  }

  // ============================================================================
  // PHASE 5: Fixed target analysis — best tier
  // ============================================================================

  console.log('\n' + '='.repeat(130));
  console.log('FIXED TARGET + STOP ANALYSIS (best tiers, stop = 8pts)');
  console.log('='.repeat(130));

  const ANALYSIS_STOP = 8;
  const bestTiers = significantTiers.filter(t => t.trueRate >= 0.3 && t.count >= 100);

  for (const tier of bestTiers) {
    const eligible = tier.filtered.filter(c => c.risk <= ANALYSIS_STOP);
    if (eligible.length < 30) continue;

    console.log(`\n  ${tier.name} (${eligible.length} trades with wick ≤ ${ANALYSIS_STOP}pts)`);

    // Simulate trades with stop = 8
    const trades = [];
    for (const cand of eligible) {
      const trade = simulateTrade(candles, cand, ANALYSIS_STOP - cand.risk);
      if (trade) trades.push(trade);
    }

    console.log(`  ${'Target'.padEnd(10)} ${'Hits'.padStart(6)} ${'Hit%'.padStart(7)} ${'Stops'.padStart(6)} ${'Stop%'.padStart(7)} ${'Other'.padStart(6)} ${'Avg P&L'.padStart(8)} ${'Total'.padStart(10)} ${'PF'.padStart(6)} ${'W:L Ratio'.padStart(10)}`);
    console.log(`  ${'─'.repeat(80)}`);

    for (const target of TARGET_LEVELS) {
      // Re-simulate with explicit target exit
      let hits = 0, stops = 0, other = 0;
      const pnls = [];

      for (const cand of eligible) {
        const entryIdx = cand.index + 1;
        if (entryIdx >= candles.length) continue;
        const entryPrice = candles[entryIdx].open;
        const stopPrice = cand.type === 'high'
          ? cand.swingPrice + (ANALYSIS_STOP - cand.risk)
          : cand.swingPrice - (ANALYSIS_STOP - cand.risk);
        const targetPrice = cand.type === 'high'
          ? entryPrice - target
          : entryPrice + target;

        let pnl = 0, reason = 'max_hold';

        for (let i = entryIdx; i < Math.min(candles.length, entryIdx + 500); i++) {
          const c = candles[i];
          if (cand.type === 'high') {
            // Check stop first (worst case)
            if (c.high >= stopPrice) { pnl = -(stopPrice - entryPrice); reason = 'stop'; break; }
            // Check target
            if (c.low <= targetPrice) { pnl = target; reason = 'target'; break; }
          } else {
            if (c.low <= stopPrice) { pnl = -(entryPrice - stopPrice); reason = 'stop'; break; }
            if (c.high >= targetPrice) { pnl = target; reason = 'target'; break; }
          }
        }

        if (reason === 'max_hold') {
          // Close at last candle
          const lastC = candles[Math.min(candles.length - 1, entryIdx + 499)];
          pnl = cand.type === 'high' ? entryPrice - lastC.close : lastC.close - entryPrice;
        }

        pnls.push(pnl);
        if (reason === 'target') hits++;
        else if (reason === 'stop') stops++;
        else other++;
      }

      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      const grossWin = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
      const grossLoss = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
      const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
      const rr = ANALYSIS_STOP > 0 ? target / ANALYSIS_STOP : 0;

      console.log(`  ${(target + 'pts').padEnd(10)} ${String(hits).padStart(6)} ${formatPct(hits / pnls.length).padStart(7)} ${String(stops).padStart(6)} ${formatPct(stops / pnls.length).padStart(7)} ${String(other).padStart(6)} ${formatNum(mean(pnls)).padStart(8)} ${formatNum(totalPnl, 0).padStart(10)} ${formatNum(pf).padStart(6)} ${formatNum(rr, 1).padStart(10)}`);
    }
  }

  // ============================================================================
  // PHASE 6: Session breakdown for best tiers
  // ============================================================================

  console.log('\n' + '='.repeat(130));
  console.log('SESSION BREAKDOWN (stop = 8pts, target = 20pts)');
  console.log('='.repeat(130));

  const TARGET_FOR_SESSION = 20;
  const sessions = ['rth', 'premarket', 'overnight'];

  for (const tier of bestTiers.slice(0, 4)) {
    const eligible = tier.filtered.filter(c => c.risk <= ANALYSIS_STOP);
    if (eligible.length < 30) continue;

    console.log(`\n  ${tier.name}`);
    console.log(`  ${'Session'.padEnd(14)} ${'Trades'.padStart(7)} ${'Hits'.padStart(6)} ${'Hit%'.padStart(7)} ${'Stops'.padStart(6)} ${'Stop%'.padStart(7)} ${'Avg P&L'.padStart(8)} ${'Total'.padStart(10)}`);
    console.log(`  ${'─'.repeat(70)}`);

    for (const sess of sessions) {
      const sessEligible = eligible.filter(c => getSession(c.timestamp) === sess);
      if (sessEligible.length < 10) continue;

      let hits = 0, stops = 0;
      const pnls = [];

      for (const cand of sessEligible) {
        const entryIdx = cand.index + 1;
        if (entryIdx >= candles.length) continue;
        const entryPrice = candles[entryIdx].open;
        const stopPrice = cand.type === 'high'
          ? cand.swingPrice + (ANALYSIS_STOP - cand.risk)
          : cand.swingPrice - (ANALYSIS_STOP - cand.risk);
        const targetPrice = cand.type === 'high'
          ? entryPrice - TARGET_FOR_SESSION
          : entryPrice + TARGET_FOR_SESSION;

        let pnl = 0, reason = 'max_hold';
        for (let i = entryIdx; i < Math.min(candles.length, entryIdx + 500); i++) {
          const c = candles[i];
          if (cand.type === 'high') {
            if (c.high >= stopPrice) { pnl = -(stopPrice - entryPrice); reason = 'stop'; break; }
            if (c.low <= targetPrice) { pnl = TARGET_FOR_SESSION; reason = 'target'; break; }
          } else {
            if (c.low <= stopPrice) { pnl = -(entryPrice - stopPrice); reason = 'stop'; break; }
            if (c.high >= targetPrice) { pnl = TARGET_FOR_SESSION; reason = 'target'; break; }
          }
        }
        if (reason === 'max_hold') {
          const lastC = candles[Math.min(candles.length - 1, entryIdx + 499)];
          pnl = cand.type === 'high' ? entryPrice - lastC.close : lastC.close - entryPrice;
        }

        pnls.push(pnl);
        if (reason === 'target') hits++;
        else if (reason === 'stop') stops++;
      }

      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      console.log(`  ${sess.padEnd(14)} ${String(pnls.length).padStart(7)} ${String(hits).padStart(6)} ${formatPct(hits / pnls.length).padStart(7)} ${String(stops).padStart(6)} ${formatPct(stops / pnls.length).padStart(7)} ${formatNum(mean(pnls)).padStart(8)} ${formatNum(totalPnl, 0).padStart(10)}`);
    }
  }

  // ============================================================================
  // Summary
  // ============================================================================

  console.log('\n' + '='.repeat(130));
  console.log('SUMMARY');
  console.log('='.repeat(130));

  console.log(`\n  Total candidates found: ${candidates.length}`);
  console.log(`  True swing rate (unfiltered): ${formatPct(trueSwings.length / candidates.length)}`);

  // Find best tier/stop/target combo by total P&L
  console.log(`\n  Wick (stop distance) distribution across all candidates:`);
  const allWicks = candidates.map(c => c.risk);
  console.log(`    Mean: ${formatNum(mean(allWicks))} | Median: ${formatNum(median(allWicks))} | P75: ${formatNum(percentile(allWicks, 75))} | P90: ${formatNum(percentile(allWicks, 90))}`);
  console.log(`    ≤ 5pts: ${formatPct(allWicks.filter(w => w <= 5).length / allWicks.length)} | ≤ 8pts: ${formatPct(allWicks.filter(w => w <= 8).length / allWicks.length)} | ≤ 10pts: ${formatPct(allWicks.filter(w => w <= 10).length / allWicks.length)} | ≤ 12pts: ${formatPct(allWicks.filter(w => w <= 12).length / allWicks.length)}`);

  console.log(`\nRuntime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Save results
  const output = {
    config: { startDate: startDateStr, endDate: endDateStr, leftLookback: LEFT_LOOKBACK, fullLookback: FULL_LOOKBACK },
    summary: {
      totalCandidates: candidates.length,
      trueSwings: trueSwings.length,
      trueSwingRate: trueSwings.length / candidates.length,
    },
    tiers: tierResults.map(t => ({
      name: t.name, count: t.count, trueCount: t.trueCount, trueRate: t.trueRate,
      wickMedian: t.wickMedian, wickP75: t.wickP75,
    })),
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Results saved to ${outputPath}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
