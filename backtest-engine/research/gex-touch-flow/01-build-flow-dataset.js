/**
 * GEX-Touch Flow — Phase 1: enriched touch event dataset.
 *
 * Framework (2026-05-14):
 *   - Every touch of a GEX level (within TOUCH_DISTANCE pts) is a candidate event
 *   - For each touch, compute rolling-window microstructure features (no
 *     lookahead) from 1m candles around the touch + 1s flow during touch min
 *   - For each touch, walk 1s OHLCV forward from touch_ts + 60s in BOTH
 *     directions ("bounce" = away from approach, "break" = continuation)
 *     capturing MFE/MAE at horizons {5m, 15m, 30m} and time-to-target at
 *     {15, 20, 25} pts plus time-to-MAE at {5, 8, 10, 12, 15} pts
 *   - 1s-honest discipline per CLAUDE.md
 *
 * Output: research/output/gex-touch-flow-${ts}.json
 *   { config, touches: [{ ts, features, bounce_outcome, break_outcome, ... }] }
 *
 * Usage:
 *   node research/gex-touch-flow/01-build-flow-dataset.js \
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
const SNAP_LAG_MIN = Number(arg('snap-lag-min', 16));
const EOD_CUTOFF_ET = arg('eod-cutoff-et', '16:40');
const COOLDOWN_MIN = Number(arg('cooldown-min', 0));  // skip touches within N min of last touch of same level
const MAX_HOLD_MIN = 30;  // max walk horizon (covers 5/15/30)

// MAE/MFE tier ladders — recorded per touch, per direction
const TARGET_PTS = [5, 7, 8, 10, 12, 15, 18, 20, 22, 25];
const STOP_PTS = [3, 4, 5, 6, 7, 8, 10, 12, 15];
const HORIZONS_MIN = [1, 2, 3, 5, 10, 15, 30];

console.log(`\n=== GEX Touch Flow — Phase 1 (enriched dataset, 1s-honest) ===`);
console.log(`Range:                ${START} → ${END}`);
console.log(`Touch distance:       ${TOUCH_DISTANCE} pts`);
console.log(`Cooldown per level:   ${COOLDOWN_MIN} min`);
console.log(`Max forward walk:     ${MAX_HOLD_MIN} min`);
console.log(`Snap lag:             ${SNAP_LAG_MIN} min`);
console.log(`EOD cutoff (ET):      ${EOD_CUTOFF_ET}\n`);

const [EOD_HOUR, EOD_MIN] = EOD_CUTOFF_ET.split(':').map(Number);

// --- Loaders (reuse pattern from gex-touch-patterns) ---
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

function eodCutoffMsForDate(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  let utcMs = Date.UTC(y, mo - 1, d, EOD_HOUR + 5, EOD_MIN);
  const et = toET(utcMs);
  if (et.offset === -4) utcMs = Date.UTC(y, mo - 1, d, EOD_HOUR + 4, EOD_MIN);
  return utcMs;
}

function todBucket(min) {
  if (min < 540) return 'pre_rth_early';   // < 09:00
  if (min < 570) return 'pre_rth_late';     // 09:00-09:30
  if (min < 600) return 'rth_open';         // 09:30-10:00
  if (min < 720) return 'rth_morn';         // 10:00-12:00
  if (min < 780) return 'rth_lunch';        // 12:00-13:00
  if (min < 930) return 'rth_aft';          // 13:00-15:30
  if (min < 960) return 'rth_close';        // 15:30-16:00
  return 'after_rth';
}

// ---------- Feature computation per touch ----------
function computeFeatures1m(touch, dayCandles, touchIdx, snap, levels, sameLevelTouchesToday) {
  const f = {};
  const lvl = touch.level.price;
  const bar = touch.touch;

  // A. Approach (5m/15m via 1m bars)
  const prior5 = dayCandles.slice(Math.max(0, touchIdx - 5), touchIdx);
  const prior15 = dayCandles.slice(Math.max(0, touchIdx - 15), touchIdx);
  const prior30 = dayCandles.slice(Math.max(0, touchIdx - 30), touchIdx);

  f.approach = touch.approach;
  f.touch_distance_pts = +touch.min_dist_1m.toFixed(2);
  f.close_dist_from_level = +(bar.close - lvl).toFixed(2);

  if (prior5.length >= 2) {
    f.approach_speed_5m = +((bar.close - prior5[0].close) / prior5.length).toFixed(2);
  }
  if (prior15.length >= 2) {
    f.approach_speed_15m = +((bar.close - prior15[0].close) / prior15.length).toFixed(2);
  }

  // approach consistency: % of bars in approach direction
  if (prior5.length >= 3) {
    const sign = touch.approach === 'from_above' ? -1 : 1;
    let aligned = 0;
    for (let i = 1; i < prior5.length; i++) {
      const delta = prior5[i].close - prior5[i - 1].close;
      if (Math.sign(delta) === sign) aligned++;
    }
    f.approach_consistency_5m = +(aligned / (prior5.length - 1)).toFixed(2);
  }

  // distance traveled in approach direction over last 5 bars
  if (prior5.length >= 2) {
    if (touch.approach === 'from_above') {
      const maxH = Math.max(...prior5.map(c => c.high));
      f.distance_traveled_5m = +(maxH - bar.close).toFixed(2);
    } else {
      const minL = Math.min(...prior5.map(c => c.low));
      f.distance_traveled_5m = +(bar.close - minL).toFixed(2);
    }
  }

  // ATR(14) crude
  if (prior15.length >= 14) {
    const trs = prior15.slice(-14).map((c, i, arr) => {
      if (i === 0) return c.high - c.low;
      const pc = arr[i - 1].close;
      return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    });
    const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
    f.atr_14 = +atr.toFixed(2);
    f.touch_range_atr_ratio = atr > 0 ? +((bar.high - bar.low) / atr).toFixed(2) : null;
  }

  // B. Touch bar 1m features
  const range = bar.high - bar.low;
  f.touch_range_pts = +range.toFixed(2);
  f.touch_body_pos = range > 0 ? +((bar.close - bar.low) / range).toFixed(2) : 0.5;
  f.touch_body_range_ratio = range > 0 ? +(Math.abs(bar.close - bar.open) / range).toFixed(2) : 0;
  f.touch_upper_wick = +(bar.high - Math.max(bar.open, bar.close)).toFixed(2);
  f.touch_lower_wick = +(Math.min(bar.open, bar.close) - bar.low).toFixed(2);
  // wick rejecting the level
  if (touch.approach === 'from_above') {
    f.touch_wick_at_level = f.touch_lower_wick;  // wicked down toward support
  } else {
    f.touch_wick_at_level = f.touch_upper_wick;  // wicked up toward resistance
  }
  f.touch_close_relative = touch.approach === 'from_above'
    ? +(bar.close - lvl).toFixed(2)  // positive = closed above support
    : +(lvl - bar.close).toFixed(2); // positive = closed below resistance
  f.touch_engulfing = touchIdx > 0 ? (
    bar.high >= dayCandles[touchIdx - 1].high && bar.low <= dayCandles[touchIdx - 1].low
  ) : false;
  f.touch_pinbar = range > 0 && f.touch_wick_at_level >= 2 * Math.abs(bar.close - bar.open) ? true : false;
  f.touch_doji = range > 0 && Math.abs(bar.close - bar.open) / range < 0.15;

  // C. Volume features (the "big boys" hypothesis)
  f.vol_touch_bar = bar.volume;
  if (prior5.length >= 3) {
    const mean5 = prior5.reduce((s, c) => s + c.volume, 0) / prior5.length;
    f.vol_ratio_5m = mean5 > 0 ? +(bar.volume / mean5).toFixed(2) : null;
  }
  if (prior15.length >= 5) {
    const mean15 = prior15.reduce((s, c) => s + c.volume, 0) / prior15.length;
    const std15 = Math.sqrt(prior15.reduce((s, c) => s + (c.volume - mean15) ** 2, 0) / prior15.length);
    f.vol_ratio_15m = mean15 > 0 ? +(bar.volume / mean15).toFixed(2) : null;
    f.vol_zscore_15m = std15 > 0 ? +((bar.volume - mean15) / std15).toFixed(2) : null;
  }
  if (prior30.length >= 10) {
    const mean30 = prior30.reduce((s, c) => s + c.volume, 0) / prior30.length;
    f.vol_ratio_30m = mean30 > 0 ? +(bar.volume / mean30).toFixed(2) : null;
  }
  // Volume trend (sign of slope over last 15 bars)
  if (prior15.length >= 5) {
    const n = prior15.length;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += prior15[i].volume; sxy += i * prior15[i].volume; sxx += i * i; }
    const slope = (n * sxy - sx * sy) / Math.max(1, n * sxx - sx * sx);
    f.vol_trend_15m_slope = +slope.toFixed(2);
    f.vol_trend_15m_sign = slope > 0 ? 1 : (slope < 0 ? -1 : 0);
  }
  // Recent burst: was there a big-vol bar in last 5?
  if (prior5.length >= 3) {
    const maxRecent = Math.max(...prior5.map(c => c.volume));
    const meanRecent = prior5.reduce((s, c) => s + c.volume, 0) / prior5.length;
    f.vol_max_to_mean_5m = meanRecent > 0 ? +(maxRecent / meanRecent).toFixed(2) : null;
  }

  // E. Level context
  f.level_type = touch.level.type;
  f.level_gex_mag = Math.abs(touch.level.gex || 0);
  f.regime = snap?.regime ?? null;
  f.gamma_imbalance = snap?.gamma_imbalance != null ? +snap.gamma_imbalance.toFixed(3) : null;

  // gex rank within snapshot
  const ranked = levels
    .filter(l => l.price != null && !isNaN(l.price))
    .map(l => Math.abs(l.gex || 0))
    .sort((a, b) => b - a);
  const myMag = Math.abs(touch.level.gex || 0);
  f.level_gex_rank = ranked.indexOf(myMag) + 1;
  f.level_gex_pct = ranked.length > 0 ? +(myMag / Math.max(1, ranked[0])).toFixed(2) : 0;

  // Distance to nearest opposite-side level
  // Opposite side relative to touch level: if support, look for next level below (further down);
  // for room-to-run on a break (approach direction continuation) we need next level in approach direction.
  const sorted = levels
    .map(l => ({ ...l, abs: Math.abs(l.price - lvl) }))
    .filter(l => l.abs > 0.5)
    .sort((a, b) => a.abs - b.abs);
  let nextAbove = null, nextBelow = null;
  for (const l of sorted) {
    if (l.price > lvl + 0.5 && !nextAbove) nextAbove = l;
    if (l.price < lvl - 0.5 && !nextBelow) nextBelow = l;
    if (nextAbove && nextBelow) break;
  }
  if (touch.approach === 'from_above') {
    // approach direction is DOWN; break = further down (need room below), bounce = up
    f.dist_next_break_level = nextBelow ? +(lvl - nextBelow.price).toFixed(2) : null;
    f.dist_next_bounce_level = nextAbove ? +(nextAbove.price - lvl).toFixed(2) : null;
  } else {
    f.dist_next_break_level = nextAbove ? +(nextAbove.price - lvl).toFixed(2) : null;
    f.dist_next_bounce_level = nextBelow ? +(lvl - nextBelow.price).toFixed(2) : null;
  }

  // F. Recent history at this level today
  f.tests_today_so_far = sameLevelTouchesToday;

  // G. Session
  f.minute_of_day = touch.et.timeInMinutes;
  f.tod_bucket = todBucket(touch.et.timeInMinutes);
  f.dow = touch.et.dayOfWeek;

  return f;
}

// ---------- 1s flow features (within touch minute window: touch_ts to touch_ts+60s) ----------
function compute1sFeatures(secondBars, touchTs, lvl, signalContract) {
  // bars in [touchTs, touchTs + 60s)
  const winEnd = touchTs + 60_000;
  let minDist = Infinity;
  let maxPen = -Infinity;
  let maxWickPast = 0;
  let secondsAtLevel = 0;
  let firstRejectionSec = null;
  let totalVol = 0;
  const allVols = [];
  let priorTs = null;
  for (let i = 0; i < secondBars.length; i++) {
    const b = secondBars[i];
    if (b.ts < touchTs) continue;
    if (b.ts >= winEnd) break;
    if (b.symbol !== signalContract) continue;
    // closest distance from level
    const distH = Math.abs(b.high - lvl);
    const distL = Math.abs(b.low - lvl);
    const dist = (b.low <= lvl && lvl <= b.high) ? 0 : Math.min(distH, distL);
    if (dist < minDist) minDist = dist;
    // penetration past level (signed past)
    if (b.low <= lvl && lvl <= b.high) {
      // candle straddles level, partial penetration
      const pen = Math.max(lvl - b.low, b.high - lvl);
      if (pen > maxPen) maxPen = pen;
    }
    // wick past level (largest single-1s wick past level)
    let wickPast = 0;
    if (b.high > lvl && b.close < lvl) wickPast = b.high - lvl;
    if (b.low < lvl && b.close > lvl) wickPast = lvl - b.low;
    if (wickPast > maxWickPast) {
      maxWickPast = wickPast;
      if (firstRejectionSec == null) firstRejectionSec = Math.floor((b.ts - touchTs) / 1000);
    }
    // seconds at level (close within 2pt of level)
    if (Math.abs(b.close - lvl) <= 2) secondsAtLevel++;
    totalVol += b.volume || 0;
    allVols.push(b.volume || 0);
  }
  if (allVols.length === 0) return {};
  allVols.sort((a, b) => b - a);
  const top3 = allVols.slice(0, 3).reduce((a, b) => a + b, 0);
  return {
    s1_min_dist_pts: minDist === Infinity ? null : +minDist.toFixed(2),
    s1_max_penetration_pts: maxPen === -Infinity ? 0 : +maxPen.toFixed(2),
    s1_max_wick_past_pts: +maxWickPast.toFixed(2),
    s1_seconds_at_level: secondsAtLevel,
    s1_first_rejection_sec: firstRejectionSec,
    s1_total_vol: totalVol,
    s1_top3_vol: top3,
    s1_top3_vol_pct: totalVol > 0 ? +(top3 / totalVol).toFixed(2) : null,
    s1_bars_seen: allVols.length,
  };
}

// ---------- 1s forward walk: capture MFE/MAE and time-to-target/stop per touch ----------
function bsearch(secondBars, targetTs) {
  let lo = 0, hi = secondBars.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (secondBars[m].ts < targetTs) lo = m + 1; else hi = m;
  }
  return lo;
}

function forwardWalk(secondBars, signalContract, walkStartTs, entryPrice, direction, maxHoldTs, eodCutoffMs) {
  const stopTs = Math.min(maxHoldTs, eodCutoffMs);
  const startIdx = bsearch(secondBars, walkStartTs);
  // Capture MFE/MAE per horizon
  const out = {
    direction,
    entry_price: entryPrice,
    rolloverAt: null,
    finalTs: null,
    mfe_pts: 0,
    mae_pts: 0,
    mfe_by_horizon: {},
    mae_by_horizon: {},
    time_to_target_sec: {},
    time_to_stop_sec: {},
    closes: {},  // close at +3/+5/+10/+15/+30 min
  };
  for (const m of HORIZONS_MIN) {
    out.mfe_by_horizon[m] = 0;
    out.mae_by_horizon[m] = 0;
  }
  for (const p of TARGET_PTS) out.time_to_target_sec[p] = null;
  for (const p of STOP_PTS) out.time_to_stop_sec[p] = null;

  let lastBar = null;
  for (let i = startIdx; i < secondBars.length; i++) {
    const b = secondBars[i];
    if (b.ts > stopTs) break;
    if (b.symbol !== signalContract) {
      out.rolloverAt = b.ts;
      break;
    }
    const secElapsed = Math.max(0, Math.round((b.ts - walkStartTs) / 1000));
    const minElapsed = secElapsed / 60;

    let fav, adv;
    if (direction === 'long') {
      fav = b.high - entryPrice;
      adv = entryPrice - b.low;
    } else {
      fav = entryPrice - b.low;
      adv = b.high - entryPrice;
    }
    if (fav > out.mfe_pts) out.mfe_pts = fav;
    if (adv > out.mae_pts) out.mae_pts = adv;
    for (const m of HORIZONS_MIN) {
      if (minElapsed <= m) {
        if (fav > out.mfe_by_horizon[m]) out.mfe_by_horizon[m] = fav;
        if (adv > out.mae_by_horizon[m]) out.mae_by_horizon[m] = adv;
      }
    }
    // close at horizons (capture once)
    for (const m of HORIZONS_MIN) {
      const key = `close_${m}m`;
      if (out.closes[key] == null && minElapsed >= m) {
        out.closes[key] = b.close;
      }
    }
    // time to target/stop tiers (first hit only)
    for (const p of TARGET_PTS) {
      if (out.time_to_target_sec[p] == null && fav >= p) out.time_to_target_sec[p] = secElapsed;
    }
    for (const p of STOP_PTS) {
      if (out.time_to_stop_sec[p] == null && adv >= p) out.time_to_stop_sec[p] = secElapsed;
    }
    lastBar = b;
  }
  out.finalTs = lastBar ? lastBar.ts : null;
  // Round numerics
  out.mfe_pts = +out.mfe_pts.toFixed(2);
  out.mae_pts = +out.mae_pts.toFixed(2);
  for (const m of HORIZONS_MIN) {
    out.mfe_by_horizon[m] = +out.mfe_by_horizon[m].toFixed(2);
    out.mae_by_horizon[m] = +out.mae_by_horizon[m].toFixed(2);
  }
  return out;
}

// ---------- Main ----------
async function run() {
  const tStart = Date.now();
  const allCandles = await loadRawNQ(START, END);
  const { filtered: candles, primaryByHour } = filterPrimaryContract(allCandles);
  console.log(`After primary-contract filter: ${candles.length.toLocaleString()} candles`);

  const byDate = new Map();
  for (const c of candles) {
    const et = toET(c.timestamp);
    if (et.dayOfWeek < 1 || et.dayOfWeek > 5) continue;
    if (!byDate.has(et.date)) byDate.set(et.date, []);
    byDate.get(et.date).push({ candle: c, et });
  }
  const tradingDates = Array.from(byDate.keys()).sort();
  console.log(`Trading dates: ${tradingDates.length}`);

  // Build touches per date with features (1m-derivable)
  const touchesByDate = new Map();
  let totalTouches = 0;
  for (const dateStr of tradingDates) {
    const snapshots = loadIntradayGEXCustom(dateStr);
    if (!snapshots || !snapshots.length) { touchesByDate.set(dateStr, { touches: [], candles: byDate.get(dateStr).map(x => x.candle) }); continue; }
    const dayCandles = byDate.get(dateStr).map(x => x.candle);
    const dayEt = byDate.get(dateStr).map(x => x.et);
    let prevClose = null;
    const dayTouches = [];
    // track last touch time per (level_type) to enforce cooldown
    const lastTouchByLevel = new Map();
    const testsPerLevel = new Map();
    for (let i = 0; i < dayCandles.length; i++) {
      const c = dayCandles[i];
      const et = dayEt[i];
      // RTH + pre-RTH 7am+ — match strategy's entry window potential
      if (et.timeInMinutes < 420 || et.timeInMinutes >= 960) { prevClose = c.close; continue; }
      const snap = snapshotAtOrBefore(snapshots, c.timestamp - SNAP_LAG_MIN * 60000);
      if (!snap) { prevClose = c.close; continue; }
      const levels = extractLevels(snap);
      for (const lvl of levels) {
        if (lvl.price == null || isNaN(lvl.price)) continue;
        const distLow = Math.abs(c.low - lvl.price);
        const distHigh = Math.abs(c.high - lvl.price);
        const inside = c.low <= lvl.price && lvl.price <= c.high;
        const edgeMin = Math.min(distLow, distHigh);
        if (edgeMin > TOUCH_DISTANCE && !inside) continue;
        if (prevClose == null) continue;
        let approach;
        if (prevClose > lvl.price) approach = 'from_above';
        else if (prevClose < lvl.price) approach = 'from_below';
        else continue;

        // cooldown: same level type within COOLDOWN_MIN min
        const levelKey = `${lvl.type}@${lvl.price.toFixed(2)}`;
        if (COOLDOWN_MIN > 0) {
          const last = lastTouchByLevel.get(levelKey);
          if (last != null && (c.timestamp - last) < COOLDOWN_MIN * 60000) continue;
        }

        const sameLevelCount = testsPerLevel.get(levelKey) || 0;
        const touch = {
          touch: c, et, level: lvl, approach, snap, touchIdx: i,
          min_dist_1m: inside ? 0 : edgeMin,
        };
        const features = computeFeatures1m(touch, dayCandles, i, snap, levels, sameLevelCount);
        dayTouches.push({ touch, features, levels });
        lastTouchByLevel.set(levelKey, c.timestamp);
        testsPerLevel.set(levelKey, sameLevelCount + 1);
      }
      prevClose = c.close;
    }
    touchesByDate.set(dateStr, { touches: dayTouches, candles: dayCandles });
    totalTouches += dayTouches.length;
  }
  console.log(`Touches detected: ${totalTouches.toLocaleString()}\n`);

  // Stream 1s data per day, compute s1 features + forward walks
  console.log(`Streaming 1s OHLCV (per-day processing) ...`);
  const onesPath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1s.csv`);
  if (!fs.existsSync(onesPath)) throw new Error(`1s file not found: ${onesPath}`);

  const scanStartIso = new Date(START).toISOString();
  const scanEndIso = new Date(new Date(END).getTime() + 36 * 3600000).toISOString();

  let curDate = null;
  let curBars = [];
  const allTouches = [];
  let processedDays = 0;

  function processDay(dateStr, secondBars) {
    const dayInfo = touchesByDate.get(dateStr);
    if (!dayInfo) return;
    const { touches } = dayInfo;
    if (touches.length === 0 || secondBars.length === 0) return;
    const eodCutoffMs = eodCutoffMsForDate(dateStr);

    for (const tEvt of touches) {
      const { touch, features } = tEvt;
      const lvl = touch.level.price;
      const signalContract = touch.touch.symbol;
      // Entry timestamp = touch bar's close = touch_ts + 60s (we use the first 1s bar AFTER the touch minute closes)
      const walkStartTs = touch.touch.timestamp + 60_000;

      // Entry price: open of first 1s bar at walkStartTs (market fill)
      const startIdx = bsearch(secondBars, walkStartTs);
      let entryBar = null;
      for (let i = startIdx; i < secondBars.length; i++) {
        if (secondBars[i].symbol === signalContract) { entryBar = secondBars[i]; break; }
        if (secondBars[i].ts >= walkStartTs + 60_000) break;
      }
      if (!entryBar) continue;  // no 1s bar found within 1 min
      const entryPrice = entryBar.open;

      // s1 features computed on the TOUCH minute, [touch_ts, touch_ts+60s)
      const s1 = compute1sFeatures(secondBars, touch.touch.timestamp, lvl, signalContract);

      const maxHoldTs = walkStartTs + MAX_HOLD_MIN * 60 * 1000;
      // Bounce direction = away from approach
      const bounceDir = touch.approach === 'from_above' ? 'long' : 'short';
      // Break direction = same as approach
      const breakDir = touch.approach === 'from_above' ? 'short' : 'long';

      const bounce = forwardWalk(secondBars, signalContract, walkStartTs, entryPrice, bounceDir, maxHoldTs, eodCutoffMs);
      const brk = forwardWalk(secondBars, signalContract, walkStartTs, entryPrice, breakDir, maxHoldTs, eodCutoffMs);

      allTouches.push({
        touch_id: allTouches.length,
        ts: touch.touch.timestamp,
        date: dateStr,
        time_et: `${String(Math.floor(touch.et.timeInMinutes / 60)).padStart(2, '0')}:${String(touch.et.timeInMinutes % 60).padStart(2, '0')}`,
        level_type: touch.level.type,
        level_price: +touch.level.price.toFixed(2),
        approach: touch.approach,
        symbol: signalContract,
        entry_price: +entryPrice.toFixed(2),
        features,
        s1,
        bounce,
        brk,
      });
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
      process.stdout.write(`  scanned ${(scanned / 1e6).toFixed(0)}M  kept ${kept.toLocaleString()}  days=${processedDays}/${tradingDates.length}  touches=${allTouches.length}  (${sec}s)\n`);
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
      volume: +parts[8] || 0,
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
  console.log(`Touches with outcomes: ${allTouches.length.toLocaleString()}`);

  // Save
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(OUT_DIR, `gex-touch-flow-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    config: { START, END, TOUCH_DISTANCE, COOLDOWN_MIN, MAX_HOLD_MIN, SNAP_LAG_MIN, EOD_CUTOFF_ET, TARGET_PTS, STOP_PTS, HORIZONS_MIN },
    touches: allTouches,
  }));
  console.log(`Written: ${outPath}`);
  console.log(`Elapsed: ${((Date.now() - tStart) / 1000).toFixed(0)}s`);
}

run().catch(err => { console.error(err); process.exit(1); });
