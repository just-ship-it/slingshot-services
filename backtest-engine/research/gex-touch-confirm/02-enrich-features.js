/**
 * Phase 2: Feature enrichment
 *
 * Reads the Phase 1b resolved touches JSON and joins each touch event to a wide
 * net of confirmation features drawn from independently loaded sources:
 *   A. Volume (1m raw OHLCV — re-loaded with primary-contract filter)
 *   B. IV (QQQ ATM 1m smoothed and raw)
 *   C. 1m candle patterns (touch bar shape, prior compression, ATR-relative)
 *   D. 1s micro-patterns (wick rejection, seconds-at-level, etc.)
 *   E. Structural context (distance to next level, level GEX rank, regime strength)
 *
 * Output: same JSON shape as Phase 1b with each touch carrying a `features` block.
 *
 * Usage:
 *   node research/gex-touch-confirm/02-enrich-features.js \
 *     --in research/output/gex-touch-confirm-base-<TS>.resolved.json
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { toET } from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const IN = arg('in');
if (!IN) {
  console.error('Missing --in <path>');
  process.exit(1);
}
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);
if (!fs.existsSync(inPath)) {
  console.error(`Input not found: ${inPath}`);
  process.exit(1);
}

console.log(`\n=== Phase 2: Feature Enrichment ===`);
console.log(`Input: ${inPath}\n`);

const payload = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const { touches, config } = payload;
console.log(`Touches: ${touches.length.toLocaleString()}`);

// --- 1. Load and filter 1m raw OHLCV ---
async function loadRawNQ(startStr, endStr) {
  const filePath = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
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
        const c = { timestamp: ts, open: +row.open, high: +row.high, low: +row.low,
          close: +row.close, volume: +row.volume || 0, symbol: row.symbol };
        if (isNaN(c.open) || isNaN(c.close)) return;
        candles.push(c);
      })
      .on('end', resolve).on('error', reject);
  });
  candles.sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}
function filterPrimaryContract(candles) {
  const hourVol = new Map();
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    if (!hourVol.has(h)) hourVol.set(h, new Map());
    const m = hourVol.get(h);
    m.set(c.symbol, (m.get(c.symbol) || 0) + (c.volume || 0));
  }
  const primaryByHour = new Map();
  for (const [h, m] of hourVol.entries()) {
    let bestSym = '', bestVol = 0;
    for (const [s, v] of m.entries()) if (v > bestVol) { bestVol = v; bestSym = s; }
    primaryByHour.set(h, bestSym);
  }
  return candles.filter(c => c.symbol === primaryByHour.get(Math.floor(c.timestamp / 3600000)));
}

console.log(`Loading raw 1m OHLCV (${config.START} → ${config.END}) ...`);
const allCandles = await loadRawNQ(config.START, config.END);
const candles = filterPrimaryContract(allCandles);
console.log(`Loaded ${allCandles.length.toLocaleString()} raw, ${candles.length.toLocaleString()} after primary-contract filter`);

const byTs = new Map();
for (const c of candles) byTs.set(c.timestamp, c);

// --- 2. Compute ATR(14) per minute (Wilder SMA) ---
// We compute on the contiguous primary-contract sequence. Reset on contract change.
console.log(`Computing ATR(14) ...`);
const atrByTs = new Map();
{
  let trBuf = [];
  let prevClose = null, prevSym = null;
  for (const c of candles) {
    if (prevSym !== null && c.symbol !== prevSym) { trBuf = []; prevClose = null; }
    const tr = prevClose == null
      ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    trBuf.push(tr);
    if (trBuf.length > 14) trBuf.shift();
    if (trBuf.length === 14) {
      const atr = trBuf.reduce((s, v) => s + v, 0) / 14;
      atrByTs.set(c.timestamp, atr);
    }
    prevClose = c.close;
    prevSym = c.symbol;
  }
}
console.log(`  ATR series: ${atrByTs.size.toLocaleString()} entries`);

// --- 3. Load IV files ---
console.log(`Loading QQQ ATM IV ...`);
const ivByTs = new Map();         // smoothed: ts -> {iv, spot, atm_strike, call_iv, put_iv, dte}
const rawIvByTs = new Map();      // raw: ts -> {iv, call_iv, put_iv, dte}
async function loadCSV(filePath, parser) {
  if (!fs.existsSync(filePath)) {
    console.warn(`  IV file missing: ${filePath}`);
    return 0;
  }
  let n = 0;
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).pipe(csv())
      .on('data', (row) => { parser(row); n++; })
      .on('end', resolve).on('error', reject);
  });
  return n;
}
const smoothedN = await loadCSV(path.join(DATA_DIR, 'iv', 'qqq', 'qqq_atm_iv_1m_smoothed.csv'), (row) => {
  const ts = new Date(row.timestamp).getTime();
  if (isNaN(ts)) return;
  ivByTs.set(ts, { iv: +row.iv, spot: +row.spot_price, dte: +row.dte });
});
const rawN = await loadCSV(path.join(DATA_DIR, 'iv', 'qqq', 'qqq_atm_iv_1m.csv'), (row) => {
  const ts = new Date(row.timestamp).getTime();
  if (isNaN(ts)) return;
  rawIvByTs.set(ts, { iv: +row.iv, call_iv: +row.call_iv, put_iv: +row.put_iv, dte: +row.dte });
});
console.log(`  Smoothed IV rows: ${smoothedN.toLocaleString()} | raw IV rows: ${rawN.toLocaleString()}`);


// --- 4. Per-day GEX snapshot cache ---
const gexByDate = new Map();
function getSnapshots(dateStr) {
  if (gexByDate.has(dateStr)) return gexByDate.get(dateStr);
  const filename = `nq_gex_${dateStr}.json`;
  const filePath = path.join(DATA_DIR, 'gex', 'nq-cbbo', filename);
  if (!fs.existsSync(filePath)) { gexByDate.set(dateStr, null); return null; }
  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  gexByDate.set(dateStr, content.data || []);
  return content.data || [];
}
function snapshotAtOrBefore(snapshots, targetTs) {
  if (!snapshots || !snapshots.length) return null;
  let best = null, bestTs = -Infinity;
  for (const s of snapshots) {
    const ts = new Date(s.timestamp).getTime();
    if (ts <= targetTs && ts > bestTs) { best = s; bestTs = ts; }
  }
  return best;
}
function flattenLevels(snap) {
  const levels = [];
  if (!snap) return levels;
  if (snap.call_wall != null) levels.push({ type: 'call_wall', price: snap.call_wall, gex: snap.call_wall_gex || 0 });
  if (snap.put_wall != null) levels.push({ type: 'put_wall', price: snap.put_wall, gex: snap.put_wall_gex || 0 });
  if (snap.gamma_flip != null) levels.push({ type: 'gamma_flip', price: snap.gamma_flip, gex: 0 });
  if (Array.isArray(snap.resistance)) snap.resistance.forEach((p, i) => {
    if (p != null) levels.push({ type: `R${i + 1}`, price: p, gex: snap.resistance_gex?.[i] || 0 });
  });
  if (Array.isArray(snap.support)) snap.support.forEach((p, i) => {
    if (p != null) levels.push({ type: `S${i + 1}`, price: p, gex: snap.support_gex?.[i] || 0 });
  });
  return levels;
}

// --- 5. Helpers ---
function pctileOf(sortedArr, value) {
  if (!sortedArr.length) return null;
  let lo = 0, hi = sortedArr.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (sortedArr[m] <= value) lo = m + 1; else hi = m;
  }
  return lo / sortedArr.length;
}
function linregSlope(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += arr[i]; sxy += i * arr[i]; sxx += i * i; }
  const denom = n * sxx - sx * sx;
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

// --- 6. 1s micro-pattern collection ---
// For every touch, we need 1s data for [touch_minute_start, touch_minute_start + 60s].
const oneSlotsByMinute = new Map(); // minuteTs -> [touch refs]
for (const t of touches) {
  const minTs = Math.floor(t.ts / 60000) * 60000;
  if (!oneSlotsByMinute.has(minTs)) oneSlotsByMinute.set(minTs, []);
  oneSlotsByMinute.get(minTs).push(t);
}
console.log(`Unique 1s minute windows needed: ${oneSlotsByMinute.size.toLocaleString()}`);

// Build primary-by-hour for 1s gating
const primaryByHour = new Map();
for (const [k, v] of Object.entries(payload.primary_by_hour || {})) primaryByHour.set(Number(k), v);

console.log(`Streaming NQ_ohlcv_1s.csv for touch minutes ...`);
const onesPath = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1s.csv');
const secondBarsByMinute = new Map(); // minuteTs -> sorted 1s bars
{
  const minutes = Array.from(oneSlotsByMinute.keys()).sort((a, b) => a - b);
  const minTs = minutes[0], maxTs = minutes[minutes.length - 1] + 60000;
  const minIso = new Date(minTs).toISOString();
  const maxIso = new Date(maxTs).toISOString();
  const tStart = Date.now();
  let scanned = 0, kept = 0;
  const stream = fs.createReadStream(onesPath, { highWaterMark: 1 << 20 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!header) { header = line; continue; }
    scanned++;
    if (scanned % 10000000 === 0) {
      const sec = ((Date.now() - tStart) / 1000).toFixed(0);
      process.stdout.write(`  scanned ${(scanned / 1e6).toFixed(0)}M  kept ${kept.toLocaleString()}  (${sec}s)\n`);
    }
    const f0End = line.indexOf(',');
    if (f0End < 0) continue;
    const tsStr = line.slice(0, f0End);
    if (tsStr < minIso) continue;
    if (tsStr > maxIso) break;
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const symbol = parts[9];
    if (symbol.includes('-')) continue;
    const ts = new Date(tsStr).getTime();
    const minuteTs = Math.floor(ts / 60000) * 60000;
    if (!oneSlotsByMinute.has(minuteTs)) continue;
    const hourBucket = Math.floor(ts / 3600000);
    const primarySym = primaryByHour.get(hourBucket);
    if (primarySym && symbol !== primarySym) continue;
    if (!secondBarsByMinute.has(minuteTs)) secondBarsByMinute.set(minuteTs, []);
    secondBarsByMinute.get(minuteTs).push({
      ts, open: +parts[4], high: +parts[5], low: +parts[6], close: +parts[7], volume: +parts[8] || 0,
    });
    kept++;
  }
  rl.close(); stream.destroy();
  for (const arr of secondBarsByMinute.values()) arr.sort((a, b) => a.ts - b.ts);
  const sec = ((Date.now() - tStart) / 1000).toFixed(0);
  console.log(`  1s scan done: ${scanned.toLocaleString()} scanned, ${kept.toLocaleString()} kept (${sec}s)`);
}

// --- 7. Compute features per touch ---
console.log(`\nComputing features for ${touches.length.toLocaleString()} touches ...`);

let featCount = 0;
const tFeatStart = Date.now();
for (const t of touches) {
  featCount++;
  if (featCount % 5000 === 0) {
    const sec = ((Date.now() - tFeatStart) / 1000).toFixed(0);
    process.stdout.write(`  ${featCount.toLocaleString()} / ${touches.length.toLocaleString()}  (${sec}s)\n`);
  }

  const f = {};

  // --- Touch candle ---
  const tc = byTs.get(t.ts);
  if (!tc) { t.features = f; continue; }

  const level = t.level_price;
  const isLong = (t.outcomes[0].setup === 'bounce' && t.approach === 'from_above')
              || (t.outcomes[0].setup === 'break' && t.approach === 'from_below');
  // (We compute both setups separately; bounce.direction = long for from_above.)
  // For touch-candle rejection-wick we use the level-relative sides.

  // --- A. Volume features ---
  f.vol_touch_bar = tc.volume;
  // Build prior-bar arrays (skip the touch bar itself)
  const priorVols = [];
  const priorBars = [];
  for (let k = 1; k <= 30; k++) {
    const b = byTs.get(t.ts - k * 60000);
    if (b && b.symbol === tc.symbol) {
      priorVols.push(b.volume);
      priorBars.push(b);
    } else if (b == null) {
      // gap; continue
    } else {
      // different symbol — stop (avoid cross-contract contamination)
      break;
    }
  }
  priorVols.reverse(); priorBars.reverse();
  const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  f.vol_ratio_5m = priorVols.length >= 5 ? tc.volume / mean(priorVols.slice(-5)) : null;
  f.vol_ratio_15m = priorVols.length >= 15 ? tc.volume / mean(priorVols.slice(-15)) : null;
  f.vol_ratio_30m = priorVols.length >= 30 ? tc.volume / mean(priorVols.slice(-30)) : null;
  f.vol_trend_15m = priorVols.length >= 15 ? Math.sign(linregSlope(priorVols.slice(-15))) : null;

  // --- B. IV features ---
  // Snap to the nearest IV timestamp at or before touch
  let ivSnapTs = t.ts;
  // round down to minute
  ivSnapTs = Math.floor(ivSnapTs / 60000) * 60000;
  let ivRec = ivByTs.get(ivSnapTs);
  if (!ivRec) {
    // fall back to nearest at-or-before within 5 min
    for (let k = 1; k <= 5; k++) {
      ivRec = ivByTs.get(ivSnapTs - k * 60000);
      if (ivRec) break;
    }
  }
  f.qqq_iv_level = ivRec ? ivRec.iv : null;
  if (ivRec) {
    const ivAt5 = ivByTs.get(ivSnapTs - 5 * 60000);
    const ivAt15 = ivByTs.get(ivSnapTs - 15 * 60000);
    f.qqq_iv_delta_5m = ivAt5 ? ivRec.iv - ivAt5.iv : null;
    f.qqq_iv_delta_15m = ivAt15 ? ivRec.iv - ivAt15.iv : null;
  } else {
    f.qqq_iv_delta_5m = null; f.qqq_iv_delta_15m = null;
  }
  const rawIv = rawIvByTs.get(ivSnapTs) || rawIvByTs.get(ivSnapTs - 60000);
  f.qqq_iv_skew = rawIv && rawIv.put_iv != null && rawIv.call_iv != null ? rawIv.put_iv - rawIv.call_iv : null;

  // --- C. 1m candle pattern features (touch bar) ---
  const range = tc.high - tc.low;
  const body = Math.abs(tc.close - tc.open);
  const upperWick = tc.high - Math.max(tc.open, tc.close);
  const lowerWick = Math.min(tc.open, tc.close) - tc.low;

  // Rejection wick is the wick on the SIDE the price approached from
  // approach=from_above -> price came down to level -> rejection = lower wick
  // approach=from_below -> price came up to level -> rejection = upper wick
  const rejWick = t.approach === 'from_above' ? lowerWick : upperWick;
  f.touch_rej_wick_pts = rejWick;
  f.touch_body_pts = body;
  f.touch_range_pts = range;
  f.touch_body_range_ratio = range > 0 ? body / range : null;
  f.touch_close_position = range > 0 ? (tc.close - tc.low) / range : null;
  f.touch_doji = range > 0 ? (body / range < 0.1 ? 1 : 0) : null;

  // Pinbar: rejection wick >= 2× body AND wick is on the rejection side
  f.touch_pinbar = body > 0 ? (rejWick >= 2 * body ? 1 : 0) : (rejWick > 0 ? 1 : 0);

  // Engulfing: touch bar's body engulfs prior bar's body, in rejection direction
  const prev = byTs.get(t.ts - 60000);
  if (prev && prev.symbol === tc.symbol) {
    const prevBodyTop = Math.max(prev.open, prev.close);
    const prevBodyBot = Math.min(prev.open, prev.close);
    const curBodyTop = Math.max(tc.open, tc.close);
    const curBodyBot = Math.min(tc.open, tc.close);
    f.touch_engulfing = (curBodyTop >= prevBodyTop && curBodyBot <= prevBodyBot) ? 1 : 0;
  } else f.touch_engulfing = null;

  // ATR + compression
  const atr = atrByTs.get(t.ts);
  f.atr14 = atr || null;
  f.touch_atr_pct = atr && atr > 0 ? range / atr : null;
  if (priorBars.length >= 3) {
    const last3 = priorBars.slice(-3);
    const compMax = Math.max(...last3.map(b => b.high));
    const compMin = Math.min(...last3.map(b => b.low));
    f.prior_3bar_range_compression = atr && atr > 0 ? (compMax - compMin) / atr : null;
  } else f.prior_3bar_range_compression = null;

  // --- D. 1s micro-pattern features ---
  const minTs = Math.floor(t.ts / 60000) * 60000;
  const s1bars = secondBarsByMinute.get(minTs) || [];
  if (s1bars.length) {
    let minDist = Infinity, maxRejWick = 0, secsAtLevel = 0;
    let firstRejSec = null;
    let volSum = 0, pvSum = 0;
    for (const b of s1bars) {
      const dHigh = Math.abs(b.high - level);
      const dLow = Math.abs(b.low - level);
      const d = Math.min(dHigh, dLow);
      if (d < minDist) minDist = d;
      // wick on the rejection side
      const bUp = b.high - Math.max(b.open, b.close);
      const bDn = Math.min(b.open, b.close) - b.low;
      const wickRej = t.approach === 'from_above' ? bDn : bUp;
      if (wickRej > maxRejWick) maxRejWick = wickRej;
      if (Math.abs(b.close - level) <= 2) secsAtLevel++;
      // First rejection: wick beyond level + close back away
      let rejected = false;
      if (t.approach === 'from_above') {
        rejected = (b.low <= level) && (b.close >= level);
      } else {
        rejected = (b.high >= level) && (b.close <= level);
      }
      if (rejected && firstRejSec == null) firstRejSec = Math.floor((b.ts - minTs) / 1000);
      const typical = (b.high + b.low + b.close) / 3;
      pvSum += typical * b.volume;
      volSum += b.volume;
    }
    const vwap = volSum > 0 ? pvSum / volSum : null;
    f.s1_min_dist_to_level = minDist === Infinity ? null : minDist;
    f.s1_max_rej_wick_pts = maxRejWick;
    f.s1_seconds_at_level = secsAtLevel;
    f.s1_first_rejection_t_sec = firstRejSec;
    f.s1_n_bars = s1bars.length;
    // VWAP position: how far the last 1s close is from intra-minute VWAP, signed by approach
    if (vwap != null) {
      const lastClose = s1bars[s1bars.length - 1].close;
      const diff = lastClose - vwap;
      f.s1_vwap_close_diff = t.approach === 'from_above' ? diff : -diff; // positive = favorable (bounce side)
    } else f.s1_vwap_close_diff = null;
  } else {
    f.s1_min_dist_to_level = null;
    f.s1_max_rej_wick_pts = null;
    f.s1_seconds_at_level = null;
    f.s1_first_rejection_t_sec = null;
    f.s1_n_bars = 0;
    f.s1_vwap_close_diff = null;
  }

  // --- E. Structural context features (re-load snap to get all levels) ---
  const snaps = getSnapshots(t.date);
  const snap = snaps ? snapshotAtOrBefore(snaps, t.ts - (config.SNAP_LAG_MIN || 16) * 60000) : null;
  if (snap) {
    const allLevels = flattenLevels(snap);
    // Rank this level by |GEX| within the snapshot
    const sortedByMag = [...allLevels].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex));
    const myIdx = sortedByMag.findIndex(l => l.type === t.level_type && Math.abs(l.price - t.level_price) < 0.01);
    f.level_gex_rank_in_snap = myIdx >= 0 ? myIdx + 1 : null;
    f.snap_n_levels = allLevels.length;

    // Distance to next opposite/same side level (relative to trade direction).
    // For bounce: trade direction = away from approach side; "opposite" means
    // the level on the OTHER side of the trade direction; "same" means levels
    // in the trade direction.
    // To make this independent of setup, compute the structural distances:
    //   - dist to next level ABOVE current price
    //   - dist to next level BELOW current price
    const price = t.level_price;
    const above = allLevels.filter(l => l.price > price + 0.01).map(l => l.price - price);
    const below = allLevels.filter(l => l.price < price - 0.01).map(l => price - l.price);
    f.dist_to_nearest_above = above.length ? Math.min(...above) : null;
    f.dist_to_nearest_below = below.length ? Math.min(...below) : null;

    f.regime_strength = Math.abs(snap.gamma_imbalance || 0);
    f.gamma_flip_rel_spot = (snap.gamma_flip != null && snap.nq_spot != null)
      ? snap.gamma_flip - snap.nq_spot : null;
    f.total_gex_sign = snap.total_gex != null ? Math.sign(snap.total_gex) : null;
  } else {
    f.level_gex_rank_in_snap = null;
    f.snap_n_levels = null;
    f.dist_to_nearest_above = null;
    f.dist_to_nearest_below = null;
    f.regime_strength = null;
    f.gamma_flip_rel_spot = null;
    f.total_gex_sign = null;
  }

  // --- F. Time / session features ---
  const et = toET(t.ts);
  f.minutes_into_rth = et.timeInMinutes - 570;

  t.features = f;
}

const totalSec = ((Date.now() - tFeatStart) / 1000).toFixed(1);
console.log(`Feature computation done in ${totalSec}s`);

// --- 8. Write ---
const outPath = inPath.replace(/\.resolved\.json$/, '.enriched.json').replace(/\.touches\.json$/, '.enriched.json');
fs.writeFileSync(outPath, JSON.stringify(payload));
console.log(`\nWritten: ${outPath}`);
console.log(`File size: ${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB`);

// Quick sanity print: average feature values for first 100 touches with valid features
const sample = touches.slice(0, 100).filter(t => t.features && t.features.qqq_iv_level != null);
if (sample.length) {
  console.log(`\nFeature sanity (first ${sample.length} valid touches):`);
  const featKeys = Object.keys(sample[0].features);
  const summary = {};
  for (const k of featKeys) {
    const vals = sample.map(t => t.features[k]).filter(v => v != null && !isNaN(v));
    if (vals.length) {
      const m = vals.reduce((s, v) => s + v, 0) / vals.length;
      summary[k] = { n: vals.length, mean: m.toFixed(3) };
    }
  }
  console.log(JSON.stringify(summary, null, 2));
}
