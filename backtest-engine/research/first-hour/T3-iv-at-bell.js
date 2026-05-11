/**
 * T3 — 0-DTE QQQ IV at the bell → first-hour NQ direction
 *
 * Hypothesis: a QQQ short-DTE IV reading taken AT or NEAR the 9:30 cash open
 * predicts the 9:30 → 10:30 / 9:30 → 11:00 NQ direction.
 *
 * Three signals tested:
 *   (a) IV LEVEL at 9:30 vs trailing-20-day percentile of the 9:30 reading
 *   (b) IV CHANGE 9:15 → 9:30 (drop → long bias, spike → short bias)
 *      NOTE: pre-9:30 QQQ IV data does not exist in our 1m file (file starts at
 *      14:31 UTC = 9:31 ET). We approximate 9:30 → 9:45 IV change instead, with
 *      entry at 9:45 open (timing matches existing short-dte-iv strategy logic
 *      where IV CHANGE during candle T predicts move DURING candle T+1 entered
 *      at the candle-T+1 OPEN).
 *   (c) IV CHANGE prior day 16:00 → today 9:30 (overnight) — uses IV @ 14:31 UTC
 *      (= first available print of the day) as the "9:30" reading.
 *
 * Critical timing: per existing short-dte-iv strategy, the predicted move occurs
 * DURING the 15-minute candle. Two entry timings tested:
 *   - "open930" (overnight signal): IV @ 9:31 print → enter at NQ 9:31 open
 *   - "open945" (intraday change):  IV change 9:31 → 9:45 → enter at NQ 9:45 open
 *
 * Data:
 *   - QQQ 1m IV (mostly 7-DTE):   data/iv/qqq/qqq_atm_iv_1m.csv
 *   - NQ raw 1m candles:          data/ohlcv/nq/NQ_ohlcv_1m.csv (filterPrimaryContract)
 *   - Rollover log:               data/ohlcv/nq/NQ_rollover_log.csv (skip those days)
 *
 * All times bucketed in ET. Date range: 2025-01-13 → 2026-04-23, last 2 mos OOS.
 */

import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';
import { toET, fromET } from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NQ_FILE = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
const IV_1M_FILE = path.join(REPO_ROOT, 'data', 'iv', 'qqq', 'qqq_atm_iv_1m.csv');
const ROLLOVER_FILE = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_rollover_log.csv');
const OUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const START_DATE = '2025-01-13';
const END_DATE = '2026-04-23';
const OOS_CUTOFF = '2026-02-23'; // last ~2 months OOS

// ----- helpers -----------------------------------------------------------
function loadRolloverDates() {
  return new Promise((resolve) => {
    const dates = new Set();
    fs.createReadStream(ROLLOVER_FILE)
      .pipe(csv())
      .on('data', (r) => { if (r.date) dates.add(r.date); })
      .on('end', () => resolve(dates));
  });
}

// Stream NQ raw 1m, filter calendar spreads, run filterPrimaryContract
function loadNQRaw(start, end) {
  return new Promise((resolve, reject) => {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime() + 24 * 3600 * 1000;
    const candles = [];
    fs.createReadStream(NQ_FILE)
      .pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return;
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < startMs || ts > endMs) return;
        const o = parseFloat(row.open), h = parseFloat(row.high),
              l = parseFloat(row.low), c = parseFloat(row.close);
        if (isNaN(o) || isNaN(c)) return;
        candles.push({
          timestamp: ts,
          open: o, high: h, low: l, close: c,
          volume: parseFloat(row.volume) || 0,
          symbol: row.symbol,
        });
      })
      .on('end', () => {
        // hour-bucket primary contract filter
        const hourVols = new Map();
        for (const c of candles) {
          const hk = Math.floor(c.timestamp / 3600000);
          if (!hourVols.has(hk)) hourVols.set(hk, new Map());
          const m = hourVols.get(hk);
          m.set(c.symbol, (m.get(c.symbol) || 0) + c.volume);
        }
        const primaryByHour = new Map();
        for (const [hk, m] of hourVols) {
          let best = '', bestV = -1;
          for (const [s, v] of m) if (v > bestV) { bestV = v; best = s; }
          primaryByHour.set(hk, best);
        }
        const out = candles.filter(c => primaryByHour.get(Math.floor(c.timestamp / 3600000)) === c.symbol);
        out.sort((a, b) => a.timestamp - b.timestamp);
        resolve(out);
      })
      .on('error', reject);
  });
}

function loadIV1m(start, end) {
  return new Promise((resolve, reject) => {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime() + 24 * 3600 * 1000;
    const out = []; // sorted by ts
    fs.createReadStream(IV_1M_FILE)
      .pipe(csv())
      .on('data', (row) => {
        const ts = new Date(row.timestamp).getTime();
        if (isNaN(ts) || ts < startMs || ts > endMs) return;
        const iv = parseFloat(row.iv);
        if (isNaN(iv) || iv <= 0 || iv > 3) return;
        out.push({
          timestamp: ts,
          iv,
          dte: parseInt(row.dte, 10),
        });
      })
      .on('end', () => {
        out.sort((a, b) => a.timestamp - b.timestamp);
        resolve(out);
      })
      .on('error', reject);
  });
}

// last IV value with timestamp <= target (binary search)
function ivAt(ivArr, targetMs, maxStaleMs = 5 * 60 * 1000) {
  let lo = 0, hi = ivArr.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ivArr[mid].timestamp <= targetMs) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (best < 0) return null;
  if (targetMs - ivArr[best].timestamp > maxStaleMs) return null;
  return ivArr[best];
}

// First IV value with timestamp >= target (binary search) — used because IV file
// starts at 14:31 UTC for each session, so for a 14:30 ET-open we look forward 1 min.
function ivAtForward(ivArr, targetMs, maxAheadMs = 5 * 60 * 1000) {
  let lo = 0, hi = ivArr.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ivArr[mid].timestamp >= targetMs) { best = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  if (best < 0) return null;
  if (ivArr[best].timestamp - targetMs > maxAheadMs) return null;
  return ivArr[best];
}

// percentile of value within array of past values
function percentileRank(value, arr) {
  if (arr.length === 0) return null;
  let count = 0;
  for (const v of arr) if (v <= value) count++;
  return count / arr.length;
}

// ----- main analysis -----------------------------------------------------
async function main() {
  console.log('T3 — IV at the bell → first-hour NQ direction');
  console.log(`Date range: ${START_DATE} → ${END_DATE} (OOS from ${OOS_CUTOFF})`);

  const [rollovers, nqCandles, iv1m] = await Promise.all([
    loadRolloverDates(),
    loadNQRaw(START_DATE, END_DATE),
    loadIV1m(START_DATE, END_DATE),
  ]);

  console.log(`Loaded NQ candles: ${nqCandles.length.toLocaleString()}`);
  console.log(`Loaded IV 1m rows: ${iv1m.length.toLocaleString()}`);
  console.log(`Rollover dates excluded: ${[...rollovers].join(', ')}`);

  // Index NQ by ET-date string for quick day lookup
  const nqByDay = new Map();
  for (const c of nqCandles) {
    const et = toET(c.timestamp);
    if (!nqByDay.has(et.date)) nqByDay.set(et.date, []);
    nqByDay.get(et.date).push({ ...c, et });
  }

  // Walk every trading day in range
  const records = [];
  const tradingDays = [...nqByDay.keys()].filter(d => d >= START_DATE && d <= END_DATE).sort();

  // For overnight IV change we need previous trading day's last IV reading.
  // We'll keep last seen 16:00-ish IV rolling forward.
  const ivByDayLastClose = new Map(); // date -> last 4pm IV reading
  for (const d of tradingDays) {
    const [y, m, day] = d.split('-').map(Number);
    const closeMs = fromET(y, m - 1, day, 16, 0);
    const ivClose = ivAt(iv1m, closeMs, 30 * 60 * 1000); // up to 30 min stale
    if (ivClose) ivByDayLastClose.set(d, ivClose.iv);
  }

  // For percentile of 9:30 IV LEVEL we need a rolling window of prior 9:30 IVs (level)
  const prior930IVs = []; // chronological list of (date, iv930)
  let lastDate = null;

  // build day index for prev-date lookup
  const dayIdx = new Map();
  tradingDays.forEach((d, i) => dayIdx.set(d, i));

  for (const date of tradingDays) {
    if (rollovers.has(date)) continue;
    const dayCandles = nqByDay.get(date) || [];
    if (dayCandles.length < 60) continue;

    const [y, m, d] = date.split('-').map(Number);
    const t930 = fromET(y, m - 1, d, 9, 30);
    const t945 = fromET(y, m - 1, d, 9, 45);
    const t1030 = fromET(y, m - 1, d, 10, 30);
    const t1100 = fromET(y, m - 1, d, 11, 0);
    const t1115 = fromET(y, m - 1, d, 11, 15);

    // NQ first-90 bars (9:30 → 11:00) for "overnight signal entered at 9:30"
    const bars930 = dayCandles.filter(c => c.timestamp >= t930 && c.timestamp < t1100);
    // NQ bars for "intraday signal entered at 9:45 → 11:15" (also 90 min)
    const bars945 = dayCandles.filter(c => c.timestamp >= t945 && c.timestamp < t1115);
    if (bars930.length < 30 || bars945.length < 30) continue;

    const open930Bar = bars930[0];
    const open945Bar = bars945[0];
    const close1030Bar = bars930.find(c => c.timestamp >= t1030 - 60000 && c.timestamp <= t1030);
    const last930Bar = bars930[bars930.length - 1];
    const last945Bar = bars945[bars945.length - 1];

    const entry930 = open930Bar.open;
    const entry945 = open945Bar.open;

    // MFE/MAE during 9:30→11:00
    let hi930 = -Infinity, lo930 = Infinity;
    for (const c of bars930) { if (c.high > hi930) hi930 = c.high; if (c.low < lo930) lo930 = c.low; }
    // MFE/MAE during 9:45→11:15
    let hi945 = -Infinity, lo945 = Infinity;
    for (const c of bars945) { if (c.high > hi945) hi945 = c.high; if (c.low < lo945) lo945 = c.low; }

    // ---- IV signals ----
    // "9:30 IV" = first IV print at-or-after 9:30:00 ET (typically 14:31:00 UTC EST / 13:31 UTC EDT)
    // We allow forward-look up to 5 min so we always grab the first print of the day.
    const iv930 = ivAtForward(iv1m, t930, 5 * 60 * 1000);
    const iv945 = ivAtForward(iv1m, t945, 5 * 60 * 1000);
    if (!iv930) continue;

    // (b) intraday IV change: "9:30→9:45 IV change" (uses iv930 and iv945)
    const ivIntradayChange = iv945 ? iv945.iv - iv930.iv : null;

    // (c) overnight: prior trading day's last (~16:00) IV → today's 9:30 IV
    const idx = dayIdx.get(date);
    const prevDate = idx > 0 ? tradingDays[idx - 1] : null;
    const ivPrevClose = prevDate ? ivByDayLastClose.get(prevDate) : null;
    const ivOvernightChange = ivPrevClose != null ? iv930.iv - ivPrevClose : null;
    const ivOvernightPct = ivPrevClose != null ? (iv930.iv - ivPrevClose) / ivPrevClose : null;

    // (a) IV LEVEL percentile vs trailing 20 sessions of 9:30 IVs
    const window = prior930IVs.slice(-20).map(x => x.iv);
    const ivLevelPct = window.length >= 10 ? percentileRank(iv930.iv, window) : null;

    records.push({
      date,
      isOOS: date >= OOS_CUTOFF,
      // 9:30 entry path (uses overnight signal & IV level)
      entry930,
      close1030: close1030Bar ? close1030Bar.close : null,
      close1100: last930Bar.close,
      move1030: close1030Bar ? close1030Bar.close - entry930 : null,
      move1100: last930Bar.close - entry930,
      mfeLong930: hi930 - entry930, maeLong930: entry930 - lo930,
      // 9:45 entry path (uses intraday change)
      entry945,
      close1115: last945Bar.close,
      move1115: last945Bar.close - entry945,
      mfeLong945: hi945 - entry945, maeLong945: entry945 - lo945,
      // signals
      iv930: iv930.iv, iv930Dte: iv930.dte, iv930Ts: iv930.timestamp,
      iv945: iv945 ? iv945.iv : null,
      ivIntradayChange,
      ivPrevClose,
      ivOvernightChange,
      ivOvernightPct,
      ivLevelPct,
    });

    prior930IVs.push({ date, iv: iv930.iv });
  }

  console.log(`\nValid trading days with IV: ${records.length}`);
  const oosCount = records.filter(r => r.isOOS).length;
  console.log(`In-sample: ${records.length - oosCount}, OOS: ${oosCount}`);

  // ---- Correlations (in-sample only) ----
  const inSample = records.filter(r => !r.isOOS);

  function pearson(xs, ys) {
    const n = xs.length;
    if (n < 5) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      const ex = xs[i] - mx, ey = ys[i] - my;
      num += ex * ey; dx += ex * ex; dy += ey * ey;
    }
    return num / Math.sqrt(dx * dy);
  }

  // Map signal → entry timing → target field
  // 9:30 entry uses overnight signals + IV level (no lookahead)
  // 9:45 entry uses intraday change (uses 9:31 + 9:45 prints, enters at 9:45 open)
  const signalSpec = [
    { sig: 'ivOvernightChange', entry: '9:30', targets: ['move1030', 'move1100'] },
    { sig: 'ivOvernightPct',    entry: '9:30', targets: ['move1030', 'move1100'] },
    { sig: 'ivLevelPct',        entry: '9:30', targets: ['move1030', 'move1100'] },
    { sig: 'iv930',             entry: '9:30', targets: ['move1030', 'move1100'] },
    { sig: 'ivIntradayChange',  entry: '9:45', targets: ['move1115'] },
  ];

  const corrTable = {};
  for (const spec of signalSpec) {
    for (const tgt of spec.targets) {
      const valid = inSample.filter(r => r[spec.sig] != null && r[tgt] != null);
      const xs = valid.map(r => r[spec.sig]);
      const ys = valid.map(r => r[tgt]);
      corrTable[`${spec.sig}@${spec.entry}__${tgt}`] = {
        n: valid.length,
        r: pearson(xs, ys),
      };
    }
  }
  console.log('\n=== Correlations (in-sample) ===');
  console.table(corrTable);

  // ---- Decile buckets (in-sample) per signal vs move1100 ----
  function decileStats(records, sigKey, tgtKey, nBuckets = 10) {
    const valid = records.filter(r => r[sigKey] != null && r[tgtKey] != null);
    valid.sort((a, b) => a[sigKey] - b[sigKey]);
    const bSize = Math.floor(valid.length / nBuckets);
    if (bSize === 0) return [];
    const out = [];
    for (let i = 0; i < nBuckets; i++) {
      const slice = i === nBuckets - 1 ? valid.slice(i * bSize) : valid.slice(i * bSize, (i + 1) * bSize);
      if (!slice.length) continue;
      const moves = slice.map(r => r[tgtKey]);
      const wins = moves.filter(m => m > 0).length;
      const sigVals = slice.map(r => r[sigKey]);
      out.push({
        bucket: i + 1,
        n: slice.length,
        sigMin: Math.min(...sigVals),
        sigMax: Math.max(...sigVals),
        sigMean: sigVals.reduce((a, b) => a + b, 0) / slice.length,
        wrLong: wins / slice.length,
        avgMove: moves.reduce((a, b) => a + b, 0) / slice.length,
        medianMove: moves.sort((a, b) => a - b)[Math.floor(slice.length / 2)],
      });
    }
    return out;
  }

  const decTables = {};
  for (const spec of signalSpec) {
    const tgt = spec.entry === '9:30' ? 'move1100' : 'move1115';
    decTables[`${spec.sig}@${spec.entry}`] = decileStats(inSample, spec.sig, tgt, 10);
    console.log(`\n=== Deciles: ${spec.sig}@${spec.entry} → ${tgt} (in-sample) ===`);
    console.table(decTables[`${spec.sig}@${spec.entry}`].map(d => ({
      bkt: d.bucket, n: d.n,
      sigRange: `${d.sigMin.toFixed(4)}..${d.sigMax.toFixed(4)}`,
      wrLong: (d.wrLong * 100).toFixed(1) + '%',
      avgMove: d.avgMove.toFixed(1),
    })));
  }

  // ---- Threshold-based simulation with grid search ----
  // We'll use the strongest correlated signal: assume it's ivChange15m (negative r expected).
  // Long when signal is in top OR bottom decile (depending on sign of r); short opposite.
  // For each candidate signal we test long/short threshold rules.

  // For each candidate signal, choose long-bias side (positive avg move) and short-bias side (negative avg move),
  // pick a threshold that captures the extreme decile, then simulate 9:30 entry → grid search.
  function simulate(records, sigKey, longThreshold, longSide, shortThreshold, shortSide,
                    stopPts, targetPts, timeStopMin, dayCandles) {
    // dayCandles: Map of date -> first-hour bars
    const trades = [];
    for (const r of records) {
      if (r[sigKey] == null) continue;
      let side = null;
      // longSide is 'gt' or 'lt' meaning fire LONG when sig > threshold or < threshold
      if (longSide === 'gt' && r[sigKey] >= longThreshold) side = 'long';
      else if (longSide === 'lt' && r[sigKey] <= longThreshold) side = 'long';
      if (side == null) {
        if (shortSide === 'gt' && r[sigKey] >= shortThreshold) side = 'short';
        else if (shortSide === 'lt' && r[sigKey] <= shortThreshold) side = 'short';
      }
      if (!side) continue;

      const bars = dayCandles.get(r.date);
      if (!bars || bars.length === 0) continue;
      const entry = bars[0].open;
      const stop = side === 'long' ? entry - stopPts : entry + stopPts;
      const target = side === 'long' ? entry + targetPts : entry - targetPts;
      const maxBars = timeStopMin; // 1m bars

      let exitPrice = null, exitReason = null;
      for (let i = 0; i < Math.min(bars.length, maxBars); i++) {
        const c = bars[i];
        if (side === 'long') {
          if (c.low <= stop) { exitPrice = stop; exitReason = 'stop'; break; }
          if (c.high >= target) { exitPrice = target; exitReason = 'target'; break; }
        } else {
          if (c.high >= stop) { exitPrice = stop; exitReason = 'stop'; break; }
          if (c.low <= target) { exitPrice = target; exitReason = 'target'; break; }
        }
      }
      if (exitPrice == null) {
        const lastBar = bars[Math.min(bars.length, maxBars) - 1];
        exitPrice = lastBar.close;
        exitReason = 'time';
      }
      const pnlPts = side === 'long' ? (exitPrice - entry) : (entry - exitPrice);
      trades.push({ date: r.date, side, entry, exit: exitPrice, pnlPts, exitReason, sig: r[sigKey], isOOS: r.isOOS });
    }

    // Stats
    const wins = trades.filter(t => t.pnlPts > 0);
    const losses = trades.filter(t => t.pnlPts <= 0);
    const grossWin = wins.reduce((a, t) => a + t.pnlPts, 0);
    const grossLoss = -losses.reduce((a, t) => a + t.pnlPts, 0);
    const totalPnL = trades.reduce((a, t) => a + t.pnlPts, 0);
    const avg = trades.length ? totalPnL / trades.length : 0;
    const std = trades.length > 1 ? Math.sqrt(trades.reduce((a, t) => a + (t.pnlPts - avg) ** 2, 0) / (trades.length - 1)) : 0;
    const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;
    const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
    const wr = trades.length ? wins.length / trades.length : 0;

    // simple equity drawdown
    let equity = 0, peak = 0, maxDD = 0;
    for (const t of trades) {
      equity += t.pnlPts;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;
    }

    return {
      trades, n: trades.length, wr, pf, totalPnL, avgPnL: avg, sharpe, maxDD,
    };
  }

  // For decile-based simulation, pick threshold = 20th/80th percentile of in-sample signal.
  function pct(vals, p) {
    const sorted = [...vals].sort((a, b) => a - b);
    return sorted[Math.floor(p * sorted.length)];
  }

  // Day-bars index for sim — keep both 9:30 and 9:45 entry windows (90 min each)
  const dayBars930 = new Map(), dayBars945 = new Map();
  for (const r of records) {
    const [y, m, d] = r.date.split('-').map(Number);
    const t930 = fromET(y, m - 1, d, 9, 30);
    const t945 = fromET(y, m - 1, d, 9, 45);
    const t1100 = fromET(y, m - 1, d, 11, 0);
    const t1115 = fromET(y, m - 1, d, 11, 15);
    dayBars930.set(r.date, (nqByDay.get(r.date) || []).filter(c => c.timestamp >= t930 && c.timestamp < t1100));
    dayBars945.set(r.date, (nqByDay.get(r.date) || []).filter(c => c.timestamp >= t945 && c.timestamp < t1115));
  }

  // Edges per signal from in-sample distribution
  const sigEdges = {};
  for (const spec of signalSpec) {
    const vals = inSample.map(r => r[spec.sig]).filter(v => v != null);
    if (!vals.length) continue;
    const tgt = spec.entry === '9:30' ? 'move1100' : 'move1115';
    sigEdges[`${spec.sig}@${spec.entry}`] = {
      lo: pct(vals, 0.20),
      hi: pct(vals, 0.80),
      lo30: pct(vals, 0.30),
      hi30: pct(vals, 0.70),
      r: (corrTable[`${spec.sig}@${spec.entry}__${tgt}`] || {}).r || 0,
      entry: spec.entry,
    };
  }

  console.log('\n=== Signal edges (20th/80th pct of in-sample) ===');
  console.table(sigEdges);

  // Grid search per signal × entry
  const stopGrid = [25, 40, 60];
  const targetGrid = [30, 50, 75, 100];
  const timeGrid = [60, 90];

  const results = [];
  for (const spec of signalSpec) {
    const key = `${spec.sig}@${spec.entry}`;
    const e = sigEdges[key];
    if (!e) continue;
    const dayBars = spec.entry === '9:30' ? dayBars930 : dayBars945;

    for (const thrPct of ['20/80', '30/70']) {
      const lo = thrPct === '20/80' ? e.lo : e.lo30;
      const hi = thrPct === '20/80' ? e.hi : e.hi30;
      let longSide, longThr, shortSide, shortThr;
      if (e.r >= 0) {
        longSide = 'gt'; longThr = hi; shortSide = 'lt'; shortThr = lo;
      } else {
        longSide = 'lt'; longThr = lo; shortSide = 'gt'; shortThr = hi;
      }

      for (const stop of stopGrid) for (const target of targetGrid) for (const tm of timeGrid) {
        const sim = simulate(records, spec.sig, longThr, longSide, shortThr, shortSide,
                             stop, target, tm, dayBars);
        const inSim = sim.trades.filter(t => !t.isOOS);
        const oosSim = sim.trades.filter(t => t.isOOS);
        const calc = (arr) => {
          const w = arr.filter(t => t.pnlPts > 0).length;
          const gw = arr.filter(t => t.pnlPts > 0).reduce((a, t) => a + t.pnlPts, 0);
          const gl = -arr.filter(t => t.pnlPts <= 0).reduce((a, t) => a + t.pnlPts, 0);
          const tot = arr.reduce((a, t) => a + t.pnlPts, 0);
          const avg = arr.length ? tot / arr.length : 0;
          const std = arr.length > 1 ? Math.sqrt(arr.reduce((a, t) => a + (t.pnlPts - avg) ** 2, 0) / (arr.length - 1)) : 0;
          return {
            n: arr.length, wr: arr.length ? w / arr.length : 0,
            pf: gl > 0 ? gw / gl : Infinity, totalPnL: tot, avgPnL: avg,
            sharpe: std > 0 ? (avg / std) * Math.sqrt(252) : 0,
          };
        };
        results.push({
          signal: spec.sig, entry: spec.entry, thrPct, stop, target, time: tm,
          n: sim.n, wr: sim.wr, pf: sim.pf, totalPnL: sim.totalPnL, sharpe: sim.sharpe, maxDD: sim.maxDD,
          IS: calc(inSim),
          OOS: calc(oosSim),
        });
      }
    }
  }

  // Filter combos to require enough trades to be statistically meaningful
  const minTrades = 20;
  const filtered = results.filter(r => r.IS.n >= minTrades);
  filtered.sort((a, b) => (b.IS.pf || 0) - (a.IS.pf || 0));
  console.log(`\n=== Top 20 grid combos by IS PF (min IS_n=${minTrades}) ===`);
  console.table(filtered.slice(0, 20).map(r => ({
    sig: r.signal, e: r.entry, thr: r.thrPct, stop: r.stop, tgt: r.target, t: r.time,
    n: r.n, wr: (r.wr * 100).toFixed(1) + '%', pf: (r.pf || 0).toFixed(2),
    pnl: r.totalPnL.toFixed(0), sh: r.sharpe.toFixed(2), DD: r.maxDD.toFixed(0),
    IS_n: r.IS.n, IS_pf: r.IS.pf.toFixed(2), IS_pnl: r.IS.totalPnL.toFixed(0),
    OOS_n: r.OOS.n, OOS_pf: (r.OOS.pf || 0).toFixed(2), OOS_pnl: r.OOS.totalPnL.toFixed(0),
  })));

  // Also sort by sharpe with min trade filter
  const bySharpe = [...filtered].sort((a, b) => (b.IS.sharpe || 0) - (a.IS.sharpe || 0));
  console.log(`\n=== Top 10 grid combos by IS Sharpe (min IS_n=${minTrades}) ===`);
  console.table(bySharpe.slice(0, 10).map(r => ({
    sig: r.signal, e: r.entry, thr: r.thrPct, stop: r.stop, tgt: r.target, t: r.time,
    IS_n: r.IS.n, IS_wr: (r.IS.wr * 100).toFixed(1) + '%', IS_pf: r.IS.pf.toFixed(2),
    IS_sharpe: r.IS.sharpe.toFixed(2), IS_pnl: r.IS.totalPnL.toFixed(0),
    OOS_n: r.OOS.n, OOS_pf: (r.OOS.pf || 0).toFixed(2), OOS_pnl: r.OOS.totalPnL.toFixed(0),
  })));

  // ---- Save outputs ----
  const out = {
    meta: {
      track: 'T3',
      title: '0-DTE QQQ IV at the bell → first-hour NQ direction',
      generated: new Date().toISOString(),
      startDate: START_DATE, endDate: END_DATE, oosCutoff: OOS_CUTOFF,
      tradingDays: records.length,
    },
    correlations: corrTable,
    sigEdges,
    deciles: decTables,
    gridResults: results,
    records, // all per-day records
  };
  const outFile = path.join(OUT_DIR, 'T3-iv-at-bell.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outFile} (${records.length} day records, ${results.length} grid combos)`);
}

main().catch(err => { console.error(err); process.exit(1); });
