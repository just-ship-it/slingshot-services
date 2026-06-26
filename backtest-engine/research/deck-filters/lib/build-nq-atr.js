/**
 * Build a per-minute NQ realized-volatility cache (ATR-14 on 1m bars, intraday-reset) for the
 * deck-filter research window. Used by thread A2 (stop-vs-realized-vol noise gate).
 *
 * Honesty notes:
 *  - Streams the raw NQ_ohlcv_1m.csv (multi-contract). Per ET-day we pick the single highest-volume
 *    symbol (front contract) and compute ATR only on THAT contract's bars in time order, so
 *    rollover jumps and calendar spreads (symbol contains '-') never enter the true-range series.
 *  - ATR resets each ET day (no overnight gap contaminating the range). Wilder ATR-14; before 14
 *    bars accumulate we emit the running simple mean of available TRs (so early-session entries
 *    still get a sane denominator).
 *  - Output is a compact CSV: minuteKey (floor(ms/60000)), atr (NQ points), symbol. Only the
 *    research window is written.
 *
 * Usage: node research/deck-filters/lib/build-nq-atr.js
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');         // backtest-engine/
const SRC = path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1m.csv');
const OUT = path.join(ROOT, 'data/iv/nq/nq_atr_1m.csv');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const WIN_START = '2025-01-13', WIN_END = '2026-04-23';

function isDST(ms){const d=new Date(ms),y=d.getUTCFullYear(),m=d.getUTCMonth();if(m>=3&&m<=9)return true;if(m===0||m===1||m===11)return false;if(m===2){const fd=new Date(Date.UTC(y,2,1)).getUTCDay();return ms>=Date.UTC(y,2,fd===0?8:15-fd,7);}if(m===10){const fd=new Date(Date.UTC(y,10,1)).getUTCDay();return ms<Date.UTC(y,10,fd===0?1:8-fd,6);}return false;}
const etDate = ms => {const e=ms-(isDST(ms)?4:5)*3600000;const d=new Date(e);return`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;};

// PASS 1: per ET-day, total volume per symbol → pick front contract.
// We must buffer one day's rows; the file is sorted by ts_event so days are contiguous.
// To avoid holding all rows, we do two streams: pass 1 = day→bestSymbol, pass 2 = emit ATR.
console.log('PASS 1: finding front contract per ET-day...');
const dayVol = new Map();   // etDate -> Map(symbol -> volume)
async function pass1() {
  const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });
  let first = true, H, iTs, iVol, iSym;
  for await (const line of rl) {
    if (first) { first = false; H = line.split(','); iTs = H.indexOf('ts_event'); iVol = H.indexOf('volume'); iSym = H.indexOf('symbol'); continue; }
    if (!line) continue;
    // cheap ISO date slice: ts_event is "YYYY-MM-DDTHH..." but that's UTC; we need ET day.
    const c = line.split(',');
    const sym = c[iSym];
    if (!sym || sym.includes('-')) continue;             // drop calendar spreads
    const ms = Date.parse(c[iTs]);
    const ed = etDate(ms);
    if (ed < WIN_START || ed > WIN_END) { if (ed > WIN_END) break; continue; }
    const vol = +c[iVol] || 0;
    let m = dayVol.get(ed); if (!m) { m = new Map(); dayVol.set(ed, m); }
    m.set(sym, (m.get(sym) || 0) + vol);
  }
}
await pass1();
const frontByDay = new Map();
for (const [ed, m] of dayVol) { let best = null, bv = -1; for (const [s, v] of m) if (v > bv) { bv = v; best = s; } frontByDay.set(ed, best); }
console.log(`  ${frontByDay.size} ET-days, front contracts: ${[...new Set(frontByDay.values())].join(', ')}`);

// PASS 2: stream again, keep only front-contract bars per day, compute intraday-reset Wilder ATR-14.
console.log('PASS 2: computing intraday ATR-14...');
const out = fs.createWriteStream(OUT);
out.write('minuteKey,atr,symbol\n');
let curDay = null, prevClose = null, trs = [], atr = null, wrote = 0;
async function pass2() {
  const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });
  let first = true, H, iTs, iH, iL, iC, iSym;
  for await (const line of rl) {
    if (first) { first = false; H = line.split(','); iTs = H.indexOf('ts_event'); iH = H.indexOf('high'); iL = H.indexOf('low'); iC = H.indexOf('close'); iSym = H.indexOf('symbol'); continue; }
    if (!line) continue;
    const c = line.split(',');
    const sym = c[iSym];
    if (!sym || sym.includes('-')) continue;
    const ms = Date.parse(c[iTs]);
    const ed = etDate(ms);
    if (ed < WIN_START || ed > WIN_END) { if (ed > WIN_END) break; continue; }
    if (frontByDay.get(ed) !== sym) continue;            // only the day's front contract
    if (ed !== curDay) { curDay = ed; prevClose = null; trs = []; atr = null; }  // intraday reset
    const hi = +c[iH], lo = +c[iL], cl = +c[iC];
    const tr = prevClose == null ? (hi - lo) : Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose));
    prevClose = cl;
    if (atr == null) { trs.push(tr); atr = trs.reduce((s, x) => s + x, 0) / trs.length; if (trs.length >= 14) atr = trs.slice(-14).reduce((s, x) => s + x, 0) / 14; }
    else { atr = (atr * 13 + tr) / 14; }                  // Wilder smoothing once seeded
    out.write(`${Math.floor(ms / 60000)},${atr.toFixed(4)},${sym}\n`);
    wrote++;
  }
}
await pass2();
out.end();
await new Promise(r => out.on('finish', r));
console.log(`✓ wrote ${OUT} (${wrote} minute rows)`);
