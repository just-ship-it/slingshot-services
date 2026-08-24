#!/usr/bin/env node
/** Find an ORB config with dev edge, then measure the latency arms ON that config.
 *  A latency comparison run on a no-edge strategy measures noise; this fixes that. */
import { loadCache } from './cache.js';
import { runORB } from './lib-orb.js';
const P = (process.argv[2] || 'NQ').toUpperCase();
const C = loadCache(P);
const dev = C.range(null, '2024-12-31'), val = C.range('2025-01-01', null);
const dY = (C.ts[dev[1] - 1] - C.ts[dev[0]]) / (365.25 * 86400), vY = (C.ts[val[1] - 1] - C.ts[val[0]]) / (365.25 * 86400);
const grid = [];
for (const orMin of [5, 15, 30, 60])
  for (const stopAtr of [0.5, 1.0, 2.0])
    for (const timeCapMin of [60, 240, 390])
      for (const sides of ['both', 'long', 'short'])
        for (const minRangeAtr of [0, 0.75])
          grid.push({ orMin, stopAtr, timeCapMin, sides, minRangeAtr, entryMode: 'resting' });
console.log(`${P}: ${grid.length} ORB configs on dev (${dev[2].length} sessions)`);
const rows = [];
const t0 = Date.now();
for (let i = 0; i < grid.length; i++) {
  const s = runORB(C, grid[i], dev[0], dev[1]).summary;
  if (s.n >= 150) rows.push({ ...grid[i], n: s.n, pf: s.pf, usdYr: Math.round(s.usd / dY), dd: s.maxDD });
  if ((i + 1) % 40 === 0) process.stderr.write(`  ${i + 1}/${grid.length} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}
rows.sort((a, b) => b.usdYr - a.usdYr);
console.log(`\nDEV top 10 of ${rows.length}:`);
console.log('   or stop  cap sides   minR |     n    PF     $/yr      DD');
for (const r of rows.slice(0, 10))
  console.log(`  ${String(r.orMin).padStart(3)} ${String(r.stopAtr).padStart(4)} ${String(r.timeCapMin).padStart(4)} ${r.sides.padEnd(6)} ${String(r.minRangeAtr).padStart(5)} | ${String(r.n).padStart(5)} ${r.pf.toFixed(2).padStart(5)} ${String(r.usdYr).padStart(8)} ${String(r.dd).padStart(7)}`);
console.log(`\nLATENCY ARMS on the top-3 dev configs (dev | val):`);
console.log('  cfg                          arm       devPF  dev$/yr |  valPF  val$/yr');
for (const r of rows.slice(0, 3)) {
  const tag = `or${r.orMin} s${r.stopAtr} c${r.timeCapMin} ${r.sides} mR${r.minRangeAtr}`;
  for (const mode of ['resting', 'close1m', 'close5m']) {
    const d = runORB(C, { ...r, entryMode: mode }, dev[0], dev[1]).summary;
    const v = runORB(C, { ...r, entryMode: mode }, val[0], val[1]).summary;
    console.log(`  ${tag.padEnd(28)} ${mode.padEnd(9)} ${(d.pf || 0).toFixed(2).padStart(5)} ${String(d.n ? Math.round(d.usd / dY) : 0).padStart(8)} | ${(v.pf || 0).toFixed(2).padStart(6)} ${String(v.n ? Math.round(v.usd / vY) : 0).padStart(8)}`);
  }
}
console.log(`\n${((Date.now() - t0) / 60000).toFixed(1)} min`);
