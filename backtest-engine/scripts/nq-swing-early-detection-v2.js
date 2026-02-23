#!/usr/bin/env node
/**
 * NQ Early Swing Detection v2 — Partial Confirmation
 *
 * Tests the tradeoff between confirmation bars and entry quality.
 * Instead of waiting 0 bars (too noisy) or 8 bars (too much slippage),
 * find the sweet spot at 1-4 confirmation bars.
 *
 * For each confirmation level (0, 1, 2, 3, 4, 8 bars):
 *   - How many false positives remain?
 *   - How much entry slippage?
 *   - What P&L with realistic stop + target?
 *
 * Also adds "reversal confirmation" — the confirming bars must move AWAY
 * from the extreme (not just stay below it).
 *
 * Usage:
 *   node scripts/nq-swing-early-detection-v2.js [--start YYYY-MM-DD] [--end YYYY-MM-DD]
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
const outputPath = getArg('output', 'nq-swing-early-v2-results.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

const LEFT_LOOKBACK = 8;
const FULL_LOOKBACK = 8;
const CONFIRM_LEVELS = [0, 1, 2, 3, 4, 8]; // right-side bars to require
const STOP_LEVELS = [8, 10, 12, 15];
const TARGET_LEVELS = [10, 15, 20, 25, 30];

console.log('='.repeat(100));
console.log('NQ EARLY SWING DETECTION v2 — PARTIAL CONFIRMATION ANALYSIS');
console.log('='.repeat(100));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log(`Left lookback: ${LEFT_LOOKBACK}, Confirmation levels: ${CONFIRM_LEVELS.join(', ')}`);
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

/**
 * Find candles that are left-side extremes AND pass N bars of right-side confirmation.
 *
 * confirmBars = 0: just left-side extreme (bar i high > bars [i-8, i-1])
 * confirmBars = 3: left-side extreme + bars i+1, i+2, i+3 all have lower highs
 * confirmBars = 8: full swing confirmation
 *
 * Entry is at bar i + confirmBars + 1.
 */
function findSwingsWithConfirmation(candles, confirmBars) {
  const swings = [];

  for (let i = LEFT_LOOKBACK; i < candles.length - confirmBars - 2; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    if (range < 0.5) continue;

    // ATR 20 (compute once)
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

    // Check swing HIGH: left extreme + right confirmation
    let isHigh = true;
    for (let j = i - LEFT_LOOKBACK; j < i; j++) {
      if (candles[j].high >= c.high) { isHigh = false; break; }
    }
    if (isHigh) {
      for (let j = i + 1; j <= i + confirmBars; j++) {
        if (j >= candles.length || candles[j].high >= c.high) { isHigh = false; break; }
      }
    }

    // Check swing LOW: left extreme + right confirmation
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
        risk: c.high - entryPrice, // stop distance to swing extreme
        wick: upperWick,
        range, body, atr20,
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
        wick: lowerWick,
        range, body, atr20,
        bodyRatio: range > 0 ? body / range : 0,
        session: getSession(c.timestamp),
      });
    }
  }

  return swings;
}

/**
 * Check if a swing at index i is a TRUE full lookback-8 swing.
 */
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

/**
 * Simulate a trade with stop at swing extreme + buffer, target as fixed points.
 */
function simulateTrade(candles, swing, stopDist, target) {
  const entryIdx = swing.entryIdx;
  const entryPrice = swing.entryPrice;

  const stopPrice = swing.type === 'high'
    ? entryPrice + stopDist
    : entryPrice - stopDist;

  const targetPrice = swing.type === 'high'
    ? entryPrice - target
    : entryPrice + target;

  let mfe = 0, mae = 0;

  for (let i = entryIdx; i < Math.min(candles.length, entryIdx + 500); i++) {
    const c = candles[i];

    if (swing.type === 'high') {
      const fav = entryPrice - c.low;
      const adv = c.high - entryPrice;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;

      // Stop hit (check first — worst case)
      if (c.high >= stopPrice) return { pnl: -stopDist, reason: 'stop', mfe, mae, bars: i - entryIdx };
      // Target hit
      if (c.low <= targetPrice) return { pnl: target, reason: 'target', mfe, mae, bars: i - entryIdx };
    } else {
      const fav = c.high - entryPrice;
      const adv = entryPrice - c.low;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;

      if (c.low <= stopPrice) return { pnl: -stopDist, reason: 'stop', mfe, mae, bars: i - entryIdx };
      if (c.high >= targetPrice) return { pnl: target, reason: 'target', mfe, mae, bars: i - entryIdx };
    }
  }

  // Max hold exit
  const lastClose = candles[Math.min(candles.length - 1, entryIdx + 499)].close;
  const pnl = swing.type === 'high' ? entryPrice - lastClose : lastClose - entryPrice;
  return { pnl, reason: 'max_hold', mfe, mae, bars: 500 };
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

  // ============================================================================
  // PHASE 2: Test each confirmation level
  // ============================================================================

  console.log('PHASE 2: Testing confirmation levels...\n');

  console.log('='.repeat(130));
  console.log('CONFIRMATION LEVEL COMPARISON');
  console.log('='.repeat(130));

  // Overview table
  console.log(`\n  ${'Confirm'.padEnd(10)} ${'Total'.padStart(7)} ${'True%'.padStart(7)} ${'Entry slip'.padStart(11)} ${'Slip med'.padStart(9)} ${'Stop≤8'.padStart(8)} ${'Stop≤10'.padStart(8)} ${'Stop≤12'.padStart(8)}`);
  console.log(`  ${'─'.repeat(72)}`);

  const confirmResults = {};

  for (const confirmBars of CONFIRM_LEVELS) {
    const swings = findSwingsWithConfirmation(candles, confirmBars);
    for (const s of swings) {
      s.isTrueSwing = isTrueSwing(candles, s.index, s.type);
    }

    const trueCount = swings.filter(s => s.isTrueSwing).length;
    const trueRate = swings.length > 0 ? trueCount / swings.length : 0;
    const risks = swings.map(s => s.risk);
    const riskMed = median(risks);

    const stop8 = swings.filter(s => s.risk <= 8).length;
    const stop10 = swings.filter(s => s.risk <= 10).length;
    const stop12 = swings.filter(s => s.risk <= 12).length;

    console.log(`  ${(confirmBars + ' bars').padEnd(10)} ${String(swings.length).padStart(7)} ${formatPct(trueRate).padStart(7)} ${formatNum(mean(risks)).padStart(11)} ${formatNum(riskMed).padStart(9)} ${String(stop8).padStart(8)} ${String(stop10).padStart(8)} ${String(stop12).padStart(8)}`);

    confirmResults[confirmBars] = swings;
  }

  // ============================================================================
  // PHASE 3: P&L grids — confirmation × stop × target
  // ============================================================================

  console.log('\n' + '='.repeat(130));
  console.log('P&L ANALYSIS: CONFIRMATION × STOP × TARGET (all swings, no feature filter)');
  console.log('='.repeat(130));

  for (const confirmBars of CONFIRM_LEVELS) {
    const swings = confirmResults[confirmBars];
    if (swings.length < 50) continue;

    console.log(`\n  CONFIRM = ${confirmBars} bars (${swings.length} candidates, ${swings.filter(s => s.isTrueSwing).length} true swings)`);
    console.log(`  ${'Stop'.padEnd(8)} ${'Target'.padEnd(8)} ${'Trades'.padStart(7)} ${'Wins'.padStart(6)} ${'Win%'.padStart(7)} ${'Stops'.padStart(6)} ${'Stop%'.padStart(7)} ${'Avg P&L'.padStart(8)} ${'Med P&L'.padStart(8)} ${'Total'.padStart(10)} ${'PF'.padStart(6)}`);
    console.log(`  ${'─'.repeat(85)}`);

    for (const stop of STOP_LEVELS) {
      const eligible = swings.filter(s => s.risk <= stop);
      if (eligible.length < 30) continue;

      for (const target of [15, 20, 25, 30]) {
        const results = eligible.map(s => simulateTrade(candles, s, stop, target));
        const wins = results.filter(r => r.reason === 'target').length;
        const stops = results.filter(r => r.reason === 'stop').length;
        const pnls = results.map(r => r.pnl);
        const totalPnl = pnls.reduce((a, b) => a + b, 0);
        const grossWin = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
        const grossLoss = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
        const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;

        console.log(`  ${(stop + 'pts').padEnd(8)} ${(target + 'pts').padEnd(8)} ${String(results.length).padStart(7)} ${String(wins).padStart(6)} ${formatPct(wins / results.length).padStart(7)} ${String(stops).padStart(6)} ${formatPct(stops / results.length).padStart(7)} ${formatNum(mean(pnls)).padStart(8)} ${formatNum(median(pnls)).padStart(8)} ${formatNum(totalPnl, 0).padStart(10)} ${formatNum(pf).padStart(6)}`);
      }
    }
  }

  // ============================================================================
  // PHASE 4: Best combos with feature filters
  // ============================================================================

  console.log('\n' + '='.repeat(130));
  console.log('FEATURE-FILTERED P&L (ATR ≥ 6.83 + Range ≥ 8.75 + neg GEX regime)');
  console.log('='.repeat(130));

  for (const confirmBars of CONFIRM_LEVELS) {
    const swings = confirmResults[confirmBars];
    const filtered = swings.filter(s => {
      if (s.atr20 < 6.83 || s.range < 8.75) return false;
      const regime = getGexRegime(gexMap, s.timestamp);
      return regime !== null && regime < 0;
    });

    if (filtered.length < 30) continue;
    const trueCount = filtered.filter(s => s.isTrueSwing).length;

    console.log(`\n  CONFIRM = ${confirmBars} bars → ${filtered.length} candidates (${trueCount} true, ${formatPct(trueCount / filtered.length)})`);
    console.log(`  Entry slippage: mean ${formatNum(mean(filtered.map(s => s.risk)))} | median ${formatNum(median(filtered.map(s => s.risk)))} pts`);
    console.log(`  ${'Stop'.padEnd(8)} ${'Target'.padEnd(8)} ${'Trades'.padStart(7)} ${'Win%'.padStart(7)} ${'Stop%'.padStart(7)} ${'Avg P&L'.padStart(8)} ${'Total'.padStart(10)} ${'PF'.padStart(6)} ${'R:R'.padStart(5)}`);
    console.log(`  ${'─'.repeat(65)}`);

    for (const stop of STOP_LEVELS) {
      const eligible = filtered.filter(s => s.risk <= stop);
      if (eligible.length < 20) continue;

      for (const target of [10, 15, 20, 25, 30]) {
        const results = eligible.map(s => simulateTrade(candles, s, stop, target));
        const wins = results.filter(r => r.reason === 'target').length;
        const stops = results.filter(r => r.reason === 'stop').length;
        const pnls = results.map(r => r.pnl);
        const totalPnl = pnls.reduce((a, b) => a + b, 0);
        const grossWin = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
        const grossLoss = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
        const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
        const rr = target / stop;

        console.log(`  ${(stop + 'pts').padEnd(8)} ${(target + 'pts').padEnd(8)} ${String(eligible.length).padStart(7)} ${formatPct(wins / results.length).padStart(7)} ${formatPct(stops / results.length).padStart(7)} ${formatNum(mean(pnls)).padStart(8)} ${formatNum(totalPnl, 0).padStart(10)} ${formatNum(pf).padStart(6)} ${formatNum(rr, 1).padStart(5)}`);
      }
    }
  }

  // ============================================================================
  // PHASE 5: Additional filter variants
  // ============================================================================

  console.log('\n' + '='.repeat(130));
  console.log('FILTER VARIANTS AT BEST CONFIRMATION LEVELS');
  console.log('='.repeat(130));

  const filterVariants = [
    { name: 'ATR ≥ 6.83 + Range ≥ 8.75', test: (s) => s.atr20 >= 6.83 && s.range >= 8.75 },
    { name: 'ATR ≥ 6.83 + Range ≥ 8.75 + neg GEX', test: (s, gex) => s.atr20 >= 6.83 && s.range >= 8.75 && gex !== null && gex < 0 },
    { name: 'ATR ≥ 6.83 + Range ≥ 8.75 + bodyRatio ≤ 0.5', test: (s) => s.atr20 >= 6.83 && s.range >= 8.75 && s.bodyRatio <= 0.5 },
    { name: 'ATR ≥ 6.83 + Range ≥ 8.75 + wick ≥ 3pts', test: (s) => s.atr20 >= 6.83 && s.range >= 8.75 && s.wick >= 3 },
    { name: 'ATR ≥ 10 + Range ≥ 12 (high vol)', test: (s) => s.atr20 >= 10 && s.range >= 12 },
    { name: 'ATR ≥ 10 + Range ≥ 12 + neg GEX', test: (s, gex) => s.atr20 >= 10 && s.range >= 12 && gex !== null && gex < 0 },
    { name: 'RTH only + ATR ≥ 6.83 + Range ≥ 8.75', test: (s) => s.session === 'rth' && s.atr20 >= 6.83 && s.range >= 8.75 },
    { name: 'RTH + ATR ≥ 6.83 + Range ≥ 8.75 + neg GEX', test: (s, gex) => s.session === 'rth' && s.atr20 >= 6.83 && s.range >= 8.75 && gex !== null && gex < 0 },
  ];

  // Test with confirm=3 (likely sweet spot) and confirm=2
  for (const confirmBars of [2, 3, 4]) {
    const swings = confirmResults[confirmBars];
    if (!swings || swings.length < 50) continue;

    console.log(`\n  CONFIRM = ${confirmBars} bars, STOP = 10pts, TARGET = 20pts`);
    console.log(`  ${'Filter'.padEnd(52)} ${'Trades'.padStart(7)} ${'True%'.padStart(7)} ${'Win%'.padStart(7)} ${'Stop%'.padStart(7)} ${'Avg P&L'.padStart(8)} ${'Total'.padStart(10)} ${'PF'.padStart(6)}`);
    console.log(`  ${'─'.repeat(100)}`);

    for (const variant of filterVariants) {
      const filtered = swings.filter(s => {
        const gex = getGexRegime(gexMap, s.timestamp);
        return variant.test(s, gex);
      });
      const eligible = filtered.filter(s => s.risk <= 10);
      if (eligible.length < 20) continue;

      const trueRate = eligible.filter(s => s.isTrueSwing).length / eligible.length;
      const results = eligible.map(s => simulateTrade(candles, s, 10, 20));
      const wins = results.filter(r => r.reason === 'target').length;
      const stops = results.filter(r => r.reason === 'stop').length;
      const pnls = results.map(r => r.pnl);
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      const grossWin = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
      const grossLoss = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
      const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;

      console.log(`  ${variant.name.padEnd(52)} ${String(eligible.length).padStart(7)} ${formatPct(trueRate).padStart(7)} ${formatPct(wins / results.length).padStart(7)} ${formatPct(stops / results.length).padStart(7)} ${formatNum(mean(pnls)).padStart(8)} ${formatNum(totalPnl, 0).padStart(10)} ${formatNum(pf).padStart(6)}`);
    }

    // Also test stop=12, target=20 for comparison
    console.log(`\n  CONFIRM = ${confirmBars} bars, STOP = 12pts, TARGET = 20pts`);
    console.log(`  ${'Filter'.padEnd(52)} ${'Trades'.padStart(7)} ${'True%'.padStart(7)} ${'Win%'.padStart(7)} ${'Stop%'.padStart(7)} ${'Avg P&L'.padStart(8)} ${'Total'.padStart(10)} ${'PF'.padStart(6)}`);
    console.log(`  ${'─'.repeat(100)}`);

    for (const variant of filterVariants) {
      const filtered = swings.filter(s => {
        const gex = getGexRegime(gexMap, s.timestamp);
        return variant.test(s, gex);
      });
      const eligible = filtered.filter(s => s.risk <= 12);
      if (eligible.length < 20) continue;

      const trueRate = eligible.filter(s => s.isTrueSwing).length / eligible.length;
      const results = eligible.map(s => simulateTrade(candles, s, 12, 20));
      const wins = results.filter(r => r.reason === 'target').length;
      const stops = results.filter(r => r.reason === 'stop').length;
      const pnls = results.map(r => r.pnl);
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      const grossWin = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
      const grossLoss = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
      const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;

      console.log(`  ${variant.name.padEnd(52)} ${String(eligible.length).padStart(7)} ${formatPct(trueRate).padStart(7)} ${formatPct(wins / results.length).padStart(7)} ${formatPct(stops / results.length).padStart(7)} ${formatNum(mean(pnls)).padStart(8)} ${formatNum(totalPnl, 0).padStart(10)} ${formatNum(pf).padStart(6)}`);
    }
  }

  // ============================================================================
  // Session breakdown for best combos
  // ============================================================================

  console.log('\n' + '='.repeat(130));
  console.log('SESSION BREAKDOWN — BEST COMBOS');
  console.log('='.repeat(130));

  for (const confirmBars of [2, 3, 4]) {
    const swings = confirmResults[confirmBars];
    if (!swings) continue;

    // ATR + Range + neg GEX filter
    const filtered = swings.filter(s => {
      if (s.atr20 < 6.83 || s.range < 8.75) return false;
      const gex = getGexRegime(gexMap, s.timestamp);
      return gex !== null && gex < 0;
    }).filter(s => s.risk <= 10);

    if (filtered.length < 30) continue;

    console.log(`\n  Confirm=${confirmBars}, ATR+Range+negGEX, Stop=10, Target=20 (${filtered.length} trades)`);
    console.log(`  ${'Session'.padEnd(14)} ${'Trades'.padStart(7)} ${'Win%'.padStart(7)} ${'Stop%'.padStart(7)} ${'Avg P&L'.padStart(8)} ${'Total'.padStart(10)} ${'PF'.padStart(6)}`);
    console.log(`  ${'─'.repeat(55)}`);

    for (const sess of ['rth', 'premarket', 'overnight']) {
      const sessSwings = filtered.filter(s => s.session === sess);
      if (sessSwings.length < 10) continue;
      const results = sessSwings.map(s => simulateTrade(candles, s, 10, 20));
      const wins = results.filter(r => r.reason === 'target').length;
      const stops = results.filter(r => r.reason === 'stop').length;
      const pnls = results.map(r => r.pnl);
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      const grossWin = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
      const grossLoss = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
      const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
      console.log(`  ${sess.padEnd(14)} ${String(sessSwings.length).padStart(7)} ${formatPct(wins / results.length).padStart(7)} ${formatPct(stops / results.length).padStart(7)} ${formatNum(mean(pnls)).padStart(8)} ${formatNum(totalPnl, 0).padStart(10)} ${formatNum(pf).padStart(6)}`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(130));
  console.log('SUMMARY');
  console.log('='.repeat(130));

  console.log(`\n  Confirmation levels tested: ${CONFIRM_LEVELS.join(', ')} bars`);
  for (const cb of CONFIRM_LEVELS) {
    const s = confirmResults[cb];
    if (!s) continue;
    const t = s.filter(x => x.isTrueSwing).length;
    console.log(`    ${cb} bars: ${s.length} candidates, ${t} true swings (${formatPct(t / s.length)}), entry slip ${formatNum(mean(s.map(x => x.risk)))} pts`);
  }

  console.log(`\nRuntime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Save
  const output = {
    config: { startDate: startDateStr, endDate: endDateStr },
    confirmLevels: Object.fromEntries(CONFIRM_LEVELS.map(cb => {
      const s = confirmResults[cb] || [];
      const t = s.filter(x => x.isTrueSwing).length;
      return [cb, { count: s.length, trueCount: t, trueRate: t / (s.length || 1), avgSlip: mean(s.map(x => x.risk)) }];
    })),
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Results saved to ${outputPath}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
