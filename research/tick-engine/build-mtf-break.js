#!/usr/bin/env node
/**
 * MTF BREAK: does LOWER-timeframe candle structure predict which side of the PREVIOUS HIGHER-
 * timeframe candle breaks first?
 *
 * Setup: HTF candle i closes → its high (Hh) and low (Hl) become the target/stop pair.
 * We then watch LTF candles forming after it. At the close of each LTF candle (while BOTH extremes
 * are still unbroken) we record:
 *    features  — that LTF candle's full wick anatomy, plus the cumulative path since the HTF close,
 *                plus the mechanical drivers (distance to each extreme, position in the HTF range)
 *    label     — which of Hh / Hl is touched first from that instant, walked on 1s bars
 *    payoff    — winTicks / loseTicks for a bracket placed right there (the R/R is set by geometry)
 *
 * Everything in `features` is knowable at that LTF close; the label comes strictly afterwards.
 * A second that touches both extremes is flagged ambiguous (0.02% of cases) and never counted as a win.
 *
 *   node build-mtf-break.js --product NQ --htf 15m --ltf 3m [--watch 10]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache } from './cache.js';
import { analyzeCandle } from './wick-anatomy.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const P = (arg('product', 'NQ')).toUpperCase();
const HTF = arg('htf', '15m'), LTF = arg('ltf', '3m');
const WATCH = +arg('watch', 10);
const OUT = path.join(__dirname, 'mtf'); fs.mkdirSync(OUT, { recursive: true });
const C = loadCache(P), TICK = C.meta.tickSize;
const secOf = (tf) => +tf.slice(0, -1) * (tf.endsWith('m') ? 60 : 3600);
const HS = secOf(HTF), LS = secOf(LTF);
const days = C.meta.days, dayKeys = Object.keys(days).sort();

const COLS = ['tradeDate','htfTs','ltfTs','k','Hh','Hl','px','htfRangeTicks','htfBodyTicks','htfClv','htfUpWick','htfDnWick',
  'distHiTicks','distLoTicks','posInRange','atrTicks',
  'lUpVolPct','lDnVolPct','lBodyVolPct','lUpTimePct','lDnTimePct','lUpCentroidV','lDnCentroidV','lUpInt','lDnInt',
  'lUpTouches','lDnTouches','lClv','lRangeTicks','lBodyTicks','lVolZ','lDir',
  'cumMoveTicks','cumVolZ','maxUpTicks','maxDnTicks',
  'firstBreak','secsToBreak','ambiguous','winTicks','loseTicks'];

const buildCandles = (a, b, sOpen, sec) => {
  const out = []; let i = a;
  while (i < b) {
    const k = Math.floor((C.ts[i] - sOpen) / sec);
    const cOpen = sOpen + k * sec, cEnd = cOpen + sec;
    let j = i, hi = -2e9, lo = 2e9, vol = 0;
    while (j < b && C.ts[j] < cEnd) { if (C.h[j] > hi) hi = C.h[j]; if (C.l[j] < lo) lo = C.l[j]; vol += C.v[j]; j++; }
    if (j > i) out.push({ i, j, cOpen, cEnd, hi, lo, vol, o: C.o[i], c: C.c[j - 1] });
    i = j > i ? j : i + 1;
  }
  return out;
};

const ws = fs.createWriteStream(path.join(OUT, `${P}_${HTF}_${LTF}_mtf.csv`));
ws.write(COLS.join(',') + '\n');
let rows = 0, buf = [], hiF = 0, loF = 0, amb = 0, none = 0;
const t0 = Date.now();
for (const td of dayKeys) {
  const [a, b] = days[td];
  const sOpen = C.ts[a];
  const H = buildCandles(a, b, sOpen, HS), L = buildCandles(a, b, sOpen, LS);
  if (H.length < 6 || L.length < 10) continue;
  let atr = 0, hn = 0, lvm = 0, ln = 0;
  const atrAt = new Map();
  for (const h of H) { const r = h.hi - h.lo; atr = hn ? (atr * 13 + r) / 14 : r; hn++; atrAt.set(h.cOpen, atr); }
  for (const l of L) { lvm = ln ? (lvm * 13 + l.vol) / 14 : l.vol; ln++; }
  let li = 0;
  for (let x = 14; x < H.length; x++) {
    const Hc = H[x], Hh = Hc.hi, Hl = Hc.lo;
    const rng = Hh - Hl; if (rng <= 0) continue;
    const atrH = atrAt.get(Hc.cOpen) || rng;
    const bodyTop = Math.max(Hc.o, Hc.c), bodyBot = Math.min(Hc.o, Hc.c);
    while (li < L.length && L[li].cOpen < Hc.cEnd) li++;              // first LTF candle after the HTF close
    let broken = false;
    for (let k = 0; k < WATCH && li + k < L.length && !broken; k++) {
      const Lc = L[li + k];
      // has either extreme already broken during this LTF candle? then the setup is over
      if (Lc.hi >= Hh || Lc.lo <= Hl) { broken = true; }
      const px = Lc.c;
      const d = analyzeCandle(C.l, C.h, C.v, C.ts, Lc.i, Lc.j, Lc.o, Lc.hi, Lc.lo, Lc.c, Lc.cOpen, LS);
      if (broken) break;                                              // record only pre-break decisions
      // cumulative path since the HTF close
      let cumVol = 0, maxUp = 0, maxDn = 0;
      for (let q = li; q <= li + k; q++) { cumVol += L[q].vol; if (L[q].hi - Hc.c > maxUp) maxUp = L[q].hi - Hc.c; if (Hc.c - L[q].lo > maxDn) maxDn = Hc.c - L[q].lo; }
      // ---- label from this LTF close forward
      const endTs = Lc.cEnd + LS * (WATCH - k);
      let fb = 0, secs = null, ambig = 0;
      for (let r = Lc.j; r < b && C.ts[r] < endTs; r++) {
        const hH = C.h[r] >= Hh, hL = C.l[r] <= Hl;
        if (hH && hL) { ambig = 1; fb = 2; secs = C.ts[r] - Lc.cEnd; break; }
        if (hH) { fb = 1; secs = C.ts[r] - Lc.cEnd; break; }
        if (hL) { fb = -1; secs = C.ts[r] - Lc.cEnd; break; }
      }
      if (fb === 1) hiF++; else if (fb === -1) loF++; else if (fb === 2) amb++; else none++;
      const lrng = Lc.hi - Lc.lo;
      buf.push([td, Hc.cOpen, Lc.cOpen, k, (Hh*TICK).toFixed(2), (Hl*TICK).toFixed(2), (px*TICK).toFixed(2),
        rng, bodyTop-bodyBot, +(((Hc.c-Hl)/rng)).toFixed(4), Hh-bodyTop, bodyBot-Hl,
        Hh-px, px-Hl, +(((px-Hl)/rng)).toFixed(4), Math.round(atrH),
        d.upVolPct, d.dnVolPct, d.bodyVolPct, d.upTimePct, d.dnTimePct, d.upCentroidV ?? '', d.dnCentroidV ?? '',
        d.upTimePct>0?+(d.upVolPct/d.upTimePct).toFixed(3):'', d.dnTimePct>0?+(d.dnVolPct/d.dnTimePct).toFixed(3):'',
        d.upTouches, d.dnTouches, lrng>0?+(((Lc.c-Lc.lo)/lrng)).toFixed(4):'', lrng, Math.abs(Lc.c-Lc.o),
        lvm>0?+(Lc.vol/lvm).toFixed(3):'', Lc.c>=Lc.o?1:-1,
        px-Hc.c, lvm>0?+(cumVol/((k+1)*lvm)).toFixed(3):'', maxUp, maxDn,
        fb, secs ?? '', ambig, Hh-px, px-Hl].join(','));
      rows++;
      if (buf.length >= 20000) { ws.write(buf.join('\n')+'\n'); buf = []; }
    }
  }
}
if (buf.length) ws.write(buf.join('\n')+'\n');
ws.end();
const tot = hiF+loF+amb+none;
console.log(`${P} ${HTF}←${LTF}: ${rows.toLocaleString()} decision points in ${((Date.now()-t0)/1000).toFixed(1)}s → mtf/${P}_${HTF}_${LTF}_mtf.csv`);
console.log(`   HTF high first ${(hiF/tot*100).toFixed(1)}%  low first ${(loF/tot*100).toFixed(1)}%  ambiguous ${(amb/tot*100).toFixed(2)}%  neither ${(none/tot*100).toFixed(1)}%`);
