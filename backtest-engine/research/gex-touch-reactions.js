/**
 * Track 1: GEX Touch Reaction Analysis
 *
 * For every RTH minute where price comes within `--touch-distance` pts of a GEX
 * level (call_wall, put_wall, gamma_flip, S1-S5, R1-R5), measure forward
 * MFE/MAE/return at 5/15/30/60-min horizons and stratify by:
 *   - level type
 *   - approach direction (from above / from below)
 *   - regime (positive / neutral / negative)
 *   - level GEX magnitude bucket
 *   - time-of-day bucket
 *
 * MUST be run on raw 1m contract data filtered to primary contract.
 *
 * Usage:
 *   node research/gex-touch-reactions.js \
 *     --start 2025-01-13 --end 2026-01-23 \
 *     --touch-distance 5 --cooldown-min 30
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

// --- CLI args ---
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const START = arg('start', '2025-01-13');
const END = arg('end', '2026-01-23');
const TOUCH_DISTANCE = Number(arg('touch-distance', 5)); // pts within level to count as touch
const COOLDOWN_MIN = Number(arg('cooldown-min', 30)); // min minutes between touches of the same level
const PRODUCT = arg('product', 'NQ').toUpperCase();
const GEX_DIR = arg('gex-dir', 'nq-cbbo'); // subdir under data/gex/, defaults to trustworthy cbbo
const FORWARD_BARS = [5, 15, 30, 60]; // horizons in minutes
// Lookahead correction: snapshot labeled T contains data through T+14:59
// (15-min bucketing keeps last close). For a candle at C, only use snapshots
// with snap_ts <= C - SNAP_LAG_MIN so all its data is genuinely in the past.
const SNAP_LAG_MIN = Number(arg('snap-lag-min', 16));

console.log(`\n=== GEX Touch Reaction Study: ${PRODUCT} ===`);
console.log(`Date range: ${START} -> ${END}`);
console.log(`Touch distance: ${TOUCH_DISTANCE} pts | Cooldown: ${COOLDOWN_MIN} min`);
console.log(`Forward horizons: ${FORWARD_BARS.join(', ')} min`);
console.log(`GEX dir: data/gex/${GEX_DIR}`);
console.log(`Snapshot lag (lookahead correction): require snap_ts <= candle_ts - ${SNAP_LAG_MIN} min\n`);

// Custom intraday GEX loader for the cbbo subdirectory
function loadIntradayGEXCustom(dateStr) {
  const filename = `${PRODUCT.toLowerCase()}_gex_${dateStr}.json`;
  const filePath = path.join(DATA_DIR, 'gex', GEX_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return content.data || [];
}

// --- Load raw 1m candles + filter primary contract ---
async function loadRawNQ(startStr, endStr) {
  const filePath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1m.csv`);
  if (!fs.existsSync(filePath)) throw new Error(`OHLCV not found: ${filePath}`);

  const start = new Date(startStr).getTime();
  const end = new Date(endStr).getTime() + 24 * 3600000;

  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return; // skip calendar spreads
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
  console.log(`Loaded ${candles.length.toLocaleString()} raw candles`);
  return candles;
}

// Per-hour highest-volume primary contract filter (matches csv-loader.js)
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

// --- GEX snapshot lookup (no-lookahead: most recent at-or-before target) ---
function snapshotAtOrBefore(snapshots, targetTs) {
  if (!snapshots || !snapshots.length) return null;
  let best = null;
  for (const s of snapshots) {
    const ts = new Date(s.timestamp).getTime();
    if (ts <= targetTs && (!best || ts > new Date(best.timestamp).getTime())) {
      best = s;
    }
  }
  return best;
}

// --- Build flat level list from a snapshot ---
// Returns [{ type, price, gex, isResistance }]
function extractLevels(snap) {
  const levels = [];
  if (!snap) return levels;
  if (snap.call_wall != null) {
    levels.push({ type: 'call_wall', price: snap.call_wall, gex: snap.call_wall_gex || 0, isResistance: true });
  }
  if (snap.put_wall != null) {
    levels.push({ type: 'put_wall', price: snap.put_wall, gex: snap.put_wall_gex || 0, isResistance: false });
  }
  if (snap.gamma_flip != null) {
    levels.push({ type: 'gamma_flip', price: snap.gamma_flip, gex: 0, isResistance: null });
  }
  if (Array.isArray(snap.resistance)) {
    for (let i = 0; i < snap.resistance.length; i++) {
      levels.push({
        type: `R${i + 1}`,
        price: snap.resistance[i],
        gex: snap.resistance_gex?.[i] || 0,
        isResistance: true,
      });
    }
  }
  if (Array.isArray(snap.support)) {
    for (let i = 0; i < snap.support.length; i++) {
      levels.push({
        type: `S${i + 1}`,
        price: snap.support[i],
        gex: snap.support_gex?.[i] || 0,
        isResistance: false,
      });
    }
  }
  return levels;
}

// --- Bucket helpers ---
function todBucket(minutesET) {
  // 9:30 = 570
  if (minutesET < 570) return 'pre_rth';
  if (minutesET < 600) return 'open_30';     // 9:30-10:00
  if (minutesET < 720) return 'morning';     // 10:00-12:00
  if (minutesET < 840) return 'lunch';       // 12:00-14:00
  if (minutesET < 930) return 'afternoon';   // 14:00-15:30
  if (minutesET < 960) return 'close_30';    // 15:30-16:00
  return 'post_rth';
}

function gexMagBucket(absGex) {
  if (absGex < 1e8) return '<100M';
  if (absGex < 5e8) return '100M-500M';
  if (absGex < 1e9) return '500M-1B';
  if (absGex < 5e9) return '1B-5B';
  return '5B+';
}

// --- Core: walk candles, detect touches, measure forward windows ---
async function run() {
  const all = await loadRawNQ(START, END);
  const candles = filterPrimaryContract(all);
  console.log(`After primary-contract filter: ${candles.length.toLocaleString()} candles`);

  // Index by timestamp for O(1) forward bar access
  const byTs = new Map();
  for (const c of candles) byTs.set(c.timestamp, c);

  // Group candles by date with cached ET info
  const byDate = new Map();
  for (const c of candles) {
    const et = toET(c.timestamp);
    if (et.dayOfWeek < 1 || et.dayOfWeek > 5) continue;
    if (!byDate.has(et.date)) byDate.set(et.date, []);
    byDate.get(et.date).push({ candle: c, et });
  }
  const tradingDates = Array.from(byDate.keys()).sort();
  console.log(`Trading dates: ${tradingDates.length}`);

  const touches = []; // raw touch events
  let snapHits = 0, snapMisses = 0;

  // Per-day processing
  for (const dateStr of tradingDates) {
    const snapshots = loadIntradayGEXCustom(dateStr);
    if (!snapshots || !snapshots.length) { snapMisses++; continue; }
    snapHits++;

    // Per-level cooldown tracker (level signature = type@roundedPrice)
    const lastTouchTs = new Map();
    const dayCandles = byDate.get(dateStr) || [];

    // Iterate RTH candles for this date in sequence
    let prevClose = null;
    for (const { candle: c, et } of dayCandles) {
      if (et.timeInMinutes < 570 || et.timeInMinutes >= 960) { prevClose = c.close; continue; }

      // Lookahead correction: only use snapshots whose data window ended
      // before the current candle. snap_ts must be <= c.timestamp - SNAP_LAG_MIN.
      const snap = snapshotAtOrBefore(snapshots, c.timestamp - SNAP_LAG_MIN * 60000);
      if (!snap) { prevClose = c.close; continue; }

      const levels = extractLevels(snap);

      for (const lvl of levels) {
        if (lvl.price == null || isNaN(lvl.price)) continue;
        const sig = `${lvl.type}@${lvl.price.toFixed(2)}`;
        const last = lastTouchTs.get(sig);
        if (last && (c.timestamp - last) < COOLDOWN_MIN * 60000) continue;

        // Touch detection: candle high/low entered within TOUCH_DISTANCE of level
        const distLow = Math.abs(c.low - lvl.price);
        const distHigh = Math.abs(c.high - lvl.price);
        const minDist = Math.min(distLow, distHigh);
        if (minDist > TOUCH_DISTANCE) continue;

        // Approach direction: did prior close come from above or below the level?
        let approach = 'unknown';
        if (prevClose != null) {
          if (prevClose > lvl.price) approach = 'from_above';
          else if (prevClose < lvl.price) approach = 'from_below';
        }

        // Forward window measurements
        // Use level price as entry (touch price) — assume fill at level
        const entryPrice = lvl.price;
        const forwardStats = {};
        for (const horizon of FORWARD_BARS) {
          let mfe = 0, mae = 0; // max favorable/adverse from entry, signed by approach
          let endClose = null;
          let bars = 0;
          for (let k = 1; k <= horizon; k++) {
            const fwd = byTs.get(c.timestamp + k * 60000);
            if (!fwd) continue;
            bars++;
            const upMove = fwd.high - entryPrice;
            const dnMove = entryPrice - fwd.low;
            // For "bounce" framing: bounce direction = away from level
            // - touch from_above (price came down to level): bounce = up; favorable = up
            // - touch from_below (price came up to level): bounce = down; favorable = down
            if (approach === 'from_above') {
              if (upMove > mfe) mfe = upMove;
              if (dnMove > mae) mae = dnMove;
            } else if (approach === 'from_below') {
              if (dnMove > mfe) mfe = dnMove;
              if (upMove > mae) mae = upMove;
            } else {
              // unknown approach: just record raw range
              if (upMove > mfe) mfe = upMove;
              if (dnMove > mae) mae = dnMove;
            }
            endClose = fwd.close;
          }
          let signedReturn = null;
          if (endClose != null) {
            const raw = endClose - entryPrice;
            signedReturn = (approach === 'from_below') ? -raw : raw; // bounce-positive
          }
          forwardStats[`fwd_${horizon}m`] = {
            mfe, mae, return: signedReturn, bars,
          };
        }

        touches.push({
          timestamp: c.timestamp,
          date: dateStr,
          time_et: `${String(Math.floor(et.timeInMinutes / 60)).padStart(2, '0')}:${String(et.timeInMinutes % 60).padStart(2, '0')}`,
          tod: todBucket(et.timeInMinutes),
          level_type: lvl.type,
          level_price: lvl.price,
          level_gex: lvl.gex,
          touch_low_dist: distLow,
          touch_high_dist: distHigh,
          approach,
          regime: snap.regime || 'unknown',
          total_gex: snap.total_gex || 0,
          gamma_imbalance: snap.gamma_imbalance || 0,
          gex_mag_bucket: gexMagBucket(Math.abs(lvl.gex)),
          forwards: forwardStats,
        });

        lastTouchTs.set(sig, c.timestamp);
      }
      prevClose = c.close;
    }
  }

  console.log(`\nSnapshot files hit: ${snapHits} | missing: ${snapMisses}`);
  console.log(`Total touch events: ${touches.length.toLocaleString()}\n`);

  // --- Aggregate ---
  const agg = aggregate(touches);
  printSummary(agg);

  // --- Persist ---
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outBase = path.join(OUT_DIR, `gex-touch-reactions-${ts}`);
  fs.writeFileSync(`${outBase}.json`, JSON.stringify({
    config: { START, END, TOUCH_DISTANCE, COOLDOWN_MIN, PRODUCT, FORWARD_BARS },
    snapshot_files_loaded: snapHits, snapshot_files_missing: snapMisses,
    touch_count: touches.length,
    aggregates: agg,
  }, null, 2));
  fs.writeFileSync(`${outBase}.touches.json`, JSON.stringify(touches));
  console.log(`\nWritten: ${outBase}.json`);
  console.log(`Raw touches: ${outBase}.touches.json`);
}

// --- Aggregation ---
function statBlock(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = arr.reduce((s, v) => s + v, 0);
  const mean = sum / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  const stddev = Math.sqrt(variance);
  return {
    n: arr.length, mean, stddev,
    median: sorted[Math.floor(sorted.length / 2)],
    p25: sorted[Math.floor(sorted.length * 0.25)],
    p75: sorted[Math.floor(sorted.length * 0.75)],
    min: sorted[0], max: sorted[sorted.length - 1],
  };
}

function aggregate(touches) {
  const groups = {
    by_level_type: {},
    by_level_x_approach: {},
    by_level_x_regime: {},
    by_level_x_tod: {},
    by_level_x_gex_mag: {},
  };

  for (const t of touches) {
    const keys = {
      by_level_type: t.level_type,
      by_level_x_approach: `${t.level_type}|${t.approach}`,
      by_level_x_regime: `${t.level_type}|${t.regime}`,
      by_level_x_tod: `${t.level_type}|${t.tod}`,
      by_level_x_gex_mag: `${t.level_type}|${t.gex_mag_bucket}`,
    };

    for (const [groupName, key] of Object.entries(keys)) {
      if (!groups[groupName][key]) {
        groups[groupName][key] = {
          count: 0,
          mfe_15: [], mae_15: [], ret_15: [],
          mfe_30: [], mae_30: [], ret_30: [],
          mfe_60: [], mae_60: [], ret_60: [],
          bounce_15_count: 0, bounce_30_count: 0, bounce_60_count: 0,
        };
      }
      const g = groups[groupName][key];
      g.count++;
      for (const h of [15, 30, 60]) {
        const fw = t.forwards[`fwd_${h}m`];
        if (!fw) continue;
        g[`mfe_${h}`].push(fw.mfe);
        g[`mae_${h}`].push(fw.mae);
        if (fw.return != null) g[`ret_${h}`].push(fw.return);
        // Bounce = signed return positive (price moved away from level in the "bounce" direction)
        if (fw.return != null && fw.return > 0) g[`bounce_${h}_count`]++;
      }
    }
  }

  // Convert raw arrays into stats
  for (const groupName of Object.keys(groups)) {
    for (const key of Object.keys(groups[groupName])) {
      const g = groups[groupName][key];
      const out = { count: g.count };
      for (const h of [15, 30, 60]) {
        out[`mfe_${h}`] = statBlock(g[`mfe_${h}`]);
        out[`mae_${h}`] = statBlock(g[`mae_${h}`]);
        out[`ret_${h}`] = statBlock(g[`ret_${h}`]);
        out[`bounce_${h}_rate`] = g.count ? g[`bounce_${h}_count`] / g.count : 0;
      }
      groups[groupName][key] = out;
    }
  }
  return groups;
}

// --- Pretty-print top findings ---
function printSummary(agg) {
  console.log('=== Touch reaction by level type (15m forward) ===');
  console.log('level_type'.padEnd(12), 'n'.padStart(7), 'bounce%'.padStart(10),
    'mean_ret'.padStart(10), 'mean_mfe'.padStart(10), 'mean_mae'.padStart(10), 'edge'.padStart(10));
  const rows = Object.entries(agg.by_level_type)
    .map(([k, v]) => ({
      key: k, n: v.count,
      bounce: v.bounce_15_rate,
      ret: v.ret_15?.mean ?? 0,
      mfe: v.mfe_15?.mean ?? 0,
      mae: v.mae_15?.mean ?? 0,
      edge: (v.mfe_15?.mean ?? 0) - (v.mae_15?.mean ?? 0),
    }))
    .sort((a, b) => b.edge - a.edge);
  for (const r of rows) {
    console.log(
      r.key.padEnd(12),
      String(r.n).padStart(7),
      (100 * r.bounce).toFixed(1).padStart(10),
      r.ret.toFixed(2).padStart(10),
      r.mfe.toFixed(2).padStart(10),
      r.mae.toFixed(2).padStart(10),
      r.edge.toFixed(2).padStart(10),
    );
  }

  console.log('\n=== Top 15 (level | approach) by edge (mfe - mae @ 15m) — n>=50 ===');
  const lxa = Object.entries(agg.by_level_x_approach)
    .filter(([_, v]) => v.count >= 50)
    .map(([k, v]) => ({
      key: k, n: v.count, bounce: v.bounce_15_rate,
      ret: v.ret_15?.mean ?? 0, mfe: v.mfe_15?.mean ?? 0, mae: v.mae_15?.mean ?? 0,
      edge: (v.mfe_15?.mean ?? 0) - (v.mae_15?.mean ?? 0),
    }))
    .sort((a, b) => b.edge - a.edge).slice(0, 15);
  console.log('key'.padEnd(28), 'n'.padStart(7), 'bounce%'.padStart(10), 'ret'.padStart(10), 'mfe'.padStart(10), 'mae'.padStart(10), 'edge'.padStart(10));
  for (const r of lxa) {
    console.log(r.key.padEnd(28), String(r.n).padStart(7),
      (100 * r.bounce).toFixed(1).padStart(10),
      r.ret.toFixed(2).padStart(10), r.mfe.toFixed(2).padStart(10),
      r.mae.toFixed(2).padStart(10), r.edge.toFixed(2).padStart(10));
  }

  console.log('\n=== Top 15 (level | regime) by edge — n>=50 ===');
  const lxr = Object.entries(agg.by_level_x_regime)
    .filter(([_, v]) => v.count >= 50)
    .map(([k, v]) => ({
      key: k, n: v.count, bounce: v.bounce_15_rate,
      ret: v.ret_15?.mean ?? 0, mfe: v.mfe_15?.mean ?? 0, mae: v.mae_15?.mean ?? 0,
      edge: (v.mfe_15?.mean ?? 0) - (v.mae_15?.mean ?? 0),
    }))
    .sort((a, b) => b.edge - a.edge).slice(0, 15);
  console.log('key'.padEnd(28), 'n'.padStart(7), 'bounce%'.padStart(10), 'ret'.padStart(10), 'mfe'.padStart(10), 'mae'.padStart(10), 'edge'.padStart(10));
  for (const r of lxr) {
    console.log(r.key.padEnd(28), String(r.n).padStart(7),
      (100 * r.bounce).toFixed(1).padStart(10),
      r.ret.toFixed(2).padStart(10), r.mfe.toFixed(2).padStart(10),
      r.mae.toFixed(2).padStart(10), r.edge.toFixed(2).padStart(10));
  }
}

run().catch(e => { console.error(e); process.exit(1); });
