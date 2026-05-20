/**
 * Phase I-5 — Two-phase entry: half contract at fib_a (e.g., 0.5), half at fib_b (e.g., 0.786).
 *
 * Per LS flip event, place TWO limit orders:
 *   - Order A at fib_a (default 0.5 = mid)
 *   - Order B at fib_b (default 0.786 = deep retrace)
 * Both share same stop (flip_low for LONG, flip_high for SHORT) and same target.
 *
 * Each order is 1 contract. Total exposure = 1 or 2 contracts depending on fills.
 * If only A fills: 1-contract trade with R:R = (1-fib_a)/fib_a.
 * If both fill: 2-contract trade. Combined R:R depends on average entry.
 *
 * Cancel rules:
 *   - Bar-count expiry on each order independently
 *   - Adverse same-TF flip cancels ALL unfilled orders
 * Exits:
 *   - Stop slippage applied to losses (default 0.25pt)
 *   - Target/limit entries: exact
 *
 * Output: one row per event with both legs' outcomes and combined PnL.
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
const OUT = arg('out', path.join(__dirname, 'output', '24-trigger-bar-2phase.csv'));
const FIB_A = +arg('fib_a', '0.5');
const FIB_B = +arg('fib_b', '0.786');
const MAX_FILL_BARS = +arg('max_fill_bars', '10');
const MAX_HOLD_MIN = +arg('max_hold', '60');
const STOP_SLIPPAGE_PT = +arg('stop_slippage', '0.25');

const MAX_HOLD_MS = MAX_HOLD_MIN * 60_000;

const LS_1M = path.join(__dirname, '..', 'lt-extraction', 'output', 'nq_ls_1m_raw.csv');
const LS_3M = path.join(__dirname, '..', 'lt-extraction', 'output', 'nq_ls_3m_raw.csv');
const LS_15M = path.join(__dirname, '..', 'lt-extraction', 'output', 'nq_ls_15m_raw.csv');

const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

console.log(`\n=== Phase I-5 — Two-phase entry (${FIB_A} + ${FIB_B} fib levels) ===`);
console.log(`Range: ${START} → ${END}  |  Fill expiry: ${MAX_FILL_BARS} bars  |  Max hold: ${MAX_HOLD_MIN}min`);
console.log(`Stop slippage: ${STOP_SLIPPAGE_PT}pt  (limits exact)\n`);

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
const tsToIdx = new Map();
for (let i = 0; i < primary1m.length; i++) tsToIdx.set(primary1m[i].ts, i);
console.log(`Primary 1m: ${primary1m.length}`);

function buildEvents(rows, tfMin, tfLabel) {
  const tfSec = tfMin * 60;
  const events = [];
  let priorState = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (priorState !== null && priorState !== r.state) {
      let flipBar = null;
      if (tfLabel === '1m') {
        const idx = tsToIdx.get(r.ts);
        if (idx != null) flipBar = primary1m[idx];
      } else {
        const idx0 = tsToIdx.get(r.ts), idx1 = tsToIdx.get(r.ts + 60_000), idx2 = tsToIdx.get(r.ts + 120_000);
        if (idx0 != null && idx1 != null && idx2 != null) {
          const b0 = primary1m[idx0], b1 = primary1m[idx1], b2 = primary1m[idx2];
          if (b0.sym === b1.sym && b1.sym === b2.sym) {
            flipBar = { ts: b0.ts, o: b0.o, c: b2.c, h: Math.max(b0.h, b1.h, b2.h), l: Math.min(b0.l, b1.l, b2.l), sym: b0.sym };
          }
        }
      }
      if (flipBar && flipBar.h > flipBar.l) {
        const s1 = lsStateAt(ls1m, r.ts);
        const s3 = lsStateAt(ls3m, r.ts);
        const s15 = lsStateAt(ls15m, r.ts);
        const against = (s1 != null && s3 != null && s15 != null) && isAgainst(tfLabel, r.state, s1, s3, s15);
        const direction = r.state === 1 ? 'long' : 'short';
        const range = flipBar.h - flipBar.l;
        // Compute fib levels
        const entryA = direction === 'long' ? (flipBar.h - FIB_A * range) : (flipBar.l + FIB_A * range);
        const entryB = direction === 'long' ? (flipBar.h - FIB_B * range) : (flipBar.l + FIB_B * range);
        const fill_window_end = r.ts + tfSec * 1000 + MAX_FILL_BARS * tfSec * 1000;
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
          prior_state: priorState, new_state: r.state,
          direction, against,
          flip_high: flipBar.h, flip_low: flipBar.l, flip_open: flipBar.o, flip_close: flipBar.c,
          entryA, entryB, range,
          target: direction === 'long' ? flipBar.h : flipBar.l,
          stop: direction === 'long' ? flipBar.l : flipBar.h,
          primary_sym: flipBar.sym,
          s1m: s1, s3m: s3, s15m: s15,
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

// Each event tracks 2 legs: A and B
// Per leg: phase ('wait', 'active', 'done'), entry_ts, entry_price, outcome, exit_ts, exit_price, pnl_pts
function initEvent(e) {
  e.legs = {
    A: { fib: FIB_A, price: e.entryA, phase: 'wait', entry_ts: null, entry_price: null, outcome: null, exit_ts: null, exit_price: null, pnl_pts: null },
    B: { fib: FIB_B, price: e.entryB, phase: 'wait', entry_ts: null, entry_price: null, outcome: null, exit_ts: null, exit_price: null, pnl_pts: null },
  };
  e.allDone = false;
}

function processLeg(e, leg, ts, open, high, low, close, primary) {
  if (leg.phase === 'done') return;
  if (primary !== e.primary_sym) {
    if (leg.phase === 'wait') { leg.phase = 'done'; leg.outcome = 'no_fill_rollover'; }
    else { leg.phase = 'done'; leg.outcome = 'rollover'; leg.exit_ts = ts; leg.exit_price = close; leg.pnl_pts = e.direction === 'long' ? close - leg.entry_price : leg.entry_price - close; }
    return;
  }
  if (leg.phase === 'wait') {
    if (ts > e.fill_window_end) { leg.phase = 'done'; leg.outcome = 'no_fill_timeout'; return; }
    if (e.adverse_flip_ts != null && ts >= e.adverse_flip_ts) { leg.phase = 'done'; leg.outcome = 'no_fill_adverse_flip'; leg.exit_ts = ts; return; }
    // Check for fill
    let filled = false;
    if (e.direction === 'long') filled = low <= leg.price;
    else filled = high >= leg.price;
    if (filled) {
      // also check same-bar target/stop
      if (e.direction === 'long') {
        const sH = low <= e.stop, tH = high >= e.target;
        if (sH && tH) {
          leg.entry_ts = ts; leg.entry_price = leg.price; leg.phase = 'done';
          const fill = e.stop - STOP_SLIPPAGE_PT;
          leg.outcome = 'loss_same_bar'; leg.exit_ts = ts; leg.exit_price = fill; leg.pnl_pts = fill - leg.price;
          return;
        }
        if (sH) {
          leg.entry_ts = ts; leg.entry_price = leg.price; leg.phase = 'done';
          const fill = e.stop - STOP_SLIPPAGE_PT;
          leg.outcome = 'loss_same_bar'; leg.exit_ts = ts; leg.exit_price = fill; leg.pnl_pts = fill - leg.price;
          return;
        }
        if (tH) {
          leg.entry_ts = ts; leg.entry_price = leg.price; leg.phase = 'done';
          leg.outcome = 'win_same_bar'; leg.exit_ts = ts; leg.exit_price = e.target; leg.pnl_pts = e.target - leg.price;
          return;
        }
      } else {
        const sH = high >= e.stop, tH = low <= e.target;
        if (sH && tH) {
          leg.entry_ts = ts; leg.entry_price = leg.price; leg.phase = 'done';
          const fill = e.stop + STOP_SLIPPAGE_PT;
          leg.outcome = 'loss_same_bar'; leg.exit_ts = ts; leg.exit_price = fill; leg.pnl_pts = leg.price - fill;
          return;
        }
        if (sH) {
          leg.entry_ts = ts; leg.entry_price = leg.price; leg.phase = 'done';
          const fill = e.stop + STOP_SLIPPAGE_PT;
          leg.outcome = 'loss_same_bar'; leg.exit_ts = ts; leg.exit_price = fill; leg.pnl_pts = leg.price - fill;
          return;
        }
        if (tH) {
          leg.entry_ts = ts; leg.entry_price = leg.price; leg.phase = 'done';
          leg.outcome = 'win_same_bar'; leg.exit_ts = ts; leg.exit_price = e.target; leg.pnl_pts = leg.price - e.target;
          return;
        }
      }
      leg.entry_ts = ts; leg.entry_price = leg.price; leg.phase = 'active';
      // also check for premature target in opposite direction (no_fill_target_first)? not applicable once filled
    } else {
      // Could check no_fill_target_first / no_fill_stop_first for unfilled legs, but for simplicity treat unfilled as still waiting
      if (e.direction === 'long') {
        if (high >= e.target) { leg.phase = 'done'; leg.outcome = 'no_fill_target_first'; leg.exit_ts = ts; return; }
        if (low <= e.stop) { leg.phase = 'done'; leg.outcome = 'no_fill_stop_first'; leg.exit_ts = ts; return; }
      } else {
        if (low <= e.target) { leg.phase = 'done'; leg.outcome = 'no_fill_target_first'; leg.exit_ts = ts; return; }
        if (high >= e.stop) { leg.phase = 'done'; leg.outcome = 'no_fill_stop_first'; leg.exit_ts = ts; return; }
      }
    }
  }
  if (leg.phase === 'active') {
    if (ts - leg.entry_ts > MAX_HOLD_MS) {
      leg.phase = 'done'; leg.outcome = 'timeout'; leg.exit_ts = ts; leg.exit_price = close;
      leg.pnl_pts = e.direction === 'long' ? close - leg.entry_price : leg.entry_price - close;
      return;
    }
    if (e.direction === 'long') {
      const sH = low <= e.stop, tH = high >= e.target;
      const stopFill = e.stop - STOP_SLIPPAGE_PT;
      if (sH && tH) { leg.phase = 'done'; leg.outcome = 'loss'; leg.exit_ts = ts; leg.exit_price = stopFill; leg.pnl_pts = stopFill - leg.entry_price; }
      else if (sH) { leg.phase = 'done'; leg.outcome = 'loss'; leg.exit_ts = ts; leg.exit_price = stopFill; leg.pnl_pts = stopFill - leg.entry_price; }
      else if (tH) { leg.phase = 'done'; leg.outcome = 'win'; leg.exit_ts = ts; leg.exit_price = e.target; leg.pnl_pts = e.target - leg.entry_price; }
    } else {
      const sH = high >= e.stop, tH = low <= e.target;
      const stopFill = e.stop + STOP_SLIPPAGE_PT;
      if (sH && tH) { leg.phase = 'done'; leg.outcome = 'loss'; leg.exit_ts = ts; leg.exit_price = stopFill; leg.pnl_pts = leg.entry_price - stopFill; }
      else if (sH) { leg.phase = 'done'; leg.outcome = 'loss'; leg.exit_ts = ts; leg.exit_price = stopFill; leg.pnl_pts = leg.entry_price - stopFill; }
      else if (tH) { leg.phase = 'done'; leg.outcome = 'win'; leg.exit_ts = ts; leg.exit_price = e.target; leg.pnl_pts = leg.entry_price - e.target; }
    }
  }
}

const onesPath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1s.csv`);
const scanStart = events.length ? events[0].fill_window_start : Date.now();
const MAX_FILL_MS = MAX_FILL_BARS * 3 * 60_000;
const scanEnd = (events.length ? events[events.length - 1].fill_window_start : Date.now()) + MAX_FILL_MS + MAX_HOLD_MS + 60000;
const minIso = new Date(scanStart).toISOString();
const maxIso = new Date(scanEnd).toISOString();

console.log(`Streaming 1s OHLCV...`);
const stream = fs.createReadStream(onesPath, { highWaterMark: 1 << 20 });
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
let header = null, scanned = 0;
let nextIdx = 0;
const live = [];
let fin = 0;
const tStart = Date.now();
for await (const line of rl) {
  if (!header) { header = line; continue; }
  scanned++;
  if (scanned % 10_000_000 === 0) {
    const sec = ((Date.now() - tStart) / 1000).toFixed(0);
    process.stdout.write(`  scanned ${(scanned / 1e6).toFixed(0)}M live=${live.length} fin=${fin.toLocaleString()} (${sec}s)\n`);
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

  while (nextIdx < events.length && events[nextIdx].fill_window_start <= ts) {
    const e = events[nextIdx];
    if (!e._activated) { e._activated = true; initEvent(e); live.push(e); }
    nextIdx++;
  }
  for (let i = live.length - 1; i >= 0; i--) {
    const e = live[i];
    processLeg(e, e.legs.A, ts, open, high, low, close, primary);
    processLeg(e, e.legs.B, ts, open, high, low, close, primary);
    if (e.legs.A.phase === 'done' && e.legs.B.phase === 'done') { e.allDone = true; live.splice(i, 1); fin++; }
  }
}
rl.close(); stream.destroy();
for (const e of live) {
  for (const k of ['A', 'B']) {
    const leg = e.legs[k];
    if (leg.phase === 'wait') { leg.phase = 'done'; leg.outcome = 'no_fill_eod'; }
    else if (leg.phase === 'active') { leg.phase = 'done'; leg.outcome = 'eod'; leg.exit_ts = leg.entry_ts; leg.exit_price = leg.entry_price; leg.pnl_pts = 0; }
  }
  fin++;
}
const sec = ((Date.now() - tStart) / 1000).toFixed(0);
console.log(`Done: scanned ${scanned.toLocaleString()} fin ${fin} (${sec}s)\n`);

// Write output
const cols = [
  'event_id', 'tf', 'flip_ts', 'direction', 'against', 'new_state',
  'flip_high', 'flip_low', 'range',
  'entryA', 'entryB',
  'A_outcome', 'A_entry_ts', 'A_exit_ts', 'A_pnl',
  'B_outcome', 'B_entry_ts', 'B_exit_ts', 'B_pnl',
  'combined_pnl', 'contracts_filled',
];
console.log('Writing...');
const ws = fs.createWriteStream(outPath);
ws.write(cols.join(',') + '\n');
let written = 0;
for (const e of events) {
  if (!e._activated) continue;
  const A = e.legs.A, B = e.legs.B;
  const aFill = A.entry_price != null && ['win', 'win_same_bar', 'loss', 'loss_same_bar', 'timeout'].includes(A.outcome);
  const bFill = B.entry_price != null && ['win', 'win_same_bar', 'loss', 'loss_same_bar', 'timeout'].includes(B.outcome);
  const aPnl = aFill ? (A.pnl_pts || 0) : 0;
  const bPnl = bFill ? (B.pnl_pts || 0) : 0;
  const combined = aPnl + bPnl;
  const contracts = (aFill ? 1 : 0) + (bFill ? 1 : 0);
  const row = [
    e.event_id, e.tf, e.flip_ts, e.direction, e.against ? 1 : 0, e.new_state,
    e.flip_high.toFixed(4), e.flip_low.toFixed(4), e.range.toFixed(4),
    e.entryA.toFixed(4), e.entryB.toFixed(4),
    A.outcome ?? '', A.entry_ts ?? '', A.exit_ts ?? '', aPnl.toFixed(4),
    B.outcome ?? '', B.entry_ts ?? '', B.exit_ts ?? '', bPnl.toFixed(4),
    combined.toFixed(4), contracts,
  ];
  ws.write(row.join(',') + '\n');
  written++;
}
ws.end();
await new Promise(r => ws.on('finish', r));
const stat = fs.statSync(outPath);
console.log(`Written: ${outPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB, ${written} rows)\n`);

// Quick summary
function summarizeStrat(events, getPnl, getContracts) {
  if (events.length === 0) return null;
  const sorted = events.slice().sort((a, b) => a.flip_ts - b.flip_ts);
  let n = 0, w = 0, l = 0, t = 0, pnl = 0, sumW = 0, sumL = 0, sumC = 0;
  let cum = 0, peak = 0, maxDD = 0;
  const returns = [];
  for (const e of sorted) {
    const p = getPnl(e);
    const c = getContracts(e);
    if (c === 0) continue; // never filled
    n++; pnl += p; sumC += c;
    if (p > 0) { w++; sumW += p; }
    else if (p < 0) { l++; sumL += -p; }
    else { t++; }
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
    returns.push(p);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length);
  const yrs = sorted.length > 1 ? (sorted[sorted.length - 1].flip_ts - sorted[0].flip_ts) / (365.25 * 24 * 3600 * 1000) : 0;
  const tpy = yrs > 0 ? n / yrs : 0;
  const ann = std > 0 ? (mean / std) * Math.sqrt(tpy) : 0;
  return { n, w, l, t, pnl, sumC, wr: n ? w/n*100 : 0, pf: sumL > 0 ? sumW/sumL : (sumW > 0 ? Infinity : 0), avg: n ? pnl/n : 0, annSharpe: ann, ddPct: peak > 0 ? maxDD/peak*100 : 0 };
}

// All filled events (combined PnL across both legs)
const all = events.filter(e => e._activated);
const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();
console.log(`\nSummary:`);
for (const tf of ['1m', '3m']) {
  for (const fil of [{ name: 'all', fn: () => true }, { name: 'against=N', fn: e => !e.against }]) {
    const sub = all.filter(e => e.tf === tf && fil.fn(e));
    const s = summarizeStrat(sub, e => {
      const a = e.legs.A, b = e.legs.B;
      const aF = a.entry_price != null && ['win', 'win_same_bar', 'loss', 'loss_same_bar', 'timeout'].includes(a.outcome);
      const bF = b.entry_price != null && ['win', 'win_same_bar', 'loss', 'loss_same_bar', 'timeout'].includes(b.outcome);
      return (aF ? a.pnl_pts : 0) + (bF ? b.pnl_pts : 0);
    }, e => {
      const a = e.legs.A, b = e.legs.B;
      const aF = a.entry_price != null && ['win', 'win_same_bar', 'loss', 'loss_same_bar', 'timeout'].includes(a.outcome);
      const bF = b.entry_price != null && ['win', 'win_same_bar', 'loss', 'loss_same_bar', 'timeout'].includes(b.outcome);
      return (aF ? 1 : 0) + (bF ? 1 : 0);
    });
    if (!s) continue;
    console.log(`  ${tf} ${fil.name}: n_filled=${s.n} contracts=${s.sumC} WR_combined=${s.wr.toFixed(1)}% PF=${s.pf.toFixed(2)} Sharpe=${s.annSharpe.toFixed(2)} DD%=${s.ddPct.toFixed(2)} sum=${s.pnl.toFixed(0)}pt ($${(s.pnl * 20 / 1000).toFixed(1)}k)`);
  }
}
