#!/usr/bin/env node
/**
 * T9 — Day-of-week and event-day stratification of NQ first-hour behavior
 *
 * Hypothesis: Certain weekdays and macro-event days have first-hour distributions so
 * different from baseline that any first-hour strategy should explicitly skip them
 * (or adjust stops/targets). This is a kill-switch / regime study, NOT a strategy.
 *
 * Output:
 *   - per-day raw stats (range/MFE/MAE/direction at h60 + h90)
 *   - weekday rollups vs baseline
 *   - event-day rollups for: FOMC, CPI, NFP, PCE, NVDA earnings
 *     plus T-1 / T+1 adjacency to detect lingering distortion
 *   - recommended kill-list (which day-types to skip / which to widen stops on)
 *
 * Hard rules (CLAUDE.md / MASTER-PLAN.md):
 *   - raw contracts (NQ_ohlcv_1m.csv) + filterPrimaryContract()
 *   - skip rollover boundary days (NQ_rollover_log.csv)
 *   - all windowing in ET (toET helper)
 *   - date range 2025-01-13 -> 2026-04-23
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { CSVLoader } from '../../src/data/csv-loader.js';
import { toET } from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NQ_OHLCV_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
const ROLLOVER_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_rollover_log.csv');
const OUTPUT_PATH   = path.join(__dirname, 'output', 'T9-dow-events.json');

const START_DATE = '2025-01-13';
const END_DATE   = '2026-04-23';
const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ============================================================
// EVENT CALENDAR (researched 2026-05-09)
// ============================================================

// FOMC = day OF the policy statement (2 PM ET). Schedule is 2-day meetings;
// the trade-relevant date is the SECOND day. (Source: federalreserve.gov FOMC calendar)
const FOMC_DATES = [
  // 2025
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
  '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  // 2026
  '2026-01-28', '2026-03-18', '2026-04-29',
];

// CPI release dates 8:30 ET (BLS). 2025: standard 2nd Wed pattern; 2025 Sep CPI was
// rescheduled to 2025-09-11 (originally 9/10). Oct 2025 release affected by gov't
// shutdown (delayed/skipped — only Sep CPI released as combined report on 10/24/2025).
// Source: BLS 2025-lapse-revised-release-dates page + standard release archive.
const CPI_DATES = [
  // 2025
  '2025-01-15', '2025-02-12', '2025-03-12', '2025-04-10', '2025-05-13', '2025-06-11',
  '2025-07-15', '2025-08-12', '2025-09-11',
  // Oct 2025 CPI postponed by shutdown -> released 2025-10-24 (covers Sep)
  '2025-10-24',
  // Nov 2025 CPI -> released 2025-12-18 (combined Nov+adjusted)
  '2025-12-18',
  // 2026
  '2026-01-13', '2026-02-11', '2026-03-12', '2026-04-14',
];

// NFP / Employment Situation, first Friday at 8:30 ET. 2025-10-03 NFP was POSTPONED
// by gov't shutdown -> Sep employment report released 2025-11-20.
// Source: BLS empsit schedule.
const NFP_DATES = [
  // 2025
  '2025-01-10', '2025-02-07', '2025-03-07', '2025-04-04', '2025-05-02', '2025-06-06',
  '2025-07-03', '2025-08-01', '2025-09-05',
  // Oct NFP postponed -> released 2025-11-20 (Thu, not Fri)
  '2025-11-20',
  // 2026
  '2026-01-09', '2026-02-06', '2026-03-06', '2026-04-03',
];

// PCE = monthly Personal Income & Outlays, BEA, 8:30 ET. Usually last business day
// of month (or last Friday for some months). 2025: Sep PCE delayed by shutdown,
// released combined w/ Oct as 2025-12-19. Source: BEA release schedule.
const PCE_DATES = [
  // 2025
  '2025-01-31', '2025-02-28', '2025-03-28', '2025-04-30', '2025-05-30', '2025-06-27',
  '2025-07-31', '2025-08-29', '2025-09-26',
  // Oct PCE was delayed; combined Sep+Oct released 2025-12-19
  '2025-12-19',
  // Nov PCE released early Jan
  '2026-01-09',
  // 2026
  '2026-01-30', '2026-02-27', '2026-03-27',
];

// NVDA earnings: AMC (after market close), so the trade-impacted day is the NEXT
// trading day's open. We tag BOTH the AMC day (T0_evening) and the next morning (T+1)
// so the "first-hour reaction" naturally falls on the T+1 row.
// Source: NVIDIA investor relations + Wallstreetzen historical.
const NVDA_EARNINGS_AMC = [
  '2025-02-26', // FY25 Q4
  '2025-05-28', // FY26 Q1
  '2025-08-27', // FY26 Q2
  '2025-11-19', // FY26 Q3
  '2026-02-25', // FY26 Q4
];

// US market holidays / half-days in our window (NYSE schedule)
const US_HOLIDAYS = new Set([
  '2025-01-20','2025-02-17','2025-04-18','2025-05-26','2025-06-19',
  '2025-07-04','2025-09-01','2025-11-27','2025-12-25',
  '2026-01-19','2026-02-16','2026-04-03',
]);

// ============================================================
// helpers
// ============================================================

function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function round(x, d = 2) {
  if (x == null || isNaN(x)) return null;
  const m = Math.pow(10, d);
  return Math.round(x * m) / m;
}

function summary(arr) {
  if (!arr.length) return { n: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / sorted.length;
  const stdev = Math.sqrt(variance);
  return {
    n: sorted.length,
    min: round(sorted[0], 2),
    p25: round(pct(sorted, 25), 2),
    median: round(pct(sorted, 50), 2),
    mean: round(mean, 2),
    p75: round(pct(sorted, 75), 2),
    p90: round(pct(sorted, 90), 2),
    max: round(sorted[sorted.length - 1], 2),
    stdev: round(stdev, 2),
  };
}

function fracAtLeast(arr, threshold) {
  if (!arr.length) return null;
  const n = arr.filter(v => v >= threshold).length;
  return round(n / arr.length, 4);
}

function shiftDate(dateStr, days) {
  // shift a YYYY-MM-DD by integer days (calendar, not trading)
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().split('T')[0];
}

// ============================================================
// data load (mirrors T0)
// ============================================================

async function loadRawNqMinute(startDate, endDate) {
  console.log(`Loading raw NQ 1m candles ${startDate} → ${endDate}...`);
  const start = new Date(startDate + 'T00:00:00Z').getTime();
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
          symbol: row.symbol,
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

// ============================================================
// per-day computation (subset of T0; we only need range, MFE, MAE, direction)
// ============================================================

function computeDailyStats(byDate, rolloverDates) {
  const dates = [...byDate.keys()].sort();
  const days = [];

  for (let i = 0; i < dates.length; i++) {
    const dateStr = dates[i];
    if (rolloverDates.has(dateStr)) continue;
    if (US_HOLIDAYS.has(dateStr)) continue;

    const dayCandles = byDate.get(dateStr);
    if (!dayCandles || dayCandles.length < 60) continue;

    const rth = dayCandles.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes < 960);
    if (rth.length < 90) continue;

    const openCandle = rth.find(c => c.et.timeInMinutes === 570);
    if (!openCandle) continue;
    const open930 = openCandle.open;

    // 9:30 - 10:30 (60m) and 9:30 - 11:00 (90m)
    const first60 = rth.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes < 630);
    const first90 = rth.filter(c => c.et.timeInMinutes >= 570 && c.et.timeInMinutes < 660);
    if (first60.length < 50 || first90.length < 80) continue;

    const range60 = Math.max(...first60.map(c => c.high)) - Math.min(...first60.map(c => c.low));
    const range90 = Math.max(...first90.map(c => c.high)) - Math.min(...first90.map(c => c.low));

    const mfe60 = Math.max(...first60.map(c => c.high)) - open930;
    const mae60 = open930 - Math.min(...first60.map(c => c.low));
    const mfe90 = Math.max(...first90.map(c => c.high)) - open930;
    const mae90 = open930 - Math.min(...first90.map(c => c.low));

    const close11 = first90[first90.length - 1].close;
    const directional60 = first60[first60.length - 1].close - open930; // 10:30 close - 9:30 open
    const directional90 = close11 - open930;
    const sign60 = directional60 > 0 ? 1 : (directional60 < 0 ? -1 : 0);
    const sign90 = directional90 > 0 ? 1 : (directional90 < 0 ? -1 : 0);

    days.push({
      date: dateStr,
      dayOfWeek: openCandle.et.dayOfWeek,
      dowName: DOW_NAMES[openCandle.et.dayOfWeek],
      month: openCandle.et.month + 1,
      open930: round(open930, 2),
      range60: round(range60, 2),
      range90: round(range90, 2),
      mfe60: round(mfe60, 2),
      mae60: round(mae60, 2),
      mfe90: round(mfe90, 2),
      mae90: round(mae90, 2),
      directional60: round(directional60, 2),
      directional90: round(directional90, 2),
      sign60,
      sign90,
    });
  }
  return days;
}

// ============================================================
// event tagging
// ============================================================

function nextTradingDate(dateStr, validDates) {
  // find the first date in validDates that is strictly after dateStr
  // validDates is sorted
  for (const d of validDates) {
    if (d > dateStr) return d;
  }
  return null;
}

function tagEvents(days) {
  const validDates = days.map(d => d.date); // already sorted
  const validSet = new Set(validDates);

  const fomc   = new Set(FOMC_DATES.filter(d => validSet.has(d)));
  const cpi    = new Set(CPI_DATES.filter(d => validSet.has(d)));
  const nfp    = new Set(NFP_DATES.filter(d => validSet.has(d)));
  const pce    = new Set(PCE_DATES.filter(d => validSet.has(d)));

  // NVDA: tag the NEXT trading day after AMC announcement (the morning of the reaction)
  const nvdaReact = new Set();
  for (const amcDate of NVDA_EARNINGS_AMC) {
    // find next trading day in our dataset
    const nxt = nextTradingDate(amcDate, validDates);
    if (nxt) nvdaReact.add(nxt);
  }

  // T-1 / T+1 adjacency for each event
  function adj(set, offsetDays) {
    const out = new Set();
    for (const d of set) {
      const dayIdx = validDates.indexOf(d);
      if (dayIdx < 0) continue;
      const tgtIdx = dayIdx + offsetDays;
      if (tgtIdx >= 0 && tgtIdx < validDates.length) out.add(validDates[tgtIdx]);
    }
    return out;
  }

  const fomcMinus1 = adj(fomc, -1);
  const fomcPlus1  = adj(fomc, +1);
  const cpiMinus1  = adj(cpi, -1);
  const cpiPlus1   = adj(cpi, +1);
  const nfpMinus1  = adj(nfp, -1);
  const nfpPlus1   = adj(nfp, +1);
  const pceMinus1  = adj(pce, -1);
  const pcePlus1   = adj(pce, +1);
  const nvdaPlus1  = adj(nvdaReact, +1); // NVDA T+2 trading day from announcement

  for (const d of days) {
    d.events = {
      fomc:   fomc.has(d.date),
      cpi:    cpi.has(d.date),
      nfp:    nfp.has(d.date),
      pce:    pce.has(d.date),
      nvdaReact: nvdaReact.has(d.date),
      fomcMinus1: fomcMinus1.has(d.date),
      fomcPlus1:  fomcPlus1.has(d.date),
      cpiMinus1:  cpiMinus1.has(d.date),
      cpiPlus1:   cpiPlus1.has(d.date),
      nfpMinus1:  nfpMinus1.has(d.date),
      nfpPlus1:   nfpPlus1.has(d.date),
      pceMinus1:  pceMinus1.has(d.date),
      pcePlus1:   pcePlus1.has(d.date),
      nvdaPlus1:  nvdaPlus1.has(d.date),
    };
    // any major event (excluding adjacency) flag
    d.events.anyMajor = d.events.fomc || d.events.cpi || d.events.nfp || d.events.pce || d.events.nvdaReact;
  }

  return {
    counts: {
      fomc: fomc.size,
      cpi: cpi.size,
      nfp: nfp.size,
      pce: pce.size,
      nvdaReact: nvdaReact.size,
    },
    sets: {
      fomc, cpi, nfp, pce, nvdaReact,
      fomcMinus1, fomcPlus1, cpiMinus1, cpiPlus1,
      nfpMinus1, nfpPlus1, pceMinus1, pcePlus1, nvdaPlus1,
    },
  };
}

// ============================================================
// rollups
// ============================================================

const METRICS = ['range60','range90','mfe60','mae60','mfe90','mae90'];

function dayMetricsBundle(subset) {
  if (!subset.length) return { n: 0 };
  const out = { n: subset.length };
  for (const m of METRICS) {
    out[m] = summary(subset.map(d => d[m]).filter(v => v != null));
  }
  // directional WR (sign90 == +1) and pAbsMove
  const pBull90 = subset.filter(d => d.sign90 > 0).length / subset.length;
  const pBear90 = subset.filter(d => d.sign90 < 0).length / subset.length;
  out.pBull90 = round(pBull90, 4);
  out.pBear90 = round(pBear90, 4);
  out.directional90 = summary(subset.map(d => d.directional90));
  // |directional90| (signed move size)
  out.absDirectional90 = summary(subset.map(d => Math.abs(d.directional90)));
  // P(MFE>=20/30/50) and P(MAE>=20/30/50) at 60 and 90
  out.fracMfeGE_h60 = {
    20: fracAtLeast(subset.map(d => d.mfe60), 20),
    30: fracAtLeast(subset.map(d => d.mfe60), 30),
    50: fracAtLeast(subset.map(d => d.mfe60), 50),
  };
  out.fracMaeGE_h60 = {
    20: fracAtLeast(subset.map(d => d.mae60), 20),
    30: fracAtLeast(subset.map(d => d.mae60), 30),
    50: fracAtLeast(subset.map(d => d.mae60), 50),
  };
  return out;
}

function compareToBaseline(subset, baseline, label) {
  const sub = dayMetricsBundle(subset);
  const out = { label, n: sub.n };
  for (const m of METRICS) {
    if (!sub[m] || !baseline[m]) continue;
    const baseMed = baseline[m].median;
    const baseMean = baseline[m].mean;
    const baseStd = baseline[m].stdev;
    out[m] = {
      median: sub[m].median,
      median_vs_base: baseMed ? round(sub[m].median / baseMed, 3) : null,
      mean: sub[m].mean,
      mean_vs_base: baseMean ? round(sub[m].mean / baseMean, 3) : null,
      stdev: sub[m].stdev,
      stdev_vs_base: baseStd ? round(sub[m].stdev / baseStd, 3) : null,
      p90: sub[m].p90,
    };
  }
  out.directional90 = sub.directional90;
  out.absDirectional90 = {
    median: sub.absDirectional90.median,
    mean: sub.absDirectional90.mean,
    median_vs_base: baseline.absDirectional90.median ? round(sub.absDirectional90.median / baseline.absDirectional90.median, 3) : null,
    mean_vs_base: baseline.absDirectional90.mean ? round(sub.absDirectional90.mean / baseline.absDirectional90.mean, 3) : null,
  };
  out.pBull90 = sub.pBull90;
  out.pBear90 = sub.pBear90;
  out.pBull90_delta = baseline.pBull90 != null ? round(sub.pBull90 - baseline.pBull90, 4) : null;
  out.fracMfeGE_h60 = sub.fracMfeGE_h60;
  out.fracMaeGE_h60 = sub.fracMaeGE_h60;
  return out;
}

// ============================================================
// rule builder for kill-list
// ============================================================

function ruleScore(comparison) {
  // higher = more distorted from baseline. uses range60 stdev ratio as primary signal.
  let score = 0;
  if (comparison.range60?.stdev_vs_base) score += Math.abs(comparison.range60.stdev_vs_base - 1);
  if (comparison.mae60?.median_vs_base) score += Math.abs(comparison.mae60.median_vs_base - 1);
  if (comparison.mfe60?.median_vs_base) score += Math.abs(comparison.mfe60.median_vs_base - 1);
  if (comparison.absDirectional90?.median_vs_base) score += Math.abs(comparison.absDirectional90.median_vs_base - 1);
  return round(score, 3);
}

// ============================================================
// main
// ============================================================

async function main() {
  const t0 = Date.now();
  console.log('='.repeat(70));
  console.log(' T9 — Day-of-week & event-day stratification (NQ first hour)');
  console.log('='.repeat(70));

  const rolloverDates = loadRolloverDates();
  console.log(`  rollover dates: ${rolloverDates.size}`);
  const candles = await loadRawNqMinute(START_DATE, END_DATE);
  const byDate  = bucketByDay(candles);

  console.log(`Trading dates seen: ${byDate.size}`);
  const days = computeDailyStats(byDate, rolloverDates);
  console.log(`Days kept after filters: ${days.length}`);

  const eventInfo = tagEvents(days);
  console.log('Event counts in window:', eventInfo.counts);

  // baseline = ALL days (we will compare event/dow subsets to this)
  const baseline = dayMetricsBundle(days);

  // baseline excluding any major event (true "calm day" baseline)
  const calmDays = days.filter(d => !d.events.anyMajor);
  const calmBaseline = dayMetricsBundle(calmDays);

  // ----- weekday rollups -----
  const weekday = {};
  for (let dow = 1; dow <= 5; dow++) {
    const subset = days.filter(d => d.dayOfWeek === dow);
    weekday[DOW_NAMES[dow]] = compareToBaseline(subset, baseline, DOW_NAMES[dow]);
  }
  // weekday with calm days only (strip events to see "clean" weekday effect)
  const weekdayCalm = {};
  for (let dow = 1; dow <= 5; dow++) {
    const subset = calmDays.filter(d => d.dayOfWeek === dow);
    weekdayCalm[DOW_NAMES[dow]] = compareToBaseline(subset, calmBaseline, DOW_NAMES[dow] + '_calm');
  }

  // ----- event-day rollups -----
  const events = {};
  const eventSpec = [
    ['fomc', 'FOMC'],
    ['cpi', 'CPI'],
    ['nfp', 'NFP'],
    ['pce', 'PCE'],
    ['nvdaReact', 'NVDA_T+1'],
    ['fomcMinus1', 'FOMC_T-1'],
    ['fomcPlus1', 'FOMC_T+1'],
    ['cpiMinus1', 'CPI_T-1'],
    ['cpiPlus1', 'CPI_T+1'],
    ['nfpMinus1', 'NFP_T-1'],
    ['nfpPlus1', 'NFP_T+1'],
    ['pceMinus1', 'PCE_T-1'],
    ['pcePlus1', 'PCE_T+1'],
    ['nvdaPlus1', 'NVDA_T+2'],
  ];
  for (const [key, label] of eventSpec) {
    const subset = days.filter(d => d.events[key]);
    events[label] = compareToBaseline(subset, baseline, label);
    events[label].score = ruleScore(events[label]);
  }
  // any major event
  events['ANY_MAJOR_EVENT'] = compareToBaseline(days.filter(d => d.events.anyMajor), baseline, 'ANY_MAJOR_EVENT');
  events['ANY_MAJOR_EVENT'].score = ruleScore(events['ANY_MAJOR_EVENT']);

  // ----- baseline-vs-calm comparison (purely informational) -----
  const allVsCalm = compareToBaseline(days, calmBaseline, 'ALL_DAYS_vs_calm');

  // ----- ranked kill-list -----
  const ranked = Object.entries(events)
    .filter(([k]) => k !== 'ANY_MAJOR_EVENT')
    .map(([k, v]) => ({
      eventType: k,
      n: v.n,
      score: v.score,
      range60_median_x: v.range60?.median_vs_base,
      mae60_median_x: v.mae60?.median_vs_base,
      mfe60_median_x: v.mfe60?.median_vs_base,
      absDir90_median_x: v.absDirectional90?.median_vs_base,
      pBull90: v.pBull90,
      pBull90_delta: v.pBull90_delta,
    }))
    .sort((a, b) => b.score - a.score);

  const result = {
    meta: {
      script: 'T9-dow-events.js',
      generatedAt: new Date().toISOString(),
      startDate: START_DATE,
      endDate: END_DATE,
      nDaysTotal: days.length,
      nDaysCalm: calmDays.length,
      eventCounts: eventInfo.counts,
      excludedHolidays: [...US_HOLIDAYS].sort(),
      rolloverDatesSkipped: [...rolloverDates].filter(d => d >= START_DATE && d <= END_DATE).sort(),
    },
    baseline_all: baseline,
    baseline_calm: calmBaseline,
    weekday_all: weekday,
    weekday_calm: weekdayCalm,
    events,
    rankedKillList: ranked,
    allVsCalm,
    perDay: days, // raw day rows for downstream
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH} (${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)} KB)`);
  console.log(`Elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ----- console summary tables -----
  console.log('\n--- Baseline (all days) first-60m metrics ---');
  console.log('  range60 med', baseline.range60.median, 'mean', baseline.range60.mean, 'std', baseline.range60.stdev);
  console.log('  mfe60   med', baseline.mfe60.median,   'mean', baseline.mfe60.mean);
  console.log('  mae60   med', baseline.mae60.median,   'mean', baseline.mae60.mean);
  console.log('  pBull90', baseline.pBull90, 'pBear90', baseline.pBear90);

  console.log('\n--- Weekday vs baseline (range60 median ratio) ---');
  for (const [k, v] of Object.entries(weekday)) {
    console.log(`  ${k.padEnd(4)} n=${String(v.n).padStart(3)}  range60.med×${v.range60?.median_vs_base}  std×${v.range60?.stdev_vs_base}  pBull90=${v.pBull90}  Δ${v.pBull90_delta}`);
  }

  console.log('\n--- Event-day rankings (descending distortion score) ---');
  for (const r of ranked) {
    console.log(`  ${r.eventType.padEnd(12)} n=${String(r.n).padStart(3)}  score=${r.score}  range60×${r.range60_median_x}  mae60×${r.mae60_median_x}  mfe60×${r.mfe60_median_x}  pBull90=${r.pBull90} (Δ${r.pBull90_delta})`);
  }

  console.log('\n--- Top distortion events ---');
  for (const r of ranked.slice(0, 5)) {
    const v = events[r.eventType];
    console.log(`  ${r.eventType}:  range60 med ${v.range60.median} (×${v.range60.median_vs_base}, std×${v.range60.stdev_vs_base}),  MAE60 med ${v.mae60.median} (×${v.mae60.median_vs_base}),  pBull90=${v.pBull90} (Δ${v.pBull90_delta})`);
  }
}

main().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
