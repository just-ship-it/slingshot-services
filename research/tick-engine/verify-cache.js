#!/usr/bin/env node
/** Verify a built cache against the source CSV + internal invariants. usage: verify-cache.js NQ [nSamples] */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const P = (process.argv[2] || 'NQ').toUpperCase();
const N = +(process.argv[3] || 12);
const dir = path.join(__dirname, 'cache', P);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
const load = (n, T) => { const b = fs.readFileSync(path.join(dir, n)); return new T(b.buffer, b.byteOffset, b.length / T.BYTES_PER_ELEMENT); };
const ts = load('ts.i32', Int32Array), o = load('o.i32', Int32Array), h = load('h.i32', Int32Array),
      l = load('l.i32', Int32Array), c = load('c.i32', Int32Array), v = load('v.i32', Int32Array), sym = load('sym.u8', Uint8Array);
console.log(`${P}: ${meta.nBars.toLocaleString()} bars, ${meta.symbols.length} contracts, ${meta.rollovers.length} rollovers, ${Object.keys(meta.days).length} sessions`);
let bad = 0;
// invariants
for (let i = 0; i < meta.nBars; i++) {
  if (h[i] < l[i] || o[i] > h[i] || o[i] < l[i] || c[i] > h[i] || c[i] < l[i]) { if (bad++ < 3) console.log('BAD OHLC at', i, o[i], h[i], l[i], c[i]); }
  if (i && ts[i] < ts[i - 1]) { if (bad++ < 3) console.log('NON-MONOTONIC ts at', i, ts[i - 1], ts[i]); }
}
console.log(`invariants: ${bad === 0 ? 'PASS' : 'FAIL (' + bad + ')'} (OHLC bounds + monotonic ts)`);
// day ranges contiguous & aligned
const dayKeys = Object.keys(meta.days).sort();
let dbad = 0, prevEnd = 0;
for (const k of dayKeys) { const [s, e] = meta.days[k]; if (s !== prevEnd || e <= s) dbad++; prevEnd = e; }
console.log(`day index: ${dbad === 0 && prevEnd === meta.nBars ? 'PASS' : 'FAIL'} (contiguous, covers ${prevEnd}/${meta.nBars})`);
// spot-check vs source CSV
const SRC = path.join(ROOT, `backtest-engine/data/ohlcv/${P.toLowerCase()}/${P}_ohlcv_1s.csv`);
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, `backtest-engine/data/ohlcv/${P.toLowerCase()}/${P}_ohlcv_1s.index.json`))).minutes;
const fd = fs.openSync(SRC, 'r');
let checked = 0, mism = 0;
for (let s = 0; s < N; s++) {
  const i = Math.floor((s + 0.5) / N * meta.nBars);
  const minuteMs = Math.floor(ts[i] / 60) * 60000;
  const ent = idx[String(minuteMs)];
  if (!ent) continue;
  const buf = Buffer.allocUnsafe(ent.length);
  fs.readSync(fd, buf, 0, ent.length, ent.offset);
  const want = new Date(ts[i] * 1000).toISOString().replace('.000Z', '.000000000Z');
  const symName = meta.symbols[sym[i]];
  const line = buf.toString('latin1').split('\n').find((L) => L.startsWith(want) && L.endsWith(symName));
  checked++;
  if (!line) { mism++; console.log(`  no source row for bar ${i} ${want} ${symName}`); continue; }
  const f = line.split(',');
  const tk = (x) => Math.round(parseFloat(x) * 4);
  const ok = tk(f[4]) === o[i] && tk(f[5]) === h[i] && tk(f[6]) === l[i] && tk(f[7]) === c[i] && +f[8] === v[i];
  if (!ok) { mism++; console.log(`  MISMATCH bar ${i}: cache ${o[i]}/${h[i]}/${l[i]}/${c[i]}/${v[i]} vs src ${tk(f[4])}/${tk(f[5])}/${tk(f[6])}/${tk(f[7])}/${f[8]}`); }
}
fs.closeSync(fd);
console.log(`source spot-check: ${mism === 0 ? 'PASS' : 'FAIL'} (${checked - mism}/${checked} exact)`);
const px = (t) => (t * 0.25).toFixed(2);
console.log(`first bar ${new Date(ts[0]*1000).toISOString()} ${px(o[0])}/${px(h[0])}/${px(l[0])}/${px(c[0])} ${meta.symbols[sym[0]]}`);
const L = meta.nBars - 1;
console.log(`last  bar ${new Date(ts[L]*1000).toISOString()} ${px(o[L])}/${px(h[L])}/${px(l[L])}/${px(c[L])} ${meta.symbols[sym[L]]}`);
console.log(`rollovers: ${meta.rollovers.slice(0,4).map(r=>r.from+'→'+r.to).join(', ')}${meta.rollovers.length>4?' …':''}`);
