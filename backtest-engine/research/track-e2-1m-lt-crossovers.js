/**
 * Track E2 — 1m LT × GEX Crossover Analysis
 *
 * Uses the user's TradingView-extracted 1m LT data
 * (research/lt-extraction/output/nq_lt_1m_raw.csv, raw-contract space) and
 * detects sign flips of (gex_level − lt_level) at 1-minute cadence for all
 * 13 GEX × 5 LT = 65 pairs.
 *
 * The 1m LT signal is INDEPENDENT of the 15m LT signal (chart timeframe is
 * a fundamental input to the LT calculation), so this is its own test of
 * directional bias — not a downsampling of Track E's 15m result.
 *
 * Forward analysis (same convention as Track E):
 *   - Entry candle = NQ raw 1m candle at-or-after the LT_1m row's timestamp
 *   - Forward return = entry_candle.close at +H min minus entry_candle.open
 *   - Direction-conditional means at 5/15/30/60 min
 *
 * Run:
 *   node research/track-e2-1m-lt-crossovers.js \
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
const END = arg('end', '2026-04-23');
const PRODUCT = arg('product', 'NQ').toUpperCase();
const GEX_DIR = arg('gex-dir', 'nq-cbbo');
const LT_1M_PATH = arg('lt-file', path.join(ROOT, 'research', 'lt-extraction', 'output', 'nq_lt_1m_raw.csv'));
const FORWARD_HORIZONS = [5, 15, 30, 60];
const RTH_START = 570, RTH_END = 960;

console.log(`\n=== 1m LT × GEX Crossover Study: ${PRODUCT} ===`);
console.log(`Date range: ${START} -> ${END}`);
console.log(`GEX dir: data/gex/${GEX_DIR}`);
console.log(`LT 1m file: ${LT_1M_PATH}`);
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

async function loadLT1m(filePath) {
  const records = [];
  await new Promise((res, rej) => {
    fs.createReadStream(filePath).pipe(csv())
      .on('data', r => {
        const ts = +r.unix_ms;
        if (isNaN(ts)) return;
        const levels = [+r.level_1, +r.level_2, +r.level_3, +r.level_4, +r.level_5];
        // Drop warmup rows (any NaN level)
        if (levels.some(l => isNaN(l))) return;
        records.push({ ts, levels });
      }).on('end', res).on('error', rej);
  });
  records.sort((a, b) => a.ts - b.ts);
  return records;
}

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

function snapAtOrBefore(sortedSnaps, target) {
  // Binary search for largest index where snap ts <= target
  if (!sortedSnaps.length) return null;
  let lo = 0, hi = sortedSnaps.length - 1;
  if (sortedSnaps[0]._ts > target) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (sortedSnaps[mid]._ts <= target) lo = mid;
    else hi = mid - 1;
  }
  return sortedSnaps[lo];
}

async function run() {
  console.log('Loading raw NQ candles…');
  const all = await loadRawNQ(START, END);
  const candles = filterPrimaryContract(all);
  console.log(`After primary-contract filter: ${candles.length.toLocaleString()} candles`);
  const byTs = new Map();
  for (const c of candles) byTs.set(c.timestamp, c);

  console.log('Loading 1m LT records…');
  const ltAll = await loadLT1m(LT_1M_PATH);
  console.log(`Loaded ${ltAll.length.toLocaleString()} 1m LT records (after warmup drop)`);

  const startMs = new Date(START).getTime();
  const endMs = new Date(END).getTime() + 24 * 3600000;
  const ltInRange = ltAll.filter(r => r.ts >= startMs && r.ts <= endMs);
  console.log(`In window: ${ltInRange.length.toLocaleString()} LT 1m records`);

  // Group LT records by date so we can load the right GEX snapshots
  const byDate = new Map();
  for (const r of ltInRange) {
    const et = toET(r.ts);
    if (et.dayOfWeek < 1 || et.dayOfWeek > 5) continue;
    if (!byDate.has(et.date)) byDate.set(et.date, []);
    byDate.get(et.date).push(r);
  }
  const tradingDates = Array.from(byDate.keys()).sort();
  console.log(`Trading dates with LT data: ${tradingDates.length}\n`);

  const events = [];
  let snapHits = 0, snapMisses = 0;

  for (const dateStr of tradingDates) {
    const snapshots = loadIntradayGEX(dateStr);
    if (!snapshots || snapshots.length < 1) { snapMisses++; continue; }
    snapHits++;
    const sortedSnaps = snapshots
      .map(s => ({ ...s, _ts: new Date(s.timestamp).getTime() }))
      .sort((a, b) => a._ts - b._ts);

    // Per-pair sign tracking, reset each day
    const prevSign = new Map();        // key = "gexType|ltIdx" → { sign, gex, lt }
    const dayLts = byDate.get(dateStr) || [];

    for (const lt of dayLts) {
      const ltEt = toET(lt.ts);
      // Restrict to RTH 9:30 - 16:00 ET
      if (ltEt.timeInMinutes < RTH_START || ltEt.timeInMinutes > RTH_END) continue;

      const snap = snapAtOrBefore(sortedSnaps, lt.ts);
      if (!snap) continue;

      const gx = gexLevels(snap);

      // Compute current pair signs
      for (const g of gx) {
        for (let li = 0; li < lt.levels.length; li++) {
          const ltPrice = lt.levels[li];
          const diff = g.price - ltPrice;
          const sig = `${g.type}|${li}`;
          const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0;

          if (prevSign.has(sig)) {
            const prev = prevSign.get(sig);
            if (prev.sign !== 0 && sign !== 0 && prev.sign !== sign) {
              // Crossover event detected
              const direction = sign > 0 ? 'gex_above_lt' : 'gex_below_lt';
              const entryCandle = byTs.get(lt.ts);
              if (entryCandle) {
                const entryEt = toET(entryCandle.timestamp);
                if (entryEt.date === dateStr) {
                  const fwd = {};
                  for (const horizon of FORWARD_HORIZONS) {
                    const fc = byTs.get(entryCandle.timestamp + horizon * 60000);
                    if (!fc) { fwd[`fwd_${horizon}m`] = null; continue; }
                    if (toET(fc.timestamp).date !== dateStr) {
                      fwd[`fwd_${horizon}m`] = null; continue;
                    }
                    fwd[`fwd_${horizon}m`] = fc.close - entryCandle.open;
                  }
                  const midPrice = (g.price + ltPrice) / 2;
                  events.push({
                    date: dateStr,
                    ts: lt.ts,
                    time_et: `${String(ltEt.hour).padStart(2, '0')}:${String(ltEt.minute).padStart(2, '0')}`,
                    gex_type: g.type,
                    lt_idx: li,
                    direction,
                    prev_diff: prev.gex - prev.lt,
                    curr_diff: diff,
                    gex_price: g.price,
                    lt_price: ltPrice,
                    spot: entryCandle.open,
                    dist_from_spot: midPrice - entryCandle.open,
                    regime: snap.regime,
                    forwards: fwd,
                  });
                }
              }
            }
          }
          prevSign.set(sig, { sign, gex: g.price, lt: ltPrice });
        }
      }
    }
  }

  console.log(`Snapshot files: ${snapHits} loaded, ${snapMisses} missing`);
  console.log(`Crossover events: ${events.length.toLocaleString()}\n`);

  printSummary(events);

  // Persist
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outBase = path.join(OUT_DIR, `track-e2-1m-lt-crossovers-${ts}`);
  fs.writeFileSync(`${outBase}.json`, JSON.stringify({
    config: { START, END, PRODUCT, GEX_DIR, LT_1M_PATH, FORWARD_HORIZONS },
    counts: { events: events.length, snapHits, snapMisses },
  }, null, 2));
  fs.writeFileSync(`${outBase}.events.json`, JSON.stringify(events));
  console.log(`\nWrote ${outBase}.json + .events.json`);
}

function printSummary(events) {
  if (!events.length) return;
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  const filterFwd = (events, h) => events.map(e => e.forwards?.[`fwd_${h}m`]).filter(v => v != null);

  console.log('=== All 1m LT × GEX crossovers ===');
  console.log('group'.padEnd(36), 'n'.padStart(8), 'mean_5m'.padStart(9),
    'mean_15m'.padStart(9), 'mean_30m'.padStart(9), 'mean_60m'.padStart(9));
  const printGroup = (key, arr) => {
    console.log(key.padEnd(36), String(arr.length).padStart(8),
      mean(filterFwd(arr, 5)).toFixed(2).padStart(9),
      mean(filterFwd(arr, 15)).toFixed(2).padStart(9),
      mean(filterFwd(arr, 30)).toFixed(2).padStart(9),
      mean(filterFwd(arr, 60)).toFixed(2).padStart(9));
  };
  printGroup('all', events);
  printGroup('gex_above_lt (gex moved up)', events.filter(e => e.direction === 'gex_above_lt'));
  printGroup('gex_below_lt (gex moved down)', events.filter(e => e.direction === 'gex_below_lt'));

  // By GEX type × direction
  console.log('\n=== Crossovers by GEX type × direction (n>=50, sorted by |mean_15m|) ===');
  console.log('key'.padEnd(36), 'n'.padStart(8), 'mean_5m'.padStart(9),
    'mean_15m'.padStart(9), 'mean_30m'.padStart(9), 'mean_60m'.padStart(9));
  const groups = {};
  for (const e of events) {
    const k = `${e.gex_type}|${e.direction}`;
    if (!groups[k]) groups[k] = [];
    groups[k].push(e);
  }
  const rows = [];
  for (const [k, arr] of Object.entries(groups)) {
    if (arr.length < 50) continue;
    rows.push({
      k, n: arr.length,
      m5: mean(filterFwd(arr, 5)),
      m15: mean(filterFwd(arr, 15)),
      m30: mean(filterFwd(arr, 30)),
      m60: mean(filterFwd(arr, 60)),
    });
  }
  rows.sort((a, b) => Math.abs(b.m15) - Math.abs(a.m15));
  for (const r of rows) {
    console.log(r.k.padEnd(36), String(r.n).padStart(8),
      r.m5.toFixed(2).padStart(9),
      r.m15.toFixed(2).padStart(9),
      r.m30.toFixed(2).padStart(9),
      r.m60.toFixed(2).padStart(9));
  }

  // By LT index (which 1m LT level is most informative?)
  console.log('\n=== Crossovers by LT index × direction (n>=50) ===');
  console.log('key'.padEnd(20), 'n'.padStart(8), 'mean_15m'.padStart(9), 'mean_60m'.padStart(9));
  const ltGroups = {};
  for (const e of events) {
    const k = `LT${e.lt_idx + 1}|${e.direction}`;
    if (!ltGroups[k]) ltGroups[k] = [];
    ltGroups[k].push(e);
  }
  const ltRows = [];
  for (const [k, arr] of Object.entries(ltGroups)) {
    if (arr.length < 50) continue;
    ltRows.push({
      k, n: arr.length,
      m15: mean(filterFwd(arr, 15)),
      m60: mean(filterFwd(arr, 60)),
    });
  }
  ltRows.sort((a, b) => Math.abs(b.m15) - Math.abs(a.m15));
  for (const r of ltRows) {
    console.log(r.k.padEnd(20), String(r.n).padStart(8),
      r.m15.toFixed(2).padStart(9),
      r.m60.toFixed(2).padStart(9));
  }
}

run().catch(e => { console.error(e); process.exit(1); });
