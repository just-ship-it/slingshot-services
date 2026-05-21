/**
 * Phase 1 — Walk each gold-standard trade's fill instant forward in 1s OHLCV.
 *
 * Now records per-bar (high, low, close) signed offsets from entry so the
 * simulator can detect trail/BE retracements accurately (not just MFE/MAE
 * extremes).
 *
 * Output: per trade an array of [t_sec, hi_pts, lo_pts, c_pts] tuples where
 * pts are signed PnL from entry (favorable = positive for long, etc.).
 * Trades record both side and contract; simulator normalizes per-direction.
 *
 * Emit policy:
 *   - First bar at/after fillTs: always emit
 *   - Each subsequent bar within MAX_HOLD: emit if (hi or lo or c) differ
 *     from previous emitted sample by >= EMIT_STEP (0.25pt default)
 *   - On EOD (15:45 ET): emit eod snapshot, terminate
 *   - On contract change: skip (don't terminate; many trades cross hours
 *     but stay on the same contract)
 *
 * Mandatory 1s-honest constraint: stop/target/trail/BE evaluation walks
 * forward in 1s from fill instant.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');   // = backtest-engine
const DATA_DIR = path.join(ROOT, 'data');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
const GS_PATH = arg('gold', path.join(DATA_DIR, 'gold-standard', 'ls-flip-trigger-bar-v2.json'));
const OUT_PATH = arg('out', path.join(__dirname, 'output', '01-trades-walk.json'));
const MAX_HOLD_MIN = +arg('max_hold', '60');
const EMIT_STEP = +arg('emit_step', '0.25');
const EOD_ET_HH = 15;
const EOD_ET_MM = 45;
const MAX_HOLD_MS = MAX_HOLD_MIN * 60_000;

console.log(`\n=== Walk fill instants (1s honest, per-bar OHLC) ===`);
console.log(`Gold standard: ${GS_PATH}`);
console.log(`Output: ${OUT_PATH}`);
console.log(`Max hold: ${MAX_HOLD_MIN}min  Emit step: ${EMIT_STEP}pt  EOD: 15:45 ET\n`);

const gs = JSON.parse(fs.readFileSync(GS_PATH, 'utf-8'));
const trades = gs.trades.filter(t => t.status === 'completed' && t.actualEntry != null && t.entryTime != null);
console.log(`Trades to walk: ${trades.length}`);

function eodForDate(ts) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(ts));
  const y = +parts.find(p => p.type === 'year').value;
  const m = +parts.find(p => p.type === 'month').value;
  const d = +parts.find(p => p.type === 'day').value;
  for (const off of [-4, -5]) {
    const guess = Date.UTC(y, m - 1, d, EOD_ET_HH - off, EOD_ET_MM, 0, 0);
    const check = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(guess));
    if (+check.find(p => p.type === 'year').value === y &&
        +check.find(p => p.type === 'month').value === m &&
        +check.find(p => p.type === 'day').value === d &&
        +check.find(p => p.type === 'hour').value === EOD_ET_HH &&
        +check.find(p => p.type === 'minute').value === EOD_ET_MM) return guess;
  }
  return null;
}

function etHour(ts) {
  return parseInt(new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
}

const events = trades.map((t, idx) => {
  const fillTs = t.entryTime;
  const entry = t.actualEntry;
  const direction = t.side === 'buy' ? 'long' : 'short';
  return {
    event_id: idx,
    trade_id: t.id,
    side: t.side,
    direction,
    fillTs,
    entry,
    sl: t.stopLoss,
    tp: t.takeProfit,
    contract: t.signal?.signalContract,
    eodTs: eodForDate(fillTs),
    eodPrice: null,
    walk: [],       // [ [t_sec, hi, lo, c], ... ] signed favorable-positive
    lastEmit: null, // [hi, lo, c]
    finalTs: null,
    terminal: null,
    triggerBarRange: t.metadata?.triggerBar?.range || null,
    triggerBarHigh: t.metadata?.triggerBar?.high || null,
    triggerBarLow: t.metadata?.triggerBar?.low || null,
    triggerBarOpen: t.metadata?.triggerBar?.open || null,
    triggerBarClose: t.metadata?.triggerBar?.close || null,
    cbAtr: t.metadata?.cbAtr || null,
    atr20: t.metadata?.atr20 || null,
    rangeRatio: (t.metadata?.triggerBar?.range && t.metadata?.atr20)
      ? t.metadata.triggerBar.range / t.metadata.atr20 : null,
    hourEt: etHour(fillTs),
    flipTs: t.metadata?.flipTs || null,
  };
}).sort((a, b) => a.fillTs - b.fillTs);

const minFill = events[0].fillTs;
const maxFinish = events[events.length - 1].fillTs + MAX_HOLD_MS + 24 * 3600_000;
console.log(`Time range: ${new Date(minFill).toISOString()} → ${new Date(maxFinish).toISOString()}`);

const onesPath = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1s.csv');
const minIso = new Date(minFill).toISOString();
const maxIso = new Date(maxFinish).toISOString();
console.log(`Streaming 1s (${minIso} → ${maxIso})...`);

const stream = fs.createReadStream(onesPath, { highWaterMark: 1 << 20 });
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
let header = null, scanned = 0;
let nextIdx = 0;
const live = [];
let finalized = 0;
const tStart = Date.now();

function favSigned(e, h, l, c) {
  // Return signed favorable-positive PnL offsets [hi, lo, c]
  if (e.direction === 'long') return [h - e.entry, l - e.entry, c - e.entry];
  // Short: favorable is when price goes down. high → least favorable, low → most favorable
  return [e.entry - l, e.entry - h, e.entry - c];   // hi=fav-extreme, lo=adv-extreme, c=close-signed
}

function pushBar(e, ts, h, l, c) {
  // Compute signed (hi=fav-extreme, lo=adv-extreme, c=close-favorable-signed)
  const [hi, lo, cv] = favSigned(e, h, l, c);
  const tSec = Math.round((ts - e.fillTs) / 1000);
  if (e.walk.length === 0) {
    e.walk.push([tSec, +hi.toFixed(2), +lo.toFixed(2), +cv.toFixed(2)]);
    e.lastEmit = [hi, lo, cv];
    return;
  }
  const [lh, ll, lc] = e.lastEmit;
  if (Math.abs(hi - lh) >= EMIT_STEP || Math.abs(lo - ll) >= EMIT_STEP || Math.abs(cv - lc) >= EMIT_STEP) {
    e.walk.push([tSec, +hi.toFixed(2), +lo.toFixed(2), +cv.toFixed(2)]);
    e.lastEmit = [hi, lo, cv];
  }
}

for await (const line of rl) {
  if (!header) { header = line; continue; }
  scanned++;
  if (scanned % 20_000_000 === 0) {
    const sec = ((Date.now() - tStart) / 1000).toFixed(0);
    process.stdout.write(`  scanned ${(scanned/1e6).toFixed(0)}M  live=${live.length}  fin=${finalized.toLocaleString()}  (${sec}s)\n`);
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
  const open = +parts[4], high = +parts[5], low = +parts[6], close = +parts[7];
  if (isNaN(close)) continue;
  const ts = new Date(tsStr).getTime();

  while (nextIdx < events.length && events[nextIdx].fillTs <= ts) {
    const e = events[nextIdx];
    e._activated = true;
    e._maxHoldEnd = e.fillTs + MAX_HOLD_MS;
    live.push(e);
    nextIdx++;
  }

  for (let i = live.length - 1; i >= 0; i--) {
    const e = live[i];
    if (symbol !== e.contract) continue;
    if (e.eodTs != null && ts >= e.eodTs && e.eodPrice == null) {
      e.eodPrice = close;
    }
    if (ts > e._maxHoldEnd || (e.eodTs != null && ts >= e.eodTs)) {
      // Push final bar then terminate
      pushBar(e, ts, high, low, close);
      e.terminal = ts > e._maxHoldEnd ? 'maxhold' : 'eod';
      e.finalTs = ts;
      live.splice(i, 1); finalized++;
      continue;
    }
    pushBar(e, ts, high, low, close);
  }
}
rl.close(); stream.destroy();
for (const e of live) {
  e.terminal = e.terminal || 'eod_late';
  e.finalTs = e.finalTs || e.fillTs + MAX_HOLD_MS;
  finalized++;
}
const sec = ((Date.now() - tStart) / 1000).toFixed(0);
console.log(`Done streaming: ${scanned.toLocaleString()} lines, ${finalized} events finalized (${sec}s)`);

console.log(`Writing ${events.length} events to ${OUT_PATH}...`);
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
const slimmed = events.map(e => ({
  id: e.event_id,
  tradeId: e.trade_id,
  side: e.side,
  direction: e.direction,
  fillTs: e.fillTs,
  entry: e.entry,
  sl: e.sl,
  tp: e.tp,
  contract: e.contract,
  eodTs: e.eodTs,
  eodPrice: e.eodPrice,
  finalTs: e.finalTs,
  terminal: e.terminal,
  triggerBarRange: e.triggerBarRange,
  triggerBarHigh: e.triggerBarHigh,
  triggerBarLow: e.triggerBarLow,
  triggerBarOpen: e.triggerBarOpen,
  triggerBarClose: e.triggerBarClose,
  cbAtr: e.cbAtr,
  atr20: e.atr20,
  rangeRatio: e.rangeRatio,
  hourEt: e.hourEt,
  flipTs: e.flipTs,
  walk: e.walk,
}));
fs.writeFileSync(OUT_PATH, JSON.stringify(slimmed));
const stat = fs.statSync(OUT_PATH);
console.log(`Wrote ${OUT_PATH} (${(stat.size / 1024 / 1024).toFixed(1)} MB)\n`);

const exitMap = {};
const ws = [];
for (const e of slimmed) {
  exitMap[e.terminal] = (exitMap[e.terminal] || 0) + 1;
  ws.push(e.walk.length);
}
console.log('Terminals:', exitMap);
ws.sort((a,b)=>a-b);
console.log('Walk sizes: p25=' + ws[Math.floor(ws.length*0.25)] + ' med=' + ws[Math.floor(ws.length*0.5)] + ' p75=' + ws[Math.floor(ws.length*0.75)] + ' p99=' + ws[Math.floor(ws.length*0.99)] + ' max=' + ws[ws.length-1]);
