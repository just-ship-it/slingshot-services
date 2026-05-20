/**
 * Phase B — Feature snapshot at flip instant.
 *
 * For every LS flip in 1m + 3m, compute features at the moment of the flip:
 *   - Multi-TF LS alignment (3m + 15m state at flip_ts)
 *   - GEX context: regime, gamma_imbalance, multiplier, distances to walls/levels
 *   - Time-of-day: ET hour bucket, session, day-of-week, minutes_into_rth
 *   - Flip dynamics: prior_state_duration_min, flips_prev_30m, flips_prev_60m
 *   - IV regime: QQQ ATM IV (1m), 15m IV change, 0-DTE avg/skew
 *   - Price action: 1m candle body/wick/direction, 5/15/30m momentum, ATR(20)
 *
 * Key: (tf, flip_ts_ms). Phase C joins with Phase A outputs.
 *
 * Usage:
 *   node research/ls-flip-edge/02-enrich-features.js \
 *     --start 2025-01-13 --end 2026-05-18 \
 *     --out research/ls-flip-edge/output/02-features.csv
 */

import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');
const RESEARCH_DIR = __dirname;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}
const START = arg('start', '2025-01-13');
const END = arg('end', '2026-05-18');
const OUT = arg('out', path.join(RESEARCH_DIR, 'output', '02-features.csv'));
const PRODUCT = arg('product', 'NQ').toUpperCase();

const LS_1M = path.join(RESEARCH_DIR, '..', 'lt-extraction', 'output', 'nq_ls_1m_raw.csv');
const LS_3M = path.join(RESEARCH_DIR, '..', 'lt-extraction', 'output', 'nq_ls_3m_raw.csv');
const LS_15M = path.join(RESEARCH_DIR, '..', 'lt-extraction', 'output', 'nq_ls_15m_raw.csv');
const IV_1M = path.join(DATA_DIR, 'iv', 'qqq', 'qqq_atm_iv_1m.csv');
const IV_SDTE_15M = path.join(DATA_DIR, 'iv', 'qqq', 'qqq_short_dte_iv_15m.csv');
const GEX_DIR = path.join(DATA_DIR, 'gex', 'nq-cbbo');

const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

console.log(`\n=== Phase B — Feature enrichment at flip instant ===`);
console.log(`Range: ${START} → ${END}`);
console.log(`Out: ${outPath}\n`);

// ---------- helpers ----------
function loadLs(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.trim().split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 4) continue;
    out.push({ ts: +p[1], state: +p[2] });
  }
  return out;
}

/** Build a step-function state series keyed by ts. Returns object with sorted ts[] and state[]. */
function lsStateIndex(rows) {
  const ts = rows.map(r => r.ts);
  const state = rows.map(r => r.state);
  return { ts, state };
}

/** Binary search: find idx of largest ts <= queryTs in arr. Returns -1 if none. */
function findLeIdx(arr, queryTs) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= queryTs) { ans = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return ans;
}

function stateAt(idxObj, queryTs) {
  const i = findLeIdx(idxObj.ts, queryTs);
  return i === -1 ? null : idxObj.state[i];
}

// ---------- load LS series ----------
console.log(`Loading LS ...`);
const ls1mRaw = loadLs(LS_1M);
const ls3mRaw = loadLs(LS_3M);
const ls15mRaw = loadLs(LS_15M);
const idx1m = lsStateIndex(ls1mRaw);
const idx3m = lsStateIndex(ls3mRaw);
const idx15m = lsStateIndex(ls15mRaw);
console.log(`  1m=${ls1mRaw.length}  3m=${ls3mRaw.length}  15m=${ls15mRaw.length}`);

// ---------- load 1m OHLCV (primary contract) ----------
async function loadRawOhlcv1m(startStr, endStr) {
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
        candles.push({
          ts,
          o: +row.open, h: +row.high, l: +row.low, c: +row.close,
          v: +row.volume || 0,
          sym: row.symbol,
        });
      })
      .on('end', resolve).on('error', reject);
  });
  return candles;
}
function buildPrimaryByHour(candles) {
  const hourVol = new Map();
  for (const c of candles) {
    const h = Math.floor(c.ts / 3600000);
    if (!hourVol.has(h)) hourVol.set(h, new Map());
    const m = hourVol.get(h);
    m.set(c.sym, (m.get(c.sym) || 0) + c.v);
  }
  const primary = new Map();
  for (const [h, m] of hourVol.entries()) {
    let bestSym = '', bestVol = 0;
    for (const [s, v] of m.entries()) if (v > bestVol) { bestVol = v; bestSym = s; }
    primary.set(h, bestSym);
  }
  return primary;
}

console.log(`Loading 1m OHLCV ...`);
const oneMin = await loadRawOhlcv1m(START, END);
const primaryByHour = buildPrimaryByHour(oneMin);
// Filter to primary-contract bars only and index by ts
const primary1m = oneMin.filter(c => {
  const h = Math.floor(c.ts / 3600000);
  return primaryByHour.get(h) === c.sym;
}).sort((a, b) => a.ts - b.ts);
const primaryTs = primary1m.map(c => c.ts);
console.log(`  primary 1m bars: ${primary1m.length.toLocaleString()}`);

// Compute ATR(20) per primary bar (rolling, on primary series)
const atr20 = new Array(primary1m.length).fill(null);
{
  const trs = [];
  for (let i = 0; i < primary1m.length; i++) {
    const c = primary1m[i];
    let tr;
    if (i === 0) tr = c.h - c.l;
    else {
      const prev = primary1m[i - 1];
      tr = Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
    }
    trs.push(tr);
    if (trs.length > 20) trs.shift();
    if (trs.length === 20) {
      const sum = trs.reduce((a, b) => a + b, 0);
      atr20[i] = sum / 20;
    }
  }
}

// ---------- load GEX (per-day JSONs) ----------
function loadGex(startStr, endStr) {
  const start = new Date(startStr); const end = new Date(endStr);
  const files = fs.readdirSync(GEX_DIR).filter(f => f.startsWith('nq_gex_') && f.endsWith('.json'));
  const snapshots = [];
  for (const f of files) {
    const dateStr = f.replace('nq_gex_', '').replace('.json', '');
    const d = new Date(dateStr);
    if (d < start || d > end) continue;
    const data = JSON.parse(fs.readFileSync(path.join(GEX_DIR, f), 'utf-8'));
    if (Array.isArray(data.data)) {
      for (const snap of data.data) {
        snapshots.push({ ...snap, ts: new Date(snap.timestamp).getTime() });
      }
    }
  }
  snapshots.sort((a, b) => a.ts - b.ts);
  return snapshots;
}
console.log(`Loading GEX snapshots ...`);
const gexSnaps = loadGex(START, END);
const gexTs = gexSnaps.map(s => s.ts);
console.log(`  GEX snapshots: ${gexSnaps.length.toLocaleString()}`);

// ---------- load IV ----------
function loadCsvAsRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < header.length) continue;
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = p[j];
    row.ts = new Date(row.timestamp).getTime();
    out.push(row);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}
console.log(`Loading IV ...`);
const iv1m = loadCsvAsRows(IV_1M);
const ivSdte = loadCsvAsRows(IV_SDTE_15M);
const iv1mTs = iv1m.map(r => r.ts);
const ivSdteTs = ivSdte.map(r => r.ts);
console.log(`  QQQ ATM 1m: ${iv1m.length.toLocaleString()}  |  Short-DTE 15m: ${ivSdte.length.toLocaleString()}`);

// ---------- helpers: time-of-day ----------
function getEtParts(ms) {
  // ET handling — leverage Intl
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    hour: parseInt(map.hour, 10) % 24,
    minute: parseInt(map.minute, 10),
    weekday: map.weekday,
    iso: `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`,
  };
}
function sessionOf(hourEt, minuteEt) {
  const t = hourEt * 60 + minuteEt;
  if (t < 4 * 60) return 'overnight'; // < 04:00
  if (t < 9 * 60 + 30) return 'premarket'; // 04:00-09:30
  if (t < 11 * 60) return 'open'; // 09:30-11:00
  if (t < 14 * 60) return 'mid'; // 11:00-14:00
  if (t < 16 * 60) return 'close'; // 14:00-16:00
  return 'afterhours';
}
function minutesIntoRth(hourEt, minuteEt) {
  const t = hourEt * 60 + minuteEt;
  const open = 9 * 60 + 30;
  return t - open;
}

// ---------- build flip-rate index for prev-N-min counts ----------
function flipsInWindow(idxObj, queryTs, windowMs) {
  // Count flips with ts in (queryTs - windowMs, queryTs)
  const lo = findLeIdx(idxObj.ts, queryTs - windowMs - 1);
  const hi = findLeIdx(idxObj.ts, queryTs - 1);
  return Math.max(0, hi - lo);
}

// ---------- enrich each event ----------
function buildEvents(lsRows, tfMin, tfLabel, rangeStart, rangeEnd) {
  const tfSec = tfMin * 60;
  const events = [];
  let priorTs = null, priorState = null;
  for (const r of lsRows) {
    if (priorState !== null && r.ts >= rangeStart && r.ts <= rangeEnd) {
      events.push({
        tf: tfLabel,
        flip_ts: r.ts,
        fill_ts: r.ts + tfSec * 1000,
        new_state: r.state,
        prior_state: priorState,
        prior_state_duration_min: (r.ts - priorTs) / 60000,
      });
    }
    priorTs = r.ts;
    priorState = r.state;
  }
  return events;
}

const rangeStart = new Date(START).getTime();
const rangeEnd = new Date(END).getTime() + 24 * 3600000;
const events1m = buildEvents(ls1mRaw, 1, '1m', rangeStart, rangeEnd);
const events3m = buildEvents(ls3mRaw, 3, '3m', rangeStart, rangeEnd);
const events = [...events1m, ...events3m];
console.log(`\nEnriching ${events.length.toLocaleString()} events ...`);

const rows = [];
for (const e of events) {
  // --- LS alignment ---
  const sOwn = e.new_state;
  // For 1m event: also snapshot 3m and 15m
  // For 3m event: snapshot 1m and 15m
  const s1m = stateAt(idx1m, e.flip_ts);
  const s3m = stateAt(idx3m, e.flip_ts);
  const s15m = stateAt(idx15m, e.flip_ts);

  // alignment_bits: bit0=1m, bit1=3m, bit2=15m  (1 = bullish, 0 = bearish)
  const alignBits = (s1m === 1 ? 1 : 0) | ((s3m === 1 ? 1 : 0) << 1) | ((s15m === 1 ? 1 : 0) << 2);
  const allAgree = (s1m === s3m && s3m === s15m);
  const otherTfsAgreeWithFlip = (e.tf === '1m')
    ? (s3m === sOwn && s15m === sOwn)
    : (s1m === sOwn && s15m === sOwn);

  // --- flip dynamics ---
  const flipsPrev30m = flipsInWindow(e.tf === '1m' ? idx1m : idx3m, e.flip_ts, 30 * 60 * 1000);
  const flipsPrev60m = flipsInWindow(e.tf === '1m' ? idx1m : idx3m, e.flip_ts, 60 * 60 * 1000);

  // --- time-of-day ---
  const et = getEtParts(e.flip_ts);
  const session = sessionOf(et.hour, et.minute);
  const minsIntoRth = minutesIntoRth(et.hour, et.minute);

  // --- 1m bar features at flip ---
  // Find the 1m primary bar that contains flip_ts
  const barIdx = findLeIdx(primaryTs, e.flip_ts);
  let candle_body = null, candle_wick_up = null, candle_wick_dn = null, candle_dir = null;
  let mom_5m = null, mom_15m = null, mom_30m = null;
  let atr20pts = null, spotAtFlip = null;
  if (barIdx >= 0 && barIdx < primary1m.length) {
    const c = primary1m[barIdx];
    candle_body = Math.abs(c.c - c.o);
    candle_wick_up = c.h - Math.max(c.o, c.c);
    candle_wick_dn = Math.min(c.o, c.c) - c.l;
    candle_dir = c.c > c.o ? 1 : (c.c < c.o ? -1 : 0);
    spotAtFlip = c.c;
    atr20pts = atr20[barIdx];
    if (barIdx >= 5) mom_5m = c.c - primary1m[barIdx - 5].c;
    if (barIdx >= 15) mom_15m = c.c - primary1m[barIdx - 15].c;
    if (barIdx >= 30) mom_30m = c.c - primary1m[barIdx - 30].c;
  }

  // --- GEX context (most recent snapshot at/before flip_ts) ---
  let gex_regime = null, gex_multiplier = null, gex_gi = null, gex_total = null;
  let dist_cw = null, dist_pw = null, dist_gflip = null;
  let nearest_r_idx = null, nearest_r_dist = null;
  let nearest_s_idx = null, nearest_s_dist = null;
  let gex_age_min = null;
  const gIdx = findLeIdx(gexTs, e.flip_ts);
  if (gIdx >= 0 && spotAtFlip != null) {
    const g = gexSnaps[gIdx];
    gex_age_min = (e.flip_ts - g.ts) / 60000;
    gex_regime = g.regime;
    gex_multiplier = g.multiplier;
    gex_gi = g.gamma_imbalance;
    gex_total = g.total_gex;
    if (g.call_wall != null) dist_cw = spotAtFlip - g.call_wall; // signed: positive = price above CW
    if (g.put_wall != null) dist_pw = spotAtFlip - g.put_wall;
    if (g.gamma_flip != null) dist_gflip = spotAtFlip - g.gamma_flip;
    if (Array.isArray(g.resistance)) {
      let best = null, bestI = -1;
      for (let i = 0; i < g.resistance.length; i++) {
        const r = g.resistance[i];
        if (r == null) continue;
        const d = r - spotAtFlip; // signed; nearest R should be above
        if (d >= 0 && (best == null || d < best)) { best = d; bestI = i + 1; }
      }
      nearest_r_idx = bestI > 0 ? bestI : null;
      nearest_r_dist = best;
    }
    if (Array.isArray(g.support)) {
      let best = null, bestI = -1;
      for (let i = 0; i < g.support.length; i++) {
        const s = g.support[i];
        if (s == null) continue;
        const d = spotAtFlip - s;
        if (d >= 0 && (best == null || d < best)) { best = d; bestI = i + 1; }
      }
      nearest_s_idx = bestI > 0 ? bestI : null;
      nearest_s_dist = best;
    }
  }

  // --- IV ---
  let qqq_iv = null, qqq_iv_chg_15m = null, dte0_avg = null, dte0_skew = null;
  const ivIdx = findLeIdx(iv1mTs, e.flip_ts);
  if (ivIdx >= 0) {
    const r = iv1m[ivIdx];
    qqq_iv = +r.iv;
    if (ivIdx >= 15) {
      const r15 = iv1m[ivIdx - 15];
      qqq_iv_chg_15m = qqq_iv - (+r15.iv);
    }
  }
  const ivSIdx = findLeIdx(ivSdteTs, e.flip_ts);
  if (ivSIdx >= 0) {
    const r = ivSdte[ivSIdx];
    if (r.dte0_avg_iv) dte0_avg = +r.dte0_avg_iv;
    if (r.dte0_skew) dte0_skew = +r.dte0_skew;
  }

  rows.push({
    tf: e.tf,
    flip_ts_ms: e.flip_ts,
    flip_ts_iso: new Date(e.flip_ts).toISOString(),
    new_state: e.new_state,
    prior_state: e.prior_state,
    prior_state_duration_min: e.prior_state_duration_min,
    s1m_at_flip: s1m, s3m_at_flip: s3m, s15m_at_flip: s15m,
    align_bits: alignBits,
    all_tfs_agree: allAgree ? 1 : 0,
    other_tfs_agree_with_flip: otherTfsAgreeWithFlip ? 1 : 0,
    flips_prev_30m: flipsPrev30m,
    flips_prev_60m: flipsPrev60m,
    hour_et: et.hour,
    minute_et: et.minute,
    session,
    weekday: et.weekday,
    minutes_into_rth: minsIntoRth,
    spot_at_flip: spotAtFlip,
    candle_body, candle_wick_up, candle_wick_dn, candle_dir,
    mom_5m, mom_15m, mom_30m,
    atr_20: atr20pts,
    gex_regime, gex_multiplier, gex_gi, gex_total,
    gex_age_min,
    dist_cw, dist_pw, dist_gflip,
    nearest_r_idx, nearest_r_dist, nearest_s_idx, nearest_s_dist,
    qqq_iv, qqq_iv_chg_15m, dte0_avg, dte0_skew,
  });
}
console.log(`  enriched: ${rows.length.toLocaleString()}\n`);

// ---------- write ----------
const cols = [
  'tf', 'flip_ts_ms', 'flip_ts_iso', 'new_state', 'prior_state', 'prior_state_duration_min',
  's1m_at_flip', 's3m_at_flip', 's15m_at_flip', 'align_bits', 'all_tfs_agree', 'other_tfs_agree_with_flip',
  'flips_prev_30m', 'flips_prev_60m',
  'hour_et', 'minute_et', 'session', 'weekday', 'minutes_into_rth',
  'spot_at_flip', 'candle_body', 'candle_wick_up', 'candle_wick_dn', 'candle_dir',
  'mom_5m', 'mom_15m', 'mom_30m', 'atr_20',
  'gex_regime', 'gex_multiplier', 'gex_gi', 'gex_total', 'gex_age_min',
  'dist_cw', 'dist_pw', 'dist_gflip',
  'nearest_r_idx', 'nearest_r_dist', 'nearest_s_idx', 'nearest_s_dist',
  'qqq_iv', 'qqq_iv_chg_15m', 'dte0_avg', 'dte0_skew',
];

const ws = fs.createWriteStream(outPath);
ws.write(cols.join(',') + '\n');
for (const r of rows) {
  const out = cols.map(c => {
    const v = r[c];
    if (v == null) return '';
    if (typeof v === 'number') return isFinite(v) ? (Number.isInteger(v) ? v : v.toFixed(6)) : '';
    return v;
  });
  ws.write(out.join(',') + '\n');
}
ws.end();
await new Promise(r => ws.on('finish', r));
const stat = fs.statSync(outPath);
console.log(`Written: ${outPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB, ${rows.length.toLocaleString()} rows)\n`);
