/**
 * Phase G — 1s entry-quality scan for 10-15pt swing-stop scalps.
 *
 * Premise from user: LS+AGAINST is the FIRST filter (gives directional bias).
 * Strategy then enters on a 1s bar close where price has pulled back to a
 * recent low (LONG) or high (SHORT), giving good R:R for a fixed 10 or 15
 * point target. Stop = swing point ± buffer.
 *
 * For each AGAINST flip event (3m and 1m), walk 1s primary-contract bars
 * forward up to MAX_WAIT_MIN. Maintain rolling swing min(low)/max(high) over
 * multiple lookback windows. For each (lookback, target) combo, find the
 * FIRST 1s bar where stop_dist falls into each bucket {0-3, 3-5, 5-8, 8-12,
 * 12-18, 18-25} pts. Walk forward up to MAX_HOLD_MIN to record outcome.
 *
 * Output: one row per (flip, lookback, target, stop_bucket) attempt — long
 * format. Subsequent phases aggregate to find the (lookback, target, stop)
 * cells with highest WR.
 *
 * Direction logic (fade): new_state=0 → LONG, new_state=1 → SHORT.
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
const OUT = arg('out', path.join(__dirname, 'output', '10-scalp-entries.csv'));

// Sweep grid
const LOOKBACK_SEC = [60, 180, 300, 600];
const TARGETS_PT = [10, 15];
const STOP_BUCKETS_PT = [3, 5, 8, 12, 18, 25]; // we record entry at first bar with stop_dist <= bucket
const BUFFER_PT = 1.0;     // stop sits below swing low (or above swing high) by this many pts
const MAX_WAIT_MIN = 15;
const MAX_HOLD_MIN = 30;

const MAX_WAIT_MS = MAX_WAIT_MIN * 60 * 1000;
const MAX_HOLD_MS = MAX_HOLD_MIN * 60 * 1000;
const MAX_LOOKBACK_MS = Math.max(...LOOKBACK_SEC) * 1000;

const LS_1M = path.join(__dirname, '..', 'lt-extraction', 'output', 'nq_ls_1m_raw.csv');
const LS_3M = path.join(__dirname, '..', 'lt-extraction', 'output', 'nq_ls_3m_raw.csv');
const LS_15M = path.join(__dirname, '..', 'lt-extraction', 'output', 'nq_ls_15m_raw.csv');

const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

console.log(`\n=== Phase G — 1s entry-quality scan (10-15pt swing-stop scalps) ===`);
console.log(`Range: ${START} → ${END}`);
console.log(`Lookbacks: ${LOOKBACK_SEC.join(',')}s | Targets: ${TARGETS_PT.join(',')}pt | Stop buckets: ${STOP_BUCKETS_PT.join(',')}pt`);
console.log(`Max wait after flip: ${MAX_WAIT_MIN}min | Max hold: ${MAX_HOLD_MIN}min | Buffer: ${BUFFER_PT}pt\n`);

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
function findLeIdx(arr, q) {
  let lo = 0, hi = arr.length - 1, a = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= q) { a = m; lo = m + 1; } else hi = m - 1; }
  return a;
}
function stateAt(idx, q) { const i = findLeIdx(idx.ts, q); return i === -1 ? null : idx.state[i]; }
function lsStateIndex(rows) { return { ts: rows.map(r => r.ts), state: rows.map(r => r.state) }; }

// ---------- load LS ----------
console.log('Loading LS ...');
const ls1m = loadLs(LS_1M);
const ls3m = loadLs(LS_3M);
const ls15m = loadLs(LS_15M);
const idx1m = lsStateIndex(ls1m);
const idx3m = lsStateIndex(ls3m);
const idx15m = lsStateIndex(ls15m);
console.log(`  1m=${ls1m.length} 3m=${ls3m.length} 15m=${ls15m.length}`);

// ---------- load 1m OHLCV → primary map ----------
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
        candles.push({ ts, v: +row.volume || 0, sym: row.symbol });
      })
      .on('end', resolve).on('error', reject);
  });
  return candles;
}
console.log('Loading 1m for primary map ...');
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
    let bestS = '', bestV = 0;
    for (const [s, v] of m.entries()) if (v > bestV) { bestV = v; bestS = s; }
    primaryByHour.set(h, bestS);
  }
}
console.log(`  primary hours: ${primaryByHour.size}`);

// ---------- build event list with AGAINST filter ----------
function isAgainst(tf, newState, s1, s3, s15) {
  if (tf === '1m') return (newState !== s3) && (newState !== s15);
  return (newState !== s15) && (newState !== s1);
}
function buildEvents(lsRows, tfMin, tfLabel, rangeStart, rangeEnd) {
  const tfSec = tfMin * 60;
  const events = [];
  let priorState = null;
  for (const r of lsRows) {
    if (priorState !== null && r.ts >= rangeStart && r.ts <= rangeEnd) {
      const s1 = stateAt(idx1m, r.ts);
      const s3 = stateAt(idx3m, r.ts);
      const s15 = stateAt(idx15m, r.ts);
      const newState = r.state;
      if (s1 == null || s3 == null || s15 == null) {
        priorState = r.state; continue;
      }
      if (isAgainst(tfLabel, newState, s1, s3, s15)) {
        const fill_ts = r.ts + tfSec * 1000;
        const direction = newState === 0 ? 'long' : 'short';
        events.push({
          tf: tfLabel,
          flip_ts: r.ts,
          fill_ts,
          watch_start_ts: fill_ts,
          watch_end_ts: fill_ts + MAX_WAIT_MS,
          direction,
          new_state: newState,
          s1m_at_flip: s1, s3m_at_flip: s3, s15m_at_flip: s15,
        });
      }
    }
    priorState = r.state;
  }
  return events;
}
const rangeStart = new Date(START).getTime();
const rangeEnd = new Date(END).getTime() + 24 * 3600000;
const ev1m = buildEvents(ls1m, 1, '1m', rangeStart, rangeEnd);
const ev3m = buildEvents(ls3m, 3, '3m', rangeStart, rangeEnd);
const events = [...ev1m, ...ev3m].sort((a, b) => a.watch_start_ts - b.watch_start_ts);
events.forEach((e, i) => { e.event_id = i; });
console.log(`AGAINST events: 1m=${ev1m.length} 3m=${ev3m.length} total=${events.length}\n`);

// ---------- per-event state ----------
// For each event, maintain rolling 1s buffer for the largest lookback (MAX_LOOKBACK_MS).
// We use a circular array; per-bar we update min/max for each lookback window.
// To save memory, store {ts, low, high} per 1s bar in a deque.
//
// Also per event, track entries per (lookback, target, stop_bucket) — each is a
// separate "watcher" that fires once when the entry condition is first met.
// Each watcher has phase: WATCH → EXIT → DONE.

function makeWatchers(direction) {
  // For each (lookback × target × stop_bucket), one watcher.
  const watchers = [];
  for (const lb of LOOKBACK_SEC) for (const tgt of TARGETS_PT) for (const bkt of STOP_BUCKETS_PT) {
    watchers.push({
      lookback: lb,
      target: tgt,
      stop_bucket: bkt,
      phase: 'watch',
      entry_ts: null, entry_price: null, stop_price: null, target_price: null, stop_dist: null,
      outcome: null, exit_ts: null, exit_price: null, pnl_pts: null,
    });
  }
  return watchers;
}

function initEventState(e) {
  e.buf = []; // {ts, low, high}
  e.watchers = makeWatchers(e.direction);
  e.activatedExit = false;
  e.allWatchersDone = false;
  e.maxExitEndTs = null; // when latest exit walk could end
}

function getSwingForLookback(buf, nowTs, lb) {
  // Walk buf backward from end while ts >= nowTs - lb*1000
  const limit = nowTs - lb * 1000;
  let mn = Infinity, mx = -Infinity;
  for (let i = buf.length - 1; i >= 0; i--) {
    const b = buf[i];
    if (b.ts < limit) break;
    if (b.low < mn) mn = b.low;
    if (b.high > mx) mx = b.high;
  }
  return { mn, mx };
}

function updateExitWatcher(w, e, ts, high, low, close) {
  if (w.phase !== 'exit') return;
  if (ts - w.entry_ts > MAX_HOLD_MS) {
    // Timeout: close at last price
    w.outcome = 'timeout';
    w.exit_ts = ts;
    w.exit_price = close;
    w.pnl_pts = (e.direction === 'long' ? close - w.entry_price : w.entry_price - close);
    w.phase = 'done';
    return;
  }
  if (e.direction === 'long') {
    const stopHit = low <= w.stop_price;
    const targetHit = high >= w.target_price;
    if (stopHit && targetHit) {
      // Conservative: stop wins
      w.outcome = 'stop'; w.exit_ts = ts; w.exit_price = w.stop_price; w.pnl_pts = w.stop_price - w.entry_price;
    } else if (stopHit) {
      w.outcome = 'stop'; w.exit_ts = ts; w.exit_price = w.stop_price; w.pnl_pts = w.stop_price - w.entry_price;
    } else if (targetHit) {
      w.outcome = 'target'; w.exit_ts = ts; w.exit_price = w.target_price; w.pnl_pts = w.target_price - w.entry_price;
    }
  } else {
    const stopHit = high >= w.stop_price;
    const targetHit = low <= w.target_price;
    if (stopHit && targetHit) {
      w.outcome = 'stop'; w.exit_ts = ts; w.exit_price = w.stop_price; w.pnl_pts = w.entry_price - w.stop_price;
    } else if (stopHit) {
      w.outcome = 'stop'; w.exit_ts = ts; w.exit_price = w.stop_price; w.pnl_pts = w.entry_price - w.stop_price;
    } else if (targetHit) {
      w.outcome = 'target'; w.exit_ts = ts; w.exit_price = w.target_price; w.pnl_pts = w.entry_price - w.target_price;
    }
  }
  if (w.outcome) w.phase = 'done';
}

function dispatchEvent(e, ts, open, high, low, close, primarySym) {
  if (e.primarySym == null) e.primarySym = primarySym;
  if (primarySym !== e.primarySym) {
    // rollover — finalize anything left
    for (const w of e.watchers) {
      if (w.phase === 'watch') { w.phase = 'done'; w.outcome = 'no_entry_rollover'; }
      else if (w.phase === 'exit') { w.phase = 'done'; w.outcome = 'rollover'; w.exit_ts = ts; w.exit_price = close; w.pnl_pts = (e.direction === 'long' ? close - w.entry_price : w.entry_price - close); }
    }
    e.allWatchersDone = true;
    return;
  }

  // Push to rolling buffer; prune older than max lookback
  e.buf.push({ ts, low, high });
  const minKeepTs = ts - MAX_LOOKBACK_MS;
  while (e.buf.length > 0 && e.buf[0].ts < minKeepTs) e.buf.shift();

  // For each watch-phase watcher, check entry condition (only if past warmup of its lookback)
  for (const w of e.watchers) {
    if (w.phase !== 'watch') continue;
    // Has enough lookback passed since watch_start_ts?
    if (ts - e.watch_start_ts < w.lookback * 1000) continue;
    // Past watch_end_ts → mark no_entry
    if (ts > e.watch_end_ts) { w.phase = 'done'; w.outcome = 'no_entry'; continue; }

    // Compute swing
    const { mn, mx } = getSwingForLookback(e.buf, ts, w.lookback);
    if (!isFinite(mn) || !isFinite(mx)) continue;
    let stop, stop_dist, target_price;
    if (e.direction === 'long') {
      stop = mn - BUFFER_PT;
      stop_dist = close - stop;
      target_price = close + w.target;
    } else {
      stop = mx + BUFFER_PT;
      stop_dist = stop - close;
      target_price = close - w.target;
    }
    if (stop_dist <= 0) continue; // entry would be on wrong side of swing
    if (stop_dist > w.stop_bucket) continue; // not yet tight enough for this bucket
    // Entry trigger! Transition to exit phase.
    w.phase = 'exit';
    w.entry_ts = ts;
    w.entry_price = close;
    w.stop_price = stop;
    w.target_price = target_price;
    w.stop_dist = stop_dist;
    // Also immediately apply this bar for stop/target (rare case where same-bar hits)
    updateExitWatcher(w, e, ts, high, low, close);
  }
  // For exit-phase watchers, apply this bar
  for (const w of e.watchers) {
    if (w.phase === 'exit') updateExitWatcher(w, e, ts, high, low, close);
  }

  // Check if all watchers done
  let anyOpen = false;
  for (const w of e.watchers) { if (w.phase !== 'done') { anyOpen = true; break; } }
  if (!anyOpen) e.allWatchersDone = true;
}

// ---------- streaming pass ----------
const onesPath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1s.csv`);
const scanStart = events.length ? events[0].watch_start_ts : rangeStart;
const scanEnd = (events.length ? events[events.length - 1].watch_end_ts : rangeEnd) + MAX_HOLD_MS + 60000;
const minIso = new Date(scanStart).toISOString();
const maxIso = new Date(scanEnd).toISOString();

console.log(`Streaming 1s OHLCV (${minIso} → ${maxIso}) ...`);
const stream = fs.createReadStream(onesPath, { highWaterMark: 1 << 20 });
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
let header = null, scanned = 0, kept = 0, nextEventIdx = 0;
const live = [];
let finalized = 0;
const tStart = Date.now();

for await (const line of rl) {
  if (!header) { header = line; continue; }
  scanned++;
  if (scanned % 10_000_000 === 0) {
    const sec = ((Date.now() - tStart) / 1000).toFixed(0);
    process.stdout.write(`  scanned ${(scanned / 1e6).toFixed(0)}M kept ${kept.toLocaleString()} live=${live.length} fin=${finalized.toLocaleString()} (${sec}s)\n`);
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

  // Activate events
  while (nextEventIdx < events.length && events[nextEventIdx].watch_start_ts <= ts + MAX_LOOKBACK_MS) {
    // Activate slightly early to pre-fill the lookback buffer. We mark watch_start_ts to gate entry triggers.
    const e = events[nextEventIdx];
    if (!e.activated) {
      initEventState(e);
      e.activated = true;
      live.push(e);
    }
    nextEventIdx++;
  }

  for (let i = live.length - 1; i >= 0; i--) {
    const e = live[i];
    if (e.allWatchersDone) { live.splice(i, 1); finalized++; continue; }
    // Skip dispatch if we're not yet in the buffer-fill window (shouldn't happen since we activate by then)
    dispatchEvent(e, ts, open, high, low, close, primary);
    if (e.allWatchersDone) { live.splice(i, 1); finalized++; }
  }
}
rl.close(); stream.destroy();
for (const e of live) {
  for (const w of e.watchers) {
    if (w.phase === 'watch') { w.phase = 'done'; w.outcome = 'no_entry_eod'; }
    else if (w.phase === 'exit') {
      w.phase = 'done'; w.outcome = 'eod';
      w.exit_ts = e.buf.length ? e.buf[e.buf.length - 1].ts : w.entry_ts;
      // Approximate exit price as last close — we don't store close in buf, so use entry_price for pnl=0 in this edge case
      w.exit_price = w.entry_price; w.pnl_pts = 0;
    }
  }
  finalized++;
}
const sec = ((Date.now() - tStart) / 1000).toFixed(0);
console.log(`  Done: scanned ${scanned.toLocaleString()} kept ${kept.toLocaleString()} fin ${finalized.toLocaleString()} (${sec}s)\n`);

// ---------- write output ----------
console.log('Writing output ...');
const cols = [
  'event_id', 'tf', 'flip_ts_iso', 'flip_ts_ms', 'fill_ts_ms', 'direction', 'new_state',
  's1m_at_flip', 's3m_at_flip', 's15m_at_flip',
  'lookback_s', 'target_pt', 'stop_bucket_pt',
  'phase', 'outcome',
  'entry_ts_ms', 'entry_price', 'stop_price', 'target_price', 'stop_dist',
  'exit_ts_ms', 'exit_price', 'pnl_pts',
  'wait_to_entry_s', 'hold_s',
];
const ws = fs.createWriteStream(outPath);
ws.write(cols.join(',') + '\n');
for (const e of events) {
  if (!e.activated) continue;
  for (const w of e.watchers) {
    const row = [
      e.event_id, e.tf,
      new Date(e.flip_ts).toISOString(), e.flip_ts, e.fill_ts,
      e.direction, e.new_state,
      e.s1m_at_flip, e.s3m_at_flip, e.s15m_at_flip,
      w.lookback, w.target, w.stop_bucket,
      w.phase, w.outcome ?? '',
      w.entry_ts ?? '', w.entry_price?.toFixed(4) ?? '', w.stop_price?.toFixed(4) ?? '',
      w.target_price?.toFixed(4) ?? '', w.stop_dist?.toFixed(4) ?? '',
      w.exit_ts ?? '', w.exit_price?.toFixed(4) ?? '', w.pnl_pts?.toFixed(4) ?? '',
      w.entry_ts ? ((w.entry_ts - e.watch_start_ts) / 1000).toFixed(0) : '',
      w.entry_ts && w.exit_ts ? ((w.exit_ts - w.entry_ts) / 1000).toFixed(0) : '',
    ];
    ws.write(row.join(',') + '\n');
  }
}
ws.end();
await new Promise(r => ws.on('finish', r));
const stat = fs.statSync(outPath);
console.log(`Written: ${outPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)\n`);
