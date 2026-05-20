/**
 * Phase A — Forward-return event study on LS flips (1m + 3m).
 *
 * For each LS flip:
 *   - Compute fill_ts = ls_timestamp + tf_seconds (next 1s bar after flip bar close,
 *     because TV reports bar OPEN time and dumper emits on barstate.isconfirmed).
 *   - Entry price = open of first 1s primary-contract bar with ts >= fill_ts.
 *   - Walk forward to MAX_HORIZON_MIN of 1s bars (primary contract only).
 *   - Record per-event MFE / MAE / close-PnL at each horizon checkpoint for both
 *     FADE and MOMENTUM directions. (LS is contrarian per prior research; we
 *     measure both so this study stands on its own.)
 *   - Record first-hit outcome (TARGET / STOP / TIMEOUT) for a stop x target grid.
 *
 * Direction semantics:
 *   new_state = 0 (just flipped to bearish): FADE = LONG, MOMENTUM = SHORT
 *   new_state = 1 (just flipped to bullish): FADE = SHORT, MOMENTUM = LONG
 *
 * Rollover handling: if primary contract changes during walk, force-end the walk
 * at the last bar of the original contract (treated as TIMEOUT at that moment).
 *
 * Output: one row per (flip, direction) — long-format for easier filter scans.
 *
 * Usage:
 *   node research/ls-flip-edge/01-event-study.js \
 *     --start 2025-01-13 --end 2026-05-18 \
 *     --out research/ls-flip-edge/output/01-events.csv
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
const RESEARCH_DIR = __dirname;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const START = arg('start', '2025-01-13');
const END = arg('end', '2026-05-18');
const OUT = arg('out', path.join(RESEARCH_DIR, 'output', '01-events.csv'));
const PRODUCT = arg('product', 'NQ').toUpperCase();
const LS_1M = path.join(RESEARCH_DIR, '..', 'lt-extraction', 'output', 'nq_ls_1m_raw.csv');
const LS_3M = path.join(RESEARCH_DIR, '..', 'lt-extraction', 'output', 'nq_ls_3m_raw.csv');

// Stop/target grid (pts). Chosen to span scalp-friendly tight setups and
// wider swing-style holds; widen later if a surface peak appears at edges.
const STOP_PTS = [8, 15, 25, 40];
const TARGET_PTS = [15, 30, 60, 120];
const HORIZONS_MIN = [3, 10, 30, 60];
const MAX_HORIZON_MIN = Math.max(...HORIZONS_MIN);
const MAX_HORIZON_MS = MAX_HORIZON_MIN * 60 * 1000;

const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

console.log(`\n=== Phase A — LS flip forward-return event study ===`);
console.log(`Range: ${START} → ${END}`);
console.log(`Grid: stops=${STOP_PTS} targets=${TARGET_PTS} horizons=${HORIZONS_MIN}min  (max ${MAX_HORIZON_MIN}min)`);
console.log(`Out: ${outPath}\n`);

// ---------- 1. Load 1m OHLCV → primary-contract-by-hour map ----------
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
        candles.push({ ts, vol: +row.volume || 0, sym: row.symbol });
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
    m.set(c.sym, (m.get(c.sym) || 0) + c.vol);
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
console.log(`  ${oneMin.length.toLocaleString()} 1m rows`);
const primaryByHour = buildPrimaryByHour(oneMin);
console.log(`  primary-by-hour: ${primaryByHour.size.toLocaleString()} hours\n`);

// ---------- 2. Load LS flips, build event list ----------
function loadLs(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.trim().split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 4) continue;
    out.push({
      ts: +p[1],
      state: +p[2],
    });
  }
  return out;
}

function buildEvents(lsRows, tfMin, tfLabel, rangeStart, rangeEnd) {
  const tfSec = tfMin * 60;
  const events = [];
  let priorTs = null, priorState = null;
  for (const r of lsRows) {
    const fill_ts = r.ts + tfSec * 1000;
    if (priorState !== null && fill_ts >= rangeStart && fill_ts <= rangeEnd) {
      events.push({
        tf: tfLabel,
        flip_ts: r.ts,
        fill_ts,
        new_state: r.state,
        prior_state: priorState,
        prior_state_duration_min: priorTs == null ? null : (r.ts - priorTs) / 60000,
      });
    }
    priorTs = r.ts;
    priorState = r.state;
  }
  return events;
}

console.log(`Loading LS flips ...`);
const ls1m = loadLs(LS_1M);
const ls3m = loadLs(LS_3M);
console.log(`  1m: ${ls1m.length.toLocaleString()} rows  |  3m: ${ls3m.length.toLocaleString()} rows`);

const rangeStart = new Date(START).getTime();
const rangeEnd = new Date(END).getTime() + 24 * 3600000;
const events1m = buildEvents(ls1m, 1, '1m', rangeStart, rangeEnd);
const events3m = buildEvents(ls3m, 3, '3m', rangeStart, rangeEnd);
const events = [...events1m, ...events3m].sort((a, b) => a.fill_ts - b.fill_ts);
console.log(`  events in range: 1m=${events1m.length.toLocaleString()}  3m=${events3m.length.toLocaleString()}  total=${events.length.toLocaleString()}\n`);

// Assign a stable event_id
events.forEach((e, i) => { e.event_id = i; });

// ---------- 3. Stream 1s OHLCV, dispatch to active events ----------
function makeWatcher() {
  // Status per (stop, target) cell: { outcome: null|'target'|'stop'|'timeout'|'rollover',
  //                                   exit_ts: number|null, exit_pnl: number|null }
  const cells = [];
  for (const s of STOP_PTS) for (const t of TARGET_PTS) {
    cells.push({ s, t, outcome: null, exit_ts: null, exit_pnl: null });
  }
  // Horizon snapshots: { mfe, mae, close_pnl } per horizon
  const horizons = HORIZONS_MIN.map(h => ({ h, mfe: 0, mae: 0, close_pnl: null, captured: false }));
  return { cells, horizons };
}

function initEvent(e, openPrice, bar_ts, primarySym) {
  e.entry_price = openPrice;
  e.actual_fill_ts = bar_ts;
  e.entry_primary_sym = primarySym;
  e.maxH = openPrice;
  e.minL = openPrice;
  e.last_close = openPrice;
  e.last_ts = bar_ts;
  // Two watchers: depends on new_state which way is fade vs momentum.
  // LONG watcher and SHORT watcher; we'll label them in output.
  e.longW = makeWatcher();
  e.shortW = makeWatcher();
}

function updateWatcher(w, dir, entry, high, low, close, ts) {
  // dir: 'long' | 'short'
  // First-hit cell evaluation:
  for (const c of w.cells) {
    if (c.outcome) continue;
    const stopHit = dir === 'long' ? (low <= entry - c.s) : (high >= entry + c.s);
    const targetHit = dir === 'long' ? (high >= entry + c.t) : (low <= entry - c.t);
    if (stopHit && targetHit) {
      // Conservative: stop wins
      c.outcome = 'stop'; c.exit_ts = ts; c.exit_pnl = -c.s;
    } else if (stopHit) {
      c.outcome = 'stop'; c.exit_ts = ts; c.exit_pnl = -c.s;
    } else if (targetHit) {
      c.outcome = 'target'; c.exit_ts = ts; c.exit_pnl = c.t;
    }
  }
}

function captureHorizonSnapshot(w, dir, entry, maxH, minL, close, msSinceFill) {
  for (const h of w.horizons) {
    if (h.captured) continue;
    if (msSinceFill >= h.h * 60000) {
      h.mfe = dir === 'long' ? maxH - entry : entry - minL;
      h.mae = dir === 'long' ? entry - minL : maxH - entry;
      h.close_pnl = dir === 'long' ? close - entry : entry - close;
      h.captured = true;
    }
  }
}

function finalizeEvent(e, reason) {
  if (e.entry_price == null) return; // never filled (e.g., end-of-data)
  // Any unfilled horizon snapshots → use final state
  const dirs = [['long', e.longW], ['short', e.shortW]];
  for (const [dir, w] of dirs) {
    for (const h of w.horizons) {
      if (!h.captured) {
        h.mfe = dir === 'long' ? e.maxH - e.entry_price : e.entry_price - e.minL;
        h.mae = dir === 'long' ? e.entry_price - e.minL : e.maxH - e.entry_price;
        h.close_pnl = dir === 'long' ? e.last_close - e.entry_price : e.entry_price - e.last_close;
        h.captured = true;
        h.partial = true; // walk ended before this horizon
      }
    }
    for (const c of w.cells) {
      if (!c.outcome) {
        c.outcome = reason; // 'timeout' | 'rollover' | 'eod'
        c.exit_ts = e.last_ts;
        c.exit_pnl = dir === 'long' ? e.last_close - e.entry_price : e.entry_price - e.last_close;
      }
    }
  }
  e.finalized = true;
  e.finalize_reason = reason;
}

// Streaming
const onesPath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1s.csv`);
if (!fs.existsSync(onesPath)) {
  console.error(`1s file not found: ${onesPath}`);
  process.exit(1);
}

// Earliest scan = first event's fill_ts. Latest = last event's fill_ts + MAX_HORIZON.
const scanStart = events.length ? events[0].fill_ts : rangeStart;
const scanEnd = (events.length ? events[events.length - 1].fill_ts : rangeEnd) + MAX_HORIZON_MS + 60000;
const minIso = new Date(scanStart).toISOString();
const maxIso = new Date(scanEnd).toISOString();

console.log(`Streaming 1s OHLCV (${minIso} → ${maxIso}) ...`);
const stream = fs.createReadStream(onesPath, { highWaterMark: 1 << 20 });
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
let header = null;
let scanned = 0, kept = 0;
const tStart = Date.now();

let nextEventIdx = 0;
const active = [];   // pending events (not yet filled)
const live = [];     // filled events being walked
let finalizedCount = 0;

function activateAt(bar_ts, bar_open, bar_high, bar_low, bar_close, primarySym) {
  // Activate any events whose fill_ts <= bar_ts and not yet activated.
  while (nextEventIdx < events.length && events[nextEventIdx].fill_ts <= bar_ts) {
    active.push(events[nextEventIdx]);
    nextEventIdx++;
  }
  // For each pending event, fire entry on this bar (it's the first primary bar at/after fill_ts)
  // We use the bar OPEN as the entry price.
  for (let i = active.length - 1; i >= 0; i--) {
    const e = active[i];
    initEvent(e, bar_open, bar_ts, primarySym);
    // Also apply this bar's range immediately (covers the second of entry)
    e.maxH = Math.max(e.maxH, bar_high);
    e.minL = Math.min(e.minL, bar_low);
    e.last_close = bar_close;
    e.last_ts = bar_ts;
    updateWatcher(e.longW, 'long', e.entry_price, bar_high, bar_low, bar_close, bar_ts);
    updateWatcher(e.shortW, 'short', e.entry_price, bar_high, bar_low, bar_close, bar_ts);
    captureHorizonSnapshot(e.longW, 'long', e.entry_price, e.maxH, e.minL, e.last_close, bar_ts - e.actual_fill_ts);
    captureHorizonSnapshot(e.shortW, 'short', e.entry_price, e.maxH, e.minL, e.last_close, bar_ts - e.actual_fill_ts);
    live.push(e);
    active.splice(i, 1);
  }
}

for await (const line of rl) {
  if (!header) { header = line; continue; }
  scanned++;
  if (scanned % 10_000_000 === 0) {
    const sec = ((Date.now() - tStart) / 1000).toFixed(0);
    process.stdout.write(`  scanned ${(scanned / 1e6).toFixed(0)}M  kept ${kept.toLocaleString()}  live=${live.length}  fin=${finalizedCount.toLocaleString()}  (${sec}s)\n`);
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
  const primarySym = primaryByHour.get(hourBucket);
  if (!primarySym || symbol !== primarySym) continue;

  const open = +parts[4], high = +parts[5], low = +parts[6], close = +parts[7];
  if (isNaN(close)) continue;
  kept++;

  // 1) Activate any pending events on or before this bar
  activateAt(ts, open, high, low, close, primarySym);

  // 2) Update live events
  for (let i = live.length - 1; i >= 0; i--) {
    const e = live[i];
    if (ts === e.actual_fill_ts) continue; // already processed at init

    // Detect rollover: primary sym changed since fill
    if (primarySym !== e.entry_primary_sym) {
      finalizeEvent(e, 'rollover');
      live.splice(i, 1); finalizedCount++;
      continue;
    }

    // Walk window expired?
    if (ts - e.actual_fill_ts > MAX_HORIZON_MS) {
      finalizeEvent(e, 'timeout');
      live.splice(i, 1); finalizedCount++;
      continue;
    }

    e.maxH = Math.max(e.maxH, high);
    e.minL = Math.min(e.minL, low);
    e.last_close = close;
    e.last_ts = ts;

    updateWatcher(e.longW, 'long', e.entry_price, high, low, close, ts);
    updateWatcher(e.shortW, 'short', e.entry_price, high, low, close, ts);
    captureHorizonSnapshot(e.longW, 'long', e.entry_price, e.maxH, e.minL, e.last_close, ts - e.actual_fill_ts);
    captureHorizonSnapshot(e.shortW, 'short', e.entry_price, e.maxH, e.minL, e.last_close, ts - e.actual_fill_ts);
  }
}
rl.close(); stream.destroy();

// Force-finalize anything still live
for (const e of live) {
  finalizeEvent(e, 'eod');
  finalizedCount++;
}

const sec = ((Date.now() - tStart) / 1000).toFixed(0);
console.log(`  Done: scanned ${scanned.toLocaleString()} rows, kept ${kept.toLocaleString()}, finalized ${finalizedCount.toLocaleString()}  (${sec}s)\n`);

// ---------- 4. Write output ----------
console.log(`Writing output ...`);
const cols = [
  'event_id', 'tf', 'flip_ts_iso', 'flip_ts_ms', 'fill_ts_ms', 'actual_fill_ts_ms',
  'new_state', 'prior_state', 'prior_state_duration_min',
  'direction',         // fade | momentum
  'side',              // long | short
  'entry_price', 'entry_primary_sym', 'finalize_reason',
];
for (const h of HORIZONS_MIN) cols.push(`mfe_${h}m`, `mae_${h}m`, `close_pnl_${h}m`);
for (const s of STOP_PTS) for (const t of TARGET_PTS) {
  cols.push(`out_s${s}_t${t}`, `pnl_s${s}_t${t}`, `exit_ms_s${s}_t${t}`);
}

const ws = fs.createWriteStream(outPath);
ws.write(cols.join(',') + '\n');

let written = 0;
for (const e of events) {
  if (e.entry_price == null) continue; // never filled
  const sides = [
    { dirLabel: 'fade', side: e.new_state === 0 ? 'long' : 'short', w: e.new_state === 0 ? e.longW : e.shortW },
    { dirLabel: 'momentum', side: e.new_state === 0 ? 'short' : 'long', w: e.new_state === 0 ? e.shortW : e.longW },
  ];
  for (const s of sides) {
    const row = [
      e.event_id, e.tf,
      new Date(e.flip_ts).toISOString(),
      e.flip_ts, e.fill_ts, e.actual_fill_ts,
      e.new_state, e.prior_state, e.prior_state_duration_min ?? '',
      s.dirLabel, s.side,
      e.entry_price.toFixed(4),
      e.entry_primary_sym,
      e.finalize_reason,
    ];
    for (const h of s.w.horizons) row.push(h.mfe.toFixed(4), h.mae.toFixed(4), h.close_pnl == null ? '' : h.close_pnl.toFixed(4));
    for (const c of s.w.cells) row.push(c.outcome, c.exit_pnl == null ? '' : c.exit_pnl.toFixed(4), c.exit_ts ?? '');
    ws.write(row.join(',') + '\n');
    written++;
  }
}
ws.end();
await new Promise(r => ws.on('finish', r));
const stat = fs.statSync(outPath);
console.log(`Written: ${outPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB, ${written.toLocaleString()} rows)\n`);

// ---------- 5. Quick summary ----------
console.log(`=== Quick summary (in-memory) ===`);
const dirSummary = { fade: {}, momentum: {} };
for (const dl of ['fade', 'momentum']) {
  for (const tf of ['1m', '3m']) {
    const ones = events.filter(e => e.entry_price != null && e.tf === tf);
    if (!ones.length) continue;
    // Use the middle stop/target cell for headline (s=15, t=30)
    const sIdx = STOP_PTS.indexOf(15) * TARGET_PTS.length + TARGET_PTS.indexOf(30);
    let n = 0, wins = 0, sumPnl = 0, gp = 0, gl = 0;
    for (const e of ones) {
      const side = dl === 'fade' ? (e.new_state === 0 ? 'long' : 'short') : (e.new_state === 0 ? 'short' : 'long');
      const w = side === 'long' ? e.longW : e.shortW;
      const c = w.cells[sIdx];
      if (c.exit_pnl == null) continue;
      n++; sumPnl += c.exit_pnl;
      if (c.exit_pnl > 0) { wins++; gp += c.exit_pnl; } else { gl += -c.exit_pnl; }
    }
    const wr = n ? (wins / n * 100).toFixed(1) : '—';
    const pf = gl > 0 ? (gp / gl).toFixed(2) : '∞';
    const avg = n ? (sumPnl / n).toFixed(2) : '—';
    console.log(`  ${dl.padEnd(10)} ${tf}  s15/t30:  n=${n.toString().padStart(6)}  WR=${wr}%  PF=${pf}  avg=${avg}pts  sum=${sumPnl.toFixed(0)}pts`);
  }
}
console.log('');
