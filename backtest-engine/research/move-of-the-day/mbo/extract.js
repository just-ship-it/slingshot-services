// MBO microstructure extractor. Reconstructs the full NQH6 limit order book order-by-order
// from a day's Databento MBO file and emits per-second feature snapshots during each big-3
// trade's life. Validated by checking reconstructed mid ≈ trade entry price and book sanity.
//
// Usage: node extract.js YYYY-MM-DD            (e.g. 2026-01-13)
// Output: output/mbo-panels/<date>.json  (array of {trade, snaps:[...]} )
//
// Book: orders Map(order_id→{side,tick,size}); bidDepth/askDepth Map(tick→size); best tracked.
// Tape: T events carry aggressor side. Per-second trailing buffers for flow/cancel/add.
//
// Databento MBO actions: A add, C cancel, M modify, F fill (reduces resting), T trade (tape), R clear.
// side: B bid / A ask. price pretty (NQ space). tick = round(price*4).

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const DATE = process.argv[2];
if (!DATE) { console.error('need date arg YYYY-MM-DD'); process.exit(1); }
const MBOFILE = path.resolve(ROOT, `data/orderflow/nq/mbo/glbx-mdp3-${DATE.replace(/-/g, '')}.mbo.csv`);
const OUTDIR = path.resolve(__dirname, '../output/mbo-panels');
fs.mkdirSync(OUTDIR, { recursive: true });
const SYMBOL = 'NQH6';
const TICK = 0.25;

// ---- trades on this date ----
const FILES = { glx: 'gex-lt-3m-crossover-v3.json', gfi: 'gex-flip-ivpct-v2.json', glf: 'gex-level-fade-v2.json' };
const normSide = s => { const l = String(s).toLowerCase(); return (l === 'long' || l === 'buy') ? 'long' : 'short'; };
const trades = [];
for (const [k, f] of Object.entries(FILES)) {
  for (const t of JSON.parse(fs.readFileSync(path.resolve(ROOT, 'data/gold-standard', f), 'utf8')).trades) {
    if (t.status !== 'completed' || t.entryTime == null) continue;
    if (new Date(t.entryTime).toISOString().slice(0, 10) !== DATE) continue;
    if ((t.signalContract ?? t.signal?.signalContract) !== SYMBOL) continue;
    trades.push({ id: `${k}-${t.id}`, k, side: normSide(t.side), entryTs: t.entryTime, exitTs: t.exitTime,
      entry: t.actualEntry ?? t.entryPrice, finalPts: t.pointsPnL,
      winStart: Math.floor((t.entryTime - 60000) / 1000), winEnd: Math.ceil(t.exitTime / 1000),
      snaps: [] });
  }
}
console.error(`${DATE}: ${trades.length} trades`);
if (!trades.length) { fs.writeFileSync(path.join(OUTDIR, `${DATE}.json`), '[]'); process.exit(0); }
const minStart = Math.min(...trades.map(t => t.winStart));
const maxEnd = Math.max(...trades.map(t => t.winEnd));

// ---- order book state ----
const orders = new Map();            // order_id -> {bid:bool, tick, size}
const bid = new Map(), ask = new Map(); // tick -> total size
let bestBid = -Infinity, bestAsk = Infinity;
function addLvl(m, t, sz, isBid) { const v = (m.get(t) || 0) + sz; if (v <= 0) m.delete(t); else m.set(t, v);
  if (sz > 0) { if (isBid && t > bestBid) bestBid = t; if (!isBid && t < bestAsk) bestAsk = t; } }
function fixBest(isBid) {
  if (isBid) { if (!bid.has(bestBid)) { bestBid = -Infinity; for (const t of bid.keys()) if (t > bestBid) bestBid = t; } }
  else { if (!ask.has(bestAsk)) { bestAsk = Infinity; for (const t of ask.keys()) if (t < bestAsk) bestAsk = t; } }
}

// ---- per-second tape/cancel/add buffers (ring by second) ----
const TR = 5; // trailing seconds
const ringBuy = new Map(), ringSell = new Map(), ringCxB = new Map(), ringCxA = new Map(), ringAdB = new Map(), ringAdA = new Map();
const bump = (m, sec, v) => m.set(sec, (m.get(sec) || 0) + v);
const trail = (m, sec) => { let s = 0; for (let i = 0; i < TR; i++) s += m.get(sec - i) || 0; return s; };

function depthWithin(m, bestTick, ticks, isBid) { // sum sizes within `ticks` of best (inclusive), + max level
  let sum = 0, mx = 0;
  for (let i = 0; i <= ticks; i++) { const t = isBid ? bestTick - i : bestTick + i; const v = m.get(t); if (v) { sum += v; if (v > mx) mx = v; } }
  return [sum, mx];
}

function snapshot(sec) {
  if (bestBid === -Infinity || bestAsk === Infinity || bestBid >= bestAsk) return null;
  const mid = (bestBid + bestAsk) / 2 * TICK;
  const [b1] = depthWithin(bid, bestBid, 0, true), [a1] = depthWithin(ask, bestAsk, 0, false);
  const [b5, mb5] = depthWithin(bid, bestBid, 4, true), [a5, ma5] = depthWithin(ask, bestAsk, 4, false);
  const [b10] = depthWithin(bid, bestBid, 9, true), [a10] = depthWithin(ask, bestAsk, 9, false);
  const imb = (x, y) => (x + y) > 0 ? (x - y) / (x + y) : 0;
  return {
    t: sec, mid, spr: bestAsk - bestBid,
    bb1: b1, ba1: a1, imb1: imb(b1, a1), imb5: imb(b5, a5), imb10: imb(b10, a10),
    b5, a5, b10, a10, maxB5: mb5, maxA5: ma5,
    buy5: trail(ringBuy, sec), sell5: trail(ringSell, sec),
    cxB5: trail(ringCxB, sec), cxA5: trail(ringCxA, sec),
    adB5: trail(ringAdB, sec), adA5: trail(ringAdA, sec),
  };
}

// ---- stream ----
const rl = readline.createInterface({ input: fs.createReadStream(MBOFILE), crlfDelay: Infinity });
let header = true, curSec = 0, rows = 0, valBadBook = 0;
let _secMin = Infinity, _secMax = -Infinity, _activeRoll = 0, _snapNull = 0;
const activeAt = sec => trades.filter(t => sec >= t.winStart && sec <= t.winEnd);

for await (const line of rl) {
  if (header) { header = false; continue; }
  // fields: 0ts_recv 1ts_event 2rtype 3pub 4instr 5action 6side 7price 8size 9chan 10oid 11flags 12tsdelta 13seq 14symbol
  const c = line.split(',');
  if (c[14] !== SYMBOL) continue;
  const action = c[5];
  const sec = Math.floor(Date.parse(c[1].slice(0, 19) + 'Z') / 1000);
  if (sec > maxEnd) break;            // past all trade windows — book no longer needed
  rows++;                             // NOTE: book is maintained from file start (needs pre-window adds)

  if (sec < _secMin) _secMin = sec; if (sec > _secMax) _secMax = sec;
  // second rollover → snapshot active trades for the second that just completed
  if (sec !== curSec) {
    if (curSec) { const act = activeAt(curSec); if (act.length) { _activeRoll++; for (const t of act) { const s = snapshot(curSec); if (s) t.snaps.push(s); else _snapNull++; } } }
    curSec = sec;
  }

  const side = c[6];           // B / A / N
  const isBid = side === 'B';
  if (action === 'T') { const sz = +c[8]; if (side === 'B') bump(ringBuy, sec, sz); else if (side === 'A') bump(ringSell, sec, sz); continue; }
  if (side !== 'B' && side !== 'A') continue; // R / N / non-book
  const oid = c[10], price = +c[7], sz = +c[8], tick = Math.round(price * 4);
  const m = isBid ? bid : ask;
  if (action === 'A') { orders.set(oid, { isBid, tick, size: sz }); addLvl(m, tick, sz, isBid); bump(isBid ? ringAdB : ringAdA, sec, sz); }
  else if (action === 'C') { const o = orders.get(oid); if (o) { addLvl(isBid ? bid : ask, o.tick, -o.size, isBid); orders.delete(oid); fixBest(isBid); bump(isBid ? ringCxB : ringCxA, sec, sz); } }
  else if (action === 'F') { const o = orders.get(oid); if (o) { const dec = Math.min(sz, o.size); o.size -= dec; addLvl(m, o.tick, -dec, isBid); if (o.size <= 0) orders.delete(oid); fixBest(isBid); } }
  else if (action === 'M') { const o = orders.get(oid); if (o) { addLvl(o.isBid ? bid : ask, o.tick, -o.size, o.isBid); fixBest(o.isBid); } orders.set(oid, { isBid, tick, size: sz }); addLvl(m, tick, sz, isBid); }
  else if (action === 'R') { orders.clear(); bid.clear(); ask.clear(); bestBid = -Infinity; bestAsk = Infinity; }
}
// flush last second
if (curSec) for (const t of activeAt(curSec)) { const s = snapshot(curSec); if (s) t.snaps.push(s); }

// ---- validation ----
console.error(`processed ${rows} ${SYMBOL} rows | activeRollovers=${_activeRoll} snapNull=${_snapNull}`);
for (const t of trades) {
  const atEntry = t.snaps.find(s => s.t >= Math.floor(t.entryTs / 1000));
  const bad = t.snaps.filter(s => s.spr <= 0).length;
  const midErr = atEntry ? (atEntry.mid - t.entry).toFixed(2) : 'NA';
  console.error(`  ${t.id.padEnd(16)} snaps=${String(t.snaps.length).padStart(4)} midAtEntry=${atEntry ? atEntry.mid.toFixed(2) : 'NA'} vs entry=${t.entry} (err ${midErr})  badSpread=${bad}`);
}
fs.writeFileSync(path.join(OUTDIR, `${DATE}.json`), JSON.stringify(trades.map(t => ({ id: t.id, k: t.k, side: t.side, entryTs: t.entryTs, exitTs: t.exitTs, entry: t.entry, finalPts: t.finalPts, snaps: t.snaps }))));
console.error(`wrote ${path.join(OUTDIR, DATE + '.json')}`);
