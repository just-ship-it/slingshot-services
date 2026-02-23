#!/usr/bin/env node
/**
 * NQ Swing MAE/MFE Path Analysis + Trailing Stop Exits
 *
 * The v2 early detection showed fixed stop/target exits don't produce edge.
 * This script answers:
 *   1. What does the bar-by-bar price path look like after entry?
 *   2. How much MAE occurs BEFORE the MFE? (can we survive with tight stops?)
 *   3. Do trailing stops capture the favorable move better than fixed targets?
 *
 * Tests:
 *   - MAE distribution for winning vs losing trades
 *   - Trailing stop exits (various trail distances + activation triggers)
 *   - Hybrid: fixed stop + trailing take-profit (no fixed target)
 *   - Time decay: P&L by holding period
 *
 * Usage:
 *   node scripts/nq-swing-mae-trailing.js [--start YYYY-MM-DD] [--end YYYY-MM-DD]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
};

const startDateStr = getArg('start', '2025-01-01');
const endDateStr = getArg('end', '2025-07-31');
const outputPath = getArg('output', 'nq-swing-mae-trailing-results.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

const LEFT_LOOKBACK = 8;
const FULL_LOOKBACK = 8;
const CONFIRM_LEVELS = [2, 3, 4];
const MAX_HOLD_BARS = 120; // 2 hours max hold

console.log('='.repeat(120));
console.log('NQ SWING MAE/MFE PATH ANALYSIS + TRAILING STOP EXITS');
console.log('='.repeat(120));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log(`Confirmation levels: ${CONFIRM_LEVELS.join(', ')} bars`);
console.log(`Max hold: ${MAX_HOLD_BARS} bars (${MAX_HOLD_BARS} minutes)`);
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
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
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

function getGexRegime(gexMap, timestamp) {
  const key = round15m(timestamp);
  for (let off = 0; off <= 4; off++) {
    const snap = gexMap.get(key - off * 15 * 60 * 1000);
    if (snap) {
      const map = { strong_negative: -2, negative: -1, neutral: 0, positive: 1, strong_positive: 2 };
      return map[snap.regime] ?? null;
    }
  }
  return null;
}

// ============================================================================
// Swing Detection with Partial Confirmation
// ============================================================================

function findSwingsWithConfirmation(candles, confirmBars) {
  const swings = [];

  for (let i = LEFT_LOOKBACK; i < candles.length - confirmBars - 2; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    if (range < 0.5) continue;

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

    // Check swing HIGH
    let isHigh = true;
    for (let j = i - LEFT_LOOKBACK; j < i; j++) {
      if (candles[j].high >= c.high) { isHigh = false; break; }
    }
    if (isHigh) {
      for (let j = i + 1; j <= i + confirmBars; j++) {
        if (j >= candles.length || candles[j].high >= c.high) { isHigh = false; break; }
      }
    }

    // Check swing LOW
    let isLow = true;
    for (let j = i - LEFT_LOOKBACK; j < i; j++) {
      if (candles[j].low <= c.low) { isLow = false; break; }
    }
    if (isLow) {
      for (let j = i + 1; j <= i + confirmBars; j++) {
        if (j >= candles.length || candles[j].low <= c.low) { isLow = false; break; }
      }
    }

    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const body = Math.abs(c.close - c.open);

    if (isHigh && upperWick > 0) {
      const entryIdx = i + confirmBars + 1;
      if (entryIdx >= candles.length) continue;
      const entryPrice = candles[entryIdx].open;
      swings.push({
        index: i, type: 'high', timestamp: c.timestamp,
        swingPrice: c.high, entryIdx, entryPrice,
        risk: c.high - entryPrice,
        wick: upperWick, range, body, atr20,
        bodyRatio: range > 0 ? body / range : 0,
        session: getSession(c.timestamp),
      });
    }

    if (isLow && lowerWick > 0) {
      const entryIdx = i + confirmBars + 1;
      if (entryIdx >= candles.length) continue;
      const entryPrice = candles[entryIdx].open;
      swings.push({
        index: i, type: 'low', timestamp: c.timestamp,
        swingPrice: c.low, entryIdx, entryPrice,
        risk: entryPrice - c.low,
        wick: lowerWick, range, body, atr20,
        bodyRatio: range > 0 ? body / range : 0,
        session: getSession(c.timestamp),
      });
    }
  }

  return swings;
}

function isTrueSwing(candles, idx, type) {
  if (idx + FULL_LOOKBACK >= candles.length || idx < FULL_LOOKBACK) return false;
  if (type === 'high') {
    for (let j = idx - FULL_LOOKBACK; j <= idx + FULL_LOOKBACK; j++) {
      if (j !== idx && candles[j].high >= candles[idx].high) return false;
    }
  } else {
    for (let j = idx - FULL_LOOKBACK; j <= idx + FULL_LOOKBACK; j++) {
      if (j !== idx && candles[j].low <= candles[idx].low) return false;
    }
  }
  return true;
}

// ============================================================================
// Bar-by-bar path tracking
// ============================================================================

/**
 * Track the full price path from entry for maxBars, recording MFE and MAE
 * at each bar. This gives us the "excursion profile" of each trade.
 */
function trackPricePath(candles, swing, maxBars) {
  const entryIdx = swing.entryIdx;
  const entryPrice = swing.entryPrice;
  const path = [];

  let runningMFE = 0, runningMAE = 0;

  for (let i = 0; i < maxBars; i++) {
    const ci = entryIdx + i;
    if (ci >= candles.length) break;
    const c = candles[ci];

    let fav, adv;
    if (swing.type === 'high') {
      // Short trade: favorable = price going down
      fav = entryPrice - c.low;
      adv = c.high - entryPrice;
    } else {
      // Long trade: favorable = price going up
      fav = c.high - entryPrice;
      adv = entryPrice - c.low;
    }

    if (fav > runningMFE) runningMFE = fav;
    if (adv > runningMAE) runningMAE = adv;

    path.push({
      bar: i,
      mfe: runningMFE,
      mae: runningMAE,
      closeExcursion: swing.type === 'high'
        ? entryPrice - c.close
        : c.close - entryPrice,
    });
  }

  return { path, mfe: runningMFE, mae: runningMAE };
}

// ============================================================================
// Trailing stop simulation
// ============================================================================

/**
 * Simulate a trade with:
 *   - Fixed stop loss (below swing extreme + buffer)
 *   - Trailing take-profit: once price moves `triggerPts` in favor, trail at `trailDist`
 *   - Optional fixed target as a cap
 *   - Max hold time
 */
function simulateTrailing(candles, swing, stopDist, triggerPts, trailDist, fixedTarget, maxBars) {
  const entryIdx = swing.entryIdx;
  const entryPrice = swing.entryPrice;

  const stopPrice = swing.type === 'high'
    ? entryPrice + stopDist
    : entryPrice - stopDist;

  let trailActive = false;
  let trailStop = null; // Price level of the trailing stop
  let bestPrice = entryPrice; // Best price seen (for trailing)
  let mfe = 0, mae = 0;

  for (let i = 0; i < maxBars; i++) {
    const ci = entryIdx + i;
    if (ci >= candles.length) break;
    const c = candles[ci];

    if (swing.type === 'high') {
      // Short trade
      const favHigh = entryPrice - c.low;
      const advHigh = c.high - entryPrice;
      if (favHigh > mfe) mfe = favHigh;
      if (advHigh > mae) mae = advHigh;

      // Fixed stop check (adverse side)
      if (c.high >= stopPrice) {
        return { pnl: -stopDist, reason: 'stop', mfe, mae, bars: i, trailActive };
      }

      // Fixed target check
      if (fixedTarget > 0) {
        const targetPrice = entryPrice - fixedTarget;
        if (c.low <= targetPrice) {
          return { pnl: fixedTarget, reason: 'target', mfe, mae, bars: i, trailActive };
        }
      }

      // Update best price (lowest price for short)
      if (c.low < bestPrice) bestPrice = c.low;

      // Activate trailing stop
      if (!trailActive && (entryPrice - bestPrice) >= triggerPts) {
        trailActive = true;
      }

      // Update trailing stop level
      if (trailActive) {
        const newTrail = bestPrice + trailDist;
        if (trailStop === null || newTrail < trailStop) {
          trailStop = newTrail;
        }
        // Check if trail hit
        if (c.high >= trailStop) {
          const pnl = entryPrice - trailStop;
          return { pnl, reason: 'trail', mfe, mae, bars: i, trailActive };
        }
      }
    } else {
      // Long trade
      const favHigh = c.high - entryPrice;
      const advHigh = entryPrice - c.low;
      if (favHigh > mfe) mfe = favHigh;
      if (advHigh > mae) mae = advHigh;

      // Fixed stop check
      if (c.low <= stopPrice) {
        return { pnl: -stopDist, reason: 'stop', mfe, mae, bars: i, trailActive };
      }

      // Fixed target check
      if (fixedTarget > 0) {
        const targetPrice = entryPrice + fixedTarget;
        if (c.high >= targetPrice) {
          return { pnl: fixedTarget, reason: 'target', mfe, mae, bars: i, trailActive };
        }
      }

      // Update best price (highest price for long)
      if (c.high > bestPrice) bestPrice = c.high;

      // Activate trailing stop
      if (!trailActive && (bestPrice - entryPrice) >= triggerPts) {
        trailActive = true;
      }

      // Update trailing stop level
      if (trailActive) {
        const newTrail = bestPrice - trailDist;
        if (trailStop === null || newTrail > trailStop) {
          trailStop = newTrail;
        }
        if (c.low <= trailStop) {
          const pnl = trailStop - entryPrice;
          return { pnl, reason: 'trail', mfe, mae, bars: i, trailActive };
        }
      }
    }
  }

  // Max hold exit
  const lastClose = candles[Math.min(candles.length - 1, entryIdx + maxBars - 1)].close;
  const pnl = swing.type === 'high' ? entryPrice - lastClose : lastClose - entryPrice;
  return { pnl, reason: 'max_hold', mfe, mae, bars: maxBars, trailActive };
}

// ============================================================================
// Analysis helpers
// ============================================================================

function summarizeResults(results) {
  const pnls = results.map(r => r.pnl);
  const wins = results.filter(r => r.pnl > 0);
  const losses = results.filter(r => r.pnl <= 0);
  const grossWin = wins.reduce((a, r) => a + r.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, r) => a + r.pnl, 0));

  return {
    count: results.length,
    winRate: results.length > 0 ? wins.length / results.length : 0,
    avgPnl: mean(pnls),
    medPnl: median(pnls),
    totalPnl: pnls.reduce((a, b) => a + b, 0),
    pf: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    avgWin: wins.length > 0 ? mean(wins.map(r => r.pnl)) : 0,
    avgLoss: losses.length > 0 ? mean(losses.map(r => r.pnl)) : 0,
    avgBars: mean(results.map(r => r.bars)),
    stopCount: results.filter(r => r.reason === 'stop').length,
    trailCount: results.filter(r => r.reason === 'trail').length,
    targetCount: results.filter(r => r.reason === 'target').length,
    maxHoldCount: results.filter(r => r.reason === 'max_hold').length,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const t0 = Date.now();

  console.log('PHASE 1: Loading data...\n');
  const candles = await loadOHLCVData();
  if (!candles.length) { console.error('No candles.'); process.exit(1); }
  const gexMap = await loadGEXData();

  console.log(`\nData loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const allResults = {};

  for (const confirmBars of CONFIRM_LEVELS) {
    console.log('='.repeat(120));
    console.log(`CONFIRMATION = ${confirmBars} BARS`);
    console.log('='.repeat(120));

    const swings = findSwingsWithConfirmation(candles, confirmBars);
    for (const s of swings) {
      s.isTrueSwing = isTrueSwing(candles, s.index, s.type);
      s.gexRegime = getGexRegime(gexMap, s.timestamp);
    }

    const trueCount = swings.filter(s => s.isTrueSwing).length;
    console.log(`\n  Total candidates: ${swings.length}`);
    console.log(`  True swings (8-bar): ${trueCount} (${formatPct(trueCount / swings.length)})`);
    console.log(`  Entry slippage: mean ${formatNum(mean(swings.map(s => s.risk)))} | med ${formatNum(median(swings.map(s => s.risk)))} pts`);

    // ========================================================================
    // PHASE 2: MAE/MFE Path Analysis
    // ========================================================================

    console.log(`\n  ${'─'.repeat(110)}`);
    console.log(`  MAE/MFE PATH ANALYSIS (all candidates, ${MAX_HOLD_BARS}-bar window)`);
    console.log(`  ${'─'.repeat(110)}`);

    const paths = swings.map(s => ({ ...s, ...trackPricePath(candles, s, MAX_HOLD_BARS) }));

    // Overall MAE/MFE distribution
    const allMAE = paths.map(p => p.mae);
    const allMFE = paths.map(p => p.mfe);

    console.log(`\n  Overall MAE distribution:`);
    console.log(`    Mean: ${formatNum(mean(allMAE))}  Median: ${formatNum(median(allMAE))}  P75: ${formatNum(percentile(allMAE, 75))}  P90: ${formatNum(percentile(allMAE, 90))}`);
    console.log(`    MAE ≤ 5pts: ${formatPct(allMAE.filter(x => x <= 5).length / allMAE.length)}  ≤ 8: ${formatPct(allMAE.filter(x => x <= 8).length / allMAE.length)}  ≤ 10: ${formatPct(allMAE.filter(x => x <= 10).length / allMAE.length)}  ≤ 15: ${formatPct(allMAE.filter(x => x <= 15).length / allMAE.length)}`);

    console.log(`\n  Overall MFE distribution:`);
    console.log(`    Mean: ${formatNum(mean(allMFE))}  Median: ${formatNum(median(allMFE))}  P75: ${formatNum(percentile(allMFE, 75))}  P90: ${formatNum(percentile(allMFE, 90))}`);
    console.log(`    MFE ≥ 15pts: ${formatPct(allMFE.filter(x => x >= 15).length / allMFE.length)}  ≥ 20: ${formatPct(allMFE.filter(x => x >= 20).length / allMFE.length)}  ≥ 30: ${formatPct(allMFE.filter(x => x >= 30).length / allMFE.length)}  ≥ 50: ${formatPct(allMFE.filter(x => x >= 50).length / allMFE.length)}`);

    // MAE/MFE for winners (MFE ≥ 30) vs losers
    const winners = paths.filter(p => p.mfe >= 30);
    const losers = paths.filter(p => p.mfe < 30);
    console.log(`\n  Winners (MFE ≥ 30pts, n=${winners.length}):`);
    console.log(`    MAE: mean ${formatNum(mean(winners.map(p => p.mae)))}  med ${formatNum(median(winners.map(p => p.mae)))}  MAE≤8: ${formatPct(winners.filter(p => p.mae <= 8).length / winners.length)}  MAE≤10: ${formatPct(winners.filter(p => p.mae <= 10).length / winners.length)}  MAE≤15: ${formatPct(winners.filter(p => p.mae <= 15).length / winners.length)}`);
    console.log(`  Losers (MFE < 30pts, n=${losers.length}):`);
    console.log(`    MAE: mean ${formatNum(mean(losers.map(p => p.mae)))}  med ${formatNum(median(losers.map(p => p.mae)))}  MAE≤8: ${formatPct(losers.filter(p => p.mae <= 8).length / losers.length)}  MAE≤10: ${formatPct(losers.filter(p => p.mae <= 10).length / losers.length)}  MAE≤15: ${formatPct(losers.filter(p => p.mae <= 15).length / losers.length)}`);

    // KEY QUESTION: Of trades where MAE ≤ 8, what % eventually reach 20+ MFE?
    console.log(`\n  Conditional MFE given MAE threshold (survival analysis):`);
    console.log(`  ${'MAE ≤'.padEnd(10)} ${'Count'.padStart(7)} ${'MFE≥15%'.padStart(8)} ${'MFE≥20%'.padStart(8)} ${'MFE≥25%'.padStart(8)} ${'MFE≥30%'.padStart(8)} ${'MFE≥40%'.padStart(8)} ${'MFE≥50%'.padStart(8)} ${'Avg MFE'.padStart(8)}`);
    console.log(`  ${'─'.repeat(75)}`);
    for (const maeThresh of [5, 8, 10, 12, 15, 20, 999]) {
      const label = maeThresh === 999 ? 'all' : `${maeThresh}pts`;
      const subset = paths.filter(p => p.mae <= maeThresh);
      if (subset.length < 10) continue;
      const mfes = subset.map(p => p.mfe);
      console.log(`  ${label.padEnd(10)} ${String(subset.length).padStart(7)} ${formatPct(mfes.filter(x => x >= 15).length / mfes.length).padStart(8)} ${formatPct(mfes.filter(x => x >= 20).length / mfes.length).padStart(8)} ${formatPct(mfes.filter(x => x >= 25).length / mfes.length).padStart(8)} ${formatPct(mfes.filter(x => x >= 30).length / mfes.length).padStart(8)} ${formatPct(mfes.filter(x => x >= 40).length / mfes.length).padStart(8)} ${formatPct(mfes.filter(x => x >= 50).length / mfes.length).padStart(8)} ${formatNum(mean(mfes)).padStart(8)}`);
    }

    // Average excursion profile: how does MAE/MFE evolve bar by bar?
    console.log(`\n  Average excursion profile (first 30 bars):`);
    console.log(`  ${'Bar'.padEnd(6)} ${'Avg MFE'.padStart(8)} ${'Avg MAE'.padStart(8)} ${'Med MFE'.padStart(8)} ${'Med MAE'.padStart(8)} ${'P&L(close)'.padStart(10)}`);
    console.log(`  ${'─'.repeat(50)}`);
    for (const bar of [1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60, 90, 120]) {
      const pathsWithBar = paths.filter(p => p.path.length > bar);
      if (pathsWithBar.length < 50) continue;
      const barData = pathsWithBar.map(p => p.path[bar]);
      console.log(`  ${String(bar).padEnd(6)} ${formatNum(mean(barData.map(b => b.mfe))).padStart(8)} ${formatNum(mean(barData.map(b => b.mae))).padStart(8)} ${formatNum(median(barData.map(b => b.mfe))).padStart(8)} ${formatNum(median(barData.map(b => b.mae))).padStart(8)} ${formatNum(mean(barData.map(b => b.closeExcursion))).padStart(10)}`);
    }

    // ========================================================================
    // PHASE 3: Trailing Stop Grid
    // ========================================================================

    console.log(`\n  ${'─'.repeat(110)}`);
    console.log(`  TRAILING STOP P&L GRID (all candidates)`);
    console.log(`  ${'─'.repeat(110)}`);

    // Grid: stop × trail trigger × trail distance
    const STOPS = [8, 10, 12, 15];
    const TRIGGERS = [5, 8, 10, 15]; // pts profit before trail activates
    const TRAILS = [3, 5, 8, 10]; // trail distance once active

    // First, try pure trailing (no fixed target)
    console.log(`\n  Pure trailing stop (no fixed target, max hold ${MAX_HOLD_BARS} bars)`);
    console.log(`  ${'Stop'.padEnd(7)} ${'Trig'.padEnd(7)} ${'Trail'.padEnd(7)} ${'Trades'.padStart(7)} ${'Win%'.padStart(7)} ${'Avg'.padStart(7)} ${'Med'.padStart(7)} ${'Total'.padStart(9)} ${'PF'.padStart(6)} ${'AvgW'.padStart(7)} ${'AvgL'.padStart(7)} ${'Stops%'.padStart(7)} ${'Trail%'.padStart(7)} ${'Bars'.padStart(6)}`);
    console.log(`  ${'─'.repeat(100)}`);

    let bestPF = 0, bestConfig = '';
    const gridResults = [];

    for (const stop of STOPS) {
      const eligible = swings.filter(s => s.risk <= stop);
      if (eligible.length < 30) continue;

      for (const trigger of TRIGGERS) {
        for (const trail of TRAILS) {
          if (trail >= trigger) continue; // trail must be tighter than trigger
          const results = eligible.map(s => simulateTrailing(candles, s, stop, trigger, trail, 0, MAX_HOLD_BARS));
          const sum = summarizeResults(results);

          const row = { stop, trigger, trail, fixedTarget: 0, ...sum };
          gridResults.push(row);

          if (sum.pf > bestPF && sum.count >= 100) {
            bestPF = sum.pf;
            bestConfig = `stop=${stop} trig=${trigger} trail=${trail}`;
          }

          console.log(`  ${(stop + 'pt').padEnd(7)} ${(trigger + 'pt').padEnd(7)} ${(trail + 'pt').padEnd(7)} ${String(sum.count).padStart(7)} ${formatPct(sum.winRate).padStart(7)} ${formatNum(sum.avgPnl).padStart(7)} ${formatNum(sum.medPnl).padStart(7)} ${formatNum(sum.totalPnl, 0).padStart(9)} ${formatNum(sum.pf).padStart(6)} ${formatNum(sum.avgWin).padStart(7)} ${formatNum(sum.avgLoss).padStart(7)} ${formatPct(sum.stopCount / sum.count).padStart(7)} ${formatPct(sum.trailCount / sum.count).padStart(7)} ${formatNum(sum.avgBars, 0).padStart(6)}`);
        }
      }
    }

    console.log(`\n  Best config: ${bestConfig} (PF ${formatNum(bestPF)})`);

    // ========================================================================
    // PHASE 4: Hybrid — fixed stop + trailing + fixed cap target
    // ========================================================================

    console.log(`\n  ${'─'.repeat(110)}`);
    console.log(`  HYBRID: FIXED STOP + TRAILING + OPTIONAL CAP TARGET`);
    console.log(`  ${'─'.repeat(110)}`);

    // Test best stop levels with cap targets
    const CAPS = [0, 30, 40, 50]; // 0 = no cap

    console.log(`\n  ${'Stop'.padEnd(7)} ${'Trig'.padEnd(7)} ${'Trail'.padEnd(7)} ${'Cap'.padEnd(7)} ${'Trades'.padStart(7)} ${'Win%'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(9)} ${'PF'.padStart(6)} ${'AvgW'.padStart(7)} ${'AvgL'.padStart(7)} ${'Stops%'.padStart(7)} ${'Trail%'.padStart(7)} ${'Tgt%'.padStart(6)}`);
    console.log(`  ${'─'.repeat(105)}`);

    for (const stop of [10, 12, 15]) {
      const eligible = swings.filter(s => s.risk <= stop);
      if (eligible.length < 30) continue;

      for (const trigger of [5, 8, 10]) {
        for (const trail of [3, 5]) {
          if (trail >= trigger) continue;
          for (const cap of CAPS) {
            const results = eligible.map(s => simulateTrailing(candles, s, stop, trigger, trail, cap, MAX_HOLD_BARS));
            const sum = summarizeResults(results);

            console.log(`  ${(stop + 'pt').padEnd(7)} ${(trigger + 'pt').padEnd(7)} ${(trail + 'pt').padEnd(7)} ${(cap ? cap + 'pt' : 'none').padEnd(7)} ${String(sum.count).padStart(7)} ${formatPct(sum.winRate).padStart(7)} ${formatNum(sum.avgPnl).padStart(7)} ${formatNum(sum.totalPnl, 0).padStart(9)} ${formatNum(sum.pf).padStart(6)} ${formatNum(sum.avgWin).padStart(7)} ${formatNum(sum.avgLoss).padStart(7)} ${formatPct(sum.stopCount / sum.count).padStart(7)} ${formatPct(sum.trailCount / sum.count).padStart(7)} ${formatPct(sum.targetCount / sum.count).padStart(6)}`);
          }
        }
      }
    }

    // ========================================================================
    // PHASE 5: Feature-filtered trailing stop
    // ========================================================================

    console.log(`\n  ${'─'.repeat(110)}`);
    console.log(`  FEATURE-FILTERED TRAILING STOP (best configs)`);
    console.log(`  ${'─'.repeat(110)}`);

    // Pre-compute medians once (was O(n²) recomputing in every filter call)
    const medATR = median(swings.map(x => x.atr20));
    const medRange = median(swings.map(x => x.range));

    const filters = [
      { name: 'All (no filter)', test: () => true },
      { name: 'ATR ≥ median', test: (s) => s.atr20 >= medATR },
      { name: 'Range ≥ median', test: (s) => s.range >= medRange },
      { name: 'ATR + Range ≥ med', test: (s) => s.atr20 >= medATR && s.range >= medRange },
      { name: 'Neg GEX regime', test: (s) => s.gexRegime !== null && s.gexRegime < 0 },
      { name: 'ATR+Range+negGEX', test: (s) => s.atr20 >= medATR && s.range >= medRange && s.gexRegime !== null && s.gexRegime < 0 },
      { name: 'RTH only', test: (s) => s.session === 'rth' },
      { name: 'RTH + ATR+Range', test: (s) => s.session === 'rth' && s.atr20 >= medATR && s.range >= medRange },
      { name: 'BodyRatio ≤ 0.4', test: (s) => s.bodyRatio <= 0.4 },
      { name: 'Wick ≥ 4pts', test: (s) => s.wick >= 4 },
      { name: 'ATR+Range+Wick≥4', test: (s) => s.atr20 >= medATR && s.range >= medRange && s.wick >= 4 },
      { name: 'True swing only', test: (s) => s.isTrueSwing },
    ];

    // Use top 3 trailing configs from grid
    const topConfigs = gridResults
      .filter(r => r.count >= 100)
      .sort((a, b) => b.pf - a.pf)
      .slice(0, 3);

    for (const cfg of topConfigs) {
      console.log(`\n  Config: stop=${cfg.stop} trigger=${cfg.trigger} trail=${cfg.trail}`);
      console.log(`  ${'Filter'.padEnd(25)} ${'Trades'.padStart(7)} ${'Win%'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(9)} ${'PF'.padStart(6)} ${'AvgW'.padStart(7)} ${'AvgL'.padStart(7)} ${'Stop%'.padStart(7)}`);
      console.log(`  ${'─'.repeat(85)}`);

      for (const filter of filters) {
        const filtered = swings.filter(s => s.risk <= cfg.stop && filter.test(s));
        if (filtered.length < 20) continue;
        const results = filtered.map(s => simulateTrailing(candles, s, cfg.stop, cfg.trigger, cfg.trail, 0, MAX_HOLD_BARS));
        const sum = summarizeResults(results);
        console.log(`  ${filter.name.padEnd(25)} ${String(sum.count).padStart(7)} ${formatPct(sum.winRate).padStart(7)} ${formatNum(sum.avgPnl).padStart(7)} ${formatNum(sum.totalPnl, 0).padStart(9)} ${formatNum(sum.pf).padStart(6)} ${formatNum(sum.avgWin).padStart(7)} ${formatNum(sum.avgLoss).padStart(7)} ${formatPct(sum.stopCount / sum.count).padStart(7)}`);
      }
    }

    // ========================================================================
    // PHASE 6: Time-exit analysis (what if we just hold for N bars?)
    // ========================================================================

    console.log(`\n  ${'─'.repeat(110)}`);
    console.log(`  TIME-BASED EXIT ANALYSIS (no stop, no target — just hold N bars)`);
    console.log(`  ${'─'.repeat(110)}`);

    console.log(`  ${'Bars'.padEnd(8)} ${'Avg P&L'.padStart(8)} ${'Med P&L'.padStart(8)} ${'Win%'.padStart(7)} ${'Avg Win'.padStart(8)} ${'Avg Loss'.padStart(8)} ${'PF'.padStart(6)} ${'Total'.padStart(10)}`);
    console.log(`  ${'─'.repeat(65)}`);

    for (const holdBars of [5, 10, 15, 20, 30, 45, 60, 90, 120]) {
      const pathsWithHold = paths.filter(p => p.path.length > holdBars);
      if (pathsWithHold.length < 50) continue;

      const pnls = pathsWithHold.map(p => p.path[holdBars].closeExcursion);
      const wins = pnls.filter(x => x > 0);
      const losses = pnls.filter(x => x <= 0);
      const grossWin = wins.reduce((a, b) => a + b, 0);
      const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
      const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;

      console.log(`  ${(holdBars + ' bars').padEnd(8)} ${formatNum(mean(pnls)).padStart(8)} ${formatNum(median(pnls)).padStart(8)} ${formatPct(wins.length / pnls.length).padStart(7)} ${formatNum(wins.length > 0 ? mean(wins) : 0).padStart(8)} ${formatNum(losses.length > 0 ? mean(losses) : 0).padStart(8)} ${formatNum(pf).padStart(6)} ${formatNum(pnls.reduce((a, b) => a + b, 0), 0).padStart(10)}`);
    }

    // ========================================================================
    // PHASE 7: MAE-based stop optimization
    // ========================================================================

    console.log(`\n  ${'─'.repeat(110)}`);
    console.log(`  MAE-BASED STOP OPTIMIZATION — What stop maximizes net P&L?`);
    console.log(`  ${'─'.repeat(110)}`);
    console.log(`  For each stop level: how many trades survive × what they earn vs what stopped-out trades lose`);

    console.log(`\n  ${'Stop'.padEnd(8)} ${'Survive%'.padStart(9)} ${'Survive'.padStart(8)} ${'AvgMFE_surv'.padStart(12)} ${'AvgCloseP&L'.padStart(12)} ${'StopLoss'.padStart(9)} ${'NetP&L@30b'.padStart(11)} ${'NetP&L@60b'.padStart(11)}`);
    console.log(`  ${'─'.repeat(85)}`);

    for (const stopLvl of [3, 5, 8, 10, 12, 15, 20, 25]) {
      const survived = paths.filter(p => p.mae <= stopLvl);
      const stoppedOut = paths.filter(p => p.mae > stopLvl);
      const surviveRate = paths.length > 0 ? survived.length / paths.length : 0;

      const survMFE = mean(survived.map(p => p.mfe));

      // Net P&L at various hold periods
      const calcNet = (bars) => {
        const survPnl = survived
          .filter(p => p.path.length > bars)
          .map(p => p.path[bars].closeExcursion);
        const stopLossPnl = stoppedOut.length * (-stopLvl);
        return survPnl.reduce((a, b) => a + b, 0) + stopLossPnl;
      };

      const survCloseAvg = survived.length > 0
        ? mean(survived.filter(p => p.path.length > 30).map(p => p.path[Math.min(30, p.path.length - 1)].closeExcursion))
        : 0;

      console.log(`  ${(stopLvl + 'pts').padEnd(8)} ${formatPct(surviveRate).padStart(9)} ${String(survived.length).padStart(8)} ${formatNum(survMFE).padStart(12)} ${formatNum(survCloseAvg).padStart(12)} ${formatNum(stoppedOut.length * (-stopLvl), 0).padStart(9)} ${formatNum(calcNet(30), 0).padStart(11)} ${formatNum(calcNet(60), 0).padStart(11)}`);
    }

    allResults[confirmBars] = {
      total: swings.length,
      trueSwings: trueCount,
      trueRate: trueCount / swings.length,
      maeDistribution: {
        mean: mean(allMAE), median: median(allMAE),
        p75: percentile(allMAE, 75), p90: percentile(allMAE, 90),
      },
      mfeDistribution: {
        mean: mean(allMFE), median: median(allMFE),
        p75: percentile(allMFE, 75), p90: percentile(allMFE, 90),
      },
    };
  }

  // Save results
  fs.writeFileSync(path.resolve(process.cwd(), outputPath), JSON.stringify(allResults, null, 2));
  console.log(`\nResults saved to ${outputPath}`);
  console.log(`Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(console.error);
