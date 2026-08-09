/**
 * 10 — rebuild days.ES.json with the PRIMARY-CONTRACT filter applied in
 * pass 1 (band inputs), fixing the 2026-06-15 build's contamination: the
 * original 02-precompute computed primaryByHour but only used it for the 1s
 * fills — day open / mClose / prevClose were last-write-wins across contract
 * months, so bands near roll windows mixed back-month quotes (e.g. 2022-09-06
 * prevClose recorded 3927.25 = thin ESZ2 vs true primary ESU2 3911).
 *
 * Output: output/days.ES.primary.json — same schema, primary-filtered.
 * Use with 03-sweep via DAYS_FILE env: DAYS_FILE=days.ES.primary.json.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { getRTHOpenTime, getRTHCloseTime, getTradingDays } from '../../src/ai/session-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CSV = path.join(ROOT, 'data', 'ohlcv', 'es', 'ES_ohlcv_1m.csv');
const START = '2021-02-01', END = '2026-01-23';
const RTH_MIN = 390;

const startMs = new Date(START + 'T00:00:00Z').getTime();
const endMs = new Date(END + 'T00:00:00Z').getTime() + 24 * 3600000;
const minIso = new Date(startMs).toISOString(), maxIso = new Date(endMs).toISOString();

async function streamRows(onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(CSV, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  let header = false;
  for await (const line of rl) {
    if (!header) { header = true; continue; }
    const c0 = line.indexOf(','); if (c0 < 0) continue;
    const tsStr = line.slice(0, c0);
    if (tsStr < minIso) continue;
    if (tsStr > maxIso) break;
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const symbol = parts[9].trim();
    if (symbol.includes('-')) continue;
    onRow(tsStr, parts, symbol);
  }
}

console.log('pass A: hour-primary volumes ...');
const hourVol = new Map();
await streamRows((tsStr, parts, symbol) => {
  const hb = Math.floor(new Date(tsStr).getTime() / 3600000);
  let hv = hourVol.get(hb);
  if (!hv) { hv = new Map(); hourVol.set(hb, hv); }
  hv.set(symbol, (hv.get(symbol) || 0) + (+parts[8] || 0));
});
const primaryByHour = new Map();
for (const [hb, hv] of hourVol) {
  let bs = '', bv = -1;
  for (const [s, v] of hv) if (v > bv) { bv = v; bs = s; }
  primaryByHour.set(hb, bs);
}
console.log(`  ${primaryByHour.size} hours mapped`);

console.log('pass B: primary-filtered day matrix ...');
const tradingDays = getTradingDays(START, END);
const days = tradingDays.map(d => ({
  date: d, rthOpenMs: getRTHOpenTime(d), rthCloseMs: getRTHCloseTime(d),
  open: NaN, prevClose: NaN, mClose: new Array(RTH_MIN).fill(NaN),
}));
days.sort((a, b) => a.rthOpenMs - b.rthOpenMs);

let di = 0;
await streamRows((tsStr, parts, symbol) => {
  const ts = new Date(tsStr).getTime();
  if (primaryByHour.get(Math.floor(ts / 3600000)) !== symbol) return;
  while (di < days.length - 1 && ts >= days[di + 1].rthOpenMs) di++;
  const day = days[di];
  if (ts >= day.rthOpenMs && ts < day.rthCloseMs) {
    const m = Math.floor((ts - day.rthOpenMs) / 60000);
    if (m >= 0 && m < RTH_MIN) {
      if (m === 0 && isNaN(day.open)) day.open = +parts[4];
      day.mClose[m] = +parts[7];  // duplicates: last primary row wins (same contract)
    }
  }
});

for (const day of days) {
  if (isNaN(day.open)) for (let m = 0; m < RTH_MIN; m++) if (!isNaN(day.mClose[m])) { day.open = day.mClose[m]; break; }
  let last = day.open;
  for (let m = 0; m < RTH_MIN; m++) { if (isNaN(day.mClose[m])) day.mClose[m] = last; else last = day.mClose[m]; }
}
for (let i = 1; i < days.length; i++) days[i].prevClose = days[i - 1].mClose[RTH_MIN - 1];

const out = path.join(__dirname, 'output', 'days.ES.primary.json');
fs.writeFileSync(out, JSON.stringify({ days }));
const d96 = days.find(d => d.date === '2022-09-06');
console.log(`wrote ${out} (${days.length} days)`);
console.log(`sanity 2022-09-06: open ${d96.open} mClose[389] ${d96.mClose[389]} (expect ~3911, was 3927.25 contaminated)`);
