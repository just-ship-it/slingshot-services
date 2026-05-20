/**
 * Phase H — Variant B: Level touch FIRST, then wait for LS flip.
 *
 * Pipeline:
 *   1. Pre-compute key levels per primary 1m bar:
 *      - PDH, PDL (previous ET day H/L)
 *      - daily_open (current ET day's first primary 1m open)
 *      - GEX: call_wall, put_wall, gamma_flip, R1-R5, S1-S5
 *        (loaded from /data/gex/nq-cbbo/ JSONs; 15-min snapshots fwd-filled)
 *   2. Detect level touches: for each primary 1m bar, check if any level
 *      is touched for the FIRST TIME today (bar.low <= support OR bar.high >= resistance).
 *      Each touch creates an event with direction (LONG @ support, SHORT @ resistance).
 *   3. For each touch event, look up next LS flip (1m or 3m, earliest) within MAX_WAIT.
 *      Stream 1s OHLCV after flip_close_ts; entry at first 1s primary bar.
 *      Walk forward to measure 10pt MFE vs 10pt MAE first-to-cross.
 *   4. Output: one row per (touch, flip match, entry) → outcome + features.
 *
 * Direction semantics:
 *   - LONG @ support touch: target = entry + 10, stop = entry - 10
 *   - SHORT @ resistance touch: target = entry - 10, stop = entry + 10
 *   - Outcome 'win' if MFE reaches 10 first; 'loss' if MAE reaches 10 first; 'timeout' otherwise.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
const START = arg('start', '2025-01-13');
const END = arg('end', '2026-05-18');
const PRODUCT = 'NQ';
const OUT = arg('out', path.join(__dirname, 'output', '16-level-then-flip.csv'));
const TARGET_PT = +arg('target', '10');
const STOP_PT = +arg('stop', '10');
const MAX_WAIT_MIN = +arg('max_wait', '15');
const MAX_HOLD_MIN = +arg('max_hold', '30');

const MAX_WAIT_MS = MAX_WAIT_MIN * 60 * 1000;
const MAX_HOLD_MS = MAX_HOLD_MIN * 60 * 1000;

const LS_1M = path.join(__dirname, '..', 'lt-extraction', 'output', 'nq_ls_1m_raw.csv');
const LS_3M = path.join(__dirname, '..', 'lt-extraction', 'output', 'nq_ls_3m_raw.csv');
const GEX_DIR = path.join(DATA_DIR, 'gex', 'nq-cbbo');

const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

console.log(`\n=== Phase H Variant B — Level touch → LS flip → entry ===`);
console.log(`Range: ${START} → ${END}  |  Target: ${TARGET_PT}pt  Stop: ${STOP_PT}pt`);
console.log(`Max wait for flip after touch: ${MAX_WAIT_MIN}min  |  Max hold after entry: ${MAX_HOLD_MIN}min\n`);

// ---------- LS flip lists ----------
function loadLs(p) {
  const text = fs.readFileSync(p, 'utf-8');
  const lines = text.trim().split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 4) continue;
    out.push({ ts: +parts[1], state: +parts[2] });
  }
  return out;
}
const ls1m = loadLs(LS_1M);
const ls3m = loadLs(LS_3M);
console.log(`LS flips: 1m=${ls1m.length}  3m=${ls3m.length}`);

// Build prior_state for each flip
function withPriorState(rows) { let prior = null; for (const r of rows) { r.prior = prior; prior = r.state; } return rows; }
withPriorState(ls1m); withPriorState(ls3m);

// Build combined timeline of flips with tf info
const allFlips = [];
for (const r of ls1m) if (r.prior !== null && r.prior !== r.state) allFlips.push({ ts: r.ts, tf: '1m', state: r.state, prior: r.prior, fill_ts: r.ts + 60_000 });
for (const r of ls3m) if (r.prior !== null && r.prior !== r.state) allFlips.push({ ts: r.ts, tf: '3m', state: r.state, prior: r.prior, fill_ts: r.ts + 180_000 });
allFlips.sort((a, b) => a.fill_ts - b.fill_ts);
console.log(`Combined flip events: ${allFlips.length}`);

// Binary search helper
function findLeIdx(arr, q, key) {
  let lo = 0, hi = arr.length - 1, a = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if ((key ? arr[m][key] : arr[m]) <= q) { a = m; lo = m + 1; } else hi = m - 1; }
  return a;
}

// LS state lookup at any ts
function lsStateAt(rows, ts) {
  const i = findLeIdx(rows, ts, 'ts');
  return i === -1 ? null : rows[i].state;
}

// ---------- Load 1m primary OHLCV ----------
async function loadRawOhlcv1m(startStr, endStr) {
  const filePath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1m.csv`);
  const startMs = new Date(startStr).getTime();
  const endMs = new Date(endStr).getTime() + 24 * 3600000;
  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return;
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < startMs || ts > endMs) return;
        candles.push({ ts, o: +row.open, h: +row.high, l: +row.low, c: +row.close, v: +row.volume || 0, sym: row.symbol });
      })
      .on('end', resolve).on('error', reject);
  });
  return candles;
}
console.log('Loading 1m OHLCV...');
const oneMin = await loadRawOhlcv1m(START, END);
const primaryByHour = new Map();
{
  const hv = new Map();
  for (const c of oneMin) {
    const h = Math.floor(c.ts / 3600000);
    if (!hv.has(h)) hv.set(h, new Map());
    const m = hv.get(h); m.set(c.sym, (m.get(c.sym) || 0) + c.v);
  }
  for (const [h, m] of hv.entries()) {
    let bs = '', bv = 0;
    for (const [s, v] of m.entries()) if (v > bv) { bv = v; bs = s; }
    primaryByHour.set(h, bs);
  }
}
const primary1m = oneMin.filter(c => primaryByHour.get(Math.floor(c.ts / 3600000)) === c.sym).sort((a, b) => a.ts - b.ts);
console.log(`Primary 1m: ${primary1m.length}`);

// ---------- Load GEX snapshots ----------
console.log('Loading GEX snapshots...');
const gexSnaps = [];
{
  const files = fs.readdirSync(GEX_DIR).filter(f => f.startsWith('nq_gex_') && f.endsWith('.json'));
  const sM = new Date(START).getTime(), eM = new Date(END).getTime() + 24 * 3600000;
  for (const f of files) {
    const dStr = f.replace('nq_gex_', '').replace('.json', '');
    const d = new Date(dStr).getTime();
    if (d < sM - 24 * 3600000 || d > eM) continue;
    const data = JSON.parse(fs.readFileSync(path.join(GEX_DIR, f), 'utf-8'));
    if (Array.isArray(data.data)) for (const s of data.data) gexSnaps.push({ ...s, ts: new Date(s.timestamp).getTime() });
  }
  gexSnaps.sort((a, b) => a.ts - b.ts);
}
console.log(`GEX snapshots: ${gexSnaps.length}`);
function gexAt(ts) {
  const i = findLeIdx(gexSnaps, ts, 'ts');
  return i === -1 ? null : gexSnaps[i];
}

// ---------- ET-date helper ----------
function etDate(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const map = {}; for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

// ---------- Pass 1 — detect first-touch events per primary 1m bar ----------
console.log('Pass 1 — detecting level touches per 1m bar...');
const touchEvents = [];
let prevDate = null;
let dailyHigh = -Infinity, dailyLow = Infinity, dailyOpen = null;
let pdh = null, pdl = null, pdo = null;
let pdh_date = null, pdl_date = null;
const touchedToday = new Set();
let curEtDate = null;

for (let i = 0; i < primary1m.length; i++) {
  const c = primary1m[i];
  const d = etDate(c.ts);
  if (d !== curEtDate) {
    // day rollover
    if (curEtDate !== null) {
      pdh = dailyHigh; pdl = dailyLow; pdo = dailyOpen;
    }
    curEtDate = d;
    dailyHigh = c.h; dailyLow = c.l; dailyOpen = c.o;
    touchedToday.clear();
  } else {
    if (c.h > dailyHigh) dailyHigh = c.h;
    if (c.l < dailyLow) dailyLow = c.l;
  }

  // Build levels list (relative to bar close c.c)
  const g = gexAt(c.ts);
  const levels = [];
  if (pdh != null) levels.push({ type: 'pdh', value: pdh, side: 'res' });
  if (pdl != null) levels.push({ type: 'pdl', value: pdl, side: 'sup' });
  if (pdo != null) levels.push({ type: 'pdo_above', value: pdo, side: 'res' });
  if (pdo != null) levels.push({ type: 'pdo_below', value: pdo, side: 'sup' });
  if (dailyOpen != null) { levels.push({ type: 'do_above', value: dailyOpen, side: 'res' }); levels.push({ type: 'do_below', value: dailyOpen, side: 'sup' }); }
  if (g) {
    if (g.call_wall != null) levels.push({ type: 'call_wall', value: g.call_wall, side: 'res' });
    if (g.put_wall != null) levels.push({ type: 'put_wall', value: g.put_wall, side: 'sup' });
    if (g.gamma_flip != null) {
      // gamma flip: support if below price, resistance if above
      levels.push({ type: 'gflip_above', value: g.gamma_flip, side: 'res' });
      levels.push({ type: 'gflip_below', value: g.gamma_flip, side: 'sup' });
    }
    if (Array.isArray(g.support)) for (let k = 0; k < g.support.length && k < 5; k++) if (g.support[k] != null) levels.push({ type: `s${k + 1}`, value: g.support[k], side: 'sup' });
    if (Array.isArray(g.resistance)) for (let k = 0; k < g.resistance.length && k < 5; k++) if (g.resistance[k] != null) levels.push({ type: `r${k + 1}`, value: g.resistance[k], side: 'res' });
  }

  for (const lev of levels) {
    const key = `${d}|${lev.type}|${lev.value.toFixed(2)}`;
    if (touchedToday.has(key)) continue;
    let touched = false;
    let touchPrice = null;
    if (lev.side === 'res') {
      // Resistance: bar high reaches level. Must be touched from BELOW.
      if (lev.value > c.o && c.h >= lev.value) { touched = true; touchPrice = lev.value; }
    } else if (lev.side === 'sup') {
      if (lev.value < c.o && c.l <= lev.value) { touched = true; touchPrice = lev.value; }
    }
    if (touched) {
      touchEvents.push({
        ts: c.ts,                  // 1m bar OPEN ts
        bar_close_ts: c.ts + 60_000,
        level_type: lev.type,
        level_value: lev.value,
        direction: lev.side === 'res' ? 'short' : 'long',
        touch_price: touchPrice,
        date: d,
        bar_high: c.h, bar_low: c.l, bar_close: c.c, bar_open: c.o,
        sym: c.sym,
      });
      touchedToday.add(key);
    }
  }
}
console.log(`Touch events: ${touchEvents.length}`);

// ---------- Pass 2 — for each touch, find next LS flip within MAX_WAIT, then 1s walk ----------
console.log('Pass 2 — pairing touches with next LS flip and exit walk...');

// For each touch event, find next flip after bar_close_ts within MAX_WAIT_MS
// Then entry anchor = flip.fill_ts (first 1s after flip bar close)
function findFirstFlipAfter(ts) {
  const idx = findLeIdx(allFlips, ts - 1, 'fill_ts');
  // we want first flip with fill_ts >= ts
  const j = idx + 1;
  if (j >= allFlips.length) return null;
  return allFlips[j];
}

const pairedEvents = [];
for (const te of touchEvents) {
  // Next flip whose fill_ts is in [bar_close_ts, bar_close_ts + MAX_WAIT_MS]
  const limit = te.bar_close_ts + MAX_WAIT_MS;
  let chosen = null;
  // linear search starting from binary-search anchor
  const idx = findLeIdx(allFlips, te.bar_close_ts - 1, 'fill_ts');
  for (let j = idx + 1; j < allFlips.length; j++) {
    if (allFlips[j].fill_ts > limit) break;
    chosen = allFlips[j];
    break;
  }
  if (!chosen) {
    pairedEvents.push({ ...te, outcome: 'no_flip_in_window' });
    continue;
  }
  pairedEvents.push({
    ...te,
    flip_ts: chosen.ts,
    flip_tf: chosen.tf,
    flip_state: chosen.state,
    flip_prior: chosen.prior,
    entry_anchor_ts: chosen.fill_ts,
    wait_ms_touch_to_flip: chosen.fill_ts - te.bar_close_ts,
  });
}
const withFlip = pairedEvents.filter(e => e.entry_anchor_ts != null);
console.log(`Touches with a flip within ${MAX_WAIT_MIN}min: ${withFlip.length} (${(withFlip.length / touchEvents.length * 100).toFixed(1)}%)`);

// Sort by entry_anchor_ts for streaming
withFlip.sort((a, b) => a.entry_anchor_ts - b.entry_anchor_ts);

// Stream 1s OHLCV. For each event, find first 1s primary bar at/after entry_anchor_ts → entry.
// Then walk forward MAX_HOLD_MS or until 10pt MFE/MAE first-to-cross.
const onesPath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1s.csv`);

const scanStart = withFlip.length ? withFlip[0].entry_anchor_ts : Date.now();
const scanEnd = (withFlip.length ? withFlip[withFlip.length - 1].entry_anchor_ts : Date.now()) + MAX_HOLD_MS + 60000;
const minIso = new Date(scanStart).toISOString();
const maxIso = new Date(scanEnd).toISOString();

console.log(`Streaming 1s OHLCV (${minIso} → ${maxIso})...`);
const stream = fs.createReadStream(onesPath, { highWaterMark: 1 << 20 });
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
let header = null, scanned = 0, kept = 0;
let nextEventIdx = 0;
const live = [];
let finalized = 0;
const tStart = Date.now();

function initEvent(e, ts, open, primary) {
  e.primary_sym = primary;
  e.actual_entry_ts = ts;
  e.entry_price = open;
  e.maxH = open; e.minL = open;
  if (e.direction === 'long') {
    e.target_price = open + TARGET_PT;
    e.stop_price = open - STOP_PT;
  } else {
    e.target_price = open - TARGET_PT;
    e.stop_price = open + STOP_PT;
  }
  e.outcome = null; e.exit_ts = null; e.exit_price = null; e.pnl_pts = null; e.mfe_pts = 0; e.mae_pts = 0;
  e.hold_s = null;
}

function updateExit(e, ts, high, low, close) {
  if (ts - e.actual_entry_ts > MAX_HOLD_MS) {
    e.outcome = 'timeout'; e.exit_ts = ts; e.exit_price = close;
    e.pnl_pts = e.direction === 'long' ? close - e.entry_price : e.entry_price - close;
    return true;
  }
  if (high > e.maxH) e.maxH = high;
  if (low < e.minL) e.minL = low;
  if (e.direction === 'long') {
    e.mfe_pts = e.maxH - e.entry_price;
    e.mae_pts = e.entry_price - e.minL;
    const stopHit = low <= e.stop_price;
    const targetHit = high >= e.target_price;
    if (stopHit && targetHit) { e.outcome = 'loss'; e.exit_ts = ts; e.exit_price = e.stop_price; e.pnl_pts = -STOP_PT; return true; }
    if (stopHit) { e.outcome = 'loss'; e.exit_ts = ts; e.exit_price = e.stop_price; e.pnl_pts = -STOP_PT; return true; }
    if (targetHit) { e.outcome = 'win'; e.exit_ts = ts; e.exit_price = e.target_price; e.pnl_pts = TARGET_PT; return true; }
  } else {
    e.mfe_pts = e.entry_price - e.minL;
    e.mae_pts = e.maxH - e.entry_price;
    const stopHit = high >= e.stop_price;
    const targetHit = low <= e.target_price;
    if (stopHit && targetHit) { e.outcome = 'loss'; e.exit_ts = ts; e.exit_price = e.stop_price; e.pnl_pts = -STOP_PT; return true; }
    if (stopHit) { e.outcome = 'loss'; e.exit_ts = ts; e.exit_price = e.stop_price; e.pnl_pts = -STOP_PT; return true; }
    if (targetHit) { e.outcome = 'win'; e.exit_ts = ts; e.exit_price = e.target_price; e.pnl_pts = TARGET_PT; return true; }
  }
  return false;
}

for await (const line of rl) {
  if (!header) { header = line; continue; }
  scanned++;
  if (scanned % 10_000_000 === 0) {
    const sec = ((Date.now() - tStart) / 1000).toFixed(0);
    process.stdout.write(`  scanned ${(scanned / 1e6).toFixed(0)}M  kept ${kept.toLocaleString()}  live=${live.length}  fin=${finalized.toLocaleString()}  (${sec}s)\n`);
  }
  const c0 = line.indexOf(',');
  if (c0 < 0) continue;
  const tsStr = line.slice(0, c0);
  if (tsStr < minIso) continue;
  if (tsStr > maxIso) break;
  const parts = line.split(',');
  if (parts.length < 10) continue;
  const symbol = parts[9];
  if (symbol.includes('-')) continue;
  const ts = new Date(tsStr).getTime();
  const hourBucket = Math.floor(ts / 3600000);
  const primary = primaryByHour.get(hourBucket);
  if (!primary || symbol !== primary) continue;
  const open = +parts[4], high = +parts[5], low = +parts[6], close = +parts[7];
  if (isNaN(close)) continue;
  kept++;

  // Activate events with entry_anchor_ts <= ts and not yet activated
  while (nextEventIdx < withFlip.length && withFlip[nextEventIdx].entry_anchor_ts <= ts) {
    const e = withFlip[nextEventIdx];
    if (!e._activated) { e._activated = true; live.push(e); }
    nextEventIdx++;
  }
  // For active events not yet entered, fire entry on this bar (first primary 1s >= anchor)
  for (let i = live.length - 1; i >= 0; i--) {
    const e = live[i];
    if (e.entry_price == null) {
      // entry at this 1s bar's OPEN
      initEvent(e, ts, open, primary);
      // apply this bar's range
      const done = updateExit(e, ts, high, low, close);
      if (done) { e.hold_s = (e.exit_ts - e.actual_entry_ts) / 1000; live.splice(i, 1); finalized++; }
      continue;
    }
    // exit walk
    if (primary !== e.primary_sym) {
      // rollover — mark timeout
      e.outcome = 'rollover'; e.exit_ts = ts; e.exit_price = close;
      e.pnl_pts = e.direction === 'long' ? close - e.entry_price : e.entry_price - close;
      e.hold_s = (e.exit_ts - e.actual_entry_ts) / 1000;
      live.splice(i, 1); finalized++; continue;
    }
    const done = updateExit(e, ts, high, low, close);
    if (done) { e.hold_s = (e.exit_ts - e.actual_entry_ts) / 1000; live.splice(i, 1); finalized++; }
  }
}
rl.close(); stream.destroy();
for (const e of live) {
  if (e.entry_price == null) { e.outcome = 'no_entry_eod'; }
  else if (!e.outcome) {
    e.outcome = 'eod'; e.exit_ts = e.actual_entry_ts + MAX_HOLD_MS; e.exit_price = e.entry_price;
    e.pnl_pts = 0; e.hold_s = MAX_HOLD_MS / 1000;
  }
  finalized++;
}
const sec = ((Date.now() - tStart) / 1000).toFixed(0);
console.log(`Done: scanned ${scanned.toLocaleString()} kept ${kept.toLocaleString()} fin ${finalized.toLocaleString()} (${sec}s)\n`);

// ---------- Write ----------
console.log('Writing output...');
const cols = [
  'date', 'ts', 'level_type', 'level_value', 'direction',
  'touch_price', 'bar_close', 'bar_open',
  'flip_ts', 'flip_tf', 'flip_state', 'flip_prior',
  'entry_anchor_ts', 'actual_entry_ts', 'entry_price',
  'wait_ms_touch_to_flip',
  'outcome', 'exit_ts', 'exit_price', 'pnl_pts', 'mfe_pts', 'mae_pts', 'hold_s',
];
const ws = fs.createWriteStream(outPath);
ws.write(cols.join(',') + '\n');
let writtenN = 0;
for (const e of pairedEvents) {
  const row = cols.map(k => {
    const v = e[k];
    if (v == null) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? v : v.toFixed(4);
    return v;
  });
  ws.write(row.join(',') + '\n');
  writtenN++;
}
ws.end();
await new Promise(r => ws.on('finish', r));
const stat = fs.statSync(outPath);
console.log(`Written: ${outPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB, ${writtenN} rows)\n`);

// Quick summary
const entered = pairedEvents.filter(e => e.outcome === 'win' || e.outcome === 'loss' || e.outcome === 'timeout');
const wins = entered.filter(e => e.outcome === 'win').length;
const losses = entered.filter(e => e.outcome === 'loss').length;
const timeouts = entered.filter(e => e.outcome === 'timeout').length;
const wr = entered.length ? (wins / entered.length * 100) : 0;
console.log(`Summary: ${entered.length} entries, ${wins} wins, ${losses} losses, ${timeouts} timeouts. WR=${wr.toFixed(1)}%`);

// By level type
const byLevel = new Map();
for (const e of entered) {
  if (!byLevel.has(e.level_type)) byLevel.set(e.level_type, { n: 0, w: 0, l: 0, to: 0, pnl: 0 });
  const b = byLevel.get(e.level_type);
  b.n++; if (e.outcome === 'win') b.w++; else if (e.outcome === 'loss') b.l++; else b.to++;
  b.pnl += e.pnl_pts || 0;
}
console.log(`\nBy level type:`);
console.log(`  ${'level'.padEnd(15)} ${'n'.padStart(4)} ${'WR'.padStart(5)} ${'PF'.padStart(5)} ${'sum_pts'.padStart(7)}`);
const sorted = [...byLevel.entries()].sort((a, b) => (b[1].w / b[1].n) - (a[1].w / a[1].n));
for (const [k, b] of sorted) {
  const wr = b.w / b.n * 100;
  const pf = b.l > 0 ? (b.w * TARGET_PT) / (b.l * STOP_PT) : (b.w > 0 ? Infinity : 0);
  console.log(`  ${k.padEnd(15)} ${b.n.toString().padStart(4)} ${wr.toFixed(1).padStart(5)} ${(isFinite(pf) ? pf.toFixed(2) : '∞').padStart(5)} ${b.pnl.toFixed(0).padStart(7)}`);
}
