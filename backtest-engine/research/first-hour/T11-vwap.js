#!/usr/bin/env node
/**
 * T11 — VWAP reclaim/rejection at the open
 *
 * Tests two patterns on the NQ 9:30-10:30 ET window:
 *  - RECLAIM: price opens BELOW (or ABOVE) the overnight session VWAP, then a 1m
 *    bar closes ≥5pt on the opposite side within 9:30-10:30 ET. Test directional edge.
 *  - REJECTION: in 9:30-9:45, a 5m candle has wick into VWAP but closes ≥3pt away
 *    from VWAP (against the prior side) → reversal candidate.
 *
 * Hypothesis: WR ≥ 60% with conditioning (gap, ON-VWAP slope, GEX regime).
 *
 * Hard rules:
 *  - raw NQ contracts (filterPrimaryContract())
 *  - GEX from data/gex/nq-cbbo/ (post-fix)
 *  - all windowing in ET, source ts in UTC
 *  - skip rollover boundary days
 *  - 2025-01-13 → 2026-04-23 (last 2 months OOS = 2026-02-23 → 2026-04-23)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { CSVLoader } from '../../src/data/csv-loader.js';
import { toET, fromET } from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT     = path.resolve(__dirname, '..', '..');
const NQ_OHLCV_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
const ROLLOVER_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_rollover_log.csv');
const GEX_DIR       = path.join(REPO_ROOT, 'data', 'gex', 'nq-cbbo');
const OUTPUT_PATH   = path.join(__dirname, 'output', 'T11-vwap.json');

const START_DATE = '2025-01-13';
const END_DATE   = '2026-04-23';
const OOS_START  = '2026-02-23'; // last ~2 months OOS

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
  const mean = sum / sorted.length;
  return {
    n: sorted.length,
    min: round(sorted[0], 2),
    p10: round(pct(sorted, 10), 2),
    p25: round(pct(sorted, 25), 2),
    median: round(pct(sorted, 50), 2),
    mean: round(mean, 2),
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
  console.log(`Loading raw NQ 1m candles ${startDate} → ${endDate}...`);
  // Need overnight data → start day before to capture overnight VWAP
  const start = new Date(startDate + 'T00:00:00Z').getTime() - 24*3600000;
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

// Load GEX snapshot near 9:30 ET for a date — return regime from snapshot at/just before 9:30 ET
function loadGEXFor930ET(dateStr) {
  const filePath = path.join(GEX_DIR, `nq_gex_${dateStr}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const snapshots = j.data || [];
    if (!snapshots.length) return null;
    // 9:30 ET → UTC
    const [yy, mm, dd] = dateStr.split('-').map(Number);
    const ts930 = fromET(yy, mm - 1, dd, 9, 30);
    // pick latest snapshot ≤ ts930 (post-relabel: snapshot timestamp == as-of time)
    let chosen = null;
    for (const s of snapshots) {
      const sts = new Date(s.timestamp).getTime();
      if (sts <= ts930) {
        if (!chosen || sts > new Date(chosen.timestamp).getTime()) chosen = s;
      }
    }
    if (!chosen) chosen = snapshots[0];
    return chosen;
  } catch (e) {
    return null;
  }
}

function gexRegime(snap) {
  if (!snap) return 'unknown';
  // gamma_imbalance is signed: negative → put-heavy; positive → call-heavy
  // mimic strategy convention: strong if |imbalance| > 0.5
  const gi = snap.gamma_imbalance;
  if (gi == null || isNaN(gi)) return 'unknown';
  if (gi <= -0.5) return 'strong_negative';
  if (gi <  -0.1) return 'negative';
  if (gi <   0.1) return 'neutral';
  if (gi <   0.5) return 'positive';
  return 'strong_positive';
}

// -------------------- bucket by ET trading day --------------------

function bucketByDay(candles) {
  const byDate = new Map();
  for (const c of candles) {
    const et = toET(c.timestamp);
    if (!byDate.has(et.date)) byDate.set(et.date, []);
    byDate.get(et.date).push({ ...c, et });
  }
  return byDate;
}

function gapBucket(gapPct) {
  if (gapPct >  0.004) return 'gap_up_strong';
  if (gapPct >  0.001) return 'gap_up_mild';
  if (gapPct < -0.004) return 'gap_down_strong';
  if (gapPct < -0.001) return 'gap_down_mild';
  return 'flat';
}

// -------------------- VWAP --------------------

/**
 * Anchored VWAP from a sorted array of candles.
 * Returns parallel arrays: { ts, vwap }
 */
function anchoredVWAP(candles) {
  let cumPV = 0, cumV = 0;
  const out = [];
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    const v = c.volume || 1;
    cumPV += tp * v;
    cumV += v;
    out.push({ ts: c.timestamp, vwap: cumPV / cumV });
  }
  return out;
}

// -------------------- daily processing --------------------

/**
 * Build per-day record with overnight VWAP series + RTH first-90m candle slice.
 * Overnight session = 18:00 prev day ET → 09:30 ET (current day).
 * RTH window = 09:30 ET → 11:00 ET (90 min).
 */
function processDay(dateStr, dayCandles, byDate, rolloverDates, sortedDates) {
  if (rolloverDates.has(dateStr)) return null;
  const idx = sortedDates.indexOf(dateStr);
  if (idx < 1) return null;
  const prevDate = sortedDates[idx - 1];
  if (!byDate.has(prevDate)) return null;

  const [yy, mm, dd] = dateStr.split('-').map(Number);
  const ts930 = fromET(yy, mm - 1, dd, 9, 30);
  const ts1100 = fromET(yy, mm - 1, dd, 11, 0);
  const ts1030 = fromET(yy, mm - 1, dd, 10, 30);
  const tsONStart = (() => {
    const [py, pm, pd] = prevDate.split('-').map(Number);
    return fromET(py, pm - 1, pd, 18, 0);
  })();

  // Overnight candles (18:00 prev → 09:30 current ET) from across both days
  const prevDayCandles = byDate.get(prevDate) || [];
  const onCandles = [];
  for (const c of prevDayCandles) {
    if (c.timestamp >= tsONStart && c.timestamp < ts930) onCandles.push(c);
  }
  for (const c of dayCandles) {
    if (c.timestamp >= tsONStart && c.timestamp < ts930) onCandles.push(c);
  }
  onCandles.sort((a, b) => a.timestamp - b.timestamp);
  if (onCandles.length < 60) return null;

  const onVWAPSeries = anchoredVWAP(onCandles);
  const onVWAPAt930 = onVWAPSeries[onVWAPSeries.length - 1].vwap;

  // ON-VWAP slope last 90 min before 09:30
  const ts90mBefore = ts930 - 90 * 60000;
  const slopeStart = onVWAPSeries.find(p => p.ts >= ts90mBefore);
  let onSlopePts = null;
  if (slopeStart) {
    onSlopePts = onVWAPAt930 - slopeStart.vwap;
  }
  const slopeBucket = onSlopePts == null ? 'unknown'
    : onSlopePts >  5 ? 'rising'
    : onSlopePts < -5 ? 'falling'
    : 'flat';

  // RTH first 90 min candles
  const rth90 = dayCandles.filter(c => c.timestamp >= ts930 && c.timestamp < ts1100);
  const rth60 = dayCandles.filter(c => c.timestamp >= ts930 && c.timestamp < ts1030);
  if (rth90.length < 70) return null;

  const openCandle = rth90.find(c => c.et.timeInMinutes === 570);
  if (!openCandle) return null;
  const open930 = openCandle.open;

  // Prev RTH close for gap calc
  let prevRthClose = null;
  for (let j = idx - 1; j >= Math.max(0, idx - 7); j--) {
    const pd = sortedDates[j];
    if (rolloverDates.has(pd)) continue;
    const pc = byDate.get(pd);
    if (!pc) continue;
    const prevRth = pc.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes <= 960);
    if (prevRth.length === 0) continue;
    prevRthClose = prevRth[prevRth.length - 1].close;
    break;
  }
  if (prevRthClose == null) return null;
  const gapPts = open930 - prevRthClose;
  const gapPct = gapPts / prevRthClose;

  // GEX regime at 9:30
  const gexSnap = loadGEXFor930ET(dateStr);
  const regime = gexRegime(gexSnap);

  return {
    date: dateStr,
    dayOfWeek: openCandle.et.dayOfWeek,
    open930,
    prevRthClose,
    gapPts: round(gapPts, 2),
    gapPct: round(gapPct, 5),
    gapBucket: gapBucket(gapPct),
    onVWAPAt930: round(onVWAPAt930, 2),
    open930VsONVWAP: round(open930 - onVWAPAt930, 2), // pos = open above VWAP
    onSlopePts: round(onSlopePts, 2),
    slopeBucket,
    regime,
    gammaImbalance: gexSnap ? round(gexSnap.gamma_imbalance, 4) : null,
    rth90, // attached for downstream pattern detection
    rth60,
    onCandles,
    ts930, ts1100, ts1030
  };
}

// -------------------- pattern detection --------------------

/**
 * RECLAIM: price was on side A vs ON-VWAP at 9:30; first 1m bar in 9:30-10:30 that
 * closes ≥ 5pt on the opposite side is the signal. Skip if open exactly at VWAP (within 5 pts).
 */
function detectReclaim(day) {
  const sideAtOpen = day.open930VsONVWAP > 0 ? 'above' : 'below';
  // require open at least 5 pts off VWAP to qualify as a meaningful "below/above" start
  if (Math.abs(day.open930VsONVWAP) < 5) return null;
  const vwap = day.onVWAPAt930;
  // Walk 1m bars 9:30 → 10:30. First close on opposite side by ≥5pt = reclaim.
  for (const c of day.rth60) {
    const distAbove = c.close - vwap;
    if (sideAtOpen === 'below' && distAbove >= 5) {
      return {
        type: 'reclaim_long',
        entryTs: c.timestamp,
        entryPrice: c.close,
        signalCandle: c,
        sideAtOpen,
        vwap
      };
    }
    if (sideAtOpen === 'above' && distAbove <= -5) {
      return {
        type: 'reclaim_short',
        entryTs: c.timestamp,
        entryPrice: c.close,
        signalCandle: c,
        sideAtOpen,
        vwap
      };
    }
  }
  return null;
}

/**
 * REJECTION: in 9:30-9:45 (3 5m candles), build 5m candles, find one where:
 *  - high reaches within 3 pts of VWAP from BELOW (then close < VWAP - 3) → SHORT
 *  - low reaches within 3 pts of VWAP from ABOVE (then close > VWAP + 3) → LONG
 * Note: "from below" means open price was below VWAP.
 */
function detectRejection(day) {
  const vwap = day.onVWAPAt930;
  // Build 5m bars from 1m for 9:30-9:45 (3 bars)
  const ts930 = day.ts930;
  const tsEnd = ts930 + 15 * 60000;
  const window = day.rth60.filter(c => c.timestamp >= ts930 && c.timestamp < tsEnd);
  const bars5m = [];
  for (let bs = 0; bs < 3; bs++) {
    const start = ts930 + bs * 5 * 60000;
    const end = start + 5 * 60000;
    const sub = window.filter(c => c.timestamp >= start && c.timestamp < end);
    if (sub.length < 3) continue;
    bars5m.push({
      timestamp: start + 4 * 60000, // label as the close minute
      open: sub[0].open,
      high: Math.max(...sub.map(s => s.high)),
      low: Math.min(...sub.map(s => s.low)),
      close: sub[sub.length - 1].close,
      volume: sub.reduce((a, s) => a + (s.volume || 0), 0)
    });
  }
  for (const bar of bars5m) {
    // SHORT: open < VWAP, high reached VWAP±3, close < VWAP - 3
    if (bar.open < vwap && bar.high >= vwap - 3 && bar.close < vwap - 3) {
      return {
        type: 'rejection_short',
        entryTs: bar.timestamp,
        entryPrice: bar.close,
        signalBar: bar,
        vwap
      };
    }
    // LONG: open > VWAP, low reached VWAP±3, close > VWAP + 3
    if (bar.open > vwap && bar.low <= vwap + 3 && bar.close > vwap + 3) {
      return {
        type: 'rejection_long',
        entryTs: bar.timestamp,
        entryPrice: bar.close,
        signalBar: bar,
        vwap
      };
    }
  }
  return null;
}

// -------------------- forward MFE/MAE --------------------

/**
 * From entry timestamp, compute MFE/MAE in cross/signal direction over `horizons` minutes.
 * direction: 'long' or 'short' (defines what counts as favorable)
 */
function forwardMFEMAE(day, signal, horizonsMin) {
  const dir = signal.type.endsWith('long') ? 'long' : 'short';
  const out = {};
  for (const h of horizonsMin) {
    const endTs = signal.entryTs + h * 60000;
    const slice = day.rth90.filter(c => c.timestamp > signal.entryTs && c.timestamp <= endTs);
    if (slice.length < Math.max(15, h - 10)) {
      out[`h${h}`] = null;
      continue;
    }
    const highs = slice.map(c => c.high);
    const lows = slice.map(c => c.low);
    const maxHigh = Math.max(...highs);
    const minLow  = Math.min(...lows);
    const lastClose = slice[slice.length - 1].close;
    let mfe, mae, finalPnL;
    if (dir === 'long') {
      mfe = maxHigh - signal.entryPrice;
      mae = signal.entryPrice - minLow;
      finalPnL = lastClose - signal.entryPrice;
    } else {
      mfe = signal.entryPrice - minLow;
      mae = maxHigh - signal.entryPrice;
      finalPnL = signal.entryPrice - lastClose;
    }
    out[`h${h}`] = {
      mfe: round(mfe, 2),
      mae: round(mae, 2),
      finalPnL: round(finalPnL, 2),
      win: finalPnL > 0
    };
  }
  return out;
}

// -------------------- grid search backtest --------------------

/**
 * Simulate trade with stop/target/time-stop. Bar-by-bar 1m walk.
 * Returns { exit, exitPrice, pnlPts }.
 */
function simulateTrade(day, signal, stopPts, targetPts, timeStopMin) {
  const dir = signal.type.endsWith('long') ? 'long' : 'short';
  const stopPrice = dir === 'long' ? signal.entryPrice - stopPts : signal.entryPrice + stopPts;
  const tgtPrice  = dir === 'long' ? signal.entryPrice + targetPts : signal.entryPrice - targetPts;
  const endTs = signal.entryTs + timeStopMin * 60000;
  const slice = day.rth90.filter(c => c.timestamp > signal.entryTs && c.timestamp <= endTs);
  for (const c of slice) {
    if (dir === 'long') {
      // simulate stop first (conservative)
      if (c.low <= stopPrice) return { exit: 'stop', exitPrice: stopPrice, pnlPts: -stopPts };
      if (c.high >= tgtPrice) return { exit: 'target', exitPrice: tgtPrice, pnlPts: targetPts };
    } else {
      if (c.high >= stopPrice) return { exit: 'stop', exitPrice: stopPrice, pnlPts: -stopPts };
      if (c.low <= tgtPrice) return { exit: 'target', exitPrice: tgtPrice, pnlPts: targetPts };
    }
  }
  // time stop
  if (slice.length === 0) return null;
  const lastClose = slice[slice.length - 1].close;
  const pnl = dir === 'long' ? lastClose - signal.entryPrice : signal.entryPrice - lastClose;
  return { exit: 'time', exitPrice: lastClose, pnlPts: round(pnl, 2) };
}

function gridSearch(signals, days, label, stops, targets, timeStops) {
  const results = [];
  for (const stop of stops) {
    for (const tgt of targets) {
      for (const ts of timeStops) {
        const trades = [];
        for (const sig of signals) {
          const day = days.find(d => d.date === sig._date);
          if (!day) continue;
          const r = simulateTrade(day, sig, stop, tgt, ts);
          if (r) trades.push({ ...r, date: sig._date, type: sig.type });
        }
        if (!trades.length) continue;
        const wins = trades.filter(t => t.pnlPts > 0);
        const losses = trades.filter(t => t.pnlPts <= 0);
        const totalPnL = trades.reduce((a, t) => a + t.pnlPts, 0);
        const grossWin = wins.reduce((a, t) => a + t.pnlPts, 0);
        const grossLoss = -losses.reduce((a, t) => a + t.pnlPts, 0);
        const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
        const wr = wins.length / trades.length;
        // Sharpe: ratio of mean to std of pnlPts
        const mean = totalPnL / trades.length;
        const variance = trades.reduce((a, t) => a + Math.pow(t.pnlPts - mean, 2), 0) / trades.length;
        const std = Math.sqrt(variance);
        const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : null;
        // simple max DD
        let cum = 0, peak = 0, maxDD = 0;
        for (const t of trades) {
          cum += t.pnlPts;
          if (cum > peak) peak = cum;
          const dd = peak - cum;
          if (dd > maxDD) maxDD = dd;
        }
        results.push({
          label, stopPts: stop, targetPts: tgt, timeStopMin: ts,
          n: trades.length,
          wr: round(wr, 4),
          totalPnLPts: round(totalPnL, 2),
          avgPnLPts: round(mean, 2),
          pf: pf === Infinity ? null : round(pf, 2),
          sharpe: sharpe == null ? null : round(sharpe, 2),
          maxDDPts: round(maxDD, 2),
          stopExits: trades.filter(t => t.exit === 'stop').length,
          targetExits: trades.filter(t => t.exit === 'target').length,
          timeExits: trades.filter(t => t.exit === 'time').length
        });
      }
    }
  }
  return results;
}

function topByMetric(results, metric, n = 5) {
  return [...results].sort((a, b) => (b[metric] || -Infinity) - (a[metric] || -Infinity)).slice(0, n);
}

// -------------------- stratification --------------------

function stratify(signals, key) {
  const out = {};
  for (const s of signals) {
    const k = s[key] || 'unknown';
    if (!out[k]) out[k] = { n: 0, wins: 0, finalPnLs: [], mfes: [], maes: [] };
    out[k].n++;
    const h60 = s._mfeMae.h60;
    if (h60) {
      if (h60.win) out[k].wins++;
      out[k].finalPnLs.push(h60.finalPnL);
      out[k].mfes.push(h60.mfe);
      out[k].maes.push(h60.mae);
    }
  }
  for (const k of Object.keys(out)) {
    const o = out[k];
    o.wr60 = o.n > 0 ? round(o.wins / o.n, 4) : null;
    o.finalPnL = summary(o.finalPnLs);
    o.mfe = summary(o.mfes);
    o.mae = summary(o.maes);
    delete o.finalPnLs;
    delete o.mfes;
    delete o.maes;
  }
  return out;
}

// -------------------- main --------------------

async function main() {
  const t0 = Date.now();
  console.log('='.repeat(70));
  console.log(' T11 — VWAP reclaim/rejection at the open');
  console.log('='.repeat(70));

  const rolloverDates = loadRolloverDates();
  const candles = await loadRawNqMinute(START_DATE, END_DATE);
  const byDate = bucketByDay(candles);
  const sortedDates = [...byDate.keys()].sort();

  console.log('Building per-day records...');
  const days = [];
  for (const dateStr of sortedDates) {
    if (dateStr < START_DATE || dateStr > END_DATE) continue;
    const dayCandles = byDate.get(dateStr);
    const day = processDay(dateStr, dayCandles, byDate, rolloverDates, sortedDates);
    if (day) days.push(day);
  }
  console.log(`Days kept: ${days.length}`);

  // Detect signals
  console.log('Detecting RECLAIM signals...');
  const reclaimSignals = [];
  for (const day of days) {
    const r = detectReclaim(day);
    if (r) {
      r._date = day.date;
      r._mfeMae = forwardMFEMAE(day, r, [60, 90]);
      r.gapBucket = day.gapBucket;
      r.slopeBucket = day.slopeBucket;
      r.regime = day.regime;
      r.dayOfWeek = day.dayOfWeek;
      r.gapPts = day.gapPts;
      r.onSlopePts = day.onSlopePts;
      r.entryDate = day.date;
      r.entryEt = toET(r.entryTs);
      r.entryMinFromOpen = (r.entryTs - day.ts930) / 60000;
      reclaimSignals.push(r);
    }
  }
  console.log(`  reclaim signals: ${reclaimSignals.length} (long=${reclaimSignals.filter(s => s.type === 'reclaim_long').length}, short=${reclaimSignals.filter(s => s.type === 'reclaim_short').length})`);

  console.log('Detecting REJECTION signals...');
  const rejectionSignals = [];
  for (const day of days) {
    const r = detectRejection(day);
    if (r) {
      r._date = day.date;
      r._mfeMae = forwardMFEMAE(day, r, [60, 90]);
      r.gapBucket = day.gapBucket;
      r.slopeBucket = day.slopeBucket;
      r.regime = day.regime;
      r.dayOfWeek = day.dayOfWeek;
      r.gapPts = day.gapPts;
      r.onSlopePts = day.onSlopePts;
      r.entryDate = day.date;
      r.entryEt = toET(r.entryTs);
      rejectionSignals.push(r);
    }
  }
  console.log(`  rejection signals: ${rejectionSignals.length} (long=${rejectionSignals.filter(s => s.type === 'rejection_long').length}, short=${rejectionSignals.filter(s => s.type === 'rejection_short').length})`);

  // ----- distributions -----
  function packStats(signals) {
    const finalPnLs60 = signals.map(s => s._mfeMae?.h60?.finalPnL).filter(v => v != null);
    const finalPnLs90 = signals.map(s => s._mfeMae?.h90?.finalPnL).filter(v => v != null);
    const mfes60 = signals.map(s => s._mfeMae?.h60?.mfe).filter(v => v != null);
    const maes60 = signals.map(s => s._mfeMae?.h60?.mae).filter(v => v != null);
    const wins60 = signals.filter(s => s._mfeMae?.h60?.win).length;
    return {
      n: signals.length,
      wr60: signals.length > 0 ? round(wins60 / signals.length, 4) : null,
      finalPnL_60min: summary(finalPnLs60),
      finalPnL_90min: summary(finalPnLs90),
      mfe_60min: summary(mfes60),
      mae_60min: summary(maes60),
      pMFE_GE: {
        '20': round(fracAtLeast(mfes60, 20), 4),
        '30': round(fracAtLeast(mfes60, 30), 4),
        '50': round(fracAtLeast(mfes60, 50), 4),
        '75': round(fracAtLeast(mfes60, 75), 4),
        '100': round(fracAtLeast(mfes60, 100), 4)
      },
      pMAE_GE: {
        '20': round(fracAtLeast(maes60, 20), 4),
        '40': round(fracAtLeast(maes60, 40), 4),
        '60': round(fracAtLeast(maes60, 60), 4)
      }
    };
  }

  const reclaimStats = packStats(reclaimSignals);
  const rejectionStats = packStats(rejectionSignals);

  // Stratifications
  const reclaimByGap = stratify(reclaimSignals, 'gapBucket');
  const reclaimBySlope = stratify(reclaimSignals, 'slopeBucket');
  const reclaimByRegime = stratify(reclaimSignals, 'regime');
  const reclaimByType = stratify(reclaimSignals, 'type');

  const rejectionByGap = stratify(rejectionSignals, 'gapBucket');
  const rejectionBySlope = stratify(rejectionSignals, 'slopeBucket');
  const rejectionByRegime = stratify(rejectionSignals, 'regime');
  const rejectionByType = stratify(rejectionSignals, 'type');

  // ----- grid search -----
  const stops = [25, 40, 60];
  const targets = [30, 50, 75, 100];
  const timeStops = [60, 90];

  console.log('Grid search RECLAIM...');
  const reclaimGrid = gridSearch(reclaimSignals, days, 'reclaim', stops, targets, timeStops);
  console.log('Grid search REJECTION...');
  const rejectionGrid = gridSearch(rejectionSignals, days, 'rejection', stops, targets, timeStops);

  // OOS split: filter signals by date
  const reclaimIS = reclaimSignals.filter(s => s._date < OOS_START);
  const reclaimOOS = reclaimSignals.filter(s => s._date >= OOS_START);
  const rejectionIS = rejectionSignals.filter(s => s._date < OOS_START);
  const rejectionOOS = rejectionSignals.filter(s => s._date >= OOS_START);

  console.log(`IS / OOS split: reclaim ${reclaimIS.length}/${reclaimOOS.length}, rejection ${rejectionIS.length}/${rejectionOOS.length}`);

  const reclaimGridIS = gridSearch(reclaimIS, days, 'reclaim_IS', stops, targets, timeStops);
  const reclaimGridOOS = gridSearch(reclaimOOS, days, 'reclaim_OOS', stops, targets, timeStops);
  const rejectionGridIS = gridSearch(rejectionIS, days, 'rejection_IS', stops, targets, timeStops);
  const rejectionGridOOS = gridSearch(rejectionOOS, days, 'rejection_OOS', stops, targets, timeStops);

  // Apply IS top-3 to OOS
  function evalConfigsOnOOS(configs, oosSignals) {
    return configs.map(cfg => {
      const trades = [];
      for (const sig of oosSignals) {
        const day = days.find(d => d.date === sig._date);
        if (!day) continue;
        const r = simulateTrade(day, sig, cfg.stopPts, cfg.targetPts, cfg.timeStopMin);
        if (r) trades.push(r);
      }
      if (!trades.length) return { ...cfg, oos: { n: 0 } };
      const wins = trades.filter(t => t.pnlPts > 0);
      const losses = trades.filter(t => t.pnlPts <= 0);
      const totalPnL = trades.reduce((a, t) => a + t.pnlPts, 0);
      const grossWin = wins.reduce((a, t) => a + t.pnlPts, 0);
      const grossLoss = -losses.reduce((a, t) => a + t.pnlPts, 0);
      return {
        ...cfg,
        oos: {
          n: trades.length,
          wr: round(wins.length / trades.length, 4),
          totalPnLPts: round(totalPnL, 2),
          avgPnLPts: round(totalPnL / trades.length, 2),
          pf: grossLoss > 0 ? round(grossWin / grossLoss, 2) : null
        }
      };
    });
  }

  const reclaimTopByPF = topByMetric(reclaimGridIS, 'pf', 3);
  const reclaimTopBySharpe = topByMetric(reclaimGridIS, 'sharpe', 3);
  const rejectionTopByPF = topByMetric(rejectionGridIS, 'pf', 3);
  const rejectionTopBySharpe = topByMetric(rejectionGridIS, 'sharpe', 3);

  const reclaimTopByPFOOS = evalConfigsOnOOS(reclaimTopByPF, reclaimOOS);
  const reclaimTopBySharpeOOS = evalConfigsOnOOS(reclaimTopBySharpe, reclaimOOS);
  const rejectionTopByPFOOS = evalConfigsOnOOS(rejectionTopByPF, rejectionOOS);
  const rejectionTopBySharpeOOS = evalConfigsOnOOS(rejectionTopBySharpe, rejectionOOS);

  const result = {
    meta: {
      script: 'T11-vwap.js',
      generatedAt: new Date().toISOString(),
      startDate: START_DATE,
      endDate: END_DATE,
      oosStart: OOS_START,
      nDays: days.length,
      nReclaim: reclaimSignals.length,
      nRejection: rejectionSignals.length
    },
    reclaim: {
      stats: reclaimStats,
      byGap: reclaimByGap,
      bySlope: reclaimBySlope,
      byRegime: reclaimByRegime,
      byType: reclaimByType
    },
    rejection: {
      stats: rejectionStats,
      byGap: rejectionByGap,
      bySlope: rejectionBySlope,
      byRegime: rejectionByRegime,
      byType: rejectionByType
    },
    gridSearch: {
      reclaim_full: { topByPF: topByMetric(reclaimGrid, 'pf', 5), topBySharpe: topByMetric(reclaimGrid, 'sharpe', 5) },
      rejection_full: { topByPF: topByMetric(rejectionGrid, 'pf', 5), topBySharpe: topByMetric(rejectionGrid, 'sharpe', 5) },
      reclaim_IS: { topByPF: reclaimTopByPF, topBySharpe: reclaimTopBySharpe },
      rejection_IS: { topByPF: rejectionTopByPF, topBySharpe: rejectionTopBySharpe },
      reclaim_OOS_eval: { byPF: reclaimTopByPFOOS, bySharpe: reclaimTopBySharpeOOS },
      rejection_OOS_eval: { byPF: rejectionTopByPFOOS, bySharpe: rejectionTopBySharpeOOS },
      allReclaim: reclaimGrid,
      allRejection: rejectionGrid
    },
    signals: {
      reclaim: reclaimSignals.map(s => ({
        date: s._date,
        type: s.type,
        entryTs: s.entryTs,
        entryPrice: s.entryPrice,
        vwap: round(s.vwap, 2),
        gapBucket: s.gapBucket,
        gapPts: s.gapPts,
        slopeBucket: s.slopeBucket,
        onSlopePts: s.onSlopePts,
        regime: s.regime,
        entryMinFromOpen: s.entryMinFromOpen,
        mfeMae: s._mfeMae
      })),
      rejection: rejectionSignals.map(s => ({
        date: s._date,
        type: s.type,
        entryTs: s.entryTs,
        entryPrice: s.entryPrice,
        vwap: round(s.vwap, 2),
        gapBucket: s.gapBucket,
        gapPts: s.gapPts,
        slopeBucket: s.slopeBucket,
        onSlopePts: s.onSlopePts,
        regime: s.regime,
        mfeMae: s._mfeMae
      }))
    }
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH} (${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)} KB)`);
  console.log(`Elapsed: ${((Date.now() - t0)/1000).toFixed(1)}s`);

  // -------- console summary --------
  console.log('\n----- RECLAIM SUMMARY -----');
  console.log(`n=${reclaimStats.n}  WR60=${reclaimStats.wr60}`);
  console.log('  finalPnL 60m:', reclaimStats.finalPnL_60min);
  console.log('  P(MFE>=30):', reclaimStats.pMFE_GE['30'], ' P(MFE>=50):', reclaimStats.pMFE_GE['50']);
  console.log('  Top 3 by Sharpe (full):');
  for (const r of topByMetric(reclaimGrid, 'sharpe', 3)) {
    console.log(`    SL=${r.stopPts}/TP=${r.targetPts}/T=${r.timeStopMin}min  n=${r.n} WR=${r.wr} PF=${r.pf} Sh=${r.sharpe} PnL=${r.totalPnLPts}pts MaxDD=${r.maxDDPts}pts`);
  }
  console.log('  Top 3 IS by Sharpe → OOS:');
  for (const r of reclaimTopBySharpeOOS) {
    console.log(`    SL=${r.stopPts}/TP=${r.targetPts}/T=${r.timeStopMin}min  IS Sh=${r.sharpe} PF=${r.pf}  OOS n=${r.oos.n} WR=${r.oos.wr} PF=${r.oos.pf} PnL=${r.oos.totalPnLPts}`);
  }

  console.log('\n----- REJECTION SUMMARY -----');
  console.log(`n=${rejectionStats.n}  WR60=${rejectionStats.wr60}`);
  console.log('  finalPnL 60m:', rejectionStats.finalPnL_60min);
  console.log('  P(MFE>=30):', rejectionStats.pMFE_GE['30'], ' P(MFE>=50):', rejectionStats.pMFE_GE['50']);
  console.log('  Top 3 by Sharpe (full):');
  for (const r of topByMetric(rejectionGrid, 'sharpe', 3)) {
    console.log(`    SL=${r.stopPts}/TP=${r.targetPts}/T=${r.timeStopMin}min  n=${r.n} WR=${r.wr} PF=${r.pf} Sh=${r.sharpe} PnL=${r.totalPnLPts}pts MaxDD=${r.maxDDPts}pts`);
  }
  console.log('  Top 3 IS by Sharpe → OOS:');
  for (const r of rejectionTopBySharpeOOS) {
    console.log(`    SL=${r.stopPts}/TP=${r.targetPts}/T=${r.timeStopMin}min  IS Sh=${r.sharpe} PF=${r.pf}  OOS n=${r.oos.n} WR=${r.oos.wr} PF=${r.oos.pf} PnL=${r.oos.totalPnLPts}`);
  }
}

main().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
