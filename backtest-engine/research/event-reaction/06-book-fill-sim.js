/**
 * Phase 4b — Book-honest fill simulation of the fast event-reaction edge.
 *
 * Reads output/book-windows-mbp1.csv (Phase 4a). For each release, determines the
 * impulse direction from the book mid at +ENTRY_SEC vs the pre-release mid, then
 * enters in that direction and simulates realistic fills for FIVE order types:
 *   - market:        fill = prevailing opposite quote at (decision + latency).
 *   - limit@touch:   buy limit = best bid (sell = best ask) at decision.
 *   - limit@mid:     limit at mid.
 *   - limit@+1tick:  1 tick INTO the book (more aggressive; fills more, worse px).
 * A limit fills only if a trade actually PRINTS through it within ENTRY_TIMEOUT;
 * otherwise it's a MISS (no trade) — momentum runners escape passive limits.
 *
 * Exits from the fill: target (passive limit, fills at target px), stop (market,
 * fills at prevailing book quote when a print triggers it), hard MAX_HOLD time-stop
 * (exit at prevailing quote). First of target/stop on the trade-print path wins;
 * stop checked before target within the same instant (conservative).
 *
 * All prices in NQ points ($20/pt). Slippage is now MODELED, not assumed; only a
 * small commission is charged. Reports per basket & type, plus train/test halves.
 *
 * Usage: node research/event-reaction/06-book-fill-sim.js \
 *   [--entry 5] [--latency 250] [--tgt 60] [--stop 30] [--maxhold 300] [--timeout 30]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOK = path.join(__dirname, 'output', 'book-windows-mbp1.csv');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
const ENTRY_SEC = parseFloat(arg('entry', '5'));
const LATENCY_MS = parseInt(arg('latency', '250'), 10);
const TGT = parseFloat(arg('tgt', '60'));
const STOP = parseFloat(arg('stop', '30'));
const MAX_HOLD = parseInt(arg('maxhold', '300'), 10);
const ENTRY_TIMEOUT = parseInt(arg('timeout', '30'), 10); // s a resting limit waits before cancel
const TICK = 0.25;
const COMMISSION_PTS = 0.1; // ~$4 roundtrip / $20 = 0.2pt; charge 0.1 each way baked as 0.1 total-ish → use 0.1 pts RT proxy

// --- load book windows grouped by event ---
function loadBook() {
  const lines = fs.readFileSync(BOOK, 'utf8').trim().split('\n');
  const col = {}; lines[0].split(',').forEach((h, i) => (col[h] = i));
  const ev = new Map();
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(',');
    const id = c[col.event_id];
    if (!ev.has(id)) ev.set(id, { id, type: c[col.type], date: id.split('_')[0], snaps: [], prints: [] });
    const t = +c[col.rel_ms];
    const bid = +c[col.bid_px], ask = +c[col.ask_px];
    const e = ev.get(id);
    if (bid > 0 && ask > 0 && ask >= bid) e.snaps.push({ t, bid, ask, bidSz: +c[col.bid_sz], askSz: +c[col.ask_sz] });
    if (c[col.action] === 'T') e.prints.push({ t, px: +c[col.price], sz: +c[col.size] });
  }
  for (const e of ev.values()) { e.snaps.sort((a, b) => a.t - b.t); e.prints.sort((a, b) => a.t - b.t); }
  return [...ev.values()];
}

// prevailing L1 snapshot at time t (last snap with snap.t <= t)
function quoteAt(snaps, t) {
  let lo = 0, hi = snaps.length - 1, res = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (snaps[m].t <= t) { res = snaps[m]; lo = m + 1; } else hi = m - 1; }
  return res;
}

// simulate one event for one order type; returns {filled, netPts} or {filled:false}
function simEvent(e, orderType) {
  const decMs = ENTRY_SEC * 1000;
  const preSnap = quoteAt(e.snaps, -1);          // pre-release quote
  const decSnap = quoteAt(e.snaps, decMs);       // quote at decision
  const impSnap = quoteAt(e.snaps, decMs);
  if (!preSnap || !decSnap || !impSnap) return { filled: false };
  const preMid = (preSnap.bid + preSnap.ask) / 2;
  const decMid = (decSnap.bid + decSnap.ask) / 2;
  const dir = Math.sign(decMid - preMid);
  if (dir === 0) return { filled: false };

  // --- ENTRY FILL ---
  let entryPx = null, entryT = null;
  if (orderType === 'market') {
    const fillMs = decMs + LATENCY_MS;
    const q = quoteAt(e.snaps, fillMs);
    if (!q) return { filled: false };
    entryPx = dir > 0 ? q.ask : q.bid;           // cross the spread
    entryT = fillMs;
  } else {
    // limit near price
    let limitPx;
    if (orderType === 'limit@touch') limitPx = dir > 0 ? decSnap.bid : decSnap.ask;
    else if (orderType === 'limit@mid') limitPx = dir > 0 ? Math.floor(decMid / TICK) * TICK : Math.ceil(decMid / TICK) * TICK;
    else /* limit@+1tick */ limitPx = dir > 0 ? decSnap.bid + TICK : decSnap.ask - TICK;
    const restFrom = decMs + LATENCY_MS, restTo = restFrom + ENTRY_TIMEOUT * 1000;
    for (const p of e.prints) {
      if (p.t < restFrom) continue;
      if (p.t > restTo) break;
      if ((dir > 0 && p.px <= limitPx) || (dir < 0 && p.px >= limitPx)) { entryPx = limitPx; entryT = p.t; break; }
    }
    if (entryPx == null) return { filled: false };  // MISS
  }

  // --- EXIT: walk prints from entryT ---
  const tgtPx = dir > 0 ? entryPx + TGT : entryPx - TGT;
  const stopPx = dir > 0 ? entryPx - STOP : entryPx + STOP;
  const holdEnd = entryT + MAX_HOLD * 1000;
  let exitPx = null;
  for (const p of e.prints) {
    if (p.t <= entryT) continue;
    if (p.t > holdEnd) break;
    const hitStop = dir > 0 ? p.px <= stopPx : p.px >= stopPx;
    const hitTgt = dir > 0 ? p.px >= tgtPx : p.px <= tgtPx;
    if (hitStop) { const q = quoteAt(e.snaps, p.t); exitPx = dir > 0 ? (q ? q.bid : stopPx) : (q ? q.ask : stopPx); break; } // market exit at book
    if (hitTgt) { exitPx = tgtPx; break; }         // passive limit exit
  }
  if (exitPx == null) { const q = quoteAt(e.snaps, holdEnd); if (!q) return { filled: false }; exitPx = dir > 0 ? q.bid : q.ask; } // time-stop, exit at book

  const gross = dir * (exitPx - entryPx);
  return { filled: true, netPts: gross - COMMISSION_PTS, type: e.type, date: e.date, dir,
           entrySlip: dir * (entryPx - decMid) };
}

function stats(arr) {
  const f = arr.filter((r) => r.filled);
  let wins = 0, gp = 0, gl = 0, tot = 0;
  for (const r of f) { tot += r.netPts; if (r.netPts > 0) { wins++; gp += r.netPts; } else gl += -r.netPts; }
  return { attempts: arr.length, n: f.length, fillRate: arr.length ? f.length / arr.length : 0,
           wr: f.length ? wins / f.length * 100 : 0, pf: gl ? gp / gl : (gp > 0 ? Infinity : 0),
           avg: f.length ? tot / f.length : 0, tot };
}

const EVENTS = loadBook();
console.log(`\n=== BOOK-HONEST fill sim ===`);
console.log(`entry +${ENTRY_SEC}s | latency ${LATENCY_MS}ms | tgt ${TGT}/stop ${STOP} | maxhold ${MAX_HOLD}s | limit timeout ${ENTRY_TIMEOUT}s`);
console.log(`Events with book: ${EVENTS.length}\n`);

const ORDER_TYPES = ['market', 'limit@touch', 'limit@mid', 'limit@+1tick'];
const types = [...new Set(EVENTS.map((e) => e.type))].sort();

for (const ot of ORDER_TYPES) {
  const recs = EVENTS.map((e) => simEvent(e, ot));
  const s = stats(recs);
  console.log(`--- ${ot} ---`);
  console.log(['group', 'attempts', 'fills', 'fill%', 'WR%', 'PF', 'avgPts', '$tot'].join('\t'));
  const groups = { ALL: recs };
  for (const t of types) groups[t] = recs.filter((r) => !r.filled ? EVENTS.find((e) => true) && false : r.type === t);
  // rebuild per-type including misses: need type on misses too → recompute with event type
  const recsTyped = EVENTS.map((e) => ({ e, r: simEvent(e, ot) }));
  const g2 = { ALL: recsTyped.map((x) => x.r) };
  for (const t of types) g2[t] = recsTyped.filter((x) => x.e.type === t).map((x) => x.r);
  for (const [g, rs] of Object.entries(g2)) {
    const st = stats(rs);
    const pf = st.pf === Infinity ? '∞' : st.pf.toFixed(2);
    console.log([g, st.attempts, st.n, (st.fillRate * 100).toFixed(0), st.wr.toFixed(0), pf, st.avg.toFixed(1), `$${(st.tot * 20).toFixed(0)}`].join('\t'));
  }
  // entry slippage + long/short split (market only) + train/test on ALL
  if (ot === 'market') {
    const slips = recs.filter((r) => r.filled).map((r) => r.entrySlip);
    console.log(`  mean entry slippage vs decision-mid: ${(slips.reduce((a, b) => a + b, 0) / slips.length).toFixed(2)} pts`);
    for (const [lbl, d] of [['LONG', 1], ['SHORT', -1]]) {
      const st = stats(recsTyped.filter((x) => x.r.filled && x.r.dir === d).map((x) => x.r));
      const pf = st.pf === Infinity ? '∞' : st.pf.toFixed(2);
      console.log(`  ${lbl}: n=${st.n} WR ${st.wr.toFixed(0)}% PF ${pf} avg ${st.avg.toFixed(1)}pt $${(st.tot * 20).toFixed(0)}`);
    }
  }
  const sorted = recsTyped.slice().sort((a, b) => (a.e.date < b.e.date ? -1 : 1)).map((x) => x.r);
  const mid = Math.floor(sorted.length / 2);
  const h1 = stats(sorted.slice(0, mid)), h2 = stats(sorted.slice(mid));
  const pf = (s) => (s.pf === Infinity ? '∞' : s.pf.toFixed(2));
  console.log(`  train/test: H1 n=${h1.n} PF ${pf(h1)} avg ${h1.avg.toFixed(1)} | H2 n=${h2.n} PF ${pf(h2)} avg ${h2.avg.toFixed(1)}\n`);
}
