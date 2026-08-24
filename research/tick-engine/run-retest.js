#!/usr/bin/env node
import { loadCache } from './cache.js';
import { runRetest } from './lib-retest.js';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
for (const P of (arg('products', 'NQ,ES')).split(',')) {
  const C = loadCache(P);
  const dev = C.range(null, '2024-12-31'), val = C.range('2025-01-01', null);
  const yrs = (a, b) => (C.ts[b - 1] - C.ts[a]) / (365.25 * 86400);
  for (const side of ['long', 'short']) {
    const out = [];
    for (const [nm, a, b] of [['dev', dev[0], dev[1]], ['val', val[0], val[1]]]) {
      if (!b) continue;
      const r = runRetest(C, { side, maxOrders: +arg('maxOrders', 4) }, a, b);
      const s = r.summary, y = yrs(a, b);
      out.push(`${nm} n=${String(s.n || 0).padStart(4)} PF ${(s.pf || 0).toFixed(2)} $${String(s.n ? Math.round(s.usd / y) : 0).padStart(8)}/yr DD ${String(s.maxDD || 0).padStart(6)}`);
    }
    console.log(`${P} retest-${side.padEnd(5)} | ${out.join(' | ')}`);
  }
}
