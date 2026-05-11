/**
 * Track E — GEX × LT Level Interactions
 *
 * Two related questions:
 *
 * 1) CONFLUENCE: when a GEX level and an LT level are co-located (within X pts),
 *    does price interact with that confluence zone differently than with a
 *    standalone GEX level? (i.e. is GEX+LT a stronger barrier?)
 *
 * 2) CROSSOVER: when one of the (GEX, LT) pairs flips sign between consecutive
 *    snapshots — i.e. one moves from above the other to below it — does that
 *    event predict forward NQ direction?
 *
 * Inputs: NQ raw 1m candles (primary contract), GEX cbbo snapshots, LT 15m records.
 *
 * For each RTH minute candle:
 *   - get the most recent GEX snapshot (≤ candle ts) and LT record (≤ candle ts)
 *   - build full level set: 13 GEX levels + 5 LT levels
 *   - for every GEX×LT pair, compute distance
 *   - identify confluence zones (|gex - lt| ≤ confluenceTol)
 *   - detect candle TOUCHES of:
 *       (a) confluence zones (price within touchDistance of confluence price)
 *       (b) plain GEX levels with NO LT confluence (the baseline)
 *   - record forward windows (5/15/30/60 min)
 *
 * For crossover analysis (separate, snapshot-cadence):
 *   - for each (gex_type, lt_idx) pair, track sign of (gex - lt) at each snapshot
 *   - on sign flip, record event and forward NQ return at next candle
 *
 * Run:
 *   node research/track-e-gex-lt-interactions.js \
 *     --start 2025-01-13 --end 2026-04-23 \
 *     --confluence-tol 15 --touch-distance 5
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { toET, loadLTLevels, getLTSnapshotAt } from './utils/data-loader.js';

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
const CONFLUENCE_TOL = Number(arg('confluence-tol', 15));   // pts: GEX-LT considered co-located
const TOUCH_DISTANCE = Number(arg('touch-distance', 5));    // pts: candle is "touching" a level
const COOLDOWN_MIN = Number(arg('cooldown-min', 30));
const FORWARD_HORIZONS = [5, 15, 30, 60];

console.log(`\n=== GEX × LT Interaction Study: ${PRODUCT} ===`);
console.log(`Date range: ${START} -> ${END}`);
console.log(`Confluence tolerance: ${CONFLUENCE_TOL}pt | Touch distance: ${TOUCH_DISTANCE}pt | Cooldown: ${COOLDOWN_MIN}min`);
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
    fs.createReadStream(filePath).pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return;
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < start || ts > end) return;
        const c = { timestamp: ts, open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume || 0, symbol: row.symbol };
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

function snapAtOrBefore(snapshots, target) {
  if (!snapshots || !snapshots.length) return null;
  let best = null;
  for (const s of snapshots) {
    const ts = new Date(s.timestamp).getTime();
    if (ts <= target && (!best || ts > new Date(best.timestamp).getTime())) best = s;
  }
  return best;
}

// Returns [{ type, price }] for GEX
function gexLevels(snap) {
  const out = [];
  if (!snap) return out;
  if (snap.call_wall != null) out.push({ type: 'call_wall', price: snap.call_wall });
  if (snap.put_wall != null) out.push({ type: 'put_wall', price: snap.put_wall });
  if (snap.gamma_flip != null) out.push({ type: 'gamma_flip', price: snap.gamma_flip });
  if (Array.isArray(snap.resistance)) for (let i = 0; i < snap.resistance.length; i++)
    if (snap.resistance[i] != null) out.push({ type: `R${i + 1}`, price: snap.resistance[i] });
  if (Array.isArray(snap.support)) for (let i = 0; i < snap.support.length; i++)
    if (snap.support[i] != null) out.push({ type: `S${i + 1}`, price: snap.support[i] });
  return out;
}

function todBucket(min) {
  if (min < 570) return 'pre_rth';
  if (min < 600) return 'open_30';
  if (min < 720) return 'morning';
  if (min < 840) return 'lunch';
  if (min < 930) return 'afternoon';
  if (min < 960) return 'close_30';
  return 'post_rth';
}

async function run() {
  console.log('Loading raw NQ candles…');
  const all = await loadRawNQ(START, END);
  const candles = filterPrimaryContract(all);
  console.log(`After primary-contract filter: ${candles.length.toLocaleString()} candles`);

  const byTs = new Map();
  for (const c of candles) byTs.set(c.timestamp, c);

  console.log('Loading LT levels…');
  const ltAll = await loadLTLevels(PRODUCT);
  console.log(`Loaded ${ltAll.length.toLocaleString()} LT records`);

  // Group candles by date
  const byDate = new Map();
  for (const c of candles) {
    const et = toET(c.timestamp);
    if (et.dayOfWeek < 1 || et.dayOfWeek > 5) continue;
    if (!byDate.has(et.date)) byDate.set(et.date, []);
    byDate.get(et.date).push({ candle: c, et });
  }
  const tradingDates = Array.from(byDate.keys()).sort();
  console.log(`Trading dates: ${tradingDates.length}\n`);

  const touchEvents = [];     // confluence + standalone touches
  const crossEvents = [];     // GEX×LT crossover events
  let snapHits = 0, snapMisses = 0;

  // Track previous-snapshot pair-distances for crossover detection
  // Key = `${gexType}|${ltIdx}` → previous (gex - lt) sign
  const prevPairSign = new Map();
  let prevSnapTs = null, prevDateStr = null;

  for (const dateStr of tradingDates) {
    const snapshots = loadIntradayGEX(dateStr);
    if (!snapshots || !snapshots.length) { snapMisses++; continue; }
    snapHits++;

    // Reset crossover tracking each day (don't carry across day boundaries)
    if (dateStr !== prevDateStr) {
      prevPairSign.clear();
      prevDateStr = dateStr;
    }

    // === CROSSOVER detection: walk snapshots in order ===
    const sortedSnaps = [...snapshots].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    for (const snap of sortedSnaps) {
      const ts = new Date(snap.timestamp).getTime();
      const et = toET(ts);
      if (et.timeInMinutes < 570 || et.timeInMinutes > 960) continue; // RTH only
      const lt = getLTSnapshotAt(ltAll, ts);
      if (!lt) continue;

      const gx = gexLevels(snap);
      // Build pair signs for this snapshot
      const newSigns = new Map();
      for (const g of gx) {
        for (let li = 0; li < lt.levels.length; li++) {
          const ltPrice = lt.levels[li];
          const diff = g.price - ltPrice;
          const sig = `${g.type}|${li}`;
          const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0;
          newSigns.set(sig, { sign, gex: g.price, lt: ltPrice, gexType: g.type, ltIdx: li, diff });

          if (prevPairSign.has(sig)) {
            const prev = prevPairSign.get(sig);
            if (prev.sign !== 0 && sign !== 0 && prev.sign !== sign) {
              // Crossover event
              const direction = sign > 0 ? 'gex_above_lt' : 'gex_below_lt';
              // Forward return from next 1m candle
              const entryCandle = byTs.get(ts) || byTs.get(ts + 60000);
              if (entryCandle) {
                const entryEt = toET(entryCandle.timestamp);
                if (entryEt.date === dateStr) {
                  const fwd = {};
                  for (const horizon of FORWARD_HORIZONS) {
                    const targetTs = entryCandle.timestamp + horizon * 60000;
                    const fc = byTs.get(targetTs);
                    if (!fc) { fwd[`fwd_${horizon}m`] = null; continue; }
                    const fcEt = toET(fc.timestamp);
                    if (fcEt.date !== dateStr) { fwd[`fwd_${horizon}m`] = null; continue; }
                    fwd[`fwd_${horizon}m`] = fc.close - entryCandle.open;
                  }
                  // Mid-price reference for "level price"
                  const midPrice = (g.price + ltPrice) / 2;
                  const distFromSpot = midPrice - entryCandle.open;
                  crossEvents.push({
                    date: dateStr,
                    snap_ts: ts,
                    time_et: `${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')}`,
                    gex_type: g.type,
                    lt_idx: li,
                    direction,             // gex_above_lt or gex_below_lt
                    prev_diff: prev.diff,
                    curr_diff: diff,
                    gex_price: g.price,
                    lt_price: ltPrice,
                    spot: entryCandle.open,
                    dist_from_spot: distFromSpot,
                    regime: snap.regime,
                    forwards: fwd,
                  });
                }
              }
            }
          }
        }
      }
      prevPairSign.clear();
      for (const [k, v] of newSigns) prevPairSign.set(k, v);
    }

    // === TOUCH detection: walk RTH 1m candles ===
    const dayCandles = byDate.get(dateStr) || [];
    const lastTouchTs = new Map(); // signature -> last touch ts (cooldown)

    let prevClose = null;
    for (const { candle: c, et } of dayCandles) {
      if (et.timeInMinutes < 570 || et.timeInMinutes >= 960) { prevClose = c.close; continue; }

      const snap = snapAtOrBefore(snapshots, c.timestamp);
      if (!snap) { prevClose = c.close; continue; }
      const lt = getLTSnapshotAt(ltAll, c.timestamp);
      if (!lt) { prevClose = c.close; continue; }

      const gx = gexLevels(snap);

      // Build the "level zones" for this candle:
      //   - confluence zones: GEX-LT pairs within tol → mid price
      //   - standalone GEX zones: GEX levels with NO LT within tol → GEX price
      const confluenceZones = [];
      const standaloneGex = [];
      for (const g of gx) {
        let nearestLt = null, nearestDist = Infinity;
        for (let li = 0; li < lt.levels.length; li++) {
          const d = Math.abs(g.price - lt.levels[li]);
          if (d < nearestDist) { nearestDist = d; nearestLt = { idx: li, price: lt.levels[li] }; }
        }
        if (nearestDist <= CONFLUENCE_TOL) {
          confluenceZones.push({
            gexType: g.type, gexPrice: g.price,
            ltIdx: nearestLt.idx, ltPrice: nearestLt.price,
            confluencePrice: (g.price + nearestLt.price) / 2,
            pairDist: nearestDist,
          });
        } else {
          standaloneGex.push({ gexType: g.type, gexPrice: g.price });
        }
      }

      // Helper: emit a touch event if candle is within touchDistance of `levelPrice`
      const emit = (kind, levelPrice, meta) => {
        const distLow = Math.abs(c.low - levelPrice);
        const distHigh = Math.abs(c.high - levelPrice);
        const minDist = Math.min(distLow, distHigh);
        if (minDist > TOUCH_DISTANCE) return;

        const sig = `${kind}|${meta.gexType}|${levelPrice.toFixed(2)}`;
        const last = lastTouchTs.get(sig);
        if (last && (c.timestamp - last) < COOLDOWN_MIN * 60000) return;

        let approach = 'unknown';
        if (prevClose != null) {
          if (prevClose > levelPrice) approach = 'from_above';
          else if (prevClose < levelPrice) approach = 'from_below';
        }

        // Forward windows
        const entryPrice = levelPrice;
        const forwards = {};
        for (const horizon of FORWARD_HORIZONS) {
          let mfe = 0, mae = 0;
          let endClose = null;
          for (let k = 1; k <= horizon; k++) {
            const fwd = byTs.get(c.timestamp + k * 60000);
            if (!fwd) continue;
            const up = fwd.high - entryPrice;
            const dn = entryPrice - fwd.low;
            if (approach === 'from_above') {
              if (up > mfe) mfe = up; if (dn > mae) mae = dn;
            } else if (approach === 'from_below') {
              if (dn > mfe) mfe = dn; if (up > mae) mae = up;
            } else {
              if (up > mfe) mfe = up; if (dn > mae) mae = dn;
            }
            endClose = fwd.close;
          }
          let signedReturn = null;
          if (endClose != null) {
            const raw = endClose - entryPrice;
            signedReturn = (approach === 'from_below') ? -raw : raw;
          }
          forwards[`fwd_${horizon}m`] = { mfe, mae, return: signedReturn };
        }

        touchEvents.push({
          kind,                      // 'confluence' | 'gex_only'
          timestamp: c.timestamp,
          date: dateStr,
          time_et: `${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')}`,
          tod: todBucket(et.timeInMinutes),
          regime: snap.regime,
          gexType: meta.gexType,
          levelPrice,
          ltIdx: meta.ltIdx ?? null,
          ltPrice: meta.ltPrice ?? null,
          pairDist: meta.pairDist ?? null,
          approach,
          forwards,
        });
        lastTouchTs.set(sig, c.timestamp);
      };

      // Emit touches
      for (const z of confluenceZones) {
        emit('confluence', z.confluencePrice, {
          gexType: z.gexType, ltIdx: z.ltIdx, ltPrice: z.ltPrice, pairDist: z.pairDist,
        });
      }
      for (const z of standaloneGex) {
        emit('gex_only', z.gexPrice, { gexType: z.gexType });
      }

      prevClose = c.close;
    }
  }

  console.log(`\nSnapshot files: ${snapHits} loaded, ${snapMisses} missing`);
  console.log(`Touch events: ${touchEvents.length.toLocaleString()}`);
  console.log(`  Confluence: ${touchEvents.filter(e => e.kind === 'confluence').length.toLocaleString()}`);
  console.log(`  GEX-only:   ${touchEvents.filter(e => e.kind === 'gex_only').length.toLocaleString()}`);
  console.log(`Crossover events: ${crossEvents.length.toLocaleString()}\n`);

  // === Summarize touches: confluence vs gex_only, stratified ===
  printTouchSummary(touchEvents);

  // === Summarize crossovers ===
  printCrossSummary(crossEvents);

  // Persist
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outBase = path.join(OUT_DIR, `track-e-gex-lt-interactions-${ts}`);
  fs.writeFileSync(`${outBase}.json`, JSON.stringify({
    config: { START, END, PRODUCT, GEX_DIR, CONFLUENCE_TOL, TOUCH_DISTANCE, COOLDOWN_MIN, FORWARD_HORIZONS },
    counts: {
      touch_events: touchEvents.length,
      confluence: touchEvents.filter(e => e.kind === 'confluence').length,
      gex_only: touchEvents.filter(e => e.kind === 'gex_only').length,
      crossover_events: crossEvents.length,
    },
  }, null, 2));
  fs.writeFileSync(`${outBase}.touches.json`, JSON.stringify(touchEvents));
  fs.writeFileSync(`${outBase}.crossovers.json`, JSON.stringify(crossEvents));
  console.log(`\nWrote ${outBase}.json + .touches.json + .crossovers.json`);
}

function statBlock(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = arr.reduce((s, v) => s + v, 0);
  const mean = sum / arr.length;
  return { n: arr.length, mean, median: sorted[Math.floor(arr.length * 0.5)],
    p25: sorted[Math.floor(arr.length * 0.25)], p75: sorted[Math.floor(arr.length * 0.75)] };
}

function bucket(items, keyFn) {
  const g = {};
  for (const it of items) {
    const k = keyFn(it);
    if (k == null) continue;
    if (!g[k]) g[k] = [];
    g[k].push(it);
  }
  return g;
}

function summaryRow(arr, key) {
  const ret = arr.map(t => t.forwards?.fwd_15m?.return).filter(v => v != null);
  const mfe = arr.map(t => t.forwards?.fwd_15m?.mfe).filter(v => v != null);
  const mae = arr.map(t => t.forwards?.fwd_15m?.mae).filter(v => v != null);
  const r = statBlock(ret), m = statBlock(mfe), a = statBlock(mae);
  if (!r) return null;
  const wins = ret.filter(v => v > 0).length;
  return {
    key, n: r.n,
    win: wins / r.n,
    ret_mean: r.mean, ret_median: r.median,
    mfe_mean: m?.mean ?? 0, mae_mean: a?.mean ?? 0,
    edge: (m?.mean ?? 0) - (a?.mean ?? 0),
  };
}

function printTouchSummary(events) {
  console.log('=== Confluence vs GEX-only baseline (fwd 15m) ===');
  console.log('kind'.padEnd(15), 'n'.padStart(7), 'win%'.padStart(6),
    'ret_mean'.padStart(10), 'mfe_mean'.padStart(10), 'mae_mean'.padStart(10), 'edge'.padStart(8));
  for (const k of ['confluence', 'gex_only']) {
    const subset = events.filter(e => e.kind === k);
    const r = summaryRow(subset, k);
    if (!r) continue;
    console.log(k.padEnd(15), String(r.n).padStart(7),
      (100 * r.win).toFixed(1).padStart(6),
      r.ret_mean.toFixed(2).padStart(10),
      r.mfe_mean.toFixed(2).padStart(10),
      r.mae_mean.toFixed(2).padStart(10),
      r.edge.toFixed(2).padStart(8));
  }

  // Stratify by GEX type within confluence/gex_only
  for (const kind of ['confluence', 'gex_only']) {
    const subset = events.filter(e => e.kind === kind);
    console.log(`\n=== ${kind} touches by GEX level type (n>=20) ===`);
    console.log('gex_type'.padEnd(15), 'n'.padStart(7), 'win%'.padStart(6),
      'ret_mean'.padStart(10), 'mfe_mean'.padStart(10), 'mae_mean'.padStart(10), 'edge'.padStart(8));
    const groups = bucket(subset, e => e.gexType);
    const rows = Object.entries(groups).map(([k, arr]) => summaryRow(arr, k)).filter(r => r && r.n >= 20);
    rows.sort((a, b) => b.edge - a.edge);
    for (const r of rows) {
      console.log(r.key.padEnd(15), String(r.n).padStart(7),
        (100 * r.win).toFixed(1).padStart(6),
        r.ret_mean.toFixed(2).padStart(10),
        r.mfe_mean.toFixed(2).padStart(10),
        r.mae_mean.toFixed(2).padStart(10),
        r.edge.toFixed(2).padStart(8));
    }
  }

  // Confluence with approach direction
  console.log(`\n=== confluence touches by GEX type | approach (n>=20) ===`);
  console.log('key'.padEnd(28), 'n'.padStart(7), 'win%'.padStart(6),
    'ret_mean'.padStart(10), 'mfe_mean'.padStart(10), 'mae_mean'.padStart(10), 'edge'.padStart(8));
  const conf = events.filter(e => e.kind === 'confluence');
  const groups = bucket(conf, e => `${e.gexType}|${e.approach}`);
  const rows = Object.entries(groups).map(([k, arr]) => summaryRow(arr, k)).filter(r => r && r.n >= 20);
  rows.sort((a, b) => b.edge - a.edge);
  for (const r of rows) {
    console.log(r.key.padEnd(28), String(r.n).padStart(7),
      (100 * r.win).toFixed(1).padStart(6),
      r.ret_mean.toFixed(2).padStart(10),
      r.mfe_mean.toFixed(2).padStart(10),
      r.mae_mean.toFixed(2).padStart(10),
      r.edge.toFixed(2).padStart(8));
  }

  // Pair distance bins (within confluence)
  console.log(`\n=== confluence touches by pair-distance bin (fwd 15m, n>=30) ===`);
  console.log('bin'.padEnd(15), 'n'.padStart(7), 'win%'.padStart(6),
    'ret_mean'.padStart(10), 'mfe_mean'.padStart(10), 'mae_mean'.padStart(10), 'edge'.padStart(8));
  const binGroups = bucket(conf, e => {
    const d = e.pairDist;
    if (d == null) return null;
    if (d <= 3) return '0-3pt';
    if (d <= 7) return '3-7pt';
    if (d <= 12) return '7-12pt';
    return `12-${CONFLUENCE_TOL}pt`;
  });
  for (const [k, arr] of Object.entries(binGroups)) {
    const r = summaryRow(arr, k);
    if (!r || r.n < 30) continue;
    console.log(r.key.padEnd(15), String(r.n).padStart(7),
      (100 * r.win).toFixed(1).padStart(6),
      r.ret_mean.toFixed(2).padStart(10),
      r.mfe_mean.toFixed(2).padStart(10),
      r.mae_mean.toFixed(2).padStart(10),
      r.edge.toFixed(2).padStart(8));
  }

  // LT index (which LT level confluences best?)
  console.log(`\n=== confluence touches by LT level idx (n>=20) ===`);
  console.log('lt_idx'.padEnd(8), 'n'.padStart(7), 'win%'.padStart(6),
    'ret_mean'.padStart(10), 'mfe_mean'.padStart(10), 'mae_mean'.padStart(10), 'edge'.padStart(8));
  const ltGroups = bucket(conf, e => e.ltIdx != null ? `LT${e.ltIdx + 1}` : null);
  const ltRows = Object.entries(ltGroups).map(([k, arr]) => summaryRow(arr, k)).filter(r => r && r.n >= 20);
  ltRows.sort((a, b) => b.edge - a.edge);
  for (const r of ltRows) {
    console.log(r.key.padEnd(8), String(r.n).padStart(7),
      (100 * r.win).toFixed(1).padStart(6),
      r.ret_mean.toFixed(2).padStart(10),
      r.mfe_mean.toFixed(2).padStart(10),
      r.mae_mean.toFixed(2).padStart(10),
      r.edge.toFixed(2).padStart(8));
  }
}

function printCrossSummary(events) {
  if (!events.length) return;
  console.log('\n=== Crossover events: forward NQ return ===');
  // Aggregate by direction
  console.log('group'.padEnd(35), 'n'.padStart(7), 'mean_5m'.padStart(8),
    'mean_15m'.padStart(9), 'mean_30m'.padStart(9), 'mean_60m'.padStart(9));
  const printGroup = (key, arr) => {
    const f5 = arr.map(e => e.forwards?.fwd_5m).filter(v => v != null);
    const f15 = arr.map(e => e.forwards?.fwd_15m).filter(v => v != null);
    const f30 = arr.map(e => e.forwards?.fwd_30m).filter(v => v != null);
    const f60 = arr.map(e => e.forwards?.fwd_60m).filter(v => v != null);
    const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
    console.log(key.padEnd(35), String(arr.length).padStart(7),
      mean(f5).toFixed(2).padStart(8),
      mean(f15).toFixed(2).padStart(9),
      mean(f30).toFixed(2).padStart(9),
      mean(f60).toFixed(2).padStart(9));
  };
  printGroup('all', events);
  printGroup('gex_above_lt (gex moved up)', events.filter(e => e.direction === 'gex_above_lt'));
  printGroup('gex_below_lt (gex moved down)', events.filter(e => e.direction === 'gex_below_lt'));

  // By GEX type
  console.log(`\n=== Crossovers by GEX type X direction (n>=30) ===`);
  console.log('key'.padEnd(35), 'n'.padStart(7), 'mean_15m'.padStart(9),
    'mean_60m'.padStart(9));
  const groups = bucket(events, e => `${e.gex_type}|${e.direction}`);
  const rows = [];
  for (const [k, arr] of Object.entries(groups)) {
    if (arr.length < 30) continue;
    const f15 = arr.map(e => e.forwards?.fwd_15m).filter(v => v != null);
    const f60 = arr.map(e => e.forwards?.fwd_60m).filter(v => v != null);
    const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
    rows.push({ k, n: arr.length, m15: mean(f15), m60: mean(f60) });
  }
  rows.sort((a, b) => Math.abs(b.m15) - Math.abs(a.m15));
  for (const r of rows) {
    console.log(r.k.padEnd(35), String(r.n).padStart(7),
      r.m15.toFixed(2).padStart(9), r.m60.toFixed(2).padStart(9));
  }
}

run().catch(e => { console.error(e); process.exit(1); });
