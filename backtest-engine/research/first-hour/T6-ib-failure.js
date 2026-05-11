#!/usr/bin/env node
/**
 * T6 — Initial Balance Failure Reversal (NQ)
 *
 * Hypothesis:
 *   Initial Balance (IB) = high/low of first 60m of RTH (9:30-10:30 ET).
 *   When price extends beyond IB after 10:30 and then RE-ENTERS the IB range
 *   within 30 min, fade the failed extension toward the opposite IB extreme.
 *   Conditional on confluence (GEX wall touched, IV percentile, gap alignment,
 *   regime), base rate should clear 50%.
 *
 * Note: this strategy structurally fires at 10:30+ — entries land between
 * 10:30 and ~11:30 ET (failed extension within 30m). Past the user's 11:00
 * default cutoff. Track reports BOTH a strict 11:00 variant and a relaxed
 * 11:30 variant.
 *
 * Hard rules:
 *   - raw contracts via filterPrimaryContract
 *   - skip rollover boundary days
 *   - all windowing in ET
 *   - GEX from data/gex/nq-cbbo (post-bucketing-fix)
 *   - 2025-01-13 -> 2026-04-23, hold last 2 months OOS
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
const IV_PATH       = path.join(REPO_ROOT, 'data', 'iv', 'qqq', 'qqq_atm_iv_1m.csv');
const OUTPUT_PATH   = path.join(__dirname, 'output', 'T6-ib-failure.json');

const START_DATE   = '2025-01-13';
const END_DATE     = '2026-04-23';
const OOS_START    = '2026-02-23'; // last ~2 months held out

const IB_START_MIN  = 570;  // 9:30
const IB_END_MIN    = 630;  // 10:30
const REENTRY_WIN_M = 30;   // 30 min for failed-extension re-entry
const HARD_CUTOFF_M = 16 * 60 + 0; // 16:00 ET — exit any open trade
const STRICT_ENTRY_CUTOFF_M = 11 * 60;       // strict 11:00 variant
const RELAXED_ENTRY_CUTOFF_M = 11 * 60 + 30; // relaxed 11:30 variant

const STOPS_PTS   = [15, 25, 40, 60];
const TIME_STOPS  = [30, 60, 90, /* 14:00 fallback */ 14 * 60];
const GEX_TOUCH_PROX_PTS = 10;

// -------------------- helpers --------------------

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
    p25: round(pct(sorted, 25), 2),
    median: round(pct(sorted, 50), 2),
    mean: round(sum / sorted.length, 2),
    p75: round(pct(sorted, 75), 2),
    p90: round(pct(sorted, 90), 2),
    p99: round(pct(sorted, 99), 2),
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
  const n = arr.filter(v => v >= threshold).length;
  return n / arr.length;
}

// -------------------- data load --------------------

async function loadRawNqMinute(startDate, endDate) {
  console.log(`Loading raw NQ 1m candles ${startDate} -> ${endDate}...`);
  const start = new Date(startDate + 'T00:00:00Z').getTime();
  const end   = new Date(endDate   + 'T23:59:59Z').getTime();
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

async function loadIVSeries() {
  console.log(`Loading QQQ 1m ATM IV series...`);
  // Returns: dateStr -> Map<utcMs, ivRow{ iv, dte }>
  // Plus: dailyIV9_30 -> Map<dateStr, iv> for percentile compute
  const byDate = new Map();
  await new Promise((resolve, reject) => {
    fs.createReadStream(IV_PATH)
      .pipe(csv())
      .on('data', (row) => {
        const ts = new Date(row.timestamp).getTime();
        if (isNaN(ts)) return;
        const iv = parseFloat(row.iv);
        if (isNaN(iv)) return;
        const et = toET(ts);
        if (!byDate.has(et.date)) byDate.set(et.date, []);
        byDate.get(et.date).push({ ts, iv, et });
      })
      .on('end', resolve)
      .on('error', reject);
  });
  // Compute 9:30 IV per date
  const dailyIV930 = new Map();
  for (const [d, rows] of byDate) {
    rows.sort((a, b) => a.ts - b.ts);
    // Find first row at or after 9:30 ET
    const r = rows.find(x => x.et.timeInMinutes >= 570);
    if (r) dailyIV930.set(d, r.iv);
  }
  console.log(`  IV days loaded: ${byDate.size}, with 9:30 reading: ${dailyIV930.size}`);
  return { byDate, dailyIV930 };
}

function rollingPercentile(orderedDates, dailyIV930, asOfDate, lookback = 30) {
  // Returns IV percentile (0..1) of asOfDate IV vs prior `lookback` trading days
  const idx = orderedDates.indexOf(asOfDate);
  if (idx < lookback) return null;
  const today = dailyIV930.get(asOfDate);
  if (today == null || isNaN(today)) return null;
  const window = [];
  for (let j = idx - lookback; j < idx; j++) {
    const v = dailyIV930.get(orderedDates[j]);
    if (v != null && !isNaN(v)) window.push(v);
  }
  if (window.length < lookback / 2) return null;
  const lessOrEq = window.filter(v => v <= today).length;
  return lessOrEq / window.length;
}

// -------------------- session bucketing --------------------

function bucketByDay(candles) {
  const byDate = new Map();
  for (const c of candles) {
    const et = toET(c.timestamp);
    if (et.dayOfWeek === 0 || et.dayOfWeek === 6) continue;
    if (!byDate.has(et.date)) byDate.set(et.date, []);
    byDate.get(et.date).push({ ...c, et });
  }
  // Ensure each day's candles are sorted by ts
  for (const arr of byDate.values()) arr.sort((a, b) => a.timestamp - b.timestamp);
  return byDate;
}

function gapBucket(gapPct) {
  if (gapPct >  0.004) return 'gap_up_strong';
  if (gapPct >  0.001) return 'gap_up_mild';
  if (gapPct < -0.004) return 'gap_down_strong';
  if (gapPct < -0.001) return 'gap_down_mild';
  return 'flat';
}

// -------------------- per-day IB-failure detection --------------------

/**
 * For one trading day, compute:
 *   - IB high/low (9:30-10:30 ET)
 *   - First IB extension after 10:30 (1m close beyond IB H or L)
 *   - Failed extension if price re-enters IB within 30 min (1m close back inside)
 *   - Trade simulation across stop/target/time-stop grid
 */
function processDay(dateStr, dayCandles, prevRthClose, gex9_30Snap, dailyIV930ForDate, ivPct, isOOS) {
  // RTH = 9:30-16:00
  const rth = dayCandles.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes < 960);
  if (rth.length < 90) return null;

  const openCandle = rth.find(c => c.et.timeInMinutes === 570);
  if (!openCandle) return null;
  const open930 = openCandle.open;

  // IB: 9:30 - 10:30 (570..629 inclusive)
  const ibCandles = rth.filter(c => c.et.timeInMinutes >= IB_START_MIN && c.et.timeInMinutes < IB_END_MIN);
  if (ibCandles.length < 50) return null;
  const ibHigh = Math.max(...ibCandles.map(c => c.high));
  const ibLow  = Math.min(...ibCandles.map(c => c.low));
  const ibMid  = (ibHigh + ibLow) / 2;
  const ibRange = ibHigh - ibLow;

  // Post-IB: minutes 630..959
  const postIB = rth.filter(c => c.et.timeInMinutes >= IB_END_MIN);
  if (postIB.length < 60) return null;

  // Find first IB extension after 10:30: 1m CLOSE beyond IB H or L
  let extension = null;
  for (let i = 0; i < postIB.length; i++) {
    const c = postIB[i];
    if (c.close > ibHigh) {
      extension = { side: 'high', extensionPx: c.close, candle: c, idx: i };
      break;
    }
    if (c.close < ibLow) {
      extension = { side: 'low', extensionPx: c.close, candle: c, idx: i };
      break;
    }
  }
  if (!extension) {
    return { dateStr, hadExtension: false, ibHigh, ibLow, ibMid, ibRange, isOOS };
  }

  const extDistance = extension.side === 'high'
    ? extension.extensionPx - ibHigh
    : ibLow - extension.extensionPx;

  // Did price re-enter IB within 30 min of extension? (close back inside IB range)
  const reentryWindow = postIB.slice(extension.idx + 1, extension.idx + 1 + REENTRY_WIN_M);
  let reentry = null;
  for (let i = 0; i < reentryWindow.length; i++) {
    const c = reentryWindow[i];
    const insideIB = (c.close <= ibHigh && c.close >= ibLow);
    if (insideIB) {
      reentry = { candle: c, idx: extension.idx + 1 + i, minutesAfterExt: i + 1 };
      break;
    }
  }

  if (!reentry) {
    return {
      dateStr, hadExtension: true, hadFailedExt: false,
      extension: { side: extension.side, extDistance, etTimeMin: extension.candle.et.timeInMinutes },
      ibHigh, ibLow, ibMid, ibRange, isOOS
    };
  }

  // FAILED EXTENSION CONFIRMED.
  // Entry = re-entry bar close. Side: opposite of extension direction.
  //   If extension was HIGH (broke high then re-entered), we SHORT (toward IB low).
  //   If extension was LOW  (broke low  then re-entered), we LONG  (toward IB high).
  const side = extension.side === 'high' ? 'short' : 'long';
  const entryPx = reentry.candle.close;
  const entryEtMin = reentry.candle.et.timeInMinutes;
  const entryIdx = reentry.idx;

  // -------------------- Confluence features --------------------

  // GEX wall touch on the EXTENSION bar (within GEX_TOUCH_PROX_PTS of any GEX support/resistance)
  let touchedWall = false;
  let touchedWallType = null; // 'callWall'|'putWall'|'gammaFlip'|'support'|'resistance'
  let nearestWallDist = null;
  let regime = null;
  if (gex9_30Snap) {
    regime = gex9_30Snap.regime;
    const checks = [];
    if (gex9_30Snap.call_wall != null) checks.push({ name: 'callWall', px: gex9_30Snap.call_wall });
    if (gex9_30Snap.put_wall  != null) checks.push({ name: 'putWall',  px: gex9_30Snap.put_wall  });
    if (gex9_30Snap.gamma_flip != null) checks.push({ name: 'gammaFlip', px: gex9_30Snap.gamma_flip });
    if (Array.isArray(gex9_30Snap.support)) {
      gex9_30Snap.support.forEach(p => { if (p != null) checks.push({ name: 'support', px: p }); });
    }
    if (Array.isArray(gex9_30Snap.resistance)) {
      gex9_30Snap.resistance.forEach(p => { if (p != null) checks.push({ name: 'resistance', px: p }); });
    }
    let bestDist = Infinity;
    for (const c of checks) {
      const d = Math.abs(extension.extensionPx - c.px);
      if (d < bestDist) { bestDist = d; touchedWallType = c.name; }
    }
    nearestWallDist = bestDist === Infinity ? null : round(bestDist, 2);
    touchedWall = bestDist !== Infinity && bestDist <= GEX_TOUCH_PROX_PTS;
  }

  // Gap alignment: gap_up + extension_low (failed downside push) is "against" the gap
  // We're trading toward opposite IB extreme. Aligned gap = gap pushes us toward target.
  // - Side 'long' (failed low extension): gap aligned if gap UP
  // - Side 'short' (failed high extension): gap aligned if gap DOWN
  const gapPts = open930 - prevRthClose;
  const gapPct = gapPts / prevRthClose;
  const gapBkt = gapBucket(gapPct);
  const gapAligned = (side === 'long' && gapPts > 0) || (side === 'short' && gapPts < 0);

  // -------------------- Forward MFE/MAE in trade direction --------------------

  // Slice from entry+1 bar onward (the entry bar itself is the close where we filled)
  const fwd = postIB.slice(entryIdx + 1);
  if (fwd.length === 0) return {
    dateStr, hadExtension: true, hadFailedExt: true, executed: false,
    isOOS
  };

  // Targets:
  //   T_oppIB: opposite IB extreme (LONG -> ibHigh, SHORT -> ibLow)
  //   T_mid:   IB midpoint
  //   T_fixed: 30/50/75/100
  const oppIB = side === 'long' ? ibHigh : ibLow;
  const targetOppIBpts = side === 'long' ? (ibHigh - entryPx) : (entryPx - ibLow);
  const targetMidPts   = side === 'long' ? (ibMid  - entryPx) : (entryPx - ibMid );

  // MFE/MAE in direction of trade
  let mfePts = -Infinity, maePts = -Infinity;
  let tToMfe = null, tToMae = null;
  for (let i = 0; i < fwd.length; i++) {
    const c = fwd[i];
    const upMove = side === 'long' ? c.high - entryPx : entryPx - c.low;
    const dnMove = side === 'long' ? entryPx - c.low  : c.high - entryPx;
    if (upMove > mfePts) { mfePts = upMove; tToMfe = i + 1; }
    if (dnMove > maePts) { maePts = dnMove; tToMae = i + 1; }
  }

  // -------------------- Grid simulation --------------------

  const grid = [];
  const targetSpecs = [
    { name: 'oppIB', pts: targetOppIBpts },
    { name: 'mid',   pts: targetMidPts },
    { name: 'fix30', pts: 30 },
    { name: 'fix50', pts: 50 },
    { name: 'fix75', pts: 75 },
    { name: 'fix100', pts: 100 }
  ].filter(t => t.pts > 0); // skip non-positive (entry already past target)

  for (const stopPts of STOPS_PTS) {
    for (const tgt of targetSpecs) {
      for (const tStop of TIME_STOPS) {
        // tStop in MINUTES; if tStop > 12*60, treat it as ET-cutoff time (flat at 14:00)
        const useEtCutoff = tStop >= 12 * 60;
        const exitByEtMin = useEtCutoff ? tStop : null;
        const maxBars     = useEtCutoff ? null : tStop;

        let outcome = 'time'; // 'tp' | 'sl' | 'time' | 'eod'
        let exitPx = entryPx;
        let exitBar = -1;
        for (let i = 0; i < fwd.length; i++) {
          const c = fwd[i];
          const minSinceEntry = i + 1;

          // EOD hard cutoff at 16:00
          if (c.et.timeInMinutes >= HARD_CUTOFF_M) {
            outcome = 'eod';
            exitPx = c.open;
            exitBar = i;
            break;
          }
          if (exitByEtMin != null && c.et.timeInMinutes >= exitByEtMin) {
            outcome = 'time';
            exitPx = c.open;
            exitBar = i;
            break;
          }
          if (maxBars != null && minSinceEntry > maxBars) {
            outcome = 'time';
            exitPx = c.open;
            exitBar = i;
            break;
          }

          // Stop & target check (bar-level, conservative: stop wins ties)
          if (side === 'long') {
            const stopHit = c.low <= entryPx - stopPts;
            const tgtHit  = c.high >= entryPx + tgt.pts;
            if (stopHit && tgtHit) { outcome = 'sl'; exitPx = entryPx - stopPts; exitBar = i; break; }
            if (stopHit) { outcome = 'sl'; exitPx = entryPx - stopPts; exitBar = i; break; }
            if (tgtHit)  { outcome = 'tp'; exitPx = entryPx + tgt.pts; exitBar = i; break; }
          } else {
            const stopHit = c.high >= entryPx + stopPts;
            const tgtHit  = c.low  <= entryPx - tgt.pts;
            if (stopHit && tgtHit) { outcome = 'sl'; exitPx = entryPx + stopPts; exitBar = i; break; }
            if (stopHit) { outcome = 'sl'; exitPx = entryPx + stopPts; exitBar = i; break; }
            if (tgtHit)  { outcome = 'tp'; exitPx = entryPx - tgt.pts; exitBar = i; break; }
          }
        }
        if (exitBar === -1) {
          // Reached end of session bars without hit/timeout — exit at last close
          const last = fwd[fwd.length - 1];
          exitPx = last.close;
          outcome = 'eod';
          exitBar = fwd.length - 1;
        }

        const pnlPts = side === 'long' ? exitPx - entryPx : entryPx - exitPx;
        grid.push({
          stopPts,
          target: tgt.name,
          targetPts: round(tgt.pts, 2),
          tStop,
          outcome,
          exitBar,
          pnlPts: round(pnlPts, 2)
        });
      }
    }
  }

  return {
    dateStr,
    isOOS,
    hadExtension: true,
    hadFailedExt: true,
    executed: true,
    side,
    open930,
    prevRthClose,
    gapPts: round(gapPts, 2),
    gapPct: round(gapPct, 5),
    gapBkt,
    gapAligned,
    ibHigh,
    ibLow,
    ibMid,
    ibRange: round(ibRange, 2),
    extensionSide: extension.side,
    extensionPx: extension.extensionPx,
    extensionEtMin: extension.candle.et.timeInMinutes,
    extDistance: round(extDistance, 2),
    reentryEtMin: reentry.candle.et.timeInMinutes,
    minutesExtToReentry: reentry.minutesAfterExt,
    entryEtMin,
    entryPx: round(entryPx, 2),
    targetOppIBpts: round(targetOppIBpts, 2),
    targetMidPts: round(targetMidPts, 2),
    mfePts: round(mfePts, 2),
    maePts: round(maePts, 2),
    tToMfeMin: tToMfe,
    tToMaeMin: tToMae,
    // confluence
    touchedWall,
    touchedWallType,
    nearestWallDistPts: nearestWallDist,
    regime,
    iv9_30: dailyIV930ForDate != null ? round(dailyIV930ForDate, 4) : null,
    ivPct,
    grid
  };
}

// -------------------- aggregations --------------------

function pickWinningGrid(trades, opts = {}) {
  // Aggregate per (stopPts, target, tStop) -> { n, winRate, sumPts, avgPts, expectancy }
  const agg = new Map();
  for (const t of trades) {
    if (!t.executed) continue;
    if (opts.entryCutoffMin != null && t.entryEtMin > opts.entryCutoffMin) continue;
    if (opts.touchedWallOnly && !t.touchedWall) continue;
    if (opts.gapAlignedOnly && !t.gapAligned) continue;
    if (opts.minIvPct != null && (t.ivPct == null || t.ivPct < opts.minIvPct)) continue;
    if (opts.maxIvPct != null && (t.ivPct == null || t.ivPct > opts.maxIvPct)) continue;
    if (opts.regimeBlocklist && opts.regimeBlocklist.includes(t.regime)) continue;
    if (opts.minExtDistance != null && t.extDistance < opts.minExtDistance) continue;
    if (opts.isOOS != null && t.isOOS !== opts.isOOS) continue;

    for (const g of t.grid) {
      const key = `s${g.stopPts}_t${g.target}_h${g.tStop}`;
      if (!agg.has(key)) agg.set(key, {
        stopPts: g.stopPts, target: g.target, tStop: g.tStop,
        n: 0, wins: 0, losses: 0, time: 0, eod: 0,
        sumPts: 0, sumWinPts: 0, sumLossPts: 0,
        nWinPts: 0, nLossPts: 0
      });
      const a = agg.get(key);
      a.n++;
      a.sumPts += g.pnlPts;
      if (g.outcome === 'tp') { a.wins++; a.sumWinPts += g.pnlPts; a.nWinPts++; }
      else if (g.outcome === 'sl') { a.losses++; a.sumLossPts += g.pnlPts; a.nLossPts++; }
      else if (g.outcome === 'time') { a.time++; if (g.pnlPts >= 0) { a.sumWinPts += g.pnlPts; a.nWinPts++; } else { a.sumLossPts += g.pnlPts; a.nLossPts++; } }
      else if (g.outcome === 'eod') { a.eod++; if (g.pnlPts >= 0) { a.sumWinPts += g.pnlPts; a.nWinPts++; } else { a.sumLossPts += g.pnlPts; a.nLossPts++; } }
    }
  }
  const results = [];
  for (const a of agg.values()) {
    const tpRate = a.wins / Math.max(1, a.n);
    const winRate = (a.nWinPts) / Math.max(1, a.n);  // fraction with positive PnL
    const avgPts = a.sumPts / Math.max(1, a.n);
    const avgWin = a.nWinPts > 0 ? a.sumWinPts / a.nWinPts : 0;
    const avgLoss = a.nLossPts > 0 ? a.sumLossPts / a.nLossPts : 0;
    const pf = a.nLossPts > 0 ? Math.abs(a.sumWinPts / a.sumLossPts) : null;
    results.push({
      ...a,
      tpRate: round(tpRate, 4),
      winRate: round(winRate, 4),
      avgPts: round(avgPts, 2),
      avgWin: round(avgWin, 2),
      avgLoss: round(avgLoss, 2),
      pf: pf != null ? round(pf, 3) : null,
      totalPts: round(a.sumPts, 2)
    });
  }
  return results;
}

function topN(grids, n = 5, sortBy = 'totalPts') {
  return [...grids].sort((a, b) => (b[sortBy] ?? -Infinity) - (a[sortBy] ?? -Infinity)).slice(0, n);
}

function condProbBlock(executed, predicate, label) {
  const subset = executed.filter(predicate);
  if (!subset.length) return { label, n: 0 };
  // P(hit opp IB) — we use mfePts >= targetOppIBpts
  const hitsOpp = subset.filter(t => t.mfePts >= t.targetOppIBpts).length;
  const hitsMid = subset.filter(t => t.mfePts >= t.targetMidPts).length;
  const hits30  = subset.filter(t => t.mfePts >= 30).length;
  const hits50  = subset.filter(t => t.mfePts >= 50).length;
  const hits75  = subset.filter(t => t.mfePts >= 75).length;
  const hits100 = subset.filter(t => t.mfePts >= 100).length;
  return {
    label, n: subset.length,
    pHitOppIB: round(hitsOpp / subset.length, 4),
    pHitMid:   round(hitsMid / subset.length, 4),
    pHitMfe30: round(hits30  / subset.length, 4),
    pHitMfe50: round(hits50  / subset.length, 4),
    pHitMfe75: round(hits75  / subset.length, 4),
    pHitMfe100:round(hits100 / subset.length, 4),
    avgMfe: round(subset.reduce((s,t)=>s+t.mfePts,0)/subset.length, 2),
    avgMae: round(subset.reduce((s,t)=>s+t.maePts,0)/subset.length, 2),
    avgTargetOppIB: round(subset.reduce((s,t)=>s+t.targetOppIBpts,0)/subset.length, 2)
  };
}

// -------------------- main --------------------

async function main() {
  const t0 = Date.now();
  console.log('='.repeat(72));
  console.log(' T6 — Initial Balance Failure Reversal (NQ)');
  console.log('='.repeat(72));

  const rolloverDates = loadRolloverDates();
  const candles = await loadRawNqMinute(START_DATE, END_DATE);
  const byDate = bucketByDay(candles);
  const ivData = await loadIVSeries();
  const orderedIVDates = [...ivData.dailyIV930.keys()].sort();

  console.log(`Trading dates seen: ${byDate.size}`);

  const dates = [...byDate.keys()].sort();
  const trades = [];
  let nNoExtension = 0, nNoFailed = 0;
  let nGexMissing = 0;

  for (let i = 0; i < dates.length; i++) {
    const dateStr = dates[i];
    if (dateStr < START_DATE || dateStr > END_DATE) continue;
    if (rolloverDates.has(dateStr)) continue;
    const dayCandles = byDate.get(dateStr);
    if (!dayCandles) continue;

    // prev RTH close
    let prevRthClose = null;
    for (let j = i - 1; j >= Math.max(0, i - 7); j--) {
      const prevDate = dates[j];
      if (rolloverDates.has(prevDate)) continue;
      const prev = byDate.get(prevDate);
      if (!prev) continue;
      const prevRth = prev.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes <= 960);
      if (!prevRth.length) continue;
      prevRthClose = prevRth[prevRth.length - 1].close;
      break;
    }
    if (prevRthClose == null) continue;

    // GEX 9:30 snapshot
    const gexSnaps = loadIntradayGEX('NQ', dateStr);
    let gex930 = null;
    if (gexSnaps && gexSnaps.length) {
      const target = fromET(
        parseInt(dateStr.slice(0,4)),
        parseInt(dateStr.slice(5,7)) - 1,
        parseInt(dateStr.slice(8,10)),
        9, 30
      );
      gex930 = getGEXSnapshotAt(gexSnaps, target);
    }
    if (!gex930) nGexMissing++;

    const iv930 = ivData.dailyIV930.get(dateStr) ?? null;
    const ivPct = rollingPercentile(orderedIVDates, ivData.dailyIV930, dateStr, 30);

    const isOOS = dateStr >= OOS_START;
    const trade = processDay(dateStr, dayCandles, prevRthClose, gex930, iv930, ivPct, isOOS);
    if (!trade) continue;
    trades.push(trade);
    if (!trade.hadExtension) nNoExtension++;
    else if (!trade.hadFailedExt) nNoFailed++;
  }

  const executed = trades.filter(t => t.executed);
  const inSample = executed.filter(t => !t.isOOS);
  const oos      = executed.filter(t => t.isOOS);

  console.log(`\nTotal days analyzed: ${trades.length}`);
  console.log(`  no IB extension:       ${nNoExtension}`);
  console.log(`  ext but no re-entry:   ${nNoFailed}`);
  console.log(`  executed failed-ext:   ${executed.length}`);
  console.log(`     IS (<${OOS_START}):  ${inSample.length}`);
  console.log(`     OOS (>=${OOS_START}): ${oos.length}`);
  console.log(`  GEX 9:30 missing days: ${nGexMissing}`);

  // -------------------- Conditional probability tables --------------------
  const probTables = {
    overall:           condProbBlock(executed, () => true, 'overall'),
    by11_00_window:    condProbBlock(executed, t => t.entryEtMin <= STRICT_ENTRY_CUTOFF_M, 'entry_by_11_00'),
    by11_30_window:    condProbBlock(executed, t => t.entryEtMin <= RELAXED_ENTRY_CUTOFF_M, 'entry_by_11_30'),
    touchedWall:       condProbBlock(executed, t => t.touchedWall, 'gex_wall_touched'),
    notTouchedWall:    condProbBlock(executed, t => !t.touchedWall, 'no_wall_touch'),
    gapAligned:        condProbBlock(executed, t => t.gapAligned, 'gap_aligned'),
    gapOpposed:        condProbBlock(executed, t => !t.gapAligned, 'gap_opposed'),
    ivPctHigh:         condProbBlock(executed, t => t.ivPct != null && t.ivPct >= 0.7, 'iv_pct_>=0.7'),
    ivPctMid:          condProbBlock(executed, t => t.ivPct != null && t.ivPct >= 0.3 && t.ivPct < 0.7, 'iv_pct_0.3-0.7'),
    ivPctLow:          condProbBlock(executed, t => t.ivPct != null && t.ivPct < 0.3, 'iv_pct_<0.3'),
    regimePos:         condProbBlock(executed, t => t.regime === 'positive' || t.regime === 'strong_positive', 'regime_positive_any'),
    regimeNeg:         condProbBlock(executed, t => t.regime === 'negative' || t.regime === 'strong_negative', 'regime_negative_any'),
    extDistShort:      condProbBlock(executed, t => t.extDistance < 15, 'ext_dist_<15pts'),
    extDistMed:        condProbBlock(executed, t => t.extDistance >= 15 && t.extDistance < 35, 'ext_dist_15-35pts'),
    extDistLong:       condProbBlock(executed, t => t.extDistance >= 35, 'ext_dist_>=35pts'),
    // Compound bull cases
    wallAndGap:        condProbBlock(executed, t => t.touchedWall && t.gapAligned, 'wall_AND_gap_aligned'),
    wallAndGapAndIv:   condProbBlock(executed, t => t.touchedWall && t.gapAligned && t.ivPct != null && t.ivPct >= 0.5, 'wall_AND_gap_AND_iv>=0.5'),
    wall_strict11:     condProbBlock(executed, t => t.touchedWall && t.entryEtMin <= STRICT_ENTRY_CUTOFF_M, 'wall_AND_entry_by_11_00'),
    wall_relaxed11_30: condProbBlock(executed, t => t.touchedWall && t.entryEtMin <= RELAXED_ENTRY_CUTOFF_M, 'wall_AND_entry_by_11_30')
  };

  // -------------------- Grid sweeps --------------------
  console.log('\nRunning stop/target/timestop grid (in-sample)...');
  const gridIS = pickWinningGrid(inSample);
  const gridIS_strict11 = pickWinningGrid(inSample, { entryCutoffMin: STRICT_ENTRY_CUTOFF_M });
  const gridIS_relaxed11_30 = pickWinningGrid(inSample, { entryCutoffMin: RELAXED_ENTRY_CUTOFF_M });
  const gridIS_wall = pickWinningGrid(inSample, { touchedWallOnly: true });
  const gridIS_gap  = pickWinningGrid(inSample, { gapAlignedOnly: true });
  const gridIS_wall_gap = pickWinningGrid(inSample, { touchedWallOnly: true, gapAlignedOnly: true });
  const gridIS_wall_strict = pickWinningGrid(inSample, { touchedWallOnly: true, entryCutoffMin: STRICT_ENTRY_CUTOFF_M });
  const gridIS_wall_relaxed = pickWinningGrid(inSample, { touchedWallOnly: true, entryCutoffMin: RELAXED_ENTRY_CUTOFF_M });

  // OOS test on top-3 from key IS configs
  function oosCheck(opts) {
    return pickWinningGrid(oos, opts);
  }
  function pickKeyParams(grids) {
    return topN(grids, 3, 'totalPts').map(g => ({ stopPts: g.stopPts, target: g.target, tStop: g.tStop }));
  }
  function findGrid(grids, key) {
    return grids.find(g => g.stopPts === key.stopPts && g.target === key.target && g.tStop === key.tStop) || null;
  }

  function isOosBundle(opts, isGrid, label) {
    const top = pickKeyParams(isGrid);
    const oosG = oosCheck(opts);
    return {
      label,
      isTop3: top.map(k => ({ ...k, ...findGrid(isGrid, k) })),
      oosForTop3: top.map(k => ({ ...k, ...findGrid(oosG, k) })),
      oosBest: topN(oosG, 5, 'totalPts')
    };
  }

  const oosBundles = {
    overall:        isOosBundle({}, gridIS, 'overall'),
    strict_11_00:   isOosBundle({ entryCutoffMin: STRICT_ENTRY_CUTOFF_M }, gridIS_strict11, 'strict_11_00'),
    relaxed_11_30:  isOosBundle({ entryCutoffMin: RELAXED_ENTRY_CUTOFF_M }, gridIS_relaxed11_30, 'relaxed_11_30'),
    wallTouch:      isOosBundle({ touchedWallOnly: true }, gridIS_wall, 'wall_touch'),
    wallTouch_strict: isOosBundle({ touchedWallOnly: true, entryCutoffMin: STRICT_ENTRY_CUTOFF_M }, gridIS_wall_strict, 'wall_touch_strict_11'),
    wallTouch_relaxed: isOosBundle({ touchedWallOnly: true, entryCutoffMin: RELAXED_ENTRY_CUTOFF_M }, gridIS_wall_relaxed, 'wall_touch_relaxed_11_30')
  };

  // -------------------- MFE/MAE distributions --------------------
  const mfeMaeStats = {
    overall: {
      mfe: summary(executed.map(t => t.mfePts)),
      mae: summary(executed.map(t => t.maePts)),
      tToMfe: summary(executed.map(t => t.tToMfeMin)),
      tToMae: summary(executed.map(t => t.tToMaeMin)),
      targetOppIB: summary(executed.map(t => t.targetOppIBpts)),
      targetMid:   summary(executed.map(t => t.targetMidPts)),
      ibRange: summary(executed.map(t => t.ibRange)),
      extDist: summary(executed.map(t => t.extDistance)),
      minutesExtToReentry: summary(executed.map(t => t.minutesExtToReentry))
    },
    wallTouchedSubset: {
      mfe: summary(executed.filter(t => t.touchedWall).map(t => t.mfePts)),
      mae: summary(executed.filter(t => t.touchedWall).map(t => t.maePts))
    }
  };

  // -------------------- Headline summary --------------------
  console.log('\n=== Conditional probabilities ===');
  for (const [k, v] of Object.entries(probTables)) {
    console.log(`  ${k.padEnd(22)} n=${String(v.n).padStart(3)}  pHitOppIB=${v.pHitOppIB ?? '-'}  pHitMid=${v.pHitMid ?? '-'}  pHit50=${v.pHitMfe50 ?? '-'}  avgMfe=${v.avgMfe ?? '-'}  avgMae=${v.avgMae ?? '-'}`);
  }

  console.log('\n=== Top 3 grid combos by total pts (in-sample, all) ===');
  for (const g of topN(gridIS, 3, 'totalPts')) {
    console.log(`  s${g.stopPts}/t${g.target}(${g.targetPts})/h${g.tStop} -> n=${g.n} wr=${g.winRate} pf=${g.pf} avg=${g.avgPts} total=${g.totalPts}`);
  }

  console.log('\n=== Top 3 grid combos (in-sample, GEX wall touched) ===');
  for (const g of topN(gridIS_wall, 3, 'totalPts')) {
    console.log(`  s${g.stopPts}/t${g.target}(${g.targetPts})/h${g.tStop} -> n=${g.n} wr=${g.winRate} pf=${g.pf} avg=${g.avgPts} total=${g.totalPts}`);
  }

  console.log('\n=== Top 3 grid combos (in-sample, wall + entry by 11:30 relaxed) ===');
  for (const g of topN(gridIS_wall_relaxed, 3, 'totalPts')) {
    console.log(`  s${g.stopPts}/t${g.target}(${g.targetPts})/h${g.tStop} -> n=${g.n} wr=${g.winRate} pf=${g.pf} avg=${g.avgPts} total=${g.totalPts}`);
  }

  // -------------------- Write output --------------------
  const result = {
    meta: {
      script: 'T6-ib-failure.js',
      generatedAt: new Date().toISOString(),
      startDate: START_DATE,
      endDate: END_DATE,
      oosStart: OOS_START,
      ibWindow: '9:30-10:30 ET',
      reentryWindowMin: REENTRY_WIN_M,
      gexTouchProxPts: GEX_TOUCH_PROX_PTS,
      stopsTested: STOPS_PTS,
      timeStopsTested: TIME_STOPS,
      totalDaysProcessed: trades.length,
      noIbExtension: nNoExtension,
      extButNoReentry: nNoFailed,
      executedFailedExtensions: executed.length,
      inSample: inSample.length,
      oos: oos.length,
      gexMissingDays: nGexMissing
    },
    conditionalProbabilities: probTables,
    mfeMaeStats,
    grids: {
      inSample_all: { topByTotalPts: topN(gridIS, 10), topByPF: topN(gridIS, 10, 'pf'), topByWinRate: topN(gridIS, 10, 'winRate') },
      inSample_strict_11_00: { topByTotalPts: topN(gridIS_strict11, 10), topByPF: topN(gridIS_strict11, 10, 'pf') },
      inSample_relaxed_11_30: { topByTotalPts: topN(gridIS_relaxed11_30, 10), topByPF: topN(gridIS_relaxed11_30, 10, 'pf') },
      inSample_wallTouch: { topByTotalPts: topN(gridIS_wall, 10), topByPF: topN(gridIS_wall, 10, 'pf') },
      inSample_gapAligned: { topByTotalPts: topN(gridIS_gap, 10), topByPF: topN(gridIS_gap, 10, 'pf') },
      inSample_wall_AND_gap: { topByTotalPts: topN(gridIS_wall_gap, 10), topByPF: topN(gridIS_wall_gap, 10, 'pf') },
      inSample_wall_strict_11: { topByTotalPts: topN(gridIS_wall_strict, 10), topByPF: topN(gridIS_wall_strict, 10, 'pf') },
      inSample_wall_relaxed_11_30: { topByTotalPts: topN(gridIS_wall_relaxed, 10), topByPF: topN(gridIS_wall_relaxed, 10, 'pf') }
    },
    oosBundles,
    perTrade: trades  // every analyzed day, including no-extension and no-reentry
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH} (${(fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Elapsed: ${((Date.now() - t0)/1000).toFixed(1)}s`);
}

main().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
