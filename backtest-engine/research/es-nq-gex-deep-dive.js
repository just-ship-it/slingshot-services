#!/usr/bin/env node
/**
 * ES-NQ GEX Deep Dive — Analysis 3 & 4 Follow-Up
 *
 * Analysis 3 (GEX Level Proximity):
 *   3a. Normalize to % returns (fix apples-to-oranges point comparison)
 *   3b. Break down by level type (support vs resistance, gamma flip, put/call wall)
 *   3c. Bounce/rejection directional signal (does pinned instrument bounce?)
 *   3d. Sweep proximity thresholds
 *
 * Analysis 4 (NQ-Leads-ES + GEX):
 *   4a. Year-over-year stability
 *   4b. Parameter sweep (threshold × hold × regime)
 *   4c. Session filter overlay (RTH open vs mid vs close)
 *   4d. Equity curves with slippage scenarios
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadContinuousOHLCV,
  toET,
  fromET,
} from './utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.join(__dirname, 'output');
const DATA_DIR = path.join(__dirname, '..', 'data');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const START_DATE = '2023-03-28';
const END_DATE = '2026-01-25';

// ─── Utility Functions ───────────────────────────────────────────────────────

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
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(p / 100 * (sorted.length - 1));
  return sorted[idx];
}

function R(v, d = 4) { return Math.round(v * 10 ** d) / 10 ** d; }

function pf(trades) {
  const wins = trades.filter(t => t > 0).reduce((s, t) => s + t, 0);
  const losses = Math.abs(trades.filter(t => t <= 0).reduce((s, t) => s + t, 0));
  return losses > 0 ? wins / losses : wins > 0 ? Infinity : 0;
}

function winRate(trades) {
  return trades.filter(t => t > 0).length / trades.length * 100;
}

// ─── Data Loading (shared) ───────────────────────────────────────────────────

function loadAllGEXData(product) {
  const dir = path.join(DATA_DIR, 'gex', product.toLowerCase());
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f.startsWith(`${product.toLowerCase()}_gex_`));
  files.sort();
  console.log(`Loading ${files.length} ${product} GEX JSON files...`);
  const snapshots = [];
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
    if (!data.data) continue;
    for (const snap of data.data) {
      const ts = new Date(snap.timestamp).getTime();
      if (isNaN(ts)) continue;
      snapshots.push({ ...snap, timestamp_ms: ts });
    }
  }
  snapshots.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  console.log(`  Loaded ${snapshots.length.toLocaleString()} ${product} GEX snapshots`);
  return snapshots;
}

function getGEXAt(snapshots, targetMs) {
  if (!snapshots || snapshots.length === 0) return null;
  if (targetMs < snapshots[0].timestamp_ms) return null;
  let lo = 0, hi = snapshots.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (snapshots[mid].timestamp_ms <= targetMs) lo = mid;
    else hi = mid - 1;
  }
  const snap = snapshots[lo];
  if (targetMs - snap.timestamp_ms > 20 * 60 * 1000) return null;
  return snap;
}

async function loadAllData() {
  console.log('Loading price data...\n');
  const [nqCandles, esCandles] = await Promise.all([
    loadContinuousOHLCV('NQ', '1m', START_DATE, END_DATE),
    loadContinuousOHLCV('ES', '1m', START_DATE, END_DATE)
  ]);

  const nqMap = new Map();
  for (const c of nqCandles) nqMap.set(c.timestamp, c);
  const esMap = new Map();
  for (const c of esCandles) esMap.set(c.timestamp, c);

  const commonTimestamps = [];
  for (const ts of nqMap.keys()) {
    if (esMap.has(ts)) commonTimestamps.push(ts);
  }
  commonTimestamps.sort((a, b) => a - b);
  console.log(`Overlapping bars: ${commonTimestamps.length.toLocaleString()}\n`);

  console.log('Loading GEX data...');
  const nqGEX = loadAllGEXData('NQ');
  const esGEX = loadAllGEXData('ES');

  return { nqMap, esMap, commonTimestamps, nqGEX, esGEX };
}

// ═════════════════════════════════════════════════════════════════════════════
// ANALYSIS 3 DEEP DIVE: GEX Level Proximity
// ═════════════════════════════════════════════════════════════════════════════

function classifyNearestLevel(snap, price) {
  // Return { dist, level, type, side }
  // type: 'gamma_flip', 'call_wall', 'put_wall', 'resistance', 'support'
  // side: 'above' (level above price) or 'below' (level below price)
  const candidates = [];

  if (snap.gamma_flip) candidates.push({ level: snap.gamma_flip, type: 'gamma_flip' });
  if (snap.call_wall) candidates.push({ level: snap.call_wall, type: 'call_wall' });
  if (snap.put_wall) candidates.push({ level: snap.put_wall, type: 'put_wall' });
  if (snap.resistance) {
    snap.resistance.filter(l => l > 0).forEach((l, i) => candidates.push({ level: l, type: `resistance_${i}` }));
  }
  if (snap.support) {
    snap.support.filter(l => l > 0).forEach((l, i) => candidates.push({ level: l, type: `support_${i}` }));
  }

  let best = null;
  let minDist = Infinity;
  for (const c of candidates) {
    const dist = Math.abs(price - c.level);
    if (dist < minDist) {
      minDist = dist;
      best = c;
    }
  }

  if (!best) return null;

  // Simplified type classification
  let levelCategory;
  if (best.type === 'gamma_flip') levelCategory = 'gamma_flip';
  else if (best.type === 'call_wall') levelCategory = 'call_wall';
  else if (best.type === 'put_wall') levelCategory = 'put_wall';
  else if (best.type.startsWith('resistance')) levelCategory = 'resistance';
  else levelCategory = 'support';

  return {
    dist: minDist,
    level: best.level,
    type: levelCategory,
    side: price >= best.level ? 'above' : 'below'
  };
}

function analysis3_deepDive(commonTimestamps, nqMap, esMap, nqGEX, esGEX) {
  console.log('\n' + '═'.repeat(80));
  console.log('ANALYSIS 3 DEEP DIVE: GEX Level Proximity');
  console.log('═'.repeat(80));

  const FORWARD_MINUTES = [5, 15, 30, 60];

  // Collect all proximity events with rich metadata
  const allEvents = [];

  for (let i = 0; i < commonTimestamps.length; i++) {
    const ts = commonTimestamps[i];
    const et = toET(ts);
    // Sample every 5 min for finer granularity than the 15m in v1
    if (et.minute % 5 !== 0) continue;
    if (et.timeInMinutes < 570 || et.timeInMinutes >= 960) continue;

    const nqSnap = getGEXAt(nqGEX, ts);
    const esSnap = getGEXAt(esGEX, ts);
    if (!nqSnap || !esSnap) continue;

    const nq = nqMap.get(ts);
    const es = esMap.get(ts);
    if (!nq || !es) continue;

    const nqNearest = classifyNearestLevel(nqSnap, nq.close);
    const esNearest = classifyNearestLevel(esSnap, es.close);
    if (!nqNearest || !esNearest) continue;

    // Forward returns as %
    const forwards = {};
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
      forwards[mins] = {
        nqPct: (nqFwd.close - nq.close) / nq.close * 100,
        esPct: (esFwd.close - es.close) / es.close * 100,
        nqPts: nqFwd.close - nq.close,
        esPts: esFwd.close - es.close,
      };
    }
    if (!valid) continue;

    // Compute NQ proximity as % of price (so we can compare NQ vs ES on equal footing)
    const nqDistPct = nqNearest.dist / nq.close * 100;
    const esDistPct = esNearest.dist / es.close * 100;

    allEvents.push({
      ts, et,
      nqPrice: nq.close, esPrice: es.close,
      nqNearest, esNearest,
      nqDistPct, esDistPct,
      nqRegime: nqSnap.regime,
      esRegime: esSnap.regime,
      forwards
    });
  }

  console.log(`Total proximity events sampled: ${allEvents.length.toLocaleString()}`);

  // ── 3a: Normalized % return comparison ─────────────────────────────────────

  console.log('\n── 3a: Pinned vs Free (% Returns, Threshold Sweep) ──');
  console.log('Proximity threshold = max % distance from nearest GEX level to count as "near"');
  console.log('"Free" = other instrument > 2x the threshold from its nearest level\n');

  const thresholds = [0.05, 0.10, 0.15, 0.20, 0.30]; // % of price

  for (const thresh of thresholds) {
    const nqPinned = allEvents.filter(e => e.nqDistPct <= thresh && e.esDistPct > thresh * 2);
    const esPinned = allEvents.filter(e => e.esDistPct <= thresh && e.nqDistPct > thresh * 2);

    if (nqPinned.length < 30 && esPinned.length < 30) continue;

    console.log(`Threshold: ${thresh}% of price (NQ≈${Math.round(thresh/100*21000)}pts, ES≈${Math.round(thresh/100*5500)}pts)`);

    for (const [label, evts] of [['NQ pinned', nqPinned], ['ES pinned', esPinned]]) {
      if (evts.length < 20) { console.log(`  ${label}: n=${evts.length} (too few)`); continue; }

      const pinnedProd = label.startsWith('NQ') ? 'nq' : 'es';
      const freeProd = pinnedProd === 'nq' ? 'es' : 'nq';

      const row = [`  ${label} (n=${evts.length})`];
      for (const mins of [15, 30, 60]) {
        const pinnedAbsRet = mean(evts.map(e => Math.abs(e.forwards[mins][`${pinnedProd}Pct`])));
        const freeAbsRet = mean(evts.map(e => Math.abs(e.forwards[mins][`${freeProd}Pct`])));
        const ratio = pinnedAbsRet / freeAbsRet;
        row.push(`${mins}m: pinned ${R(pinnedAbsRet,3).toFixed(3)}% vs free ${R(freeAbsRet,3).toFixed(3)}% (ratio ${R(ratio,2).toFixed(2)})`);
      }
      console.log(row.join('  |  '));
    }
    console.log();
  }

  // ── 3b: Breakdown by level type ────────────────────────────────────────────

  console.log('── 3b: Proximity by Level Type ──');
  console.log('Which GEX level types actually pin price?\n');

  const NEAR_THRESH = 0.10; // 0.1% of price
  const nearEvents = allEvents.filter(e => e.nqDistPct <= NEAR_THRESH || e.esDistPct <= NEAR_THRESH);

  // Group by level type for each product
  for (const product of ['nq', 'es']) {
    const prodEvents = nearEvents.filter(e => e[`${product}DistPct`] <= NEAR_THRESH);
    const byType = {};
    for (const e of prodEvents) {
      const type = e[`${product}Nearest`].type;
      if (!byType[type]) byType[type] = [];
      byType[type].push(e);
    }

    console.log(`${product.toUpperCase()} near GEX level (${NEAR_THRESH}% threshold):`);
    console.log(`${'Level Type'.padEnd(16)} ${'N'.padEnd(8)} ${'15m |Move|%'.padEnd(14)} ${'30m |Move|%'.padEnd(14)} ${'Bounce Rate 15m'.padEnd(16)}`);
    console.log('-'.repeat(68));

    for (const [type, evts] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
      if (evts.length < 15) continue;

      const absMoves15 = evts.map(e => Math.abs(e.forwards[15][`${product}Pct`]));
      const absMoves30 = evts.map(e => Math.abs(e.forwards[30][`${product}Pct`]));

      // Bounce rate: price was near a level — did it move AWAY from the level (bounce)?
      // If price is above level (side='above') and goes up → bounce. Below and goes down → bounce.
      let bounces = 0;
      for (const e of evts) {
        const side = e[`${product}Nearest`].side;
        const move = e.forwards[15][`${product}Pts`];
        if ((side === 'above' && move > 0) || (side === 'below' && move < 0)) bounces++;
      }

      console.log(`${type.padEnd(16)} ${evts.length.toString().padEnd(8)} ${R(mean(absMoves15), 3).toFixed(3).padEnd(14)} ${R(mean(absMoves30), 3).toFixed(3).padEnd(14)} ${R(bounces/evts.length*100, 1).toFixed(1)}%`);
    }
    console.log();
  }

  // ── 3c: Bounce/Rejection directional signal ────────────────────────────────

  console.log('── 3c: Bounce/Rejection Signal — Is Direction Predictable? ──');
  console.log('When price is near a support level, does it bounce up? Near resistance, reject down?\n');

  for (const product of ['nq', 'es']) {
    const prodNear = allEvents.filter(e => e[`${product}DistPct`] <= NEAR_THRESH);

    // Split into "near support" vs "near resistance"
    const nearSupport = prodNear.filter(e => {
      const type = e[`${product}Nearest`].type;
      return type === 'support' || type === 'put_wall';
    });
    const nearResistance = prodNear.filter(e => {
      const type = e[`${product}Nearest`].type;
      return type === 'resistance' || type === 'call_wall';
    });
    const nearGammaFlip = prodNear.filter(e => e[`${product}Nearest`].type === 'gamma_flip');

    console.log(`${product.toUpperCase()} Level Proximity Directional Test:`);
    console.log(`${'Condition'.padEnd(22)} ${'N'.padEnd(8)} ${'5m Avg%'.padEnd(12)} ${'15m Avg%'.padEnd(12)} ${'30m Avg%'.padEnd(12)} ${'60m Avg%'.padEnd(12)} ${'15m Win%'.padEnd(10)}`);
    console.log('-'.repeat(86));

    for (const [label, evts, expectedDir] of [
      ['Near support (long)', nearSupport, 1],
      ['Near resistance (short)', nearResistance, -1],
      ['Near gamma flip', nearGammaFlip, 0]
    ]) {
      if (evts.length < 15) continue;

      const results = {};
      for (const mins of FORWARD_MINUTES) {
        const returns = evts.map(e => e.forwards[mins][`${product}Pct`]);
        // For support: expect positive return (bounce up)
        // For resistance: expect negative return (reject down)
        const directedReturns = expectedDir !== 0 ? returns.map(r => r * expectedDir) : returns;
        results[mins] = { avg: mean(returns), dirWinRate: expectedDir !== 0 ? directedReturns.filter(r => r > 0).length / directedReturns.length * 100 : null };
      }

      const winPct = results[15].dirWinRate !== null ? R(results[15].dirWinRate, 1).toFixed(1) + '%' : 'N/A';
      console.log(`${label.padEnd(22)} ${evts.length.toString().padEnd(8)} ${R(results[5].avg, 4).toFixed(4).padEnd(12)} ${R(results[15].avg, 4).toFixed(4).padEnd(12)} ${R(results[30].avg, 4).toFixed(4).padEnd(12)} ${R(results[60].avg, 4).toFixed(4).padEnd(12)} ${winPct.padEnd(10)}`);
    }
    console.log();
  }

  // ── 3d: Spread trade — long pinned-at-support, short free ──────────────────

  console.log('── 3d: Spread Trade Test — Long Instrument Pinned at Support ──');
  console.log('When one instrument is near GEX support and the other is free,');
  console.log('go long the pinned instrument (expect bounce) vs short the free one.\n');

  for (const [pinnedProd, freeProd] of [['nq', 'es'], ['es', 'nq']]) {
    const trades = [];

    for (const e of allEvents) {
      if (e[`${pinnedProd}DistPct`] > NEAR_THRESH) continue;
      if (e[`${freeProd}DistPct`] <= NEAR_THRESH * 2) continue; // free must be actually free

      const nearType = e[`${pinnedProd}Nearest`].type;
      if (nearType !== 'support' && nearType !== 'put_wall') continue;

      // Long pinned, short free → net return = pinned_return - free_return
      for (const mins of [15, 30]) {
        trades.push({
          mins,
          ret: e.forwards[mins][`${pinnedProd}Pct`] - e.forwards[mins][`${freeProd}Pct`],
          pinnedRet: e.forwards[mins][`${pinnedProd}Pct`],
          freeRet: e.forwards[mins][`${freeProd}Pct`],
          year: e.et.year,
        });
      }
    }

    if (trades.length < 20) {
      console.log(`${pinnedProd.toUpperCase()} at support, ${freeProd.toUpperCase()} free: ${trades.length / 2} events (too few)\n`);
      continue;
    }

    console.log(`${pinnedProd.toUpperCase()} at support, ${freeProd.toUpperCase()} free:`);
    for (const mins of [15, 30]) {
      const t = trades.filter(x => x.mins === mins);
      console.log(`  ${mins}m hold: n=${t.length}, win rate ${R(winRate(t.map(x=>x.ret)), 1).toFixed(1)}%, avg spread ret ${R(mean(t.map(x=>x.ret)), 4).toFixed(4)}%, PF ${R(pf(t.map(x=>x.ret)), 2).toFixed(2)}`);
    }
    console.log();
  }

  return allEvents;
}

// ═════════════════════════════════════════════════════════════════════════════
// ANALYSIS 4 DEEP DIVE: NQ-Leads-ES + GEX Regime
// ═════════════════════════════════════════════════════════════════════════════

function analysis4_deepDive(commonTimestamps, nqMap, esMap, nqGEX, esGEX) {
  console.log('\n' + '═'.repeat(80));
  console.log('ANALYSIS 4 DEEP DIVE: NQ-Leads-ES Filtered by GEX Regime');
  console.log('═'.repeat(80));

  // Pre-compute all NQ 1m returns for fast lookup
  const nqReturns = new Map();
  for (let i = 1; i < commonTimestamps.length; i++) {
    const ts = commonTimestamps[i];
    const prevTs = commonTimestamps[i - 1];
    if (ts - prevTs > 120000) continue;
    const nqCurr = nqMap.get(ts);
    const nqPrev = nqMap.get(prevTs);
    nqReturns.set(ts, (nqCurr.close - nqPrev.close) / nqPrev.close);
  }

  // Build a timestamp→index map
  const tsIndex = new Map();
  commonTimestamps.forEach((ts, i) => tsIndex.set(ts, i));

  // Core trade generator: returns array of trades with metadata
  function generateTrades(threshold, holdBars) {
    const trades = [];

    for (let i = 1; i < commonTimestamps.length - holdBars; i++) {
      const ts = commonTimestamps[i];
      const nqRet = nqReturns.get(ts);
      if (nqRet === undefined || Math.abs(nqRet) < threshold) continue;

      const exitTs = commonTimestamps[i + holdBars];
      if (!exitTs || exitTs - ts > (holdBars + 2) * 60000) continue;

      const esEntry = esMap.get(ts);
      const esExit = esMap.get(exitTs);
      if (!esEntry || !esExit) continue;

      const direction = nqRet > 0 ? 1 : -1;
      const esPnL = (esExit.close - esEntry.close) * direction;

      const nqSnap = getGEXAt(nqGEX, ts);
      const esSnap = getGEXAt(esGEX, ts);

      let regime = 'no_gex';
      let nqRegimeRaw = null, esRegimeRaw = null;
      if (nqSnap && esSnap) {
        nqRegimeRaw = nqSnap.regime;
        esRegimeRaw = esSnap.regime;
        const nqS = nqSnap.regime.includes('positive') ? 'pos' : nqSnap.regime.includes('negative') ? 'neg' : 'neut';
        const esS = esSnap.regime.includes('positive') ? 'pos' : esSnap.regime.includes('negative') ? 'neg' : 'neut';
        if (nqS === 'pos' && esS === 'pos') regime = 'positive';
        else if (nqS === 'neg' && esS === 'neg') regime = 'negative';
        else if (nqS === 'neut' && esS === 'neut') regime = 'neutral';
        else regime = 'mixed';
      }

      const et = toET(ts);
      let session;
      if (et.timeInMinutes >= 570 && et.timeInMinutes < 630) session = 'rth_open';
      else if (et.timeInMinutes >= 630 && et.timeInMinutes < 900) session = 'rth_mid';
      else if (et.timeInMinutes >= 900 && et.timeInMinutes < 960) session = 'rth_close';
      else session = 'overnight';

      trades.push({
        ts, esPnL, direction, regime, session,
        nqRegimeRaw, esRegimeRaw,
        year: et.year,
        esEntry: esEntry.close,
        nqReturn: nqRet
      });
    }
    return trades;
  }

  // ── 4a: Year-over-year stability ───────────────────────────────────────────

  console.log('\n── 4a: Year-over-Year Stability (0.15% thresh, 5-bar hold) ──\n');

  const baseTrades = generateTrades(0.0015, 5);
  console.log(`Total trades: ${baseTrades.length}`);

  console.log(`\n${'Year'.padEnd(8)} ${'Regime'.padEnd(12)} ${'Trades'.padEnd(10)} ${'Win Rate'.padEnd(12)} ${'Avg Pts'.padEnd(12)} ${'PF'.padEnd(10)} ${'Cum Pts'}`);
  console.log('-'.repeat(74));

  const years = [...new Set(baseTrades.map(t => t.year))].sort();
  const regimes = ['positive', 'negative', 'neutral', 'mixed', 'no_gex'];

  const yearRegimeData = {};

  for (const year of years) {
    for (const regime of regimes) {
      const t = baseTrades.filter(x => x.year === year && x.regime === regime);
      if (t.length < 10) continue;

      const pts = t.map(x => x.esPnL);
      const wr = winRate(pts);
      const avgPts = mean(pts);
      const profitFactor = pf(pts);
      const cumPts = pts.reduce((s, x) => s + x, 0);

      console.log(`${year.toString().padEnd(8)} ${regime.padEnd(12)} ${t.length.toString().padEnd(10)} ${R(wr, 1).toFixed(1).padEnd(12)} ${R(avgPts, 2).toFixed(2).padEnd(12)} ${R(profitFactor, 2).toFixed(2).padEnd(10)} ${R(cumPts, 0).toFixed(0)}`);

      if (!yearRegimeData[regime]) yearRegimeData[regime] = {};
      yearRegimeData[regime][year] = { n: t.length, winRate: R(wr, 1), pf: R(profitFactor, 2), cumPts: R(cumPts, 0) };
    }
  }

  // Consistency check: how many years is each regime profitable?
  console.log('\nConsistency (profitable years / total years):');
  for (const regime of regimes) {
    const data = yearRegimeData[regime];
    if (!data) continue;
    const yrs = Object.keys(data);
    const profitableYears = yrs.filter(y => data[y].cumPts > 0).length;
    console.log(`  ${regime}: ${profitableYears}/${yrs.length} years profitable`);
  }

  // ── 4b: Parameter sweep ────────────────────────────────────────────────────

  console.log('\n── 4b: Parameter Sweep (Threshold × Hold × Regime) ──\n');

  const thresholds = [0.0010, 0.0015, 0.0020, 0.0025, 0.0030];
  const holdPeriods = [3, 5, 8, 10, 15];

  // Focus on positive (best regime) and negative (most trades)
  const focusRegimes = ['positive', 'negative'];

  for (const focusRegime of focusRegimes) {
    console.log(`Regime: ${focusRegime}`);
    // Header
    let header = 'Thresh\\Hold';
    for (const hold of holdPeriods) header += `  | ${hold}m`.padEnd(28);
    console.log(header);
    console.log('-'.repeat(28 * holdPeriods.length + 12));

    for (const thresh of thresholds) {
      let row = `${(thresh * 100).toFixed(2)}%`.padEnd(11);
      for (const hold of holdPeriods) {
        const trades = generateTrades(thresh, hold);
        const t = trades.filter(x => x.regime === focusRegime);
        if (t.length < 20) {
          row += `  | n=${t.length}`.padEnd(28);
          continue;
        }
        const pts = t.map(x => x.esPnL);
        const wr = R(winRate(pts), 1);
        const profitFactor = R(pf(pts), 2);
        const cum = R(pts.reduce((s, x) => s + x, 0), 0);
        row += `  | ${wr}% PF${profitFactor} n=${t.length}`.padEnd(28);
      }
      console.log(row);
    }
    console.log();
  }

  // ── 4c: Session filter overlay ─────────────────────────────────────────────

  console.log('── 4c: Session Filter × GEX Regime ──\n');

  const sessions = ['rth_open', 'rth_mid', 'rth_close', 'overnight'];

  console.log(`${'Session'.padEnd(14)} ${'Regime'.padEnd(12)} ${'Trades'.padEnd(10)} ${'Win Rate'.padEnd(12)} ${'Avg Pts'.padEnd(12)} ${'PF'.padEnd(10)} ${'Cum Pts'}`);
  console.log('-'.repeat(80));

  for (const session of sessions) {
    for (const regime of ['positive', 'negative', 'mixed']) {
      const t = baseTrades.filter(x => x.session === session && x.regime === regime);
      if (t.length < 20) continue;

      const pts = t.map(x => x.esPnL);
      const wr = winRate(pts);
      const profitFactor = pf(pts);
      const cumPts = pts.reduce((s, x) => s + x, 0);

      console.log(`${session.padEnd(14)} ${regime.padEnd(12)} ${t.length.toString().padEnd(10)} ${R(wr, 1).toFixed(1).padEnd(12)} ${R(mean(pts), 2).toFixed(2).padEnd(12)} ${R(profitFactor, 2).toFixed(2).padEnd(10)} ${R(cumPts, 0).toFixed(0)}`);
    }
  }

  // ── 4d: Equity curves with slippage scenarios ──────────────────────────────

  console.log('\n── 4d: Equity Curves — Best Configurations with Slippage ──\n');

  // Test the best config from initial results: positive regime, 0.15% thresh, 5-bar hold
  // With slippage: 0 (ideal), 0.25 pts (1 tick), 0.50 pts (2 ticks), 1.0 pts (4 ticks)
  const slippages = [0, 0.25, 0.50, 1.0];

  // Also test best combo from parameter sweep
  const configs = [
    { label: 'positive, 0.15%, 5m', regime: 'positive', thresh: 0.0015, hold: 5 },
    { label: 'negative, 0.15%, 5m', regime: 'negative', thresh: 0.0015, hold: 5 },
    { label: 'positive, 0.20%, 5m', regime: 'positive', thresh: 0.0020, hold: 5 },
    { label: 'positive, 0.15%, 3m', regime: 'positive', thresh: 0.0015, hold: 3 },
    { label: 'positive, 0.10%, 8m', regime: 'positive', thresh: 0.0010, hold: 8 },
  ];

  for (const config of configs) {
    const trades = generateTrades(config.thresh, config.hold).filter(x => x.regime === config.regime);
    if (trades.length < 20) continue;

    console.log(`Config: ${config.label} (${trades.length} trades)`);
    console.log(`${'Slippage'.padEnd(12)} ${'Win Rate'.padEnd(12)} ${'Avg Pts'.padEnd(12)} ${'PF'.padEnd(10)} ${'Cum Pts'.padEnd(12)} ${'Max DD Pts'.padEnd(14)} ${'Sharpe'}`);
    console.log('-'.repeat(82));

    for (const slip of slippages) {
      const pts = trades.map(t => t.esPnL - slip * 2); // slippage on entry + exit

      const wr = winRate(pts);
      const profitFactor = pf(pts);
      const cumPts = pts.reduce((s, x) => s + x, 0);
      const avgPts = mean(pts);

      // Max drawdown
      let peak = 0, equity = 0, maxDD = 0;
      for (const p of pts) {
        equity += p;
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDD) maxDD = dd;
      }

      // Annualized Sharpe (assume ~250 trading days, ~X trades per day)
      const tradingDays = trades.length > 0 ? (trades[trades.length - 1].ts - trades[0].ts) / 86400000 : 1;
      const tradesPerDay = trades.length / tradingDays;
      const dailyReturn = avgPts * tradesPerDay;
      const dailyStd = stddev(pts) * Math.sqrt(tradesPerDay);
      const sharpe = dailyStd > 0 ? (dailyReturn / dailyStd) * Math.sqrt(252) : 0;

      console.log(`${(slip.toFixed(2) + ' pts').padEnd(12)} ${R(wr, 1).toFixed(1).padEnd(12)} ${R(avgPts, 2).toFixed(2).padEnd(12)} ${R(profitFactor, 2).toFixed(2).padEnd(10)} ${R(cumPts, 0).toFixed(0).padEnd(12)} ${R(maxDD, 0).toFixed(0).padEnd(14)} ${R(sharpe, 2).toFixed(2)}`);
    }

    // Monthly equity curve (no slippage)
    const monthlyEquity = {};
    let equity = 0;
    for (const t of trades) {
      equity += t.esPnL;
      const monthKey = `${t.year}-${String(toET(t.ts).month + 1).padStart(2, '0')}`;
      monthlyEquity[monthKey] = equity;
    }

    const months = Object.keys(monthlyEquity).sort();
    let prevEq = 0;
    const monthlyPnL = [];
    for (const m of months) {
      monthlyPnL.push({ month: m, pnl: monthlyEquity[m] - prevEq });
      prevEq = monthlyEquity[m];
    }

    const profitMonths = monthlyPnL.filter(m => m.pnl > 0).length;
    console.log(`  Monthly P&L: ${profitMonths}/${monthlyPnL.length} months profitable (${R(profitMonths/monthlyPnL.length*100, 1).toFixed(1)}%)`);

    // Show worst 5 and best 5 months
    const sorted = [...monthlyPnL].sort((a, b) => a.pnl - b.pnl);
    console.log(`  Worst months: ${sorted.slice(0, 3).map(m => `${m.month}: ${R(m.pnl, 0).toFixed(0)}pts`).join(', ')}`);
    console.log(`  Best months:  ${sorted.slice(-3).reverse().map(m => `${m.month}: ${R(m.pnl, 0).toFixed(0)}pts`).join(', ')}`);
    console.log();
  }

  // ── 4e: Granular regime breakdown (strong_ variants) ───────────────────────

  console.log('── 4e: Granular Regime Breakdown (strong_positive vs positive vs neutral etc.) ──\n');

  // Use raw regime strings
  const rawRegimeTrades = {};
  for (const t of baseTrades) {
    if (!t.nqRegimeRaw || !t.esRegimeRaw) continue;
    const key = `${t.nqRegimeRaw} | ${t.esRegimeRaw}`;
    if (!rawRegimeTrades[key]) rawRegimeTrades[key] = [];
    rawRegimeTrades[key].push(t);
  }

  console.log(`${'NQ Regime'.padEnd(20)} ${'ES Regime'.padEnd(20)} ${'N'.padEnd(8)} ${'Win%'.padEnd(10)} ${'Avg Pts'.padEnd(12)} ${'PF'.padEnd(10)} ${'Cum'}`);
  console.log('-'.repeat(80));

  for (const [key, trades] of Object.entries(rawRegimeTrades).sort((a, b) => b[1].length - a[1].length)) {
    if (trades.length < 30) continue;
    const [nqR, esR] = key.split(' | ');
    const pts = trades.map(t => t.esPnL);
    console.log(`${nqR.padEnd(20)} ${esR.padEnd(20)} ${trades.length.toString().padEnd(8)} ${R(winRate(pts), 1).toFixed(1).padEnd(10)} ${R(mean(pts), 2).toFixed(2).padEnd(12)} ${R(pf(pts), 2).toFixed(2).padEnd(10)} ${R(pts.reduce((s,x)=>s+x,0), 0).toFixed(0)}`);
  }

  return baseTrades;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  const { nqMap, esMap, commonTimestamps, nqGEX, esGEX } = await loadAllData();

  analysis3_deepDive(commonTimestamps, nqMap, esMap, nqGEX, esGEX);
  analysis4_deepDive(commonTimestamps, nqMap, esMap, nqGEX, esGEX);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nTotal runtime: ${elapsed}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
