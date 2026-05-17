/**
 * GEX-Touch Patterns — Phase 1: build pattern-trigger dataset.
 *
 * Framework redesign (2026-05-13): instead of firing entries on the touch bar,
 * we treat each GEX touch as the START of a 30-min monitoring window. Within
 * that window we look for ONE OR MORE pattern-based entry triggers that
 * suggest a 20-pt move from the trigger price.
 *
 * Patterns (initial v1):
 *   R1 — Bounce + higher-low → break of swing-high (LONG, support touch from_above)
 *   R2 — Bounce + lower-high → break of swing-low (SHORT, resistance touch from_below)
 *   R3 — Pin-bar rejection + confirmation bar (direction = pin tail; either side)
 *   A1 — Accept + retest hold (LONG break of resistance)
 *   A2 — Accept + retest hold (SHORT break of support)
 *   F1 — Fake-out recovery (LONG, support wicked but closed back above)
 *   F2 — Fake-out recovery (SHORT, resistance wicked but closed back below)
 *
 * Critical 1s-honest discipline per CLAUDE.md:
 *   • Trigger fires at the close of a 1m bar (e.g., R1 trigger = close of bar
 *     whose close broke the swing high). Effective entry timestamp = bar's
 *     close = bar.ts + 60s.
 *   • Outcome is walked on 1s OHLCV starting AT trigger_ts. We assume MARKET
 *     entry at the trigger bar's close price (no slippage in research; engine
 *     will add slippage). Stop/target checked on each subsequent 1s bar.
 *   • Same-bar both-hit resolves conservatively to STOP.
 *   • Max hold: 60 min from trigger. EOD cutoff: 16:40 ET.
 *   • Contract rollover within walk = outcome 'rollover'.
 *
 * Output: research/output/gex-touch-patterns-base-${ts}.json
 *
 * Usage:
 *   node research/gex-touch-patterns/01-build-pattern-dataset.js \
 *     --start 2025-01-13 --end 2026-04-23
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { toET } from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'research', 'output');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}

const START = arg('start', '2025-01-13');
const END = arg('end', '2026-04-23');
const TOUCH_DISTANCE = Number(arg('touch-distance', 10));
const PRODUCT = arg('product', 'NQ').toUpperCase();
const GEX_DIR = arg('gex-dir', 'nq-cbbo');
const TARGET_POINTS = Number(arg('target-points', 20));
// Stretch-target evaluation: evaluate multiple targets in one walk.
const TARGET_LADDER = String(arg('target-ladder', '20,30,40,50,60,80,100'))
  .split(',').map(Number).filter(n => n > 0);
const STOP_BUFFER = Number(arg('stop-buffer', 2));  // pts past pattern's stop reference
const MAX_TRIGGER_WINDOW_MIN = Number(arg('trigger-window-min', 30));  // monitoring window
const MAX_HOLD_MIN = Number(arg('max-hold-min', 60));  // post-trigger max hold
const SNAP_LAG_MIN = Number(arg('snap-lag-min', 16));
const EOD_CUTOFF_ET = arg('eod-cutoff-et', '16:40');
const ACCEPT_K = Number(arg('accept-k', 3));  // consecutive closes for acceptance
const FAKE_PIERCE_PTS = Number(arg('fake-pierce-pts', 3));  // F1/F2 pierce depth
const MAX_STOP_PTS = Number(arg('max-stop-pts', 25));  // skip triggers with > MAX_STOP_PTS stop

console.log(`\n=== GEX Touch Patterns — Phase 1 (1s-honest, pattern triggers) ===`);
console.log(`Range:                ${START} → ${END}`);
console.log(`Touch distance:       ${TOUCH_DISTANCE} pts`);
console.log(`Trigger window:       ${MAX_TRIGGER_WINDOW_MIN} min after touch`);
console.log(`Max hold per trade:   ${MAX_HOLD_MIN} min after trigger`);
console.log(`Target:               ${TARGET_POINTS} pts from entry`);
console.log(`Stop buffer:          ${STOP_BUFFER} pts past pattern reference`);
console.log(`Max stop distance:    ${MAX_STOP_PTS} pts (skip wider stops)`);
console.log(`Accept K closes:      ${ACCEPT_K}`);
console.log(`Fake pierce depth:    ${FAKE_PIERCE_PTS} pts`);
console.log(`Snap lag:             ${SNAP_LAG_MIN} min`);
console.log(`EOD cutoff (ET):      ${EOD_CUTOFF_ET}\n`);

const [EOD_HOUR, EOD_MIN] = EOD_CUTOFF_ET.split(':').map(Number);

// --- 1m OHLCV loader ---
async function loadRawNQ(startStr, endStr) {
  const filePath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1m.csv`);
  const start = new Date(startStr).getTime();
  const end = new Date(endStr).getTime() + 24 * 3600000;
  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return;
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < start || ts > end) return;
        const c = { timestamp: ts, open: +row.open, high: +row.high, low: +row.low,
          close: +row.close, volume: +row.volume || 0, symbol: row.symbol };
        if (isNaN(c.open) || isNaN(c.close)) return;
        candles.push(c);
      })
      .on('end', resolve).on('error', reject);
  });
  candles.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Loaded ${candles.length.toLocaleString()} raw 1m candles`);
  return candles;
}

function filterPrimaryContract(candles) {
  const hourVol = new Map();
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    if (!hourVol.has(h)) hourVol.set(h, new Map());
    const m = hourVol.get(h);
    m.set(c.symbol, (m.get(c.symbol) || 0) + (c.volume || 0));
  }
  const primaryByHour = new Map();
  for (const [h, m] of hourVol.entries()) {
    let bestSym = '', bestVol = 0;
    for (const [s, v] of m.entries()) if (v > bestVol) { bestVol = v; bestSym = s; }
    primaryByHour.set(h, bestSym);
  }
  const filtered = candles.filter(c => c.symbol === primaryByHour.get(Math.floor(c.timestamp / 3600000)));
  return { filtered, primaryByHour };
}

// --- GEX ---
function loadIntradayGEXCustom(dateStr) {
  const filename = `${PRODUCT.toLowerCase()}_gex_${dateStr}.json`;
  const filePath = path.join(DATA_DIR, 'gex', GEX_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return content.data || [];
}
function snapshotAtOrBefore(snapshots, targetTs) {
  if (!snapshots || !snapshots.length) return null;
  let best = null, bestTs = -Infinity;
  for (const s of snapshots) {
    const ts = new Date(s.timestamp).getTime();
    if (ts <= targetTs && ts > bestTs) { best = s; bestTs = ts; }
  }
  return best;
}
function extractLevels(snap) {
  const levels = [];
  if (!snap) return levels;
  if (snap.call_wall != null) levels.push({ type: 'call_wall', price: snap.call_wall, gex: snap.call_wall_gex || 0, isResistance: true });
  if (snap.put_wall != null) levels.push({ type: 'put_wall', price: snap.put_wall, gex: snap.put_wall_gex || 0, isResistance: false });
  if (snap.gamma_flip != null) levels.push({ type: 'gamma_flip', price: snap.gamma_flip, gex: 0, isResistance: null });
  if (Array.isArray(snap.resistance)) snap.resistance.forEach((p, i) => {
    if (p != null) levels.push({ type: `R${i + 1}`, price: p, gex: snap.resistance_gex?.[i] || 0, isResistance: true });
  });
  if (Array.isArray(snap.support)) snap.support.forEach((p, i) => {
    if (p != null) levels.push({ type: `S${i + 1}`, price: p, gex: snap.support_gex?.[i] || 0, isResistance: false });
  });
  return levels;
}

function todBucket(m) {
  if (m < 570) return 'pre_rth';
  if (m < 600) return 'open_30';
  if (m < 720) return 'morning';
  if (m < 840) return 'lunch';
  if (m < 930) return 'afternoon';
  if (m < 960) return 'close_30';
  return 'post_rth';
}
function gexMagBucket(absGex) {
  if (absGex < 1e8) return '<100M';
  if (absGex < 5e8) return '100M-500M';
  if (absGex < 1e9) return '500M-1B';
  if (absGex < 5e9) return '1B-5B';
  return '5B+';
}

function eodCutoffMsForDate(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  let utcMs = Date.UTC(y, mo - 1, d, EOD_HOUR + 5, EOD_MIN);
  const et = toET(utcMs);
  if (et.offset === -4) utcMs = Date.UTC(y, mo - 1, d, EOD_HOUR + 4, EOD_MIN);
  return utcMs;
}

// --- IV loaders ---
function loadIVRaw() {
  // For per-touch context: load minute-level raw QQQ ATM IV (call_iv, put_iv).
  const candidates = [
    path.join(DATA_DIR, 'iv', 'qqq', 'qqq_atm_iv_1m_raw.csv'),
    path.join(DATA_DIR, 'iv', 'qqq', 'qqq_atm_iv_1m.csv'),
  ];
  const f = candidates.find(p => fs.existsSync(p));
  if (!f) { console.log('⚠️  no IV CSV found, ivSkew/ivLevel features will be null'); return new Map(); }
  console.log(`Loading IV: ${f}`);
  const m = new Map();
  const txt = fs.readFileSync(f, 'utf-8');
  const lines = txt.split('\n');
  const head = lines[0].split(',');
  const tsIdx = head.findIndex(h => h.toLowerCase().includes('ts') || h.toLowerCase().includes('timestamp'));
  const ivIdx = head.findIndex(h => h.toLowerCase() === 'iv' || h.toLowerCase() === 'atm_iv');
  const callIdx = head.findIndex(h => h.toLowerCase() === 'call_iv' || h.toLowerCase() === 'call');
  const putIdx = head.findIndex(h => h.toLowerCase() === 'put_iv' || h.toLowerCase() === 'put');
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 2) continue;
    const ts = new Date(parts[tsIdx]).getTime();
    if (isNaN(ts)) continue;
    const rec = {
      iv: ivIdx >= 0 ? +parts[ivIdx] : null,
      callIV: callIdx >= 0 ? +parts[callIdx] : null,
      putIV: putIdx >= 0 ? +parts[putIdx] : null,
    };
    if (rec.callIV != null && rec.putIV != null) rec.skew = rec.putIV - rec.callIV;
    m.set(Math.floor(ts / 60000) * 60000, rec);
  }
  console.log(`  loaded ${m.size.toLocaleString()} 1m IV rows`);
  return m;
}
const ivByTs = loadIVRaw();
function getIVAt(ts) {
  const bucket = Math.floor(ts / 60000) * 60000;
  let rec = ivByTs.get(bucket);
  if (rec) return rec;
  for (let k = 1; k <= 5; k++) {
    rec = ivByTs.get(bucket - k * 60000);
    if (rec) return rec;
  }
  return null;
}

// --- Pattern detectors ---
// Each detector inspects bars1m[0..idx] for touch t.
// `state` is mutated to maintain detector progress within a touch window.
// Return null or a trigger spec: { pattern, direction, entry_price, stop_ref_price, just }
// entry will be assumed at bar.close, entry_ts = bar.timestamp + 60s.

function initTouchState() {
  return {
    R1: { disqualified: false, swingLow: null, swingHigh: null },
    R2: { disqualified: false, swingHigh: null, swingLow: null },
    R3: { fired: false },
    A1: { closesAbove: 0, broke: false, fired: false, retestLow: null },
    A2: { closesBelow: 0, broke: false, fired: false, retestHigh: null },
    F1: { fired: false },
    F2: { fired: false },
  };
}

const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall']);

// helper: 3-bar fractal swing detection. Returns true if bars1m[idx-1] is a confirmed swing low/high.
function isSwingLow(bars1m, idx) {
  if (idx < 2) return false;
  const a = bars1m[idx - 2], b = bars1m[idx - 1], c = bars1m[idx];
  return b.low < a.low && b.low < c.low;
}
function isSwingHigh(bars1m, idx) {
  if (idx < 2) return false;
  const a = bars1m[idx - 2], b = bars1m[idx - 1], c = bars1m[idx];
  return b.high > a.high && b.high > c.high;
}

function levelIsSupportFor(level, approach) {
  // For gamma_flip: treat as support if approach was from_above, resistance if from_below.
  if (level.type === 'gamma_flip') return approach === 'from_above';
  return SUPPORT_TYPES.has(level.type);
}
function levelIsResistanceFor(level, approach) {
  if (level.type === 'gamma_flip') return approach === 'from_below';
  return RESIST_TYPES.has(level.type);
}

// R1: bounce + HL break (support, LONG)
function tryR1(touch, bars1m, idx, state) {
  if (state.R1.fired) return null;
  if (touch.approach !== 'from_above') return null;
  if (!levelIsSupportFor(touch.level, touch.approach)) return null;
  const lvl = touch.level.price;
  const bar = bars1m[idx];
  if (bar.close < lvl - 3) { state.R1.disqualified = true; return null; }
  if (state.R1.disqualified) return null;

  // Confirm swing low (must be above level)
  if (!state.R1.swingLow && isSwingLow(bars1m, idx)) {
    const b = bars1m[idx - 1];
    if (b.low > lvl - 1) {
      state.R1.swingLow = { price: b.low, ts: b.timestamp };
    }
  }
  // After swing low, look for swing high
  if (state.R1.swingLow && !state.R1.swingHigh && isSwingHigh(bars1m, idx)) {
    const b = bars1m[idx - 1];
    if (b.timestamp > state.R1.swingLow.ts) {
      state.R1.swingHigh = { price: b.high, ts: b.timestamp };
    }
  }
  // Need confirmed pivot pair AND current bar's close > swingHigh.price
  if (state.R1.swingLow && state.R1.swingHigh && bar.close > state.R1.swingHigh.price) {
    const entryPrice = bar.close;
    const stopRef = state.R1.swingLow.price - STOP_BUFFER;
    const stopDist = entryPrice - stopRef;
    if (stopDist > MAX_STOP_PTS || stopDist <= 0) return null;
    state.R1.fired = true;
    return { pattern: 'R1', direction: 'long', entry_price: entryPrice, stop_price: stopRef, stop_distance: stopDist,
      just: `SL=${state.R1.swingLow.price.toFixed(2)} SH=${state.R1.swingHigh.price.toFixed(2)}` };
  }
  return null;
}

// R2: bounce + LH break (resistance, SHORT)
function tryR2(touch, bars1m, idx, state) {
  if (state.R2.fired) return null;
  if (touch.approach !== 'from_below') return null;
  if (!levelIsResistanceFor(touch.level, touch.approach)) return null;
  const lvl = touch.level.price;
  const bar = bars1m[idx];
  if (bar.close > lvl + 3) { state.R2.disqualified = true; return null; }
  if (state.R2.disqualified) return null;

  if (!state.R2.swingHigh && isSwingHigh(bars1m, idx)) {
    const b = bars1m[idx - 1];
    if (b.high < lvl + 1) {
      state.R2.swingHigh = { price: b.high, ts: b.timestamp };
    }
  }
  if (state.R2.swingHigh && !state.R2.swingLow && isSwingLow(bars1m, idx)) {
    const b = bars1m[idx - 1];
    if (b.timestamp > state.R2.swingHigh.ts) {
      state.R2.swingLow = { price: b.low, ts: b.timestamp };
    }
  }
  if (state.R2.swingHigh && state.R2.swingLow && bar.close < state.R2.swingLow.price) {
    const entryPrice = bar.close;
    const stopRef = state.R2.swingHigh.price + STOP_BUFFER;
    const stopDist = stopRef - entryPrice;
    if (stopDist > MAX_STOP_PTS || stopDist <= 0) return null;
    state.R2.fired = true;
    return { pattern: 'R2', direction: 'short', entry_price: entryPrice, stop_price: stopRef, stop_distance: stopDist,
      just: `SH=${state.R2.swingHigh.price.toFixed(2)} SL=${state.R2.swingLow.price.toFixed(2)}` };
  }
  return null;
}

// R3: pin + confirm. Pin detected on TOUCH bar; confirm bar = first 1m bar after touch
// whose close is in the rejection direction beyond the pin's "neck" (open/close midpoint).
function tryR3(touch, bars1m, idx, state) {
  if (state.R3.fired) return null;
  const touchBar = bars1m[0];  // bars1m[0] is the touch bar (we'll pass it as bars1m[0])
  const lvl = touch.level.price;
  const range = touchBar.high - touchBar.low;
  if (range <= 0) return null;
  const body = Math.abs(touchBar.close - touchBar.open);
  const upperWick = touchBar.high - Math.max(touchBar.open, touchBar.close);
  const lowerWick = Math.min(touchBar.open, touchBar.close) - touchBar.low;
  // Determine pin direction by approach
  let pinDir = null;
  if (touch.approach === 'from_above') {  // expecting bounce up = bullish pin
    if (lowerWick >= 2 * body && touchBar.low <= lvl + TOUCH_DISTANCE && touchBar.close > lvl) pinDir = 'long';
  } else {  // from_below — bearish pin
    if (upperWick >= 2 * body && touchBar.high >= lvl - TOUCH_DISTANCE && touchBar.close < lvl) pinDir = 'short';
  }
  if (!pinDir) return null;

  if (idx === 0) return null;  // need at least one confirmation bar
  const bar = bars1m[idx];
  const midline = (touchBar.open + touchBar.close) / 2;
  let confirmed = false;
  if (pinDir === 'long' && bar.close > midline && bar.close > touchBar.close) confirmed = true;
  if (pinDir === 'short' && bar.close < midline && bar.close < touchBar.close) confirmed = true;
  if (!confirmed) return null;

  const entryPrice = bar.close;
  let stopRef, stopDist;
  if (pinDir === 'long') {
    stopRef = touchBar.low - STOP_BUFFER;
    stopDist = entryPrice - stopRef;
  } else {
    stopRef = touchBar.high + STOP_BUFFER;
    stopDist = stopRef - entryPrice;
  }
  if (stopDist > MAX_STOP_PTS || stopDist <= 0) return null;
  state.R3.fired = true;
  return { pattern: 'R3', direction: pinDir, entry_price: entryPrice, stop_price: stopRef, stop_distance: stopDist,
    just: `pin(${pinDir}) wick ${pinDir==='long'?lowerWick:upperWick}/body ${body}` };
}

// A1: accept + retest hold (LONG break of resistance)
function tryA1(touch, bars1m, idx, state) {
  if (state.A1.fired) return null;
  if (touch.approach !== 'from_below') return null;
  if (!levelIsResistanceFor(touch.level, touch.approach)) return null;
  const lvl = touch.level.price;
  const bar = bars1m[idx];

  // Count consecutive closes above level
  if (bar.close > lvl + STOP_BUFFER) {
    state.A1.closesAbove++;
    if (state.A1.closesAbove >= ACCEPT_K) state.A1.broke = true;
  } else if (bar.close < lvl - 1) {
    state.A1.closesAbove = 0;
    state.A1.broke = false;  // back below; reset
    state.A1.retestLow = null;
  }
  if (!state.A1.broke) return null;

  // Look for retest: a bar whose low pulls back to within 3pt of level but closes still above
  if (!state.A1.retestLow) {
    if (bar.low <= lvl + 3 && bar.close > lvl) {
      state.A1.retestLow = { price: bar.low, ts: bar.timestamp };
    }
    return null;
  }
  // After a retest, trigger on the NEXT bar that closes above the retest bar's high
  const retestBar = bars1m.find(b => b.timestamp === state.A1.retestLow.ts);
  if (!retestBar) return null;
  if (bar.timestamp <= retestBar.timestamp) return null;
  if (bar.close > retestBar.high) {
    const entryPrice = bar.close;
    const stopRef = state.A1.retestLow.price - STOP_BUFFER;
    const stopDist = entryPrice - stopRef;
    if (stopDist > MAX_STOP_PTS || stopDist <= 0) return null;
    state.A1.fired = true;
    return { pattern: 'A1', direction: 'long', entry_price: entryPrice, stop_price: stopRef, stop_distance: stopDist,
      just: `K_above=${state.A1.closesAbove} retestLow=${state.A1.retestLow.price.toFixed(2)}` };
  }
  return null;
}

// A2: accept + retest hold (SHORT break of support)
function tryA2(touch, bars1m, idx, state) {
  if (state.A2.fired) return null;
  if (touch.approach !== 'from_above') return null;
  if (!levelIsSupportFor(touch.level, touch.approach)) return null;
  const lvl = touch.level.price;
  const bar = bars1m[idx];

  if (bar.close < lvl - STOP_BUFFER) {
    state.A2.closesBelow++;
    if (state.A2.closesBelow >= ACCEPT_K) state.A2.broke = true;
  } else if (bar.close > lvl + 1) {
    state.A2.closesBelow = 0;
    state.A2.broke = false;
    state.A2.retestHigh = null;
  }
  if (!state.A2.broke) return null;

  if (!state.A2.retestHigh) {
    if (bar.high >= lvl - 3 && bar.close < lvl) {
      state.A2.retestHigh = { price: bar.high, ts: bar.timestamp };
    }
    return null;
  }
  const retestBar = bars1m.find(b => b.timestamp === state.A2.retestHigh.ts);
  if (!retestBar) return null;
  if (bar.timestamp <= retestBar.timestamp) return null;
  if (bar.close < retestBar.low) {
    const entryPrice = bar.close;
    const stopRef = state.A2.retestHigh.price + STOP_BUFFER;
    const stopDist = stopRef - entryPrice;
    if (stopDist > MAX_STOP_PTS || stopDist <= 0) return null;
    state.A2.fired = true;
    return { pattern: 'A2', direction: 'short', entry_price: entryPrice, stop_price: stopRef, stop_distance: stopDist,
      just: `K_below=${state.A2.closesBelow} retestHigh=${state.A2.retestHigh.price.toFixed(2)}` };
  }
  return null;
}

// F1: fake-out long. Touch bar's low pierced support by >= FAKE_PIERCE_PTS, close > level. Trigger at touch bar's close.
function tryF1(touch, bars1m, idx, state) {
  if (state.F1.fired) return null;
  if (idx !== 0) return null;  // F1 fires on the touch bar itself
  if (touch.approach !== 'from_above') return null;
  if (!levelIsSupportFor(touch.level, touch.approach)) return null;
  const lvl = touch.level.price;
  const tb = bars1m[0];
  if (lvl - tb.low < FAKE_PIERCE_PTS) return null;
  if (tb.close <= lvl) return null;
  const entryPrice = tb.close;
  const stopRef = tb.low - STOP_BUFFER;
  const stopDist = entryPrice - stopRef;
  if (stopDist > MAX_STOP_PTS || stopDist <= 0) return null;
  state.F1.fired = true;
  return { pattern: 'F1', direction: 'long', entry_price: entryPrice, stop_price: stopRef, stop_distance: stopDist,
    just: `pierced ${(lvl - tb.low).toFixed(2)}pt close ${(tb.close - lvl).toFixed(2)}pt above` };
}
function tryF2(touch, bars1m, idx, state) {
  if (state.F2.fired) return null;
  if (idx !== 0) return null;
  if (touch.approach !== 'from_below') return null;
  if (!levelIsResistanceFor(touch.level, touch.approach)) return null;
  const lvl = touch.level.price;
  const tb = bars1m[0];
  if (tb.high - lvl < FAKE_PIERCE_PTS) return null;
  if (tb.close >= lvl) return null;
  const entryPrice = tb.close;
  const stopRef = tb.high + STOP_BUFFER;
  const stopDist = stopRef - entryPrice;
  if (stopDist > MAX_STOP_PTS || stopDist <= 0) return null;
  state.F2.fired = true;
  return { pattern: 'F2', direction: 'short', entry_price: entryPrice, stop_price: stopRef, stop_distance: stopDist,
    just: `pierced ${(tb.high - lvl).toFixed(2)}pt close ${(lvl - tb.close).toFixed(2)}pt below` };
}

const DETECTORS = [tryR1, tryR2, tryR3, tryA1, tryA2, tryF1, tryF2];

// --- 1s outcome walker for a market-entry trigger ---
function bsearchFirstAtOrAfter(secondBars, targetTs) {
  let lo = 0, hi = secondBars.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (secondBars[m].ts < targetTs) lo = m + 1; else hi = m;
  }
  return lo;
}

// targetsArr: array of target prices to evaluate simultaneously. Returns:
//   outcome at the FIRST target/stop hit AND first-hit timestamp per target,
//   plus full MFE/MAE through to stop/eod/maxhold/rollover.
function resolveTriggerOutcomeMulti(secondBars, signalContract, triggerTs, entryPrice, stopPrice,
                                    targetPrices, direction, maxHoldTs, eodCutoffMs) {
  const stopTs = Math.min(maxHoldTs, eodCutoffMs);
  const startIdx = bsearchFirstAtOrAfter(secondBars, triggerTs);
  let mfe = 0, mae = 0;
  let lastBar = null;
  const targetsHit = new Array(targetPrices.length).fill(null);  // first hit ts per target
  let stoppedAt = null;  // first ts where stop hit
  for (let i = startIdx; i < secondBars.length; i++) {
    const b = secondBars[i];
    if (b.ts > stopTs) {
      const isEod = eodCutoffMs <= maxHoldTs;
      return { outcome: isEod ? 'eod' : 'timeout',
        exit_ts: lastBar ? lastBar.ts : b.ts, exit_price: lastBar ? lastBar.close : b.open,
        mfe, mae, targetsHit, stoppedAt };
    }
    if (b.symbol !== signalContract) {
      return { outcome: 'rollover',
        exit_ts: lastBar ? lastBar.ts : b.ts, exit_price: lastBar ? lastBar.close : b.open,
        mfe, mae, targetsHit, stoppedAt };
    }
    // Update excursion + check stop
    if (direction === 'long') {
      const up = b.high - entryPrice;
      const dn = entryPrice - b.low;
      if (up > mfe) mfe = up;
      if (dn > mae) mae = dn;
      for (let k = 0; k < targetPrices.length; k++) {
        if (targetsHit[k] == null && b.high >= targetPrices[k]) targetsHit[k] = b.ts;
      }
      if (stoppedAt == null && b.low <= stopPrice) {
        stoppedAt = b.ts;
        // first-target-vs-stop on same bar: stop wins (conservative)
        // but if any target was already hit on a prior bar, it stays hit
        return { outcome: 'stop', exit_ts: b.ts, exit_price: stopPrice,
          mfe, mae, targetsHit, stoppedAt };
      }
    } else {
      const dn = entryPrice - b.low;
      const up = b.high - entryPrice;
      if (dn > mfe) mfe = dn;
      if (up > mae) mae = up;
      for (let k = 0; k < targetPrices.length; k++) {
        if (targetsHit[k] == null && b.low <= targetPrices[k]) targetsHit[k] = b.ts;
      }
      if (stoppedAt == null && b.high >= stopPrice) {
        stoppedAt = b.ts;
        return { outcome: 'stop', exit_ts: b.ts, exit_price: stopPrice,
          mfe, mae, targetsHit, stoppedAt };
      }
    }
    lastBar = b;
  }
  return { outcome: 'timeout',
    exit_ts: lastBar ? lastBar.ts : null, exit_price: lastBar ? lastBar.close : null,
    mfe, mae, targetsHit, stoppedAt };
}

function resolveTriggerOutcome(secondBars, signalContract, triggerTs, entryPrice, stopPrice, targetPrice,
                               direction, maxHoldTs, eodCutoffMs) {
  const stopTs = Math.min(maxHoldTs, eodCutoffMs);
  const startIdx = bsearchFirstAtOrAfter(secondBars, triggerTs);
  let mfe = 0, mae = 0;
  let lastBar = null;
  for (let i = startIdx; i < secondBars.length; i++) {
    const b = secondBars[i];
    if (b.ts > stopTs) {
      const isEod = eodCutoffMs <= maxHoldTs;
      return {
        outcome: isEod ? 'eod' : 'timeout',
        exit_ts: lastBar ? lastBar.ts : b.ts, exit_price: lastBar ? lastBar.close : b.open,
        mfe, mae,
      };
    }
    if (b.symbol !== signalContract) {
      return {
        outcome: 'rollover',
        exit_ts: lastBar ? lastBar.ts : b.ts, exit_price: lastBar ? lastBar.close : b.open,
        mfe, mae,
      };
    }
    // Excursion
    if (direction === 'long') {
      const up = b.high - entryPrice;
      const dn = entryPrice - b.low;
      if (up > mfe) mfe = up;
      if (dn > mae) mae = dn;
      const targetHit = b.high >= targetPrice;
      const stopHit = b.low <= stopPrice;
      if (targetHit && stopHit) return { outcome: 'loss', exit_ts: b.ts, exit_price: stopPrice, mfe, mae };
      if (targetHit) return { outcome: 'win', exit_ts: b.ts, exit_price: targetPrice, mfe, mae };
      if (stopHit) return { outcome: 'loss', exit_ts: b.ts, exit_price: stopPrice, mfe, mae };
    } else {
      const dn = entryPrice - b.low;
      const up = b.high - entryPrice;
      if (dn > mfe) mfe = dn;
      if (up > mae) mae = up;
      const targetHit = b.low <= targetPrice;
      const stopHit = b.high >= stopPrice;
      if (targetHit && stopHit) return { outcome: 'loss', exit_ts: b.ts, exit_price: stopPrice, mfe, mae };
      if (targetHit) return { outcome: 'win', exit_ts: b.ts, exit_price: targetPrice, mfe, mae };
      if (stopHit) return { outcome: 'loss', exit_ts: b.ts, exit_price: stopPrice, mfe, mae };
    }
    lastBar = b;
  }
  return {
    outcome: 'timeout',
    exit_ts: lastBar ? lastBar.ts : null, exit_price: lastBar ? lastBar.close : null,
    mfe, mae,
  };
}

// --- Main ---
async function run() {
  const tStart = Date.now();
  const allCandles = await loadRawNQ(START, END);
  const { filtered: candles, primaryByHour } = filterPrimaryContract(allCandles);
  console.log(`After primary-contract filter: ${candles.length.toLocaleString()} candles`);

  // Group 1m by date
  const byDate = new Map();
  for (const c of candles) {
    const et = toET(c.timestamp);
    if (et.dayOfWeek < 1 || et.dayOfWeek > 5) continue;
    if (!byDate.has(et.date)) byDate.set(et.date, []);
    byDate.get(et.date).push({ candle: c, et });
  }
  const tradingDates = Array.from(byDate.keys()).sort();
  console.log(`Trading dates: ${tradingDates.length}\n`);

  // Build touches per date (similar to v3)
  const touchesByDate = new Map();
  let totalTouches = 0;
  for (const dateStr of tradingDates) {
    const snapshots = loadIntradayGEXCustom(dateStr);
    if (!snapshots || !snapshots.length) { touchesByDate.set(dateStr, { touches: [], candles: byDate.get(dateStr).map(x=>x.candle), snapshots: [] }); continue; }
    const dayCandles = byDate.get(dateStr);
    const candlesArr = dayCandles.map(x => x.candle);
    // index 1m by ts for fast lookup
    const tsToIdx = new Map();
    candlesArr.forEach((c, i) => tsToIdx.set(c.timestamp, i));
    let prevClose = null;
    const dayTouches = [];
    for (let i = 0; i < dayCandles.length; i++) {
      const { candle: c, et } = dayCandles[i];
      if (et.timeInMinutes < 570 || et.timeInMinutes >= 960) { prevClose = c.close; continue; }
      const snap = snapshotAtOrBefore(snapshots, c.timestamp - SNAP_LAG_MIN * 60000);
      if (!snap) { prevClose = c.close; continue; }
      const levels = extractLevels(snap);
      for (const lvl of levels) {
        if (lvl.price == null || isNaN(lvl.price)) continue;
        const distLow = Math.abs(c.low - lvl.price);
        const distHigh = Math.abs(c.high - lvl.price);
        const inside = c.low <= lvl.price && lvl.price <= c.high;
        const edgeMin = Math.min(distLow, distHigh);
        if (edgeMin > TOUCH_DISTANCE) continue;
        if (prevClose == null) continue;
        let approach;
        if (prevClose > lvl.price) approach = 'from_above';
        else if (prevClose < lvl.price) approach = 'from_below';
        else continue;
        dayTouches.push({
          touch: c, et, level: lvl, approach, snap,
          touch_idx: i,  // index into dayCandles
          min_dist_1m: inside ? 0 : edgeMin,
        });
      }
      prevClose = c.close;
    }
    touchesByDate.set(dateStr, { touches: dayTouches, candles: candlesArr, snapshots });
    totalTouches += dayTouches.length;
  }
  console.log(`Touches detected: ${totalTouches.toLocaleString()}\n`);

  // Stream 1s data per day
  console.log(`Streaming 1s OHLCV (per-day processing) ...`);
  const onesPath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1s.csv`);
  if (!fs.existsSync(onesPath)) throw new Error(`1s file not found: ${onesPath}`);

  const scanStartIso = new Date(START).toISOString();
  const scanEndIso = new Date(new Date(END).getTime() + 36 * 3600000).toISOString();

  let curDate = null;
  let curBars = [];
  const allTriggers = [];
  let processedDays = 0;
  let touchesProcessed = 0;
  let totalTriggerCount = 0;
  const stats = { win: 0, loss: 0, timeout: 0, eod: 0, rollover: 0, no_trigger: 0 };
  const perPatternCount = {};

  function processDay(dateStr, secondBars) {
    const dayInfo = touchesByDate.get(dateStr);
    if (!dayInfo) return;
    const { touches, candles: dayCandles } = dayInfo;
    if (touches.length === 0 || secondBars.length === 0) return;
    const eodCutoffMs = eodCutoffMsForDate(dateStr);

    for (const t of touches) {
      touchesProcessed++;
      const state = initTouchState();
      // Build journey: bars from touch_idx to touch_idx + TRIGGER_WINDOW
      const startIdx = t.touch_idx;
      const endIdx = Math.min(dayCandles.length - 1, startIdx + MAX_TRIGGER_WINDOW_MIN);
      const journey = dayCandles.slice(startIdx, endIdx + 1);
      // For each 1m bar in journey, run detectors
      let touchTriggers = [];
      for (let j = 0; j < journey.length; j++) {
        for (const det of DETECTORS) {
          const trig = det(t, journey, j, state);
          if (trig) {
            // trigger at end of this 1m bar
            const triggerTs = journey[j].timestamp + 60_000;
            const targetPrices = TARGET_LADDER.map(pts => trig.direction === 'long' ? trig.entry_price + pts : trig.entry_price - pts);
            const maxHoldTs = triggerTs + MAX_HOLD_MIN * 60 * 1000;
            const rmulti = resolveTriggerOutcomeMulti(secondBars, t.touch.symbol, triggerTs,
              trig.entry_price, trig.stop_price, targetPrices, trig.direction, maxHoldTs, eodCutoffMs);
            // Primary outcome at TARGET_POINTS (first in ladder typically = 20)
            const primaryIdx = TARGET_LADDER.indexOf(TARGET_POINTS);
            const r = (() => {
              // Determine outcome at primary target:
              if (rmulti.outcome === 'rollover') return { outcome: 'rollover', exit_ts: rmulti.exit_ts, exit_price: rmulti.exit_price, mfe: rmulti.mfe, mae: rmulti.mae };
              const tHit = rmulti.targetsHit[primaryIdx];
              const sHit = rmulti.stoppedAt;
              if (tHit != null && (sHit == null || tHit < sHit)) {
                return { outcome: 'win', exit_ts: tHit, exit_price: targetPrices[primaryIdx], mfe: rmulti.mfe, mae: rmulti.mae };
              }
              if (sHit != null) {
                return { outcome: 'loss', exit_ts: sHit, exit_price: trig.stop_price, mfe: rmulti.mfe, mae: rmulti.mae };
              }
              return { outcome: rmulti.outcome, exit_ts: rmulti.exit_ts, exit_price: rmulti.exit_price, mfe: rmulti.mfe, mae: rmulti.mae };
            })();
            // ladder_outcomes: per-target win/loss flag based on first-hit time vs stop
            const ladderOutcomes = TARGET_LADDER.map((pts, k) => {
              const tHit = rmulti.targetsHit[k];
              const sHit = rmulti.stoppedAt;
              if (tHit != null && (sHit == null || tHit < sHit)) return 'win';
              if (sHit != null) return 'loss';
              return rmulti.outcome;  // timeout/eod/rollover
            });
            const ivRec = getIVAt(triggerTs);
            // 5m vol ratio: avg of prior 5 1m volumes vs trigger bar volume
            const triggerBarVol = journey[j].volume;
            const priorVols = [];
            for (let k = 1; k <= 5; k++) {
              const idx2 = startIdx + j - k;
              if (idx2 >= 0 && dayCandles[idx2]) priorVols.push(dayCandles[idx2].volume);
            }
            const meanPrior5 = priorVols.length ? priorVols.reduce((a, b) => a + b, 0) / priorVols.length : 0;
            const volRatio5m = meanPrior5 > 0 ? triggerBarVol / meanPrior5 : null;

            const rec = {
              touch_id: allTriggers.length,
              touch_ts: t.touch.timestamp,
              touch_date: dateStr,
              touch_time_et: `${String(Math.floor(t.et.timeInMinutes / 60)).padStart(2,'0')}:${String(t.et.timeInMinutes % 60).padStart(2,'0')}`,
              tod: todBucket(t.et.timeInMinutes),
              level_type: t.level.type,
              level_price: t.level.price,
              level_gex: t.level.gex,
              level_is_resistance: t.level.isResistance,
              approach: t.approach,
              regime: t.snap.regime || 'unknown',
              gex_mag_bucket: gexMagBucket(Math.abs(t.level.gex)),
              gamma_imbalance: t.snap.gamma_imbalance || 0,
              min_dist_1m: t.min_dist_1m,

              pattern: trig.pattern,
              direction: trig.direction,
              minutes_after_touch: j,
              trigger_ts: triggerTs,
              entry_price: trig.entry_price,
              stop_price: trig.stop_price,
              stop_distance: trig.stop_distance,
              target_price: targetPrices[primaryIdx],
              justification: trig.just,

              outcome: r.outcome,
              exit_ts: r.exit_ts,
              exit_price: r.exit_price,
              mfe: r.mfe,
              mae: r.mae,

              // Ladder of (target, outcome) for stretch-target evaluation.
              // True MFE is preserved because the walker only stops on stop/eod/rollover.
              target_ladder: TARGET_LADDER,
              ladder_outcomes: ladderOutcomes,
              ladder_hit_ts: rmulti.targetsHit,
              stopped_at: rmulti.stoppedAt,

              iv_skew_trigger: ivRec?.skew ?? null,
              iv_level_trigger: ivRec?.iv ?? null,
              vol_ratio_5m_trigger: volRatio5m,
            };
            allTriggers.push(rec);
            touchTriggers.push(rec);
            totalTriggerCount++;
            stats[r.outcome] = (stats[r.outcome] || 0) + 1;
            perPatternCount[trig.pattern] = (perPatternCount[trig.pattern] || 0) + 1;
          }
        }
      }
      if (touchTriggers.length === 0) stats.no_trigger++;
    }
  }

  const stream = fs.createReadStream(onesPath, { highWaterMark: 1 << 20 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  let scanned = 0, kept = 0;
  const tScanStart = Date.now();

  for await (const line of rl) {
    if (!header) { header = line; continue; }
    scanned++;
    if (scanned % 20000000 === 0) {
      const sec = ((Date.now() - tScanStart) / 1000).toFixed(0);
      process.stdout.write(`  scanned ${(scanned / 1e6).toFixed(0)}M  kept ${kept.toLocaleString()}  days=${processedDays}/${tradingDates.length}  triggers=${totalTriggerCount}  (${sec}s)\n`);
    }
    const c0 = line.indexOf(',');
    if (c0 < 0) continue;
    const tsStr = line.slice(0, c0);
    if (tsStr < scanStartIso) continue;
    if (tsStr > scanEndIso) break;
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const symbol = parts[9];
    if (symbol.includes('-')) continue;
    const ts = new Date(tsStr).getTime();
    const hourBucket = Math.floor(ts / 3600000);
    const primarySym = primaryByHour.get(hourBucket);
    if (primarySym && symbol !== primarySym) continue;

    const et = toET(ts);
    const barDate = et.date;
    if (barDate !== curDate) {
      if (curDate != null && curBars.length > 0) {
        processDay(curDate, curBars);
        processedDays++;
      }
      curDate = barDate;
      curBars = [];
    }
    curBars.push({
      ts,
      open: +parts[4], high: +parts[5], low: +parts[6], close: +parts[7],
      symbol,
    });
    kept++;
  }
  if (curDate != null && curBars.length > 0) {
    processDay(curDate, curBars);
    processedDays++;
  }
  rl.close(); stream.destroy();

  const totalSec = ((Date.now() - tScanStart) / 1000).toFixed(0);
  console.log(`\n1s scan done: ${scanned.toLocaleString()} rows, ${kept.toLocaleString()} kept (${totalSec}s)`);
  console.log(`Touches processed:  ${touchesProcessed.toLocaleString()}`);
  console.log(`Total triggers:     ${totalTriggerCount.toLocaleString()}`);
  console.log(`Stats:`, stats);
  console.log(`Per-pattern triggers:`, perPatternCount);

  // Per-pattern summary
  console.log(`\n=== Per-pattern outcome breakdown ===`);
  const patternStats = {};
  for (const t of allTriggers) {
    const p = t.pattern;
    if (!patternStats[p]) patternStats[p] = { n: 0, win: 0, loss: 0, timeout: 0, eod: 0, rollover: 0, total_pts: 0, total_mfe: 0, total_mae: 0, sum_stop_dist: 0 };
    const s = patternStats[p];
    s.n++;
    s[t.outcome] = (s[t.outcome] || 0) + 1;
    s.total_mfe += t.mfe || 0;
    s.total_mae += t.mae || 0;
    s.sum_stop_dist += t.stop_distance;
    if (t.outcome === 'win') s.total_pts += TARGET_POINTS;
    else if (t.outcome === 'loss') s.total_pts -= t.stop_distance;
  }
  console.log('pattern   n     W   L  TO  EOD ROv  WR     PF   avgStop  totalPts');
  for (const p of Object.keys(patternStats).sort()) {
    const s = patternStats[p];
    const decided = s.win + s.loss;
    const wr = decided > 0 ? s.win / decided : null;
    const winsPts = s.win * TARGET_POINTS;
    const lossPts = (s.sum_stop_dist / Math.max(1, s.n)) * s.loss;
    const pf = lossPts > 0 ? winsPts / lossPts : (s.win > 0 ? Infinity : 0);
    const avgStop = s.sum_stop_dist / Math.max(1, s.n);
    console.log(
      p.padEnd(8), String(s.n).padStart(5),
      String(s.win).padStart(4), String(s.loss).padStart(4), String(s.timeout).padStart(4), String(s.eod || 0).padStart(4), String(s.rollover || 0).padStart(4),
      (wr != null ? (wr * 100).toFixed(1) + '%' : '-').padStart(7),
      (isFinite(pf) ? pf.toFixed(2) : '∞').padStart(6),
      avgStop.toFixed(1).padStart(8),
      String(Math.round(s.total_pts)).padStart(9),
    );
  }

  // Save
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(OUT_DIR, `gex-touch-patterns-base-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    config: { START, END, TOUCH_DISTANCE, MAX_TRIGGER_WINDOW_MIN, MAX_HOLD_MIN, TARGET_POINTS, STOP_BUFFER, ACCEPT_K, FAKE_PIERCE_PTS, MAX_STOP_PTS, SNAP_LAG_MIN, EOD_CUTOFF_ET },
    summary: { touchesProcessed, totalTriggerCount, stats, perPatternCount },
    triggers: allTriggers,
  }, null, 2));
  console.log(`\nWritten: ${outPath}`);
  console.log(`\nElapsed: ${((Date.now() - tStart) / 1000).toFixed(0)}s`);
}

run().catch(err => { console.error(err); process.exit(1); });
