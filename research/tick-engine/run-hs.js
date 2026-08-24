#!/usr/bin/env node
import { loadCache } from './cache.js';
import { runHS } from './lib-hs.js';
const P = (process.argv[2] || 'NQ').toUpperCase();
const C = loadCache(P);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const mode = arg('mode', 'predictive'), side = arg('side', 'top');
const dev = C.range(null, '2024-12-31'), val = C.range('2025-01-01', null);
const yrs = (a, b) => (C.ts[b - 1] - C.ts[a]) / (365.25 * 86400);
for (const [name, r0, r1] of [['DEV  ', dev[0], dev[1]], ['VAL  ', val[0], val[1]]]) {
  const t = Date.now();
  const r = runHS(C, { mode, side, maxOrders: +arg('maxOrders', 4) }, r0, r1);
  const s = r.summary, y = yrs(r0, r1);
  console.log(`${name} ${mode}/${side}: structures ${r.nStruct} orders ${r.nOrders} → trades ${s.n || 0} ` +
    (s.n ? `WR ${(s.wr * 100).toFixed(1)}% PF ${s.pf.toFixed(3)} $${Math.round(s.usd / y).toLocaleString()}/yr DD $${s.maxDD.toLocaleString()} exits ${JSON.stringify(s.exits)}` : '') +
    ` [${((Date.now() - t) / 1000).toFixed(1)}s]`);
}
