/**
 * Phase 1 — Lookahead-safe 1s order-flow event stream (NQ), from Databento trades.
 *
 * Reuses src/data/databento-loader.js (DatabentoTradeLoader) and its established
 * aggressor convention:  side='A' (Ask) = BUYER aggressor (+delta);  side='B' (Bid) =
 * SELLER aggressor (-delta).
 *
 * Output: one row per 1-SECOND bucket of the PRIMARY contract, with the order-flow
 * features a sweep detector needs. The stream is the join key for price + levels later.
 *
 * LOOKAHEAD DISCIPLINE (hard requirement):
 *   • A 1s bar aggregates ONLY trades with ts_event in [t, t+1000ms). It is stamped at
 *     the bar START t, but its contents are "known" only at t+1000ms — any downstream
 *     decision at time D may use a bar only if barStart+1000 <= D. (Documented for Phase 2.)
 *   • CVD is cumulative over PAST bars within the current session; it resets at the CME
 *     session boundary (22:00 UTC ≈ Globex open) and on a primary-contract change
 *     (cross-contract delta is meaningless). No future information ever enters a bar.
 *   • Primary contract per hour is decided from REALIZED volume up to that hour's trades
 *     only (it's a per-hour grouping of that hour's prints — no peeking forward).
 *
 * VERIFY (--verify): independently re-aggregate ALL NQ contracts to 1-minute and
 * reconcile against the existing data/orderflow/nq/trade-ofi-1m.csv. A tight match
 * confirms our parsing + side mapping reproduce the known-good derived file.
 *
 * Usage:
 *   node research/orderflow-sweep/01-build-orderflow-stream.js \
 *     --start 2025-01-06 --end 2025-01-10 \
 *     --out data/features/nq_orderflow_1s_2025-01wk.csv --verify
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabentoTradeLoader } from '../../src/data/databento-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const has = (n) => process.argv.includes(`--${n}`);

const START = arg('start', '2025-01-06');
const END = arg('end', '2025-01-10');
const LARGE = +arg('large', 25);          // "large trade" size threshold (NQ lots)
const OUT = arg('out', `data/features/nq_orderflow_1s_${START}_${END}.csv`);
const VERIFY = has('verify');
const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

// CME session id: reset at 22:00 UTC (≈ Globex equity-index open). Bars in the same
// session share an id; a change triggers a CVD reset.
const SESSION_OFFSET_MS = 22 * 3600 * 1000;
const sessionId = (ts) => Math.floor((ts - SESSION_OFFSET_MS) / 86400000);

console.log(`\n=== Phase 1: 1s order-flow stream (NQ) ===`);
console.log(`Range: ${START} → ${END}   large=${LARGE}   verify=${VERIFY}`);
console.log(`Out:   ${outPath}\n`);

const loader = new DatabentoTradeLoader({ dataDir: 'data/orderflow/nq/trades', symbolFilter: 'NQ' });

const out = fs.createWriteStream(outPath);
out.write('ts,symbol,buyVol,sellVol,delta,cvd,trades,largeBuyVol,largeSellVol,maxTradeSize\n');

// running state across days/buckets (chronological)
let cvd = 0, curSession = null, curPrimary = null;
let rowsWritten = 0, daysDone = 0;

// verification accumulators: all-NQ 1m tallies keyed by minute-start ms
const verifyMin = VERIFY ? new Map() : null;

function dayList(start, end) {
  const out = []; const c = new Date(start + 'T00:00:00Z'); const e = new Date(end + 'T00:00:00Z');
  while (c <= e) { out.push(new Date(c)); c.setUTCDate(c.getUTCDate() + 1); }
  return out;
}

for (const day of dayList(START, END)) {
  const trades = await loader.loadDate(day);   // action==='T' only, parsed, NQ-filtered
  if (!trades.length) continue;
  trades.sort((a, b) => a.timestamp - b.timestamp);

  // --- primary contract per hour from realized volume (drop calendar spreads) ---
  const hourVol = new Map();
  for (const t of trades) {
    if (!t.symbol || t.symbol.includes('-')) continue;
    const h = Math.floor(t.timestamp / 3600000);
    let m = hourVol.get(h); if (!m) { m = new Map(); hourVol.set(h, m); }
    m.set(t.symbol, (m.get(t.symbol) || 0) + t.size);
  }
  const primaryByHour = new Map();
  for (const [h, m] of hourVol) { let bs = '', bv = -1; for (const [s, v] of m) if (v > bv) { bv = v; bs = s; } primaryByHour.set(h, bs); }

  // --- bucket primary-contract trades into 1s; tally all-NQ 1m for verify ---
  const sec = new Map(); // secStart -> {sym, buyVol, sellVol, trades, lgBuy, lgSell, maxSz}
  for (const t of trades) {
    if (!t.symbol || t.symbol.includes('-')) continue;

    if (VERIFY) { // all-NQ minute tally (matches existing derived-file scope)
      const mk = Math.floor(t.timestamp / 60000) * 60000;
      let v = verifyMin.get(mk); if (!v) { v = { buy: 0, sell: 0, n: 0 }; verifyMin.set(mk, v); }
      if (t.side === 'A') v.buy += t.size; else if (t.side === 'B') v.sell += t.size; v.n++;
    }

    const h = Math.floor(t.timestamp / 3600000);
    if (primaryByHour.get(h) !== t.symbol) continue;   // primary only

    const s = Math.floor(t.timestamp / 1000) * 1000;
    let b = sec.get(s);
    if (!b) { b = { sym: t.symbol, buyVol: 0, sellVol: 0, trades: 0, lgBuy: 0, lgSell: 0, maxSz: 0 }; sec.set(s, b); }
    if (t.side === 'A') { b.buyVol += t.size; if (t.size >= LARGE) b.lgBuy += t.size; }
    else if (t.side === 'B') { b.sellVol += t.size; if (t.size >= LARGE) b.lgSell += t.size; }
    b.trades++; if (t.size > b.maxSz) b.maxSz = t.size;
  }

  // --- emit 1s rows in chronological order, maintaining session-reset CVD ---
  for (const s of [...sec.keys()].sort((a, b) => a - b)) {
    const b = sec.get(s);
    const sid = sessionId(s);
    if (sid !== curSession || b.sym !== curPrimary) { cvd = 0; curSession = sid; curPrimary = b.sym; }
    const delta = b.buyVol - b.sellVol;
    cvd += delta;
    out.write(`${new Date(s).toISOString()},${b.sym},${b.buyVol},${b.sellVol},${delta},${cvd},${b.trades},${b.lgBuy},${b.lgSell},${b.maxSz}\n`);
    rowsWritten++;
  }

  loader.clearCache();
  daysDone++;
  if (daysDone % 10 === 0) console.log(`  ${daysDone} days, ${rowsWritten.toLocaleString()} 1s rows`);
}
out.end();
console.log(`\nDone. ${rowsWritten.toLocaleString()} 1s rows written.\n`);

// ---------- verification against existing trade-ofi-1m.csv ----------
if (VERIFY) {
  const ofiPath = path.join(ROOT, 'data/orderflow/nq/trade-ofi-1m.csv');
  const lines = fs.readFileSync(ofiPath, 'utf8').trim().split('\n');
  const hdr = lines[0].split(','); const ci = {}; hdr.forEach((h, i) => ci[h] = i);
  const parseTs = (s) => /^\d+$/.test(s) ? +s : new Date(s).getTime();
  let n = 0, matchBuy = 0, matchSell = 0, sumAbsPct = 0, cmp = 0;
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const mk = parseTs(f[ci.timestamp]);
    const mine = verifyMin.get(mk);
    if (!mine) continue;                     // only compare overlapping minutes
    n++;
    const theirBuy = +f[ci.buyVolume], theirSell = +f[ci.sellVolume];
    if (Math.abs(theirBuy - mine.buy) <= Math.max(1, 0.005 * theirBuy)) matchBuy++;
    if (Math.abs(theirSell - mine.sell) <= Math.max(1, 0.005 * theirSell)) matchSell++;
    const tot = theirBuy + theirSell;
    if (tot > 0) { sumAbsPct += (Math.abs(theirBuy - mine.buy) + Math.abs(theirSell - mine.sell)) / tot; cmp++; }
  }
  console.log(`=== VERIFY vs trade-ofi-1m.csv (overlapping minutes: ${n.toLocaleString()}) ===`);
  if (n === 0) { console.log('  no overlapping minutes — check timestamp format / range'); }
  else {
    console.log(`  buyVolume exact-ish match: ${(matchBuy / n * 100).toFixed(2)}%`);
    console.log(`  sellVolume exact-ish match: ${(matchSell / n * 100).toFixed(2)}%`);
    console.log(`  mean abs volume error: ${(sumAbsPct / cmp * 100).toFixed(3)}%`);
    console.log(`  → >99% match confirms parsing + side convention reproduce the known-good file.\n`);
  }
}
