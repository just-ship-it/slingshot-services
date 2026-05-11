#!/usr/bin/env node
/**
 * T4 — Opening Range Breakout (ORB) with confluence filters
 *
 * Hypothesis:
 *   A 15-min OR breakout (long if first 1m close > 9:45 OR high after 9:45,
 *   short if first 1m close < 9:45 OR low) is a viable first-hour strategy
 *   when filtered by GEX regime, IV percentile, gap direction, and overnight bias.
 *
 * Method (per MASTER-PLAN.md):
 *   - Date range 2025-01-13 → 2026-04-23
 *   - Raw NQ contracts via filterPrimaryContract
 *   - One trade per day max, entry between OR-end and 11:00 ET
 *   - Stop = opposite OR boundary; Time-stop = 11:00 ET
 *   - Target sweep: fixed pts {25,50,75,100,150,200} + R-multiples {1.0,1.5,2.0,3.0}
 *   - Skip days with rollover boundary in window
 *   - Output: T4-orb.json + T4-FINDINGS.md (Proposed Strategy v0)
 *
 * Filters tested one at a time on top of baseline 15-min ORB:
 *   1) GEX regime (skip strong_negative entries; skip strong_positive shorts)
 *   2) IV percentile (middle 60th)
 *   3) Gap direction (longs only on gap-up, shorts on gap-down)
 *   4) Overnight bias proxy for pre-RTH sweep direction
 *
 * Quick-comparison: 5m and 30m OR variants under baseline (no filters).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import {
  toET,
  fromET,
  getRTHCandlesFromArray,
  getOvernightCandlesFromArray,
  extractTradingDates,
  loadIntradayGEX,
  getGEXSnapshotAt,
  getPrevDayLevelsFromArray,
} from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..', '..');

const START_DATE = '2025-01-13';
const END_DATE = '2026-04-23';

const NQ_CSV = path.join(ROOT, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
const QQQ_IV_CSV = path.join(ROOT, 'data', 'iv', 'qqq', 'qqq_atm_iv_1m.csv');
const ROLLOVER_CSV = path.join(ROOT, 'data', 'ohlcv', 'nq', 'NQ_rollover_log.csv');

const OUTPUT_DIR = path.join(__dirname, 'output');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'T4-orb.json');
const FINDINGS_MD = path.join(__dirname, 'T4-FINDINGS.md');

// ----------- Loaders -----------

async function loadNQ() {
  console.log('Loading NQ raw 1m...');
  const start = new Date(START_DATE).getTime();
  const end = new Date(END_DATE).getTime() + 2 * 24 * 3600 * 1000;
  const out = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(NQ_CSV)
      .pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return;
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < start || ts > end) return;
        const o = parseFloat(row.open),
          h = parseFloat(row.high),
          l = parseFloat(row.low),
          c = parseFloat(row.close);
        if (isNaN(o) || isNaN(c)) return;
        out.push({
          timestamp: ts,
          open: o,
          high: h,
          low: l,
          close: c,
          volume: parseFloat(row.volume) || 0,
          symbol: row.symbol,
        });
      })
      .on('end', resolve)
      .on('error', reject);
  });
  out.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  ${out.length.toLocaleString()} raw NQ candles`);
  return out;
}

// Inline filterPrimaryContract from src/data/csv-loader.js
function filterPrimaryContract(candles) {
  if (candles.length === 0) return candles;
  const hourVol = new Map();
  candles.forEach((c) => {
    const hk = Math.floor(c.timestamp / 3600000);
    if (!hourVol.has(hk)) hourVol.set(hk, new Map());
    const h = hourVol.get(hk);
    h.set(c.symbol, (h.get(c.symbol) || 0) + (c.volume || 0));
  });
  const primaryByHour = new Map();
  for (const [hk, m] of hourVol) {
    let bestSym = '',
      bestVol = -1;
    for (const [s, v] of m) {
      if (v > bestVol) {
        bestVol = v;
        bestSym = s;
      }
    }
    primaryByHour.set(hk, bestSym);
  }
  return candles.filter((c) => primaryByHour.get(Math.floor(c.timestamp / 3600000)) === c.symbol);
}

async function loadQQQIV() {
  console.log('Loading QQQ ATM IV 1m...');
  const start = new Date(START_DATE).getTime();
  const end = new Date(END_DATE).getTime() + 2 * 24 * 3600 * 1000;
  const out = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(QQQ_IV_CSV)
      .pipe(csv())
      .on('data', (row) => {
        const ts = new Date(row.timestamp).getTime();
        if (isNaN(ts) || ts < start || ts > end) return;
        const iv = parseFloat(row.iv);
        if (isNaN(iv)) return;
        out.push({ timestamp: ts, iv });
      })
      .on('end', resolve)
      .on('error', reject);
  });
  out.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  ${out.length.toLocaleString()} QQQ IV records`);
  return out;
}

function loadRolloverDates() {
  const text = fs.readFileSync(ROLLOVER_CSV, 'utf-8');
  const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('date,'));
  const dates = new Set();
  for (const ln of lines) {
    const date = ln.split(',')[0];
    if (date) dates.add(date);
  }
  return dates;
}

// ----------- Helpers -----------

function findCandleAt(candles, ts) {
  // Binary search for index of first candle with timestamp >= ts
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (candles[m].timestamp < ts) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function ivAt(ivArr, ts) {
  // Latest IV record at or before ts
  if (!ivArr.length || ts < ivArr[0].timestamp) return null;
  let lo = 0, hi = ivArr.length - 1;
  while (lo < hi) {
    const m = Math.ceil((lo + hi) / 2);
    if (ivArr[m].timestamp <= ts) lo = m;
    else hi = m - 1;
  }
  return ivArr[lo].iv;
}

function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function statsFromTrades(trades) {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, pnl: 0, pf: 0, sharpe: 0, dd: 0, expectancy: 0 };
  let wins = 0, gp = 0, gl = 0, sum = 0;
  const pnls = [];
  for (const t of trades) {
    sum += t.pnl;
    pnls.push(t.pnl);
    if (t.pnl > 0) {
      wins++;
      gp += t.pnl;
    } else {
      gl += -t.pnl;
    }
  }
  const wr = (wins / n) * 100;
  const pf = gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
  // Daily-level approximation: each trade is one trading day
  const mean = sum / n;
  const variance = pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  // Annualize: ~252 trading days; per-trade Sharpe scaled
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  // Max DD
  let peak = 0, cum = 0, maxDD = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }
  return {
    n,
    wr: +wr.toFixed(1),
    pnl: +sum.toFixed(0),
    pf: pf === Infinity ? 999 : +pf.toFixed(2),
    sharpe: +sharpe.toFixed(2),
    dd: +maxDD.toFixed(0),
    expectancy: +mean.toFixed(1),
  };
}

// Simulate a single ORB day and return trade or null
// orMinutes: 5/15/30
// stopMode: 'opposite_or' or 'fixed_pts'(unused here)
// targetSpec: { type: 'pts', value } or { type: 'r', value }
function simulateOrbDay(rthCandles, orMinutes, targetSpec, dateStr) {
  if (rthCandles.length < orMinutes + 5) return null;
  const orCandles = rthCandles.slice(0, orMinutes);
  const orHigh = Math.max(...orCandles.map((c) => c.high));
  const orLow = Math.min(...orCandles.map((c) => c.low));
  const orRange = orHigh - orLow;
  if (orRange <= 0) return null;

  // Search post-OR candles up through 11:00 ET for first valid breakout (close beyond)
  const [Y, Mo, D] = dateStr.split('-').map(Number);
  const cutoffTs = fromET(Y, Mo - 1, D, 11, 0);

  let entrySide = null;
  let entryIdx = -1;
  let entryPrice = null;
  for (let i = orMinutes; i < rthCandles.length; i++) {
    const c = rthCandles[i];
    if (c.timestamp >= cutoffTs) break; // no breakout signal in window
    if (c.close > orHigh) {
      entrySide = 'long';
      entryIdx = i;
      entryPrice = c.close;
      break;
    }
    if (c.close < orLow) {
      entrySide = 'short';
      entryIdx = i;
      entryPrice = c.close;
      break;
    }
  }
  if (!entrySide) return null;

  // Stop = opposite OR boundary
  const stopPrice = entrySide === 'long' ? orLow : orHigh;
  const stopDist = Math.abs(entryPrice - stopPrice);
  if (stopDist <= 0) return null;

  // Target
  let targetPts;
  if (targetSpec.type === 'pts') targetPts = targetSpec.value;
  else targetPts = stopDist * targetSpec.value;
  const targetPrice = entrySide === 'long' ? entryPrice + targetPts : entryPrice - targetPts;

  // Walk forward bar by bar from entryIdx+1 (entry bar already closed, fill at close)
  // Time stop at 11:00 ET
  let exitPrice = null;
  let exitReason = null;
  let exitIdx = -1;
  let mfe = 0, mae = 0;
  for (let i = entryIdx + 1; i < rthCandles.length; i++) {
    const c = rthCandles[i];
    if (c.timestamp >= cutoffTs) {
      // time stop — fill at last bar close before cutoff
      exitPrice = rthCandles[i - 1].close;
      exitReason = 'time_stop';
      exitIdx = i - 1;
      break;
    }
    // Track MFE / MAE
    if (entrySide === 'long') {
      const upMove = c.high - entryPrice;
      const downMove = entryPrice - c.low;
      if (upMove > mfe) mfe = upMove;
      if (downMove > mae) mae = downMove;
    } else {
      const downMove = entryPrice - c.low;
      const upMove = c.high - entryPrice;
      if (downMove > mfe) mfe = downMove;
      if (upMove > mae) mae = upMove;
    }
    // Pessimistic ordering: stop checked before target if both within bar
    if (entrySide === 'long') {
      if (c.low <= stopPrice && c.high >= targetPrice) {
        // Both touched; assume stop fills first
        exitPrice = stopPrice;
        exitReason = 'stop';
        exitIdx = i;
        break;
      }
      if (c.low <= stopPrice) {
        exitPrice = stopPrice;
        exitReason = 'stop';
        exitIdx = i;
        break;
      }
      if (c.high >= targetPrice) {
        exitPrice = targetPrice;
        exitReason = 'target';
        exitIdx = i;
        break;
      }
    } else {
      if (c.high >= stopPrice && c.low <= targetPrice) {
        exitPrice = stopPrice;
        exitReason = 'stop';
        exitIdx = i;
        break;
      }
      if (c.high >= stopPrice) {
        exitPrice = stopPrice;
        exitReason = 'stop';
        exitIdx = i;
        break;
      }
      if (c.low <= targetPrice) {
        exitPrice = targetPrice;
        exitReason = 'target';
        exitIdx = i;
        break;
      }
    }
  }
  if (exitPrice === null) {
    // No exit hit & no time stop triggered (window ended at last RTH bar in array)
    const last = rthCandles[rthCandles.length - 1];
    exitPrice = last.close;
    exitReason = 'eos';
    exitIdx = rthCandles.length - 1;
  }
  const pnl = entrySide === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
  return {
    date: dateStr,
    side: entrySide,
    orHigh, orLow, orRange,
    entryTs: rthCandles[entryIdx].timestamp,
    entryPrice,
    stopPrice,
    targetPrice,
    targetPts,
    stopDist,
    exitTs: rthCandles[exitIdx].timestamp,
    exitPrice,
    exitReason,
    pnl,
    mfe,
    mae,
    holdMin: Math.round((rthCandles[exitIdx].timestamp - rthCandles[entryIdx].timestamp) / 60000),
  };
}

// ----------- Main -----------

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const rolloverDates = loadRolloverDates();
  const rawNQ = await loadNQ();
  console.log('Filtering primary contract...');
  const nq = filterPrimaryContract(rawNQ);
  console.log(`  ${nq.length.toLocaleString()} primary-contract candles`);

  const ivArr = await loadQQQIV();

  const tradingDates = extractTradingDates(nq).filter((d) => d >= START_DATE && d <= END_DATE);
  console.log(`Trading dates in window: ${tradingDates.length}`);

  // Pre-build per-day RTH candles (9:30-11:00 only) and per-day context
  console.log('Building per-day context...');
  const dayContext = new Map();
  for (const dateStr of tradingDates) {
    if (rolloverDates.has(dateStr)) continue; // skip rollover days entirely
    const rth = getRTHCandlesFromArray(nq, dateStr);
    if (rth.length < 30) continue;
    // Only need first 90 minutes for ORB
    const fh = rth.filter((c) => {
      const et = toET(c.timestamp);
      return et.timeInMinutes >= 9 * 60 + 30 && et.timeInMinutes <= 11 * 60;
    });
    if (fh.length < 20) continue;

    const overnight = getOvernightCandlesFromArray(nq, dateStr);
    const prevDay = getPrevDayLevelsFromArray(nq, dateStr, tradingDates);
    if (!prevDay || overnight.length < 10) continue;

    const onHigh = Math.max(...overnight.map((c) => c.high));
    const onLow = Math.min(...overnight.map((c) => c.low));
    const onClose = overnight[overnight.length - 1].close;
    const rthOpen = fh[0].open;
    const gap = rthOpen - prevDay.close;
    const onRange = onHigh - onLow;
    // overnight_bias proxy: where in the ON range did we close? closer to high → bull bias
    const onPosition = onRange > 0 ? (onClose - onLow) / onRange : 0.5;
    // Sweep predictor proxy (T1/T2 not yet available): combine onPosition, gap, prev-day position
    const overnightBias = onPosition - 0.5; // -0.5..+0.5
    const gapDir = gap > 0 ? 'up' : gap < 0 ? 'down' : 'flat';

    // GEX snapshot at 9:30 ET
    const [Y, Mo, D] = dateStr.split('-').map(Number);
    const rthOpenTs = fromET(Y, Mo - 1, D, 9, 30);
    const gexSnaps = loadIntradayGEX('NQ', dateStr);
    let regime = null;
    if (gexSnaps && gexSnaps.length) {
      const snap = getGEXSnapshotAt(gexSnaps, rthOpenTs);
      if (snap) regime = snap.regime || null;
    }

    // IV at 9:30 ET (or nearest before)
    const iv930 = ivAt(ivArr, rthOpenTs);

    dayContext.set(dateStr, {
      fh,
      rth,
      gap,
      gapDir,
      onPosition,
      overnightBias,
      regime,
      iv930,
    });
  }
  console.log(`  ${dayContext.size} usable trading days`);

  // Build IV percentile bands using all 9:30 IV samples
  const ivSamples = [...dayContext.values()].map((d) => d.iv930).filter((v) => v != null);
  const ivP20 = pct(ivSamples, 0.2);
  const ivP80 = pct(ivSamples, 0.8);
  console.log(`  IV 20th=${ivP20?.toFixed(3)} 80th=${ivP80?.toFixed(3)}`);

  // ----------- Run sweeps -----------
  const results = {};

  // Targets to sweep
  const ptsTargets = [25, 50, 75, 100, 150, 200];
  const rTargets = [1.0, 1.5, 2.0, 3.0];
  const targetSpecs = [
    ...ptsTargets.map((v) => ({ type: 'pts', value: v, label: `${v}pt` })),
    ...rTargets.map((v) => ({ type: 'r', value: v, label: `${v}R` })),
  ];

  // OR variants for quick comparison (baseline, no filters)
  const orVariants = [5, 15, 30];

  // -------- Quick OR-length comparison (no filters) --------
  console.log('\n=== Quick OR-length comparison (no filters) ===');
  const orCompareTable = [];
  for (const orMin of orVariants) {
    for (const ts of targetSpecs) {
      const trades = [];
      for (const [date, ctx] of dayContext) {
        const t = simulateOrbDay(ctx.fh, orMin, ts, date);
        if (t) trades.push(t);
      }
      const s = statsFromTrades(trades);
      orCompareTable.push({ orMin, target: ts.label, ...s });
    }
  }
  results.orCompare = orCompareTable;

  // Print top OR/target combos by PF
  const topOR = [...orCompareTable].sort((a, b) => b.pf - a.pf).slice(0, 10);
  console.log('Top 10 OR/target combos by PF:');
  for (const r of topOR)
    console.log(
      `  OR=${r.orMin}m tgt=${r.target.padStart(6)} n=${r.n} wr=${r.wr}% pnl=${r.pnl} pf=${r.pf} sharpe=${r.sharpe} dd=${r.dd}`
    );

  // -------- Baseline (15-min OR, no filters) full target sweep --------
  console.log('\n=== Baseline 15-min ORB (no filters) ===');
  const baselineByTarget = {};
  for (const ts of targetSpecs) {
    const trades = [];
    for (const [date, ctx] of dayContext) {
      const t = simulateOrbDay(ctx.fh, 15, ts, date);
      if (t) trades.push(t);
    }
    baselineByTarget[ts.label] = { stats: statsFromTrades(trades), trades };
    const s = baselineByTarget[ts.label].stats;
    console.log(`  tgt=${ts.label.padStart(6)} n=${s.n} wr=${s.wr}% pnl=${s.pnl} pf=${s.pf} sharpe=${s.sharpe} dd=${s.dd}`);
  }
  results.baseline15 = Object.fromEntries(
    Object.entries(baselineByTarget).map(([k, v]) => [k, v.stats])
  );

  // -------- Filter sweeps (one filter at a time, on top of 15m baseline) --------
  // For each filter, test all targets; report best
  function applyFilter(date, ctx, side, filterName) {
    switch (filterName) {
      case 'gex_regime': {
        if (!ctx.regime) return false; // exclude unknown regime
        if (ctx.regime === 'strong_negative') return false;
        if (ctx.regime === 'strong_positive' && side === 'short') return false;
        return true;
      }
      case 'iv_middle60': {
        if (ctx.iv930 == null) return false;
        return ctx.iv930 > ivP20 && ctx.iv930 < ivP80;
      }
      case 'gap_direction': {
        if (side === 'long' && ctx.gapDir !== 'up') return false;
        if (side === 'short' && ctx.gapDir !== 'down') return false;
        return true;
      }
      case 'overnight_bias': {
        // long requires onPosition >= 0.55; short requires <= 0.45
        if (side === 'long' && ctx.onPosition < 0.55) return false;
        if (side === 'short' && ctx.onPosition > 0.45) return false;
        return true;
      }
      default:
        return true;
    }
  }

  const filterNames = ['gex_regime', 'iv_middle60', 'gap_direction', 'overnight_bias'];
  console.log('\n=== Single-filter sweeps (15m OR) ===');
  const filterResults = {};
  for (const fn of filterNames) {
    filterResults[fn] = {};
    let bestRow = null;
    for (const ts of targetSpecs) {
      const trades = [];
      for (const [date, ctx] of dayContext) {
        const t = simulateOrbDay(ctx.fh, 15, ts, date);
        if (!t) continue;
        if (!applyFilter(date, ctx, t.side, fn)) continue;
        trades.push(t);
      }
      const s = statsFromTrades(trades);
      filterResults[fn][ts.label] = s;
      if (s.n >= 30 && (!bestRow || s.pf > bestRow.pf || (s.pf === bestRow.pf && s.sharpe > bestRow.sharpe))) {
        bestRow = { target: ts.label, ...s };
      }
    }
    console.log(`  filter=${fn.padEnd(16)} best target=${bestRow?.target ?? 'n/a'} stats=${JSON.stringify(bestRow ?? {})}`);
  }
  results.singleFilter = filterResults;

  // -------- Combined-filter pass: try pairs and the full stack --------
  console.log('\n=== Filter combinations (15m OR) ===');
  const filterCombos = [
    ['gex_regime', 'gap_direction'],
    ['gex_regime', 'overnight_bias'],
    ['gex_regime', 'iv_middle60'],
    ['gap_direction', 'overnight_bias'],
    ['gap_direction', 'iv_middle60'],
    ['overnight_bias', 'iv_middle60'],
    ['gex_regime', 'gap_direction', 'overnight_bias'],
    ['gex_regime', 'gap_direction', 'iv_middle60'],
    ['gex_regime', 'overnight_bias', 'iv_middle60'],
    ['gap_direction', 'overnight_bias', 'iv_middle60'],
    ['gex_regime', 'gap_direction', 'overnight_bias', 'iv_middle60'],
  ];
  const comboResults = [];
  for (const combo of filterCombos) {
    const comboKey = combo.join('+');
    let bestRow = null;
    for (const ts of targetSpecs) {
      const trades = [];
      for (const [date, ctx] of dayContext) {
        const t = simulateOrbDay(ctx.fh, 15, ts, date);
        if (!t) continue;
        const ok = combo.every((fn) => applyFilter(date, ctx, t.side, fn));
        if (!ok) continue;
        trades.push(t);
      }
      const s = statsFromTrades(trades);
      if (s.n >= 25 && (!bestRow || s.pf > bestRow.pf || (s.pf === bestRow.pf && s.sharpe > bestRow.sharpe))) {
        bestRow = { target: ts.label, ...s };
      }
      comboResults.push({ combo: comboKey, target: ts.label, ...s });
    }
    console.log(`  combo=${comboKey.padEnd(60)} best=${JSON.stringify(bestRow ?? {})}`);
  }
  results.combos = comboResults;

  // Identify top-5 overall combinations (n>=25)
  const allRows = [
    ...orCompareTable.map((r) => ({ key: `OR=${r.orMin} no_filter`, ...r })),
    ...Object.entries(results.singleFilter).flatMap(([fn, by]) =>
      Object.entries(by).map(([t, s]) => ({ key: `OR=15 ${fn}`, target: t, ...s }))
    ),
    ...comboResults.map((r) => ({ key: `OR=15 ${r.combo}`, ...r })),
  ].filter((r) => r.n >= 25);
  const topByPF = [...allRows].sort((a, b) => b.pf - a.pf).slice(0, 10);
  const topBySharpe = [...allRows].sort((a, b) => b.sharpe - a.sharpe).slice(0, 10);
  const topByPnL = [...allRows].sort((a, b) => b.pnl - a.pnl).slice(0, 10);

  console.log('\n=== TOP 10 BY PF (n>=25) ===');
  for (const r of topByPF)
    console.log(`  ${r.key.padEnd(70)} tgt=${r.target.padStart(6)} n=${r.n} wr=${r.wr}% pnl=${r.pnl} pf=${r.pf} sharpe=${r.sharpe} dd=${r.dd}`);
  console.log('\n=== TOP 10 BY SHARPE (n>=25) ===');
  for (const r of topBySharpe)
    console.log(`  ${r.key.padEnd(70)} tgt=${r.target.padStart(6)} n=${r.n} wr=${r.wr}% pnl=${r.pnl} pf=${r.pf} sharpe=${r.sharpe} dd=${r.dd}`);
  console.log('\n=== TOP 10 BY PNL (n>=25) ===');
  for (const r of topByPnL)
    console.log(`  ${r.key.padEnd(70)} tgt=${r.target.padStart(6)} n=${r.n} wr=${r.wr}% pnl=${r.pnl} pf=${r.pf} sharpe=${r.sharpe} dd=${r.dd}`);

  results.topByPF = topByPF;
  results.topBySharpe = topBySharpe;
  results.topByPnL = topByPnL;

  // Build OR-range/MFE/MAE distribution from baseline 15m trades for context
  const baselineRefTrades = baselineByTarget['100pt'].trades;
  const orRanges = baselineRefTrades.map((t) => t.orRange);
  const orRangePcts = {
    p10: pct(orRanges, 0.1),
    p25: pct(orRanges, 0.25),
    p50: median(orRanges),
    p75: pct(orRanges, 0.75),
    p90: pct(orRanges, 0.9),
  };
  results.metadata = {
    startDate: START_DATE,
    endDate: END_DATE,
    daysAnalyzed: dayContext.size,
    rolloverDaysSkipped: [...rolloverDates].filter((d) => d >= START_DATE && d <= END_DATE).length,
    ivP20,
    ivP80,
    orRange15m: orRangePcts,
    timestamp: new Date().toISOString(),
  };

  // Save JSON (avoid storing every trade — keep top combos with their trades for inspection)
  // Strip per-trade arrays from baseline to keep file small; keep top combo trades only
  const out = {
    metadata: results.metadata,
    orCompare: results.orCompare,
    baseline15: results.baseline15,
    singleFilter: results.singleFilter,
    combos: results.combos,
    topByPF: results.topByPF,
    topBySharpe: results.topBySharpe,
    topByPnL: results.topByPnL,
  };
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(out, null, 2));
  console.log(`\nSaved ${OUTPUT_JSON}`);

  // -------- Build FINDINGS.md --------
  const bestPF = topByPF[0];
  const bestSharpe = topBySharpe[0];
  const bestPnL = topByPnL[0];

  // Pick a "Proposed Strategy v0" — best Sharpe with PF>=1.5 and DD reasonable, n>=40
  const strategyCandidates = allRows
    .filter((r) => r.n >= 40 && r.pf >= 1.5 && r.dd <= 800)
    .sort((a, b) => b.sharpe - a.sharpe);
  const v0 = strategyCandidates[0] || bestSharpe;

  const md = `# T4: Opening Range Breakout (ORB) with confluence filters

## TL;DR
Tested 5/15/30-min OR breakouts on NQ with first valid 1m close beyond OR after window end, stop = opposite OR boundary, time stop = 11:00 ET. Date range ${START_DATE} → ${END_DATE} (${results.metadata.daysAnalyzed} days). Baseline 15-min ORB without filters generates ~${results.baseline15['100pt']?.n ?? 'n/a'} trades with PF=${results.baseline15['100pt']?.pf ?? 'n/a'} at 100-pt target. Best filtered combination: **${v0.key}** with target=${v0.target} → ${v0.n} trades, ${v0.wr}% WR, PF=${v0.pf}, Sharpe=${v0.sharpe}, MaxDD=${v0.dd}pts, total=${v0.pnl}pts.

## Dataset
- Date range: ${START_DATE} → ${END_DATE}
- Trading days analyzed: ${results.metadata.daysAnalyzed}
- Rollover days skipped: ${results.metadata.rolloverDaysSkipped}
- NQ raw 1m via filterPrimaryContract
- GEX: \`data/gex/nq-cbbo/\` (post-bucketing-fix)
- IV: \`qqq_atm_iv_1m.csv\` 9:30 ET sample. p20=${ivP20?.toFixed(3)}, p80=${ivP80?.toFixed(3)}

## OR-length Quick Comparison (no filters)
Top 10 by PF:
| OR | Target | n | WR% | PnL(pts) | PF | Sharpe | MaxDD |
|---|---|---:|---:|---:|---:|---:|---:|
${topOR.map((r) => `| ${r.orMin}m | ${r.target} | ${r.n} | ${r.wr} | ${r.pnl} | ${r.pf} | ${r.sharpe} | ${r.dd} |`).join('\n')}

## Baseline 15-min ORB (no filters)
| Target | n | WR% | PnL | PF | Sharpe | MaxDD |
|---|---:|---:|---:|---:|---:|---:|
${Object.entries(results.baseline15).map(([t, s]) => `| ${t} | ${s.n} | ${s.wr} | ${s.pnl} | ${s.pf} | ${s.sharpe} | ${s.dd} |`).join('\n')}

## Single-filter best targets (15-min OR)
| Filter | Best target | n | WR% | PnL | PF | Sharpe | MaxDD |
|---|---|---:|---:|---:|---:|---:|---:|
${filterNames
  .map((fn) => {
    const rows = Object.entries(filterResults[fn])
      .map(([t, s]) => ({ target: t, ...s }))
      .filter((r) => r.n >= 30);
    rows.sort((a, b) => b.pf - a.pf);
    const r = rows[0];
    return r ? `| ${fn} | ${r.target} | ${r.n} | ${r.wr} | ${r.pnl} | ${r.pf} | ${r.sharpe} | ${r.dd} |` : `| ${fn} | n/a (n<30) | - | - | - | - | - | - |`;
  })
  .join('\n')}

## Top 10 combinations overall by PF (n>=25)
| Config | Target | n | WR% | PnL | PF | Sharpe | MaxDD |
|---|---|---:|---:|---:|---:|---:|---:|
${topByPF.map((r) => `| ${r.key} | ${r.target} | ${r.n} | ${r.wr} | ${r.pnl} | ${r.pf} | ${r.sharpe} | ${r.dd} |`).join('\n')}

## Top 10 by Sharpe (n>=25)
| Config | Target | n | WR% | PnL | PF | Sharpe | MaxDD |
|---|---|---:|---:|---:|---:|---:|---:|
${topBySharpe.map((r) => `| ${r.key} | ${r.target} | ${r.n} | ${r.wr} | ${r.pnl} | ${r.pf} | ${r.sharpe} | ${r.dd} |`).join('\n')}

## OR Range distribution (15m, baseline)
| p10 | p25 | p50 | p75 | p90 |
|---:|---:|---:|---:|---:|
| ${orRangePcts.p10?.toFixed(1)} | ${orRangePcts.p25?.toFixed(1)} | ${orRangePcts.p50?.toFixed(1)} | ${orRangePcts.p75?.toFixed(1)} | ${orRangePcts.p90?.toFixed(1)} |

## Proposed Strategy v0 — \`${v0.key}\`
- **Entry**: First 1m close beyond 9:30-9:45 ET OR after 9:45 ET (long if close > orHigh, short if close < orLow). Entry price = bar close.
- **Side**: Long on upside breakout, short on downside breakout.
- **Filters**: ${v0.key.includes('no_filter') ? 'None' : v0.key.split(' ').slice(1).join(' AND ')}
  - \`gex_regime\`: skip if 9:30 GEX regime = \`strong_negative\`; skip shorts if regime = \`strong_positive\`
  - \`iv_middle60\`: take only if 9:30 QQQ ATM IV is between p20 (${ivP20?.toFixed(3)}) and p80 (${ivP80?.toFixed(3)})
  - \`gap_direction\`: longs only if RTH open > prev RTH close; shorts only if RTH open < prev RTH close
  - \`overnight_bias\`: longs need overnight close in upper half of overnight range (≥0.55); shorts need ≤0.45
- **Stop**: opposite OR boundary (typical stop distance ≈ ${median(baselineRefTrades.map(t=>t.stopDist)).toFixed(1)} pts; equals OR width)
- **Target**: ${v0.target} from entry
- **Time stop**: 11:00 ET (close at last bar before 11:00 if neither stop nor target hit)
- **Expected frequency**: ${v0.n} trades over ${results.metadata.daysAnalyzed} days ≈ ${(v0.n / results.metadata.daysAnalyzed).toFixed(2)} trades/day
- **Per-trade EV**: ${(v0.pnl / v0.n).toFixed(2)} pts (≈ \$${((v0.pnl / v0.n) * 20).toFixed(0)} on 1 NQ contract)
- **PF**: ${v0.pf} | **Sharpe**: ${v0.sharpe} | **WR**: ${v0.wr}% | **MaxDD**: ${v0.dd} pts

## Backtest-engine integration sketch
- New strategy file: \`shared/strategies/orb-first-hour.js\` extending \`base-strategy.js\`.
- Subscribes to \`candle.close\` (1m) on NQ.
- State per ET trading day: \`orHigh\`, \`orLow\`, \`orFinalized\`, \`signalFired\`.
- Reset state at 9:30 ET (or first bar after the daily session boundary).
- Between 9:30:00 and 9:44:59, accumulate high/low into OR.
- At 9:45:00, finalize OR. From 9:45:00 to 11:00:00, on each closed 1m bar:
  - If \`!signalFired\` and close > orHigh and filters pass → publish \`place_market\` long with stop=\`orLow\`, target=\`entry+${v0.target.includes('R') ? 'R*orRange' : v0.target}\`.
  - If \`!signalFired\` and close < orLow and filters pass → publish \`place_market\` short, stop=\`orHigh\`.
  - Filter inputs:
    - GEX regime: from latest \`gex.levels\` snapshot at 9:30 ET
    - IV: live QQQ ATM IV at 9:30 ET (already computed in data-service)
    - Gap dir: from prev day RTH close vs today's RTH open
    - Overnight bias: position of overnight close within overnight range
- Time stop: cancel + flatten if no exit by 11:00 ET.
- CLI flags for backtester: \`--orb-or-min 15 --orb-target ${v0.target} --orb-filters "${v0.key.includes('no_filter') ? '' : v0.key.split(' ').slice(1).join(',')}"\`

## Caveats / Followups
- Entry uses 1m close; live execution should fire a market order at bar close — slippage of 1-2 pts realistic on NQ but not modeled here.
- Stop = opposite OR boundary means stop distance varies daily (median ≈ ${median(baselineRefTrades.map(t=>t.stopDist)).toFixed(1)} pts); risk per trade is non-constant. Consider a max stop cap (e.g. 80 pts).
- Both stop and target inside same bar default to stop fill — pessimistic. Real fill depends on intra-bar path; consider 1s data for top combos.
- Overnight bias is a proxy for the T1/T2 sweep predictor; once those tracks land, swap in the actual 90.5% OOS predictor.
- GEX regime skipped if no snapshot exists; check coverage = ${[...dayContext.values()].filter(d => d.regime).length} / ${dayContext.size} days have a regime label.
- All results are pre-fee, pre-slippage. NQ tick = 0.25 pt = \$5; commission ~\$1-2 per RT.
- Hold out OOS: top combos should be re-validated on Feb-Apr 2026 if not already.
`;

  fs.writeFileSync(FINDINGS_MD, md);
  console.log(`Saved ${FINDINGS_MD}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
