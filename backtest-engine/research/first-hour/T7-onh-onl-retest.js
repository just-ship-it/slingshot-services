#!/usr/bin/env node
/**
 * T7 — Overnight High/Low (ONH/ONL) retest in first hour
 *
 * Hypothesis: When NQ price touches ONH or ONL during 9:30-11:00 ET (after
 * opening NOT at the level), the bounce-vs-continuation rate is materially
 * predictable from gap direction × overnight inventory × GEX regime.
 *
 * Definitions:
 *   - Overnight session (ON) = 18:00 prior day → 09:30 current day ET (futures globex)
 *   - ONH = max(high) over ON candles, ONL = min(low) over ON candles
 *   - Touch = candle.high >= level - tolerance (for ONH) or candle.low <= level + tolerance (for ONL)
 *     during 09:30-11:00 ET, AFTER opening NOT at the level (open distance >= 5pts)
 *   - First touch only (per side, per day)
 *   - Reversal: price moves >= 30pts AWAY from level within 60min of touch
 *   - Continuation: price moves >= 20pts BEYOND level within 60min of touch
 *
 * Hard rules:
 *   - raw contracts (NQ_ohlcv_1m.csv) + filterPrimaryContract()
 *   - skip rollover boundary days
 *   - all windowing in ET
 *   - GEX from data/gex/nq-cbbo (post-bucketing-fix)
 *   - 2025-01-13 → 2026-04-23, last 2 months OOS
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { CSVLoader } from '../../src/data/csv-loader.js';
import { toET, fromET, loadIntradayGEX, getGEXSnapshotAt } from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NQ_OHLCV_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
const ROLLOVER_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_rollover_log.csv');
const GEX_DIR       = path.join(REPO_ROOT, 'data', 'gex', 'nq-cbbo');
const OUTPUT_PATH   = path.join(__dirname, 'output', 'T7-onh-onl-retest.json');

const START_DATE  = '2025-01-13';
const END_DATE    = '2026-04-23';
const OOS_CUTOFF  = '2026-02-23'; // last 2 months OOS

const TOUCH_TOL_PTS    = 5;     // touch within 5pts of level
const MIN_OPEN_DIST    = 5;     // 9:30 open must be >=5pts from level
const REVERSAL_PTS     = 30;    // moved 30pts away from level
const CONTINUATION_PTS = 20;    // moved 20pts beyond level
const REACTION_WIN_MIN = 60;    // minutes after touch
const RTH_TOUCH_START  = 570;   // 9:30 ET in minutes
const RTH_TOUCH_END    = 660;   // 11:00 ET in minutes

// ----------------- helpers -----------------

function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summary(arr) {
  if (!arr.length) return { n: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: round(sorted[0], 2),
    p10: round(pct(sorted, 10), 2),
    p25: round(pct(sorted, 25), 2),
    median: round(pct(sorted, 50), 2),
    mean: round(sum / sorted.length, 2),
    p75: round(pct(sorted, 75), 2),
    p90: round(pct(sorted, 90), 2),
    max: round(sorted[sorted.length - 1], 2)
  };
}

function round(x, d = 2) {
  if (x == null || isNaN(x)) return null;
  const m = Math.pow(10, d);
  return Math.round(x * m) / m;
}

function fracAtLeast(arr, threshold) {
  if (!arr.length) return null;
  return arr.filter(v => v >= threshold).length / arr.length;
}

// ----------------- data load -----------------

async function loadRawNqMinute(startDate, endDate) {
  console.log(`Loading raw NQ 1m candles ${startDate} → ${endDate}...`);
  // Need overnight before start, so widen by 1 calendar day
  const start = new Date(startDate + 'T00:00:00Z').getTime() - 24 * 3600000;
  const end = new Date(endDate + 'T23:59:59Z').getTime();
  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(NQ_OHLCV_PATH)
      .pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return;
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < start || ts > end) return;
        const o = parseFloat(row.open);
        const h = parseFloat(row.high);
        const l = parseFloat(row.low);
        const c = parseFloat(row.close);
        if (isNaN(o) || isNaN(c)) return;
        candles.push({
          timestamp: ts,
          open: o, high: h, low: l, close: c,
          volume: parseFloat(row.volume) || 0,
          symbol: row.symbol
        });
      })
      .on('end', resolve)
      .on('error', reject);
  });
  console.log(`  raw rows: ${candles.length.toLocaleString()}`);

  const loader = new CSVLoader();
  const filtered = loader.filterPrimaryContract(candles);
  filtered.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  primary-contract rows: ${filtered.length.toLocaleString()}`);
  return filtered;
}

function loadRolloverDates() {
  const txt = fs.readFileSync(ROLLOVER_PATH, 'utf-8');
  const lines = txt.trim().split('\n').slice(1);
  const set = new Set();
  for (const line of lines) {
    const date = line.split(',')[0];
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) set.add(date);
  }
  console.log(`  loaded ${set.size} rollover dates`);
  return set;
}

// ----------------- session bucketing -----------------

function bucketByDay(candles) {
  const byDate = new Map(); // ET dateStr -> [candles with .et]
  for (const c of candles) {
    const et = toET(c.timestamp);
    if (et.dayOfWeek === 0 || et.dayOfWeek === 6) continue;
    if (!byDate.has(et.date)) byDate.set(et.date, []);
    byDate.get(et.date).push({ ...c, et });
  }
  return byDate;
}

/**
 * Gather candles that belong to the OVERNIGHT session leading into a given RTH date.
 * ON window = 18:00 prior trading day ET → 09:30 current day ET.
 * We pull from byDate using the actual ET date of each candle.
 */
function getOvernightCandles(byDate, sortedDates, dateStr) {
  const idx = sortedDates.indexOf(dateStr);
  if (idx <= 0) return null;

  const [Y, M, D] = dateStr.split('-').map(Number);
  const onEnd = fromET(Y, M - 1, D, 9, 30); // 09:30 today ET in UTC ms (exclusive)

  // Walk back through prior trading dates to gather candles >= ON start
  // ON start = 18:00 ET of the previous trading day
  const prevDate = sortedDates[idx - 1];
  const [pY, pM, pD] = prevDate.split('-').map(Number);
  const onStart = fromET(pY, pM - 1, pD, 18, 0);

  const out = [];
  // candles with ET date in {prevDate, dateStr} are candidates
  for (const dStr of [prevDate, dateStr]) {
    const arr = byDate.get(dStr);
    if (!arr) continue;
    for (const c of arr) {
      if (c.timestamp >= onStart && c.timestamp < onEnd) out.push(c);
    }
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

// ----------------- core computation -----------------

function gapBucket(gapPct) {
  if (gapPct >  0.004) return 'gap_up_strong';
  if (gapPct >  0.001) return 'gap_up_mild';
  if (gapPct < -0.004) return 'gap_down_strong';
  if (gapPct < -0.001) return 'gap_down_mild';
  return 'flat';
}

function rangeBucket(rangePts) {
  if (rangePts < 80)  return 'small';
  if (rangePts < 180) return 'normal';
  return 'large';
}

function inventoryBucket(pctTimeAbovePdc) {
  if (pctTimeAbovePdc > 0.70) return 'mostly_above';
  if (pctTimeAbovePdc < 0.30) return 'mostly_below';
  return 'mixed';
}

function computeEvents(byDate, rolloverDates) {
  const dates = [...byDate.keys()].sort();
  const events = [];
  const dayMeta = [];

  // Build prev-RTH-close lookup
  for (let i = 1; i < dates.length; i++) {
    const dateStr = dates[i];
    if (rolloverDates.has(dateStr)) continue;
    if (dateStr < START_DATE || dateStr > END_DATE) continue;

    const dayCandles = byDate.get(dateStr);
    if (!dayCandles || dayCandles.length < 60) continue;

    // RTH candles 9:30 - 11:00 ET (570..659)
    const touchWin = dayCandles.filter(c => c.et.timeInMinutes >= RTH_TOUCH_START && c.et.timeInMinutes < RTH_TOUCH_END);
    if (touchWin.length < 60) continue;

    // 9:30 open
    const openCandle = touchWin.find(c => c.et.timeInMinutes === RTH_TOUCH_START);
    if (!openCandle) continue;
    const open930 = openCandle.open;

    // Prior day RTH close (last RTH candle <= 16:00)
    let prevRthClose = null;
    for (let j = i - 1; j >= Math.max(0, i - 7); j--) {
      const prev = dates[j];
      if (rolloverDates.has(prev)) continue;
      const arr = byDate.get(prev);
      if (!arr) continue;
      const rth = arr.filter(c => c.et.timeInMinutes >= RTH_TOUCH_START && c.et.timeInMinutes <= 960);
      if (rth.length === 0) continue;
      prevRthClose = rth[rth.length - 1].close;
      break;
    }
    if (prevRthClose == null) continue;

    // Overnight candles
    const onCandles = getOvernightCandles(byDate, dates, dateStr);
    if (!onCandles || onCandles.length < 60) continue;

    // Need ON to be primarily on the same contract as RTH (skip rollover-adjacent days)
    const rthSym = openCandle.symbol;
    const onSyms = new Set(onCandles.map(c => c.symbol));
    if (onSyms.size > 1 || !onSyms.has(rthSym)) {
      // contract change in overnight → skip (would shift levels by roll spread)
      continue;
    }

    const ONH = Math.max(...onCandles.map(c => c.high));
    const ONL = Math.min(...onCandles.map(c => c.low));
    const onRange = ONH - ONL;

    // Overnight inventory: % time the close was above prevRthClose
    const aboveCount = onCandles.filter(c => c.close > prevRthClose).length;
    const pctTimeAbovePdc = aboveCount / onCandles.length;

    const gapPts = open930 - prevRthClose;
    const gapPct = gapPts / prevRthClose;
    const gB = gapBucket(gapPct);
    const rB = rangeBucket(onRange);
    const iB = inventoryBucket(pctTimeAbovePdc);

    // GEX regime at 9:30 (snapshot at or before 9:30)
    const gexSnaps = loadIntradayGEX('NQ', dateStr) || [];
    const gex930   = getGEXSnapshotAt(gexSnaps, openCandle.timestamp);
    const gexRegime = gex930 ? gex930.regime : 'unknown';

    // Need a second-look window after 11:00 to measure post-touch reaction (60 min after touch).
    // So we also keep candles up to RTH_TOUCH_END + 60min for resolution.
    const reactionEndMin = RTH_TOUCH_END + REACTION_WIN_MIN;
    const reactionWin = dayCandles.filter(c => c.et.timeInMinutes >= RTH_TOUCH_START && c.et.timeInMinutes < reactionEndMin);

    // Track per-side first touch
    for (const side of ['ONH', 'ONL']) {
      const level = side === 'ONH' ? ONH : ONL;
      const openDist = Math.abs(open930 - level);
      if (openDist < MIN_OPEN_DIST) continue; // already at the level → skip

      // Find first touch in 9:30-11:00 window
      let touchCandle = null;
      for (const c of touchWin) {
        if (side === 'ONH' ? c.high >= level - TOUCH_TOL_PTS : c.low <= level + TOUCH_TOL_PTS) {
          touchCandle = c;
          break;
        }
      }
      if (!touchCandle) {
        events.push({
          date: dateStr,
          side,
          touched: false,
          gapBucket: gB,
          rangeBucket: rB,
          invBucket: iB,
          gexRegime,
          openDistPts: round(openDist, 2),
          gapPts: round(gapPts, 2),
          onRange: round(onRange, 2),
          ONH: round(ONH, 2),
          ONL: round(ONL, 2),
          open930: round(open930, 2)
        });
        continue;
      }

      // Reaction window: from touch timestamp + 1min through +60min (or to reactionWin end)
      const touchMin = touchCandle.et.timeInMinutes;
      const reactSlice = reactionWin.filter(c => c.et.timeInMinutes > touchMin && c.et.timeInMinutes <= touchMin + REACTION_WIN_MIN);
      if (reactSlice.length < 10) continue; // not enough data to evaluate (e.g., touch at 10:55)

      // Reference price at touch: use the level itself (entry assumption)
      // For ONH: reversal moves DOWN (away from ONH), continuation moves UP through ONH
      // For ONL: reversal moves UP (away from ONL), continuation moves DOWN through ONL
      let mfeReversal = 0, maeReversal = 0;
      let mfeContin   = 0, maeContin   = 0;
      let bReversal30 = false, bContin20 = false;
      let tReversal30 = null, tContin20 = null;

      for (const c of reactSlice) {
        if (side === 'ONH') {
          // Fade: short at ONH; reversal = price drops below ONH; mfe = ONH - low; mae = high - ONH
          const upMove = Math.max(0, c.high - level); // adverse for fade
          const dnMove = Math.max(0, level - c.low);  // favorable for fade (reversal)
          mfeReversal = Math.max(mfeReversal, dnMove);
          maeReversal = Math.max(maeReversal, upMove);
          // Break: long above ONH; favorable = high - ONH; adverse = ONH - low
          mfeContin   = Math.max(mfeContin, upMove);
          maeContin   = Math.max(maeContin, dnMove);
          if (!bReversal30 && dnMove >= REVERSAL_PTS) {
            bReversal30 = true;
            tReversal30 = c.et.timeInMinutes - touchMin;
          }
          if (!bContin20 && upMove >= CONTINUATION_PTS) {
            bContin20 = true;
            tContin20 = c.et.timeInMinutes - touchMin;
          }
        } else { // ONL
          // Fade: long at ONL; reversal = price rises above ONL; mfe = high - ONL; mae = ONL - low
          const upMove = Math.max(0, c.high - level);
          const dnMove = Math.max(0, level - c.low);
          mfeReversal = Math.max(mfeReversal, upMove);
          maeReversal = Math.max(maeReversal, dnMove);
          // Break: short below ONL; favorable = ONL - low; adverse = high - ONL
          mfeContin   = Math.max(mfeContin, dnMove);
          maeContin   = Math.max(maeContin, upMove);
          if (!bReversal30 && upMove >= REVERSAL_PTS) {
            bReversal30 = true;
            tReversal30 = c.et.timeInMinutes - touchMin;
          }
          if (!bContin20 && dnMove >= CONTINUATION_PTS) {
            bContin20 = true;
            tContin20 = c.et.timeInMinutes - touchMin;
          }
        }
      }

      // Save the per-bar reaction slice for proper sequenced sim (compact: hi/lo/min)
      const bars = reactSlice.map(c => ({
        m: c.et.timeInMinutes - touchMin,
        h: round(c.high, 2),
        l: round(c.low, 2),
        c: round(c.close, 2)
      }));

      events.push({
        date: dateStr,
        side,
        touched: true,
        touchMin,
        touchTimeET: `${String(Math.floor(touchMin/60)).padStart(2,'0')}:${String(touchMin%60).padStart(2,'0')}`,
        gapBucket: gB,
        rangeBucket: rB,
        invBucket: iB,
        gexRegime,
        openDistPts: round(openDist, 2),
        gapPts: round(gapPts, 2),
        gapPct: round(gapPct, 5),
        onRange: round(onRange, 2),
        pctTimeAbovePdc: round(pctTimeAbovePdc, 4),
        ONH: round(ONH, 2),
        ONL: round(ONL, 2),
        open930: round(open930, 2),
        prevRthClose: round(prevRthClose, 2),
        level: round(level, 2),
        mfeReversal: round(mfeReversal, 2),
        maeReversal: round(maeReversal, 2),
        mfeContin: round(mfeContin, 2),
        maeContin: round(maeContin, 2),
        bReversal30,
        bContin20,
        tReversal30,
        tContin20,
        bars
      });
    }

    dayMeta.push({
      date: dateStr,
      ONH: round(ONH, 2),
      ONL: round(ONL, 2),
      onRange: round(onRange, 2),
      open930: round(open930, 2),
      prevRthClose: round(prevRthClose, 2),
      gapPts: round(gapPts, 2),
      gapBucket: gB,
      pctTimeAbovePdc: round(pctTimeAbovePdc, 4),
      invBucket: iB,
      rangeBucket: rB,
      gexRegime
    });
  }

  return { events, dayMeta };
}

// ----------------- analytics -----------------

function reactionStats(events, predicate) {
  const subset = events.filter(e => e.touched && predicate(e));
  if (!subset.length) return { n: 0 };
  const pRev30 = subset.filter(e => e.bReversal30).length / subset.length;
  const pCnt20 = subset.filter(e => e.bContin20).length / subset.length;
  const mfeRev = subset.map(e => e.mfeReversal);
  const maeRev = subset.map(e => e.maeReversal);
  const mfeCnt = subset.map(e => e.mfeContin);
  const maeCnt = subset.map(e => e.maeContin);
  const tRev   = subset.filter(e => e.tReversal30 != null).map(e => e.tReversal30);
  const tCnt   = subset.filter(e => e.tContin20  != null).map(e => e.tContin20);
  return {
    n: subset.length,
    pReversal30: round(pRev30, 4),
    pContin20:   round(pCnt20, 4),
    mfeReversal: summary(mfeRev),
    maeReversal: summary(maeRev),
    mfeContin:   summary(mfeCnt),
    maeContin:   summary(maeCnt),
    tToReversal: summary(tRev),
    tToContin:   summary(tCnt)
  };
}

function stratify(events, dim, options) {
  const out = {};
  for (const opt of options) {
    out[opt] = reactionStats(events, e => e[dim] === opt);
  }
  return out;
}

function stratify2D(events, dim1, opts1, dim2, opts2) {
  const out = {};
  for (const a of opts1) {
    out[a] = {};
    for (const b of opts2) {
      out[a][b] = reactionStats(events, e => e[dim1] === a && e[dim2] === b);
    }
  }
  return out;
}

// ----------------- backtest grid -----------------

/**
 * Simulate FADE strategy on a touch event.
 * ONH touch → SHORT at level; ONL touch → LONG at level.
 * Stop = stopPts beyond the level. Target = targetPts in fade direction.
 * Time stop: end of REACTION_WIN_MIN window.
 *
 * Returns pnl in points (not $) using high/low scan within the reaction slice.
 * NOTE: We don't have intra-bar order, so apply the conservative rule —
 * if BOTH stop and target hit in same bar, count it as STOP (worst case).
 */
/**
 * Bar-by-bar fade sim.
 * Entry at touch level. ONH → SHORT, ONL → LONG.
 * For each subsequent bar, check stop first then target (conservative).
 * If both touched in same bar, count as STOP (no intra-bar order info).
 * If neither hit by end of reaction window, exit at last bar's close.
 */
function simFade(events, stopPts, targetPts) {
  const trades = [];
  for (const e of events) {
    if (!e.touched || !e.bars || !e.bars.length) continue;
    const level = e.level;
    let exit = null;
    let exitMin = null;
    for (const b of e.bars) {
      if (e.side === 'ONH') {
        // SHORT entry at level. Stop = level + stopPts. Target = level - targetPts.
        const stopHit = b.h >= level + stopPts;
        const tgtHit  = b.l <= level - targetPts;
        if (stopHit && tgtHit) { exit = -stopPts; exitMin = b.m; break; }
        if (stopHit) { exit = -stopPts; exitMin = b.m; break; }
        if (tgtHit)  { exit = +targetPts; exitMin = b.m; break; }
      } else {
        // LONG entry at level. Stop = level - stopPts. Target = level + targetPts.
        const stopHit = b.l <= level - stopPts;
        const tgtHit  = b.h >= level + targetPts;
        if (stopHit && tgtHit) { exit = -stopPts; exitMin = b.m; break; }
        if (stopHit) { exit = -stopPts; exitMin = b.m; break; }
        if (tgtHit)  { exit = +targetPts; exitMin = b.m; break; }
      }
    }
    if (exit == null) {
      // Time stop at last bar's close
      const last = e.bars[e.bars.length - 1];
      exit = e.side === 'ONH' ? (level - last.c) : (last.c - level);
      exitMin = last.m;
    }
    trades.push({ date: e.date, side: e.side, pnl: exit, exitMin });
  }
  return trades;
}

/**
 * Bar-by-bar break sim. ONH → LONG above, ONL → SHORT below.
 * Entry triggered when price first crosses level by `triggerPts` after touch.
 * Stop = entry - stopPts (long) / entry + stopPts (short). Target = entry + targetPts.
 */
function simBreak(events, stopPts, targetPts, triggerPts = 5) {
  const trades = [];
  for (const e of events) {
    if (!e.touched || !e.bars || !e.bars.length) continue;
    const level = e.level;
    // Find break bar
    let entry = null;
    let entryIdx = -1;
    for (let i = 0; i < e.bars.length; i++) {
      const b = e.bars[i];
      if (e.side === 'ONH' && b.h >= level + triggerPts) {
        entry = level + triggerPts;
        entryIdx = i;
        break;
      }
      if (e.side === 'ONL' && b.l <= level - triggerPts) {
        entry = level - triggerPts;
        entryIdx = i;
        break;
      }
    }
    if (entry == null) continue; // no break, no trade

    // Walk forward from entryIdx to look for stop/target
    let exit = null;
    let exitMin = null;
    for (let i = entryIdx; i < e.bars.length; i++) {
      const b = e.bars[i];
      if (e.side === 'ONH') {
        // LONG: stop = entry - stopPts, target = entry + targetPts
        const stopHit = b.l <= entry - stopPts;
        const tgtHit  = b.h >= entry + targetPts;
        if (stopHit && tgtHit) { exit = -stopPts; exitMin = b.m; break; }
        if (stopHit) { exit = -stopPts; exitMin = b.m; break; }
        if (tgtHit)  { exit = +targetPts; exitMin = b.m; break; }
      } else {
        // SHORT: stop = entry + stopPts, target = entry - targetPts
        const stopHit = b.h >= entry + stopPts;
        const tgtHit  = b.l <= entry - targetPts;
        if (stopHit && tgtHit) { exit = -stopPts; exitMin = b.m; break; }
        if (stopHit) { exit = -stopPts; exitMin = b.m; break; }
        if (tgtHit)  { exit = +targetPts; exitMin = b.m; break; }
      }
    }
    if (exit == null) {
      const last = e.bars[e.bars.length - 1];
      exit = e.side === 'ONH' ? (last.c - entry) : (entry - last.c);
      exitMin = last.m;
    }
    trades.push({ date: e.date, side: e.side, pnl: exit, exitMin });
  }
  return trades;
}

function tradeStats(trades) {
  if (!trades.length) return { n: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const totalPts = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = wins.length / trades.length;
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const expectancy = totalPts / trades.length;
  // Sharpe in points
  const mean = expectancy;
  const variance = trades.reduce((s, t) => s + (t.pnl - mean) ** 2, 0) / trades.length;
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? mean / sd : 0;
  // Max DD
  let peak = 0, trough = 0, dd = 0, eq = 0;
  for (const t of trades) {
    eq += t.pnl;
    if (eq > peak) { peak = eq; trough = eq; }
    if (eq < trough) { trough = eq; dd = Math.max(dd, peak - trough); }
  }
  return {
    n: trades.length,
    nWins: wins.length,
    nLosses: losses.length,
    nFlats: trades.length - wins.length - losses.length,
    winRate: round(winRate, 4),
    totalPts: round(totalPts, 2),
    expectancyPts: round(expectancy, 2),
    profitFactor: round(pf, 3),
    sharpePerTrade: round(sharpe, 3),
    maxDDPts: round(dd, 2),
    avgWinPts: wins.length ? round(grossWin / wins.length, 2) : null,
    avgLossPts: losses.length ? round(grossLoss / losses.length, 2) : null
  };
}

function gridSearch(events, kind /* 'fade'|'break' */) {
  const stops = [15, 20, 25, 30, 40, 50, 60, 75];
  const targets = [20, 25, 30, 40, 50, 60, 75, 100];
  const results = [];
  for (const s of stops) {
    for (const t of targets) {
      const trades = kind === 'fade' ? simFade(events, s, t) : simBreak(events, s, t);
      const stats = tradeStats(trades);
      results.push({ stopPts: s, targetPts: t, ...stats });
    }
  }
  return results.sort((a, b) => (b.profitFactor || 0) - (a.profitFactor || 0));
}

function gridSearchFiltered(events, kind, predicate) {
  const filtered = events.filter(e => e.touched && predicate(e));
  const stops = [15, 20, 25, 30, 40, 50, 60, 75];
  const targets = [20, 25, 30, 40, 50, 60, 75, 100];
  const results = [];
  for (const s of stops) {
    for (const t of targets) {
      const trades = kind === 'fade' ? simFade(filtered, s, t) : simBreak(filtered, s, t);
      const stats = tradeStats(trades);
      results.push({ stopPts: s, targetPts: t, ...stats });
    }
  }
  return results.sort((a, b) => (b.profitFactor || 0) - (a.profitFactor || 0));
}

// ----------------- main -----------------

async function main() {
  const t0 = Date.now();
  console.log('='.repeat(70));
  console.log(' T7 — ONH/ONL retest in first hour (NQ)');
  console.log('='.repeat(70));

  const rolloverDates = loadRolloverDates();
  const candles = await loadRawNqMinute(START_DATE, END_DATE);
  const byDate  = bucketByDay(candles);
  console.log(`ET trading dates seen: ${byDate.size}`);

  console.log('Computing overnight levels and touch events...');
  const { events, dayMeta } = computeEvents(byDate, rolloverDates);
  console.log(`  total touch records (incl. non-touches): ${events.length}`);
  const touched = events.filter(e => e.touched);
  console.log(`  actual touches: ${touched.length}`);
  console.log(`  days analyzed: ${dayMeta.length}`);

  // Split IS / OOS
  const isEvents  = touched.filter(e => e.date <  OOS_CUTOFF);
  const oosEvents = touched.filter(e => e.date >= OOS_CUTOFF);
  console.log(`  IS events: ${isEvents.length}, OOS events: ${oosEvents.length}`);

  // -------- base rates --------
  const baseAll = reactionStats(touched, () => true);
  const baseONH = reactionStats(touched, e => e.side === 'ONH');
  const baseONL = reactionStats(touched, e => e.side === 'ONL');

  // -------- stratifications --------
  const gapBuckets = ['gap_up_strong','gap_up_mild','flat','gap_down_mild','gap_down_strong'];
  const invBuckets = ['mostly_above','mixed','mostly_below'];
  const rangeBuckets = ['small','normal','large'];
  const regimes = ['strong_negative','negative','neutral','positive','strong_positive','unknown'];

  const byGap     = stratify(touched, 'gapBucket', gapBuckets);
  const byInv     = stratify(touched, 'invBucket', invBuckets);
  const byRange   = stratify(touched, 'rangeBucket', rangeBuckets);
  const byRegime  = stratify(touched, 'gexRegime', regimes);

  // Side × gap (often the most actionable)
  const onhByGap = stratify(touched.filter(e => e.side === 'ONH'), 'gapBucket', gapBuckets);
  const onlByGap = stratify(touched.filter(e => e.side === 'ONL'), 'gapBucket', gapBuckets);

  // Side × inventory
  const onhByInv = stratify(touched.filter(e => e.side === 'ONH'), 'invBucket', invBuckets);
  const onlByInv = stratify(touched.filter(e => e.side === 'ONL'), 'invBucket', invBuckets);

  // Side × regime
  const onhByRegime = stratify(touched.filter(e => e.side === 'ONH'), 'gexRegime', regimes);
  const onlByRegime = stratify(touched.filter(e => e.side === 'ONL'), 'gexRegime', regimes);

  // Side × gap × regime (4-cell summary on key combos to find the edge)
  const sideGapRegime = {};
  for (const side of ['ONH','ONL']) {
    sideGapRegime[side] = {};
    for (const g of gapBuckets) {
      sideGapRegime[side][g] = {};
      for (const r of regimes) {
        const cell = reactionStats(touched, e => e.side === side && e.gapBucket === g && e.gexRegime === r);
        if (cell.n >= 5) sideGapRegime[side][g][r] = cell;
      }
    }
  }

  // -------- frequency: P(touch | open != at level) --------
  // Per-day: did ONH or ONL get touched at all? (counts the ratio)
  const dayTouch = {};
  for (const e of events) {
    const k = `${e.date}:${e.side}`;
    if (e.touched) dayTouch[k] = true;
    else if (!(k in dayTouch)) dayTouch[k] = false;
  }
  const onhEligible = events.filter(e => e.side === 'ONH').length;
  const onhTouched  = events.filter(e => e.side === 'ONH' && e.touched).length;
  const onlEligible = events.filter(e => e.side === 'ONL').length;
  const onlTouched  = events.filter(e => e.side === 'ONL' && e.touched).length;
  const freq = {
    onh: { eligible: onhEligible, touched: onhTouched, pTouch: round(onhTouched / Math.max(1, onhEligible), 4) },
    onl: { eligible: onlEligible, touched: onlTouched, pTouch: round(onlTouched / Math.max(1, onlEligible), 4) },
    eitherPerDay: round(touched.length / Math.max(1, dayMeta.length), 4)
  };

  // -------- backtest grids --------
  console.log('Running grid search (fade)...');
  const fadeGridIS  = gridSearch(isEvents, 'fade');
  const fadeGridAll = gridSearch(touched, 'fade');

  console.log('Running grid search (break)...');
  const breakGridIS  = gridSearch(isEvents, 'break');
  const breakGridAll = gridSearch(touched, 'break');

  // Top conditional strategies based on stratification findings
  // We pick the strongest cells from byGap/byInv/byRegime (highest pReversal30 with n>=20) and grid-search those.
  function topConditionalGrids(label, predicate, filteredEvents) {
    const fg = gridSearchFiltered(filteredEvents, 'fade', predicate);
    const bg = gridSearchFiltered(filteredEvents, 'break', predicate);
    return {
      label,
      n: filteredEvents.filter(e => predicate(e)).length,
      topFade: fg.slice(0, 3),
      topBreak: bg.slice(0, 3)
    };
  }

  const conditionalStrats = [];
  // 1. ONH fade in negative-regime days
  conditionalStrats.push(topConditionalGrids(
    'ONH-fade × strong_negative GEX',
    e => e.side === 'ONH' && e.gexRegime === 'strong_negative',
    isEvents
  ));
  // 2. ONL fade in positive-regime days
  conditionalStrats.push(topConditionalGrids(
    'ONL-fade × strong_positive GEX',
    e => e.side === 'ONL' && e.gexRegime === 'strong_positive',
    isEvents
  ));
  // 3. ONH break in gap-up-strong
  conditionalStrats.push(topConditionalGrids(
    'ONH-break × gap_up_strong',
    e => e.side === 'ONH' && e.gapBucket === 'gap_up_strong',
    isEvents
  ));
  // 4. ONL break in gap-down-strong
  conditionalStrats.push(topConditionalGrids(
    'ONL-break × gap_down_strong',
    e => e.side === 'ONL' && e.gapBucket === 'gap_down_strong',
    isEvents
  ));
  // 5. ONH fade after gap-up + mostly_above inventory (exhaustion thesis)
  conditionalStrats.push(topConditionalGrids(
    'ONH-fade × gap_up + mostly_above inventory',
    e => e.side === 'ONH' && (e.gapBucket === 'gap_up_mild' || e.gapBucket === 'gap_up_strong') && e.invBucket === 'mostly_above',
    isEvents
  ));
  // 6. ONL fade after gap-down + mostly_below inventory
  conditionalStrats.push(topConditionalGrids(
    'ONL-fade × gap_down + mostly_below inventory',
    e => e.side === 'ONL' && (e.gapBucket === 'gap_down_mild' || e.gapBucket === 'gap_down_strong') && e.invBucket === 'mostly_below',
    isEvents
  ));
  // 7. Generic fade (both sides, all conditions)
  conditionalStrats.push(topConditionalGrids(
    'Fade-all (any touch, any conditions)',
    () => true,
    isEvents
  ));
  // 8. Side-agnostic break w/ aligned gap (gap_up_strong × ONH break OR gap_down_strong × ONL break)
  conditionalStrats.push(topConditionalGrids(
    'Aligned-gap break (gap_up_strong→ONH-break OR gap_down_strong→ONL-break)',
    e => (e.gapBucket === 'gap_up_strong' && e.side === 'ONH') || (e.gapBucket === 'gap_down_strong' && e.side === 'ONL'),
    isEvents
  ));
  // 9. ONL fade × neg regimes (very high reversal rate)
  conditionalStrats.push(topConditionalGrids(
    'ONL-fade × neg/strong_neg regime',
    e => e.side === 'ONL' && (e.gexRegime === 'negative' || e.gexRegime === 'strong_negative'),
    isEvents
  ));
  // 10. ONL fade × neutral regime (100% rev30)
  conditionalStrats.push(topConditionalGrids(
    'ONL-fade × neutral regime',
    e => e.side === 'ONL' && e.gexRegime === 'neutral',
    isEvents
  ));
  // 11. ONL fade × gap_down_strong (88.9% rev30)
  conditionalStrats.push(topConditionalGrids(
    'ONL-fade × gap_down_strong',
    e => e.side === 'ONL' && e.gapBucket === 'gap_down_strong',
    isEvents
  ));
  // 12. ONH fade × positive regime (lowest MAE for fade)
  conditionalStrats.push(topConditionalGrids(
    'ONH-fade × positive regime',
    e => e.side === 'ONH' && e.gexRegime === 'positive',
    isEvents
  ));
  // 13. ONL fade × gap_up_strong (counter-trend mean revert into ONL)
  conditionalStrats.push(topConditionalGrids(
    'ONL-fade × gap_up_strong',
    e => e.side === 'ONL' && e.gapBucket === 'gap_up_strong',
    isEvents
  ));
  // 14. Combined "best" fade: ONL in any non-positive regime
  conditionalStrats.push(topConditionalGrids(
    'ONL-fade × non-positive regime',
    e => e.side === 'ONL' && e.gexRegime !== 'positive' && e.gexRegime !== 'strong_positive',
    isEvents
  ));
  // 15. Combined fade: ONH in any non-negative regime
  conditionalStrats.push(topConditionalGrids(
    'ONH-fade × non-negative regime',
    e => e.side === 'ONH' && e.gexRegime !== 'negative' && e.gexRegime !== 'strong_negative',
    isEvents
  ));

  // OOS validation of best three IS strategies
  function bestStrat(grid) { return grid[0]; }
  const oosResults = [];
  for (const s of conditionalStrats) {
    const tf = s.topFade[0];
    const tb = s.topBreak[0];
    if (tf && tf.n >= 20) {
      const oosPredicate = makeMatchingPredicate(s.label);
      const oosFilteredEvents = oosEvents.filter(oosPredicate);
      if (oosFilteredEvents.length >= 5) {
        const trades = simFade(oosFilteredEvents, tf.stopPts, tf.targetPts);
        oosResults.push({
          label: s.label + ' (FADE)',
          oosN: oosFilteredEvents.length,
          stopPts: tf.stopPts, targetPts: tf.targetPts,
          isStats: { winRate: tf.winRate, pf: tf.profitFactor, expectancy: tf.expectancyPts },
          oosStats: tradeStats(trades)
        });
      }
    }
    if (tb && tb.n >= 20) {
      const oosPredicate = makeMatchingPredicate(s.label);
      const oosFilteredEvents = oosEvents.filter(oosPredicate);
      if (oosFilteredEvents.length >= 5) {
        const trades = simBreak(oosFilteredEvents, tb.stopPts, tb.targetPts);
        oosResults.push({
          label: s.label + ' (BREAK)',
          oosN: oosFilteredEvents.length,
          stopPts: tb.stopPts, targetPts: tb.targetPts,
          isStats: { winRate: tb.winRate, pf: tb.profitFactor, expectancy: tb.expectancyPts },
          oosStats: tradeStats(trades)
        });
      }
    }
  }

  // -------- write output --------
  const result = {
    meta: {
      script: 'T7-onh-onl-retest.js',
      generatedAt: new Date().toISOString(),
      startDate: START_DATE,
      endDate: END_DATE,
      oosCutoff: OOS_CUTOFF,
      params: {
        TOUCH_TOL_PTS, MIN_OPEN_DIST, REVERSAL_PTS, CONTINUATION_PTS,
        REACTION_WIN_MIN, RTH_TOUCH_START, RTH_TOUCH_END
      },
      nDaysAnalyzed: dayMeta.length,
      nTouchEvents: touched.length,
      isEvents: isEvents.length,
      oosEvents: oosEvents.length
    },
    frequency: freq,
    baseRates: { all: baseAll, ONH: baseONH, ONL: baseONL },
    stratification: {
      byGap, byInv, byRange, byRegime,
      onhByGap, onlByGap,
      onhByInv, onlByInv,
      onhByRegime, onlByRegime,
      sideGapRegime
    },
    grids: {
      fadeAll: fadeGridIS.slice(0, 5),
      breakAll: breakGridIS.slice(0, 5),
      fadeAllFull: fadeGridAll.slice(0, 5),
      breakAllFull: breakGridAll.slice(0, 5)
    },
    conditionalStrategies: conditionalStrats,
    oosValidation: oosResults
  };

  if (!fs.existsSync(path.dirname(OUTPUT_PATH))) {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  }
  // Strip bulky `bars` from any embedded events before serialization (none currently embedded, but defensive)
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`\nWrote: ${OUTPUT_PATH}`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Print headline
  console.log('\n' + '='.repeat(70));
  console.log(' Headlines');
  console.log('='.repeat(70));
  console.log(`Touch frequency: ONH=${freq.onh.pTouch}, ONL=${freq.onl.pTouch}, total=${freq.eitherPerDay} touches/day`);
  console.log(`Base reversal-30 rate: ${baseAll.pReversal30} | continuation-20 rate: ${baseAll.pContin20}`);
  console.log(`ONH reversal-30: ${baseONH.pReversal30} (n=${baseONH.n}) | ONL reversal-30: ${baseONL.pReversal30} (n=${baseONL.n})`);
  console.log('\nTop 3 fade configs (IS):');
  for (const r of fadeGridIS.slice(0, 3)) {
    console.log(`  stop=${r.stopPts} tgt=${r.targetPts} → n=${r.n} WR=${r.winRate} PF=${r.profitFactor} exp=${r.expectancyPts}pts`);
  }
  console.log('\nTop 3 break configs (IS):');
  for (const r of breakGridIS.slice(0, 3)) {
    console.log(`  stop=${r.stopPts} tgt=${r.targetPts} → n=${r.n} WR=${r.winRate} PF=${r.profitFactor} exp=${r.expectancyPts}pts`);
  }
  console.log('\nBest conditional strategies (IS, top fade & break per cell):');
  for (const s of conditionalStrats) {
    const tf = s.topFade[0];
    const tb = s.topBreak[0];
    console.log(`  [${s.label}] n=${s.n}`);
    if (tf) console.log(`    fade  : stop=${tf.stopPts} tgt=${tf.targetPts} n=${tf.n} WR=${tf.winRate} PF=${tf.profitFactor} exp=${tf.expectancyPts}`);
    if (tb) console.log(`    break : stop=${tb.stopPts} tgt=${tb.targetPts} n=${tb.n} WR=${tb.winRate} PF=${tb.profitFactor} exp=${tb.expectancyPts}`);
  }
  console.log('\nOOS validation:');
  for (const r of oosResults) {
    console.log(`  [${r.label}] IS PF=${r.isStats.pf} → OOS n=${r.oosStats.n} WR=${r.oosStats.winRate} PF=${r.oosStats.profitFactor} exp=${r.oosStats.expectancyPts}`);
  }
}

// helper to recreate predicates from labels for OOS
function makeMatchingPredicate(label) {
  switch (label) {
    case 'ONH-fade × strong_negative GEX':
      return e => e.side === 'ONH' && e.gexRegime === 'strong_negative';
    case 'ONL-fade × strong_positive GEX':
      return e => e.side === 'ONL' && e.gexRegime === 'strong_positive';
    case 'ONH-break × gap_up_strong':
      return e => e.side === 'ONH' && e.gapBucket === 'gap_up_strong';
    case 'ONL-break × gap_down_strong':
      return e => e.side === 'ONL' && e.gapBucket === 'gap_down_strong';
    case 'ONH-fade × gap_up + mostly_above inventory':
      return e => e.side === 'ONH' && (e.gapBucket === 'gap_up_mild' || e.gapBucket === 'gap_up_strong') && e.invBucket === 'mostly_above';
    case 'ONL-fade × gap_down + mostly_below inventory':
      return e => e.side === 'ONL' && (e.gapBucket === 'gap_down_mild' || e.gapBucket === 'gap_down_strong') && e.invBucket === 'mostly_below';
    case 'Fade-all (any touch, any conditions)':
      return () => true;
    case 'Aligned-gap break (gap_up_strong→ONH-break OR gap_down_strong→ONL-break)':
      return e => (e.gapBucket === 'gap_up_strong' && e.side === 'ONH') || (e.gapBucket === 'gap_down_strong' && e.side === 'ONL');
    case 'ONL-fade × neg/strong_neg regime':
      return e => e.side === 'ONL' && (e.gexRegime === 'negative' || e.gexRegime === 'strong_negative');
    case 'ONL-fade × neutral regime':
      return e => e.side === 'ONL' && e.gexRegime === 'neutral';
    case 'ONL-fade × gap_down_strong':
      return e => e.side === 'ONL' && e.gapBucket === 'gap_down_strong';
    case 'ONH-fade × positive regime':
      return e => e.side === 'ONH' && e.gexRegime === 'positive';
    case 'ONL-fade × gap_up_strong':
      return e => e.side === 'ONL' && e.gapBucket === 'gap_up_strong';
    case 'ONL-fade × non-positive regime':
      return e => e.side === 'ONL' && e.gexRegime !== 'positive' && e.gexRegime !== 'strong_positive';
    case 'ONH-fade × non-negative regime':
      return e => e.side === 'ONH' && e.gexRegime !== 'negative' && e.gexRegime !== 'strong_negative';
    default:
      return () => false;
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
