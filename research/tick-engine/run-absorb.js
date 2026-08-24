#!/usr/bin/env node
import { loadCache } from './cache.js';
import { runAbsorb } from './lib-absorb.js';
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i>=0?process.argv[i+1]:d;};
for (const P of (arg('products','NQ')).split(',')) {
  const C = loadCache(P);
  const dev = C.range(null,'2024-12-31'), val = C.range('2025-01-01',null);
  const y=(a,b)=>(C.ts[b-1]-C.ts[a])/(365.25*86400);
  console.log(`\n${P}  ${'set'.padEnd(4)} ${'sig'.padStart(5)} ${'n'.padStart(5)} ${'WR'.padStart(6)} ${'PF'.padStart(6)} ${'$/yr'.padStart(9)} ${'DD'.padStart(8)} ${'$/trade'.padStart(8)}`);
  for (const [nm,a,b] of [['dev',dev[0],dev[1]],['val',val[0],val[1]]]) {
    const r = runAbsorb(C,{side:arg('side','short'),mode:arg('mode','high'),entry:arg('entry','market'),stopAtr:+arg('stopAtr',1),timeCapMin:+arg('cap',60)},a,b);
    const s=r.summary;
    console.log(`   ${nm.padEnd(4)} ${String(r.nSig).padStart(5)} ${String(s.n||0).padStart(5)} ${((s.wr||0)*100).toFixed(1).padStart(5)}% ${(s.pf||0).toFixed(3).padStart(6)} ${String(s.n?Math.round(s.usd/y(a,b)):0).padStart(9)} ${String(s.maxDD||0).padStart(8)} ${String(s.n?Math.round(s.usd/s.n):0).padStart(8)}`);
  }
}
