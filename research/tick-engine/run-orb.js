#!/usr/bin/env node
import { loadCache } from './cache.js';
import { runORB } from './lib-orb.js';
const P = (process.argv[2] || 'NQ').toUpperCase();
const C = loadCache(P);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const dev = C.range(null, '2024-12-31'), val = C.range('2025-01-01', null);
const yrs = (a, b) => (C.ts[b - 1] - C.ts[a]) / (365.25 * 86400);
const base = { orMin: +arg('orMin', 15), stopAtr: +arg('stopAtr', 1), timeCapMin: +arg('cap', 240), sides: arg('sides', 'both') };
console.log(`${P} ORB${base.orMin} stop${base.stopAtr}ATR cap${base.timeCapMin}m sides=${base.sides} — latency arms\n`);
console.log(`${'arm'.padEnd(9)} ${'set'.padEnd(4)} ${'n'.padStart(5)} ${'WR'.padStart(6)} ${'PF'.padStart(6)} ${'$/yr'.padStart(9)} ${'DD'.padStart(8)} ${'avg$/trade'.padStart(11)}`);
for (const mode of ['resting', 'close1m', 'close5m']) {
  for (const [nm, a, b] of [['dev', dev[0], dev[1]], ['val', val[0], val[1]]]) {
    const r = runORB(C, { ...base, entryMode: mode }, a, b);
    const s = r.summary, y = yrs(a, b);
    console.log(`${mode.padEnd(9)} ${nm.padEnd(4)} ${String(s.n || 0).padStart(5)} ${((s.wr || 0) * 100).toFixed(1).padStart(5)}% ${(s.pf || 0).toFixed(3).padStart(6)} ${String(s.n ? Math.round(s.usd / y) : 0).padStart(9)} ${String(s.maxDD || 0).padStart(8)} ${String(s.n ? Math.round(s.usd / s.n) : 0).padStart(11)}`);
  }
}
