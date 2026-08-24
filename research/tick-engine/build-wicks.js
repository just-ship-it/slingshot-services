#!/usr/bin/env node
/**
 * Catalog wick anatomy for every completed candle on the requested timeframes.
 *   node build-wicks.js --product NQ --tfs 3m,5m,15m [--out wicks] [--from YYYY-MM-DD] [--to ...]
 * Emits one CSV per timeframe + a summary to stdout.
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
const OUT = path.join(__dirname, arg('out', 'wicks')); fs.mkdirSync(OUT, { recursive: true });
const C = loadCache(P);
const TICK = C.meta.tickSize;
const [from, to] = (() => { const r = C.range(arg('from'), arg('to')); return r ? [r[0], r[1]] : [0, C.n]; })();
const secOf = (tf) => (tf.endsWith('m') ? +tf.slice(0, -1) * 60 : +tf.slice(0, -1) * 3600);
const days = C.meta.days, dayKeys = Object.keys(days).sort().filter((k) => days[k][1] > from && days[k][0] < to);

const COLS = ['tradeDate', 'ts', 'sym', 'o', 'h', 'l', 'c', 'v', 'n1s', 'rangeTicks', 'bodyTicks', 'upWickTicks', 'dnWickTicks',
  'upTimePct', 'bodyTimePct', 'dnTimePct', 'upVolPct', 'bodyVolPct', 'dnVolPct',
  'upCentroidT', 'upCentroidV', 'dnCentroidT', 'dnCentroidV', 'bodyCentroidV',
  'upExtremePct', 'dnExtremePct', 'upFirstPct', 'upLastPct', 'dnFirstPct', 'dnLastPct', 'upTouches', 'dnTouches'];

for (const tf of TFS) {
  const sec = secOf(tf);
  const ws = fs.createWriteStream(path.join(OUT, `${P}_${tf}_wicks.csv`));
  ws.write(COLS.join(',') + '\n');
  let rows = 0, buf = [];
  const t0 = Date.now();
  const agg = { up: 0, dn: 0, upV: 0, dnV: 0, n: 0, upEarly: 0, dnEarly: 0, upN: 0, dnN: 0 };
  for (const td of dayKeys) {
    const [a, b] = days[td];
    const sOpen = C.ts[a];
    let i = a;
    while (i < b) {
      const k = Math.floor((C.ts[i] - sOpen) / sec);
      const cOpen = sOpen + k * sec, cEnd = cOpen + sec;
      let j = i;
      let hi = -2e9, lo = 2e9, vol = 0;
      while (j < b && C.ts[j] < cEnd) { if (C.h[j] > hi) hi = C.h[j]; if (C.l[j] < lo) lo = C.l[j]; vol += C.v[j]; j++; }
      if (j > i) {
        const o = C.o[i], c = C.c[j - 1];
        const d = analyzeCandle(C.l, C.h, C.v, C.ts, i, j, o, hi, lo, c, cOpen, sec);
        const bodyTop = Math.max(o, c), bodyBot = Math.min(o, c);
        buf.push([td, cOpen, C.meta.symbols[C.sym[i]], o * TICK, hi * TICK, lo * TICK, c * TICK, vol, d.n1s,
          hi - lo, bodyTop - bodyBot, hi - bodyTop, bodyBot - lo,
          d.upTimePct, d.bodyTimePct, d.dnTimePct, d.upVolPct, d.bodyVolPct, d.dnVolPct,
          d.upCentroidT ?? '', d.upCentroidV ?? '', d.dnCentroidT ?? '', d.dnCentroidV ?? '', d.bodyCentroidV ?? '',
          d.upExtremePct ?? '', d.dnExtremePct ?? '', d.upFirstPct ?? '', d.upLastPct ?? '', d.dnFirstPct ?? '', d.dnLastPct ?? '',
          d.upTouches, d.dnTouches].join(','));
        rows++;
        agg.n++; agg.up += d.upTimePct; agg.dn += d.dnTimePct; agg.upV += d.upVolPct; agg.dnV += d.dnVolPct;
        if (d.upCentroidV != null) { agg.upN++; agg.upEarly += d.upCentroidV; }
        if (d.dnCentroidV != null) { agg.dnN++; agg.dnEarly += d.dnCentroidV; }
        if (buf.length >= 20000) { ws.write(buf.join('\n') + '\n'); buf = []; }
      }
      i = j > i ? j : i + 1;
    }
  }
  if (buf.length) ws.write(buf.join('\n') + '\n');
  ws.end();
  console.log(`${P} ${tf}: ${rows.toLocaleString()} candles in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${OUT}/${P}_${tf}_wicks.csv`);
  console.log(`   mean time in wicks: up ${(agg.up / agg.n * 100).toFixed(1)}%  dn ${(agg.dn / agg.n * 100).toFixed(1)}%  |  ` +
              `mean volume in wicks: up ${(agg.upV / agg.n * 100).toFixed(1)}%  dn ${(agg.dnV / agg.n * 100).toFixed(1)}%`);
  console.log(`   mean wick volume-centroid (0=open,1=close): up ${(agg.upEarly / agg.upN).toFixed(3)}  dn ${(agg.dnEarly / agg.dnN).toFixed(3)}`);
}
