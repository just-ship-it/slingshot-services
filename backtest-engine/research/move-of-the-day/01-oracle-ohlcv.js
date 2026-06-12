// Phase 1a — THEORETICAL OHLCV oracle: the max single-trade points capturable
// in each RTH session, ignoring whether any strategy pointed there.
//
// This is the absolute ceiling. For each day: bestLong = max(high_j - min(low_i<=j)),
// bestShort = max(max(high_i<=j) - low_j). oracleMove = max(bestLong, bestShort).
// Uses raw NQ 1m + per-hour highest-volume primary-contract filter (CLAUDE.md rule).
//
// Window: RTH 09:30–16:00 ET (exit may run to the close even if entry cutoff is 15:45).
// This is a ceiling reference, not a tradeable rule — 1m extremes are intentionally generous.

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { etParts, RTH_OPEN_MIN, RTH_CLOSE_MIN } from './lib/et.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV = path.resolve(__dirname, '../../data/ohlcv/nq/NQ_ohlcv_1m.csv');
const OUT = path.resolve(__dirname, 'output');

const START = '2025-01-13';
const END = '2026-04-23';

// Collect RTH bars per day. Per day store rows {sym, hour, o,h,l,c,v, min}
const byDay = new Map();

const rl = readline.createInterface({ input: fs.createReadStream(CSV), crlfDelay: Infinity });
let header = true, scanned = 0, kept = 0;

for await (const line of rl) {
  if (header) { header = false; continue; }
  if (!line) continue;
  // fast date gate via ISO prefix lexical compare
  const datePrefix = line.slice(0, 10);
  if (datePrefix < START) continue;
  if (datePrefix > END) break; // file sorted by ts_event

  const c = line.split(',');
  // ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
  const ts = c[0], symbol = c[9];
  if (symbol && symbol.includes('-')) continue; // calendar spread
  scanned++;

  const t = Date.parse(ts);
  const e = etParts(t);
  if (e.dow === 0 || e.dow === 6) continue;
  if (e.minutesOfDay < RTH_OPEN_MIN || e.minutesOfDay >= RTH_CLOSE_MIN) continue;

  const open = +c[4], high = +c[5], low = +c[6], close = +c[7], volume = +c[8];
  if (!(high >= low) || !isFinite(high) || !isFinite(low)) continue;
  if (open === high && high === low && low === close) continue; // single-tick junk

  let day = byDay.get(e.dateET);
  if (!day) { day = []; byDay.set(e.dateET, day); }
  day.push({ symbol, hour: e.hour, min: e.minutesOfDay, high, low, close, volume });
  kept++;
}

// Per day: pick primary contract per hour (highest volume), keep only those bars, then max-move.
const oracle = {};
for (const [date, bars] of byDay) {
  // volume per (hour,symbol)
  const hourVol = new Map(); // hour -> Map(sym->vol)
  for (const b of bars) {
    let hv = hourVol.get(b.hour); if (!hv) { hv = new Map(); hourVol.set(b.hour, hv); }
    hv.set(b.symbol, (hv.get(b.symbol) || 0) + b.volume);
  }
  const primaryByHour = new Map();
  for (const [hour, hv] of hourVol) {
    let best = '', mx = -1;
    for (const [sym, v] of hv) if (v > mx) { mx = v; best = sym; }
    primaryByHour.set(hour, best);
  }
  const pbars = bars
    .filter(b => b.symbol === primaryByHour.get(b.hour))
    .sort((a, b) => a.min - b.min);
  if (pbars.length < 5) continue;

  // max single-transaction long & short on intrabar extremes
  let minLow = pbars[0].low, maxHigh = pbars[0].high;
  let bestLong = 0, bestShort = 0;
  let blEntry = null, blExit = null, bsEntry = null, bsExit = null;
  let minLowAt = pbars[0].min, maxHighAt = pbars[0].min;
  for (const b of pbars) {
    if (b.high - minLow > bestLong) { bestLong = b.high - minLow; blEntry = minLow; blExit = b.high; }
    if (maxHigh - b.low > bestShort) { bestShort = maxHigh - b.low; bsEntry = maxHigh; bsExit = b.low; }
    if (b.low < minLow) { minLow = b.low; minLowAt = b.min; }
    if (b.high > maxHigh) { maxHigh = b.high; maxHighAt = b.min; }
  }
  const dir = bestLong >= bestShort ? 'long' : 'short';
  oracle[date] = {
    date,
    oracleMove: +Math.max(bestLong, bestShort).toFixed(2),
    dir,
    bestLong: +bestLong.toFixed(2),
    bestShort: +bestShort.toFixed(2),
    rthHigh: +maxHigh.toFixed(2),
    rthLow: +minLow.toFixed(2),
    rthRange: +(maxHigh - minLow).toFixed(2),
    bars: pbars.length,
  };
}

fs.writeFileSync(path.join(OUT, 'oracle-ohlcv.json'), JSON.stringify(oracle));

const days = Object.values(oracle);
const moves = days.map(d => d.oracleMove);
const ranges = days.map(d => d.rthRange);
const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => sum(a) / a.length;
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

console.log(`Scanned ${scanned} in-window rows, kept ${kept}. Oracle days: ${days.length}`);
console.log('\n========== THEORETICAL OHLCV ORACLE (RTH max single-trade move) ==========');
console.log(`Total oracle points (sum of per-day max move): ${sum(moves).toFixed(0)} pts  ($${(sum(moves) * 20).toLocaleString()})`);
console.log(`Mean per-day max move:   ${mean(moves).toFixed(1)} pts   (median ${median(moves).toFixed(1)})`);
console.log(`Mean per-day RTH range:  ${mean(ranges).toFixed(1)} pts   (median ${median(ranges).toFixed(1)})`);
console.log(`Move as % of range:      ${(mean(moves) / mean(ranges) * 100).toFixed(0)}% (max move can exceed range when both legs tradeable)`);
const longDays = days.filter(d => d.dir === 'long').length;
console.log(`Direction split:         ${longDays} long / ${days.length - longDays} short`);
console.log('Wrote output/oracle-ohlcv.json');
