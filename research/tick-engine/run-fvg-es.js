#!/usr/bin/env node
/** Cross-product check of the FVG sweep's dev-best configs: same config, ES, dev + val. */
import { loadCache } from './cache.js';
import { runFvg } from './lib-fvg.js';
const tops = [
  { maxOrders: 8, level: 'ce', stopAtr: 1.0, timeCapMin: 60, targetAtr: 1.0 },
  { maxOrders: 2, level: 'ce', stopAtr: 1.0, timeCapMin: 60, targetAtr: 1.0 },
  { maxOrders: 8, level: 'bottom', stopAtr: 0.5, timeCapMin: 480, targetAtr: 0 },
];
for (const P of ['NQ', 'ES']) {
  const C = loadCache(P);
  const dev = C.range(null, '2024-12-31'), val = C.range('2025-01-01', null);
  const y = (a, b) => (C.ts[b - 1] - C.ts[a]) / (365.25 * 86400);
  console.log(`\n${P}`);
  console.log(`  ${'config'.padEnd(30)} ${'devN'.padStart(5)} ${'devPF'.padStart(6)} ${'dev$/yr'.padStart(9)} | ${'valN'.padStart(5)} ${'valPF'.padStart(6)} ${'val$/yr'.padStart(9)}`);
  for (const t of tops) {
    const tag = `ord${t.maxOrders} ${t.level} s${t.stopAtr} c${t.timeCapMin} t${t.targetAtr}`;
    const d = runFvg(C, { ...t, side: 'bear' }, dev[0], dev[1]).summary;
    const v = runFvg(C, { ...t, side: 'bear' }, val[0], val[1]).summary;
    console.log(`  ${tag.padEnd(30)} ${String(d.n || 0).padStart(5)} ${(d.pf || 0).toFixed(2).padStart(6)} ${String(d.n ? Math.round(d.usd / y(dev[0], dev[1])) : 0).padStart(9)} | ${String(v.n || 0).padStart(5)} ${(v.pf || 0).toFixed(2).padStart(6)} ${String(v.n ? Math.round(v.usd / y(val[0], val[1])) : 0).padStart(9)}`);
  }
}
