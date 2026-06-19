/**
 * Precompute RTH 1s feature store for fast sweeps (stream the 6.9GB 1s file ONCE).
 *
 * Produces:
 *   output/days.json   — per-day band inputs: {date, open, prevClose, mClose[390], rthOpenMs, rthCloseMs}
 *   output/rth1s.bin    — flat binary of every RTH primary 1s bar, chronological:
 *                          uint16 dayIdx | uint16 secOfDay(0..23399) | float32 close | float32 vwap
 *                          (12 bytes/row). VWAP is full-RTH session VWAP (reset 09:30 ET).
 *
 * Then 03-sweep.js recomputes bands per (lookback, mult) from days.json and replays
 * rth1s.bin in-memory (~1-3s/variant) — no re-streaming.
 *
 * Usage: node 02-precompute-rth-1s.js --ticker ES --start 2021-02-01 --end 2026-01-23
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

const TICKER = arg('ticker', 'ES').toUpperCase();
const START = arg('start', '2021-02-01');
const END = arg('end', '2026-01-23');
const RTH_MIN = 390, RTH_SEC = RTH_MIN * 60; // 23400

const oneMinPath = path.join(DATA_DIR, 'ohlcv', TICKER.toLowerCase(), `${TICKER}_ohlcv_1m.csv`);
const oneSecPath = path.join(DATA_DIR, 'ohlcv', TICKER.toLowerCase(), `${TICKER}_ohlcv_1s.csv`);
const startMs = new Date(START + 'T00:00:00Z').getTime();
const endMs = new Date(END + 'T00:00:00Z').getTime() + 24 * 3600000;

const tradingDays = getTradingDays(START, END);
const days = tradingDays.map(d => ({
  date: d, rthOpenMs: getRTHOpenTime(d), rthCloseMs: getRTHCloseTime(d),
  open: NaN, prevClose: NaN, mClose: new Float64Array(RTH_MIN).fill(NaN),
}));
days.sort((a, b) => a.rthOpenMs - b.rthOpenMs);

// ---- PASS 1: 1m → per-day open / mClose matrix + primary-by-hour ----
const hourVol = new Map();
console.log(`Pass 1: 1m → day matrix (${path.basename(oneMinPath)}) ...`);
{
  const rl = readline.createInterface({ input: fs.createReadStream(oneMinPath, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  let header = null, di = 0;
  const minIso = new Date(startMs).toISOString(), maxIso = new Date(endMs).toISOString();
  for await (const line of rl) {
    if (!header) { header = line; continue; }
    const c0 = line.indexOf(','); if (c0 < 0) continue;
    const tsStr = line.slice(0, c0);
    if (tsStr < minIso) continue; if (tsStr > maxIso) break;
    const parts = line.split(','); if (parts.length < 10) continue;
    const symbol = parts[9]; if (symbol.includes('-')) continue;
    const ts = new Date(tsStr).getTime();
    const open = +parts[4], close = +parts[7], volume = +parts[8] || 0;
    const hb = Math.floor(ts / 3600000);
    let hv = hourVol.get(hb); if (!hv) { hv = new Map(); hourVol.set(hb, hv); }
    hv.set(symbol, (hv.get(symbol) || 0) + volume);
    while (di < days.length - 1 && ts >= days[di + 1].rthOpenMs) di++;
    const day = days[di];
    if (ts >= day.rthOpenMs && ts < day.rthCloseMs) {
      const m = Math.floor((ts - day.rthOpenMs) / 60000);
      if (m >= 0 && m < RTH_MIN) { if (m === 0 && isNaN(day.open)) day.open = open; day.mClose[m] = close; }
    }
  }
  rl.close();
}
const primaryByHour = new Map();
for (const [hb, hv] of hourVol.entries()) { let bs = '', bv = -1; for (const [s, v] of hv.entries()) if (v > bv) { bv = v; bs = s; } primaryByHour.set(hb, bs); }
// fill-forward + prevClose
for (const day of days) {
  if (isNaN(day.open)) for (let m = 0; m < RTH_MIN; m++) if (!isNaN(day.mClose[m])) { day.open = day.mClose[m]; break; }
  let last = day.open;
  for (let m = 0; m < RTH_MIN; m++) { if (isNaN(day.mClose[m])) day.mClose[m] = last; else last = day.mClose[m]; }
}
for (let i = 1; i < days.length; i++) days[i].prevClose = days[i - 1].mClose[RTH_MIN - 1];
console.log(`  ${days.length} days, primary map ${primaryByHour.size} hours`);

// ---- PASS 2: 1s → rth1s.bin (dayIdx, secOfDay, close, vwap) ----
console.log(`Pass 2: 1s → rth1s.bin (${path.basename(oneSecPath)}) ...`);
const ROW = 12; // bytes
const outBin = path.join(__dirname, 'output', `rth1s.${TICKER}.bin`);
fs.mkdirSync(path.dirname(outBin), { recursive: true });
const ws = fs.createWriteStream(outBin);
let buf = Buffer.allocUnsafe(ROW * 100000), bo = 0, rows = 0;
function emit(dayIdx, sec, close, vwap) {
  if (bo + ROW > buf.length) { ws.write(buf.subarray(0, bo)); buf = Buffer.allocUnsafe(ROW * 100000); bo = 0; }
  buf.writeUInt16LE(dayIdx, bo); buf.writeUInt16LE(sec, bo + 2);
  buf.writeFloatLE(close, bo + 4); buf.writeFloatLE(vwap, bo + 8); bo += ROW; rows++;
}
{
  const rl = readline.createInterface({ input: fs.createReadStream(oneSecPath, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  let header = null, di = 0, scanned = 0;
  let pvSum = 0, vSum = 0, curDi = -1;
  const tStart = Date.now();
  const minIso = new Date(days[0].rthOpenMs).toISOString();
  const maxIso = new Date(days[days.length - 1].rthCloseMs).toISOString();
  for await (const line of rl) {
    if (!header) { header = line; continue; }
    scanned++;
    if (scanned % 25000000 === 0) process.stdout.write(`  ${(scanned / 1e6).toFixed(0)}M rows, ${(rows / 1e6).toFixed(1)}M kept (${((Date.now() - tStart) / 1000).toFixed(0)}s)\n`);
    const c0 = line.indexOf(','); if (c0 < 0) continue;
    const tsStr = line.slice(0, c0);
    if (tsStr < minIso) continue; if (tsStr > maxIso) break;
    const parts = line.split(','); if (parts.length < 10) continue;
    const symbol = parts[9]; if (symbol.includes('-')) continue;
    const ts = new Date(tsStr).getTime();
    while (di < days.length - 1 && ts >= days[di + 1].rthOpenMs) di++;
    const day = days[di];
    if (ts < day.rthOpenMs || ts >= day.rthCloseMs) continue;
    const hb = Math.floor(ts / 3600000); const ps = primaryByHour.get(hb);
    if (ps && symbol !== ps) continue;
    const high = +parts[5], low = +parts[6], close = +parts[7], volume = +parts[8] || 0;
    if (isNaN(close)) continue;
    if (di !== curDi) { pvSum = 0; vSum = 0; curDi = di; } // session VWAP reset
    const typical = (high + low + close) / 3;
    pvSum += typical * volume; vSum += volume;
    const vwap = vSum > 0 ? pvSum / vSum : close;
    const sec = Math.floor((ts - day.rthOpenMs) / 1000);
    if (sec < 0 || sec >= RTH_SEC) continue;
    emit(di, sec, close, vwap);
  }
  rl.close();
  if (bo > 0) ws.write(buf.subarray(0, bo));
  ws.end();
  await new Promise(r => ws.on('finish', r));
  console.log(`  wrote ${rows.toLocaleString()} rows (${(fs.statSync(outBin).size / 1e6).toFixed(0)}MB) in ${((Date.now() - tStart) / 1000).toFixed(0)}s`);
}

// ---- days.json ----
const daysOut = days.map(d => ({ date: d.date, open: d.open, prevClose: d.prevClose, rthOpenMs: d.rthOpenMs, rthCloseMs: d.rthCloseMs, mClose: Array.from(d.mClose, x => +x.toFixed(4)) }));
const outDays = path.join(__dirname, 'output', `days.${TICKER}.json`);
fs.writeFileSync(outDays, JSON.stringify({ ticker: TICKER, start: START, end: END, rthMin: RTH_MIN, days: daysOut }));
console.log(`  wrote ${outDays} (${days.length} days)\nDone.`);
