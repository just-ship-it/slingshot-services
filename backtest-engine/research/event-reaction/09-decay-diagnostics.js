/**
 * Decay diagnostics — is the H1→H2 fade REGIME (moves shrank) or ALPHA DECAY
 * (directional skill faded)? Decomposes per calendar quarter:
 *
 *   move regime  = median |close@300s - P_ref| over ALL tradeable events
 *                  (how impactful releases were — independent of our strategy)
 *   impulse size = median |close@5s - P_ref| (size of the initial reaction)
 *   skill        = continuation rate: P(sign@5s == sign@300s) over events with
 *                  a nonzero impulse (the raw edge, independent of tgt/stop/slip)
 *   strategy     = actual backtest PF/WR/avg (entry +5s, persist, book slippage)
 *
 * If move+impulse shrink while skill holds → REGIME (fuel ran low; gate on vol).
 * If moves hold while skill drops → ALPHA DECAY (signal dying).
 *
 * Usage: node research/event-reaction/09-decay-diagnostics.js [--product NQ]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; }
const PRODUCT = arg('product', 'NQ').toUpperCase();
const BARS = path.join(__dirname, 'output', `event-windows-1s-${PRODUCT}.csv`);
const TYPES = new Set(['CPI', 'NFP', 'PCE', 'PPI']);
const ENTRY = 5, PERSIST = 3, TGT = PRODUCT === 'ES' ? 18 : 60, STOP = PRODUCT === 'ES' ? 9 : 30;
const ENTRY_SLIP = PRODUCT === 'ES' ? 1.0 : 2.25, STOP_SLIP = PRODUCT === 'ES' ? 0.75 : 1.5, MAXHOLD = 300;
const PV = PRODUCT === 'ES' ? 50 : 20;

function load() {
  const lines = fs.readFileSync(BARS, 'utf8').trim().split('\n');
  const col = {}; lines[0].split(',').forEach((h, i) => (col[h] = i));
  const ev = new Map();
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(',');
    if (!TYPES.has(c[col.event_type])) continue;
    const id = c[col.event_id];
    if (!ev.has(id)) ev.set(id, { id, type: c[col.event_type], date: id.split('_')[0], bars: [] });
    ev.get(id).bars.push({ rel: +c[col.rel_sec], h: +c[col.high], l: +c[col.low], c: +c[col.close] });
  }
  const arr = [...ev.values()];
  for (const e of arr) e.bars.sort((a, b) => a.rel - b.rel);
  return arr;
}
const priceAt = (b, r) => { let p = null; for (const x of b) { if (x.rel <= r) p = x.c; else break; } return p; };
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const quarter = (d) => { const [y, m] = d.split('-'); return `${y}-Q${Math.floor((+m - 1) / 3) + 1}`; };

function sim(e) {
  const pRef = priceAt(e.bars, -1), pEn = priceAt(e.bars, ENTRY);
  if (pRef == null || pEn == null) return null;
  const dir = Math.sign(pEn - pRef);
  if (dir === 0) return null;
  if (Math.sign(priceAt(e.bars, PERSIST) - pRef) !== dir) return { skip: true };
  const fill = pEn + dir * ENTRY_SLIP;
  const tgt = dir > 0 ? fill + TGT : fill - TGT, stp = dir > 0 ? fill - STOP : fill + STOP;
  let g = null;
  for (const b of e.bars) {
    if (b.rel <= ENTRY) continue; if (b.rel > ENTRY + MAXHOLD) break;
    if (dir > 0 ? b.l <= stp : b.h >= stp) { g = -STOP - STOP_SLIP; break; }
    if (dir > 0 ? b.h >= tgt : b.l <= tgt) { g = TGT; break; }
  }
  if (g == null) g = dir * (priceAt(e.bars, ENTRY + MAXHOLD) - fill);
  return { net: g - 0.2 };
}

const EVENTS = load().sort((a, b) => (a.date < b.date ? -1 : 1));
const byQ = new Map();
for (const e of EVENTS) {
  const q = quarter(e.date);
  if (!byQ.has(q)) byQ.set(q, []);
  byQ.get(q).push(e);
}

console.log(`\n=== DECAY DIAGNOSTICS — ${PRODUCT} (${EVENTS.length} events) ===`);
console.log('move = median|move@300s| (regime) | imp = median|impulse@5s| | skill = P(sign5s==sign300s)\n');
console.log(['quarter', 'nEv', 'move', 'imp', 'skill%', 'stratN', 'WR%', 'PF', 'avgPt', '$tot'].join('\t'));

for (const [q, evs] of [...byQ.entries()].sort()) {
  const moves = [], imps = []; let cont = 0, contN = 0;
  for (const e of evs) {
    const pRef = priceAt(e.bars, -1), p5 = priceAt(e.bars, 5), p300 = priceAt(e.bars, 300);
    if (pRef == null || p5 == null || p300 == null) continue;
    moves.push(Math.abs(p300 - pRef));
    imps.push(Math.abs(p5 - pRef));
    if (Math.sign(p5 - pRef) !== 0) { contN++; if (Math.sign(p5 - pRef) === Math.sign(p300 - pRef)) cont++; }
  }
  const sims = evs.map(sim).filter((s) => s && !s.skip);
  let w = 0, gp = 0, gl = 0, tot = 0;
  for (const s of sims) { tot += s.net; if (s.net > 0) { w++; gp += s.net; } else gl += -s.net; }
  const pf = gl ? (gp / gl).toFixed(2) : '∞';
  console.log([q, evs.length, median(moves).toFixed(0), median(imps).toFixed(0),
    contN ? (cont / contN * 100).toFixed(0) : 'NA', sims.length,
    sims.length ? (w / sims.length * 100).toFixed(0) : '0', pf,
    sims.length ? (tot / sims.length).toFixed(1) : '0', `$${(tot * PV).toFixed(0)}`].join('\t'));
}
console.log('\nRead: if move+imp fall while skill holds → REGIME. If move holds while skill falls → DECAY.');
