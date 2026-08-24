#!/usr/bin/env node
/** Benchmark TickCore + WatchIndex on the real cache. usage: bench-tick.js [NQ] [from] [to] */
import { loadCache } from './cache.js';
import { TickCore } from './tick-core.js';

const P = (process.argv[2] || 'NQ').toUpperCase();
const C = loadCache(P);
const from = process.argv[3] ? +process.argv[3] : 0;
const to = process.argv[4] ? +process.argv[4] : C.n;
console.log(`${P}: ${C.n.toLocaleString()} bars in cache; benchmarking rows [${from}, ${to}) = ${((to - from) / 1e6).toFixed(1)}M`);

function bench(nWatch, tfs) {
  const core = new TickCore({ cache: C, timeframes: tfs, watchCapacity: Math.max(1024, nWatch * 2) });
  // seed N watches spread around the opening price; re-arm on fire to keep N live
  const p0 = C.c[from];
  const add = (i) => core.watches.add({
    armLevel: p0 + (i % 2 ? 1 : -1) * (40 + (i % 97) * 8), armSide: i % 2 ? 1 : -1,
    voidLevel: p0 + (i % 2 ? -1 : 1) * (40 + (i % 89) * 8), voidSide: i % 2 ? -1 : 1,
    meta: i,
  });
  for (let i = 0; i < nWatch; i++) add(i);
  let closes = 0;
  const t0 = process.hrtime.bigint();
  core.run(from, to, {
    onBarClose: () => { closes++; },
    onArm: (meta, lvl, c) => { const p = c.cache.c[c.row]; c.watches.add({ armLevel: p + 40 + (meta % 97) * 8, armSide: 1, voidLevel: p - 40 - (meta % 89) * 8, voidSide: -1, meta }); },
    onVoid: (meta, r, c) => { const p = c.cache.c[c.row]; c.watches.add({ armLevel: p - 40 - (meta % 97) * 8, armSide: -1, voidLevel: p + 40 + (meta % 89) * 8, voidSide: 1, meta }); },
  });
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const rate = (to - from) / secs;
  const w = core.watches.stats;
  return { secs, rate, closes, arms: core.stats.arms, voids: core.stats.voids, rolls: core.stats.rolls,
           checksPerBar: (w.slotChecks / (to - from)).toFixed(2) };
}
console.log(`\n${'watches'.padStart(8)} ${'tfs'.padStart(4)} ${'M bars/s'.padStart(9)} ${'full 90M'.padStart(9)}  ${'slotChecks/bar'.padStart(14)}  events`);
for (const [nw, tfs] of [[0, ['1m']], [8, ['1m']], [32, ['1m', '5m']], [128, ['1m', '5m', '15m']], [512, ['1m', '5m', '15m']], [2048, ['1m', '5m', '15m']]]) {
  const r = bench(nw, tfs);
  console.log(`${String(nw).padStart(8)} ${String(tfs.length).padStart(4)} ${(r.rate / 1e6).toFixed(2).padStart(9)} ${(90e6 / r.rate).toFixed(1).padStart(8)}s  ${r.checksPerBar.padStart(14)}  closes ${r.closes} arms ${r.arms} voids ${r.voids} rolls ${r.rolls}`);
}
