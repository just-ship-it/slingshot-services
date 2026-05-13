/**
 * Phase 1 v3: 1s-honest wide-net GEX-touch dataset.
 *
 * SUPERSEDES 01v2-build-touch-dataset.js, which had a lookahead bug: it
 * evaluated stop/target on the full 1m fill bar (and Phase 1b's resolver
 * walked 1s from minute start), so pre-fill price action was counted as
 * post-fill outcomes. Backtest engine validation on 2026-05-13 exposed
 * this — research said 62% WR / PF 2.20, engine said 50% / 0.94.
 *
 * v3 simulates fills and exits HONESTLY:
 *   1. Touch detected on 1m bar M's close (price within --touch-distance of
 *      any GEX level; approach known from prev close).
 *   2. LIMIT placed at level price, activates at M+1 start (touch_ts + 60s).
 *   3. Stream 1s OHLCV for the day. Walk 1s bars starting at M+1 start
 *      looking for fill:
 *        LONG  limit: first 1s where low  <= level
 *        SHORT limit: first 1s where high >= level
 *      within --limit-timeout-min minutes (else no_fill).
 *   4. From fill 1s onward, walk 1s bars chronologically. First side to hit
 *      target or stop wins. Both-hit within a single 1s bar (rare given typical
 *      1s range < 1pt) resolves conservatively to STOP (worst-for-trader).
 *   5. Stop walking on contract rollover (mark 'rollover') or EOD cutoff
 *      (mark 'eod') or after --max-hold-min minutes from TOUCH ts (mark
 *      'timeout').
 *
 * Bounce only — break setups don't fit a limit-at-level model and were
 * unprofitable in v1/v2. Add later as a separate market-on-open script if
 * needed.
 *
 * Per CLAUDE.md "CRITICAL: Strategy research MUST use 1s OHLCV from the fill
 * instant onward", DO NOT add any "check 1m bar for stop/target" fallback.
 *
 * Output: research/output/gex-touch-confirm-v3-base-${ts}.touches.json
 *
 * Usage:
 *   node research/gex-touch-confirm/01v3-build-1s-honest.js \
 *     --start 2025-01-13 --end 2026-04-23 \
 *     --touch-distance 10 --limit-timeout-min 5 --max-hold-min 120 \
 *     --eod-cutoff-et 16:40
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
const COOLDOWN_MIN = Number(arg('cooldown-min', 0));
const PRODUCT = arg('product', 'NQ').toUpperCase();
const GEX_DIR = arg('gex-dir', 'nq-cbbo');
const TARGET_POINTS = Number(arg('target-points', 20));
const STOP_DISTANCES = String(arg('stop-distances', '8,10,12,15,20'))
  .split(',').map(Number).filter(n => n > 0);
const MAX_HOLD_MIN = Number(arg('max-hold-min', 120));
const LIMIT_TIMEOUT_MIN = Number(arg('limit-timeout-min', 5));
const SNAP_LAG_MIN = Number(arg('snap-lag-min', 16));
const EOD_CUTOFF_ET = arg('eod-cutoff-et', '16:40');

console.log(`\n=== GEX Touch Confirm Study — Phase 1 v3 (1s-honest) ===`);
console.log(`Range:            ${START} → ${END}`);
console.log(`Touch distance:   ${TOUCH_DISTANCE} pts`);
console.log(`Target:           ${TARGET_POINTS} pts (anchored at level)`);
console.log(`Stop distances:   [${STOP_DISTANCES.join(', ')}] pts`);
console.log(`Limit timeout:    ${LIMIT_TIMEOUT_MIN} min`);
console.log(`Max hold:         ${MAX_HOLD_MIN} min from touch`);
console.log(`Snap lag:         ${SNAP_LAG_MIN} min`);
console.log(`EOD cutoff (ET):  ${EOD_CUTOFF_ET}\n`);

// Parse EOD cutoff
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

// --- EOD cutoff: convert each date to a UTC ms cutoff at EOD_HOUR:EOD_MIN ET ---
function eodCutoffMsForDate(dateStr) {
  // dateStr is YYYY-MM-DD in ET. The cutoff at EOD_HOUR:EOD_MIN ET converts to UTC.
  // Use Intl to find the UTC equivalent at that ET time on that ET date.
  // Simpler: pick noon ET on that date, use its toET() to detect DST offset, derive cutoff.
  const [y, mo, d] = dateStr.split('-').map(Number);
  // Try EST first (UTC-5), then check if DST applies.
  let utcMs = Date.UTC(y, mo - 1, d, EOD_HOUR + 5, EOD_MIN);
  const et = toET(utcMs);
  if (et.offset === -4) {  // DST: adjust by 1 hour
    utcMs = Date.UTC(y, mo - 1, d, EOD_HOUR + 4, EOD_MIN);
  }
  return utcMs;
}

// --- Simulate one (setup, stop, direction) outcome using 1s bars ---
//
// secondBars: sorted-by-ts array of { ts, open, high, low, close, symbol }
// signalContract: primary contract symbol at touch (M)
// touchTs: 1m bar M's timestamp (start of M in ms)
// direction: 'long' | 'short'
// level: limit price
// stopDistance: pts past level
// limitTimeoutMin / maxHoldMin / eodCutoffMs as documented above
function resolveOutcome1s(secondBars, startIdx, signalContract, touchTs, direction,
                          level, stopDistance, limitTimeoutMin, maxHoldMin, eodCutoffMs) {
  const targetPrice = direction === 'long' ? level + TARGET_POINTS : level - TARGET_POINTS;
  const stopPrice = direction === 'long' ? level - stopDistance : level + stopDistance;

  const fillStartTs = touchTs + 60 * 1000;
  const fillEndTs = touchTs + (1 + limitTimeoutMin) * 60 * 1000;  // 1 min for M+1 start + limit_timeout - 1
  const maxHoldTs = touchTs + maxHoldMin * 60 * 1000;
  const stopTs = Math.min(maxHoldTs, eodCutoffMs);

  // --- Phase A: find fill 1s bar ---
  let fillIdx = -1;
  let i = startIdx;
  // Skip 1s bars before fill window
  while (i < secondBars.length && secondBars[i].ts < fillStartTs) i++;
  while (i < secondBars.length) {
    const b = secondBars[i];
    if (b.ts >= fillEndTs) break;
    if (b.symbol !== signalContract) {
      return {
        outcome: 'rollover_pre_fill',
        fill_ts: null, fill_price: null,
        exit_ts: null, exit_price: null,
        mfe: 0, mae: 0,
      };
    }
    const filled = direction === 'long' ? b.low <= level : b.high >= level;
    if (filled) { fillIdx = i; break; }
    i++;
  }
  if (fillIdx < 0) {
    return {
      outcome: 'no_fill',
      fill_ts: null, fill_price: null,
      exit_ts: null, exit_price: null,
      mfe: 0, mae: 0,
    };
  }

  const fillBar = secondBars[fillIdx];
  const fillTs = fillBar.ts;

  // --- Phase B: check exit on fill bar itself + subsequent 1s bars ---
  let mfe = 0, mae = 0;
  function updateExcursion(b) {
    if (direction === 'long') {
      const up = b.high - level;
      const dn = level - b.low;
      if (up > mfe) mfe = up;
      if (dn > mae) mae = dn;
    } else {
      const dn = level - b.low;
      const up = b.high - level;
      if (dn > mfe) mfe = dn;
      if (up > mae) mae = up;
    }
  }

  // Determine within-bar outcome. Conservative: same-bar both-hit resolves to stop.
  function evalBar(b) {
    const targetHit = direction === 'long' ? b.high >= targetPrice : b.low <= targetPrice;
    const stopHit = direction === 'long' ? b.low <= stopPrice : b.high >= stopPrice;
    if (targetHit && stopHit) return { hit: 'stop', price: stopPrice };  // conservative
    if (targetHit) return { hit: 'target', price: targetPrice };
    if (stopHit) return { hit: 'stop', price: stopPrice };
    return null;
  }

  // Check the FILL bar for an immediate stop/target hit. The fill happened
  // somewhere within this 1s. The bar's full range could include pre-fill or
  // post-fill ticks; in practice 1s range is < 1pt on NQ so this is rarely
  // ambiguous, and the conservative same-bar resolution above keeps us honest.
  updateExcursion(fillBar);
  const fillBarExit = evalBar(fillBar);
  if (fillBarExit) {
    return {
      outcome: fillBarExit.hit === 'target' ? 'win' : 'loss',
      fill_ts: fillTs, fill_price: level,
      exit_ts: fillTs, exit_price: fillBarExit.price,
      mfe, mae,
    };
  }

  // Walk subsequent 1s bars
  for (let j = fillIdx + 1; j < secondBars.length; j++) {
    const b = secondBars[j];
    if (b.ts > stopTs) {
      const isEod = eodCutoffMs < maxHoldTs;
      return {
        outcome: isEod ? 'eod' : 'timeout',
        fill_ts: fillTs, fill_price: level,
        exit_ts: secondBars[j - 1].ts, exit_price: secondBars[j - 1].close,
        mfe, mae,
      };
    }
    if (b.symbol !== signalContract) {
      return {
        outcome: 'rollover',
        fill_ts: fillTs, fill_price: level,
        exit_ts: secondBars[j - 1].ts, exit_price: secondBars[j - 1].close,
        mfe, mae,
      };
    }
    updateExcursion(b);
    const exit = evalBar(b);
    if (exit) {
      return {
        outcome: exit.hit === 'target' ? 'win' : 'loss',
        fill_ts: fillTs, fill_price: level,
        exit_ts: b.ts, exit_price: exit.price,
        mfe, mae,
      };
    }
  }

  // Ran off the end of 1s data without hitting stop/target. Treat as timeout.
  const lastBar = secondBars[secondBars.length - 1] || fillBar;
  return {
    outcome: 'timeout',
    fill_ts: fillTs, fill_price: level,
    exit_ts: lastBar.ts, exit_price: lastBar.close,
    mfe, mae,
  };
}

// --- Find first 1s index at-or-after a target ts (binary search) ---
function bsearchFirstAtOrAfter(secondBars, targetTs) {
  let lo = 0, hi = secondBars.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (secondBars[m].ts < targetTs) lo = m + 1; else hi = m;
  }
  return lo;
}

// --- Main ---
async function run() {
  const tStart = Date.now();
  const allCandles = await loadRawNQ(START, END);
  const { filtered: candles, primaryByHour } = filterPrimaryContract(allCandles);
  console.log(`After primary-contract filter: ${candles.length.toLocaleString()} candles`);

  // Group 1m by date and detect touches
  const byDate = new Map();
  for (const c of candles) {
    const et = toET(c.timestamp);
    if (et.dayOfWeek < 1 || et.dayOfWeek > 5) continue;
    if (!byDate.has(et.date)) byDate.set(et.date, []);
    byDate.get(et.date).push({ candle: c, et });
  }
  const tradingDates = Array.from(byDate.keys()).sort();
  console.log(`Trading dates: ${tradingDates.length}\n`);

  // Build touch list per day
  const touchesByDate = new Map();
  let totalTouches = 0;
  let snapHits = 0, snapMisses = 0;
  for (const dateStr of tradingDates) {
    const snapshots = loadIntradayGEXCustom(dateStr);
    if (!snapshots || !snapshots.length) { snapMisses++; touchesByDate.set(dateStr, []); continue; }
    snapHits++;
    const dayCandles = byDate.get(dateStr);
    let prevClose = null;
    const dayTouches = [];
    const lastTouchTs = new Map();
    for (const { candle: c, et } of dayCandles) {
      if (et.timeInMinutes < 570 || et.timeInMinutes >= 960) { prevClose = c.close; continue; }
      const snap = snapshotAtOrBefore(snapshots, c.timestamp - SNAP_LAG_MIN * 60000);
      if (!snap) { prevClose = c.close; continue; }
      const levels = extractLevels(snap);
      for (const lvl of levels) {
        if (lvl.price == null || isNaN(lvl.price)) continue;
        if (COOLDOWN_MIN > 0) {
          const sig = `${lvl.type}@${lvl.price.toFixed(2)}`;
          const last = lastTouchTs.get(sig);
          if (last && (c.timestamp - last) < COOLDOWN_MIN * 60000) continue;
        }
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
          touch_low_dist: distLow,
          touch_high_dist: distHigh,
          min_dist_1m: inside ? 0 : edgeMin,
        });
        if (COOLDOWN_MIN > 0) {
          lastTouchTs.set(`${lvl.type}@${lvl.price.toFixed(2)}`, c.timestamp);
        }
      }
      prevClose = c.close;
    }
    touchesByDate.set(dateStr, dayTouches);
    totalTouches += dayTouches.length;
  }
  console.log(`Touches detected: ${totalTouches.toLocaleString()} (snap hits ${snapHits}, misses ${snapMisses})\n`);

  // Stream 1s file, processing one day at a time.
  console.log(`Streaming 1s OHLCV (per-day processing) ...`);
  const onesPath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1s.csv`);
  if (!fs.existsSync(onesPath)) throw new Error(`1s file not found: ${onesPath}`);

  const scanStartIso = new Date(START).toISOString();
  const scanEndIso = new Date(new Date(END).getTime() + 36 * 3600000).toISOString();  // +36h headroom for end-of-day touches

  let curDate = null;
  let curBars = [];  // sorted 1s bars for current ET trading date, primary contract
  const allOutcomes = [];  // built up across days; each entry is one touch with all its outcomes
  let processedDays = 0;
  let touchesProcessed = 0;
  const outcomeStats = { win: 0, loss: 0, timeout: 0, eod: 0, no_fill: 0, rollover: 0, rollover_pre_fill: 0 };

  function processDay(dateStr, secondBars) {
    const dayTouches = touchesByDate.get(dateStr) || [];
    if (dayTouches.length === 0 || secondBars.length === 0) return;
    const eodCutoffMs = eodCutoffMsForDate(dateStr);
    for (const t of dayTouches) {
      // Find 1s index at-or-after touch_ts + 60s (M+1 start)
      const m1Start = t.touch.timestamp + 60 * 1000;
      const startIdx = bsearchFirstAtOrAfter(secondBars, m1Start);
      const touchOut = {
        id: allOutcomes.length,
        ts: t.touch.timestamp,
        date: dateStr,
        time_et: `${String(Math.floor(t.et.timeInMinutes / 60)).padStart(2, '0')}:${String(t.et.timeInMinutes % 60).padStart(2, '0')}`,
        tod: todBucket(t.et.timeInMinutes),
        level_type: t.level.type,
        level_price: t.level.price,
        level_gex: t.level.gex,
        level_is_resistance: t.level.isResistance,
        touch_low_dist: t.touch_low_dist,
        touch_high_dist: t.touch_high_dist,
        min_dist_1m: t.min_dist_1m,
        approach: t.approach,
        regime: t.snap.regime || 'unknown',
        total_gex: t.snap.total_gex || 0,
        gamma_imbalance: t.snap.gamma_imbalance || 0,
        nq_spot_in_snap: t.snap.nq_spot,
        gex_mag_bucket: gexMagBucket(Math.abs(t.level.gex)),
        snap_ts: t.snap.timestamp,
        entry_price: t.level.price,
        entry_symbol: t.touch.symbol,
        prev_close: null,  // not tracked here; not used by Phase 3
        outcomes: [],
      };
      const direction = t.approach === 'from_above' ? 'long' : 'short';
      const stops = [];
      for (const stopDistance of STOP_DISTANCES) {
        const r = resolveOutcome1s(secondBars, startIdx, t.touch.symbol, t.touch.timestamp,
          direction, t.level.price, stopDistance, LIMIT_TIMEOUT_MIN, MAX_HOLD_MIN, eodCutoffMs);
        stops.push({
          stop: stopDistance,
          stop_price: direction === 'long' ? t.level.price - stopDistance : t.level.price + stopDistance,
          target_price: direction === 'long' ? t.level.price + TARGET_POINTS : t.level.price - TARGET_POINTS,
          ...r,
        });
        const key = r.outcome === 'rollover_pre_fill' ? 'rollover_pre_fill' : r.outcome;
        if (outcomeStats[key] != null) outcomeStats[key]++;
      }
      touchOut.outcomes.push({ setup: 'bounce', direction, stops });
      allOutcomes.push(touchOut);
      touchesProcessed++;
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
      process.stdout.write(`  scanned ${(scanned / 1e6).toFixed(0)}M  kept ${kept.toLocaleString()}  days=${processedDays}/${tradingDates.length}  (${sec}s)\n`);
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

    // Determine the ET date this 1s bar belongs to
    const et = toET(ts);
    const barDate = et.date;
    if (barDate !== curDate) {
      // Flush previous day (process its touches)
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
  // Final flush
  if (curDate != null && curBars.length > 0) {
    processDay(curDate, curBars);
    processedDays++;
  }
  rl.close(); stream.destroy();

  const totalSec = ((Date.now() - tScanStart) / 1000).toFixed(0);
  console.log(`  1s scan done: ${scanned.toLocaleString()} rows, ${kept.toLocaleString()} kept (${totalSec}s)`);
  console.log(`  Touches processed: ${touchesProcessed.toLocaleString()}\n`);
  console.log(`Outcomes:`, outcomeStats);

  // Per (stop) summary
  console.log(`\n=== Baseline by stop_distance (bounce, 1s-honest) ===`);
  const buckets = new Map();
  for (const t of allOutcomes) {
    for (const o of t.outcomes) {
      for (const s of o.stops) {
        const k = `${s.stop}`;
        if (!buckets.has(k)) buckets.set(k, { n: 0, win: 0, loss: 0, timeout: 0, eod: 0, no_fill: 0, rollover: 0, rollover_pre_fill: 0 });
        const b = buckets.get(k);
        b.n++;
        if (b[s.outcome] != null) b[s.outcome]++;
      }
    }
  }
  console.log('stop'.padStart(5), 'n'.padStart(8), 'fill%'.padStart(7), 'win%'.padStart(7),
    'loss%'.padStart(7), 'time%'.padStart(7), 'eod%'.padStart(6), 'pf'.padStart(7));
  for (const [k, b] of Array.from(buckets.entries()).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const stopN = Number(k);
    const decided = b.win + b.loss;
    const filled = decided + b.timeout + b.eod + b.rollover;
    const wPct = decided > 0 ? 100 * b.win / decided : 0;
    const lPct = decided > 0 ? 100 * b.loss / decided : 0;
    const tPct = filled > 0 ? 100 * b.timeout / filled : 0;
    const ePct = filled > 0 ? 100 * b.eod / filled : 0;
    const fillPct = 100 * filled / b.n;
    const pf = b.loss * stopN > 0 ? b.win * TARGET_POINTS / (b.loss * stopN) : (b.win > 0 ? Infinity : 0);
    console.log(String(k).padStart(5), String(b.n).padStart(8),
      fillPct.toFixed(1).padStart(7), wPct.toFixed(1).padStart(7), lPct.toFixed(1).padStart(7),
      tPct.toFixed(1).padStart(7), ePct.toFixed(1).padStart(6),
      pf.toFixed(2).padStart(7));
  }

  // Serialize
  const primaryByHourObj = {};
  for (const [h, sym] of primaryByHour.entries()) primaryByHourObj[h] = sym;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outBase = path.join(OUT_DIR, `gex-touch-confirm-v3-base-${ts}`);
  const payload = {
    config: {
      START, END, TOUCH_DISTANCE, COOLDOWN_MIN, PRODUCT, GEX_DIR,
      TARGET_POINTS, STOP_DISTANCES, MAX_HOLD_MIN, LIMIT_TIMEOUT_MIN,
      SNAP_LAG_MIN, EOD_CUTOFF_ET,
      ENTRY_MODEL: 'limit_at_level_1s_honest_v3',
    },
    stats: {
      candles_loaded: allCandles.length,
      candles_after_primary_filter: candles.length,
      trading_dates: tradingDates.length,
      snap_hits: snapHits, snap_misses: snapMisses,
      touches: allOutcomes.length,
      outcomes: outcomeStats,
      one_s_scanned: scanned,
      one_s_kept: kept,
      runtime_sec: Number(((Date.now() - tStart) / 1000).toFixed(0)),
    },
    primary_by_hour: primaryByHourObj,
    touches: allOutcomes,
  };
  fs.writeFileSync(`${outBase}.touches.json`, JSON.stringify(payload));
  console.log(`\nWritten: ${outBase}.touches.json (${(fs.statSync(`${outBase}.touches.json`).size / 1024 / 1024).toFixed(1)} MB)`);
}

run().catch(e => { console.error(e); process.exit(1); });
