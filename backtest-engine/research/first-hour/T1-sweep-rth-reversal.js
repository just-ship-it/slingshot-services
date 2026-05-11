/**
 * T1 — Sweep + RTH-timed Reversal Entry
 *
 * Hypothesis: Restricting overnight-range-sweep reversal entries to the RTH
 * window (entry ≥ 9:30 ET, exit by 11:00 ET) yields a cleaner MFE/MAE
 * distribution than the all-session post-sweep reversal study (avg MFE 167 /
 * MAE 84 / base reversal 67.6%).
 *
 * Dataset rules (per MASTER-PLAN.md):
 *  - Raw NQ 1m via CSVLoader → filterPrimaryContract (NEVER continuous).
 *  - GEX = post-fix CBBO (data/gex/nq-cbbo) — not loaded for the sweep
 *    detection itself; we only need price.
 *  - Date range: 2025-01-13 → 2026-04-23. Hold last 2 months OOS.
 *  - All times in ET. Source data is UTC. Use toET/fromET.
 *  - Skip days where the sweep candle or entry candle falls inside a contract
 *    rollover boundary.
 *
 * Sweep window: 7:30 ET → 10:00 ET — captures the realistic morning sweep
 * window. Entry must be ≥ 9:30 ET. Trade is force-flat at 11:00 ET.
 *
 * Output:
 *   research/first-hour/output/T1-sweep-rth-reversal.json (param grid + trades)
 *
 * Usage:
 *   cd backtest-engine && node research/first-hour/T1-sweep-rth-reversal.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CSVLoader } from '../../src/data/csv-loader.js';
import { toET, fromET } from '../utils/data-loader.js';
import { calculatePercentiles, round, saveResults } from '../utils/analysis-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'config', 'default.json'), 'utf-8'));

// --- Parameters ---
const START_DATE = '2025-01-13';
const END_DATE = '2026-04-23';
const OOS_START = '2026-02-23'; // last 2 months OOS
const TOUCH_THRESHOLD = 2;       // points
const ASIAN_START_HOUR_ET = 19;  // 7 PM ET (prev calendar day)
const ASIAN_END_HOUR_ET = 3;     // 3 AM ET (current day)
const SWEEP_WINDOW_START_MIN = 7 * 60 + 30;  // 07:30 ET
const SWEEP_WINDOW_END_MIN = 10 * 60;        // 10:00 ET (exclusive)
const ENTRY_MIN_TIME = 9 * 60 + 30;          // 09:30 ET (entry must be at/after)
const FORCE_FLAT_MIN = 11 * 60;              // 11:00 ET (cutoff)
const NQ_POINT_VALUE = 20; // $/pt for NQ full-size

// Param grid (Sharpe/PF/etc computed per-combo)
const STOP_GRID = [25, 40, 60, 80];
const TARGET_GRID = [25, 50, 75, 100, 150];
// Time stops: minutes from entry (Infinity = only force-flat at 11:00 ET cutoff)
const TIME_STOP_GRID = [
  { name: '30m',  minutes: 30 },
  { name: '60m',  minutes: 60 },
  { name: '90m',  minutes: 90 },
  { name: 'EOD',  minutes: Infinity }  // governed by 11:00 ET force-flat
];

// --- Helpers ---
function loadRolloverDates() {
  const csv = fs.readFileSync(path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_rollover_log.csv'), 'utf-8');
  const lines = csv.trim().split('\n').slice(1);
  return new Set(lines.map(l => l.split(',')[0]));
}

function groupByDate(candles) {
  const byDate = new Map();
  for (const c of candles) {
    const et = toET(c.timestamp);
    const k = et.date;
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push({ ...c, etMin: et.timeInMinutes, etDow: et.dayOfWeek });
  }
  for (const arr of byDate.values()) arr.sort((a, b) => a.timestamp - b.timestamp);
  return byDate;
}

function getAsianRange(candlesByDate, dateStr) {
  // Asian = prev day 19:00 ET → today 03:00 ET
  const [year, month, day] = dateStr.split('-').map(Number);
  const prevDate = new Date(Date.UTC(year, month - 1, day));
  prevDate.setUTCDate(prevDate.getUTCDate() - 1);
  const prevStr = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, '0')}-${String(prevDate.getUTCDate()).padStart(2, '0')}`;

  const prevCandles = (candlesByDate.get(prevStr) || []).filter(c => c.etMin >= ASIAN_START_HOUR_ET * 60);
  const todayCandles = (candlesByDate.get(dateStr) || []).filter(c => c.etMin < ASIAN_END_HOUR_ET * 60);
  const asian = [...prevCandles, ...todayCandles];
  if (asian.length < 5) return null;

  const high = Math.max(...asian.map(c => c.high));
  const low = Math.min(...asian.map(c => c.low));
  return { high, low, range: high - low, count: asian.length };
}

/**
 * Walk candles from sweep window start through the post-sweep reclaim, find
 * the first valid reversal entry. Returns null if no entry materializes by
 * 10:30 ET (gives 30min after sweep window for reclaim).
 *
 * Algorithm:
 *  1. Within 7:30-10:00 ET, scan for first bar that touches/breaches Asian
 *     high (high sweep) or Asian low (low sweep). Call this sweep_idx.
 *  2. After sweep_idx, scan forward for the first 1m bar whose CLOSE is back
 *     INSIDE the swept range (close < asianHigh - TOUCH for high sweep, close
 *     > asianLow + TOUCH for low sweep). Allow up to 30min after sweep
 *     window end to reclaim.
 *  3. Entry = next bar OPEN after the reclaim bar. Direction = reversal
 *     (high sweep → SHORT, low sweep → LONG).
 *  4. Entry timestamp must be ≥ 9:30 ET. If reclaim happens before 9:30 ET,
 *     defer entry to the 9:30 open.
 */
function findReversalEntry(dayCandles, asianHigh, asianLow) {
  // candles sorted by timestamp; only those between 00:00 and 12:00 ET matter
  // Sweep candidates: first bar in 7:30-10:00 ET that hits a side
  let sweepIdx = -1;
  let sweepSide = null;
  let sweepBar = null;

  for (let i = 0; i < dayCandles.length; i++) {
    const c = dayCandles[i];
    if (c.etMin < SWEEP_WINDOW_START_MIN) continue;
    if (c.etMin >= SWEEP_WINDOW_END_MIN) break;
    const hitHigh = c.high >= asianHigh - TOUCH_THRESHOLD;
    const hitLow = c.low <= asianLow + TOUCH_THRESHOLD;
    if (hitHigh || hitLow) {
      sweepIdx = i;
      sweepBar = c;
      // If both hit on same bar, pick whichever extreme came first.
      // In 1m we can't disambiguate cleanly: prefer the side closest to the
      // OPEN since price tends to move away from open first.
      if (hitHigh && hitLow) {
        sweepSide = Math.abs(asianHigh - c.open) < Math.abs(asianLow - c.open) ? 'high' : 'low';
      } else {
        sweepSide = hitHigh ? 'high' : 'low';
      }
      break;
    }
  }

  if (sweepIdx === -1) return null;

  // Find first bar after sweep that closes back inside (reclaim).
  // Allow reclaim up to 30 min after sweep window end (so 10:30 ET).
  const reclaimDeadlineMin = SWEEP_WINDOW_END_MIN + 30;
  let reclaimIdx = -1;
  for (let j = sweepIdx + 1; j < dayCandles.length; j++) {
    const c = dayCandles[j];
    if (c.etMin >= reclaimDeadlineMin) break;
    if (sweepSide === 'high' && c.close < asianHigh - TOUCH_THRESHOLD) { reclaimIdx = j; break; }
    if (sweepSide === 'low' && c.close > asianLow + TOUCH_THRESHOLD) { reclaimIdx = j; break; }
  }

  if (reclaimIdx === -1) return null;

  // Entry = next bar open after reclaim
  const nextIdx = reclaimIdx + 1;
  if (nextIdx >= dayCandles.length) return null;
  let entryBar = dayCandles[nextIdx];
  let entryIdx = nextIdx;

  // If entry would land before 9:30 ET, defer to first bar at/after 9:30 ET.
  if (entryBar.etMin < ENTRY_MIN_TIME) {
    let deferredIdx = -1;
    for (let k = nextIdx; k < dayCandles.length; k++) {
      if (dayCandles[k].etMin >= ENTRY_MIN_TIME) { deferredIdx = k; break; }
    }
    if (deferredIdx === -1) return null;
    entryIdx = deferredIdx;
    entryBar = dayCandles[entryIdx];
  }

  // Sanity: entry must be ≤ 11:00 ET cutoff (otherwise no point)
  if (entryBar.etMin >= FORCE_FLAT_MIN) return null;

  return {
    sweepIdx, sweepSide, sweepBar,
    reclaimIdx,
    entryIdx,
    entryBar,
    entryPrice: entryBar.open,
    direction: sweepSide === 'high' ? -1 : 1,  // -1 = SHORT, +1 = LONG
    asianHigh, asianLow
  };
}

/**
 * Walk forward from entry bar, return MFE/MAE and the time series of
 * (offsetMin, high, low, close) for the simulation step. Walks until 11:00 ET.
 */
function buildPath(dayCandles, entry) {
  const out = [];
  for (let i = entry.entryIdx; i < dayCandles.length; i++) {
    const c = dayCandles[i];
    if (c.etMin >= FORCE_FLAT_MIN) break;
    const offsetMin = Math.round((c.timestamp - entry.entryBar.timestamp) / 60000);
    out.push({ offsetMin, etMin: c.etMin, high: c.high, low: c.low, close: c.close, open: c.open });
  }
  return out;
}

function computeMFEMAE(path, entry) {
  let mfe = 0, mae = 0;
  let timeToMFE = null;
  for (const p of path) {
    if (p.offsetMin === 0) continue; // skip entry bar's own OHLC for excursion math
    const moveH = (p.high - entry.entryPrice) * entry.direction;
    const moveL = (p.low - entry.entryPrice) * entry.direction;
    const localMax = Math.max(moveH, moveL);
    const localMin = Math.min(moveH, moveL);
    if (localMax > mfe) { mfe = localMax; timeToMFE = p.offsetMin; }
    if (localMin < mae) { mae = localMin; }
  }
  return { mfe: round(mfe, 2), mae: round(Math.abs(mae), 2), timeToMFE };
}

/**
 * Simulate exit with stop/target/time-stop. Returns { exitPx, exitOffsetMin,
 * exitReason, pnlPts }.
 *
 * Order check per bar (conservative): stop checked first, then target, then
 * time-stop, then end-of-window (force-flat 11:00 ET).
 */
function simulateExit(path, entry, stopPts, targetPts, timeStopMin) {
  // Bracket levels (in PRICE space, not pts)
  const stopPx = entry.entryPrice - entry.direction * stopPts;
  const targetPx = entry.entryPrice + entry.direction * targetPts;

  for (const p of path) {
    if (p.offsetMin === 0) continue; // entry bar — assume no fill on entry bar itself
    // Check stop first (worst case for the trade)
    if (entry.direction === 1) {
      // LONG: stop hit if low <= stopPx
      if (p.low <= stopPx) {
        return { exitPx: stopPx, exitOffsetMin: p.offsetMin, exitReason: 'stop', pnlPts: -stopPts };
      }
      if (p.high >= targetPx) {
        return { exitPx: targetPx, exitOffsetMin: p.offsetMin, exitReason: 'target', pnlPts: targetPts };
      }
    } else {
      // SHORT: stop hit if high >= stopPx
      if (p.high >= stopPx) {
        return { exitPx: stopPx, exitOffsetMin: p.offsetMin, exitReason: 'stop', pnlPts: -stopPts };
      }
      if (p.low <= targetPx) {
        return { exitPx: targetPx, exitOffsetMin: p.offsetMin, exitReason: 'target', pnlPts: targetPts };
      }
    }
    // Time stop
    if (p.offsetMin >= timeStopMin) {
      const pnl = (p.close - entry.entryPrice) * entry.direction;
      return { exitPx: p.close, exitOffsetMin: p.offsetMin, exitReason: 'time_stop', pnlPts: round(pnl, 2) };
    }
  }
  // Force flat at 11:00 ET — last bar in path
  if (path.length > 0) {
    const last = path[path.length - 1];
    const pnl = (last.close - entry.entryPrice) * entry.direction;
    return { exitPx: last.close, exitOffsetMin: last.offsetMin, exitReason: 'eod_force_flat', pnlPts: round(pnl, 2) };
  }
  return { exitPx: entry.entryPrice, exitOffsetMin: 0, exitReason: 'no_data', pnlPts: 0 };
}

/**
 * Equity curve metrics: PF, Sharpe (using per-trade returns, daily-style),
 * Max DD on cumulative $ curve.
 */
function computeMetrics(pnlsDollars) {
  if (pnlsDollars.length === 0) {
    return { trades: 0, winRate: 0, avgPnl: 0, totalPnl: 0, pf: 0, sharpe: 0, maxDD: 0, maxDDpct: 0 };
  }
  const wins = pnlsDollars.filter(p => p > 0);
  const losses = pnlsDollars.filter(p => p < 0);
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const total = pnlsDollars.reduce((s, p) => s + p, 0);
  const avg = total / pnlsDollars.length;
  const variance = pnlsDollars.reduce((s, p) => s + (p - avg) ** 2, 0) / pnlsDollars.length;
  const std = Math.sqrt(variance);
  // Annualized Sharpe: ~252 trade-days/yr; this study is ≤1 trade/day
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  // Max DD on cumulative curve
  let peak = 0, equity = 0, maxDD = 0;
  for (const p of pnlsDollars) {
    equity += p;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDDpct = peak > 0 ? (maxDD / peak) * 100 : 0;

  return {
    trades: pnlsDollars.length,
    winRate: round(wins.length / pnlsDollars.length * 100, 2),
    avgPnl: round(avg, 2),
    totalPnl: round(total, 2),
    pf: pf === Infinity ? 999 : round(pf, 2),
    sharpe: round(sharpe, 2),
    maxDD: round(maxDD, 2),
    maxDDpct: round(maxDDpct, 2)
  };
}

// --- Main ---
(async () => {
  console.log('=== T1: Sweep + RTH-Timed Reversal Entry ===\n');
  console.log(`Date range: ${START_DATE} → ${END_DATE} (OOS from ${OOS_START})\n`);

  const rolloverDates = loadRolloverDates();
  console.log(`Rollover dates loaded: ${rolloverDates.size}\n`);

  console.log('Loading NQ 1m raw OHLCV...');
  const loader = new CSVLoader(DATA_DIR, CONFIG, { noContinuous: true });
  const { candles } = await loader.loadOHLCVData('NQ', new Date(START_DATE), new Date(END_DATE + 'T23:59:59Z'));
  console.log(`  ${candles.length.toLocaleString()} candles after primary-contract filter\n`);

  console.log('Grouping by ET date...');
  const byDate = groupByDate(candles);
  const dates = Array.from(byDate.keys()).sort().filter(d => d >= START_DATE && d <= END_DATE);
  console.log(`  ${dates.length} unique dates\n`);

  // --- Build trade list (entries + paths + MFE/MAE) ---
  const trades = [];
  let skipped = { rollover: 0, no_asian: 0, asian_too_tight: 0, no_sweep: 0, no_reclaim: 0 };

  for (const dateStr of dates) {
    if (rolloverDates.has(dateStr)) { skipped.rollover++; continue; }
    const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
    if (dow === 0 || dow === 6) continue;

    // For Asian range, also skip if PREVIOUS day was a rollover
    const [yy, mm, dd] = dateStr.split('-').map(Number);
    const prev = new Date(Date.UTC(yy, mm - 1, dd));
    prev.setUTCDate(prev.getUTCDate() - 1);
    const prevStr = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
    if (rolloverDates.has(prevStr)) { skipped.rollover++; continue; }

    const range = getAsianRange(byDate, dateStr);
    if (!range) { skipped.no_asian++; continue; }
    if (range.range < 10) { skipped.asian_too_tight++; continue; } // skip flat nights

    // Day candles relevant to scan: 00:00 ET → 12:00 ET (etMin < 720)
    const dayCandles = (byDate.get(dateStr) || []).filter(c => c.etMin < 720);
    if (dayCandles.length === 0) continue;

    const entry = findReversalEntry(dayCandles, range.high, range.low);
    if (!entry) {
      // Decide bucket: did we have a sweep at all?
      let hadSweep = false;
      for (const c of dayCandles) {
        if (c.etMin < SWEEP_WINDOW_START_MIN || c.etMin >= SWEEP_WINDOW_END_MIN) continue;
        if (c.high >= range.high - TOUCH_THRESHOLD || c.low <= range.low + TOUCH_THRESHOLD) { hadSweep = true; break; }
      }
      if (!hadSweep) skipped.no_sweep++;
      else skipped.no_reclaim++;
      continue;
    }

    const path = buildPath(dayCandles, entry);
    if (path.length < 2) continue;

    const mfeMae = computeMFEMAE(path, entry);
    const minutesToFlat = Math.max(0, FORCE_FLAT_MIN - entry.entryBar.etMin);

    trades.push({
      date: dateStr,
      sweepSide: entry.sweepSide,
      direction: entry.direction === 1 ? 'long' : 'short',
      asianHigh: round(range.high, 2),
      asianLow: round(range.low, 2),
      asianRange: round(range.range, 2),
      sweepEtMin: entry.sweepBar.etMin,
      reclaimEtMin: path[0].etMin,
      entryEtMin: entry.entryBar.etMin,
      entryPrice: round(entry.entryPrice, 2),
      symbol: entry.entryBar.symbol,
      mfe: mfeMae.mfe,
      mae: mfeMae.mae,
      timeToMFE: mfeMae.timeToMFE,
      timeBudgetMin: minutesToFlat,
      path  // will simulate against this in grid
    });
  }

  console.log(`Trades built: ${trades.length}`);
  console.log(`  Skipped — rollover days: ${skipped.rollover}`);
  console.log(`  Skipped — no Asian session: ${skipped.no_asian}`);
  console.log(`  Skipped — Asian range < 10pts: ${skipped.asian_too_tight}`);
  console.log(`  Skipped — no sweep in 7:30-10:00 ET: ${skipped.no_sweep}`);
  console.log(`  Skipped — sweep but no reclaim: ${skipped.no_reclaim}\n`);

  // --- Aggregate descriptive stats ---
  const reversedCount = trades.filter(t => t.mfe >= t.mae).length;
  const baseReversalRate = round(reversedCount / trades.length * 100, 2);
  const mfePcts = calculatePercentiles(trades.map(t => t.mfe), [25, 50, 75, 90]);
  const maePcts = calculatePercentiles(trades.map(t => t.mae), [25, 50, 75, 90]);
  const ttMfeArr = trades.map(t => t.timeToMFE).filter(x => x !== null && x !== undefined);
  const ttMfePcts = calculatePercentiles(ttMfeArr, [25, 50, 75, 90]);

  console.log(`Descriptive stats (all ${trades.length} trades):`);
  console.log(`  Base "reversal-favorable" rate (MFE >= MAE): ${baseReversalRate}%`);
  console.log(`  MFE p25/p50/p75/p90: ${mfePcts.p25}/${mfePcts.p50}/${mfePcts.p75}/${mfePcts.p90} pts`);
  console.log(`  MAE p25/p50/p75/p90: ${maePcts.p25}/${maePcts.p50}/${maePcts.p75}/${maePcts.p90} pts`);
  console.log(`  TimeToMFE p25/p50/p75/p90: ${ttMfePcts.p25}/${ttMfePcts.p50}/${ttMfePcts.p75}/${ttMfePcts.p90} min\n`);

  // --- IS / OOS split ---
  const isTrades = trades.filter(t => t.date < OOS_START);
  const oosTrades = trades.filter(t => t.date >= OOS_START);
  console.log(`IS: ${isTrades.length} trades | OOS: ${oosTrades.length} trades\n`);

  // --- Param grid ---
  console.log('Running param grid...');
  const gridResults = [];

  for (const stop of STOP_GRID) {
    for (const tgt of TARGET_GRID) {
      for (const ts of TIME_STOP_GRID) {
        const all = trades.map(t => simulateExit(t.path, {
          entryPrice: t.entryPrice, direction: t.direction === 'long' ? 1 : -1
        }, stop, tgt, ts.minutes));
        const isExits = isTrades.map(t => simulateExit(t.path, {
          entryPrice: t.entryPrice, direction: t.direction === 'long' ? 1 : -1
        }, stop, tgt, ts.minutes));
        const oosExits = oosTrades.map(t => simulateExit(t.path, {
          entryPrice: t.entryPrice, direction: t.direction === 'long' ? 1 : -1
        }, stop, tgt, ts.minutes));

        const allDollars = all.map(e => e.pnlPts * NQ_POINT_VALUE);
        const isDollars = isExits.map(e => e.pnlPts * NQ_POINT_VALUE);
        const oosDollars = oosExits.map(e => e.pnlPts * NQ_POINT_VALUE);

        gridResults.push({
          stop, target: tgt, timeStop: ts.name,
          all: computeMetrics(allDollars),
          is: computeMetrics(isDollars),
          oos: computeMetrics(oosDollars),
        });
      }
    }
  }

  // Sort by IS Sharpe (require min trade count to qualify)
  const MIN_TRADES = Math.max(50, Math.floor(isTrades.length * 0.5));
  const qualified = gridResults.filter(r => r.is.trades >= MIN_TRADES);
  qualified.sort((a, b) => b.is.sharpe - a.is.sharpe);
  const topByIsSharpe = qualified.slice(0, 5);

  // Also pick top by OOS Sharpe to sanity-check
  const oosQualified = [...gridResults].filter(r => r.oos.trades >= 10);
  oosQualified.sort((a, b) => b.oos.sharpe - a.oos.sharpe);
  const topByOosSharpe = oosQualified.slice(0, 5);

  console.log('\nTop 5 by IS Sharpe (min ' + MIN_TRADES + ' IS trades):');
  for (const r of topByIsSharpe) {
    console.log(`  stop=${r.stop} tgt=${r.target} ts=${r.timeStop}: ` +
      `IS PF=${r.is.pf} Sharpe=${r.is.sharpe} WR=${r.is.winRate}% PnL=$${r.is.totalPnl} DD=${r.is.maxDDpct}% n=${r.is.trades} | ` +
      `OOS PF=${r.oos.pf} Sharpe=${r.oos.sharpe} PnL=$${r.oos.totalPnl} n=${r.oos.trades}`);
  }

  console.log('\nTop 5 by OOS Sharpe:');
  for (const r of topByOosSharpe) {
    console.log(`  stop=${r.stop} tgt=${r.target} ts=${r.timeStop}: ` +
      `OOS PF=${r.oos.pf} Sharpe=${r.oos.sharpe} WR=${r.oos.winRate}% PnL=$${r.oos.totalPnl} DD=${r.oos.maxDDpct}% n=${r.oos.trades}`);
  }

  // --- Write outputs ---
  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Strip path arrays from trades for serialization
  const tradesSerializable = trades.map(t => ({ ...t, path: undefined }));

  const out = {
    study: 'T1: Sweep + RTH-Timed Reversal Entry',
    timestamp: new Date().toISOString(),
    dateRange: { start: START_DATE, end: END_DATE, oosStart: OOS_START },
    constants: {
      touchThreshold: TOUCH_THRESHOLD,
      sweepWindowET: '07:30-10:00',
      entryMinET: '09:30',
      forceFlatET: '11:00',
      nqPointValue: NQ_POINT_VALUE
    },
    skipped,
    summary: {
      tradesBuilt: trades.length,
      isTrades: isTrades.length,
      oosTrades: oosTrades.length,
      baseReversalRate,
      mfePcts, maePcts, timeToMFEpcts: ttMfePcts,
      avgMFE: round(trades.reduce((s, t) => s + t.mfe, 0) / Math.max(1, trades.length), 2),
      avgMAE: round(trades.reduce((s, t) => s + t.mae, 0) / Math.max(1, trades.length), 2),
      sweepSideMix: {
        high: trades.filter(t => t.sweepSide === 'high').length,
        low: trades.filter(t => t.sweepSide === 'low').length
      }
    },
    grid: gridResults,
    topByIsSharpe,
    topByOosSharpe,
    trades: tradesSerializable
  };

  const outPath = path.join(outDir, 'T1-sweep-rth-reversal.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nResults saved to ${outPath}`);
  console.log('Done.');
})();
