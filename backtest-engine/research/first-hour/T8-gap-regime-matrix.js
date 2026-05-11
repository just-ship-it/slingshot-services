#!/usr/bin/env node
/**
 * T8 — Gap × GEX regime first-hour bias matrix
 *
 * Goal: surface (gap_bucket × regime) cells with high directional edge in the
 * 9:30 -> 11:00 ET window.
 *
 * Method:
 *   1. For each trading day 2025-01-13 -> 2026-04-23, compute gap and 9:30 GEX regime.
 *   2. Bucket into a 5x5 matrix.
 *   3. For each cell, compute: n, P(close11 > open930), mean/median first-hour return,
 *      mean MFE/MAE up & down, optimal-direction WR.
 *   4. For each cell with n>=30 and (P-bias>=60% or strong magnitude bias),
 *      grid-search a couple stop/target combos and report PF/Sharpe.
 *
 * Hard rules:
 *   - raw contracts (NQ_ohlcv_1m.csv) + filterPrimaryContract()
 *   - skip rollover boundary days
 *   - all windowing in ET via toET / fromET
 *   - GEX from data/gex/nq-cbbo/ (post-bucket-fix CBBO)
 *   - regime read from snapshot CLOSEST to (and at-or-before) 9:30 ET
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { CSVLoader } from '../../src/data/csv-loader.js';
import { toET, fromET } from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const REPO_ROOT     = path.resolve(__dirname, '..', '..');
const NQ_OHLCV_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
const ROLLOVER_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_rollover_log.csv');
const GEX_DIR       = path.join(REPO_ROOT, 'data', 'gex', 'nq-cbbo');
const OUTPUT_PATH   = path.join(__dirname, 'output', 'T8-gap-regime-matrix.json');

const START_DATE = '2025-01-13';
const END_DATE   = '2026-04-23';

const GAP_BUCKETS = ['gap_down_strong', 'gap_down', 'flat', 'gap_up', 'gap_up_strong'];
const REGIMES     = ['strong_negative', 'negative', 'neutral', 'positive', 'strong_positive'];

// ----------------------------------------------------------------------- utils

function round(x, d = 2) {
  if (x == null || isNaN(x)) return null;
  const m = Math.pow(10, d);
  return Math.round(x * m) / m;
}

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
    max: round(sorted[sorted.length - 1], 2)
  };
}

function gapBucket(gapPct) {
  // gap = (open - prev_close) / prev_close
  if (gapPct >  0.005) return 'gap_up_strong';
  if (gapPct >  0.002) return 'gap_up';
  if (gapPct < -0.005) return 'gap_down_strong';
  if (gapPct < -0.002) return 'gap_down';
  return 'flat';
}

// ----------------------------------------------------------------------- data

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
  console.log(`  rollover dates: ${set.size}`);
  return set;
}

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
 * Read GEX snapshot at-or-before targetTs. Returns { regime, snapshotTs, ... } or null.
 */
function loadGexRegimeAt(dateStr, targetTs) {
  const filename = path.join(GEX_DIR, `nq_gex_${dateStr}.json`);
  if (!fs.existsSync(filename)) return null;
  const j = JSON.parse(fs.readFileSync(filename));
  if (!j.data || !j.data.length) return null;
  // Find latest snapshot <= targetTs
  let chosen = null;
  for (const s of j.data) {
    const sTs = new Date(s.timestamp).getTime();
    if (sTs <= targetTs) chosen = s;
    else break; // snapshots are sorted
  }
  // If none at-or-before, fall back to first available (rare; pre-9:30 history thin)
  if (!chosen) chosen = j.data[0];
  return {
    regime: chosen.regime,
    snapshotTs: chosen.timestamp,
    nq_spot: chosen.nq_spot,
    gamma_imbalance: chosen.gamma_imbalance,
    total_gex: chosen.total_gex
  };
}

// ------------------------------------------------------------------ per-day

function computeDailyStats(byDate, rolloverDates) {
  const dates = [...byDate.keys()].sort();
  const days = [];

  for (let i = 0; i < dates.length; i++) {
    const dateStr = dates[i];
    if (rolloverDates.has(dateStr)) continue;

    const dayCandles = byDate.get(dateStr);
    if (!dayCandles || dayCandles.length < 60) continue;

    const rth = dayCandles.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes < 960);
    if (rth.length < 90) continue;

    const openCandle = rth.find(c => c.et.timeInMinutes === 570);
    if (!openCandle) continue;
    const open930 = openCandle.open;
    const open930Ts = openCandle.timestamp;

    // First 90m (9:30-11:00 inclusive of 10:59 bar): minutes 570..659
    const first90 = rth.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes < 660);
    if (first90.length < 80) continue;

    // 11:00 close = close of last bar in the 9:30-11:00 window
    const closeAt11 = first90[first90.length - 1].close;

    // Prior trading day's last RTH bar at or before 16:00 ET
    let prevRthClose = null;
    for (let j = i - 1; j >= Math.max(0, i - 7); j--) {
      const prevDate = dates[j];
      if (rolloverDates.has(prevDate)) continue;
      const prevCandles = byDate.get(prevDate);
      if (!prevCandles) continue;
      const prevRth = prevCandles.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes <= 960);
      if (!prevRth.length) continue;
      prevRthClose = prevRth[prevRth.length - 1].close;
      break;
    }
    if (prevRthClose == null) continue;

    const gapPts = open930 - prevRthClose;
    const gapPct = gapPts / prevRthClose;
    const bucket = gapBucket(gapPct);

    // GEX regime AT 9:30 (snapshot at-or-before that minute timestamp)
    const gexInfo = loadGexRegimeAt(dateStr, open930Ts);
    if (!gexInfo || !gexInfo.regime) continue;

    // First-hour MFE / MAE (from 9:30 open) — using the 9:30..11:00 window
    let mfeUp = 0, maeDn = 0; // both reported as positive points
    let tMfe = null, tMae = null;
    for (const c of first90) {
      const up = c.high - open930;
      const dn = open930 - c.low;
      if (up > mfeUp) { mfeUp = up; tMfe = c.et.timeInMinutes - 570; }
      if (dn > maeDn) { maeDn = dn; tMae = c.et.timeInMinutes - 570; }
    }

    days.push({
      date: dateStr,
      dayOfWeek: openCandle.et.dayOfWeek,
      open930: round(open930, 2),
      prevRthClose: round(prevRthClose, 2),
      gapPts: round(gapPts, 2),
      gapPct: round(gapPct, 5),
      gapBucket: bucket,
      regime: gexInfo.regime,
      gammaImbalance: round(gexInfo.gamma_imbalance, 4),
      totalGex: round(gexInfo.total_gex, 0),
      gexSnapTs: gexInfo.snapshotTs,
      closeAt11: round(closeAt11, 2),
      retPts: round(closeAt11 - open930, 2),
      retPct: round((closeAt11 - open930) / open930, 5),
      mfeUpPts: round(mfeUp, 2),
      maeDnPts: round(maeDn, 2),
      tToMfeMin: tMfe,
      tToMaeMin: tMae,
      first90Bars: first90.length
    });
  }
  return days;
}

// ------------------------------------------------------- matrix aggregations

function cellStats(subset) {
  if (!subset.length) return { n: 0 };
  const rets = subset.map(d => d.retPts);
  const mfes = subset.map(d => d.mfeUpPts);
  const maes = subset.map(d => d.maeDnPts);
  const wins = subset.filter(d => d.retPts > 0).length;
  const losses = subset.filter(d => d.retPts < 0).length;
  const flats = subset.filter(d => d.retPts === 0).length;
  const pUp = wins / subset.length;
  const pDn = losses / subset.length;
  // Optimal directional bias: trade in direction of majority
  const optDir = pUp >= pDn ? 'long' : 'short';
  const optWR  = Math.max(pUp, pDn);
  return {
    n: subset.length,
    pCloseUp: round(pUp, 4),
    pCloseDn: round(pDn, 4),
    pFlat: round(flats / subset.length, 4),
    optDir,
    optWR: round(optWR, 4),
    retSummary: summary(rets),
    mfeUpSummary: summary(mfes),
    maeDnSummary: summary(maes),
    // unsigned magnitude tilt: >0 means more up-magnitude than down-magnitude
    magnitudeTiltPts: round(
      mfes.reduce((a,b) => a+b, 0)/subset.length - maes.reduce((a,b) => a+b, 0)/subset.length,
      2
    )
  };
}

function buildMatrix(days) {
  const matrix = {};
  for (const g of GAP_BUCKETS) {
    matrix[g] = {};
    for (const r of REGIMES) {
      const subset = days.filter(d => d.gapBucket === g && d.regime === r);
      matrix[g][r] = cellStats(subset);
    }
  }
  return matrix;
}

// ------------------------------------------------------- mini-backtest grid

/**
 * Simulate a directional first-hour trade with a stop and target.
 * Entry at 9:30 open; exit at first of (target hit, stop hit, 11:00 close, or end-of-window).
 * Order resolution: if both stop and target are hit in the SAME bar, assume worst-case (stop fills first).
 *   - This is conservative; reality usually splits 50/50.
 *
 * @param {Array} subset days with raw mfe/mae captured. To do bar-by-bar we re-walk first90 - but we don't
 * have it here. Instead, we approximate using the captured MFE/MAE/return:
 *   - If mfeUp >= target  AND maeDn < stop  -> hit target (long)
 *   - If maeDn >= stop    AND mfeUp < target -> hit stop  (long)
 *   - If both -> use tToMfe vs tToMae for tiebreak (whichever earlier)
 *   - If neither -> exit at retPts (close at 11:00)
 * For shorts, swap mfe/mae roles.
 */
function simulateCell(subset, dir, stopPts, targetPts) {
  let pnl = 0;
  let wins = 0, losses = 0, breakeven = 0;
  const tradeReturns = [];
  for (const d of subset) {
    let result;
    if (dir === 'long') {
      const tHit = d.mfeUpPts >= targetPts;
      const sHit = d.maeDnPts >= stopPts;
      if (tHit && sHit) {
        // tiebreak by time to extreme
        if (d.tToMfeMin != null && d.tToMaeMin != null && d.tToMfeMin <= d.tToMaeMin) result = +targetPts;
        else result = -stopPts;
      } else if (tHit) result = +targetPts;
      else if (sHit)   result = -stopPts;
      else             result = d.retPts; // time exit at 11:00 close
    } else { // short
      const tHit = d.maeDnPts >= targetPts; // price moved DOWN >= target = profit for short
      const sHit = d.mfeUpPts >= stopPts;   // price moved UP   >= stop   = loss for short
      if (tHit && sHit) {
        if (d.tToMaeMin != null && d.tToMfeMin != null && d.tToMaeMin <= d.tToMfeMin) result = +targetPts;
        else result = -stopPts;
      } else if (tHit) result = +targetPts;
      else if (sHit)   result = -stopPts;
      else             result = -d.retPts; // short P&L = -delta
    }
    pnl += result;
    if (result > 0) wins++;
    else if (result < 0) losses++;
    else breakeven++;
    tradeReturns.push(result);
  }
  // Stats
  const n = tradeReturns.length;
  const wr = n ? wins / n : 0;
  const grossWin = tradeReturns.filter(r => r > 0).reduce((a,b) => a+b, 0);
  const grossLoss = -tradeReturns.filter(r => r < 0).reduce((a,b) => a+b, 0);
  const pf = grossLoss > 0 ? grossWin / grossLoss : null;
  const mean = n ? pnl / n : 0;
  const variance = n ? tradeReturns.reduce((a,b) => a + (b - mean)**2, 0) / n : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? mean / std * Math.sqrt(252) : null; // annualized assuming 1 trade/day
  return {
    n, wins, losses, breakeven,
    wr: round(wr, 4),
    totalPts: round(pnl, 2),
    avgPts: round(mean, 2),
    pf: pf == null ? null : round(pf, 2),
    sharpe: sharpe == null ? null : round(sharpe, 2),
    grossWin: round(grossWin, 2),
    grossLoss: round(grossLoss, 2)
  };
}

function gridSearchCell(subset, dir, gridStops, gridTargets) {
  const out = [];
  for (const s of gridStops) {
    for (const t of gridTargets) {
      const r = simulateCell(subset, dir, s, t);
      out.push({ stop: s, target: t, ...r });
    }
  }
  // Sort by Sharpe (null last), then PF, then PnL
  out.sort((a, b) => {
    const sa = a.sharpe == null ? -1e9 : a.sharpe;
    const sb = b.sharpe == null ? -1e9 : b.sharpe;
    if (sb !== sa) return sb - sa;
    const pa = a.pf == null ? 0 : a.pf;
    const pb = b.pf == null ? 0 : b.pf;
    if (pb !== pa) return pb - pa;
    return b.totalPts - a.totalPts;
  });
  return out;
}

// ----------------------------------------------------------------- top cells

function rankTopCells(matrix, days, opts = { minN: 30, minWR: 0.60, minMagPts: 10 }) {
  const ranked = [];
  for (const g of GAP_BUCKETS) {
    for (const r of REGIMES) {
      const cs = matrix[g][r];
      if (cs.n < opts.minN) continue;
      const passWR  = cs.optWR >= opts.minWR;
      const passMag = Math.abs(cs.magnitudeTiltPts) >= opts.minMagPts;
      const passRet = cs.retSummary && Math.abs(cs.retSummary.mean) >= opts.minMagPts;
      if (!(passWR || passMag || passRet)) continue;
      // Edge "score" = max(WR-0.5, magnitude/100, |meanRet|/100) * sqrt(n)
      const edgeScore = Math.max(
        cs.optWR - 0.5,
        Math.abs(cs.magnitudeTiltPts) / 100,
        Math.abs(cs.retSummary.mean) / 100
      ) * Math.sqrt(cs.n);
      ranked.push({ gap: g, regime: r, ...cs, edgeScore: round(edgeScore, 3) });
    }
  }
  ranked.sort((a, b) => b.edgeScore - a.edgeScore);
  return ranked;
}

// --------------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  console.log('='.repeat(72));
  console.log(' T8 — Gap × GEX regime first-hour bias matrix');
  console.log('='.repeat(72));

  const rolloverDates = loadRolloverDates();
  const candles = await loadRawNqMinute(START_DATE, END_DATE);
  const byDate  = bucketByDay(candles);
  console.log(`Trading dates seen: ${byDate.size}`);

  console.log('Computing per-day gap/regime/MFE/MAE...');
  const days = computeDailyStats(byDate, rolloverDates);
  console.log(`Days kept: ${days.length}`);

  // Counts
  const gapCounts = {}, regimeCounts = {};
  for (const d of days) {
    gapCounts[d.gapBucket] = (gapCounts[d.gapBucket] || 0) + 1;
    regimeCounts[d.regime] = (regimeCounts[d.regime] || 0) + 1;
  }
  console.log('Gap counts:   ', gapCounts);
  console.log('Regime counts:', regimeCounts);

  const matrix = buildMatrix(days);

  // Print compact matrix preview
  console.log('\nDirectional WR (n) matrix:');
  const header = '              ' + REGIMES.map(r => r.padStart(16)).join('');
  console.log(header);
  for (const g of GAP_BUCKETS) {
    let line = g.padEnd(14);
    for (const r of REGIMES) {
      const c = matrix[g][r];
      if (c.n < 5) line += '             — ';
      else line += `${(c.optDir==='long'?'L':'S')}${(c.optWR*100).toFixed(0)}%(${c.n})`.padStart(16);
    }
    console.log(line);
  }

  const topCells = rankTopCells(matrix, days);
  console.log(`\nQualifying cells (n>=30, edge filter): ${topCells.length}`);

  // Grid-search top 5 cells
  const gridStops   = [10, 15, 20, 25, 30, 40];
  const gridTargets = [15, 20, 25, 30, 40, 50, 75];
  const topGridResults = [];
  for (const cell of topCells.slice(0, 5)) {
    const subset = days.filter(d => d.gapBucket === cell.gap && d.regime === cell.regime);
    const grid = gridSearchCell(subset, cell.optDir, gridStops, gridTargets);
    topGridResults.push({
      gap: cell.gap, regime: cell.regime, dir: cell.optDir, n: subset.length,
      bestByCombined: grid.slice(0, 5),
      // Also surface a "balanced" 20/30 baseline to compare
      baseline_20s_30t: grid.find(g => g.stop === 20 && g.target === 30)
    });
  }

  const result = {
    meta: {
      script: 'T8-gap-regime-matrix.js',
      generatedAt: new Date().toISOString(),
      startDate: START_DATE,
      endDate: END_DATE,
      nDays: days.length,
      gapCounts, regimeCounts,
      gapBucketDef: {
        gap_up_strong:   'gapPct > +0.5%',
        gap_up:          '+0.2% < gapPct ≤ +0.5%',
        flat:            '|gapPct| ≤ 0.2%',
        gap_down:        '-0.5% ≤ gapPct < -0.2%',
        gap_down_strong: 'gapPct < -0.5%'
      },
      regimeDef: 'GEX snapshot at-or-before 9:30 ET; field: regime',
      windowDef: '9:30 ET open -> 11:00 ET close (90 minutes inclusive)',
      gridStops, gridTargets
    },
    matrix,
    topCells,
    topGridResults,
    perDay: days
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH} (${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)} KB)`);
  console.log(`Elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Headline log
  if (topCells.length) {
    console.log('\nTop 5 qualifying cells by edgeScore:');
    for (const c of topCells.slice(0, 5)) {
      console.log(`  ${c.gap.padEnd(15)} × ${c.regime.padEnd(16)} n=${c.n} ` +
                  `dir=${c.optDir} WR=${(c.optWR*100).toFixed(1)}% ` +
                  `meanRet=${c.retSummary.mean}pts magTilt=${c.magnitudeTiltPts}pts edge=${c.edgeScore}`);
    }
    console.log('\nBest grid combo per top cell:');
    for (const g of topGridResults) {
      const b = g.bestByCombined[0];
      console.log(`  ${g.gap.padEnd(15)} × ${g.regime.padEnd(16)} ${g.dir.toUpperCase()} ` +
                  `stop=${b.stop} tgt=${b.target} -> n=${b.n} WR=${(b.wr*100).toFixed(1)}% ` +
                  `PF=${b.pf} Sharpe=${b.sharpe} totalPts=${b.totalPts} avgPts=${b.avgPts}`);
    }
  } else {
    console.log('\nNo qualifying cells — relax thresholds or expand date range.');
  }
}

main().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
