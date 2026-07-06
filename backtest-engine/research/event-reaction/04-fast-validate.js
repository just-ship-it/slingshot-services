/**
 * Phase 3b — Validate the FAST-reaction continuation edge (first ~5-20s).
 *
 * The +60s-and-later sweep missed it: the knee-jerk continuation decays by +60s.
 * Fast entries (+3..20s) show per-type structure — CPI/PCE/PPI continue, NFP fades.
 * Before calling it a live edge, charge realistic slippage AND split train/test.
 *
 * Slippage matters enormously here: entering market a few seconds after a release,
 * into a volume spike, is not a free fill. We charge a flat roundtrip cost (pts)
 * and sweep it 0..4 to find the break-even.
 *
 * Train/test: events split by chronological half (H1 = first ~60 events, H2 = rest).
 *
 * Usage: node research/event-reaction/04-fast-validate.js [--entry 5]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BARS = path.join(__dirname, 'output', 'event-windows-1s.csv');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
const ENTRY_SEC = parseInt(arg('entry', '5'), 10);
const TGT = parseInt(arg('tgt', '60'), 10);
const STOP = parseInt(arg('stop', '30'), 10);
const MAX_HOLD = parseInt(arg('maxhold', '300'), 10); // hard time-stop (s) — Drew: conclude <=5min

function loadEvents() {
  const lines = fs.readFileSync(BARS, 'utf8').trim().split('\n');
  const col = {}; lines[0].split(',').forEach((h, i) => (col[h] = i));
  const events = new Map();
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(',');
    const id = c[col.event_id];
    if (!events.has(id)) events.set(id, { id, type: c[col.event_type], date: id.split('_')[0], bars: [] });
    events.get(id).bars.push({ rel: +c[col.rel_sec], h: +c[col.high], l: +c[col.low], c: +c[col.close] });
  }
  const arr = [...events.values()];
  for (const ev of arr) ev.bars.sort((a, b) => a.rel - b.rel);
  arr.sort((a, b) => (a.date < b.date ? -1 : 1)); // chronological for train/test
  return arr;
}
const priceAt = (bars, r) => { let p = null; for (const b of bars) { if (b.rel <= r) p = b.c; else break; } return p; };

// simulate one directional trade, return GROSS points (cost charged later)
function simTrade(ev) {
  const pre = ev.bars.filter((b) => b.rel < 0);
  const pRef = pre.length ? pre[pre.length - 1].c : null;
  const entry = priceAt(ev.bars, ENTRY_SEC);
  if (pRef == null || entry == null) return null;
  const dir = Math.sign(entry - pRef);
  if (dir === 0) return null;
  const path = ev.bars.filter((b) => b.rel >= ENTRY_SEC && b.rel <= ENTRY_SEC + MAX_HOLD);
  let gross = null, hold = MAX_HOLD, exitReason = 'time';
  for (const b of path) {
    const fav = dir > 0 ? b.h - entry : entry - b.l;
    const adv = dir > 0 ? entry - b.l : b.h - entry;
    if (adv >= STOP) { gross = -STOP; hold = b.rel - ENTRY_SEC; exitReason = 'stop'; break; }   // stop-before-target (conservative)
    if (fav >= TGT) { gross = TGT; hold = b.rel - ENTRY_SEC; exitReason = 'target'; break; }
  }
  if (gross == null) { const last = path[path.length - 1]; gross = dir * (last.c - entry); } // 5-min time-stop
  return { type: ev.type, date: ev.date, impulse: entry - pRef, gross, hold, exitReason };
}

function stats(trades, cost) {
  let wins = 0, gp = 0, gl = 0, tot = 0;
  for (const t of trades) {
    const net = t.gross - cost;
    tot += net;
    if (net > 0) { wins++; gp += net; } else gl += -net;
  }
  const n = trades.length;
  return { n, wr: n ? wins / n * 100 : 0, pf: gl ? gp / gl : Infinity, avg: n ? tot / n : 0, tot };
}

const EVENTS = loadEvents();
const allTrades = EVENTS.map(simTrade).filter(Boolean);
const types = [...new Set(allTrades.map((t) => t.type))].sort();

console.log(`\n=== FAST-reaction validation: entry +${ENTRY_SEC}s, target ${TGT} / stop ${STOP}, max-hold ${MAX_HOLD}s ===`);
console.log(`Total trades: ${allTrades.length}`);
const exitMix = allTrades.reduce((m, t) => ((m[t.exitReason] = (m[t.exitReason] || 0) + 1), m), {});
const avgHold = allTrades.reduce((s, t) => s + t.hold, 0) / allTrades.length;
console.log(`Exit mix: ${JSON.stringify(exitMix)}  |  avg hold ${avgHold.toFixed(0)}s\n`);

console.log('--- SLIPPAGE SENSITIVITY (net PF by roundtrip cost, pts) ---');
console.log(['group', 'n', 'PF@0', 'PF@1', 'PF@2', 'PF@3', 'avg@2', '$tot@2'].join('\t'));
const groups = { ALL: allTrades, 'CPI+PCE+PPI': allTrades.filter((t) => ['CPI', 'PCE', 'PPI'].includes(t.type)) };
for (const t of types) groups[t] = allTrades.filter((x) => x.type === t);
for (const [g, ts] of Object.entries(groups)) {
  const pf = (c) => { const s = stats(ts, c); return s.pf === Infinity ? '∞' : s.pf.toFixed(2); };
  const s2 = stats(ts, 2);
  console.log([g, ts.length, pf(0), pf(1), pf(2), pf(3), s2.avg.toFixed(1), `$${(s2.tot * 20).toFixed(0)}`].join('\t'));
}

console.log('\n--- TRAIN/TEST (chronological halves, roundtrip cost = 2 pts) ---');
console.log(['group', 'H1 n', 'H1 PF', 'H1 avg', 'H2 n', 'H2 PF', 'H2 avg'].join('\t'));
for (const [g, ts] of Object.entries(groups)) {
  const mid = Math.floor(ts.length / 2);
  const h1 = stats(ts.slice(0, mid), 2), h2 = stats(ts.slice(mid), 2);
  const pf = (s) => (s.pf === Infinity ? '∞' : s.pf.toFixed(2));
  console.log([g, h1.n, pf(h1), h1.avg.toFixed(1), h2.n, pf(h2), h2.avg.toFixed(1)].join('\t'));
}
console.log('\nNOTE: earliest the LIVE minute-bar feed can act on an 08:30:00 release is the');
console.log('08:31:00 bar = +60s, where this edge has already decayed. Harvesting +5-20s needs');
console.log('a sub-minute execution path (1s/tick feed + fast market entry).');
