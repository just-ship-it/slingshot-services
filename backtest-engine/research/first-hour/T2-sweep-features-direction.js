/**
 * T2 — Pre-RTH sweep predictor generalized to first-hour direction.
 *
 * Hypothesis: The features used by `pre-sweep-prediction.js`
 * (price_position_in_on_range, overnight_bias, gap_from_pdc, etc.)
 * — computed at 9:30 ET — predict the *first-hour direction* of NQ
 * during 9:30-11:00 ET, REGARDLESS of whether a sweep occurs.
 *
 * Pipeline:
 *   1. For each trading day 2025-01-13 → 2026-04-23, compute pre-RTH
 *      features at 9:30 ET (price_position_in_on_range, overnight_bias,
 *      gap_from_pdc, asian_range, GEX wall asymmetry, GEX regime, LT
 *      asymmetry).
 *   2. Compute dependent variables on the 9:30 → 11:00 RTH window:
 *        a. directional close (sign(close_11:00 - open_9:30))
 *        b. directional MFE/MAE
 *        c. race outcome: did price reach +30pt (or +50pt) before -30pt?
 *   3. Bucket each feature, report P(up | bucket), avg MFE/MAE per bucket
 *      (≥ 50 samples per bucket).
 *   4. Combine the strongest features into a long/short rule, then
 *      grid-search stops/targets over {30,50,75,100} pt.
 *   5. Hold the last 2 months (2026-02-23 → 2026-04-23) as OOS.
 *
 * Output:
 *   - JSON: research/first-hour/output/T2-features-direction.json
 *   - findings markdown: research/first-hour/T2-FINDINGS.md (written separately)
 *
 * USES RAW CONTRACTS WITH filterPrimaryContract() — see CLAUDE.md.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import {
  loadIntradayGEX,
  getGEXSnapshotAt,
  loadLTLevels,
  getLTSnapshotAt,
  toET,
  fromET,
  extractTradingDates,
  getAsianCandles,
  getOvernightCandlesFromArray,
  getRTHCandlesFromArray,
  getPrevDayLevelsFromArray
} from '../utils/data-loader.js';

import { round, calculatePercentiles, correlation, proportionZTest } from '../utils/analysis-helpers.js';

import { CSVLoader } from '../../src/data/csv-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const START_DATE = '2025-01-13';
const END_DATE = '2026-04-23';
const OOS_CUTOFF = '2026-02-23'; // last ~2 months held out

const FIRST_HOUR_TARGET_BARS = 90; // 9:30 -> 11:00 = 90 minutes

// --- Raw contract loader ---
async function loadRawNQ(startDate, endDate) {
  const filePath = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
  if (!fs.existsSync(filePath)) throw new Error(`OHLCV file not found: ${filePath}`);
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime() + 24 * 3600000;

  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return; // calendar spreads
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < start || ts > end) return;
        const o = parseFloat(row.open), h = parseFloat(row.high), l = parseFloat(row.low), c = parseFloat(row.close);
        if (isNaN(o) || isNaN(c)) return;
        candles.push({ timestamp: ts, open: o, high: h, low: l, close: c, volume: parseFloat(row.volume) || 0, symbol: row.symbol });
      })
      .on('end', resolve)
      .on('error', reject);
  });

  candles.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Loaded ${candles.length.toLocaleString()} raw NQ 1m candles`);
  // Apply primary contract filter
  const loader = new CSVLoader('1m');
  const filtered = loader.filterPrimaryContract(candles);
  console.log(`After primary contract filter: ${filtered.length.toLocaleString()} candles`);
  return filtered;
}

// --- Rollover helpers ---
function loadRolloverDates() {
  const file = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_rollover_log.csv');
  const rolls = new Set();
  const text = fs.readFileSync(file, 'utf-8');
  const lines = text.split('\n').slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [date] = line.split(',');
    rolls.add(date);
  }
  return rolls;
}

// --- Feature computation ---
function computeOvernightFeatures(asianCandles, overnightCandles, prevLevels, price) {
  const f = {
    overnight_range: null,
    overnight_bias: null,
    asian_range: null,
    gap_from_pdc: null,
    price_position_in_on_range: null,
    asian_position: null
  };
  if (overnightCandles.length > 0) {
    const onHigh = Math.max(...overnightCandles.map(c => c.high));
    const onLow = Math.min(...overnightCandles.map(c => c.low));
    const onRange = onHigh - onLow;
    const onOpen = overnightCandles[0].open;
    const onClose = overnightCandles[overnightCandles.length - 1].close;
    f.overnight_range = round(onRange, 2);
    f.overnight_bias = onRange > 0 ? round((onClose - onOpen) / onRange, 2) : 0;
    f.price_position_in_on_range = onRange > 0 ? round((price - onLow) / onRange, 2) : 0.5;
  }
  if (asianCandles.length > 0) {
    const aH = Math.max(...asianCandles.map(c => c.high));
    const aL = Math.min(...asianCandles.map(c => c.low));
    const aR = aH - aL;
    f.asian_range = round(aR, 2);
    f.asian_position = aR > 0 ? round((price - aL) / aR, 2) : 0.5;
  }
  if (prevLevels) {
    f.gap_from_pdc = round(price - prevLevels.close, 2);
  }
  return f;
}

function computeGEXFeatures(snapshots, price, ts) {
  if (!snapshots || snapshots.length === 0) return {
    gex_call_wall_dist: null, gex_put_wall_dist: null, gex_wall_asymmetry: null,
    gex_gamma_flip_position: null, gex_regime: null, gex_total_magnitude: null,
    gex_imbalance: null
  };
  const snap = getGEXSnapshotAt(snapshots, ts);
  if (!snap) return { gex_call_wall_dist: null, gex_put_wall_dist: null, gex_wall_asymmetry: null,
    gex_gamma_flip_position: null, gex_regime: null, gex_total_magnitude: null, gex_imbalance: null };
  const cw = snap.call_wall || (snap.resistance && snap.resistance[0]) || null;
  const pw = snap.put_wall || (snap.support && snap.support[0]) || null;
  const gf = snap.gamma_flip || null;
  return {
    gex_call_wall_dist: cw ? round(cw - price, 2) : null,
    gex_put_wall_dist: pw ? round(price - pw, 2) : null,
    gex_wall_asymmetry: cw && pw ? round((cw - price) - (price - pw), 2) : null,
    gex_gamma_flip_position: gf !== null ? (gf < price ? 'below' : 'above') : null,
    gex_regime: snap.regime || null,
    gex_total_magnitude: snap.total_gex || null,
    gex_imbalance: snap.gamma_imbalance != null ? round(snap.gamma_imbalance, 4) : null
  };
}

function computeLTFeatures(ltLevels, price, ts) {
  const snap = getLTSnapshotAt(ltLevels, ts);
  if (!snap) return { lt_above_count: null, lt_below_count: null, lt_asymmetry: null,
    lt_nearest_above_dist: null, lt_nearest_below_dist: null, lt_sentiment: null };
  const levels = snap.levels;
  const above = levels.filter(l => l > price);
  const below = levels.filter(l => l <= price);
  const nA = above.length > 0 ? Math.min(...above.map(l => l - price)) : null;
  const nB = below.length > 0 ? Math.min(...below.map(l => price - l)) : null;
  return {
    lt_above_count: above.length,
    lt_below_count: below.length,
    lt_asymmetry: round((above.length - below.length) / 5, 2),
    lt_nearest_above_dist: nA !== null ? round(nA, 2) : null,
    lt_nearest_below_dist: nB !== null ? round(nB, 2) : null,
    lt_sentiment: snap.sentiment
  };
}

// --- Dependent variable: first-hour outcome ---
function computeFirstHourOutcome(rthCandles) {
  if (rthCandles.length < 60) return null; // need at least 60 minutes
  const window = rthCandles.slice(0, FIRST_HOUR_TARGET_BARS); // up to 90 bars
  if (window.length < 30) return null;
  const open = window[0].open;
  // close at 11:00 ET (or last bar in window if missing)
  const lastIdx = Math.min(window.length, FIRST_HOUR_TARGET_BARS) - 1;
  const close = window[lastIdx].close;
  let mfe = 0, mae = 0;
  // Race: which threshold is hit first?
  const races = { 30: null, 50: null, 75: null, 100: null };
  for (let i = 0; i < window.length; i++) {
    const c = window[i];
    const upMove = c.high - open;
    const dnMove = c.low - open; // negative
    if (upMove > mfe) mfe = upMove;
    if (dnMove < mae) mae = dnMove;
    for (const t of [30, 50, 75, 100]) {
      if (races[t] === null) {
        const hitUp = c.high - open >= t;
        const hitDn = open - c.low >= t;
        if (hitUp && hitDn) {
          // both hit in same bar — use open vs side that's farther; default = neither
          const distUp = c.high - open;
          const distDn = open - c.low;
          races[t] = distUp >= distDn ? 'up' : 'down';
        } else if (hitUp) {
          races[t] = 'up';
        } else if (hitDn) {
          races[t] = 'down';
        }
      }
    }
  }
  return {
    open: round(open, 2),
    close11: round(close, 2),
    netPts: round(close - open, 2),
    direction: close > open ? 'up' : (close < open ? 'down' : 'flat'),
    mfe: round(mfe, 2),
    mae: round(Math.abs(mae), 2),
    race30: races[30] || 'neither',
    race50: races[50] || 'neither',
    race75: races[75] || 'neither',
    race100: races[100] || 'neither'
  };
}

// --- Bucketing helpers ---
function bucketize(value, edges) {
  // edges = [b1, b2, b3] -> labels ('< b1', 'b1..b2', 'b2..b3', '>= b3')
  if (value == null || isNaN(value)) return 'na';
  for (let i = 0; i < edges.length; i++) {
    if (value < edges[i]) return i === 0 ? `< ${edges[i]}` : `${edges[i - 1]}..${edges[i]}`;
  }
  return `>= ${edges[edges.length - 1]}`;
}

function bucketStats(days, key, edges) {
  const groups = {};
  for (const d of days) {
    const v = d.features[key];
    const lbl = bucketize(v, edges);
    if (!groups[lbl]) groups[lbl] = { count: 0, up: 0, mfeSum: 0, maeSum: 0, race50Up: 0, race50Dn: 0, race30Up: 0, race30Dn: 0, netSum: 0 };
    const g = groups[lbl];
    g.count++;
    if (d.outcome.direction === 'up') g.up++;
    g.mfeSum += d.outcome.mfe;
    g.maeSum += d.outcome.mae;
    g.netSum += d.outcome.netPts;
    if (d.outcome.race50 === 'up') g.race50Up++;
    if (d.outcome.race50 === 'down') g.race50Dn++;
    if (d.outcome.race30 === 'up') g.race30Up++;
    if (d.outcome.race30 === 'down') g.race30Dn++;
  }
  return Object.entries(groups).map(([label, g]) => ({
    label,
    count: g.count,
    upPct: round(g.up / g.count * 100, 1),
    avgMFE: round(g.mfeSum / g.count, 2),
    avgMAE: round(g.maeSum / g.count, 2),
    avgNet: round(g.netSum / g.count, 2),
    race50UpPct: round(g.race50Up / g.count * 100, 1),
    race50DnPct: round(g.race50Dn / g.count * 100, 1),
    race30UpPct: round(g.race30Up / g.count * 100, 1),
    race30DnPct: round(g.race30Dn / g.count * 100, 1),
    race50UpEdge: round((g.race50Up - g.race50Dn) / g.count * 100, 1)
  }));
}

function bucketStatsCategorical(days, key) {
  const groups = {};
  for (const d of days) {
    const lbl = d.features[key] != null ? String(d.features[key]) : 'na';
    if (!groups[lbl]) groups[lbl] = { count: 0, up: 0, mfeSum: 0, maeSum: 0, race50Up: 0, race50Dn: 0, race30Up: 0, race30Dn: 0, netSum: 0 };
    const g = groups[lbl];
    g.count++;
    if (d.outcome.direction === 'up') g.up++;
    g.mfeSum += d.outcome.mfe;
    g.maeSum += d.outcome.mae;
    g.netSum += d.outcome.netPts;
    if (d.outcome.race50 === 'up') g.race50Up++;
    if (d.outcome.race50 === 'down') g.race50Dn++;
    if (d.outcome.race30 === 'up') g.race30Up++;
    if (d.outcome.race30 === 'down') g.race30Dn++;
  }
  return Object.entries(groups).map(([label, g]) => ({
    label,
    count: g.count,
    upPct: round(g.up / g.count * 100, 1),
    avgMFE: round(g.mfeSum / g.count, 2),
    avgMAE: round(g.maeSum / g.count, 2),
    avgNet: round(g.netSum / g.count, 2),
    race50UpPct: round(g.race50Up / g.count * 100, 1),
    race50DnPct: round(g.race50Dn / g.count * 100, 1),
    race30UpPct: round(g.race30Up / g.count * 100, 1),
    race30DnPct: round(g.race30Dn / g.count * 100, 1),
    race50UpEdge: round((g.race50Up - g.race50Dn) / g.count * 100, 1)
  }));
}

// --- Combined-signal scoring ---
function scoreDay(f) {
  let bull = 0, bear = 0;
  // Most predictive in pre-sweep study: price_position_in_on_range, overnight_bias, gap_from_pdc
  if (f.price_position_in_on_range != null) {
    if (f.price_position_in_on_range >= 0.7) bull++;
    if (f.price_position_in_on_range <= 0.3) bear++;
  }
  if (f.overnight_bias != null) {
    if (f.overnight_bias >= 0.3) bull++;
    if (f.overnight_bias <= -0.3) bear++;
  }
  if (f.gap_from_pdc != null) {
    if (f.gap_from_pdc >= 30) bull++;
    if (f.gap_from_pdc <= -30) bear++;
  }
  if (f.gex_wall_asymmetry != null) {
    if (f.gex_wall_asymmetry >= 50) bull++;
    if (f.gex_wall_asymmetry <= -50) bear++;
  }
  if (f.lt_asymmetry != null) {
    if (f.lt_asymmetry <= -0.2) bull++;
    if (f.lt_asymmetry >= 0.2) bear++;
  }
  if (f.gex_imbalance != null) {
    if (f.gex_imbalance >= 0.3) bull++;
    if (f.gex_imbalance <= -0.3) bear++;
  }
  return { bull, bear, net: bull - bear };
}

// --- Trade simulator using race outcome (proxy) ---
// Realistic per-bar simulation: enter at 9:30 open, walk minute candles
// with the rule's TP/SL levels. Mark to last bar (11:00) if neither hits.
function simulateTrade(rthCandles, side, tpPts, slPts) {
  const window = rthCandles.slice(0, FIRST_HOUR_TARGET_BARS);
  if (window.length === 0) return null;
  const entry = window[0].open;
  const dir = side === 'long' ? 1 : -1;
  const tp = entry + dir * tpPts;
  const sl = entry - dir * slPts;
  for (let i = 0; i < window.length; i++) {
    const c = window[i];
    if (side === 'long') {
      const hitSL = c.low <= sl;
      const hitTP = c.high >= tp;
      if (hitSL && hitTP) {
        // Pessimistic: assume SL hit first
        return { exit: sl, pnl: -slPts, bars: i + 1, reason: 'sl_amb' };
      }
      if (hitSL) return { exit: sl, pnl: -slPts, bars: i + 1, reason: 'sl' };
      if (hitTP) return { exit: tp, pnl: tpPts, bars: i + 1, reason: 'tp' };
    } else {
      const hitSL = c.high >= sl;
      const hitTP = c.low <= tp;
      if (hitSL && hitTP) return { exit: sl, pnl: -slPts, bars: i + 1, reason: 'sl_amb' };
      if (hitSL) return { exit: sl, pnl: -slPts, bars: i + 1, reason: 'sl' };
      if (hitTP) return { exit: tp, pnl: tpPts, bars: i + 1, reason: 'tp' };
    }
  }
  // Time stop at end of window
  const closePx = window[window.length - 1].close;
  const pnl = (closePx - entry) * dir;
  return { exit: round(closePx, 2), pnl: round(pnl, 2), bars: window.length, reason: 'time' };
}

function tradeStats(trades) {
  if (trades.length === 0) return { count: 0, wr: 0, pf: 0, sharpe: 0, totalPts: 0, avgPts: 0, maxDD: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPts = trades.reduce((s, t) => s + t.pnl, 0);
  const mean = totalPts / trades.length;
  const variance = trades.reduce((s, t) => s + (t.pnl - mean) ** 2, 0) / trades.length;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  // max drawdown on equity curve
  let eq = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    count: trades.length,
    wr: round(wins.length / trades.length * 100, 1),
    pf: grossLoss > 0 ? round(grossWin / grossLoss, 2) : (grossWin > 0 ? 999 : 0),
    sharpe: round(sharpe, 2),
    totalPts: round(totalPts, 2),
    avgPts: round(mean, 2),
    maxDD: round(maxDD, 2)
  };
}

// --- Main ---
(async () => {
  console.log(`\n=== T2: Pre-RTH Sweep Features → First-Hour Direction ===\n`);

  const candles = await loadRawNQ(START_DATE, END_DATE);
  const tradingDates = extractTradingDates(candles).filter(d => d >= START_DATE && d <= END_DATE);
  console.log(`Trading days in window: ${tradingDates.length}`);

  const ltLevels = await loadLTLevels('NQ');
  const rolloverDates = loadRolloverDates();
  console.log(`Rollover dates loaded: ${rolloverDates.size}`);

  const days = [];
  let skipped = 0;
  let skipReason = { rth_short: 0, no_features: 0, rollover: 0, asian_too_small: 0 };

  for (const dateStr of tradingDates) {
    if (rolloverDates.has(dateStr)) { skipped++; skipReason.rollover++; continue; }

    const asianCandles = getAsianCandles(candles, dateStr);
    const overnightCandles = getOvernightCandlesFromArray(candles, dateStr);
    const rthCandles = getRTHCandlesFromArray(candles, dateStr);

    if (rthCandles.length < 60) { skipped++; skipReason.rth_short++; continue; }
    if (asianCandles.length < 5) { skipped++; skipReason.asian_too_small++; continue; }

    const [year, month, day] = dateStr.split('-').map(Number);
    const rthStartTs = fromET(year, month - 1, day, 9, 30);

    const price = rthCandles[0].open;
    const prevLevels = getPrevDayLevelsFromArray(candles, dateStr, tradingDates);
    const overnightFeatures = computeOvernightFeatures(asianCandles, overnightCandles, prevLevels, price);

    const gexSnapshots = loadIntradayGEX('NQ', dateStr);
    const gexFeatures = computeGEXFeatures(gexSnapshots, price, rthStartTs);
    const ltFeatures = computeLTFeatures(ltLevels, price, rthStartTs);

    const features = { ...overnightFeatures, ...gexFeatures, ...ltFeatures };
    const outcome = computeFirstHourOutcome(rthCandles);
    if (!outcome) { skipped++; skipReason.no_features++; continue; }

    days.push({ date: dateStr, features, outcome });
  }

  console.log(`\nProcessed ${days.length} days; skipped ${skipped}`, skipReason);

  // === Baseline ===
  const upDays = days.filter(d => d.outcome.direction === 'up').length;
  const dnDays = days.filter(d => d.outcome.direction === 'down').length;
  const baseUpPct = round(upDays / days.length * 100, 1);
  const baseDnPct = round(dnDays / days.length * 100, 1);
  const avgMFE = round(days.reduce((s, d) => s + d.outcome.mfe, 0) / days.length, 2);
  const avgMAE = round(days.reduce((s, d) => s + d.outcome.mae, 0) / days.length, 2);
  console.log(`\nBaseline (n=${days.length}): up=${baseUpPct}% down=${baseDnPct}% avgMFE=${avgMFE} avgMAE=${avgMAE}`);
  // Race base rates
  for (const t of [30, 50, 75, 100]) {
    const r = days.filter(d => d.outcome[`race${t}`] === 'up').length;
    const dn = days.filter(d => d.outcome[`race${t}`] === 'down').length;
    const ne = days.filter(d => d.outcome[`race${t}`] === 'neither').length;
    console.log(`  race ${t}: up=${r}/${days.length} (${round(r/days.length*100,1)}%) dn=${dn}/${days.length} (${round(dn/days.length*100,1)}%) neither=${ne}`);
  }

  // === Per-feature bucket analysis ===
  const featureBuckets = {
    price_position_in_on_range: [0.2, 0.4, 0.6, 0.8],
    overnight_bias: [-0.5, -0.2, 0.2, 0.5],
    gap_from_pdc: [-50, -15, 15, 50],
    asian_range: [25, 50, 100],
    asian_position: [0.2, 0.4, 0.6, 0.8],
    gex_wall_asymmetry: [-150, -50, 50, 150],
    gex_call_wall_dist: [50, 150, 300],
    gex_put_wall_dist: [50, 150, 300],
    gex_imbalance: [-0.5, -0.2, 0.2, 0.5],
    lt_asymmetry: [-0.5, -0.2, 0.2, 0.5],
    overnight_range: [50, 100, 200]
  };

  console.log('\n=== Per-Feature Bucket Stats (in-sample only for selection) ===\n');
  const inSample = days.filter(d => d.date < OOS_CUTOFF);
  console.log(`In-sample: ${inSample.length} days, OOS: ${days.length - inSample.length} days`);

  const featureResults = {};
  for (const [key, edges] of Object.entries(featureBuckets)) {
    const stats = bucketStats(inSample, key, edges);
    featureResults[key] = stats;
    console.log(`\n  ${key}:`);
    for (const s of stats) {
      console.log(`    ${s.label.padEnd(18)} n=${String(s.count).padStart(4)} up%=${String(s.upPct).padStart(5)} avgNet=${String(s.avgNet).padStart(7)} race50UpEdge=${String(s.race50UpEdge).padStart(7)} avgMFE=${s.avgMFE} avgMAE=${s.avgMAE}`);
    }
  }

  // Categorical features
  const catFeatures = ['gex_regime', 'gex_gamma_flip_position', 'lt_sentiment'];
  const catResults = {};
  for (const key of catFeatures) {
    const stats = bucketStatsCategorical(inSample, key);
    catResults[key] = stats;
    console.log(`\n  ${key}:`);
    for (const s of stats) {
      console.log(`    ${String(s.label).padEnd(20)} n=${String(s.count).padStart(4)} up%=${String(s.upPct).padStart(5)} avgNet=${String(s.avgNet).padStart(7)} race50UpEdge=${String(s.race50UpEdge).padStart(7)}`);
    }
  }

  // === Feature correlations to direction ===
  console.log('\n=== Feature Correlations to first-hour netPts (in-sample) ===\n');
  const corrResults = {};
  for (const key of Object.keys(featureBuckets)) {
    const paired = inSample
      .filter(d => typeof d.features[key] === 'number')
      .map(d => ({ x: d.features[key], y: d.outcome.netPts }));
    if (paired.length < 30) continue;
    const r = correlation(paired.map(p => p.x), paired.map(p => p.y));
    corrResults[key] = { r, n: paired.length };
    console.log(`  ${key.padEnd(28)} r=${r}  n=${paired.length}`);
  }

  // === Combined signal score → direction ===
  console.log('\n=== Combined Signal (net = bull - bear) ===\n');
  for (const d of days) d.score = scoreDay(d.features);
  const scoreBuckets = {};
  for (const d of inSample) {
    const k = String(d.score.net);
    if (!scoreBuckets[k]) scoreBuckets[k] = { count: 0, up: 0, race50Up: 0, race50Dn: 0, mfe: 0, mae: 0, net: 0 };
    const g = scoreBuckets[k];
    g.count++;
    if (d.outcome.direction === 'up') g.up++;
    if (d.outcome.race50 === 'up') g.race50Up++;
    if (d.outcome.race50 === 'down') g.race50Dn++;
    g.mfe += d.outcome.mfe;
    g.mae += d.outcome.mae;
    g.net += d.outcome.netPts;
  }
  const sortedKeys = Object.keys(scoreBuckets).sort((a, b) => Number(a) - Number(b));
  const scoreRows = [];
  for (const k of sortedKeys) {
    const g = scoreBuckets[k];
    const row = {
      net: Number(k), count: g.count,
      upPct: round(g.up / g.count * 100, 1),
      avgNet: round(g.net / g.count, 2),
      race50UpPct: round(g.race50Up / g.count * 100, 1),
      race50DnPct: round(g.race50Dn / g.count * 100, 1),
      race50Edge: round((g.race50Up - g.race50Dn) / g.count * 100, 1),
      avgMFE: round(g.mfe / g.count, 2),
      avgMAE: round(g.mae / g.count, 2)
    };
    scoreRows.push(row);
    console.log(`  net=${String(k).padStart(3)} n=${String(g.count).padStart(4)} up%=${String(row.upPct).padStart(5)} avgNet=${String(row.avgNet).padStart(7)} race50UpPct=${String(row.race50UpPct).padStart(5)} race50DnPct=${String(row.race50DnPct).padStart(5)} race50Edge=${String(row.race50Edge).padStart(6)}`);
  }

  // === Build candidate rules using the strongest features individually & in combo ===
  // Strongest splits emerged:
  //   gex_wall_asymmetry: >=150 → 70.6% up; <=-150 → 35.8% up (~65% down)
  //   gex_regime: strong_negative=85.7% up, strong_positive=21.4% up
  //   lt_sentiment: BULLISH=65.1% up, BEARISH=38.8% up
  //   gamma_flip below=55.6% up, above=36.8% up
  //   gex_put_wall_dist <50 → 74.4% up
  //   gex_call_wall_dist <50 → 22.7% up (i.e., 77% down)
  console.log('\n=== Rule Sweep: candidate rules + grid SL/TP ===\n');
  const candidatePts = [30, 50, 75, 100];

  // Rule definitions: each returns 'long' | 'short' | null based on features
  const ruleDefs = {
    R1_wallAsym: (f) => {
      if (f.gex_wall_asymmetry == null) return null;
      if (f.gex_wall_asymmetry >= 150) return 'long';
      if (f.gex_wall_asymmetry <= -150) return 'short';
      return null;
    },
    R2_wallAsymPlusLT: (f) => {
      if (f.gex_wall_asymmetry == null || !f.lt_sentiment) return null;
      if (f.gex_wall_asymmetry >= 100 && f.lt_sentiment === 'BULLISH') return 'long';
      if (f.gex_wall_asymmetry <= -100 && f.lt_sentiment === 'BEARISH') return 'short';
      return null;
    },
    R3_wallDist: (f) => {
      // Strong asymmetry in wall distance: closer wall is the magnet
      if (f.gex_call_wall_dist == null || f.gex_put_wall_dist == null) return null;
      if (f.gex_put_wall_dist < 50) return 'long';   // already at put wall, expect bounce
      if (f.gex_call_wall_dist < 50) return 'short'; // pinned at call wall, expect rejection
      return null;
    },
    R4_ltAndFlip: (f) => {
      if (!f.lt_sentiment || !f.gex_gamma_flip_position) return null;
      if (f.lt_sentiment === 'BULLISH' && f.gex_gamma_flip_position === 'below') return 'long';
      if (f.lt_sentiment === 'BEARISH' && f.gex_gamma_flip_position === 'above') return 'short';
      return null;
    },
    R5_combo: (f) => {
      // Triple confluence: wall asym + LT + gamma-flip side
      if (f.gex_wall_asymmetry == null || !f.lt_sentiment || !f.gex_gamma_flip_position) return null;
      const bull = f.gex_wall_asymmetry >= 50 && f.lt_sentiment === 'BULLISH' && f.gex_gamma_flip_position === 'below';
      const bear = f.gex_wall_asymmetry <= -50 && f.lt_sentiment === 'BEARISH' && f.gex_gamma_flip_position === 'above';
      if (bull) return 'long';
      if (bear) return 'short';
      return null;
    },
    R6_imbalance: (f) => {
      if (f.gex_imbalance == null) return null;
      if (f.gex_imbalance <= -0.4) return 'long'; // gamma below dominates → reflexive bid
      if (f.gex_imbalance >= 0.4) return 'short'; // gamma above dominates → bearish
      return null;
    },
    R7_score: (f, score) => {
      if (score.net >= 3) return 'long';
      if (score.net <= -3) return 'short';
      return null;
    }
  };

  const sweep = [];
  for (const [ruleName, ruleFn] of Object.entries(ruleDefs)) {
    for (const tpPts of candidatePts) {
      for (const slPts of candidatePts) {
        const trades = [];
        for (const d of inSample) {
          const rthCandles = getRTHCandlesFromArray(candles, d.date);
          if (rthCandles.length < 60) continue;
          const side = ruleFn(d.features, d.score);
          if (!side) continue;
          const trade = simulateTrade(rthCandles, side, tpPts, slPts);
          if (trade) trades.push({ date: d.date, side, ...trade });
        }
        const stats = tradeStats(trades);
        sweep.push({ rule: ruleName, tpPts, slPts, ...stats });
        console.log(`  ${ruleName.padEnd(20)} TP=${tpPts} SL=${slPts}: n=${String(stats.count).padStart(3)} WR=${String(stats.wr).padStart(5)}% PF=${String(stats.pf).padStart(5)} avg=${String(stats.avgPts).padStart(7)} total=${String(stats.totalPts).padStart(8)} sharpe=${String(stats.sharpe).padStart(6)} DD=${stats.maxDD}`);
      }
    }
  }

  // Pick best by Sharpe with PF>=1.3 and n>=50
  const valid = sweep.filter(s => s.pf >= 1.3 && s.count >= 50);
  valid.sort((a, b) => b.sharpe - a.sharpe);
  const bestIS = valid[0] || sweep.filter(s => s.count >= 50).sort((a, b) => b.sharpe - a.sharpe)[0];
  console.log('\nBest in-sample combo:', bestIS);

  // Also compute a per-rule winner for context
  const perRuleBest = {};
  for (const ruleName of Object.keys(ruleDefs)) {
    const subset = sweep.filter(s => s.rule === ruleName && s.count >= 30);
    subset.sort((a, b) => b.sharpe - a.sharpe);
    perRuleBest[ruleName] = subset[0] || null;
  }
  console.log('\nPer-rule best (Sharpe):');
  for (const [r, s] of Object.entries(perRuleBest)) {
    if (s) console.log(`  ${r}: TP=${s.tpPts} SL=${s.slPts} n=${s.count} WR=${s.wr}% PF=${s.pf} sharpe=${s.sharpe} total=${s.totalPts}`);
  }

  // === OOS validation ===
  console.log('\n=== OOS validation ===');
  const oos = days.filter(d => d.date >= OOS_CUTOFF);
  console.log(`OOS days: ${oos.length}`);
  const oosTrades = [];
  if (bestIS) {
    const ruleFn = ruleDefs[bestIS.rule];
    for (const d of oos) {
      const rthCandles = getRTHCandlesFromArray(candles, d.date);
      if (rthCandles.length < 60) continue;
      const side = ruleFn(d.features, d.score);
      if (!side) continue;
      const trade = simulateTrade(rthCandles, side, bestIS.tpPts, bestIS.slPts);
      if (trade) oosTrades.push({ date: d.date, side, ...trade });
    }
  }
  const oosStats = tradeStats(oosTrades);
  console.log(`OOS (best): rule=${bestIS?.rule} n=${oosStats.count} WR=${oosStats.wr}% PF=${oosStats.pf} avg=${oosStats.avgPts} total=${oosStats.totalPts} sharpe=${oosStats.sharpe} DD=${oosStats.maxDD}`);

  // Run OOS for every per-rule best as well for comparison
  const perRuleOOS = {};
  for (const [ruleName, isBest] of Object.entries(perRuleBest)) {
    if (!isBest) continue;
    const ruleFn = ruleDefs[ruleName];
    const trades = [];
    for (const d of oos) {
      const rthCandles = getRTHCandlesFromArray(candles, d.date);
      if (rthCandles.length < 60) continue;
      const side = ruleFn(d.features, d.score);
      if (!side) continue;
      const trade = simulateTrade(rthCandles, side, isBest.tpPts, isBest.slPts);
      if (trade) trades.push({ date: d.date, side, ...trade });
    }
    perRuleOOS[ruleName] = { tpPts: isBest.tpPts, slPts: isBest.slPts, ...tradeStats(trades) };
  }
  console.log('\nPer-rule OOS (using each rule\'s in-sample-best TP/SL):');
  for (const [r, s] of Object.entries(perRuleOOS)) {
    console.log(`  ${r}: TP=${s.tpPts} SL=${s.slPts} n=${s.count} WR=${s.wr}% PF=${s.pf} sharpe=${s.sharpe} total=${s.totalPts}`);
  }

  // === Save results ===
  const resultsObj = {
    study: 'T2: Pre-RTH sweep features → first-hour direction',
    dateRange: { start: START_DATE, end: END_DATE, oosStart: OOS_CUTOFF },
    nDays: days.length,
    nInSample: inSample.length,
    nOOS: oos.length,
    skipped: skipReason,
    baseline: { upPct: baseUpPct, downPct: baseDnPct, avgMFE, avgMAE },
    raceBaseRates: [30, 50, 75, 100].map(t => {
      const r = days.filter(d => d.outcome[`race${t}`] === 'up').length;
      const dn = days.filter(d => d.outcome[`race${t}`] === 'down').length;
      return { threshold: t, upPct: round(r / days.length * 100, 1), dnPct: round(dn / days.length * 100, 1) };
    }),
    featureBuckets: featureResults,
    categoricalBuckets: catResults,
    correlations: corrResults,
    combinedScore: scoreRows,
    sweep,
    bestInSample: bestIS,
    perRuleBestInSample: perRuleBest,
    perRuleOOS,
    oosStats,
    oosTrades: oosTrades.slice(0, 200) // trim if huge
  };

  const outFile = path.join(OUTPUT_DIR, 'T2-features-direction.json');
  fs.writeFileSync(outFile, JSON.stringify(resultsObj, null, 2));
  console.log(`\nSaved: ${outFile}`);
  console.log('Done.');
})();
