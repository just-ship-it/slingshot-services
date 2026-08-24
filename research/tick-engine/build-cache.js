#!/usr/bin/env node
/**
 * T1 — build the columnar binary 1s cache used by the tick engine.
 *
 *   node build-cache.js --product NQ [--out <dir>] [--limit N]
 *
 * Source: backtest-engine/data/ohlcv/<prod>/<PROD>_ohlcv_1s.csv (raw contracts, MANY symbols per
 * timestamp + calendar spreads). Per CLAUDE.md this MUST be reduced to the primary contract:
 * calendar spreads (symbol contains '-') are dropped and, per clock hour, only the highest-volume
 * contract's bars are kept. Contract changes are recorded explicitly as rollovers.
 *
 * Output (one directory per product, structure-of-arrays so columns mmap independently):
 *   ts.i32   epoch SECONDS (bar open)
 *   o/h/l/c.i32   price in TICKS (price / tickSize) — exact integers, no float error
 *   v.i32    volume
 *   sym.u8   index into meta.symbols
 *   meta.json  { product, tickSize, nBars, symbols[], days: {tradeDate: [start,end)}, rollovers[] }
 *
 * Prices as integer ticks keep the hot loop in integer compares and make "price == level" exact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionInfo, toEt } from '../../shared/pattern-engine/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) =>
  a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));

const PRODUCT = (args.product || 'NQ').toUpperCase();
const TICK = 0.25;
const SRC = path.join(ROOT, `backtest-engine/data/ohlcv/${PRODUCT.toLowerCase()}/${PRODUCT}_ohlcv_1s.csv`);
const OUT = args.out || path.join(__dirname, 'cache', PRODUCT);
const LIMIT = args.limit ? +args.limit : Infinity;
fs.mkdirSync(OUT, { recursive: true });

// ---------- fast parsers ----------
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
const D = (s, i) => s.charCodeAt(i) - 48;
/** "2021-01-26T00:00:00.000000000Z" → epoch seconds */
function parseTs(s) {
  const y = D(s, 0) * 1000 + D(s, 1) * 100 + D(s, 2) * 10 + D(s, 3);
  const mo = D(s, 5) * 10 + D(s, 6);
  const da = D(s, 8) * 10 + D(s, 9);
  const hh = D(s, 11) * 10 + D(s, 12);
  const mi = D(s, 14) * 10 + D(s, 15);
  const ss = D(s, 17) * 10 + D(s, 18);
  return daysFromCivil(y, mo, da) * 86400 + hh * 3600 + mi * 60 + ss;
}
/** "3845.250000000" (from a to b) → integer ticks. Assumes tick 0.25. */
function parseTicks(s, a, b) {
  let ip = 0, i = a;
  for (; i < b; i++) { const ch = s.charCodeAt(i); if (ch === 46) break; ip = ip * 10 + (ch - 48); }
  let thou = 0, k = 0;
  for (i++; i < b && k < 3; i++, k++) thou = thou * 10 + (s.charCodeAt(i) - 48);
  while (k++ < 3) thou *= 10;
  return ip * 4 + Math.round(thou / 250);
}

// ---------- output buffers ----------
const CHUNK = 4_000_000;
const col = {
  ts: new Int32Array(CHUNK), o: new Int32Array(CHUNK), h: new Int32Array(CHUNK),
  l: new Int32Array(CHUNK), c: new Int32Array(CHUNK), v: new Int32Array(CHUNK), sym: new Uint8Array(CHUNK),
};
const fds = {};
for (const k of Object.keys(col)) fds[k] = fs.openSync(path.join(OUT, `${k}.${k === 'sym' ? 'u8' : 'i32'}`), 'w');
let cn = 0, total = 0;
function flushCols() {
  if (!cn) return;
  for (const k of Object.keys(col)) {
    const a = col[k];
    fs.writeSync(fds[k], Buffer.from(a.buffer, a.byteOffset, cn * a.BYTES_PER_ELEMENT));
  }
  total += cn; cn = 0;
}
function emit(ts, o, h, l, c, v, sym) {
  col.ts[cn] = ts; col.o[cn] = o; col.h[cn] = h; col.l[cn] = l; col.c[cn] = c; col.v[cn] = v; col.sym[cn] = sym;
  if (++cn === CHUNK) flushCols();
}

// ---------- hour buffer (primary-contract selection) ----------
const symbols = [];
const symIdx = new Map();
function symId(name) {
  let i = symIdx.get(name);
  if (i === undefined) { i = symbols.length; symbols.push(name); symIdx.set(name, i); }
  return i;
}
const HB = 200_000;                 // rows per hour ceiling (1s × multiple contracts)
const hb = { ts: new Int32Array(HB), o: new Int32Array(HB), h: new Int32Array(HB), l: new Int32Array(HB), c: new Int32Array(HB), v: new Int32Array(HB), s: new Int32Array(HB) };
let hn = 0, curHour = -1;
const hourVol = new Map();
const days = {};                    // tradeDate → [startRow, endRow)
const rollovers = [];
let lastSym = -1, dropped = 0, spreads = 0;

function flushHour() {
  if (!hn) return;
  let best = -1, bestV = -1;
  for (const [s, vol] of hourVol) if (vol > bestV) { bestV = vol; best = s; }
  const startRow = total + cn;
  for (let i = 0; i < hn; i++) {
    if (hb.s[i] !== best) { dropped++; continue; }
    if (hb.s[i] !== lastSym) {
      if (lastSym !== -1) rollovers.push({ row: total + cn, from: symbols[lastSym], to: symbols[hb.s[i]], ts: hb.ts[i] });
      lastSym = hb.s[i];
    }
    emit(hb.ts[i], hb.o[i], hb.h[i], hb.l[i], hb.c[i], hb.v[i], hb.s[i]);
  }
  const endRow = total + cn;
  if (endRow > startRow) {
    const ms = hb.ts[0] * 1000;
    const td = new Date(toEt(sessionInfo(ms).ssUtc) + 23 * 3600_000).toISOString().slice(0, 10);
    const d = days[td];
    if (d) d[1] = endRow; else days[td] = [startRow, endRow];
  }
  hn = 0; hourVol.clear();
}

// ---------- stream ----------
const t0 = Date.now();
const fd = fs.openSync(SRC, 'r');
const BUF = Buffer.allocUnsafe(1 << 24);
let leftover = '', header = true, bytes = 0, rows = 0;
for (;;) {
  const got = fs.readSync(fd, BUF, 0, BUF.length, null);
  if (!got) break;
  bytes += got;
  const chunk = leftover + BUF.toString('latin1', 0, got);
  let start = 0;
  for (;;) {
    const nl = chunk.indexOf('\n', start);
    if (nl < 0) { leftover = chunk.slice(start); break; }
    const line = chunk.slice(start, nl);
    start = nl + 1;
    if (header) { header = false; continue; }
    if (!line) continue;
    rows++;
    // ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
    const f = [];
    let p = 0;
    for (let k = 0; k < 9; k++) { const q = line.indexOf(',', p); f.push(p, q); p = q + 1; }
    const sym = line.slice(p);
    if (sym.indexOf('-') >= 0) { spreads++; continue; }          // calendar spread: a price DIFFERENCE, not a quote
    const ts = parseTs(line);
    const hour = (ts / 3600) | 0;
    if (hour !== curHour) { flushHour(); curHour = hour; }
    const s = symId(sym);
    const vol = +line.slice(f[16], f[17]);
    hb.ts[hn] = ts;
    hb.o[hn] = parseTicks(line, f[8], f[9]);
    hb.h[hn] = parseTicks(line, f[10], f[11]);
    hb.l[hn] = parseTicks(line, f[12], f[13]);
    hb.c[hn] = parseTicks(line, f[14], f[15]);
    hb.v[hn] = vol;
    hb.s[hn] = s;
    hourVol.set(s, (hourVol.get(s) || 0) + vol);
    if (++hn >= HB) { console.error('hour buffer overflow'); process.exit(1); }
    if (total + cn >= LIMIT) { leftover = ''; break; }
  }
  if (total + cn >= LIMIT) break;
  if (rows % 20_000_000 < 100_000) process.stderr.write(`  ${(bytes / 1e9).toFixed(1)}GB, ${(rows / 1e6).toFixed(0)}M rows → ${((total + cn) / 1e6).toFixed(1)}M bars, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}
flushHour(); flushCols();
fs.closeSync(fd);
for (const k of Object.keys(fds)) fs.closeSync(fds[k]);
const meta = {
  product: PRODUCT, tickSize: TICK, nBars: total, symbols, rollovers,
  days, builtAt: new Date().toISOString(), source: path.basename(SRC),
  srcRows: rows, droppedNonPrimary: dropped, droppedSpreads: spreads,
  columns: { ts: 'i32 epoch seconds', o: 'i32 ticks', h: 'i32 ticks', l: 'i32 ticks', c: 'i32 ticks', v: 'i32', sym: 'u8 → symbols[]' },
};
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta));
const secs = (Date.now() - t0) / 1000;
console.log(`${PRODUCT}: ${(rows / 1e6).toFixed(1)}M source rows → ${(total / 1e6).toFixed(2)}M primary bars in ${secs.toFixed(0)}s ` +
            `(${(rows / secs / 1e6).toFixed(2)}M rows/s); dropped ${(dropped / 1e6).toFixed(1)}M non-primary, ${(spreads / 1e3).toFixed(0)}k spreads; ` +
            `${symbols.length} contracts, ${rollovers.length} rollovers, ${Object.keys(days).length} sessions → ${OUT}`);
