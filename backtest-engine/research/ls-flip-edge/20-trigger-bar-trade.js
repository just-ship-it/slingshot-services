/**
 * Phase I — Trigger-bar structural trade.
 *
 * Concept:
 *   LONG after 0→1 (bullish) flip:
 *     - flip_high = high of the flip bar (1m or 3m)
 *     - flip_low  = low  of the flip bar
 *     - mid       = (flip_high + flip_low) / 2
 *     - Limit entry at mid (LONG fills when 1s bar's low <= mid post-flip-close)
 *     - Stop at flip_low (break = loss)
 *     - Target at flip_high (break = win)
 *
 *   SHORT after 1→0 (bearish) flip: mirror.
 *
 * R:R is 1:1 by construction (target_dist = stop_dist = bar_range/2).
 *
 * Simulation:
 *   - After flip bar closes (flip_ts + tf*60s), stream 1s primary bars.
 *   - Phase 'wait_fill': watch up to MAX_WAIT_MIN for the 1s bar to touch mid.
 *     If the bar BREAKS the target first (LONG: bar.high >= flip_high before
 *     filling at mid), mark 'no_fill_target_first'. If it BREAKS the stop
 *     first (LONG: bar.low <= flip_low without first dipping to mid), mark
 *     'no_fill_stop_first'.
 *     Same-1s-bar ambiguity: low <= mid AND high >= flip_high → assume fill
 *     then win.
 *   - Phase 'exit_walk': after fill, walk MAX_HOLD_MIN looking for target/stop.
 *     Same-bar (low <= stop AND high >= target) → conservative loss.
 *
 * Output: per-flip row with bar OHLC, mid, outcome, entry/exit prices, pnl_pts.
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
const OUT = arg('out', path.join(__dirname, 'output', '20-trigger-bar.csv'));
const MAX_FILL_BARS = +arg('max_fill_bars', '10'); // expire fill order after N bars of the flip TF
const MAX_HOLD_MIN = +arg('max_hold', '60');
const STOP_SLIPPAGE_PT = +arg('stop_slippage', '0.25'); // slippage on stop fills only (limits = exact, NQ tick = 0.25pt)
const ENTRY_FIB = +arg('entry_fib', '0.5'); // fraction of bar range to retrace before entering (0.5 = midpoint)

const MAX_HOLD_MS = MAX_HOLD_MIN * 60_000;

const LS_1M = path.join(__dirname, '..', 'lt-extraction', 'output', 'nq_ls_1m_raw.csv');
const LS_3M = path.join(__dirname, '..', 'lt-extraction', 'output', 'nq_ls_3m_raw.csv');
const LS_15M = path.join(__dirname, '..', 'lt-extraction', 'output', 'nq_ls_15m_raw.csv');

const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

console.log(`\n=== Phase I — Trigger-bar structural trade ===`);
console.log(`Range: ${START} → ${END}  |  Fill expiry: ${MAX_FILL_BARS} bars of flip TF  |  Max hold: ${MAX_HOLD_MIN}min`);
console.log(`Cancel on same-TF adverse flip during wait_fill.`);
console.log(`Stop slippage: ${STOP_SLIPPAGE_PT}pt (entries/targets are limit = exact).`);
console.log(`Entry fib: ${ENTRY_FIB} (fraction of bar range retraced from extreme).\n`);

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
console.log(`Primary 1m bars: ${primary1m.length}`);

// ts → primary 1m bar index
const tsToIdx = new Map();
for (let i = 0; i < primary1m.length; i++) tsToIdx.set(primary1m[i].ts, i);

// ---------- Build events ----------
function buildEvents(rows, tfMin, tfLabel) {
  const tfSec = tfMin * 60;
  const events = [];
  let priorState = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (priorState !== null && priorState !== r.state) {
      // Flip detected. Compute flip-bar OHLC.
      let flipBar = null;
      if (tfLabel === '1m') {
        const idx = tsToIdx.get(r.ts);
        if (idx != null) flipBar = primary1m[idx];
      } else {
        // 3m: aggregate 3 consecutive primary 1m bars at ts, ts+60s, ts+120s (must all be same primary contract = same hour bucket or at most across hour boundary)
        const idx0 = tsToIdx.get(r.ts);
        const idx1 = tsToIdx.get(r.ts + 60_000);
        const idx2 = tsToIdx.get(r.ts + 120_000);
        if (idx0 != null && idx1 != null && idx2 != null) {
          const b0 = primary1m[idx0], b1 = primary1m[idx1], b2 = primary1m[idx2];
          // require same primary symbol across all three
          if (b0.sym === b1.sym && b1.sym === b2.sym) {
            flipBar = {
              ts: b0.ts, o: b0.o, c: b2.c,
              h: Math.max(b0.h, b1.h, b2.h), l: Math.min(b0.l, b1.l, b2.l),
              sym: b0.sym, v: b0.v + b1.v + b2.v,
            };
          }
        }
      }
      if (flipBar && flipBar.h > flipBar.l) {
        const s1 = lsStateAt(ls1m, r.ts);
        const s3 = lsStateAt(ls3m, r.ts);
        const s15 = lsStateAt(ls15m, r.ts);
        const against = (s1 != null && s3 != null && s15 != null) && isAgainst(tfLabel, r.state, s1, s3, s15);
        // Direction: LONG after bullish flip (0→1), SHORT after bearish flip (1→0)
        const direction = r.state === 1 ? 'long' : 'short';
        const range = flipBar.h - flipBar.l;
        // Entry at ENTRY_FIB retrace from extreme:
        //   LONG: entry = flip_high - fib * range  (deeper retrace = lower entry, better R:R)
        //   SHORT: entry = flip_low + fib * range
        const mid = direction === 'long' ? (flipBar.h - ENTRY_FIB * range) : (flipBar.l + ENTRY_FIB * range);
        // Compute fill_window_end = fill_window_start + MAX_FILL_BARS * tf_seconds
        const fill_window_end = r.ts + tfSec * 1000 + MAX_FILL_BARS * tfSec * 1000;
        // Compute adverse_flip_ts = ts of next SAME-TF flip with state opposite to new_state, after r.ts
        // (LONG @ state=1 → adverse = next flip to state=0; SHORT @ state=0 → adverse = next to state=1)
        let adverse_flip_ts = null;
        for (let k = i + 1; k < rows.length; k++) {
          if (rows[k].state !== r.state) { adverse_flip_ts = rows[k].ts; break; }
        }
        events.push({
          tf: tfLabel,
          flip_ts: r.ts,
          fill_window_start: r.ts + tfSec * 1000,
          fill_window_end,
          adverse_flip_ts,
          prior_state: priorState,
          new_state: r.state,
          direction,
          flip_high: flipBar.h, flip_low: flipBar.l, flip_open: flipBar.o, flip_close: flipBar.c,
          mid, range,
          against,
          s1m: s1, s3m: s3, s15m: s15,
          primary_sym: flipBar.sym,
        });
      }
    }
    priorState = r.state;
  }
  return events;
}

const ev1m = buildEvents(ls1m, 1, '1m');
const ev3m = buildEvents(ls3m, 3, '3m');
const events = [...ev1m, ...ev3m].sort((a, b) => a.fill_window_start - b.fill_window_start);
events.forEach((e, i) => { e.event_id = i; });
console.log(`Events: 1m=${ev1m.length} 3m=${ev3m.length} total=${events.length}`);

// Distribution of flip-bar range (sanity)
{
  const ranges1m = ev1m.map(e => e.range).sort((a, b) => a - b);
  const ranges3m = ev3m.map(e => e.range).sort((a, b) => a - b);
  const pct = (a, p) => a[Math.floor(a.length * p)];
  console.log(`Flip-bar range (pts): 1m p25=${pct(ranges1m, 0.25).toFixed(2)} med=${pct(ranges1m, 0.5).toFixed(2)} p75=${pct(ranges1m, 0.75).toFixed(2)}`);
  console.log(`                      3m p25=${pct(ranges3m, 0.25).toFixed(2)} med=${pct(ranges3m, 0.5).toFixed(2)} p75=${pct(ranges3m, 0.75).toFixed(2)}\n`);
}

// ---------- Stream 1s OHLCV ----------
function initWatcher(e) {
  e.phase = 'wait_fill';
  e.actual_fill_ts = null; e.entry_price = null;
  e.outcome = null; e.exit_ts = null; e.exit_price = null; e.pnl_pts = null;
  e.fill_bar_max_h = -Infinity; e.fill_bar_min_l = Infinity;
  e.target = e.direction === 'long' ? e.flip_high : e.flip_low;
  e.stop = e.direction === 'long' ? e.flip_low : e.flip_high;
}

function tryFill(e, ts, open, high, low, close, primary) {
  if (primary !== e.primary_sym) { e.phase = 'done'; e.outcome = 'rollover_pre_fill'; return; }
  if (ts > e.fill_window_end) { e.phase = 'done'; e.outcome = 'no_fill_timeout'; return; }
  // Adverse same-TF flip during wait_fill → cancel order
  if (e.adverse_flip_ts != null && ts >= e.adverse_flip_ts) {
    e.phase = 'done'; e.outcome = 'no_fill_adverse_flip'; e.exit_ts = ts; return;
  }
  if (e.direction === 'long') {
    const targetFirst = high >= e.target;
    const stopFirst = low <= e.stop;
    const filled = low <= e.mid;
    // SAME-BAR AMBIGUITY: if filled AND both target+stop hit in same 1s bar,
    // we cannot prove order within 1 second — conservative loss.
    if (filled && targetFirst && stopFirst) {
      e.actual_fill_ts = ts; e.entry_price = e.mid; e.phase = 'done';
      const fill = e.stop - STOP_SLIPPAGE_PT;
      e.outcome = 'loss_same_bar'; e.exit_ts = ts; e.exit_price = fill; e.pnl_pts = fill - e.mid;
      return;
    }
    if (filled && targetFirst) {
      // fill then target hit in same bar — unambiguous (target above mid)
      e.actual_fill_ts = ts; e.entry_price = e.mid; e.phase = 'done';
      e.outcome = 'win_same_bar'; e.exit_ts = ts; e.exit_price = e.target; e.pnl_pts = e.target - e.mid;
      return;
    }
    if (filled && stopFirst) {
      // fill at mid then stop hit at flip_low — unambiguous (mid > stop)
      e.actual_fill_ts = ts; e.entry_price = e.mid; e.phase = 'done';
      const fill = e.stop - STOP_SLIPPAGE_PT;
      e.outcome = 'loss_same_bar'; e.exit_ts = ts; e.exit_price = fill; e.pnl_pts = fill - e.mid;
      return;
    }
    if (filled) {
      e.actual_fill_ts = ts; e.entry_price = e.mid; e.phase = 'exit';
      return;
    }
    if (targetFirst) { e.phase = 'done'; e.outcome = 'no_fill_target_first'; e.exit_ts = ts; return; }
    if (stopFirst) { e.phase = 'done'; e.outcome = 'no_fill_stop_first'; e.exit_ts = ts; return; }
  } else {
    const targetFirst = low <= e.target;   // SHORT target = flip_low
    const stopFirst = high >= e.stop;
    const filled = high >= e.mid;
    if (filled && targetFirst && stopFirst) {
      e.actual_fill_ts = ts; e.entry_price = e.mid; e.phase = 'done';
      const fill = e.stop + STOP_SLIPPAGE_PT;
      e.outcome = 'loss_same_bar'; e.exit_ts = ts; e.exit_price = fill; e.pnl_pts = e.mid - fill;
      return;
    }
    if (filled && targetFirst) {
      e.actual_fill_ts = ts; e.entry_price = e.mid; e.phase = 'done';
      e.outcome = 'win_same_bar'; e.exit_ts = ts; e.exit_price = e.target; e.pnl_pts = e.mid - e.target;
      return;
    }
    if (filled && stopFirst) {
      e.actual_fill_ts = ts; e.entry_price = e.mid; e.phase = 'done';
      const fill = e.stop + STOP_SLIPPAGE_PT;
      e.outcome = 'loss_same_bar'; e.exit_ts = ts; e.exit_price = fill; e.pnl_pts = e.mid - fill;
      return;
    }
    if (filled) { e.actual_fill_ts = ts; e.entry_price = e.mid; e.phase = 'exit'; return; }
    if (targetFirst) { e.phase = 'done'; e.outcome = 'no_fill_target_first'; e.exit_ts = ts; return; }
    if (stopFirst) { e.phase = 'done'; e.outcome = 'no_fill_stop_first'; e.exit_ts = ts; return; }
  }
}
function updateExit(e, ts, high, low, close, primary) {
  if (primary !== e.primary_sym) {
    e.phase = 'done'; e.outcome = 'rollover_post_fill'; e.exit_ts = ts; e.exit_price = close;
    e.pnl_pts = e.direction === 'long' ? close - e.entry_price : e.entry_price - close;
    return;
  }
  if (ts - e.actual_fill_ts > MAX_HOLD_MS) {
    e.phase = 'done'; e.outcome = 'timeout'; e.exit_ts = ts; e.exit_price = close;
    e.pnl_pts = e.direction === 'long' ? close - e.entry_price : e.entry_price - close;
    return;
  }
  if (e.direction === 'long') {
    const sH = low <= e.stop, tH = high >= e.target;
    const stopFill = e.stop - STOP_SLIPPAGE_PT;
    if (sH && tH) { e.phase = 'done'; e.outcome = 'loss'; e.exit_ts = ts; e.exit_price = stopFill; e.pnl_pts = stopFill - e.entry_price; }
    else if (sH) { e.phase = 'done'; e.outcome = 'loss'; e.exit_ts = ts; e.exit_price = stopFill; e.pnl_pts = stopFill - e.entry_price; }
    else if (tH) { e.phase = 'done'; e.outcome = 'win'; e.exit_ts = ts; e.exit_price = e.target; e.pnl_pts = e.target - e.entry_price; }
  } else {
    const sH = high >= e.stop, tH = low <= e.target;
    const stopFill = e.stop + STOP_SLIPPAGE_PT;
    if (sH && tH) { e.phase = 'done'; e.outcome = 'loss'; e.exit_ts = ts; e.exit_price = stopFill; e.pnl_pts = e.entry_price - stopFill; }
    else if (sH) { e.phase = 'done'; e.outcome = 'loss'; e.exit_ts = ts; e.exit_price = stopFill; e.pnl_pts = e.entry_price - stopFill; }
    else if (tH) { e.phase = 'done'; e.outcome = 'win'; e.exit_ts = ts; e.exit_price = e.target; e.pnl_pts = e.entry_price - e.target; }
  }
}

const onesPath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1s.csv`);
const scanStart = events.length ? events[0].fill_window_start : Date.now();
const MAX_FILL_MS = MAX_FILL_BARS * 3 * 60_000; // worst case: 3m TF, 10 bars
const scanEnd = (events.length ? events[events.length - 1].fill_window_start : Date.now()) + MAX_FILL_MS + MAX_HOLD_MS + 60000;
const minIso = new Date(scanStart).toISOString();
const maxIso = new Date(scanEnd).toISOString();

console.log(`Streaming 1s OHLCV (${minIso} → ${maxIso})...`);
const stream = fs.createReadStream(onesPath, { highWaterMark: 1 << 20 });
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
let header = null, scanned = 0, kept = 0;
let nextIdx = 0;
const live = [];
let finalized = 0;
const tStart = Date.now();

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

  while (nextIdx < events.length && events[nextIdx].fill_window_start <= ts) {
    const e = events[nextIdx];
    if (!e._activated) { e._activated = true; initWatcher(e); live.push(e); }
    nextIdx++;
  }
  for (let i = live.length - 1; i >= 0; i--) {
    const e = live[i];
    if (e.phase === 'wait_fill') tryFill(e, ts, open, high, low, close, primary);
    if (e.phase === 'exit') updateExit(e, ts, high, low, close, primary);
    if (e.phase === 'done') { live.splice(i, 1); finalized++; }
  }
}
rl.close(); stream.destroy();
for (const e of live) {
  if (e.phase === 'wait_fill') { e.phase = 'done'; e.outcome = 'no_fill_eod'; }
  else if (e.phase === 'exit') { e.phase = 'done'; e.outcome = 'eod'; e.exit_ts = e.actual_fill_ts; e.exit_price = e.entry_price; e.pnl_pts = 0; }
  finalized++;
}
const sec = ((Date.now() - tStart) / 1000).toFixed(0);
console.log(`Done: scanned ${scanned.toLocaleString()} fin ${finalized} (${sec}s)\n`);

// ---------- Write ----------
console.log('Writing output...');
const cols = [
  'event_id', 'tf', 'flip_ts', 'prior_state', 'new_state', 'direction', 'against',
  'flip_open', 'flip_high', 'flip_low', 'flip_close', 'mid', 'range',
  's1m', 's3m', 's15m',
  'phase', 'outcome',
  'actual_fill_ts', 'entry_price', 'target', 'stop',
  'exit_ts', 'exit_price', 'pnl_pts',
];
const ws = fs.createWriteStream(outPath);
ws.write(cols.join(',') + '\n');
let written = 0;
for (const e of events) {
  if (!e._activated) continue;
  const row = cols.map(k => {
    const v = e[k];
    if (v == null) return '';
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return Number.isInteger(v) ? v : v.toFixed(4);
    return v;
  });
  ws.write(row.join(',') + '\n');
  written++;
}
ws.end();
await new Promise(r => ws.on('finish', r));
const stat = fs.statSync(outPath);
console.log(`Written: ${outPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB, ${written} rows)\n`);

// ---------- Quick summary ----------
console.log(`Quick summary:`);
const outcomesCount = new Map();
for (const e of events) {
  if (!e._activated) continue;
  outcomesCount.set(e.outcome, (outcomesCount.get(e.outcome) || 0) + 1);
}
for (const [k, v] of [...outcomesCount.entries()].sort()) console.log(`  ${k.padEnd(24)} ${v}`);

function summarize(arr) {
  let n = 0, w = 0, l = 0, pnl = 0, sumRange = 0;
  for (const e of arr) {
    const isWin = e.outcome === 'win' || e.outcome === 'win_same_bar';
    const isLoss = e.outcome === 'loss' || e.outcome === 'loss_same_bar';
    if (isWin || isLoss) {
      n++; if (isWin) w++; else l++;
      pnl += e.pnl_pts || 0;
      sumRange += e.range;
    }
  }
  return { n, w, l, pnl, sumRange, wr: n ? w / n * 100 : 0, pf: l ? (w / l) : (w > 0 ? Infinity : 0), avg_range: n ? sumRange / n : 0 };
}

console.log(`\nFilled-trade WR by (tf, direction, against):`);
const grp = new Map();
for (const e of events) {
  if (!e._activated) continue;
  const k = `${e.tf}|${e.direction}|against=${e.against ? 'Y' : 'N'}`;
  if (!grp.has(k)) grp.set(k, []);
  grp.get(k).push(e);
}
for (const [k, arr] of [...grp.entries()].sort()) {
  const s = summarize(arr);
  console.log(`  ${k.padEnd(28)} filled=${s.n}  WR=${s.wr.toFixed(1)}%  PF=${s.pf.toFixed(2)}  sumPnL=${s.pnl.toFixed(0)}pt  avg_range=${s.avg_range.toFixed(1)}pt`);
}
