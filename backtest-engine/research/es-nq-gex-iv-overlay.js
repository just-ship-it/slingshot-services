#!/usr/bin/env node
/**
 * ES-NQ Correlation + GEX/IV Overlay Analysis
 *
 * Tests whether GEX regime and IV conditions act as filters or amplifiers
 * that turn marginal ES-NQ correlation signals into tradeable setups.
 *
 * Analyses:
 * 1. GEX Regime Effect on NQ/ES Correlation
 * 2. GEX Regime Divergence as a Signal
 * 3. GEX Level Proximity + NQ/ES Divergence
 * 4. NQ-Leads-ES Filtered by GEX Regime
 * 5. Daily Ratio Mean Reversion Filtered by GEX
 * 6. IV Level and Change Effect on Correlation
 * 7. Combined Signal — GEX Regime Divergence + IV Rising
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadContinuousOHLCV,
  toET,
  fromET,
  extractTradingDates,
  getRTHCandlesFromArray,
  loadIntradayGEX,
  getGEXSnapshotAt
} from './utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.join(__dirname, 'output');
const DATA_DIR = path.join(__dirname, '..', 'data');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── Configuration ───────────────────────────────────────────────────────────

// GEX data available from Mar 2023, so use that as start
const START_DATE = '2023-03-28';
const END_DATE = '2026-01-25';
// IV data only from Jan 2025
const IV_START_DATE = '2025-01-13';

// ─── Utility Functions ───────────────────────────────────────────────────────

function pearsonCorrelation(x, y) {
  const n = x.length;
  if (n < 10) return { r: null, n };

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let num = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  if (denom === 0) return { r: 0, n };
  return { r: num / denom, n };
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / arr.length);
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(p / 100 * (sorted.length - 1));
  return sorted[idx];
}

function r(v, d = 4) {
  return Math.round(v * 10 ** d) / 10 ** d;
}

// ─── Data Loading ────────────────────────────────────────────────────────────

async function loadPriceData() {
  console.log('Loading continuous 1m data for NQ and ES...\n');

  const [nqCandles, esCandles] = await Promise.all([
    loadContinuousOHLCV('NQ', '1m', START_DATE, END_DATE),
    loadContinuousOHLCV('ES', '1m', START_DATE, END_DATE)
  ]);

  // Build timestamp-indexed maps
  const nqMap = new Map();
  for (const c of nqCandles) nqMap.set(c.timestamp, c);

  const esMap = new Map();
  for (const c of esCandles) esMap.set(c.timestamp, c);

  // Find overlapping timestamps
  const commonTimestamps = [];
  for (const ts of nqMap.keys()) {
    if (esMap.has(ts)) commonTimestamps.push(ts);
  }
  commonTimestamps.sort((a, b) => a - b);

  console.log(`Overlapping bars: ${commonTimestamps.length.toLocaleString()}\n`);

  return { nqCandles, esCandles, nqMap, esMap, commonTimestamps };
}

/**
 * Load all intraday GEX data, indexed by 15-min floored timestamp
 * Returns a map of timestamp_ms -> snapshot for fast lookup
 */
function loadAllGEXData(product) {
  const dir = path.join(DATA_DIR, 'gex', product.toLowerCase());
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f.startsWith(`${product.toLowerCase()}_gex_`));
  files.sort();

  console.log(`Loading ${files.length} ${product} GEX JSON files...`);

  const snapshots = []; // sorted array of { timestamp_ms, ...snapshot }
  let totalSnapshots = 0;

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
    if (!data.data) continue;

    for (const snap of data.data) {
      const ts = new Date(snap.timestamp).getTime();
      if (isNaN(ts)) continue;
      snapshots.push({ ...snap, timestamp_ms: ts });
      totalSnapshots++;
    }
  }

  snapshots.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  console.log(`  Loaded ${totalSnapshots.toLocaleString()} ${product} GEX snapshots`);

  return snapshots;
}

/**
 * Binary search: find most recent GEX snapshot at or before targetMs
 */
function getGEXAt(snapshots, targetMs) {
  if (!snapshots || snapshots.length === 0) return null;
  if (targetMs < snapshots[0].timestamp_ms) return null;

  let lo = 0, hi = snapshots.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (snapshots[mid].timestamp_ms <= targetMs) lo = mid;
    else hi = mid - 1;
  }

  // Only use if snapshot is within 20 minutes (stale guard)
  const snap = snapshots[lo];
  if (targetMs - snap.timestamp_ms > 20 * 60 * 1000) return null;

  return snap;
}

/**
 * Load QQQ ATM IV data
 */
function loadIVData() {
  const filePath = path.join(DATA_DIR, 'iv', 'qqq', 'qqq_atm_iv_15m.csv');
  if (!fs.existsSync(filePath)) {
    console.log('IV data file not found, skipping IV analyses');
    return [];
  }

  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const header = lines[0].split(',');
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 7) continue;
    const ts = new Date(parts[0]).getTime();
    if (isNaN(ts)) continue;
    records.push({
      timestamp_ms: ts,
      iv: parseFloat(parts[1]),
      spotPrice: parseFloat(parts[2]),
      callIV: parseFloat(parts[4]),
      putIV: parseFloat(parts[5]),
      dte: parseInt(parts[6])
    });
  }

  records.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  console.log(`Loaded ${records.length.toLocaleString()} IV records (${new Date(records[0].timestamp_ms).toISOString().slice(0,10)} to ${new Date(records[records.length-1].timestamp_ms).toISOString().slice(0,10)})\n`);
  return records;
}

/**
 * Binary search for IV at a given time
 */
function getIVAt(ivRecords, targetMs) {
  if (!ivRecords || ivRecords.length === 0) return null;
  if (targetMs < ivRecords[0].timestamp_ms) return null;

  let lo = 0, hi = ivRecords.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ivRecords[mid].timestamp_ms <= targetMs) lo = mid;
    else hi = mid - 1;
  }

  const rec = ivRecords[lo];
  if (targetMs - rec.timestamp_ms > 20 * 60 * 1000) return null;
  return rec;
}

// ─── Analysis 1: GEX Regime Effect on NQ/ES Correlation ─────────────────────

function analysis1_regimeCorrelation(commonTimestamps, nqMap, esMap, nqGEX, esGEX) {
  console.log('\n' + '═'.repeat(80));
  console.log('ANALYSIS 1: GEX Regime Effect on NQ/ES 1-Minute Return Correlation');
  console.log('═'.repeat(80));

  // Bucket returns by regime combination
  const buckets = {}; // "nqRegime|esRegime" -> { nqReturns: [], esReturns: [] }

  for (let i = 1; i < commonTimestamps.length; i++) {
    const ts = commonTimestamps[i];
    const prevTs = commonTimestamps[i - 1];

    // Skip if gap > 2 minutes (session boundary)
    if (ts - prevTs > 120000) continue;

    const nq = nqMap.get(ts);
    const es = esMap.get(ts);
    const nqPrev = nqMap.get(prevTs);
    const esPrev = esMap.get(prevTs);

    const nqReturn = (nq.close - nqPrev.close) / nqPrev.close;
    const esReturn = (es.close - esPrev.close) / esPrev.close;

    const nqSnap = getGEXAt(nqGEX, ts);
    const esSnap = getGEXAt(esGEX, ts);
    if (!nqSnap || !esSnap) continue;

    const key = `${nqSnap.regime}|${esSnap.regime}`;
    if (!buckets[key]) buckets[key] = { nqReturns: [], esReturns: [] };
    buckets[key].nqReturns.push(nqReturn);
    buckets[key].esReturns.push(esReturn);
  }

  // Also compute by simplified regime (collapse to pos/neg/neutral)
  const simplified = {};
  for (const [key, data] of Object.entries(buckets)) {
    const [nqR, esR] = key.split('|');
    const nqSimple = nqR.includes('positive') ? 'positive' : nqR.includes('negative') ? 'negative' : 'neutral';
    const esSimple = esR.includes('positive') ? 'positive' : esR.includes('negative') ? 'negative' : 'neutral';
    const sKey = `${nqSimple}|${esSimple}`;
    if (!simplified[sKey]) simplified[sKey] = { nqReturns: [], esReturns: [] };
    // Avoid push(...arr) which overflows stack on large arrays
    for (let j = 0; j < data.nqReturns.length; j++) {
      simplified[sKey].nqReturns.push(data.nqReturns[j]);
      simplified[sKey].esReturns.push(data.esReturns[j]);
    }
  }

  console.log('\nSimplified Regime Combinations (positive/negative/neutral):');
  console.log(`${'NQ Regime'.padEnd(12)} ${'ES Regime'.padEnd(12)} ${'Correlation'.padEnd(14)} ${'Dir Agree'.padEnd(12)} ${'N Bars'.padEnd(12)} ${'NQ Vol'.padEnd(10)} ${'ES Vol'.padEnd(10)}`);
  console.log('-'.repeat(82));

  const regimeResults = [];
  for (const [key, data] of Object.entries(simplified).sort((a, b) => b[1].nqReturns.length - a[1].nqReturns.length)) {
    const [nqR, esR] = key.split('|');
    const { r: corr } = pearsonCorrelation(data.nqReturns, data.esReturns);
    const n = data.nqReturns.length;

    // Directional agreement
    let agree = 0;
    for (let i = 0; i < n; i++) {
      if (Math.sign(data.nqReturns[i]) === Math.sign(data.esReturns[i])) agree++;
    }

    const nqVol = stddev(data.nqReturns) * 100;
    const esVol = stddev(data.esReturns) * 100;

    const dirAgreePct = (agree / n * 100).toFixed(1);
    console.log(`${nqR.padEnd(12)} ${esR.padEnd(12)} ${corr !== null ? r(corr).toFixed(4).padEnd(14) : 'N/A'.padEnd(14)} ${(dirAgreePct + '%').padEnd(12)} ${n.toLocaleString().padEnd(12)} ${r(nqVol, 3).toFixed(3).padEnd(10)} ${r(esVol, 3).toFixed(3).padEnd(10)}`);
    regimeResults.push({ nqRegime: nqR, esRegime: esR, correlation: r(corr, 4), dirAgree: parseFloat(dirAgreePct), n, nqVol: r(nqVol, 3), esVol: r(esVol, 3) });
  }

  return regimeResults;
}

// ─── Analysis 2: GEX Regime Divergence as a Signal ──────────────────────────

function analysis2_regimeDivergence(commonTimestamps, nqMap, esMap, nqGEX, esGEX) {
  console.log('\n' + '═'.repeat(80));
  console.log('ANALYSIS 2: GEX Regime Divergence → Forward NQ/ES Relative Returns');
  console.log('═'.repeat(80));

  const FORWARD_PERIODS = [15, 30, 60, 240]; // minutes
  const tsIndex = new Map();
  commonTimestamps.forEach((ts, i) => tsIndex.set(ts, i));

  // Track regime divergence events
  const events = {
    nqPos_esNeg: [],  // NQ positive regime, ES negative
    nqNeg_esPos: [],  // NQ negative, ES positive
    aligned: []       // both same direction
  };

  // Sample every 15 minutes to align with GEX snapshots
  for (let i = 0; i < commonTimestamps.length; i++) {
    const ts = commonTimestamps[i];
    const et = toET(ts);
    // Only sample at 15-min boundaries during RTH
    if (et.minute % 15 !== 0) continue;
    if (et.timeInMinutes < 570 || et.timeInMinutes >= 960) continue;

    const nqSnap = getGEXAt(nqGEX, ts);
    const esSnap = getGEXAt(esGEX, ts);
    if (!nqSnap || !esSnap) continue;

    const nqPositive = nqSnap.regime.includes('positive');
    const nqNegative = nqSnap.regime.includes('negative');
    const esPositive = esSnap.regime.includes('positive');
    const esNegative = esSnap.regime.includes('negative');

    // Calculate forward returns
    const nq = nqMap.get(ts);
    const es = esMap.get(ts);
    if (!nq || !es) continue;

    const forwardReturns = {};
    let hasAllForward = true;
    for (const mins of FORWARD_PERIODS) {
      const fwdTs = ts + mins * 60000;
      const fwdIdx = tsIndex.get(fwdTs);
      if (fwdIdx === undefined) {
        // Try to find closest timestamp within 2 min
        let found = false;
        for (let delta = -120000; delta <= 120000; delta += 60000) {
          const tryTs = fwdTs + delta;
          if (nqMap.has(tryTs) && esMap.has(tryTs)) {
            const nqFwd = nqMap.get(tryTs);
            const esFwd = esMap.get(tryTs);
            forwardReturns[mins] = {
              nqReturn: (nqFwd.close - nq.close) / nq.close * 100,
              esReturn: (esFwd.close - es.close) / es.close * 100,
              relReturn: ((nqFwd.close - nq.close) / nq.close - (esFwd.close - es.close) / es.close) * 100
            };
            found = true;
            break;
          }
        }
        if (!found) { hasAllForward = false; break; }
      } else {
        const nqFwd = nqMap.get(commonTimestamps[fwdIdx]);
        const esFwd = esMap.get(commonTimestamps[fwdIdx]);
        if (!nqFwd || !esFwd) { hasAllForward = false; break; }
        forwardReturns[mins] = {
          nqReturn: (nqFwd.close - nq.close) / nq.close * 100,
          esReturn: (esFwd.close - es.close) / es.close * 100,
          relReturn: ((nqFwd.close - nq.close) / nq.close - (esFwd.close - es.close) / es.close) * 100
        };
      }
    }

    if (!hasAllForward) continue;

    const event = { ts, nqRegime: nqSnap.regime, esRegime: esSnap.regime, forwardReturns };

    if (nqPositive && esNegative) events.nqPos_esNeg.push(event);
    else if (nqNegative && esPositive) events.nqNeg_esPos.push(event);
    else if ((nqPositive && esPositive) || (nqNegative && esNegative)) events.aligned.push(event);
  }

  console.log(`\nRegime divergence events found:`);
  console.log(`  NQ positive / ES negative: ${events.nqPos_esNeg.length}`);
  console.log(`  NQ negative / ES positive: ${events.nqNeg_esPos.length}`);
  console.log(`  Aligned (both same dir):   ${events.aligned.length}`);

  const divergenceResults = {};

  for (const [label, evts] of Object.entries(events)) {
    if (evts.length < 10) continue;
    console.log(`\n--- ${label} (n=${evts.length}) ---`);
    console.log(`${'Forward'.padEnd(10)} ${'NQ Avg%'.padEnd(12)} ${'ES Avg%'.padEnd(12)} ${'NQ-ES Rel%'.padEnd(14)} ${'NQ>ES %'.padEnd(10)}`);

    const result = {};
    for (const mins of FORWARD_PERIODS) {
      const nqRets = evts.map(e => e.forwardReturns[mins].nqReturn);
      const esRets = evts.map(e => e.forwardReturns[mins].esReturn);
      const relRets = evts.map(e => e.forwardReturns[mins].relReturn);
      const nqOutperforms = relRets.filter(r => r > 0).length / relRets.length * 100;

      console.log(`${(mins + 'm').padEnd(10)} ${r(mean(nqRets), 4).toFixed(4).padEnd(12)} ${r(mean(esRets), 4).toFixed(4).padEnd(12)} ${r(mean(relRets), 4).toFixed(4).padEnd(14)} ${r(nqOutperforms, 1).toFixed(1).padEnd(10)}`);
      result[mins] = { nqAvg: r(mean(nqRets), 4), esAvg: r(mean(esRets), 4), relAvg: r(mean(relRets), 4), nqOutperformPct: r(nqOutperforms, 1) };
    }
    divergenceResults[label] = { n: evts.length, forwards: result };
  }

  return divergenceResults;
}

// ─── Analysis 3: GEX Level Proximity + NQ/ES Divergence ─────────────────────

function analysis3_levelProximity(commonTimestamps, nqMap, esMap, nqGEX, esGEX) {
  console.log('\n' + '═'.repeat(80));
  console.log('ANALYSIS 3: GEX Level Proximity — One Instrument Near Level, Other Free');
  console.log('═'.repeat(80));

  const PROXIMITY_POINTS_NQ = 15; // NQ within 15 pts of GEX level
  const PROXIMITY_POINTS_ES = 5;  // ES within 5 pts of GEX level
  const FORWARD_MINUTES = [15, 30, 60];

  function getNearestLevelDist(snap, price, product) {
    const levels = [];
    if (snap.gamma_flip) levels.push(snap.gamma_flip);
    if (snap.call_wall) levels.push(snap.call_wall);
    if (snap.put_wall) levels.push(snap.put_wall);
    if (snap.resistance) levels.push(...snap.resistance.filter(l => l > 0));
    if (snap.support) levels.push(...snap.support.filter(l => l > 0));

    let minDist = Infinity;
    let nearestLevel = null;
    for (const level of levels) {
      const dist = Math.abs(price - level);
      if (dist < minDist) {
        minDist = dist;
        nearestLevel = level;
      }
    }
    return { dist: minDist, level: nearestLevel };
  }

  // Events where NQ is near a level but ES is not, and vice versa
  const nqPinnedEvents = []; // NQ near GEX level, ES free
  const esPinnedEvents = []; // ES near GEX level, NQ free

  for (let i = 0; i < commonTimestamps.length; i++) {
    const ts = commonTimestamps[i];
    const et = toET(ts);
    if (et.minute % 15 !== 0) continue;
    if (et.timeInMinutes < 570 || et.timeInMinutes >= 960) continue;

    const nqSnap = getGEXAt(nqGEX, ts);
    const esSnap = getGEXAt(esGEX, ts);
    if (!nqSnap || !esSnap) continue;

    const nq = nqMap.get(ts);
    const es = esMap.get(ts);
    if (!nq || !es) continue;

    const nqDist = getNearestLevelDist(nqSnap, nq.close, 'NQ');
    const esDist = getNearestLevelDist(esSnap, es.close, 'ES');

    const nqNear = nqDist.dist <= PROXIMITY_POINTS_NQ;
    const esNear = esDist.dist <= PROXIMITY_POINTS_ES;

    if (!nqNear && !esNear) continue; // Neither near a level

    // Calculate forward returns
    const forwardReturns = {};
    let valid = true;
    for (const mins of FORWARD_MINUTES) {
      const fwdTs = ts + mins * 60000;
      // Find closest available timestamp
      let nqFwd = null, esFwd = null;
      for (let delta = 0; delta <= 120000; delta += 60000) {
        if (nqMap.has(fwdTs + delta) && esMap.has(fwdTs + delta)) {
          nqFwd = nqMap.get(fwdTs + delta);
          esFwd = esMap.get(fwdTs + delta);
          break;
        }
        if (delta > 0 && nqMap.has(fwdTs - delta) && esMap.has(fwdTs - delta)) {
          nqFwd = nqMap.get(fwdTs - delta);
          esFwd = esMap.get(fwdTs - delta);
          break;
        }
      }
      if (!nqFwd || !esFwd) { valid = false; break; }
      forwardReturns[mins] = {
        nqReturn: (nqFwd.close - nq.close) / nq.close * 100,
        esReturn: (esFwd.close - es.close) / es.close * 100,
        nqPoints: nqFwd.close - nq.close,
        esPoints: esFwd.close - es.close
      };
    }
    if (!valid) continue;

    if (nqNear && !esNear) {
      nqPinnedEvents.push({ ts, nqDist: nqDist.dist, esDistFromLevel: esDist.dist, forwardReturns, nqPrice: nq.close, nqLevel: nqDist.level });
    } else if (esNear && !nqNear) {
      esPinnedEvents.push({ ts, esDist: esDist.dist, nqDistFromLevel: nqDist.dist, forwardReturns, esPrice: es.close, esLevel: esDist.level });
    }
  }

  console.log(`\nEvents found:`);
  console.log(`  NQ near GEX level, ES free: ${nqPinnedEvents.length}`);
  console.log(`  ES near GEX level, NQ free: ${esPinnedEvents.length}`);

  const proximityResults = {};

  for (const [label, evts] of [['NQ pinned, ES free', nqPinnedEvents], ['ES pinned, NQ free', esPinnedEvents]]) {
    if (evts.length < 20) continue;

    console.log(`\n--- ${label} (n=${evts.length}) ---`);
    console.log(`Hypothesis: Pinned instrument shows lower move, free instrument moves more`);
    console.log(`${'Forward'.padEnd(10)} ${'NQ Avg Pts'.padEnd(14)} ${'ES Avg Pts'.padEnd(14)} ${'NQ |Move|'.padEnd(14)} ${'ES |Move|'.padEnd(14)} ${'Pinned < Free?'}`);

    const result = {};
    for (const mins of FORWARD_MINUTES) {
      const nqPts = evts.map(e => e.forwardReturns[mins].nqPoints);
      const esPts = evts.map(e => e.forwardReturns[mins].esPoints);
      const nqAbsAvg = mean(nqPts.map(Math.abs));
      const esAbsAvg = mean(esPts.map(Math.abs));
      const pinnedSmaller = label.startsWith('NQ') ? nqAbsAvg < esAbsAvg : esAbsAvg < nqAbsAvg;

      console.log(`${(mins + 'm').padEnd(10)} ${r(mean(nqPts), 2).toFixed(2).padEnd(14)} ${r(mean(esPts), 2).toFixed(2).padEnd(14)} ${r(nqAbsAvg, 2).toFixed(2).padEnd(14)} ${r(esAbsAvg, 2).toFixed(2).padEnd(14)} ${pinnedSmaller ? 'YES' : 'NO'}`);
      result[mins] = { nqAvgPts: r(mean(nqPts), 2), esAvgPts: r(mean(esPts), 2), nqAbsAvg: r(nqAbsAvg, 2), esAbsAvg: r(esAbsAvg, 2), pinnedSmaller };
    }
    proximityResults[label] = { n: evts.length, forwards: result };
  }

  return proximityResults;
}

// ─── Analysis 4: NQ-Leads-ES Filtered by GEX Regime ─────────────────────────

function analysis4_leadLagByRegime(commonTimestamps, nqMap, esMap, nqGEX, esGEX) {
  console.log('\n' + '═'.repeat(80));
  console.log('ANALYSIS 4: NQ-Leads-ES Strategy Filtered by GEX Regime');
  console.log('═'.repeat(80));
  console.log('(NQ moves >0.15%, hold ES for 5 min in NQ\'s direction)');

  const THRESHOLD = 0.0015; // 0.15%
  const HOLD_BARS = 5;

  // Group trades by combined regime
  const regimeTrades = {};

  for (let i = 1; i < commonTimestamps.length - HOLD_BARS; i++) {
    const ts = commonTimestamps[i];
    const prevTs = commonTimestamps[i - 1];
    if (ts - prevTs > 120000) continue;

    const nqPrev = nqMap.get(prevTs);
    const nqCurr = nqMap.get(ts);
    const nqReturn = (nqCurr.close - nqPrev.close) / nqPrev.close;

    if (Math.abs(nqReturn) < THRESHOLD) continue;

    // Check we have continuous bars for the hold period
    const exitTs = commonTimestamps[i + HOLD_BARS];
    if (!exitTs || exitTs - ts > (HOLD_BARS + 2) * 60000) continue;

    const esEntry = esMap.get(ts);
    const esExit = esMap.get(exitTs);
    if (!esEntry || !esExit) continue;

    const direction = nqReturn > 0 ? 1 : -1;
    const esReturn = (esExit.close - esEntry.close) / esEntry.close;
    const tradeReturn = esReturn * direction;
    const esPnL = (esExit.close - esEntry.close) * direction;

    const nqSnap = getGEXAt(nqGEX, ts);
    const esSnap = getGEXAt(esGEX, ts);

    let regime = 'no_gex';
    if (nqSnap && esSnap) {
      const nqSimple = nqSnap.regime.includes('positive') ? 'pos' : nqSnap.regime.includes('negative') ? 'neg' : 'neut';
      const esSimple = esSnap.regime.includes('positive') ? 'pos' : esSnap.regime.includes('negative') ? 'neg' : 'neut';
      regime = `${nqSimple}_${esSimple}`;
    }

    if (!regimeTrades[regime]) regimeTrades[regime] = [];
    regimeTrades[regime].push({ tradeReturn, esPnL, direction });
  }

  // Also create simplified buckets
  const simpleTrades = { positive: [], negative: [], neutral: [], mixed: [], no_gex: [] };
  for (const [regime, trades] of Object.entries(regimeTrades)) {
    if (regime === 'no_gex') { simpleTrades.no_gex.push(...trades); continue; }
    const [nq, es] = regime.split('_');
    if (nq === 'pos' && es === 'pos') simpleTrades.positive.push(...trades);
    else if (nq === 'neg' && es === 'neg') simpleTrades.negative.push(...trades);
    else if (nq === 'neut' && es === 'neut') simpleTrades.neutral.push(...trades);
    else simpleTrades.mixed.push(...trades);
  }

  console.log(`\nSimplified GEX Buckets:`);
  console.log(`${'Regime'.padEnd(14)} ${'Trades'.padEnd(10)} ${'Win Rate'.padEnd(12)} ${'Avg ES Pts'.padEnd(14)} ${'Profit Factor'.padEnd(14)} ${'Cum ES Pts'}`);
  console.log('-'.repeat(74));

  const leadLagResults = {};
  for (const [regime, trades] of Object.entries(simpleTrades).sort((a, b) => b[1].length - a[1].length)) {
    if (trades.length < 20) continue;
    const wins = trades.filter(t => t.esPnL > 0).length;
    const winRate = wins / trades.length * 100;
    const avgPts = mean(trades.map(t => t.esPnL));
    const totalWins = trades.filter(t => t.esPnL > 0).reduce((s, t) => s + t.esPnL, 0);
    const totalLosses = Math.abs(trades.filter(t => t.esPnL <= 0).reduce((s, t) => s + t.esPnL, 0));
    const pf = totalLosses > 0 ? totalWins / totalLosses : Infinity;
    const cumPts = trades.reduce((s, t) => s + t.esPnL, 0);

    console.log(`${regime.padEnd(14)} ${trades.length.toString().padEnd(10)} ${r(winRate, 1).toFixed(1).padEnd(12)} ${r(avgPts, 2).toFixed(2).padEnd(14)} ${r(pf, 2).toFixed(2).padEnd(14)} ${r(cumPts, 1).toFixed(1)}`);
    leadLagResults[regime] = { n: trades.length, winRate: r(winRate, 1), avgPts: r(avgPts, 2), profitFactor: r(pf, 2), cumPts: r(cumPts, 1) };
  }

  return leadLagResults;
}

// ─── Analysis 5: Daily Ratio Mean Reversion Filtered by GEX ─────────────────

function analysis5_ratioMeanReversionByGEX(commonTimestamps, nqMap, esMap, nqGEX, esGEX) {
  console.log('\n' + '═'.repeat(80));
  console.log('ANALYSIS 5: Daily NQ/ES Ratio Mean Reversion Filtered by GEX Regime');
  console.log('═'.repeat(80));

  // Build daily data: compute NQ/ES close ratio at 16:00 ET each day
  // Pre-group candles by date to avoid repeated full-array scans
  const nqByDate = {};
  const esByDate = {};
  for (const ts of commonTimestamps) {
    const et = toET(ts);
    if (et.timeInMinutes < 570 || et.timeInMinutes >= 960) continue;
    if (et.dayOfWeek < 1 || et.dayOfWeek > 5) continue;
    const d = et.date;
    if (!nqByDate[d]) nqByDate[d] = [];
    if (!esByDate[d]) esByDate[d] = [];
    nqByDate[d].push(nqMap.get(ts));
    esByDate[d].push(esMap.get(ts));
  }
  const tradingDates = Object.keys(nqByDate).sort();
  const dailyRatios = [];

  for (const dateStr of tradingDates) {
    const rthNQ = nqByDate[dateStr];
    const rthES = esByDate[dateStr];
    if (!rthNQ || !rthES || rthNQ.length === 0 || rthES.length === 0) continue;

    const nqClose = rthNQ[rthNQ.length - 1].close;
    const esClose = rthES[rthES.length - 1].close;
    const ratio = nqClose / esClose;

    // Get GEX regime at 14:00 ET (mid-afternoon, well-established for the day)
    const [yr, mo, dy] = dateStr.split('-').map(Number);
    const midDayTs = fromET(yr, mo - 1, dy, 14, 0);

    const nqSnap = getGEXAt(nqGEX, midDayTs);
    const esSnap = getGEXAt(esGEX, midDayTs);

    dailyRatios.push({
      date: dateStr,
      ratio,
      nqClose,
      esClose,
      nqRegime: nqSnap?.regime || 'unknown',
      esRegime: esSnap?.regime || 'unknown',
      nqTotalGex: nqSnap?.total_gex || 0,
      esTotalGex: esSnap?.total_gex || 0
    });
  }

  console.log(`Trading days with data: ${dailyRatios.length}`);

  // Compute 20-day rolling z-score (matches original methodology from es-nq-correlation.js)
  const LOOKBACK = 20;
  const REVERSION_DAYS = 5;
  const Z_THRESHOLD = 2;

  const ratioValues = dailyRatios.map(d => d.ratio);
  const extremeEvents = [];

  for (let i = LOOKBACK; i < dailyRatios.length - REVERSION_DAYS; i++) {
    const window = ratioValues.slice(i - LOOKBACK, i);
    const mu = mean(window);
    const sigma = stddev(window);
    if (sigma === 0) continue;

    const current = dailyRatios[i];
    const z = (current.ratio - mu) / sigma;

    if (Math.abs(z) < Z_THRESHOLD) continue;

    // Reversion check: slide the 20-day window forward and recompute z at day+5
    // Match original: reverted = abs(futureZ at day 5) < abs(z at day 0)
    const fWindow = ratioValues.slice(i - LOOKBACK + REVERSION_DAYS, i + REVERSION_DAYS);
    const fMu = mean(fWindow);
    const fSigma = stddev(fWindow);
    let reverted = false;
    if (fSigma > 0) {
      const futureZ = (ratioValues[i + REVERSION_DAYS] - fMu) / fSigma;
      reverted = Math.abs(futureZ) < Math.abs(z);
    }

    const direction = z > 0 ? 'nq_rich' : 'es_rich';

    // Classify GEX regime
    const nqSimple = current.nqRegime.includes('positive') ? 'positive' : current.nqRegime.includes('negative') ? 'negative' : 'neutral';
    const esSimple = current.esRegime.includes('positive') ? 'positive' : current.esRegime.includes('negative') ? 'negative' : 'neutral';

    // 5-day return of the ratio (for measuring reversion magnitude)
    const ratioReturn = (dailyRatios[i + REVERSION_DAYS].ratio - current.ratio) / current.ratio * 100;

    extremeEvents.push({
      date: current.date,
      z,
      direction,
      reverted,
      ratioReturn,
      nqRegime: nqSimple,
      esRegime: esSimple,
      nqTotalGex: current.nqTotalGex,
      esTotalGex: current.esTotalGex
    });
  }

  console.log(`Extreme z-score events (|z|>2): ${extremeEvents.length}`);

  // Overall reversion rate
  const overallReversion = extremeEvents.filter(e => e.reverted).length / extremeEvents.length * 100;
  console.log(`Overall 5-day reversion rate: ${r(overallReversion, 1)}%`);

  // By GEX regime
  console.log(`\nReversion Rate by GEX Regime:`);
  console.log(`${'NQ GEX'.padEnd(12)} ${'ES GEX'.padEnd(12)} ${'Events'.padEnd(10)} ${'Revert%'.padEnd(10)} ${'Avg Ratio Return'.padEnd(18)} ${'Med Ratio Return'}`);
  console.log('-'.repeat(72));

  const regimeBuckets = {};
  for (const e of extremeEvents) {
    const key = `${e.nqRegime}|${e.esRegime}`;
    if (!regimeBuckets[key]) regimeBuckets[key] = [];
    regimeBuckets[key].push(e);
  }

  const ratioResults = {};
  for (const [key, evts] of Object.entries(regimeBuckets).sort((a, b) => b[1].length - a[1].length)) {
    if (evts.length < 5) continue;
    const [nqR, esR] = key.split('|');
    const revRate = evts.filter(e => e.reverted).length / evts.length * 100;
    const avgRatioRet = mean(evts.map(e => e.ratioReturn));
    const medRatioRet = median(evts.map(e => e.ratioReturn));

    console.log(`${nqR.padEnd(12)} ${esR.padEnd(12)} ${evts.length.toString().padEnd(10)} ${r(revRate, 1).toFixed(1).padEnd(10)} ${r(avgRatioRet, 3).toFixed(3).padEnd(18)} ${r(medRatioRet, 3).toFixed(3)}`);
    ratioResults[key] = { n: evts.length, reversionRate: r(revRate, 1), avgRatioReturn: r(avgRatioRet, 3), medRatioReturn: r(medRatioRet, 3) };
  }

  // Also by total GEX sign (combined NQ+ES GEX > 0 vs < 0)
  console.log(`\nReversion by Combined GEX Magnitude:`);
  const gexPositive = extremeEvents.filter(e => e.nqTotalGex > 0 && e.esTotalGex > 0);
  const gexNegative = extremeEvents.filter(e => e.nqTotalGex < 0 || e.esTotalGex < 0);

  if (gexPositive.length >= 5) {
    const revRate = gexPositive.filter(e => e.reverted).length / gexPositive.length * 100;
    console.log(`  Both GEX positive: ${gexPositive.length} events, ${r(revRate, 1)}% revert (avg ratio return: ${r(mean(gexPositive.map(e => e.ratioReturn)), 3)})`);
    ratioResults['both_positive'] = { n: gexPositive.length, reversionRate: r(revRate, 1) };
  }
  if (gexNegative.length >= 5) {
    const revRate = gexNegative.filter(e => e.reverted).length / gexNegative.length * 100;
    console.log(`  Any GEX negative:  ${gexNegative.length} events, ${r(revRate, 1)}% revert (avg ratio return: ${r(mean(gexNegative.map(e => e.ratioReturn)), 3)})`);
    ratioResults['any_negative'] = { n: gexNegative.length, reversionRate: r(revRate, 1) };
  }

  return { overallReversionRate: r(overallReversion, 1), totalEvents: extremeEvents.length, byRegime: ratioResults };
}

// ─── Analysis 6: IV Level and Change Effect on Correlation ──────────────────

function analysis6_ivEffect(commonTimestamps, nqMap, esMap, ivRecords) {
  console.log('\n' + '═'.repeat(80));
  console.log('ANALYSIS 6: IV Level & Change Effect on NQ/ES Correlation (2025 only)');
  console.log('═'.repeat(80));

  if (!ivRecords || ivRecords.length === 0) {
    console.log('No IV data available, skipping.');
    return null;
  }

  // Filter common timestamps to 2025+ (IV data range)
  const ivStart = new Date(IV_START_DATE).getTime();
  const filteredTs = commonTimestamps.filter(ts => ts >= ivStart);
  console.log(`Bars in IV period: ${filteredTs.length.toLocaleString()}`);

  // Compute IV terciles
  const allIV = ivRecords.map(r => r.iv).filter(v => !isNaN(v));
  const ivP33 = percentile(allIV, 33);
  const ivP66 = percentile(allIV, 66);
  console.log(`IV terciles: low < ${r(ivP33 * 100, 1)}%, mid ${r(ivP33 * 100, 1)}-${r(ivP66 * 100, 1)}%, high > ${r(ivP66 * 100, 1)}%`);

  // Bucket returns by IV level and IV change
  const ivBuckets = { low: { nq: [], es: [] }, mid: { nq: [], es: [] }, high: { nq: [], es: [] } };
  const ivChangeBuckets = { falling: { nq: [], es: [] }, stable: { nq: [], es: [] }, rising: { nq: [], es: [] } };

  let prevIV = null;

  for (let i = 1; i < filteredTs.length; i++) {
    const ts = filteredTs[i];
    const prevTs = filteredTs[i - 1];
    if (ts - prevTs > 120000) continue;

    const nq = nqMap.get(ts);
    const es = esMap.get(ts);
    const nqPrev = nqMap.get(prevTs);
    const esPrev = esMap.get(prevTs);
    if (!nq || !es || !nqPrev || !esPrev) continue;

    const nqReturn = (nq.close - nqPrev.close) / nqPrev.close;
    const esReturn = (es.close - esPrev.close) / esPrev.close;

    const ivSnap = getIVAt(ivRecords, ts);
    if (!ivSnap || isNaN(ivSnap.iv)) continue;

    // IV level bucket
    const iv = ivSnap.iv;
    if (iv < ivP33) { ivBuckets.low.nq.push(nqReturn); ivBuckets.low.es.push(esReturn); }
    else if (iv < ivP66) { ivBuckets.mid.nq.push(nqReturn); ivBuckets.mid.es.push(esReturn); }
    else { ivBuckets.high.nq.push(nqReturn); ivBuckets.high.es.push(esReturn); }

    // IV change (compare to previous IV reading)
    if (prevIV !== null) {
      const ivChange = iv - prevIV;
      if (ivChange < -0.002) { ivChangeBuckets.falling.nq.push(nqReturn); ivChangeBuckets.falling.es.push(esReturn); }
      else if (ivChange > 0.002) { ivChangeBuckets.rising.nq.push(nqReturn); ivChangeBuckets.rising.es.push(esReturn); }
      else { ivChangeBuckets.stable.nq.push(nqReturn); ivChangeBuckets.stable.es.push(esReturn); }
    }
    prevIV = iv;
  }

  console.log(`\nCorrelation by IV Level:`);
  console.log(`${'IV Level'.padEnd(12)} ${'Correlation'.padEnd(14)} ${'Dir Agree'.padEnd(12)} ${'N Bars'.padEnd(12)} ${'NQ Vol'.padEnd(10)} ${'ES Vol'.padEnd(10)}`);
  console.log('-'.repeat(70));

  const ivResults = { byLevel: {}, byChange: {} };

  for (const [level, data] of Object.entries(ivBuckets)) {
    if (data.nq.length < 100) continue;
    const { r: corr } = pearsonCorrelation(data.nq, data.es);
    let agree = 0;
    for (let i = 0; i < data.nq.length; i++) {
      if (Math.sign(data.nq[i]) === Math.sign(data.es[i])) agree++;
    }
    const nqVol = stddev(data.nq) * 100;
    const esVol = stddev(data.es) * 100;

    console.log(`${level.padEnd(12)} ${r(corr, 4).toFixed(4).padEnd(14)} ${(r(agree/data.nq.length*100, 1)+'%').padEnd(12)} ${data.nq.length.toLocaleString().padEnd(12)} ${r(nqVol, 3).toFixed(3).padEnd(10)} ${r(esVol, 3).toFixed(3).padEnd(10)}`);
    ivResults.byLevel[level] = { correlation: r(corr, 4), dirAgree: r(agree/data.nq.length*100, 1), n: data.nq.length, nqVol: r(nqVol, 3), esVol: r(esVol, 3) };
  }

  console.log(`\nCorrelation by IV Change Direction:`);
  console.log(`${'IV Change'.padEnd(12)} ${'Correlation'.padEnd(14)} ${'Dir Agree'.padEnd(12)} ${'N Bars'.padEnd(12)} ${'NQ Vol'.padEnd(10)} ${'ES Vol'.padEnd(10)}`);
  console.log('-'.repeat(70));

  for (const [change, data] of Object.entries(ivChangeBuckets)) {
    if (data.nq.length < 100) continue;
    const { r: corr } = pearsonCorrelation(data.nq, data.es);
    let agree = 0;
    for (let i = 0; i < data.nq.length; i++) {
      if (Math.sign(data.nq[i]) === Math.sign(data.es[i])) agree++;
    }
    const nqVol = stddev(data.nq) * 100;
    const esVol = stddev(data.es) * 100;

    console.log(`${change.padEnd(12)} ${r(corr, 4).toFixed(4).padEnd(14)} ${(r(agree/data.nq.length*100, 1)+'%').padEnd(12)} ${data.nq.length.toLocaleString().padEnd(12)} ${r(nqVol, 3).toFixed(3).padEnd(10)} ${r(esVol, 3).toFixed(3).padEnd(10)}`);
    ivResults.byChange[change] = { correlation: r(corr, 4), dirAgree: r(agree/data.nq.length*100, 1), n: data.nq.length, nqVol: r(nqVol, 3), esVol: r(esVol, 3) };
  }

  return ivResults;
}

// ─── Analysis 7: Combined Signal — GEX Divergence + IV ──────────────────────

function analysis7_combinedSignal(commonTimestamps, nqMap, esMap, nqGEX, esGEX, ivRecords) {
  console.log('\n' + '═'.repeat(80));
  console.log('ANALYSIS 7: Combined Signal — GEX Regime Divergence + Elevated IV');
  console.log('═'.repeat(80));

  if (!ivRecords || ivRecords.length === 0) {
    console.log('No IV data available, skipping.');
    return null;
  }

  const allIV = ivRecords.map(r => r.iv).filter(v => !isNaN(v));
  const ivMedian = median(allIV);
  const ivP75 = percentile(allIV, 75);

  const ivStart = new Date(IV_START_DATE).getTime();
  const FORWARD_MINUTES = [15, 30, 60, 240];

  // Find events where: (1) GEX regimes disagree AND (2) IV is above median
  const combinedEvents = [];
  const gexDivOnly = [];
  const ivHighOnly = [];
  const neither = [];

  for (let i = 0; i < commonTimestamps.length; i++) {
    const ts = commonTimestamps[i];
    if (ts < ivStart) continue;
    const et = toET(ts);
    if (et.minute % 15 !== 0) continue;
    if (et.timeInMinutes < 570 || et.timeInMinutes >= 960) continue;

    const nqSnap = getGEXAt(nqGEX, ts);
    const esSnap = getGEXAt(esGEX, ts);
    if (!nqSnap || !esSnap) continue;

    const nq = nqMap.get(ts);
    const es = esMap.get(ts);
    if (!nq || !es) continue;

    const ivSnap = getIVAt(ivRecords, ts);
    if (!ivSnap) continue;

    // Check GEX divergence
    const nqPos = nqSnap.regime.includes('positive');
    const nqNeg = nqSnap.regime.includes('negative');
    const esPos = esSnap.regime.includes('positive');
    const esNeg = esSnap.regime.includes('negative');
    const gexDiverged = (nqPos && esNeg) || (nqNeg && esPos);

    // Check IV level
    const ivHigh = ivSnap.iv >= ivMedian;
    const ivVeryHigh = ivSnap.iv >= ivP75;

    // Calculate forward returns
    const forwardReturns = {};
    let valid = true;
    for (const mins of FORWARD_MINUTES) {
      const fwdTs = ts + mins * 60000;
      let nqFwd = null, esFwd = null;
      for (let delta = 0; delta <= 120000; delta += 60000) {
        if (nqMap.has(fwdTs + delta) && esMap.has(fwdTs + delta)) {
          nqFwd = nqMap.get(fwdTs + delta);
          esFwd = esMap.get(fwdTs + delta);
          break;
        }
      }
      if (!nqFwd || !esFwd) { valid = false; break; }
      forwardReturns[mins] = {
        nqReturn: (nqFwd.close - nq.close) / nq.close * 100,
        esReturn: (esFwd.close - es.close) / es.close * 100,
        absDiv: Math.abs((nqFwd.close - nq.close) / nq.close - (esFwd.close - es.close) / es.close) * 100
      };
    }
    if (!valid) continue;

    const event = { ts, forwardReturns, iv: ivSnap.iv, nqRegime: nqSnap.regime, esRegime: esSnap.regime, gexDiverged, ivHigh, ivVeryHigh };

    if (gexDiverged && ivHigh) combinedEvents.push(event);
    else if (gexDiverged) gexDivOnly.push(event);
    else if (ivHigh) ivHighOnly.push(event);
    else neither.push(event);
  }

  console.log(`\nEvent counts (2025 period):`);
  console.log(`  GEX diverged + IV elevated: ${combinedEvents.length}`);
  console.log(`  GEX diverged only:          ${gexDivOnly.length}`);
  console.log(`  IV elevated only:           ${ivHighOnly.length}`);
  console.log(`  Neither:                    ${neither.length}`);

  // Compare absolute divergence in forward returns across conditions
  console.log(`\nForward NQ/ES Absolute Divergence (higher = more divergence opportunity):`);
  console.log(`${'Forward'.padEnd(10)} ${'Combined'.padEnd(14)} ${'GEX Div Only'.padEnd(14)} ${'IV High Only'.padEnd(14)} ${'Neither'.padEnd(14)}`);
  console.log('-'.repeat(66));

  const combinedResults = {};
  for (const mins of FORWARD_MINUTES) {
    const groups = {
      combined: combinedEvents.length > 0 ? mean(combinedEvents.map(e => e.forwardReturns[mins].absDiv)) : 0,
      gexDivOnly: gexDivOnly.length > 0 ? mean(gexDivOnly.map(e => e.forwardReturns[mins].absDiv)) : 0,
      ivHighOnly: ivHighOnly.length > 0 ? mean(ivHighOnly.map(e => e.forwardReturns[mins].absDiv)) : 0,
      neither: neither.length > 0 ? mean(neither.map(e => e.forwardReturns[mins].absDiv)) : 0
    };

    console.log(`${(mins + 'm').padEnd(10)} ${r(groups.combined, 4).toFixed(4).padEnd(14)} ${r(groups.gexDivOnly, 4).toFixed(4).padEnd(14)} ${r(groups.ivHighOnly, 4).toFixed(4).padEnd(14)} ${r(groups.neither, 4).toFixed(4).padEnd(14)}`);
    combinedResults[mins] = groups;
  }

  // Directional signal: when GEX diverges, does the positive-GEX instrument outperform?
  if (combinedEvents.length >= 10) {
    console.log(`\nDirectional test (combined events, n=${combinedEvents.length}):`);
    console.log(`When NQ GEX > ES GEX: does NQ outperform forward?`);

    for (const mins of FORWARD_MINUTES) {
      const nqPositiveGEX = combinedEvents.filter(e => e.nqRegime.includes('positive'));
      const esPositiveGEX = combinedEvents.filter(e => e.esRegime.includes('positive'));

      if (nqPositiveGEX.length >= 5) {
        const nqOutperforms = nqPositiveGEX.filter(e => e.forwardReturns[mins].nqReturn > e.forwardReturns[mins].esReturn).length;
        console.log(`  ${mins}m fwd | NQ pos GEX (n=${nqPositiveGEX.length}): NQ outperforms ${r(nqOutperforms / nqPositiveGEX.length * 100, 1)}%`);
      }
      if (esPositiveGEX.length >= 5) {
        const esOutperforms = esPositiveGEX.filter(e => e.forwardReturns[mins].esReturn > e.forwardReturns[mins].nqReturn).length;
        console.log(`  ${mins}m fwd | ES pos GEX (n=${esPositiveGEX.length}): ES outperforms ${r(esOutperforms / esPositiveGEX.length * 100, 1)}%`);
      }
    }
  }

  // Backtest: trade the positive-GEX instrument long relative to the other
  if (combinedEvents.length >= 20) {
    console.log(`\nSimple backtest: Long instrument with positive GEX, short the negative one`);
    console.log(`${'Hold'.padEnd(10)} ${'Trades'.padEnd(10)} ${'Win Rate'.padEnd(12)} ${'Avg Rel Ret%'.padEnd(16)} ${'Cum Rel Ret%'}`);
    console.log('-'.repeat(60));

    for (const mins of FORWARD_MINUTES) {
      const trades = [];
      for (const e of combinedEvents) {
        const nqPos = e.nqRegime.includes('positive');
        // If NQ is positive, go long NQ / short ES (expect NQ outperformance)
        const relReturn = nqPos
          ? e.forwardReturns[mins].nqReturn - e.forwardReturns[mins].esReturn
          : e.forwardReturns[mins].esReturn - e.forwardReturns[mins].nqReturn;
        trades.push(relReturn);
      }
      const wins = trades.filter(t => t > 0).length;
      const winRate = wins / trades.length * 100;
      const avgRet = mean(trades);
      const cumRet = trades.reduce((s, t) => s + t, 0);

      console.log(`${(mins + 'm').padEnd(10)} ${trades.length.toString().padEnd(10)} ${r(winRate, 1).toFixed(1).padEnd(12)} ${r(avgRet, 4).toFixed(4).padEnd(16)} ${r(cumRet, 3).toFixed(3)}`);
    }
  }

  return { eventCounts: { combined: combinedEvents.length, gexDivOnly: gexDivOnly.length, ivHighOnly: ivHighOnly.length, neither: neither.length }, forwardDivergence: combinedResults };
}

// ─── Report Generation ──────────────────────────────────────────────────────

function appendReport(results) {
  const reportPath = path.join(OUTPUT_DIR, 'es-nq-correlation-report.md');
  let existing = '';
  if (fs.existsSync(reportPath)) {
    existing = fs.readFileSync(reportPath, 'utf-8');
  }

  const report = `

---

## GEX/IV Overlay Analysis (Addendum)

**Date Range**: ${START_DATE} to ${END_DATE} (GEX period), ${IV_START_DATE} to ${END_DATE} (IV period)
**Generated**: ${new Date().toISOString().slice(0, 10)}

### Analysis 1: GEX Regime Effect on NQ/ES Correlation

${results.analysis1 ? `Key finding: Correlation varies by regime combination. Negative GEX regimes tend to show ${results.analysis1.find(r => r.nqRegime === 'negative' && r.esRegime === 'negative')?.correlation < results.analysis1.find(r => r.nqRegime === 'positive' && r.esRegime === 'positive')?.correlation ? 'lower' : 'similar or higher'} correlation than positive regimes.` : 'No results.'}

### Analysis 2: GEX Regime Divergence as Signal

${results.analysis2 ? Object.entries(results.analysis2).map(([k, v]) => `- **${k}** (n=${v.n}): ${v.forwards?.[60] ? `1h forward NQ-ES relative return: ${v.forwards[60].relAvg}%, NQ outperforms ${v.forwards[60].nqOutperformPct}% of time` : 'N/A'}`).join('\n') : 'No results.'}

### Analysis 3: GEX Level Proximity

${results.analysis3 ? Object.entries(results.analysis3).map(([k, v]) => `- **${k}** (n=${v.n}): ${v.forwards?.[30] ? `30m forward — pinned instrument shows smaller move: ${v.forwards[30].pinnedSmaller ? 'YES (confirmed)' : 'NO (not confirmed)'}` : 'N/A'}`).join('\n') : 'No results.'}

### Analysis 4: NQ-Leads-ES by GEX Regime

${results.analysis4 ? `| Regime | Trades | Win Rate | Avg ES Pts | PF |\n|--------|--------|----------|------------|----|\n${Object.entries(results.analysis4).map(([k, v]) => `| ${k} | ${v.n} | ${v.winRate}% | ${v.avgPts} | ${v.profitFactor} |`).join('\n')}` : 'No results.'}

### Analysis 5: Daily Ratio Mean Reversion by GEX

${results.analysis5 ? `Overall reversion rate: ${results.analysis5.overallReversionRate}% (n=${results.analysis5.totalEvents})

${results.analysis5.byRegime?.both_positive ? `- Both GEX positive: ${results.analysis5.byRegime.both_positive.reversionRate}% reversion (n=${results.analysis5.byRegime.both_positive.n})` : ''}
${results.analysis5.byRegime?.any_negative ? `- Any GEX negative: ${results.analysis5.byRegime.any_negative.reversionRate}% reversion (n=${results.analysis5.byRegime.any_negative.n})` : ''}` : 'No results.'}

### Analysis 6: IV Effect on Correlation

${results.analysis6 ? `| IV Level | Correlation | Dir Agreement | N |\n|----------|------------|--------------|---|\n${Object.entries(results.analysis6.byLevel).map(([k, v]) => `| ${k} | ${v.correlation} | ${v.dirAgree}% | ${v.n.toLocaleString()} |`).join('\n')}` : 'No IV data available.'}

### Analysis 7: Combined GEX Divergence + IV

${results.analysis7 ? `Events: ${results.analysis7.eventCounts.combined} combined, ${results.analysis7.eventCounts.gexDivOnly} GEX-only, ${results.analysis7.eventCounts.ivHighOnly} IV-only` : 'No IV data available.'}

*Generated by es-nq-gex-iv-overlay.js*
`;

  fs.writeFileSync(reportPath, existing + report);
  console.log(`\nReport appended to ${reportPath}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  // Load all data
  const { nqCandles, esCandles, nqMap, esMap, commonTimestamps } = await loadPriceData();

  console.log('Loading GEX data...');
  const nqGEX = loadAllGEXData('NQ');
  const esGEX = loadAllGEXData('ES');

  console.log('\nLoading IV data...');
  const ivRecords = loadIVData();

  const results = {};

  // Run all analyses
  results.analysis1 = analysis1_regimeCorrelation(commonTimestamps, nqMap, esMap, nqGEX, esGEX);
  results.analysis2 = analysis2_regimeDivergence(commonTimestamps, nqMap, esMap, nqGEX, esGEX);
  results.analysis3 = analysis3_levelProximity(commonTimestamps, nqMap, esMap, nqGEX, esGEX);
  results.analysis4 = analysis4_leadLagByRegime(commonTimestamps, nqMap, esMap, nqGEX, esGEX);
  results.analysis5 = analysis5_ratioMeanReversionByGEX(commonTimestamps, nqMap, esMap, nqGEX, esGEX);
  results.analysis6 = analysis6_ivEffect(commonTimestamps, nqMap, esMap, ivRecords);
  results.analysis7 = analysis7_combinedSignal(commonTimestamps, nqMap, esMap, nqGEX, esGEX, ivRecords);

  // Generate report
  appendReport(results);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nTotal runtime: ${elapsed}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
