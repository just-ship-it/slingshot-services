#!/usr/bin/env node
/** Is ORB-long alpha or just NQ beta? Compare the breakout to a same-clock, same-exit, unconditional
 *  long ("drift twin"), and to the short side. Also replicate on ES. */
import { loadCache } from './cache.js';
import { runORB } from './lib-orb.js';
const cfg = { orMin: 60, stopAtr: 2, timeCapMin: 390, minRangeAtr: 0 };
for (const P of ['NQ', 'ES']) {
  const C = loadCache(P);
  const dev = C.range(null, '2024-12-31'), val = C.range('2025-01-01', null);
  const yrs = (a, b) => (C.ts[b - 1] - C.ts[a]) / (365.25 * 86400);
  console.log(`\n${P}  (OR${cfg.orMin}, stop ${cfg.stopAtr}ATR, cap ${cfg.timeCapMin}m)`);
  console.log(`  ${'arm'.padEnd(26)} ${'devN'.padStart(5)} ${'devPF'.padStart(6)} ${'dev$/yr'.padStart(9)} ${'valN'.padStart(5)} ${'valPF'.padStart(6)} ${'val$/yr'.padStart(9)}`);
  const arms = [
    ['breakout long (resting)', { ...cfg, sides: 'long', entryMode: 'resting' }],
    ['DRIFT TWIN uncond. long', { ...cfg, sides: 'long', entryMode: 'always' }],
    ['breakout short (resting)', { ...cfg, sides: 'short', entryMode: 'resting' }],
    ['DRIFT TWIN uncond. short', { ...cfg, sides: 'short', entryMode: 'always' }],
  ];
  for (const [name, c] of arms) {
    const d = runORB(C, c, dev[0], dev[1]).summary, v = runORB(C, c, val[0], val[1]).summary;
    console.log(`  ${name.padEnd(26)} ${String(d.n || 0).padStart(5)} ${(d.pf || 0).toFixed(2).padStart(6)} ${String(d.n ? Math.round(d.usd / yrs(dev[0], dev[1])) : 0).padStart(9)} ${String(v.n || 0).padStart(5)} ${(v.pf || 0).toFixed(2).padStart(6)} ${String(v.n ? Math.round(v.usd / yrs(val[0], val[1])) : 0).padStart(9)}`);
  }
}
