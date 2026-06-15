// Phase 10 — IN-TRADE ORDER FLOW as a LEADING signal. The signals Drew actually wants:
//   trade-ofi-1m   : aggressor flow (buyVolume vs sellVolume) — who is lifting/hitting.
//   book-imbalance : resting bid vs ask size — passive pressure.
// Both 1-min, full 16mo. Test: does flow over [entry→15min] predict the FUTURE move [15→exit],
// controlling for the price already seen by +15? If yes → flow LEADS price → actionable.
//
// Position-aligned: a LONG is helped by net BUYING / bid-heavy book; a SHORT by net SELLING.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CSV = path.resolve(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.csv');
const IDXF = path.resolve(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.index.json');
const OFI = path.resolve(ROOT, 'data/orderflow/nq/trade-ofi-1m.csv');
const BIMB = path.resolve(ROOT, 'data/orderflow/nq/book-imbalance-1m.csv');
const W = 15; // early window minutes

// ---- load 1m flow series into parallel arrays ----
function loadSeries(file, cols) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  const ci = cols.map(c => head.indexOf(c));
  const ts = [], vals = cols.map(() => []);
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(','); const t = Date.parse(p[0]); if (!isFinite(t)) continue;
    ts.push(t); ci.forEach((idx, j) => vals[j].push(+p[idx]));
  }
  return { ts, vals };
}
const ofi = loadSeries(OFI, ['buyVolume', 'sellVolume']);
const bk = loadSeries(BIMB, ['sizeImbalance']); // (bid-ask)/(bid+ask) resting, + = bid-heavy
console.log(`OFI 1m: ${ofi.ts.length} pts  | book-imb: ${bk.ts.length} pts`);

// window sum of buy/sell aggressor volume over [a,b]; returns net imbalance and avg book imb
function lower(ts, x) { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < x) lo = m + 1; else hi = m; } return lo; }
function flowWindow(a, b) {
  let i = lower(ofi.ts, a), buy = 0, sell = 0;
  for (; i < ofi.ts.length && ofi.ts[i] < b; i++) { buy += ofi.vals[0][i]; sell += ofi.vals[1][i]; }
  const tot = buy + sell;
  return tot > 0 ? (buy - sell) / tot : null; // + = net buying
}
function bookWindow(a, b) {
  let i = lower(bk.ts, a), s = 0, n = 0;
  for (; i < bk.ts.length && bk.ts[i] < b; i++) { if (isFinite(bk.vals[0][i])) { s += bk.vals[0][i]; n++; } }
  return n > 0 ? s / n : null; // + = bid-heavy
}

// ---- trades + price@15 (1s) ----
const FILES = { glx: 'gex-lt-3m-crossover-v3.json', gfi: 'gex-flip-ivpct-v2.json', glf: 'gex-level-fade-v2.json' };
const normSide = s => { const l = String(s).toLowerCase(); return (l === 'long' || l === 'buy') ? 'long' : 'short'; };
const trades = [];
for (const [k, f] of Object.entries(FILES)) {
  for (const t of JSON.parse(fs.readFileSync(path.join(ROOT, 'data/gold-standard', f), 'utf8')).trades) {
    if (t.status !== 'completed' || t.entryTime == null) continue;
    const entry = t.actualEntry ?? t.entryPrice; if (entry == null) continue;
    trades.push({ k, side: normSide(t.side), entryTs: t.entryTime, exitTs: t.exitTime, entry,
      finalPts: t.pointsPnL, contract: t.signalContract ?? t.signal?.signalContract });
  }
}
const idx = JSON.parse(fs.readFileSync(IDXF, 'utf8')).minutes;
const fd = fs.openSync(CSV, 'r');
function unrlAt(t, minute) {
  const target = t.entryTs + minute * 60000; if (target > t.exitTs) return null;
  const mk = Math.floor(target / 60000) * 60000;
  for (const m of [mk, mk - 60000, mk + 60000]) {
    const meta = idx[m]; if (!meta) continue;
    const buf = Buffer.allocUnsafe(meta.length); fs.readSync(fd, buf, 0, meta.length, meta.offset);
    let best = null, bestD = Infinity;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue; const c = line.split(','); if (c[9] !== t.contract) continue;
      const bts = Date.parse(c[0]); const d = Math.abs(bts - target); if (d < bestD) { bestD = d; best = +c[7]; }
    }
    if (best != null) return t.side === 'long' ? best - t.entry : t.entry - best;
  }
  return null;
}
const ll = [];
for (const t of trades) {
  if (t.exitTs == null || (t.entryTs + W * 60000) > t.exitTs) continue;
  const u15 = unrlAt(t, 15); if (u15 == null) continue;
  const fw = flowWindow(t.entryTs, t.entryTs + W * 60000);
  const bw = bookWindow(t.entryTs, t.entryTs + W * 60000);
  if (fw == null) continue;
  t._u15 = u15;
  t._favFlow = t.side === 'long' ? fw : -fw;           // + = aggressor flow toward position
  t._favBook = bw == null ? null : (t.side === 'long' ? bw : -bw); // + = book toward position
  ll.push(t);
}
fs.closeSync(fd);

const fm = t => t.finalPts - t._u15;
const fpos = a => a.length ? a.filter(t => fm(t) > 0).length / a.length : 0;
const favg = a => a.length ? a.reduce((s, t) => s + fm(t), 0) / a.length : 0;
const pct = x => (x * 100).toFixed(0) + '%';

console.log(`\nLead-lag sample: ${ll.length} trades (open ≥15min, flow+price available)\n`);

function leadlag(label, favFn, thr) {
  console.log(`${label} — early signal [entry→15min] vs FUTURE move [15min→exit]:`);
  for (const [plbl, pfn] of [['price@15 underwater(<-10)', t => t._u15 < -10], ['price@15 flat(-10..10)', t => t._u15 >= -10 && t._u15 <= 10], ['price@15 green(>+10)', t => t._u15 > 10]]) {
    const pg = ll.filter(pfn).filter(t => favFn(t) != null); if (pg.length < 15) { console.log(`   ${plbl}: n=${pg.length} (too few)`); continue; }
    const up = pg.filter(t => favFn(t) > thr), dn = pg.filter(t => favFn(t) < -thr);
    console.log(`   ${plbl.padEnd(24)} (n=${pg.length}, futAvg ${favg(pg).toFixed(1)}pt):`);
    console.log(`       signal TOWARD us  n=${String(up.length).padStart(3)}  P(fut>0) ${pct(fpos(up)).padStart(4)}  avgFuture ${favg(up).toFixed(1).padStart(7)}pt`);
    console.log(`       signal AGAINST us n=${String(dn.length).padStart(3)}  P(fut>0) ${pct(fpos(dn)).padStart(4)}  avgFuture ${favg(dn).toFixed(1).padStart(7)}pt`);
  }
  console.log();
}
leadlag('(A) AGGRESSOR FLOW (trade-ofi)', t => t._favFlow, 0.05);
leadlag('(B) BOOK IMBALANCE', t => t._favBook, 0.05);
