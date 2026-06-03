/**
 * Phase 2 prep — Unified lookahead-safe 1s PANEL = price (OHLC + true high/low) joined
 * with order flow (delta/cvd/large-prints/intensity), primary contract.
 *
 * This is the shared substrate for all sweep/discovery experiments. Price comes from the
 * 1s OHLCV (true intrabar high/low for wicks); flow comes from the Phase-1 order-flow
 * stream. Both describe the SAME 1s window [t, t+1s) keyed on the same timestamp → the
 * join introduces no lookahead.
 *
 * Usage:
 *   node research/orderflow-sweep/02-build-panel.js \
 *     --of data/features/nq_orderflow_1s_2025-01wk.csv \
 *     --start 2025-01-06 --end 2025-01-10 \
 *     --out data/features/nq_panel_1s_2025-01wk.csv
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const DATA = path.join(ROOT, 'data');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const OF = arg('of', 'data/features/nq_orderflow_1s_2025-01wk.csv');
const START = arg('start', '2025-01-06'), END = arg('end', '2025-01-10');
const OUT = arg('out', `data/features/nq_panel_1s_${START}_${END}.csv`);
const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
const ofPath = path.isAbsolute(OF) ? OF : path.join(ROOT, OF);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

console.log(`\n=== Build 1s panel (price + order flow) ===\n${START}→${END}\nflow: ${ofPath}\nout: ${outPath}\n`);

// --- load order-flow stream into Map(ts -> features) via STREAMING (file > max JS string) ---
console.log('Loading order-flow stream (streaming) ...');
const flow = new Map();
{
  const rlf = readline.createInterface({ input: fs.createReadStream(ofPath), crlfDelay: Infinity });
  let ci = null;
  for await (const line of rlf) {
    if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; }
    const f = line.split(',');
    flow.set(new Date(f[ci.ts]).getTime(), {
      delta: +f[ci.delta], cvd: +f[ci.cvd], buyVol: +f[ci.buyVol], sellVol: +f[ci.sellVol],
      trades: +f[ci.trades], lgBuy: +f[ci.largeBuyVol], lgSell: +f[ci.largeSellVol], maxSz: +f[ci.maxTradeSize],
    });
  }
  console.log(`  ${flow.size.toLocaleString()} flow seconds`);
}

// --- primary-by-hour from 1m OHLCV ---
async function loadOneMin() {
  const fp = path.join(DATA, 'ohlcv/nq/NQ_ohlcv_1m.csv');
  const s = new Date(START).getTime(), e = new Date(END).getTime() + 864e5;
  const rows = [];
  await new Promise((res, rej) => fs.createReadStream(fp).pipe(csv())
    .on('data', r => { if (r.symbol && r.symbol.includes('-')) return; const ts = new Date(r.ts_event).getTime(); if (isNaN(ts) || ts < s || ts > e) return; rows.push({ ts, v: +r.volume || 0, s: r.symbol }); })
    .on('end', res).on('error', rej));
  return rows;
}
const oneMin = await loadOneMin();
const primaryByHour = new Map();
{ const hv = new Map(); for (const c of oneMin) { const h = Math.floor(c.ts / 36e5); if (!hv.has(h)) hv.set(h, new Map()); const m = hv.get(h); m.set(c.s, (m.get(c.s) || 0) + c.v); } for (const [h, m] of hv) { let bs = '', bv = -1; for (const [s, v] of m) if (v > bv) { bv = v; bs = s; } primaryByHour.set(h, bs); } }
console.log(`  primary-by-hour: ${primaryByHour.size} hours`);

// --- stream 1s OHLCV (primary), join flow, write panel ---
const out = fs.createWriteStream(outPath);
out.write('ts,symbol,open,high,low,close,vol,delta,cvd,buyVol,sellVol,trades,lgBuy,lgSell,maxSz\n');
const fp = path.join(DATA, 'ohlcv/nq/NQ_ohlcv_1s.csv');
const sD = START.slice(0, 10), eD = END.slice(0, 10);
const sTs = new Date(START).getTime(), eTs = new Date(END).getTime() + 864e5;
const rl = readline.createInterface({ input: fs.createReadStream(fp), crlfDelay: Infinity });
let hdr = false, rows = 0, joined = 0;
console.log('Streaming 1s OHLCV + joining ...');
for await (const line of rl) {
  if (!hdr) { hdr = true; continue; }
  const dp = line.slice(0, 10); if (dp < sD) continue; if (dp > eD) break;
  const f = line.split(','); const sym = f[9];
  if (!sym || sym.includes('-')) continue;
  const ts = new Date(f[0]).getTime(); if (ts < sTs || ts > eTs) continue;
  if (primaryByHour.get(Math.floor(ts / 36e5)) !== sym) continue;
  const fl = flow.get(ts);
  if (fl) joined++;
  const d = fl || { delta: 0, cvd: '', buyVol: 0, sellVol: 0, trades: 0, lgBuy: 0, lgSell: 0, maxSz: 0 };
  out.write(`${f[0]},${sym},${f[4]},${f[5]},${f[6]},${f[7]},${f[8]},${d.delta},${d.cvd},${d.buyVol},${d.sellVol},${d.trades},${d.lgBuy},${d.lgSell},${d.maxSz}\n`);
  rows++;
}
out.end();
console.log(`\nDone. ${rows.toLocaleString()} panel rows, ${joined.toLocaleString()} joined to flow (${(100*joined/rows).toFixed(1)}%).\n`);
