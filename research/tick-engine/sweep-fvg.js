#!/usr/bin/env node
/** Honest parameter sweep for fvg-* on the tick engine: rank on DEV (≤2024), then read VALIDATION once.
 *  usage: sweep-fvg.js [NQ] [--side bear|bull] [--top N] */
import { loadCache } from './cache.js';
import { runFvg } from './lib-fvg.js';
const P = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'NQ').toUpperCase();
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const SIDE = arg('side', 'bear'), TOPN = +arg('top', 12);
const C = loadCache(P);
const dev = C.range(null, '2024-12-31'), val = C.range('2025-01-01', null);
console.log(`${P} ${SIDE}: dev rows ${dev[0]}-${dev[1]} (${dev[2].length} sessions), val ${val[0]}-${val[1]} (${val[2].length} sessions)`);
const grid = [];
for (const maxOrders of [1, 2, 4, 8])
  for (const level of ['top', 'ce', 'bottom'])
    for (const stopAtr of [0.5, 1.0, 1.5, 2.5])
      for (const timeCapMin of [60, 240, 480])
        for (const targetAtr of [0, 1.0, 2.0])
          grid.push({ maxOrders, level, stopAtr, timeCapMin, targetAtr, side: SIDE });
console.log(`${grid.length} configs × ${((dev[1] - dev[0]) / 1e6).toFixed(0)}M dev bars`);
const devYrs = (C.ts[dev[1] - 1] - C.ts[dev[0]]) / (365.25 * 86400);
const valYrs = (C.ts[val[1] - 1] - C.ts[val[0]]) / (365.25 * 86400);
const rows = [];
const t0 = Date.now();
for (let i = 0; i < grid.length; i++) {
  const r = runFvg(C, grid[i], dev[0], dev[1]);
  const s = r.summary;
  if (s.n >= 100) rows.push({ ...grid[i], n: s.n, pf: s.pf, wr: s.wr, usdYr: Math.round(s.usd / devYrs), dd: s.maxDD });
  if ((i + 1) % 50 === 0) process.stderr.write(`  ${i + 1}/${grid.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
}
rows.sort((a, b) => b.usdYr - a.usdYr);
console.log(`\nDEV top ${TOPN} of ${rows.length} (n≥100):`);
console.log('  ord lvl   stop  cap  tgt |     n    PF    WR   $/yr      DD');
for (const r of rows.slice(0, TOPN))
  console.log(`  ${String(r.maxOrders).padStart(3)} ${r.level.padEnd(6)} ${String(r.stopAtr).padStart(4)} ${String(r.timeCapMin).padStart(4)} ${String(r.targetAtr).padStart(4)} | ${String(r.n).padStart(5)} ${r.pf.toFixed(2).padStart(5)} ${(r.wr * 100).toFixed(0).padStart(4)}% ${String(r.usdYr).padStart(7)} ${String(r.dd).padStart(7)}`);
console.log(`\nVALIDATION (2025-26) for the DEV top ${Math.min(5, rows.length)}:`);
console.log('  ord lvl   stop  cap  tgt |  devPF  dev$/yr |  valPF  val$/yr   valDD    n');
for (const r of rows.slice(0, 5)) {
  const v = runFvg(C, r, val[0], val[1]).summary;
  console.log(`  ${String(r.maxOrders).padStart(3)} ${r.level.padEnd(6)} ${String(r.stopAtr).padStart(4)} ${String(r.timeCapMin).padStart(4)} ${String(r.targetAtr).padStart(4)} | ${r.pf.toFixed(2).padStart(6)} ${String(r.usdYr).padStart(8)} | ${(v.n ? v.pf : 0).toFixed(2).padStart(6)} ${String(v.n ? Math.round(v.usd / valYrs) : 0).padStart(8)} ${String(v.maxDD || 0).padStart(7)} ${String(v.n || 0).padStart(4)}`);
}
console.log(`\nsweep took ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
