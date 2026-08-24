#!/usr/bin/env node
import { loadCache } from './cache.js';
import { runHtfBreak } from './lib-htfbreak.js';
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i>=0?process.argv[i+1]:d;};
const C = loadCache((arg('product','NQ')).toUpperCase());
const dev=C.range(null,'2024-12-31'), val=C.range('2025-01-01',null);
const y=(a,b)=>(C.ts[b-1]-C.ts[a])/(365.25*86400);
const base={htf:arg('htf','15m'),ltf:arg('ltf','3m'),seqBars:+arg('seq',5),timeCapMin:+arg('cap',60),
            entryMode:arg('entry','market'),edgeTicks:+arg('edge',0)};
console.log(`${arg('product','NQ')} ${base.htf}←${base.ltf} entry=${base.entryMode}${base.edgeTicks?'('+base.edgeTicks+'tk)':''} cap=${base.timeCapMin}m`);
console.log(`${'posHi'.padStart(6)} ${'set'.padEnd(4)} ${'sig'.padStart(6)} ${'n'.padStart(5)} ${'WR'.padStart(6)} ${'PF'.padStart(6)} ${'$/yr'.padStart(9)} ${'DD'.padStart(8)} ${'$/tr'.padStart(6)}`);
for (const posHi of (arg('posHi','0.60,0.70,0.80,0.90')).split(',').map(Number)) {
  for (const [nm,a,b] of [['dev',dev[0],dev[1]],['val',val[0],val[1]]]) {
    const r=runHtfBreak(C,{...base,posHi},a,b), s=r.summary;
    console.log(`${String(posHi).padStart(6)} ${nm.padEnd(4)} ${String(r.nSig).padStart(6)} ${String(s.n||0).padStart(5)} ${((s.wr||0)*100).toFixed(1).padStart(5)}% ${(s.pf||0).toFixed(3).padStart(6)} ${String(s.n?Math.round(s.usd/y(a,b)):0).padStart(9)} ${String(s.maxDD||0).padStart(8)} ${String(s.n?Math.round(s.usd/s.n):0).padStart(6)}`);
  }
}
