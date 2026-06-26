/**
 * Precompute store for the vol-compression breakout (stream the 8.3GB 1s file ONCE).
 * RTH-only (09:30–16:00 ET), per-DAY front contract (max-volume symbol that day → no intraday
 * contract mixing, no roll-jump). Drops calendar spreads (symbol contains '-').
 *
 * Produces:
 *   output/days.NQ.json — per day: {date,symbol,rthOpenMs,rthCloseMs,prevClose, mOpen/mHigh/mLow/mClose/mVol[390]}
 *   output/rth1s.NQ.bin — flat rows, chronological: uint16 dayIdx | uint16 sec(0..23399) |
 *                          f32 open | f32 high | f32 low | f32 close   (20 bytes/row)
 *
 * Usage: node 01-precompute.js --start 2025-01-13 --end 2026-04-23
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { getRTHOpenTime, getRTHCloseTime, getTradingDays } from '../../src/ai/session-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const TICKER = 'NQ';
const START = arg('start', '2025-01-13'), END = arg('end', '2026-04-23');
const RTH_MIN = 390, RTH_SEC = RTH_MIN * 60; // 23400

const oneMinPath = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
const oneSecPath = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1s.csv');

const tradingDays = getTradingDays(START, END);
const days = tradingDays.map(d => ({
  date: d, rthOpenMs: getRTHOpenTime(d), rthCloseMs: getRTHCloseTime(d),
  symbol: null, prevClose: NaN,
  mOpen: new Float64Array(RTH_MIN).fill(NaN), mHigh: new Float64Array(RTH_MIN).fill(NaN),
  mLow: new Float64Array(RTH_MIN).fill(NaN), mClose: new Float64Array(RTH_MIN).fill(NaN), mVol: new Float64Array(RTH_MIN).fill(0),
}));
days.sort((a, b) => a.rthOpenMs - b.rthOpenMs);
const minIso = new Date(days[0].rthOpenMs).toISOString();
const maxIso = new Date(days[days.length - 1].rthCloseMs).toISOString();

// ---- PASS 1: per-day total volume per symbol → front contract; collect RTH 1m OHLC (front only later) ----
console.log(`Pass 1: 1m → per-day front contract + 1m OHLC ...`);
const dayVol = new Map(); // dayIdx -> Map(symbol->vol)
{
  const rl = readline.createInterface({ input: fs.createReadStream(oneMinPath, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  let header = null, di = 0;
  for await (const line of rl) {
    if (!header) { header = line; continue; }
    const c0 = line.indexOf(','); if (c0 < 0) continue;
    const tsStr = line.slice(0, c0);
    if (tsStr < minIso) continue; if (tsStr > maxIso) break;
    const parts = line.split(','); if (parts.length < 10) continue;
    const symbol = parts[9]; if (symbol.includes('-')) continue;
    const ts = new Date(tsStr).getTime();
    while (di < days.length - 1 && ts >= days[di + 1].rthOpenMs) di++;
    const day = days[di];
    if (ts < day.rthOpenMs || ts >= day.rthCloseMs) continue;
    const vol = +parts[8] || 0;
    let dv = dayVol.get(di); if (!dv) { dv = new Map(); dayVol.set(di, dv); }
    dv.set(symbol, (dv.get(symbol) || 0) + vol);
  }
  rl.close();
}
for (const [di, dv] of dayVol) { let bs = '', bv = -1; for (const [s, v] of dv) if (v > bv) { bv = v; bs = s; } days[di].symbol = bs; }
console.log(`  front contracts: ${[...new Set(days.map(d => d.symbol).filter(Boolean))].join(', ')}`);

// PASS 1b: now collect RTH 1m OHLC for the per-day front contract
{
  const rl = readline.createInterface({ input: fs.createReadStream(oneMinPath, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  let header = null, di = 0;
  for await (const line of rl) {
    if (!header) { header = line; continue; }
    const c0 = line.indexOf(','); if (c0 < 0) continue;
    const tsStr = line.slice(0, c0);
    if (tsStr < minIso) continue; if (tsStr > maxIso) break;
    const parts = line.split(','); if (parts.length < 10) continue;
    const symbol = parts[9]; if (symbol.includes('-')) continue;
    const ts = new Date(tsStr).getTime();
    while (di < days.length - 1 && ts >= days[di + 1].rthOpenMs) di++;
    const day = days[di];
    if (symbol !== day.symbol) continue;
    if (ts < day.rthOpenMs || ts >= day.rthCloseMs) continue;
    const m = Math.floor((ts - day.rthOpenMs) / 60000);
    if (m < 0 || m >= RTH_MIN) continue;
    day.mOpen[m] = +parts[4]; day.mHigh[m] = +parts[5]; day.mLow[m] = +parts[6]; day.mClose[m] = +parts[7]; day.mVol[m] = +parts[8] || 0;
  }
  rl.close();
}
// fill-forward 1m gaps (carry last close as flat bar) + prevClose
for (const day of days) {
  let last = NaN;
  for (let m = 0; m < RTH_MIN; m++) { if (!isNaN(day.mClose[m])) last = day.mClose[m]; else if (!isNaN(last)) { day.mOpen[m] = day.mHigh[m] = day.mLow[m] = day.mClose[m] = last; day.mVol[m] = 0; } }
}
for (let i = 1; i < days.length; i++) days[i].prevClose = days[i - 1].mClose[RTH_MIN - 1];

// ---- PASS 2: 1s → rth1s.bin (dayIdx, sec, o,h,l,c) for per-day front contract ----
console.log(`Pass 2: 1s → rth1s.NQ.bin ...`);
const ROW = 20;
const outBin = path.join(__dirname, 'output', 'rth1s.NQ.bin');
const ws = fs.createWriteStream(outBin);
let buf = Buffer.allocUnsafe(ROW * 100000), bo = 0, rows = 0;
function emit(di, sec, o, h, l, c) {
  if (bo + ROW > buf.length) { ws.write(buf.subarray(0, bo)); buf = Buffer.allocUnsafe(ROW * 100000); bo = 0; }
  buf.writeUInt16LE(di, bo); buf.writeUInt16LE(sec, bo + 2);
  buf.writeFloatLE(o, bo + 4); buf.writeFloatLE(h, bo + 8); buf.writeFloatLE(l, bo + 12); buf.writeFloatLE(c, bo + 16); bo += ROW; rows++;
}
{
  const rl = readline.createInterface({ input: fs.createReadStream(oneSecPath, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  let header = null, di = 0, scanned = 0; const tStart = Date.now();
  for await (const line of rl) {
    if (!header) { header = line; continue; }
    if ((++scanned) % 50000000 === 0) process.stdout.write(`  ${(scanned / 1e6).toFixed(0)}M rows, ${(rows / 1e6).toFixed(1)}M kept (${((Date.now() - tStart) / 1000).toFixed(0)}s)\n`);
    const c0 = line.indexOf(','); if (c0 < 0) continue;
    const tsStr = line.slice(0, c0);
    if (tsStr < minIso) continue; if (tsStr > maxIso) break;
    const parts = line.split(','); if (parts.length < 10) continue;
    const symbol = parts[9]; if (symbol.includes('-')) continue;
    const ts = new Date(tsStr).getTime();
    while (di < days.length - 1 && ts >= days[di + 1].rthOpenMs) di++;
    const day = days[di];
    if (symbol !== day.symbol) continue;
    if (ts < day.rthOpenMs || ts >= day.rthCloseMs) continue;
    const sec = Math.floor((ts - day.rthOpenMs) / 1000);
    if (sec < 0 || sec >= RTH_SEC) continue;
    const o = +parts[4], h = +parts[5], l = +parts[6], c = +parts[7];
    if (isNaN(c)) continue;
    emit(di, sec, o, h, l, c);
  }
  rl.close();
  if (bo > 0) ws.write(buf.subarray(0, bo));
  ws.end(); await new Promise(r => ws.on('finish', r));
  console.log(`  wrote ${rows.toLocaleString()} 1s rows (${(fs.statSync(outBin).size / 1e6).toFixed(0)}MB) in ${((Date.now() - tStart) / 1000).toFixed(0)}s`);
}

const daysOut = days.map(d => ({ date: d.date, symbol: d.symbol, rthOpenMs: d.rthOpenMs, rthCloseMs: d.rthCloseMs, prevClose: +d.prevClose.toFixed(4),
  mOpen: Array.from(d.mOpen, x => +x.toFixed(4)), mHigh: Array.from(d.mHigh, x => +x.toFixed(4)), mLow: Array.from(d.mLow, x => +x.toFixed(4)), mClose: Array.from(d.mClose, x => +x.toFixed(4)), mVol: Array.from(d.mVol, x => +x.toFixed(0)) }));
fs.writeFileSync(path.join(__dirname, 'output', 'days.NQ.json'), JSON.stringify({ ticker: TICKER, start: START, end: END, rthMin: RTH_MIN, days: daysOut }));
console.log(`  wrote days.NQ.json (${days.length} days)\nDone.`);
