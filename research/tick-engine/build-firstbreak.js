#!/usr/bin/env node
/**
 * FIRST-BREAK dataset: for every completed candle, does its HIGH or its LOW get touched first?
 *
 * The candle defines the whole trade: enter at its close, target one extreme, stop at the other.
 * So the payoff needs no arbitrary parameters — it is fixed by the candle's own geometry:
 *     long  : win = high − close, lose = close − low
 *     short : win = close − low,  lose = high − close
 * Features are everything knowable at the close (full wick anatomy). The label comes from walking 1s
 * bars forward from the close — exact, except when a single second touches BOTH extremes, which is
 * recorded as ambiguous and resolved ADVERSELY (counted against whichever side we would have bet).
 *
 *   node build-firstbreak.js --product NQ --tfs 3m,5m,15m [--horizon 4]   (horizon in candles)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache } from './cache.js';
import { analyzeCandle } from './wick-anatomy.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const P = (arg('product', 'NQ')).toUpperCase();
const TFS = arg('tfs', '3m,5m,15m').split(',');
const HOR = +arg('horizon', 4);
const OUT = path.join(__dirname, 'firstbreak'); fs.mkdirSync(OUT, { recursive: true });
const C = loadCache(P), TICK = C.meta.tickSize;
const secOf = (tf) => +tf.slice(0, -1) * (tf.endsWith('m') ? 60 : 3600);
const days = C.meta.days, dayKeys = Object.keys(days).sort();

const COLS = ['tradeDate','ts','o','h','l','c','v','n1s','rangeTicks','bodyTicks','upWickTicks','dnWickTicks','clv',
  'upTimePct','dnTimePct','upVolPct','dnVolPct','bodyVolPct','upCentroidV','dnCentroidV','upExtremePct','dnExtremePct',
  'upTouches','dnTouches','upInt','dnInt','atrTicks','volZ',
  'firstBreak','secsToBreak','ambiguous','winLongTicks','loseLongTicks'];

for (const tf of TFS) {
  const sec = secOf(tf);
  const ws = fs.createWriteStream(path.join(OUT, `${P}_${tf}_fb.csv`));
  ws.write(COLS.join(',') + '\n');
  let rows = 0, buf = [], amb = 0, hiFirst = 0, loFirst = 0, none = 0;
  const t0 = Date.now();
  for (const td of dayKeys) {
    const [a, b] = days[td];
    const sOpen = C.ts[a];
    // pass 1: candle boundaries for the day
    const cand = [];
    let i = a;
    while (i < b) {
      const k = Math.floor((C.ts[i] - sOpen) / sec);
      const cOpen = sOpen + k * sec, cEnd = cOpen + sec;
      let j = i, hi = -2e9, lo = 2e9, vol = 0;
      while (j < b && C.ts[j] < cEnd) { if (C.h[j] > hi) hi = C.h[j]; if (C.l[j] < lo) lo = C.l[j]; vol += C.v[j]; j++; }
      if (j > i) cand.push({ i, j, cOpen, hi, lo, vol, o: C.o[i], c: C.c[j - 1] });
      i = j > i ? j : i + 1;
    }
    // rolling ATR / volume z over the day's candles
    let atr = 0, vmean = 0, n = 0;
    for (let x = 0; x < cand.length; x++) {
      const cd = cand[x];
      const rng = cd.hi - cd.lo;
      atr = n ? (atr * 13 + rng) / 14 : rng; vmean = n ? (vmean * 13 + cd.vol) / 14 : cd.vol; n++;
      if (n < 15 || rng <= 0) continue;
      const d = analyzeCandle(C.l, C.h, C.v, C.ts, cd.i, cd.j, cd.o, cd.hi, cd.lo, cd.c, cd.cOpen, sec);
      // ---- label: walk 1s forward from the close, up to HOR candles
      const endTs = cd.cOpen + sec * (1 + HOR);
      let fb = 0, secs = null, ambiguous = 0;
      for (let r = cd.j; r < b && C.ts[r] < endTs; r++) {
        const hitH = C.h[r] >= cd.hi, hitL = C.l[r] <= cd.lo;
        if (hitH && hitL) { ambiguous = 1; fb = 2; secs = C.ts[r] - (cd.cOpen + sec); break; }   // both in one second
        if (hitH) { fb = 1; secs = C.ts[r] - (cd.cOpen + sec); break; }
        if (hitL) { fb = -1; secs = C.ts[r] - (cd.cOpen + sec); break; }
      }
      if (fb === 1) hiFirst++; else if (fb === -1) loFirst++; else if (fb === 2) amb++; else none++;
      const bodyTop = Math.max(cd.o, cd.c), bodyBot = Math.min(cd.o, cd.c);
      buf.push([td, cd.cOpen, (cd.o*TICK).toFixed(2), (cd.hi*TICK).toFixed(2), (cd.lo*TICK).toFixed(2), (cd.c*TICK).toFixed(2), cd.vol, d.n1s,
        rng, bodyTop-bodyBot, cd.hi-bodyTop, bodyBot-cd.lo, +(((cd.c-cd.lo)/rng)).toFixed(4),
        d.upTimePct, d.dnTimePct, d.upVolPct, d.dnVolPct, d.bodyVolPct, d.upCentroidV ?? '', d.dnCentroidV ?? '',
        d.upExtremePct ?? '', d.dnExtremePct ?? '', d.upTouches, d.dnTouches,
        d.upTimePct>0 ? +(d.upVolPct/d.upTimePct).toFixed(4) : '', d.dnTimePct>0 ? +(d.dnVolPct/d.dnTimePct).toFixed(4) : '',
        Math.round(atr), vmean>0 ? +(cd.vol/vmean).toFixed(3) : '',
        fb, secs ?? '', ambiguous, cd.hi-cd.c, cd.c-cd.lo].join(','));
      rows++;
      if (buf.length >= 20000) { ws.write(buf.join('\n')+'\n'); buf = []; }
    }
  }
  if (buf.length) ws.write(buf.join('\n')+'\n');
  ws.end();
  const tot = hiFirst+loFirst+amb+none;
  console.log(`${P} ${tf}: ${rows.toLocaleString()} candles in ${((Date.now()-t0)/1000).toFixed(1)}s → firstbreak/${P}_${tf}_fb.csv`);
  console.log(`   high first ${(hiFirst/tot*100).toFixed(1)}%  low first ${(loFirst/tot*100).toFixed(1)}%  ambiguous(same second) ${(amb/tot*100).toFixed(2)}%  neither within ${HOR} candles ${(none/tot*100).toFixed(1)}%`);
}
