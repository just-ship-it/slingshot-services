/**
 * Phase 6 helper — Precompute intra-minute s1 features.
 *
 * For every primary-contract 1m bar in the date range, compute:
 *   - vwap_minute: volume-weighted average of (h+l+c)/3 across the 60 1s bars
 *     within that minute (primary contract only).
 *   - close_minute: close of the last 1s bar within that minute.
 *   - vwap_close_diff: close_minute - vwap_minute. Sign is approach-agnostic;
 *     the live strategy multiplies by the approach sign to get the rejection-
 *     direction VWAP-close diff used in the Phase 4 filter.
 *
 * Output: CSV with columns (timestamp,vwap_close_diff,vwap,close,n_bars).
 * Backtest engine reads this via --s1-vwap-file.
 *
 * Usage:
 *   node research/gex-touch-confirm/06-precompute-s1-vwap.js \
 *     --start 2025-01-13 --end 2026-04-23 \
 *     --out data/features/nq_s1_vwap_1m.csv
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const START = arg('start', '2025-01-13');
const END = arg('end', '2026-04-23');
const OUT = arg('out', 'data/features/nq_s1_vwap_1m.csv');
const PRODUCT = arg('product', 'NQ').toUpperCase();

const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

console.log(`\n=== Precompute s1 VWAP features ===`);
console.log(`Range: ${START} → ${END}`);
console.log(`Product: ${PRODUCT}`);
console.log(`Out: ${outPath}\n`);

// --- 1. Load 1m OHLCV and build primary-contract-by-hour map ---
async function loadRawNQ(startStr, endStr) {
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
        const c = { timestamp: ts, volume: +row.volume || 0, symbol: row.symbol };
        candles.push(c);
      })
      .on('end', resolve).on('error', reject);
  });
  return candles;
}
function buildPrimaryByHour(candles) {
  const hourVol = new Map();
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    if (!hourVol.has(h)) hourVol.set(h, new Map());
    const m = hourVol.get(h);
    m.set(c.symbol, (m.get(c.symbol) || 0) + (c.volume || 0));
  }
  const primary = new Map();
  for (const [h, m] of hourVol.entries()) {
    let bestSym = '', bestVol = 0;
    for (const [s, v] of m.entries()) if (v > bestVol) { bestVol = v; bestSym = s; }
    primary.set(h, bestSym);
  }
  return primary;
}

console.log(`Loading 1m OHLCV for primary-contract map ...`);
const oneMin = await loadRawNQ(START, END);
console.log(`  ${oneMin.length.toLocaleString()} 1m rows loaded`);
const primaryByHour = buildPrimaryByHour(oneMin);
console.log(`  primary-by-hour map: ${primaryByHour.size.toLocaleString()} hours`);

// --- 2. Stream 1s OHLCV, aggregate per minute (primary contract only) ---
const onesPath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1s.csv`);
if (!fs.existsSync(onesPath)) {
  console.error(`1s file not found: ${onesPath}`);
  process.exit(1);
}

const scanStart = new Date(START).getTime();
const scanEnd = new Date(END).getTime() + 24 * 3600000;
const minIso = new Date(scanStart).toISOString();
const maxIso = new Date(scanEnd).toISOString();

console.log(`Streaming 1s OHLCV (${PRODUCT}_ohlcv_1s.csv) ...`);
const stream = fs.createReadStream(onesPath, { highWaterMark: 1 << 20 });
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
let header = null;
let scanned = 0, kept = 0;
const tStart = Date.now();

// Aggregation state: minute_ts → { pvSum, vSum, lastClose, lastTs, nBars }
let curMinuteTs = null;
let curAgg = null;
const minuteAggs = new Map(); // we'll flush per-minute into this map

function flushMinute() {
  if (curMinuteTs == null || !curAgg || curAgg.nBars === 0) return;
  const vwap = curAgg.vSum > 0 ? curAgg.pvSum / curAgg.vSum : curAgg.lastClose;
  minuteAggs.set(curMinuteTs, {
    vwap,
    close: curAgg.lastClose,
    n_bars: curAgg.nBars,
  });
}

for await (const line of rl) {
  if (!header) { header = line; continue; }
  scanned++;
  if (scanned % 10000000 === 0) {
    const sec = ((Date.now() - tStart) / 1000).toFixed(0);
    process.stdout.write(`  scanned ${(scanned / 1e6).toFixed(0)}M  kept ${kept.toLocaleString()}  (${sec}s)\n`);
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
  if (primarySym && symbol !== primarySym) continue;

  const high = +parts[5], low = +parts[6], close = +parts[7], volume = +parts[8] || 0;
  if (isNaN(close)) continue;
  const typical = (high + low + close) / 3;

  const minuteTs = Math.floor(ts / 60000) * 60000;
  if (minuteTs !== curMinuteTs) {
    flushMinute();
    curMinuteTs = minuteTs;
    curAgg = { pvSum: 0, vSum: 0, lastClose: close, nBars: 0 };
  }
  curAgg.pvSum += typical * volume;
  curAgg.vSum += volume;
  curAgg.lastClose = close;
  curAgg.nBars++;
  kept++;
}
flushMinute();
rl.close(); stream.destroy();
const sec = ((Date.now() - tStart) / 1000).toFixed(0);
console.log(`  Done: scanned ${scanned.toLocaleString()} 1s rows, kept ${kept.toLocaleString()}, aggregated ${minuteAggs.size.toLocaleString()} minutes (${sec}s)`);

// --- 3. Write CSV (sorted by timestamp) ---
console.log(`Writing CSV ...`);
const ws = fs.createWriteStream(outPath);
ws.write('timestamp,vwap_close_diff,vwap,close,n_bars\n');
const sortedMinutes = Array.from(minuteAggs.keys()).sort((a, b) => a - b);
for (const ts of sortedMinutes) {
  const a = minuteAggs.get(ts);
  const diff = a.close - a.vwap;
  ws.write(`${new Date(ts).toISOString()},${diff.toFixed(4)},${a.vwap.toFixed(4)},${a.close.toFixed(4)},${a.n_bars}\n`);
}
ws.end();
await new Promise(resolve => ws.on('finish', resolve));
const stat = fs.statSync(outPath);
console.log(`Written: ${outPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB, ${sortedMinutes.length.toLocaleString()} rows)`);
