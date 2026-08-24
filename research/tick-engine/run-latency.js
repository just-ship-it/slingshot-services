#!/usr/bin/env node
/**
 * What is entry latency actually worth, drift-neutral?
 * Long-side comparisons are contaminated: in a rising market an earlier long is mechanically better.
 * The SHORT side is the clean test — there drift penalises holding, so any advantage of resting at
 * the level over reacting to a bar close is latency value, not beta.
 */
import { loadCache } from './cache.js';
import { runORB } from './lib-orb.js';
const base = { orMin: 60, stopAtr: 2, timeCapMin: 390, minRangeAtr: 0 };
for (const P of ['NQ', 'ES']) {
  const C = loadCache(P);
  const dev = C.range(null, '2024-12-31'), val = C.range('2025-01-01', null);
  const y = (a, b) => (C.ts[b - 1] - C.ts[a]) / (365.25 * 86400);
  console.log(`\n${P}: latency arms by side (avg $/trade is the drift-neutral read)`);
  console.log(`  ${'side'.padEnd(6)} ${'arm'.padEnd(9)} ${'devN'.padStart(5)} ${'dev$/tr'.padStart(8)} ${'devPF'.padStart(6)} | ${'valN'.padStart(5)} ${'val$/tr'.padStart(8)} ${'valPF'.padStart(6)}`);
  for (const sides of ['long', 'short']) {
    const rows = [];
    for (const entryMode of ['resting', 'close1m', 'close5m']) {
      const d = runORB(C, { ...base, sides, entryMode }, dev[0], dev[1]).summary;
      const v = runORB(C, { ...base, sides, entryMode }, val[0], val[1]).summary;
      rows.push([entryMode, d, v]);
      console.log(`  ${sides.padEnd(6)} ${entryMode.padEnd(9)} ${String(d.n || 0).padStart(5)} ${String(d.n ? Math.round(d.usd / d.n) : 0).padStart(8)} ${(d.pf || 0).toFixed(2).padStart(6)} | ${String(v.n || 0).padStart(5)} ${String(v.n ? Math.round(v.usd / v.n) : 0).padStart(8)} ${(v.pf || 0).toFixed(2).padStart(6)}`);
    }
    const [r, d1] = [rows[0], rows[1]];
    const dDev = Math.round(r[1].usd / r[1].n - d1[1].usd / d1[1].n), dVal = Math.round(r[2].usd / r[2].n - d1[2].usd / d1[2].n);
    console.log(`  ${''.padEnd(6)} → resting − close1m: ${dDev >= 0 ? '+' : ''}$${dDev}/trade dev, ${dVal >= 0 ? '+' : ''}$${dVal}/trade val`);
  }
}
