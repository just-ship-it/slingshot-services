#!/usr/bin/env node
/**
 * T0 — Baseline first-hour distributions for NQ
 *
 * Goal: foundation statistics for any 9:30–11:00 ET RTH NQ strategy.
 * Outputs:
 *   - first-hour (60m)  range distribution
 *   - first-90m         range distribution
 *   - MFE/MAE-from-9:30-open at 30/60/90/120 min horizons (the headline)
 *   - time-to-MFE-extreme / time-to-MAE-extreme in 9:30-11:00 window
 *   - everything stratified by gap bucket
 *   - reversal-vs-continuation conditional on first 15m bar direction
 *
 * Hard rules (CLAUDE.md / MASTER-PLAN.md):
 *   - raw contracts (NQ_ohlcv_1m.csv) + filterPrimaryContract()
 *   - skip rollover boundary days (NQ_rollover_log.csv)
 *   - all windowing in ET (toET / fromET helpers)
 *   - date range 2025-01-13 -> 2026-04-23
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { CSVLoader } from '../../src/data/csv-loader.js';
import { toET, fromET } from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NQ_OHLCV_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
const ROLLOVER_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_rollover_log.csv');
const OUTPUT_PATH   = path.join(__dirname, 'output', 'T0-baseline.json');

const START_DATE = '2025-01-13';
const END_DATE   = '2026-04-23';

const HORIZONS_MIN = [30, 60, 90, 120];

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
    min: sorted[0],
    p25: pct(sorted, 25),
    median: pct(sorted, 50),
    mean: round(mean, 2),
    p75: pct(sorted, 75),
    p90: pct(sorted, 90),
    p99: pct(sorted, 99),
    max: sorted[sorted.length - 1]
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
  const start = new Date(startDate + 'T00:00:00Z').getTime();
  const end = new Date(endDate + 'T23:59:59Z').getTime();
  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(NQ_OHLCV_PATH)
      .pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return; // skip calendar spreads
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

// -------------------- session bucketing --------------------

/**
 * Bucket candles by ET trading date and pre-compute key time slices.
 * Returns Map<dateStr, { rthCandles, prevRthClose, openCandle, ... }>
 */
function bucketByDay(candles) {
  // First pass: group by ET date
  const byDate = new Map(); // dateStr -> { all: [], rth: [], onClose: lastRTHCloseBeforeNow? }
  for (const c of candles) {
    const et = toET(c.timestamp);
    if (et.dayOfWeek === 0 || et.dayOfWeek === 6) continue; // skip weekends
    if (!byDate.has(et.date)) byDate.set(et.date, []);
    byDate.get(et.date).push({ ...c, et });
  }
  return byDate;
}

function gapBucket(gapPct) {
  // gap = (open - prev_close) / prev_close
  if (gapPct >  0.004) return 'gap_up_strong';
  if (gapPct >  0.001) return 'gap_up_mild';
  if (gapPct < -0.004) return 'gap_down_strong';
  if (gapPct < -0.001) return 'gap_down_mild';
  return 'flat';
}

const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// -------------------- core computation --------------------

function computeDailyStats(byDate, rolloverDates) {
  const dates = [...byDate.keys()].sort();
  const days = [];

  // Build prev RTH close lookup: for each date, find last RTH bar (<= 16:00 ET) on the prior trading date
  const dateIndex = new Map(dates.map((d, i) => [d, i]));

  for (let i = 0; i < dates.length; i++) {
    const dateStr = dates[i];
    if (rolloverDates.has(dateStr)) continue; // skip rollover days entirely

    const dayCandles = byDate.get(dateStr);
    if (!dayCandles || dayCandles.length < 60) continue;

    // RTH = 9:30 - 16:00 ET (timeInMinutes 570..960)
    const rth = dayCandles.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes < 960);
    if (rth.length < 90) continue; // need at least 90 RTH minutes for 9:30-11:00 window

    // 9:30 open candle (timeInMinutes === 570)
    const openCandle = rth.find(c => c.et.timeInMinutes === 570);
    if (!openCandle) continue;
    const open930 = openCandle.open;

    // first 15-min bar (570..584 inclusive)
    const first15 = rth.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes < 585);
    if (!first15.length) continue;
    const first15Close = first15[first15.length - 1].close;

    // First 60m (9:30-10:30): minutes 570..629
    const first60 = rth.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes < 630);
    // First 90m (9:30-11:00): minutes 570..659
    const first90 = rth.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes < 660);

    if (first60.length < 50 || first90.length < 80) continue;

    // 11:00 open (or last 90m close if exact 11:00 missing)
    const closeAt11 = first90[first90.length - 1].close;

    // Prior trading day's last RTH bar at or before 16:00 ET
    let prevRthClose = null;
    for (let j = i - 1; j >= Math.max(0, i - 7); j--) {
      const prevDate = dates[j];
      if (rolloverDates.has(prevDate)) continue; // skip prior rollover days too
      const prevCandles = byDate.get(prevDate);
      if (!prevCandles) continue;
      const prevRth = prevCandles.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes <= 960);
      if (prevRth.length === 0) continue;
      // last RTH bar at or before 16:00 ET
      // (16:00 ET == timeInMinutes 960; we accept up to and including the 15:59 bar i.e. <960; if a bar exists at exactly 960 take it too)
      const candidates = prevRth.filter(c => c.et.timeInMinutes <= 960);
      if (candidates.length === 0) continue;
      prevRthClose = candidates[candidates.length - 1].close;
      break;
    }
    if (prevRthClose == null) continue;

    const gapPts = open930 - prevRthClose;
    const gapPct = gapPts / prevRthClose;
    const bucket = gapBucket(gapPct);

    // Range stats
    const range60 = Math.max(...first60.map(c => c.high)) - Math.min(...first60.map(c => c.low));
    const range90 = Math.max(...first90.map(c => c.high)) - Math.min(...first90.map(c => c.low));

    // MFE / MAE from 9:30 open at horizons (using points)
    // MFE = max(high) - open930; MAE = open930 - min(low) ; both reported as positive points
    const horizonStats = {};
    for (const h of HORIZONS_MIN) {
      const slice = rth.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes < 570 + h);
      if (slice.length < Math.max(20, h - 10)) {
        horizonStats[`h${h}`] = null;
        continue;
      }
      let mfeVal = -Infinity, maeVal = -Infinity, mfeMin = Infinity, maeMin = Infinity;
      let tMfe = null, tMae = null;
      for (const c of slice) {
        const upMove = c.high - open930;
        const dnMove = open930 - c.low;
        if (upMove > mfeVal) {
          mfeVal = upMove;
          tMfe = c.et.timeInMinutes - 570;
        }
        if (dnMove > maeVal) {
          maeVal = dnMove;
          tMae = c.et.timeInMinutes - 570;
        }
      }
      horizonStats[`h${h}`] = {
        mfePts: round(mfeVal, 2),
        maePts: round(maeVal, 2),
        tToMfeMin: tMfe,
        tToMaeMin: tMae
      };
    }

    // First 15m direction (bullish if close > open of the open candle's open)
    const first15Bull = first15Close > open930;
    const first15Bear = first15Close < open930;

    // 11:00 close vs 9:30 open
    const closedAbove930 = closeAt11 > open930;

    days.push({
      date: dateStr,
      dayOfWeek: openCandle.et.dayOfWeek,
      month: openCandle.et.month + 1, // 1-12
      open930,
      prevRthClose,
      gapPts: round(gapPts, 2),
      gapPct: round(gapPct, 5),
      gapBucket: bucket,
      range60: round(range60, 2),
      range90: round(range90, 2),
      first15Bull,
      first15Bear,
      first15CloseVsOpen: round(first15Close - open930, 2),
      closeAt11: round(closeAt11, 2),
      closeAt11VsOpen: round(closeAt11 - open930, 2),
      closedAbove930,
      horizons: horizonStats
    });
  }
  return days;
}

// -------------------- distribution rollups --------------------

function rangeDistro(days, key) {
  return summary(days.map(d => d[key]).filter(v => v != null && !isNaN(v)));
}

function rangeByMonth(days, key) {
  const out = {};
  for (let m = 1; m <= 12; m++) {
    const subset = days.filter(d => d.month === m);
    if (!subset.length) continue;
    out[m] = summary(subset.map(d => d[key]));
  }
  return out;
}

function rangeByDow(days, key) {
  const out = {};
  for (let dow = 1; dow <= 5; dow++) {
    const subset = days.filter(d => d.dayOfWeek === dow);
    if (!subset.length) continue;
    out[DOW_NAMES[dow]] = summary(subset.map(d => d[key]));
  }
  return out;
}

function mfeMaeDistro(days, horizon) {
  const mfes = [];
  const maes = [];
  const tMfes = [];
  const tMaes = [];
  for (const d of days) {
    const h = d.horizons[`h${horizon}`];
    if (!h) continue;
    if (h.mfePts != null && h.mfePts >= 0) mfes.push(h.mfePts);
    if (h.maePts != null && h.maePts >= 0) maes.push(h.maePts);
    if (h.tToMfeMin != null) tMfes.push(h.tToMfeMin);
    if (h.tToMaeMin != null) tMaes.push(h.tToMaeMin);
  }
  return {
    mfe: summary(mfes),
    mae: summary(maes),
    tToMfe: summary(tMfes),
    tToMae: summary(tMaes),
    fracMfeGE: {
      '20': round(fracAtLeast(mfes, 20), 4),
      '30': round(fracAtLeast(mfes, 30), 4),
      '50': round(fracAtLeast(mfes, 50), 4),
      '75': round(fracAtLeast(mfes, 75), 4),
      '100': round(fracAtLeast(mfes, 100), 4),
      '150': round(fracAtLeast(mfes, 150), 4)
    },
    fracMaeGE: {
      '20': round(fracAtLeast(maes, 20), 4),
      '30': round(fracAtLeast(maes, 30), 4),
      '50': round(fracAtLeast(maes, 50), 4),
      '75': round(fracAtLeast(maes, 75), 4),
      '100': round(fracAtLeast(maes, 100), 4),
      '150': round(fracAtLeast(maes, 150), 4)
    }
  };
}

function mfeMaeByGap(days, horizon) {
  const buckets = ['gap_up_strong','gap_up_mild','flat','gap_down_mild','gap_down_strong'];
  const out = {};
  for (const b of buckets) {
    const subset = days.filter(d => d.gapBucket === b);
    if (!subset.length) { out[b] = null; continue; }
    out[b] = mfeMaeDistro(subset, horizon);
    out[b].nDays = subset.length;
  }
  return out;
}

function reversalContinuation(days) {
  // Conditional probabilities about close at 11:00 vs 9:30 open given first 15m direction
  const bull15 = days.filter(d => d.first15Bull);
  const bear15 = days.filter(d => d.first15Bear);

  function probs(subset, label) {
    if (!subset.length) return null;
    const cont = subset.filter(d => (label === 'bull' ? d.closedAbove930 : !d.closedAbove930)).length;
    const rev  = subset.filter(d => (label === 'bull' ? !d.closedAbove930 : d.closedAbove930)).length;
    return {
      n: subset.length,
      pContinuation: round(cont / subset.length, 4),
      pReversal: round(rev / subset.length, 4)
    };
  }

  // Also gap-stratified
  const buckets = ['gap_up_strong','gap_up_mild','flat','gap_down_mild','gap_down_strong'];
  const byGap = {};
  for (const b of buckets) {
    const sub = days.filter(d => d.gapBucket === b);
    byGap[b] = {
      bull15: probs(sub.filter(d => d.first15Bull), 'bull'),
      bear15: probs(sub.filter(d => d.first15Bear), 'bear'),
      nDays: sub.length
    };
  }

  return {
    overall: {
      bull15: probs(bull15, 'bull'),
      bear15: probs(bear15, 'bear')
    },
    byGap
  };
}

// -------------------- main --------------------

async function main() {
  const t0 = Date.now();
  console.log('='.repeat(70));
  console.log(' T0 — Baseline first-hour distributions (NQ)');
  console.log('='.repeat(70));

  const rolloverDates = loadRolloverDates();
  const candles = await loadRawNqMinute(START_DATE, END_DATE);
  const byDate  = bucketByDay(candles);

  console.log(`Trading dates seen: ${byDate.size}`);
  const days = computeDailyStats(byDate, rolloverDates);
  console.log(`Days kept after filters: ${days.length}`);

  // Gap bucket counts
  const gapCounts = {};
  for (const d of days) gapCounts[d.gapBucket] = (gapCounts[d.gapBucket] || 0) + 1;
  console.log('Gap bucket counts:', gapCounts);

  const result = {
    meta: {
      script: 'T0-baseline.js',
      generatedAt: new Date().toISOString(),
      startDate: START_DATE,
      endDate: END_DATE,
      nDays: days.length,
      gapBucketCounts: gapCounts,
      gapBucketDef: {
        gap_up_strong: 'gapPct > +0.4%',
        gap_up_mild:   '+0.1% < gapPct ≤ +0.4%',
        flat:          'abs(gapPct) ≤ 0.1%',
        gap_down_mild: '-0.4% ≤ gapPct < -0.1%',
        gap_down_strong: 'gapPct < -0.4%'
      },
      rolloverDatesSkipped: [...rolloverDates].filter(d => d >= START_DATE && d <= END_DATE).sort()
    },
    range60: {
      overall: rangeDistro(days, 'range60'),
      byMonth: rangeByMonth(days, 'range60'),
      byDow:   rangeByDow(days, 'range60'),
      byGap:   Object.fromEntries(
        ['gap_up_strong','gap_up_mild','flat','gap_down_mild','gap_down_strong'].map(b => [
          b, summary(days.filter(d => d.gapBucket === b).map(d => d.range60))
        ])
      )
    },
    range90: {
      overall: rangeDistro(days, 'range90'),
      byMonth: rangeByMonth(days, 'range90'),
      byDow:   rangeByDow(days, 'range90'),
      byGap:   Object.fromEntries(
        ['gap_up_strong','gap_up_mild','flat','gap_down_mild','gap_down_strong'].map(b => [
          b, summary(days.filter(d => d.gapBucket === b).map(d => d.range90))
        ])
      )
    },
    mfeMaeByHorizon: Object.fromEntries(
      HORIZONS_MIN.map(h => [`h${h}`, mfeMaeDistro(days, h)])
    ),
    mfeMaeByHorizonByGap: Object.fromEntries(
      HORIZONS_MIN.map(h => [`h${h}`, mfeMaeByGap(days, h)])
    ),
    reversalContinuation: reversalContinuation(days),
    perDay: days  // raw per-day rows so downstream tracks can re-aggregate
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH} (${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)} KB)`);
  console.log(`Elapsed: ${((Date.now() - t0)/1000).toFixed(1)}s`);

  // Print headline tables to console
  console.log('\nHEADLINE — MFE/MAE at 60-min horizon (points):');
  const h60 = result.mfeMaeByHorizon.h60;
  console.log('  MFE  median', h60.mfe.median, ' p75', h60.mfe.p75, ' p90', h60.mfe.p90);
  console.log('  MAE  median', h60.mae.median, ' p75', h60.mae.p75, ' p90', h60.mae.p90);
  console.log('  P(MFE>=30):', h60.fracMfeGE['30']);
  console.log('  P(MFE>=50):', h60.fracMfeGE['50']);
  console.log('  P(MFE>=100):', h60.fracMfeGE['100']);
  console.log('  P(MAE>=30):', h60.fracMaeGE['30']);
  console.log('  P(MAE>=50):', h60.fracMaeGE['50']);

  console.log('\nFirst-60m range overall:');
  console.log(' ', result.range60.overall);

  console.log('\nReversal/Continuation overall:');
  console.log(' ', result.reversalContinuation.overall);
}

main().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
