/**
 * Phase 5 — Liquidity-sweep sensitivity of the entry trigger.
 *
 * Question (Drew): what happens when the first 1-3s spikes ONE way (a stop-run /
 * liquidity sweep) then reverses into the real impulse? Does the fixed-time
 * snapshot entry get faked out, and does a sweep-aware trigger do better?
 *
 * Measured on 1s data (event-windows-1s.csv), FRICTIONLESS (isolates the
 * path/direction question — fills already validated in 06). Tradeable types only.
 *
 * Sweep definition: early excursion >= SWEEP_PTS opposite to the settled (+10s)
 * direction within rel [0,3]. Fake-out: sign(move@3s) != sign(move@10s).
 *
 * Entry variants compared (all tgt60/stop30/maxhold300 on the 1s path):
 *   A snap@5s      : current fast — direction = sign(close@5s - P_ref).
 *   B snap@10s     : current robust.
 *   C persist@5s   : require sign(@3s)==sign(@5s); else SKIP (whipsaw filter).
 *   D break-after3s: ignore first 3s; from +3s, enter on first 1s close that is
 *                    > BREAK_PTS beyond P_ref, in that break's direction (lets the
 *                    sweep happen, then rides the reclaim).
 *
 * Usage: node research/event-reaction/07-sweep-analysis.js [--sweep 15] [--break 15]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BARS = path.join(__dirname, 'output', 'event-windows-1s.csv');
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; }
const SWEEP_PTS = parseFloat(arg('sweep', '15'));
const BREAK_PTS = parseFloat(arg('break', '15'));
const TRADE_TYPES = new Set(['CPI', 'PCE', 'PPI', 'NFP']);
const TGT = 60, STOP = 30, MAXHOLD = 300;

function load() {
  const lines = fs.readFileSync(BARS, 'utf8').trim().split('\n');
  const col = {}; lines[0].split(',').forEach((h, i) => (col[h] = i));
  const ev = new Map();
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(',');
    if (!TRADE_TYPES.has(c[col.event_type])) continue;
    const id = c[col.event_id];
    if (!ev.has(id)) ev.set(id, { id, type: c[col.event_type], date: id.split('_')[0], bars: [] });
    ev.get(id).bars.push({ rel: +c[col.rel_sec], h: +c[col.high], l: +c[col.low], c: +c[col.close] });
  }
  const arr = [...ev.values()];
  for (const e of arr) e.bars.sort((a, b) => a.rel - b.rel);
  return arr;
}
const priceAt = (bars, r) => { let p = null; for (const b of bars) { if (b.rel <= r) p = b.c; else break; } return p; };
const extr = (bars, lo, hi) => { let H = -1e18, L = 1e18; for (const b of bars) if (b.rel >= lo && b.rel <= hi) { if (b.h > H) H = b.h; if (b.l < L) L = b.l; } return { H, L }; };

// walk 1s path from entry, return gross pts (frictionless)
function ride(bars, entryRel, entryPx, dir) {
  const tgt = dir > 0 ? entryPx + TGT : entryPx - TGT;
  const stp = dir > 0 ? entryPx - STOP : entryPx + STOP;
  for (const b of bars) {
    if (b.rel <= entryRel) continue;
    if (b.rel > entryRel + MAXHOLD) break;
    const adv = dir > 0 ? entryPx - b.l : b.h - entryPx;
    const fav = dir > 0 ? b.h - entryPx : entryPx - b.l;
    if (adv >= STOP) return -STOP;   // stop before target (conservative)
    if (fav >= TGT) return TGT;
  }
  const last = priceAt(bars, entryRel + MAXHOLD);
  return dir * (last - entryPx);
}

function entryFor(e, variant) {
  const pRef = priceAt(e.bars, -1);
  if (pRef == null) return null;
  if (variant === 'A') { const p = priceAt(e.bars, 5); const d = Math.sign(p - pRef); return d ? { rel: 5, px: p, dir: d } : null; }
  if (variant === 'B') { const p = priceAt(e.bars, 10); const d = Math.sign(p - pRef); return d ? { rel: 10, px: p, dir: d } : null; }
  if (variant === 'C') {
    const d3 = Math.sign(priceAt(e.bars, 3) - pRef), d5 = Math.sign(priceAt(e.bars, 5) - pRef);
    if (d5 === 0 || d3 !== d5) return null;   // skip whipsaws
    return { rel: 5, px: priceAt(e.bars, 5), dir: d5 };
  }
  if (variant === 'D') {
    for (const b of e.bars) {
      if (b.rel < 3) continue;
      if (b.rel > 60) break;                  // must break within first minute
      if (b.c - pRef >= BREAK_PTS) return { rel: b.rel, px: b.c, dir: 1 };
      if (pRef - b.c >= BREAK_PTS) return { rel: b.rel, px: b.c, dir: -1 };
    }
    return null;
  }
}

const EVENTS = load();
console.log(`\n=== SWEEP ANALYSIS (tradeable types, ${EVENTS.length} events, frictionless) ===`);
console.log(`sweep>=${SWEEP_PTS}pt, break=${BREAK_PTS}pt\n`);

// --- prevalence ---
let sweeps = 0, fakeouts = 0;
for (const e of EVENTS) {
  const pRef = priceAt(e.bars, -1);
  const settled = Math.sign(priceAt(e.bars, 10) - pRef);
  const { H, L } = extr(e.bars, 0, 3);
  const upSweep = (H - pRef) >= SWEEP_PTS, dnSweep = (pRef - L) >= SWEEP_PTS;
  // sweep = early excursion >= SWEEP opposite to settled dir
  if ((settled > 0 && dnSweep) || (settled < 0 && upSweep)) sweeps++;
  const d3 = Math.sign(priceAt(e.bars, 3) - pRef);
  if (d3 !== 0 && settled !== 0 && d3 !== settled) fakeouts++;
}
console.log(`Events with a >=${SWEEP_PTS}pt early sweep OPPOSITE the settled(+10s) direction: ${sweeps}/${EVENTS.length} (${(sweeps / EVENTS.length * 100).toFixed(0)}%)`);
console.log(`Fake-outs (dir@3s != dir@10s — a +3s entry would be on the WRONG side): ${fakeouts}/${EVENTS.length} (${(fakeouts / EVENTS.length * 100).toFixed(0)}%)\n`);

// --- variant comparison ---
console.log('--- entry-variant comparison (frictionless, tgt60/stop30/5min) ---');
console.log(['variant', 'trades', 'skips', 'WR%', 'PF', 'avgPts', 'totPts'].join('\t'));
for (const [v, lbl] of [['A', 'snap@5s'], ['B', 'snap@10s'], ['C', 'persist@5s'], ['D', `break>${BREAK_PTS}@3s+`]]) {
  let wins = 0, gp = 0, gl = 0, tot = 0, n = 0, skip = 0;
  for (const e of EVENTS) {
    const en = entryFor(e, v);
    if (!en) { skip++; continue; }
    const g = ride(e.bars, en.rel, en.px, en.dir);
    n++; tot += g; if (g > 0) { wins++; gp += g; } else gl += -g;
  }
  const pf = gl ? (gp / gl).toFixed(2) : '∞';
  console.log([`${v} ${lbl}`, n, skip, n ? (wins / n * 100).toFixed(0) : '0', pf, n ? (tot / n).toFixed(1) : '0', tot.toFixed(0)].join('\t'));
}
console.log('\nNOTE: frictionless — compares DIRECTION/PATH robustness only. Add ~2-3pt market');
console.log('slippage (from 06) to fast variants; break@3s+ enters later so slippage is lower.');
