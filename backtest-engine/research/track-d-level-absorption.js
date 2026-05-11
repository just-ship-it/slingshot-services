/**
 * Track D — GEX Level Absorption Analysis
 *
 * For each consecutive snapshot pair (T, T+1), find levels present in T whose
 * strike has no nearby level in T+1 ("absorbed"). Measure forward price action
 * — does price drift through the absorbed level toward the next same-side
 * level? Compare to baseline (levels that persisted).
 *
 * Hypothesis: when a level is "absorbed" between snapshots (gamma exposure
 * removed via expiry, OI change, or strike-roll), the structural support /
 * resistance at that price is gone, so price can drift past it more easily
 * toward the next level.
 *
 * Definitions:
 *   - "level" at T = unique price (within 5pt) appearing in any of: call_wall,
 *     put_wall, gamma_flip, support[1..5], resistance[1..5]
 *   - "absorbed" = level in T has no match in T+1 within tolerance pts
 *   - "next same-side level in T+1" = closest level in T+1 that's on the same
 *     side of current spot as the absorbed level (excluding the absorbed level
 *     itself, which by definition isn't in T+1)
 *
 * For each absorbed level, record:
 *   - level_type at T (was-resistance, was-support, was-wall, was-flip)
 *   - distance from spot at T+1
 *   - the next same-side level price ("drift target")
 *   - forward windows: did price cross the absorbed level? did it reach
 *     the next-level "drift target"?
 *
 * Same metrics for persisted-level baseline → directional drift difference
 * is the signal.
 *
 * Run:
 *   node research/track-d-level-absorption.js \
 *     --start 2025-01-13 --end 2026-04-23 \
 *     --gex-dir nq-cbbo
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { toET } from './utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'research', 'output');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}
const START = arg('start', '2025-01-13');
const END = arg('end', '2026-01-23');
const PRODUCT = arg('product', 'NQ').toUpperCase();
const GEX_DIR = arg('gex-dir', 'nq-cbbo');
const TOL_PT = Number(arg('tolerance-pt', 5));   // points within which two levels are "same"
const MAX_DIST_PT = Number(arg('max-dist-pt', 250));  // ignore levels further than this from spot
const FORWARD_HORIZONS = [15, 45, 90];           // forward windows in minutes

console.log(`\n=== GEX Level Absorption Study: ${PRODUCT} ===`);
console.log(`Date range: ${START} -> ${END}`);
console.log(`GEX dir: data/gex/${GEX_DIR}`);
console.log(`Tolerance: ${TOL_PT}pt | Max dist from spot: ${MAX_DIST_PT}pt`);
console.log(`Forward horizons: ${FORWARD_HORIZONS.join(', ')} min\n`);

function loadIntradayGEX(dateStr) {
  const filename = `${PRODUCT.toLowerCase()}_gex_${dateStr}.json`;
  const filePath = path.join(DATA_DIR, 'gex', GEX_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return content.data || [];
}

async function loadRawNQ(startStr, endStr) {
  const filePath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1m.csv`);
  const start = new Date(startStr).getTime();
  const end = new Date(endStr).getTime() + 24 * 3600000;
  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return;
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < start || ts > end) return;
        const c = {
          timestamp: ts,
          open: +row.open, high: +row.high, low: +row.low, close: +row.close,
          volume: +row.volume || 0, symbol: row.symbol,
        };
        if (isNaN(c.open) || isNaN(c.close)) return;
        candles.push(c);
      })
      .on('end', resolve).on('error', reject);
  });
  candles.sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}

function filterPrimaryContract(candles) {
  if (!candles.length) return candles;
  const hourVol = new Map();
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    if (!hourVol.has(h)) hourVol.set(h, new Map());
    const m = hourVol.get(h);
    m.set(c.symbol, (m.get(c.symbol) || 0) + (c.volume || 0));
  }
  const out = [];
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    const m = hourVol.get(h);
    if (!m) { out.push(c); continue; }
    let bestSym = '', bestVol = 0;
    for (const [s, v] of m.entries()) if (v > bestVol) { bestVol = v; bestSym = s; }
    if (c.symbol === bestSym) out.push(c);
  }
  return out;
}

// Extract a flat list of {price, type, gex} from a snapshot.
// gex is signed (positive for resistance/call_wall, negative for support/put_wall).
function extractLevels(snap) {
  const levels = [];
  if (!snap) return levels;
  if (snap.call_wall != null) levels.push({ price: snap.call_wall, type: 'call_wall', gex: snap.call_wall_gex || 0, isWall: true });
  if (snap.put_wall != null) levels.push({ price: snap.put_wall, type: 'put_wall', gex: snap.put_wall_gex || 0, isWall: true });
  if (snap.gamma_flip != null) levels.push({ price: snap.gamma_flip, type: 'gamma_flip', gex: 0, isFlip: true });
  if (Array.isArray(snap.resistance)) {
    for (let i = 0; i < snap.resistance.length; i++) {
      levels.push({ price: snap.resistance[i], type: `R${i + 1}`, gex: snap.resistance_gex?.[i] || 0, isResistance: true });
    }
  }
  if (Array.isArray(snap.support)) {
    for (let i = 0; i < snap.support.length; i++) {
      levels.push({ price: snap.support[i], type: `S${i + 1}`, gex: snap.support_gex?.[i] || 0, isSupport: true });
    }
  }
  return levels.filter(l => l.price != null && !isNaN(l.price));
}

// Deduplicate levels within tolerance — keep the one with highest |gex|, but
// also retain the type taxonomy (e.g., 'put_wall+S1') for richer aggregation.
function dedupLevels(levels, tol) {
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const result = [];
  for (const lvl of sorted) {
    const last = result[result.length - 1];
    if (last && Math.abs(lvl.price - last.price) <= tol) {
      last.types = (last.types || [last.type]).concat(lvl.type);
      if (Math.abs(lvl.gex) > Math.abs(last.gex)) {
        last.gex = lvl.gex;
        last.type = lvl.type; // promote to the largest-gex type
      }
      last.isWall = last.isWall || lvl.isWall;
      last.isFlip = last.isFlip || lvl.isFlip;
      last.isResistance = last.isResistance || lvl.isResistance;
      last.isSupport = last.isSupport || lvl.isSupport;
    } else {
      result.push({ ...lvl, types: [lvl.type] });
    }
  }
  return result;
}

// For each level in T, find best match in T+1 within tolerance.
function classifyTransitions(levelsT, levelsT1, tol) {
  const out = [];
  for (const lvlT of levelsT) {
    let match = null;
    let minDist = Infinity;
    for (const lvlT1 of levelsT1) {
      const d = Math.abs(lvlT.price - lvlT1.price);
      if (d <= tol && d < minDist) {
        minDist = d;
        match = lvlT1;
      }
    }
    out.push({ levelT: lvlT, matchT1: match, persisted: !!match });
  }
  return out;
}

// Closest forward candle at-or-after a target ts (binary search)
function findCandleAtOrAfter(byTs, sortedTs, target) {
  let lo = 0, hi = sortedTs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedTs[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo < sortedTs.length ? byTs.get(sortedTs[lo]) : null;
}

async function run() {
  console.log('Loading raw NQ candles…');
  const all = await loadRawNQ(START, END);
  const candles = filterPrimaryContract(all);
  console.log(`After primary-contract filter: ${candles.length.toLocaleString()} candles`);

  const byTs = new Map();
  for (const c of candles) byTs.set(c.timestamp, c);
  const sortedTs = candles.map(c => c.timestamp);

  // Trading dates (RTH presence)
  const dates = new Set();
  for (const c of candles) {
    const et = toET(c.timestamp);
    if (et.dayOfWeek >= 1 && et.dayOfWeek <= 5 &&
        et.timeInMinutes >= 570 && et.timeInMinutes < 960) {
      dates.add(et.date);
    }
  }
  const tradingDates = Array.from(dates).sort();
  console.log(`Trading dates: ${tradingDates.length}\n`);

  const events = [];   // every level transition
  let absorbedCount = 0, persistedCount = 0;
  let snapHits = 0, snapMisses = 0;

  for (const dateStr of tradingDates) {
    const snapshots = loadIntradayGEX(dateStr);
    if (!snapshots || snapshots.length < 2) { snapMisses++; continue; }
    snapHits++;

    // Sort snapshots by ts
    const enriched = snapshots
      .map(s => ({ ...s, _ts: new Date(s.timestamp).getTime() }))
      .sort((a, b) => a._ts - b._ts);

    // Restrict transitions to RTH (most strategies trade RTH)
    const RTH_START = 570, RTH_END = 960;

    for (let i = 1; i < enriched.length; i++) {
      const prev = enriched[i - 1];
      const curr = enriched[i];
      const currEt = toET(curr._ts);
      if (currEt.date !== dateStr) continue;
      if (currEt.timeInMinutes < RTH_START || currEt.timeInMinutes > RTH_END) continue;

      // Reference price = NQ candle at-or-after curr's timestamp (entry on next bar)
      const entry = findCandleAtOrAfter(byTs, sortedTs, curr._ts);
      if (!entry) continue;
      const entryEt = toET(entry.timestamp);
      if (entryEt.date !== dateStr) continue;
      const spot = entry.open;

      const levelsPrev = dedupLevels(extractLevels(prev), TOL_PT);
      const levelsCurr = dedupLevels(extractLevels(curr), TOL_PT);
      if (!levelsPrev.length || !levelsCurr.length) continue;

      const transitions = classifyTransitions(levelsPrev, levelsCurr, TOL_PT);

      for (const trans of transitions) {
        const lvl = trans.levelT;
        const distFromSpot = lvl.price - spot;  // signed: positive = above spot
        if (Math.abs(distFromSpot) > MAX_DIST_PT) continue;

        const sideOfSpot = distFromSpot > 0 ? 'above' : 'below';

        // Find next same-side level in T+1 (the "drift target") — closest level
        // in T+1 that's on the same side of spot, excluding any within tolerance
        // of the absorbed/persisted level itself.
        let nextSameSide = null;
        for (const cand of levelsCurr) {
          if (Math.abs(cand.price - lvl.price) <= TOL_PT) continue;
          const candDist = cand.price - spot;
          if ((sideOfSpot === 'above' && candDist <= 0) ||
              (sideOfSpot === 'below' && candDist >= 0)) continue;
          if (!nextSameSide || Math.abs(candDist) < Math.abs(nextSameSide.price - spot)) {
            nextSameSide = cand;
          }
        }

        // Forward analysis
        const forwards = {};
        for (const horizon of FORWARD_HORIZONS) {
          const targetTs = entry.timestamp + horizon * 60000;
          const fwd = findCandleAtOrAfter(byTs, sortedTs, targetTs);
          if (!fwd) { forwards[`fwd_${horizon}m`] = null; continue; }
          if (toET(fwd.timestamp).date !== dateStr) {
            forwards[`fwd_${horizon}m`] = null; continue;
          }

          // Walk all candles between entry and fwd to capture MFE/MAE/cross/reach
          let crossedAbsorbed = false, reachedNext = false;
          let mfe = 0, mae = 0;
          // Walk minute-by-minute
          for (let k = 1; k <= horizon; k++) {
            const c = byTs.get(entry.timestamp + k * 60000);
            if (!c) continue;
            const up = c.high - spot;
            const dn = spot - c.low;
            if (sideOfSpot === 'above') {
              // "Drift through" = price crosses up through the level
              if (c.high >= lvl.price) crossedAbsorbed = true;
              if (nextSameSide && c.high >= nextSameSide.price) reachedNext = true;
              if (up > mfe) mfe = up;
              if (dn > mae) mae = dn;
            } else {
              if (c.low <= lvl.price) crossedAbsorbed = true;
              if (nextSameSide && c.low <= nextSameSide.price) reachedNext = true;
              if (dn > mfe) mfe = dn;
              if (up > mae) mae = up;
            }
          }

          // Signed return in "drift" direction: positive = price moved toward
          // and past the absorbed level (i.e., the structural barrier failed).
          const close_t = fwd.close;
          const rawReturn = close_t - spot;
          const directionalReturn = sideOfSpot === 'above' ? rawReturn : -rawReturn;

          forwards[`fwd_${horizon}m`] = {
            mfe, mae,
            return: directionalReturn,
            crossed: crossedAbsorbed,
            reached_next: reachedNext,
          };
        }

        events.push({
          date: dateStr,
          curr_ts: curr.timestamp,
          time_et: `${String(Math.floor(currEt.timeInMinutes / 60)).padStart(2, '0')}:${String(currEt.timeInMinutes % 60).padStart(2, '0')}`,
          spot,
          level_price: lvl.price,
          level_type: lvl.type,
          level_types_all: lvl.types,
          level_gex: lvl.gex,
          is_wall: !!lvl.isWall,
          is_flip: !!lvl.isFlip,
          dist_from_spot: distFromSpot,
          side: sideOfSpot,
          persisted: trans.persisted,
          match_t1_price: trans.matchT1?.price ?? null,
          next_same_side_price: nextSameSide?.price ?? null,
          next_same_side_dist: nextSameSide ? nextSameSide.price - spot : null,
          regime: curr.regime,
          total_gex: curr.total_gex,
          forwards,
        });

        if (trans.persisted) persistedCount++;
        else absorbedCount++;
      }
    }
  }

  console.log(`Snapshot files: ${snapHits} loaded, ${snapMisses} missing`);
  console.log(`Total level events: ${events.length.toLocaleString()}`);
  console.log(`  Persisted: ${persistedCount.toLocaleString()} (${(100 * persistedCount / events.length).toFixed(1)}%)`);
  console.log(`  Absorbed:  ${absorbedCount.toLocaleString()} (${(100 * absorbedCount / events.length).toFixed(1)}%)\n`);

  // --- Aggregate ---
  const summary = aggregate(events);
  printSummary(summary);

  // --- Persist ---
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outBase = path.join(OUT_DIR, `track-d-level-absorption-${ts}`);
  fs.writeFileSync(`${outBase}.json`, JSON.stringify({
    config: { START, END, PRODUCT, GEX_DIR, TOL_PT, MAX_DIST_PT, FORWARD_HORIZONS },
    counts: { events: events.length, persisted: persistedCount, absorbed: absorbedCount },
    summary,
  }, null, 2));
  fs.writeFileSync(`${outBase}.events.json`, JSON.stringify(events));
  console.log(`\nWrote ${outBase}.json`);
  console.log(`Raw events: ${outBase}.events.json`);
}

function aggregate(events) {
  // For each (status, side, level_type-class) compute forward stats
  function classifyType(ev) {
    if (ev.is_flip) return 'flip';
    if (ev.is_wall) return ev.level_type === 'call_wall' ? 'call_wall' : 'put_wall';
    if (ev.level_type.startsWith('R')) return ev.level_type;
    if (ev.level_type.startsWith('S')) return ev.level_type;
    return 'other';
  }

  const groups = {};
  for (const ev of events) {
    const status = ev.persisted ? 'persisted' : 'absorbed';
    const tcls = classifyType(ev);
    const k = `${status} | ${ev.side} | ${tcls}`;
    if (!groups[k]) groups[k] = [];
    groups[k].push(ev);
  }

  const rows = [];
  for (const [key, arr] of Object.entries(groups)) {
    const fwd15 = arr.map(e => e.forwards.fwd_15m).filter(v => v != null);
    const fwd45 = arr.map(e => e.forwards.fwd_45m).filter(v => v != null);
    const fwd90 = arr.map(e => e.forwards.fwd_90m).filter(v => v != null);
    if (!fwd15.length) continue;

    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    const ret15 = fwd15.map(f => f.return);
    const ret45 = fwd45.map(f => f.return);
    const ret90 = fwd90.map(f => f.return);
    const cross15 = fwd15.filter(f => f.crossed).length / fwd15.length;
    const reach15 = fwd15.filter(f => f.reached_next).length / fwd15.length;
    const cross45 = fwd45.filter(f => f.crossed).length / fwd45.length;
    const reach45 = fwd45.filter(f => f.reached_next).length / fwd45.length;
    const cross90 = fwd90.filter(f => f.crossed).length / fwd90.length;
    const reach90 = fwd90.filter(f => f.reached_next).length / fwd90.length;

    rows.push({
      key, n: arr.length,
      ret15: mean(ret15), ret45: mean(ret45), ret90: mean(ret90),
      cross15, cross45, cross90,
      reach15, reach45, reach90,
    });
  }
  rows.sort((a, b) => a.key.localeCompare(b.key));

  // Pairwise compare absorbed vs persisted within (side | tcls)
  const compare = {};
  for (const r of rows) {
    const [status, side, tcls] = r.key.split(' | ');
    const k = `${side} | ${tcls}`;
    if (!compare[k]) compare[k] = {};
    compare[k][status] = r;
  }
  const compareRows = [];
  for (const [k, pair] of Object.entries(compare)) {
    if (!pair.absorbed || !pair.persisted) continue;
    compareRows.push({
      key: k,
      n_abs: pair.absorbed.n, n_pers: pair.persisted.n,
      ret15_abs: pair.absorbed.ret15, ret15_pers: pair.persisted.ret15,
      ret15_diff: pair.absorbed.ret15 - pair.persisted.ret15,
      cross15_abs: pair.absorbed.cross15, cross15_pers: pair.persisted.cross15,
      cross15_diff: pair.absorbed.cross15 - pair.persisted.cross15,
      reach15_abs: pair.absorbed.reach15, reach15_pers: pair.persisted.reach15,
      reach15_diff: pair.absorbed.reach15 - pair.persisted.reach15,
    });
  }
  compareRows.sort((a, b) => Math.abs(b.cross15_diff) - Math.abs(a.cross15_diff));

  return { rows, compareRows };
}

function printSummary(summary) {
  console.log('\n=== Forward stats per (status | side | level type) ===');
  console.log(['key'.padEnd(40), 'n'.padStart(7),
    'ret_15'.padStart(8), 'ret_45'.padStart(8), 'ret_90'.padStart(8),
    'cross15%'.padStart(9), 'reach15%'.padStart(9),
    'cross90%'.padStart(9), 'reach90%'.padStart(9)].join(' '));
  for (const r of summary.rows) {
    console.log([
      r.key.padEnd(40),
      String(r.n).padStart(7),
      r.ret15.toFixed(2).padStart(8),
      r.ret45.toFixed(2).padStart(8),
      r.ret90.toFixed(2).padStart(8),
      (100 * r.cross15).toFixed(1).padStart(9),
      (100 * r.reach15).toFixed(1).padStart(9),
      (100 * r.cross90).toFixed(1).padStart(9),
      (100 * r.reach90).toFixed(1).padStart(9),
    ].join(' '));
  }

  console.log('\n=== Absorbed vs Persisted (paired by side|type) — sorted by |Δcross15| ===');
  console.log(['key'.padEnd(28), 'n_abs'.padStart(7), 'n_pers'.padStart(7),
    'cross15_abs'.padStart(12), 'cross15_pers'.padStart(13), 'Δ%'.padStart(7),
    'ret15_abs'.padStart(10), 'ret15_pers'.padStart(11), 'Δret'.padStart(8)].join(' '));
  for (const r of summary.compareRows) {
    console.log([
      r.key.padEnd(28),
      String(r.n_abs).padStart(7),
      String(r.n_pers).padStart(7),
      (100 * r.cross15_abs).toFixed(1).padStart(12),
      (100 * r.cross15_pers).toFixed(1).padStart(13),
      (100 * r.cross15_diff).toFixed(1).padStart(7),
      r.ret15_abs.toFixed(2).padStart(10),
      r.ret15_pers.toFixed(2).padStart(11),
      r.ret15_diff.toFixed(2).padStart(8),
    ].join(' '));
  }
}

run().catch(e => { console.error(e); process.exit(1); });
