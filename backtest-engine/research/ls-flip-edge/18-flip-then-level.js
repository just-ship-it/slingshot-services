/**
 * Phase H — Variant A: LS flip FIRST, then wait for level touch in bias direction.
 *
 * Pipeline:
 *   1. For each AGAINST flip (3m and 1m), define direction:
 *      new_state=0 (bearish flip): fade LONG → wait for SUPPORT touch
 *      new_state=1 (bullish flip): fade SHORT → wait for RESISTANCE touch
 *   2. Snapshot eligible levels at flip_close_ts (PDH/PDL/daily_open, GEX).
 *   3. Stream 1s bars after flip_close_ts (max wait MAX_WAIT_MIN). For each event,
 *      check each eligible level: LONG → bar.low <= support; SHORT → bar.high >= resistance.
 *      Enter at LEVEL PRICE on first touch.
 *   4. Walk forward to measure 10pt MFE vs 10pt MAE first-to-cross (max hold MAX_HOLD_MIN).
 *
 * Per event we track ONE watcher PER LEVEL TYPE so we can analyze WR per level.
 *
 * Output: one row per (event, level_type) with entry result.
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
const OUT = arg('out', path.join(__dirname, 'output', '18-flip-then-level.csv'));
const TARGET_PT = +arg('target', '10');
const STOP_PT = +arg('stop', '10');
const MAX_WAIT_MIN = +arg('max_wait', '15');
const MAX_HOLD_MIN = +arg('max_hold', '30');

const MAX_WAIT_MS = MAX_WAIT_MIN * 60_000;
const MAX_HOLD_MS = MAX_HOLD_MIN * 60_000;

const LS_1M = path.join(__dirname, '..', 'lt-extraction', 'output', 'nq_ls_1m_raw.csv');
const LS_3M = path.join(__dirname, '..', 'lt-extraction', 'output', 'nq_ls_3m_raw.csv');
const LS_15M = path.join(__dirname, '..', 'lt-extraction', 'output', 'nq_ls_15m_raw.csv');
const GEX_DIR = path.join(DATA_DIR, 'gex', 'nq-cbbo');

const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

console.log(`\n=== Phase H Variant A — LS flip → level touch → entry ===`);
console.log(`Range: ${START} → ${END}  |  Target: ${TARGET_PT}pt  Stop: ${STOP_PT}pt`);
console.log(`Max wait for touch: ${MAX_WAIT_MIN}min | Max hold: ${MAX_HOLD_MIN}min\n`);

// ---------- LS ----------
function loadLs(p) { const text = fs.readFileSync(p, 'utf-8'); const lines = text.trim().split('\n'); const out = []; for (let i = 1; i < lines.length; i++) { const parts = lines[i].split(','); if (parts.length < 4) continue; out.push({ ts: +parts[1], state: +parts[2] }); } return out; }
const ls1m = loadLs(LS_1M);
const ls3m = loadLs(LS_3M);
const ls15m = loadLs(LS_15M);
function findLeIdx(arr, q, key) { let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if ((key ? arr[m][key] : arr[m]) <= q) { a = m; lo = m + 1; } else hi = m - 1; } return a; }
function lsStateAt(rows, ts) { const i = findLeIdx(rows, ts, 'ts'); return i === -1 ? null : rows[i].state; }

function isAgainst(tf, ns, s1, s3, s15) {
  if (tf === '1m') return (ns !== s3) && (ns !== s15);
  return (ns !== s15) && (ns !== s1);
}
function buildEvents(rows, tfMin, tfLabel) {
  const tfSec = tfMin * 60;
  const events = [];
  let priorState = null;
  for (const r of rows) {
    if (priorState !== null && priorState !== r.state) {
      const s1 = lsStateAt(ls1m, r.ts);
      const s3 = lsStateAt(ls3m, r.ts);
      const s15 = lsStateAt(ls15m, r.ts);
      if (s1 == null || s3 == null || s15 == null) { priorState = r.state; continue; }
      if (isAgainst(tfLabel, r.state, s1, s3, s15)) {
        events.push({
          tf: tfLabel,
          flip_ts: r.ts,
          fill_ts: r.ts + tfSec * 1000,
          new_state: r.state,
          prior_state: priorState,
          direction: r.state === 0 ? 'long' : 'short',
          s1m: s1, s3m: s3, s15m: s15,
        });
      }
    }
    priorState = r.state;
  }
  return events;
}
const e1m = buildEvents(ls1m, 1, '1m');
const e3m = buildEvents(ls3m, 3, '3m');
const events = [...e1m, ...e3m].sort((a, b) => a.fill_ts - b.fill_ts);
events.forEach((e, i) => { e.event_id = i; });
console.log(`AGAINST events: 1m=${e1m.length} 3m=${e3m.length} total=${events.length}`);

// ---------- 1m primary OHLCV ----------
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
  for (const [h, m] of hv.entries()) { let bs = '', bv = 0; for (const [s, v] of m.entries()) if (v > bv) { bv = v; bs = s; } primaryByHour.set(h, bs); }
}
const primary1m = oneMin.filter(c => primaryByHour.get(Math.floor(c.ts / 3600000)) === c.sym).sort((a, b) => a.ts - b.ts);
const primaryTs = primary1m.map(c => c.ts);
console.log(`Primary 1m bars: ${primary1m.length}`);

// daily_high/low/open + pdh/pdl/pdo per primary bar
function etDate(ms) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const m = {}; for (const x of p) m[x.type] = x.value;
  return `${m.year}-${m.month}-${m.day}`;
}
const dailyContext = new Array(primary1m.length);
{
  let curDate = null;
  let dh = -Infinity, dl = Infinity, dop = null;
  let pdh = null, pdl = null, pdo = null;
  for (let i = 0; i < primary1m.length; i++) {
    const c = primary1m[i];
    const d = etDate(c.ts);
    if (d !== curDate) {
      if (curDate !== null) { pdh = dh; pdl = dl; pdo = dop; }
      curDate = d; dh = c.h; dl = c.l; dop = c.o;
    } else {
      if (c.h > dh) dh = c.h;
      if (c.l < dl) dl = c.l;
    }
    dailyContext[i] = { date: d, dh, dl, dop, pdh, pdl, pdo };
  }
}

// ---------- GEX snapshots ----------
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
function gexAt(ts) { const i = findLeIdx(gexSnaps, ts, 'ts'); return i === -1 ? null : gexSnaps[i]; }
console.log(`GEX snapshots: ${gexSnaps.length}`);

// ---------- Build event-level snapshot ----------
console.log('Snapshotting levels per event...');
for (const e of events) {
  const barIdx = findLeIdx(primaryTs, e.flip_ts);
  if (barIdx < 0) { e.levels = []; continue; }
  const ctx = dailyContext[barIdx];
  const bar = primary1m[barIdx];
  e.spot_at_flip = bar.c;
  const g = gexAt(e.flip_ts);
  const cur = bar.c;
  const support = [], resistance = [];
  function addSup(type, value) { if (value != null && value < cur) support.push({ type, value }); }
  function addRes(type, value) { if (value != null && value > cur) resistance.push({ type, value }); }
  addSup('pdl', ctx.pdl);
  addRes('pdh', ctx.pdh);
  if (ctx.pdo != null) { addSup('pdo', ctx.pdo); addRes('pdo', ctx.pdo); }
  if (ctx.dop != null) { addSup('do', ctx.dop); addRes('do', ctx.dop); }
  if (g) {
    addRes('call_wall', g.call_wall);
    addSup('put_wall', g.put_wall);
    if (g.gamma_flip != null) { addSup('gflip', g.gamma_flip); addRes('gflip', g.gamma_flip); }
    if (Array.isArray(g.support)) for (let k = 0; k < g.support.length && k < 5; k++) addSup(`s${k + 1}`, g.support[k]);
    if (Array.isArray(g.resistance)) for (let k = 0; k < g.resistance.length && k < 5; k++) addRes(`r${k + 1}`, g.resistance[k]);
  }
  // For LONG bias use support levels; for SHORT use resistance
  e.levels = e.direction === 'long' ? support : resistance;
}
// Stats
let totalLvl = 0; for (const e of events) totalLvl += e.levels.length;
console.log(`Avg levels per event: ${(totalLvl / events.length).toFixed(2)}`);

// ---------- Pass 2: stream 1s OHLCV, dispatch ----------
// Per event: one watcher per level
function makeWatchers(e) {
  return e.levels.map(l => ({
    level_type: l.type, level_value: l.value,
    phase: 'watch', entry_ts: null, entry_price: null,
    target: null, stop: null, outcome: null, exit_ts: null, exit_price: null, pnl: null,
    mfe: 0, mae: 0, hold_s: null,
  }));
}

const onesPath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1s.csv`);

const scanStart = events.length ? events[0].fill_ts : Date.now();
const scanEnd = (events.length ? events[events.length - 1].fill_ts : Date.now()) + MAX_WAIT_MS + MAX_HOLD_MS + 60000;
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

function tryEnter(e, w, ts, high, low, open) {
  if (e.direction === 'long') {
    if (low <= w.level_value) {
      // fill at level value (limit-ish)
      w.entry_ts = ts;
      w.entry_price = w.level_value;
      w.target = w.level_value + TARGET_PT;
      w.stop = w.level_value - STOP_PT;
      w.phase = 'exit';
      // immediately apply this bar
      updateExit(e, w, ts, high, low, open);
    }
  } else {
    if (high >= w.level_value) {
      w.entry_ts = ts;
      w.entry_price = w.level_value;
      w.target = w.level_value - TARGET_PT;
      w.stop = w.level_value + STOP_PT;
      w.phase = 'exit';
      updateExit(e, w, ts, high, low, open);
    }
  }
}
function updateExit(e, w, ts, high, low, close) {
  if (w.phase !== 'exit') return;
  if (ts - w.entry_ts > MAX_HOLD_MS) {
    w.outcome = 'timeout'; w.exit_ts = ts; w.exit_price = close;
    w.pnl = e.direction === 'long' ? close - w.entry_price : w.entry_price - close;
    w.hold_s = (ts - w.entry_ts) / 1000;
    w.phase = 'done';
    return;
  }
  if (e.direction === 'long') {
    w.mfe = Math.max(w.mfe, high - w.entry_price);
    w.mae = Math.max(w.mae, w.entry_price - low);
    const sH = low <= w.stop, tH = high >= w.target;
    if (sH && tH) { w.outcome = 'loss'; w.exit_ts = ts; w.exit_price = w.stop; w.pnl = -STOP_PT; w.hold_s = (ts - w.entry_ts) / 1000; w.phase = 'done'; }
    else if (sH) { w.outcome = 'loss'; w.exit_ts = ts; w.exit_price = w.stop; w.pnl = -STOP_PT; w.hold_s = (ts - w.entry_ts) / 1000; w.phase = 'done'; }
    else if (tH) { w.outcome = 'win'; w.exit_ts = ts; w.exit_price = w.target; w.pnl = TARGET_PT; w.hold_s = (ts - w.entry_ts) / 1000; w.phase = 'done'; }
  } else {
    w.mfe = Math.max(w.mfe, w.entry_price - low);
    w.mae = Math.max(w.mae, high - w.entry_price);
    const sH = high >= w.stop, tH = low <= w.target;
    if (sH && tH) { w.outcome = 'loss'; w.exit_ts = ts; w.exit_price = w.stop; w.pnl = -STOP_PT; w.hold_s = (ts - w.entry_ts) / 1000; w.phase = 'done'; }
    else if (sH) { w.outcome = 'loss'; w.exit_ts = ts; w.exit_price = w.stop; w.pnl = -STOP_PT; w.hold_s = (ts - w.entry_ts) / 1000; w.phase = 'done'; }
    else if (tH) { w.outcome = 'win'; w.exit_ts = ts; w.exit_price = w.target; w.pnl = TARGET_PT; w.hold_s = (ts - w.entry_ts) / 1000; w.phase = 'done'; }
  }
}

for await (const line of rl) {
  if (!header) { header = line; continue; }
  scanned++;
  if (scanned % 10_000_000 === 0) {
    const sec = ((Date.now() - tStart) / 1000).toFixed(0);
    process.stdout.write(`  scanned ${(scanned / 1e6).toFixed(0)}M live=${live.length} fin=${finalized.toLocaleString()} (${sec}s)\n`);
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
  const hb = Math.floor(ts / 3600000);
  const primary = primaryByHour.get(hb);
  if (!primary || symbol !== primary) continue;
  const open = +parts[4], high = +parts[5], low = +parts[6], close = +parts[7];
  if (isNaN(close)) continue;
  kept++;

  while (nextEventIdx < events.length && events[nextEventIdx].fill_ts <= ts) {
    const e = events[nextEventIdx];
    if (!e._activated) {
      e._activated = true;
      e._activated_ts = ts;
      e.watchers = makeWatchers(e);
      e.primary = primary;
      live.push(e);
    }
    nextEventIdx++;
  }

  for (let i = live.length - 1; i >= 0; i--) {
    const e = live[i];
    if (primary !== e.primary) {
      // rollover — finalize remaining watchers
      for (const w of e.watchers) {
        if (w.phase === 'watch') { w.phase = 'done'; w.outcome = 'no_touch_rollover'; }
        else if (w.phase === 'exit') { w.phase = 'done'; w.outcome = 'rollover'; w.exit_ts = ts; w.exit_price = close; w.pnl = e.direction === 'long' ? close - w.entry_price : w.entry_price - close; w.hold_s = (ts - w.entry_ts) / 1000; }
      }
      live.splice(i, 1); finalized++; continue;
    }
    let anyOpen = false;
    for (const w of e.watchers) {
      if (w.phase === 'watch') {
        if (ts - e.fill_ts > MAX_WAIT_MS) { w.phase = 'done'; w.outcome = 'no_touch'; }
        else { tryEnter(e, w, ts, high, low, open); }
      } else if (w.phase === 'exit') {
        updateExit(e, w, ts, high, low, close);
      }
      if (w.phase !== 'done') anyOpen = true;
    }
    if (!anyOpen) { live.splice(i, 1); finalized++; }
  }
}
rl.close(); stream.destroy();
for (const e of live) {
  for (const w of e.watchers) {
    if (w.phase === 'watch') { w.phase = 'done'; w.outcome = 'no_touch_eod'; }
    else if (w.phase === 'exit') { w.phase = 'done'; w.outcome = 'eod'; w.exit_ts = w.entry_ts; w.exit_price = w.entry_price; w.pnl = 0; w.hold_s = MAX_HOLD_MS / 1000; }
  }
  finalized++;
}
const sec = ((Date.now() - tStart) / 1000).toFixed(0);
console.log(`Done: scanned ${scanned.toLocaleString()} fin ${finalized} (${sec}s)\n`);

// ---------- Write ----------
console.log('Writing output...');
const cols = [
  'event_id', 'tf', 'flip_ts', 'fill_ts', 'direction', 'new_state', 's1m', 's3m', 's15m', 'spot_at_flip',
  'level_type', 'level_value', 'phase', 'outcome',
  'entry_ts', 'entry_price', 'target', 'stop',
  'exit_ts', 'exit_price', 'pnl', 'mfe', 'mae', 'hold_s',
];
const ws = fs.createWriteStream(outPath);
ws.write(cols.join(',') + '\n');
let written = 0;
for (const e of events) {
  if (!e._activated || !e.watchers) continue;
  for (const w of e.watchers) {
    const row = [
      e.event_id, e.tf, e.flip_ts, e.fill_ts, e.direction, e.new_state, e.s1m, e.s3m, e.s15m, e.spot_at_flip?.toFixed(4) ?? '',
      w.level_type, w.level_value?.toFixed(4) ?? '', w.phase, w.outcome ?? '',
      w.entry_ts ?? '', w.entry_price?.toFixed(4) ?? '', w.target?.toFixed(4) ?? '', w.stop?.toFixed(4) ?? '',
      w.exit_ts ?? '', w.exit_price?.toFixed(4) ?? '', w.pnl ?? '', w.mfe?.toFixed(4) ?? '', w.mae?.toFixed(4) ?? '', w.hold_s ?? '',
    ];
    ws.write(row.join(',') + '\n');
    written++;
  }
}
ws.end();
await new Promise(r => ws.on('finish', r));
const stat = fs.statSync(outPath);
console.log(`Written: ${outPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB, ${written} rows)`);

// Quick summary
const entered = [];
for (const e of events) {
  if (!e._activated || !e.watchers) continue;
  for (const w of e.watchers) {
    if (['win', 'loss', 'timeout'].includes(w.outcome)) entered.push({ tf: e.tf, dir: e.direction, level_type: w.level_type, outcome: w.outcome, pnl: w.pnl });
  }
}
const w = entered.filter(x => x.outcome === 'win').length;
const l = entered.filter(x => x.outcome === 'loss').length;
const to = entered.filter(x => x.outcome === 'timeout').length;
console.log(`\nSummary: ${entered.length} entries  wins=${w}  losses=${l}  timeouts=${to}  WR=${(w / entered.length * 100).toFixed(1)}%`);

const byLevel = new Map();
for (const e of entered) {
  if (!byLevel.has(e.level_type)) byLevel.set(e.level_type, { n: 0, w: 0, l: 0, to: 0, pnl: 0 });
  const b = byLevel.get(e.level_type);
  b.n++; if (e.outcome === 'win') b.w++; else if (e.outcome === 'loss') b.l++; else b.to++;
  b.pnl += e.pnl || 0;
}
console.log(`\nBy level type:`);
console.log(`  ${'level'.padEnd(15)} ${'n'.padStart(5)} ${'WR%'.padStart(5)} ${'sum_pts'.padStart(7)}`);
const sorted = [...byLevel.entries()].filter(([, b]) => b.n >= 20).sort((a, b) => (b[1].w / b[1].n) - (a[1].w / a[1].n));
for (const [k, b] of sorted) {
  console.log(`  ${k.padEnd(15)} ${b.n.toString().padStart(5)} ${(b.w / b.n * 100).toFixed(1).padStart(5)} ${b.pnl.toFixed(0).padStart(7)}`);
}
