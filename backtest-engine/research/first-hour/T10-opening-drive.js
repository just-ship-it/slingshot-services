#!/usr/bin/env node
/**
 * T10 — Opening Drive Continuation
 *
 * Hypothesis: when the first 5m or first 15m RTH candle has BOTH
 *   - range_pct >= 70th percentile vs trailing 20 days (relaxed from 80)
 *   - volume    >= 1.3 × trailing 20-day mean of the same candle (relaxed from 1.5)
 * the rest of the first hour continues in the candle's direction with WR >=60% and
 * meaningful magnitude.
 *
 * Steps:
 *   1) Build, per trading day, first-5m and first-15m (range, volume) and a 20-day
 *      trailing distribution to flag "drive" days.
 *   2) For drive days compute: P(end-of-window in same direction), P(reach +30 first vs -30),
 *      MFE/MAE in candle direction at 30/60/90-min horizons.
 *   3) Build candidate strategies:
 *      - 5m drive: stop entry at first-5m extreme (entry from 9:35), stop = opp extreme,
 *        targets {30, 50, 75, 100} pts, time-stop 11:00.
 *      - 15m drive: same logic on the 9:45 boundary using first-15m candle.
 *   4) Grid-search stop / target. Hold last 2 months OOS.
 *
 * Hard rules: raw contracts + filterPrimaryContract, ET windowing, skip rollover days.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { CSVLoader } from '../../src/data/csv-loader.js';
import { toET, fromET } from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..', '..');

const NQ_OHLCV_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
const ROLLOVER_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_rollover_log.csv');
const OUTPUT_PATH   = path.join(__dirname, 'output', 'T10-opening-drive.json');

const START_DATE = '2025-01-13';
const END_DATE   = '2026-04-23';
const OOS_START  = '2026-02-23'; // ~last 2 months

const TRAILING_DAYS = 20;
const RANGE_PCTILE_THRESH = 70;   // relaxed
const VOL_MULT_THRESH     = 1.30; // relaxed
const TIME_STOP_ET_MIN    = 11 * 60; // 11:00 ET

// -------------------- helpers --------------------

function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(idx); const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function summary(arr) {
  if (!arr.length) return { n: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min:  round(sorted[0], 2),
    p25:  round(pct(sorted, 25), 2),
    median: round(pct(sorted, 50), 2),
    mean: round(mean(sorted), 2),
    p75:  round(pct(sorted, 75), 2),
    p90:  round(pct(sorted, 90), 2),
    max:  round(sorted[sorted.length - 1], 2)
  };
}
function round(x, d = 2) {
  if (x == null || isNaN(x)) return null;
  const m = Math.pow(10, d);
  return Math.round(x * m) / m;
}
function fracAtLeast(arr, t) { return arr.length ? arr.filter(v => v >= t).length / arr.length : null; }

/** Return percentile-rank (0-100) of value vs array of references. */
function percentileRank(value, refs) {
  if (!refs.length) return null;
  let lt = 0, eq = 0;
  for (const r of refs) {
    if (r < value) lt++;
    else if (r === value) eq++;
  }
  return ((lt + 0.5 * eq) / refs.length) * 100;
}

// -------------------- data load --------------------

async function loadRawNqMinute(startDate, endDate) {
  console.log(`Loading raw NQ 1m candles ${startDate} → ${endDate}...`);
  // Need ~30 trading days of warmup before START_DATE for trailing 20-day stats.
  const warmStart = new Date(new Date(startDate).getTime() - 50 * 86400000)
    .toISOString().slice(0, 10);
  const start = new Date(warmStart + 'T00:00:00Z').getTime();
  const end   = new Date(endDate    + 'T23:59:59Z').getTime();
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
      .on('end', resolve).on('error', reject);
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

// -------------------- per-day prep --------------------

/**
 * Group candles by ET trading date (weekdays only).
 */
function bucketByDay(candles) {
  const byDate = new Map();
  for (const c of candles) {
    const et = toET(c.timestamp);
    if (et.dayOfWeek === 0 || et.dayOfWeek === 6) continue;
    if (!byDate.has(et.date)) byDate.set(et.date, []);
    byDate.get(et.date).push({ ...c, et });
  }
  return byDate;
}

/**
 * For each trading day produce:
 *   first5  = { open, high, low, close, range, volume, dir }
 *   first15 = same shape
 *   path = full first-90m path (rth window 9:30-11:00) — array of 1m candles
 */
function computeOpeningStats(byDate, rolloverDates) {
  const dates = [...byDate.keys()].sort();
  const out = [];
  for (const dateStr of dates) {
    if (rolloverDates.has(dateStr)) continue;
    const day = byDate.get(dateStr);
    if (!day || day.length < 60) continue;
    // 9:30-11:00 ET = timeInMinutes 570..659
    const window = day.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes < 660)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (window.length < 80) continue;
    // first 5 minutes (570..574)
    const first5 = window.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes < 575);
    // first 15 minutes (570..584)
    const first15 = window.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes < 585);
    if (first5.length < 4 || first15.length < 13) continue;

    function aggregate(slice) {
      const o = slice[0].open;
      const c = slice[slice.length - 1].close;
      const h = Math.max(...slice.map(s => s.high));
      const l = Math.min(...slice.map(s => s.low));
      const v = slice.reduce((s, x) => s + x.volume, 0);
      return { open: o, high: h, low: l, close: c, range: h - l, volume: v, dir: c > o ? 1 : (c < o ? -1 : 0) };
    }

    out.push({
      date: dateStr,
      dayOfWeek: window[0].et.dayOfWeek,
      first5:  aggregate(first5),
      first15: aggregate(first15),
      path: window.map(c => ({
        ts: c.timestamp,
        et: c.et.timeInMinutes - 570,  // minutes since 9:30
        open: c.open, high: c.high, low: c.low, close: c.close, vol: c.volume
      }))
    });
  }
  return out;
}

// -------------------- drive day classification --------------------

/**
 * Adds rangePctile / volMult fields per day vs trailing 20-day reference.
 * Reference uses days strictly BEFORE the candidate (no lookahead).
 */
function annotateDriveContext(days) {
  // sorted by date already
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const refStart = Math.max(0, i - TRAILING_DAYS);
    const refs = days.slice(refStart, i); // up to last 20 days
    if (refs.length < 10) {
      d.first5.rangePctile = null; d.first5.volMult = null;
      d.first15.rangePctile = null; d.first15.volMult = null;
      continue;
    }
    const r5 = refs.map(x => x.first5.range);
    const v5 = refs.map(x => x.first5.volume);
    const r15 = refs.map(x => x.first15.range);
    const v15 = refs.map(x => x.first15.volume);

    d.first5.rangePctile = round(percentileRank(d.first5.range, r5), 1);
    d.first5.volMult     = round(d.first5.volume / mean(v5), 3);
    d.first15.rangePctile = round(percentileRank(d.first15.range, r15), 1);
    d.first15.volMult     = round(d.first15.volume / mean(v15), 3);

    d.first5.isDrive  = d.first5.rangePctile  >= RANGE_PCTILE_THRESH && d.first5.volMult  >= VOL_MULT_THRESH && d.first5.dir !== 0;
    d.first15.isDrive = d.first15.rangePctile >= RANGE_PCTILE_THRESH && d.first15.volMult >= VOL_MULT_THRESH && d.first15.dir !== 0;
  }
  return days;
}

// -------------------- conditional probabilities --------------------

/**
 * For drive days (5m or 15m) compute path metrics in candle direction.
 *   - close at 11:00 vs candle close (sign in same direction?)
 *   - P(reach +30pt before -30pt in candle direction starting from candle close)
 *   - MFE/MAE in candle direction at 30/60/90 min horizons
 */
function pathMetricsFor(days, kind) {
  // kind = 'first5' | 'first15'
  const startMin = kind === 'first5' ? 5 : 15;
  const out = [];
  for (const d of days) {
    const k = d[kind];
    if (!k.isDrive) continue;
    // path *after* the drive candle (entry at candle close)
    const after = d.path.filter(p => p.et >= startMin);
    if (!after.length) continue;
    const entry = k.close;
    const sign = k.dir;

    // outcome at end of window (11:00 == 90 min from 9:30)
    const last = after[after.length - 1];
    const dirOk = (last.close - entry) * sign > 0;

    // first-touch: which side is hit first at +-30
    let firstTouch = null;
    for (const p of after) {
      const upHit = sign > 0 ? (p.high - entry >= 30) : (entry - p.low >= 30);
      const dnHit = sign > 0 ? (entry - p.low >= 30) : (p.high - entry >= 30);
      if (upHit && dnHit) {
        // both same bar — assume open used as tie-break: which is closer to open?
        const upDist = sign > 0 ? Math.abs(entry + 30 - p.open) : Math.abs(entry - 30 - p.open);
        const dnDist = sign > 0 ? Math.abs(entry - 30 - p.open) : Math.abs(entry + 30 - p.open);
        firstTouch = upDist <= dnDist ? 'tp' : 'sl';
        break;
      }
      if (upHit) { firstTouch = 'tp'; break; }
      if (dnHit) { firstTouch = 'sl'; break; }
    }

    // MFE/MAE in candle direction at horizons (relative to entry)
    const horizons = {};
    for (const h of [30, 60, 90]) {
      const slice = after.filter(p => p.et < startMin + h - (startMin === 5 ? 0 : 0));
      // slice represents bars from entry up to entry + h minutes worth (rough)
      const hi = Math.max(...slice.map(p => p.high));
      const lo = Math.min(...slice.map(p => p.low));
      const mfe = sign > 0 ? hi - entry : entry - lo;
      const mae = sign > 0 ? entry - lo : hi - entry;
      horizons[`h${h}`] = { mfe: round(mfe, 2), mae: round(mae, 2) };
    }

    out.push({
      date: d.date,
      sign,
      entry,
      endClose: last.close,
      endPnl: round((last.close - entry) * sign, 2),
      dirAtEnd: dirOk,
      firstTouch30: firstTouch,
      horizons
    });
  }

  if (!out.length) return { n: 0 };

  const endPnls = out.map(x => x.endPnl);
  return {
    n: out.length,
    pSameDirAtEnd: round(out.filter(x => x.dirAtEnd).length / out.length, 4),
    pTPbeforeSL30: round(out.filter(x => x.firstTouch30 === 'tp').length / out.length, 4),
    pSLbeforeTP30: round(out.filter(x => x.firstTouch30 === 'sl').length / out.length, 4),
    pNoTouch30:    round(out.filter(x => x.firstTouch30 === null).length / out.length, 4),
    endPnl: summary(endPnls),
    horizons: {
      h30: { mfe: summary(out.map(x => x.horizons.h30.mfe)), mae: summary(out.map(x => x.horizons.h30.mae)) },
      h60: { mfe: summary(out.map(x => x.horizons.h60.mfe)), mae: summary(out.map(x => x.horizons.h60.mae)) },
      h90: { mfe: summary(out.map(x => x.horizons.h90.mfe)), mae: summary(out.map(x => x.horizons.h90.mae)) }
    },
    fracEndPnlGE: {
      '20': round(fracAtLeast(endPnls, 20), 4),
      '30': round(fracAtLeast(endPnls, 30), 4),
      '50': round(fracAtLeast(endPnls, 50), 4),
      '75': round(fracAtLeast(endPnls, 75), 4)
    },
    perTradeSamples: out
  };
}

// -------------------- strategy simulation --------------------

/**
 * Simulate a "drive continuation" strategy variant.
 *   variant.kind          = 'first5' | 'first15'
 *   variant.entryMode     = 'close' | 'breakStop'
 *       'close'      → enter at the drive candle's close, side = sign(candleDir)
 *       'breakStop'  → place stop order at candle high (long) or low (short);
 *                       fill if/when subsequent bar trades through that price
 *   variant.stopMode      = 'oppExtreme' | 'fixedPts'
 *   variant.stopPts       = number (when stopMode='fixedPts')
 *   variant.targetPts     = number (target in points)
 *   variant.timeStopETMin = e.g. 660 (11:00)
 *   variant.skipFirstTouchSameBar = (default true) — assume SL hit if same-bar both
 *
 * Cost model: $20/contract round-turn (slippage + fees, NQ point = $20).
 *  Subtract 0.25 pts equivalent ($5) per side as approx slippage on stop entries / market exits.
 */
function simulateVariant(days, variant) {
  const trades = [];
  const SLIPPAGE_PTS = 0.25;       // per side
  const POINT_VALUE  = 20;          // NQ
  const COMM_PER_RT  = 4;           // $4 commission round trip (rough)

  for (const d of days) {
    const k = d[variant.kind];
    if (!k.isDrive) continue;
    const startMin = variant.kind === 'first5' ? 5 : 15;
    const after = d.path.filter(p => p.et >= startMin);
    if (!after.length) continue;

    const sign = k.dir;
    let entryPrice, entryEt;

    if (variant.entryMode === 'close') {
      entryPrice = k.close;
      entryEt    = startMin;
    } else if (variant.entryMode === 'breakStop') {
      // stop above high (long) / below low (short)
      const trigger = sign > 0 ? k.high : k.low;
      let filled = false;
      for (const p of after) {
        if (sign > 0 && p.high >= trigger) { entryPrice = trigger + SLIPPAGE_PTS; entryEt = p.et; filled = true; break; }
        if (sign < 0 && p.low  <= trigger) { entryPrice = trigger - SLIPPAGE_PTS; entryEt = p.et; filled = true; break; }
      }
      if (!filled) continue;
    } else {
      throw new Error('unknown entryMode');
    }

    // Stop / target
    let stopPrice, targetPrice;
    if (variant.stopMode === 'oppExtreme') {
      const oppExt = sign > 0 ? k.low : k.high;
      stopPrice = oppExt;
    } else if (variant.stopMode === 'fixedPts') {
      stopPrice = sign > 0 ? entryPrice - variant.stopPts : entryPrice + variant.stopPts;
    } else throw new Error('unknown stopMode');
    targetPrice = sign > 0 ? entryPrice + variant.targetPts : entryPrice - variant.targetPts;

    // Walk forward
    const journey = after.filter(p => p.et >= entryEt);
    let exitPrice = null, exitEt = null, exitReason = null;
    for (const p of journey) {
      const upHit = sign > 0 ? (p.high >= targetPrice) : (p.low <= targetPrice);
      const dnHit = sign > 0 ? (p.low  <= stopPrice)   : (p.high >= stopPrice);
      if (upHit && dnHit) {
        // assume stop first
        exitPrice = stopPrice + (sign > 0 ? -SLIPPAGE_PTS : SLIPPAGE_PTS);
        exitEt = p.et; exitReason = 'stop_amb'; break;
      }
      if (upHit) { exitPrice = targetPrice; exitEt = p.et; exitReason = 'target'; break; }
      if (dnHit) {
        exitPrice = stopPrice + (sign > 0 ? -SLIPPAGE_PTS : SLIPPAGE_PTS);
        exitEt = p.et; exitReason = 'stop'; break;
      }
    }
    if (exitPrice == null) {
      // time stop
      const last = journey[journey.length - 1];
      exitPrice = last.close + (sign > 0 ? -SLIPPAGE_PTS : SLIPPAGE_PTS);
      exitEt = last.et;
      exitReason = 'time_stop';
    }

    const pts = (exitPrice - entryPrice) * sign;
    const $   = pts * POINT_VALUE - COMM_PER_RT;

    trades.push({
      date: d.date, sign, entryEt, exitEt, entryPrice: round(entryPrice, 2),
      exitPrice: round(exitPrice, 2), stopPrice: round(stopPrice, 2),
      targetPrice: round(targetPrice, 2), exitReason,
      pts: round(pts, 2), pnl$: round($, 2)
    });
  }
  return trades;
}

function tradeStats(trades) {
  if (!trades.length) return { n: 0 };
  const pnl = trades.map(t => t.pnl$);
  const wins = pnl.filter(p => p > 0);
  const losses = pnl.filter(p => p <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const totalPnl = grossWin - grossLoss;
  const wr = wins.length / trades.length;
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  // daily (one trade/day) Sharpe approx — annualize by sqrt(252)
  const daily = pnl;
  const m = mean(daily);
  const s = std(daily);
  const sharpe = s > 0 ? (m / s) * Math.sqrt(252) : 0;

  // Max drawdown on running cumulative equity
  let peak = 0, eq = 0, maxDD = 0;
  for (const p of pnl) {
    eq += p;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
  }

  // exit-reason counts
  const reasons = {};
  for (const t of trades) reasons[t.exitReason] = (reasons[t.exitReason] || 0) + 1;

  return {
    n: trades.length,
    winRate: round(wr, 4),
    pnl$: round(totalPnl, 2),
    grossWin$: round(grossWin, 2),
    grossLoss$: round(grossLoss, 2),
    pf: round(pf, 3),
    sharpe: round(sharpe, 2),
    avgWin$: round(grossWin / Math.max(1, wins.length), 2),
    avgLoss$: round(grossLoss / Math.max(1, losses.length), 2),
    expectancy$: round(totalPnl / trades.length, 2),
    maxDD$: round(maxDD, 2),
    exitReasons: reasons
  };
}

// -------------------- main --------------------

async function main() {
  const t0 = Date.now();
  console.log('='.repeat(70));
  console.log(' T10 — Opening drive (wide+volume) continuation (NQ)');
  console.log('='.repeat(70));

  const rolloverDates = loadRolloverDates();
  const candles = await loadRawNqMinute(START_DATE, END_DATE);
  const byDate = bucketByDay(candles);
  console.log(`Trading dates seen: ${byDate.size}`);

  let days = computeOpeningStats(byDate, rolloverDates);
  console.log(`Days with full opening window: ${days.length}`);
  // Drop pre-START_DATE (we kept warmup for trailing reference only)
  days = annotateDriveContext(days);
  const inWindow = days.filter(d => d.date >= START_DATE && d.date <= END_DATE);
  console.log(`Days in study window: ${inWindow.length}`);

  // Drive-day counts
  const drive5  = inWindow.filter(d => d.first5.isDrive);
  const drive15 = inWindow.filter(d => d.first15.isDrive);
  const drive5Long  = drive5.filter(d => d.first5.dir > 0).length;
  const drive5Short = drive5.filter(d => d.first5.dir < 0).length;
  const drive15Long  = drive15.filter(d => d.first15.dir > 0).length;
  const drive15Short = drive15.filter(d => d.first15.dir < 0).length;
  console.log(`5m drives:  ${drive5.length}  (long ${drive5Long} / short ${drive5Short})`);
  console.log(`15m drives: ${drive15.length} (long ${drive15Long} / short ${drive15Short})`);

  // ---------- conditional probs ----------
  const cond5  = pathMetricsFor(inWindow, 'first5');
  const cond15 = pathMetricsFor(inWindow, 'first15');

  // ---------- strategy grid ----------
  // For each kind run two entry modes and a stop x target grid.
  const stopTargetGrid = [];
  const stopPtsList   = [15, 20, 25, 30, 40];
  const targetPtsList = [20, 30, 50, 75, 100];
  for (const sp of stopPtsList) for (const tp of targetPtsList) stopTargetGrid.push({ stopMode: 'fixedPts', stopPts: sp, targetPts: tp });
  // also add "opp extreme" stop with the same target list
  for (const tp of targetPtsList) stopTargetGrid.push({ stopMode: 'oppExtreme', targetPts: tp });

  const variants = [];
  for (const kind of ['first5', 'first15']) {
    for (const entryMode of ['close', 'breakStop']) {
      for (const grid of stopTargetGrid) {
        variants.push({ kind, entryMode, ...grid });
      }
    }
  }
  console.log(`Running ${variants.length} variants...`);

  const results = [];
  for (const v of variants) {
    const tradesAll  = simulateVariant(inWindow, v);
    const tradesIs   = tradesAll.filter(t => t.date <  OOS_START);
    const tradesOos  = tradesAll.filter(t => t.date >= OOS_START);
    const stats      = tradeStats(tradesAll);
    const statsIs    = tradeStats(tradesIs);
    const statsOos   = tradeStats(tradesOos);
    results.push({
      variant: v,
      all: stats,
      is:  statsIs,
      oos: statsOos,
      // sample of trades for top-3 inspection later (only kept for in-mem; trimmed below)
      _trades: tradesAll
    });
  }

  // Rank by all-period PF (need >=20 trades and PF defined)
  const ranked = results
    .filter(r => r.all.n >= 20 && isFinite(r.all.pf))
    .sort((a, b) => b.all.pf - a.all.pf);

  const top3PerKind = {};
  for (const kind of ['first5', 'first15']) {
    const subset = ranked.filter(r => r.variant.kind === kind);
    top3PerKind[kind] = subset.slice(0, 3).map(r => ({
      variant: r.variant,
      all: r.all, is: r.is, oos: r.oos
    }));
  }

  // Also: top-3 by Sharpe with PF > 1.2 and >=30 trades
  const top3PerKindSharpe = {};
  for (const kind of ['first5', 'first15']) {
    const subset = ranked.filter(r => r.variant.kind === kind && r.all.pf > 1.2 && r.all.n >= 30)
      .sort((a, b) => b.all.sharpe - a.all.sharpe);
    top3PerKindSharpe[kind] = subset.slice(0, 3).map(r => ({
      variant: r.variant,
      all: r.all, is: r.is, oos: r.oos
    }));
  }

  // Strip _trades before serialising; keep trades for the overall #1 variant for audit.
  const overallBest = ranked[0];
  const bestTrades  = overallBest ? overallBest._trades.slice(0, 600) : [];
  const allResultsLight = results.map(r => ({ variant: r.variant, all: r.all, is: r.is, oos: r.oos }));

  const output = {
    meta: {
      script: 'T10-opening-drive.js',
      generatedAt: new Date().toISOString(),
      startDate: START_DATE,
      endDate: END_DATE,
      oosStart: OOS_START,
      trailingDays: TRAILING_DAYS,
      rangePctileThresh: RANGE_PCTILE_THRESH,
      volMultThresh: VOL_MULT_THRESH,
      nDaysInWindow: inWindow.length,
      n5mDrives: drive5.length,
      n15mDrives: drive15.length
    },
    driveCounts: {
      first5:  { total: drive5.length,  long: drive5Long,  short: drive5Short },
      first15: { total: drive15.length, long: drive15Long, short: drive15Short }
    },
    conditional: {
      first5: { ...cond5,  perTradeSamples: undefined },
      first15: { ...cond15, perTradeSamples: undefined }
    },
    topByPF:     top3PerKind,
    topBySharpe: top3PerKindSharpe,
    overallBestVariant: overallBest ? {
      variant: overallBest.variant,
      all: overallBest.all, is: overallBest.is, oos: overallBest.oos
    } : null,
    overallBestTradesSample: bestTrades,
    allResults: allResultsLight
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH} (${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)} KB)`);
  console.log(`Elapsed: ${((Date.now() - t0)/1000).toFixed(1)}s`);

  // Console headline
  console.log('\n--- Conditional (first5 drive)  ---');
  console.log('  n=', cond5.n, ' pSameDirAtEnd=', cond5.pSameDirAtEnd, ' pTPbeforeSL30=', cond5.pTPbeforeSL30, ' pSLbeforeTP30=', cond5.pSLbeforeTP30);
  console.log('  endPnl median=', cond5.endPnl?.median, ' p75=', cond5.endPnl?.p75);
  console.log('--- Conditional (first15 drive) ---');
  console.log('  n=', cond15.n, ' pSameDirAtEnd=', cond15.pSameDirAtEnd, ' pTPbeforeSL30=', cond15.pTPbeforeSL30, ' pSLbeforeTP30=', cond15.pSLbeforeTP30);
  console.log('  endPnl median=', cond15.endPnl?.median, ' p75=', cond15.endPnl?.p75);

  console.log('\n--- TOP 3 BY PF (first5) ---');
  for (const r of top3PerKind.first5)  console.log(' ', JSON.stringify(r.variant), '  ', r.all);
  console.log('--- TOP 3 BY PF (first15) ---');
  for (const r of top3PerKind.first15) console.log(' ', JSON.stringify(r.variant), '  ', r.all);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
