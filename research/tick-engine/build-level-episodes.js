#!/usr/bin/env node
/**
 * For every 15-minute window, for every level knowable BEFORE that window, measure how price
 * interacted with it — and measure the identical thing for a displaced PLACEBO level.
 *
 * Levels: GEX call_wall / put_wall / gamma_flip / resistance[0..2] / support[0..2], and LT level_1..5.
 * Placebo: same side, displaced by a deterministic pseudo-random 30–120 ticks (the C1 rand_offset
 * method). Without this, "price interacts with a level" is information-free — 81% of the RTH range
 * sits within 5 points of *some* level (C1 §2).
 *
 * Knowability: the level snapshot is taken at-or-before the window OPEN; the anatomy covers the
 * window; the forward return starts at the window CLOSE.
 *
 *   node build-level-episodes.js --product NQ [--band 8] [--out level-episodes]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache } from './cache.js';
import { loadLT, loadGEX, asOf } from './levels.js';
import { analyzeAroundLevel } from './zone-anatomy.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const P = (arg('product', 'NQ')).toUpperCase();
const BAND = +arg('band', 8);                    // "at the level" half-width, ticks (8 = 2 NQ pts)
const WIN = 900;                                 // 15-minute windows, matching the snapshot cadence
const OUT = path.join(__dirname, arg('out', 'level-episodes')); fs.mkdirSync(OUT, { recursive: true });
const C = loadCache(P), TICK = C.meta.tickSize;
const LT = loadLT(P), GX = loadGEX(P);
const toTicks = (px) => Math.round(px / TICK);
// deterministic same-side displacement, 30–120 ticks
function crc(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return Math.abs(h); }
const placeboOf = (lvlTicks, key) => { const r = crc(key); return lvlTicks + (r % 2 ? 1 : -1) * (30 + (r % 91)); };

const COLS = ['tradeDate', 'winTs', 'src', 'name', 'levelPx', 'isPlacebo', 'distTicks', 'spot',
  'timeAt', 'timeAbove', 'timeBelow', 'volAt', 'volAbove', 'volBelow', 'intAt', 'intAbove', 'intBelow',
  'centroidAtV', 'firstAtPct', 'lastAtPct', 'crossings', 'penAboveTicks', 'penBelowTicks', 'volTotal',
  'totalGex', 'gammaImb', 'regime', 'fwd15Ticks', 'fwd60Ticks', 'atrTicks'];
const ws = fs.createWriteStream(path.join(OUT, `${P}_episodes.csv`));
ws.write(COLS.join(',') + '\n');
const days = C.meta.days, dayKeys = Object.keys(days).sort();
let rows = 0, buf = [];
const t0 = Date.now();
for (const td of dayKeys) {
  const [a, b] = days[td];
  const sOpen = C.ts[a];
  // rolling ATR proxy over 15m windows of this day
  let prevWinClose = null, atr = 0, atrN = 0;
  let i = a;
  while (i < b) {
    const k = Math.floor((C.ts[i] - sOpen) / WIN);
    const wOpen = sOpen + k * WIN, wEnd = wOpen + WIN;
    let j = i, hi = -2e9, lo = 2e9;
    while (j < b && C.ts[j] < wEnd) { if (C.h[j] > hi) hi = C.h[j]; if (C.l[j] < lo) lo = C.l[j]; j++; }
    if (j <= i) { i++; continue; }
    const spot = C.o[i], wClose = C.c[j - 1];
    atr = atrN ? (atr * 13 + (hi - lo)) / 14 : (hi - lo); atrN++;
    // forward returns measured from the window CLOSE
    let f15 = null, f60 = null;
    { const e1 = Math.min(b - 1, j + 0); if (j < b) { let x = j, endTs = wEnd + WIN; while (x < b && C.ts[x] < endTs) x++; f15 = C.c[Math.min(x, b) - 1] - wClose; }
      { let x = j, endTs = wEnd + 4 * WIN; while (x < b && C.ts[x] < endTs) x++; f60 = C.c[Math.min(x, b) - 1] - wClose; } }
    // ---- levels knowable at or before the window open
    const cand = [];
    const g = asOf(GX, wOpen, 3600);
    if (g) {
      const push = (nm, px) => { if (Number.isFinite(px) && px > 0) cand.push(['gex', nm, toTicks(px), g]); };
      push('callWall', g.callWall); push('putWall', g.putWall); push('gammaFlip', g.gammaFlip);
      (g.resistance || []).slice(0, 3).forEach((px, n) => push('res' + n, px));
      (g.support || []).slice(0, 3).forEach((px, n) => push('sup' + n, px));
    }
    const l = asOf(LT, wOpen, 3600);
    if (l) l.levels.forEach((px, n) => { if (px > 0) cand.push(['lt', 'lt' + (n + 1), toTicks(px), g]); });
    for (const [src, name, lvT, gg] of cand) {
      for (const isP of [0, 1]) {
        const L = isP ? placeboOf(lvT, `${td}|${name}|${k}`) : lvT;
        if (L < lo - 400 || L > hi + 400) continue;                 // never came near: skip both arms together
        const an = analyzeAroundLevel(C.l, C.h, C.v, C.ts, i, j, L, BAND, wOpen, WIN);
        if (!an) continue;
        buf.push([td, wOpen, src, name, (L * TICK).toFixed(2), isP, L - spot, spot,
          an.timeAt, an.timeAbove, an.timeBelow, an.volAt, an.volAbove, an.volBelow,
          an.intAt ?? '', an.intAbove ?? '', an.intBelow ?? '', an.centroidAtV ?? '',
          an.firstAtPct ?? '', an.lastAtPct ?? '', an.crossings, an.penAboveTicks, an.penBelowTicks, an.volTotal,
          gg ? (gg.totalGex / 1e9).toFixed(3) : '', gg ? (gg.gammaImbalance ?? '') : '', gg ? gg.regime : '',
          f15 ?? '', f60 ?? '', Math.round(atr)].join(','));
        rows++;
      }
    }
    if (buf.length >= 20000) { ws.write(buf.join('\n') + '\n'); buf = []; }
    prevWinClose = wClose;
    i = j;
  }
}
if (buf.length) ws.write(buf.join('\n') + '\n');
ws.end();
console.log(`${P}: ${rows.toLocaleString()} level-window episodes (real + placebo) in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${OUT}/${P}_episodes.csv`);
