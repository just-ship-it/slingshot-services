#!/usr/bin/env node
/**
 * NQ True Swing Strategy — Full 8-bar Confirmed Swings + Exit Optimization
 *
 * All swings at confirm=8 are TRUE swings by definition. Zero false positives.
 * Now we focus entirely on finding the optimal exit parameters.
 *
 * Tests:
 *   - Wide trailing stop grid (stop × trigger × trail)
 *   - Fixed stop + fixed target (for comparison)
 *   - Breakeven stop (move stop to entry after N pts profit)
 *   - Session filters, feature filters, long vs short
 *   - Per-trade P&L distribution for best configs
 *   - Monthly equity curve for best configs
 *
 * Usage:
 *   node scripts/nq-swing-true-confirmed.js [--start YYYY-MM-DD] [--end YYYY-MM-DD]
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
const outputPath = getArg('output', 'nq-swing-true-confirmed-results.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

const LOOKBACK = 8;
const MAX_HOLD_BARS = 240; // 4 hours max hold (longer since we're holding confirmed swings)

console.log('='.repeat(120));
console.log('NQ TRUE SWING STRATEGY — FULL 8-BAR CONFIRMATION + EXIT OPTIMIZATION');
console.log('='.repeat(120));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log(`Lookback: ${LOOKBACK} bars each side, Max hold: ${MAX_HOLD_BARS} bars`);
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

function getMonth(timestamp) {
  const d = new Date(timestamp);
  return d.toISOString().slice(0, 7); // YYYY-MM
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
// Swing Detection — Full 8-bar confirmation
// ============================================================================

function findConfirmedSwings(candles) {
  const swings = [];

  for (let i = LOOKBACK; i < candles.length - LOOKBACK - 1; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    if (range < 0.5) continue;

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

    // RVOL
    let rvol = 1;
    if (i >= 21) {
      let sumVol = 0;
      for (let j = i - 20; j < i; j++) sumVol += candles[j].volume || 0;
      const avgVol = sumVol / 20;
      rvol = avgVol > 0 ? (c.volume || 0) / avgVol : 1;
    }

    // Momentum (5-bar rate of change before swing)
    const momentum5 = i >= 5 ? c.close - candles[i - 5].close : 0;

    // Check swing HIGH: highest high in [i-LOOKBACK, i+LOOKBACK]
    let isHigh = true;
    for (let j = i - LOOKBACK; j <= i + LOOKBACK; j++) {
      if (j !== i && candles[j].high >= c.high) { isHigh = false; break; }
    }

    // Check swing LOW: lowest low in [i-LOOKBACK, i+LOOKBACK]
    let isLow = true;
    for (let j = i - LOOKBACK; j <= i + LOOKBACK; j++) {
      if (j !== i && candles[j].low <= c.low) { isLow = false; break; }
    }

    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const body = Math.abs(c.close - c.open);

    // Entry = open of bar after full confirmation (bar i + LOOKBACK + 1)
    const entryIdx = i + LOOKBACK + 1;
    if (entryIdx >= candles.length) continue;
    const entryPrice = candles[entryIdx].open;

    if (isHigh && upperWick > 0) {
      swings.push({
        index: i, type: 'high', timestamp: c.timestamp,
        swingPrice: c.high, entryIdx, entryPrice,
        slip: c.high - entryPrice, // how far entry is from swing extreme
        wick: upperWick, range, body, atr20, rvol, momentum5,
        bodyRatio: range > 0 ? body / range : 0,
        session: getSession(c.timestamp),
        month: getMonth(c.timestamp),
      });
    }

    if (isLow && lowerWick > 0) {
      swings.push({
        index: i, type: 'low', timestamp: c.timestamp,
        swingPrice: c.low, entryIdx, entryPrice,
        slip: entryPrice - c.low,
        wick: lowerWick, range, body, atr20, rvol, momentum5,
        bodyRatio: range > 0 ? body / range : 0,
        session: getSession(c.timestamp),
        month: getMonth(c.timestamp),
      });
    }
  }

  return swings;
}

// ============================================================================
// Trade simulation
// ============================================================================

function simulateTrailing(candles, swing, stopDist, triggerPts, trailDist, fixedTarget, maxBars, breakevenAt) {
  const entryIdx = swing.entryIdx;
  const entryPrice = swing.entryPrice;

  const stopPrice = swing.type === 'high'
    ? entryPrice + stopDist
    : entryPrice - stopDist;

  let currentStop = stopPrice;
  let trailActive = false;
  let bestPrice = entryPrice;
  let mfe = 0, mae = 0;
  let breakevenApplied = false;

  for (let i = 0; i < maxBars; i++) {
    const ci = entryIdx + i;
    if (ci >= candles.length) break;
    const c = candles[ci];

    if (swing.type === 'high') {
      // Short trade
      const fav = entryPrice - c.low;
      const adv = c.high - entryPrice;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;

      // Stop check
      if (c.high >= currentStop) {
        const pnl = entryPrice - currentStop;
        return { pnl, reason: breakevenApplied && currentStop <= entryPrice ? 'breakeven' : (trailActive ? 'trail' : 'stop'), mfe, mae, bars: i };
      }

      // Fixed target
      if (fixedTarget > 0 && c.low <= entryPrice - fixedTarget) {
        return { pnl: fixedTarget, reason: 'target', mfe, mae, bars: i };
      }

      // Update best price
      if (c.low < bestPrice) bestPrice = c.low;
      const profit = entryPrice - bestPrice;

      // Breakeven stop
      if (breakevenAt > 0 && !breakevenApplied && profit >= breakevenAt) {
        currentStop = entryPrice; // move stop to entry
        breakevenApplied = true;
      }

      // Trailing stop activation
      if (!trailActive && profit >= triggerPts) {
        trailActive = true;
      }

      if (trailActive) {
        const newTrail = bestPrice + trailDist;
        if (newTrail < currentStop) currentStop = newTrail;
      }
    } else {
      // Long trade
      const fav = c.high - entryPrice;
      const adv = entryPrice - c.low;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;

      // Stop check
      if (c.low <= currentStop) {
        const pnl = currentStop - entryPrice;
        return { pnl, reason: breakevenApplied && currentStop >= entryPrice ? 'breakeven' : (trailActive ? 'trail' : 'stop'), mfe, mae, bars: i };
      }

      // Fixed target
      if (fixedTarget > 0 && c.high >= entryPrice + fixedTarget) {
        return { pnl: fixedTarget, reason: 'target', mfe, mae, bars: i };
      }

      // Update best price
      if (c.high > bestPrice) bestPrice = c.high;
      const profit = bestPrice - entryPrice;

      // Breakeven stop
      if (breakevenAt > 0 && !breakevenApplied && profit >= breakevenAt) {
        currentStop = entryPrice;
        breakevenApplied = true;
      }

      // Trailing stop activation
      if (!trailActive && profit >= triggerPts) {
        trailActive = true;
      }

      if (trailActive) {
        const newTrail = bestPrice - trailDist;
        if (newTrail > currentStop) currentStop = newTrail;
      }
    }
  }

  // Max hold exit
  const lastClose = candles[Math.min(candles.length - 1, entryIdx + maxBars - 1)].close;
  const pnl = swing.type === 'high' ? entryPrice - lastClose : lastClose - entryPrice;
  return { pnl, reason: 'max_hold', mfe, mae, bars: maxBars };
}

function simulateFixed(candles, swing, stopDist, target, maxBars) {
  return simulateTrailing(candles, swing, stopDist, 99999, 99999, target, maxBars, 0);
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
    reasons: {
      stop: results.filter(r => r.reason === 'stop').length,
      trail: results.filter(r => r.reason === 'trail').length,
      target: results.filter(r => r.reason === 'target').length,
      breakeven: results.filter(r => r.reason === 'breakeven').length,
      max_hold: results.filter(r => r.reason === 'max_hold').length,
    },
  };
}

function printRow(label, sum, extra = '') {
  const stopPct = sum.count > 0 ? sum.reasons.stop / sum.count : 0;
  const trailPct = sum.count > 0 ? (sum.reasons.trail + sum.reasons.breakeven) / sum.count : 0;
  const tgtPct = sum.count > 0 ? sum.reasons.target / sum.count : 0;
  console.log(`  ${label.padEnd(30)} ${String(sum.count).padStart(6)} ${formatPct(sum.winRate).padStart(7)} ${formatNum(sum.avgPnl).padStart(7)} ${formatNum(sum.medPnl).padStart(7)} ${formatNum(sum.totalPnl, 0).padStart(9)} ${formatNum(sum.pf).padStart(6)} ${formatNum(sum.avgWin).padStart(7)} ${formatNum(sum.avgLoss).padStart(7)} ${formatPct(stopPct).padStart(7)} ${formatNum(sum.avgBars, 0).padStart(6)}${extra}`);
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

  // ========================================================================
  // PHASE 2: Detect all confirmed swings
  // ========================================================================

  const swings = findConfirmedSwings(candles);
  for (const s of swings) {
    s.gexRegime = getGexRegime(gexMap, s.timestamp);
  }

  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');

  console.log('='.repeat(120));
  console.log('CONFIRMED SWING POPULATION');
  console.log('='.repeat(120));
  console.log(`  Total: ${swings.length} (${highs.length} highs, ${lows.length} lows)`);
  console.log(`  Entry slippage: mean ${formatNum(mean(swings.map(s => s.slip)))} | med ${formatNum(median(swings.map(s => s.slip)))} | P25 ${formatNum(percentile(swings.map(s => s.slip), 25))} | P75 ${formatNum(percentile(swings.map(s => s.slip), 75))} pts`);
  console.log(`  ATR: mean ${formatNum(mean(swings.map(s => s.atr20)))} | med ${formatNum(median(swings.map(s => s.atr20)))}`);
  console.log(`  Range: mean ${formatNum(mean(swings.map(s => s.range)))} | med ${formatNum(median(swings.map(s => s.range)))}`);
  console.log(`  Wick: mean ${formatNum(mean(swings.map(s => s.wick)))} | med ${formatNum(median(swings.map(s => s.wick)))}`);
  console.log(`  RVOL: mean ${formatNum(mean(swings.map(s => s.rvol)))} | med ${formatNum(median(swings.map(s => s.rvol)))}`);

  // Session breakdown
  const sessions = ['overnight', 'premarket', 'rth', 'afterhours'];
  console.log(`\n  Session breakdown:`);
  for (const sess of sessions) {
    const n = swings.filter(s => s.session === sess).length;
    console.log(`    ${sess.padEnd(12)} ${n} (${formatPct(n / swings.length)})`);
  }

  // ========================================================================
  // PHASE 3: MAE/MFE overview
  // ========================================================================

  console.log(`\n${'='.repeat(120)}`);
  console.log('MAE/MFE DISTRIBUTION (from entry, 240-bar window)');
  console.log('='.repeat(120));

  const pathData = swings.map(s => {
    let mfe = 0, mae = 0;
    for (let i = 0; i < MAX_HOLD_BARS; i++) {
      const ci = s.entryIdx + i;
      if (ci >= candles.length) break;
      const c = candles[ci];
      if (s.type === 'high') {
        const fav = s.entryPrice - c.low;
        const adv = c.high - s.entryPrice;
        if (fav > mfe) mfe = fav;
        if (adv > mae) mae = adv;
      } else {
        const fav = c.high - s.entryPrice;
        const adv = s.entryPrice - c.low;
        if (fav > mfe) mfe = fav;
        if (adv > mae) mae = adv;
      }
    }
    return { ...s, mfe, mae };
  });

  const allMFE = pathData.map(p => p.mfe);
  const allMAE = pathData.map(p => p.mae);

  console.log(`\n  MFE: mean ${formatNum(mean(allMFE))} | med ${formatNum(median(allMFE))} | P25 ${formatNum(percentile(allMFE, 25))} | P75 ${formatNum(percentile(allMFE, 75))} | P90 ${formatNum(percentile(allMFE, 90))}`);
  console.log(`  MAE: mean ${formatNum(mean(allMAE))} | med ${formatNum(median(allMAE))} | P25 ${formatNum(percentile(allMAE, 25))} | P75 ${formatNum(percentile(allMAE, 75))} | P90 ${formatNum(percentile(allMAE, 90))}`);

  console.log(`\n  MAE survival: ≤10pts ${formatPct(allMAE.filter(x => x <= 10).length / allMAE.length)} | ≤15 ${formatPct(allMAE.filter(x => x <= 15).length / allMAE.length)} | ≤20 ${formatPct(allMAE.filter(x => x <= 20).length / allMAE.length)} | ≤25 ${formatPct(allMAE.filter(x => x <= 25).length / allMAE.length)} | ≤30 ${formatPct(allMAE.filter(x => x <= 30).length / allMAE.length)}`);
  console.log(`  MFE reach:   ≥20pts ${formatPct(allMFE.filter(x => x >= 20).length / allMFE.length)} | ≥30 ${formatPct(allMFE.filter(x => x >= 30).length / allMFE.length)} | ≥40 ${formatPct(allMFE.filter(x => x >= 40).length / allMFE.length)} | ≥50 ${formatPct(allMFE.filter(x => x >= 50).length / allMFE.length)} | ≥75 ${formatPct(allMFE.filter(x => x >= 75).length / allMFE.length)}`);

  // ========================================================================
  // PHASE 4: Fixed stop + fixed target grid (baseline)
  // ========================================================================

  console.log(`\n${'='.repeat(120)}`);
  console.log('FIXED STOP + FIXED TARGET (baseline comparison)');
  console.log('='.repeat(120));

  const header = `  ${'Config'.padEnd(30)} ${'Trades'.padStart(6)} ${'Win%'.padStart(7)} ${'Avg'.padStart(7)} ${'Med'.padStart(7)} ${'Total'.padStart(9)} ${'PF'.padStart(6)} ${'AvgW'.padStart(7)} ${'AvgL'.padStart(7)} ${'Stop%'.padStart(7)} ${'Bars'.padStart(6)}`;
  console.log(header);
  console.log(`  ${'─'.repeat(100)}`);

  for (const stop of [15, 20, 25, 30]) {
    for (const target of [15, 20, 25, 30, 40, 50]) {
      const results = swings.map(s => simulateFixed(candles, s, stop, target, MAX_HOLD_BARS));
      const sum = summarizeResults(results);
      printRow(`stop=${stop} target=${target}`, sum);
    }
  }

  // ========================================================================
  // PHASE 5: Trailing stop grid (main optimization)
  // ========================================================================

  console.log(`\n${'='.repeat(120)}`);
  console.log('TRAILING STOP GRID (no fixed target)');
  console.log('='.repeat(120));

  console.log(header);
  console.log(`  ${'─'.repeat(100)}`);

  const allGridResults = [];

  for (const stop of [15, 20, 25, 30]) {
    for (const trigger of [8, 10, 12, 15, 20, 25]) {
      for (const trail of [3, 5, 8, 10, 12]) {
        if (trail >= trigger) continue;
        const results = swings.map(s => simulateTrailing(candles, s, stop, trigger, trail, 0, MAX_HOLD_BARS, 0));
        const sum = summarizeResults(results);
        allGridResults.push({ stop, trigger, trail, be: 0, ...sum });
        printRow(`s=${stop} trig=${trigger} tr=${trail}`, sum);
      }
    }
  }

  // Sort and show top 10
  const top10 = allGridResults.filter(r => r.count >= 100).sort((a, b) => b.pf - a.pf).slice(0, 10);
  console.log(`\n  TOP 10 TRAILING CONFIGS (by PF):`);
  console.log(header);
  console.log(`  ${'─'.repeat(100)}`);
  for (const r of top10) {
    printRow(`s=${r.stop} trig=${r.trigger} tr=${r.trail}`, r);
  }

  // Also top 10 by total P&L
  const top10pnl = allGridResults.filter(r => r.count >= 100 && r.pf >= 1.0).sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 10);
  console.log(`\n  TOP 10 TRAILING CONFIGS (by Total P&L, PF≥1.0):`);
  console.log(header);
  console.log(`  ${'─'.repeat(100)}`);
  for (const r of top10pnl) {
    printRow(`s=${r.stop} trig=${r.trigger} tr=${r.trail}`, r);
  }

  // ========================================================================
  // PHASE 6: Breakeven stop variants
  // ========================================================================

  console.log(`\n${'='.repeat(120)}`);
  console.log('BREAKEVEN STOP VARIANTS (move stop to entry after N pts profit)');
  console.log('='.repeat(120));

  console.log(header);
  console.log(`  ${'─'.repeat(100)}`);

  // Test breakeven with best trailing configs
  for (const stop of [20, 25, 30]) {
    for (const be of [8, 10, 15]) {
      for (const trigger of [15, 20, 25]) {
        for (const trail of [5, 8, 10]) {
          if (trail >= trigger || be >= trigger) continue;
          const results = swings.map(s => simulateTrailing(candles, s, stop, trigger, trail, 0, MAX_HOLD_BARS, be));
          const sum = summarizeResults(results);
          if (sum.pf >= 1.1) {
            printRow(`s=${stop} be=${be} trig=${trigger} tr=${trail}`, sum);
          }
        }
      }
    }
  }

  // ========================================================================
  // PHASE 7: Best configs — breakdown by session, direction, features
  // ========================================================================

  // Pick top 3 overall configs
  const bestConfigs = allGridResults.filter(r => r.count >= 100).sort((a, b) => b.pf - a.pf).slice(0, 3);

  for (const cfg of bestConfigs) {
    console.log(`\n${'='.repeat(120)}`);
    console.log(`DETAILED ANALYSIS: stop=${cfg.stop} trigger=${cfg.trigger} trail=${cfg.trail}`);
    console.log('='.repeat(120));

    const results = swings.map(s => ({
      ...s,
      ...simulateTrailing(candles, s, cfg.stop, cfg.trigger, cfg.trail, 0, MAX_HOLD_BARS, 0),
    }));

    // Direction breakdown
    console.log(`\n  BY DIRECTION:`);
    console.log(header);
    console.log(`  ${'─'.repeat(100)}`);
    const shorts = results.filter(r => r.type === 'high');
    const longs = results.filter(r => r.type === 'low');
    printRow('Short (swing high)', summarizeResults(shorts));
    printRow('Long (swing low)', summarizeResults(longs));

    // Session breakdown
    console.log(`\n  BY SESSION:`);
    console.log(header);
    console.log(`  ${'─'.repeat(100)}`);
    for (const sess of sessions) {
      const sessResults = results.filter(r => r.session === sess);
      if (sessResults.length >= 20) printRow(sess, summarizeResults(sessResults));
    }

    // Pre-compute medians
    const medATR = median(swings.map(x => x.atr20));
    const medRange = median(swings.map(x => x.range));

    // Feature filters
    console.log(`\n  BY FEATURE FILTER:`);
    console.log(header);
    console.log(`  ${'─'.repeat(100)}`);

    const filters = [
      { name: 'All', test: () => true },
      { name: 'ATR ≥ median', test: (s) => s.atr20 >= medATR },
      { name: 'ATR < median', test: (s) => s.atr20 < medATR },
      { name: 'Range ≥ median', test: (s) => s.range >= medRange },
      { name: 'Neg GEX', test: (s) => s.gexRegime !== null && s.gexRegime < 0 },
      { name: 'Pos/Neutral GEX', test: (s) => s.gexRegime !== null && s.gexRegime >= 0 },
      { name: 'BodyRatio ≤ 0.3 (doji)', test: (s) => s.bodyRatio <= 0.3 },
      { name: 'BodyRatio > 0.6 (full)', test: (s) => s.bodyRatio > 0.6 },
      { name: 'RVOL ≥ 1.5', test: (s) => s.rvol >= 1.5 },
      { name: 'RVOL < 1.0', test: (s) => s.rvol < 1.0 },
      { name: 'Wick ≥ 5pts', test: (s) => s.wick >= 5 },
      { name: 'Slip ≤ 15pts', test: (s) => s.slip <= 15 },
      { name: 'Slip ≤ 20pts', test: (s) => s.slip <= 20 },
      { name: 'Slip > 30pts', test: (s) => s.slip > 30 },
      { name: 'RTH only', test: (s) => s.session === 'rth' },
      { name: 'RTH + neg GEX', test: (s) => s.session === 'rth' && s.gexRegime !== null && s.gexRegime < 0 },
    ];

    for (const f of filters) {
      const filtered = results.filter(r => f.test(r));
      if (filtered.length >= 20) printRow(f.name, summarizeResults(filtered));
    }

    // Monthly equity curve
    console.log(`\n  MONTHLY P&L:`);
    const months = [...new Set(results.map(r => r.month))].sort();
    console.log(`  ${'Month'.padEnd(10)} ${'Trades'.padStart(6)} ${'Win%'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(9)} ${'PF'.padStart(6)} ${'Cumul'.padStart(9)}`);
    console.log(`  ${'─'.repeat(55)}`);
    let cumul = 0;
    for (const m of months) {
      const mResults = results.filter(r => r.month === m);
      const mSum = summarizeResults(mResults);
      cumul += mSum.totalPnl;
      console.log(`  ${m.padEnd(10)} ${String(mSum.count).padStart(6)} ${formatPct(mSum.winRate).padStart(7)} ${formatNum(mSum.avgPnl).padStart(7)} ${formatNum(mSum.totalPnl, 0).padStart(9)} ${formatNum(mSum.pf).padStart(6)} ${formatNum(cumul, 0).padStart(9)}`);
    }

    // P&L distribution
    console.log(`\n  P&L DISTRIBUTION:`);
    const allPnl = results.map(r => r.pnl);
    console.log(`    P5: ${formatNum(percentile(allPnl, 5))}  P25: ${formatNum(percentile(allPnl, 25))}  Median: ${formatNum(median(allPnl))}  P75: ${formatNum(percentile(allPnl, 75))}  P95: ${formatNum(percentile(allPnl, 95))}`);
    console.log(`    Max win: ${formatNum(Math.max(...allPnl))}  Max loss: ${formatNum(Math.min(...allPnl))}`);
    console.log(`    Exit reasons: stop ${formatPct(cfg.reasons.stop / cfg.count)} | trail ${formatPct((cfg.reasons.trail + cfg.reasons.breakeven) / cfg.count)} | target ${formatPct(cfg.reasons.target / cfg.count)} | max_hold ${formatPct(cfg.reasons.max_hold / cfg.count)}`);
  }

  // ========================================================================
  // Save results
  // ========================================================================

  const savedResults = {
    config: { startDate: startDateStr, endDate: endDateStr, lookback: LOOKBACK, maxHold: MAX_HOLD_BARS },
    population: {
      total: swings.length, highs: highs.length, lows: lows.length,
      avgSlip: mean(swings.map(s => s.slip)), medSlip: median(swings.map(s => s.slip)),
    },
    topTrailingConfigs: top10.map(r => ({ stop: r.stop, trigger: r.trigger, trail: r.trail, pf: r.pf, totalPnl: r.totalPnl, winRate: r.winRate, count: r.count })),
  };

  fs.writeFileSync(path.resolve(process.cwd(), outputPath), JSON.stringify(savedResults, null, 2));
  console.log(`\nResults saved to ${outputPath}`);
  console.log(`Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(console.error);
