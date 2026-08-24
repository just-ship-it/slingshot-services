#!/usr/bin/env node
import { loadCache } from './cache.js';
import { runMomo } from './lib-momo.js';
const C=loadCache('NQ');
const dev=C.range(null,'2024-12-31'), val=C.range('2025-01-01',null);
const y=(a,b)=>(C.ts[b-1]-C.ts[a])/(365.25*86400);
console.log('Big-move momentum continuation, one position at a time, honest fills\n');
console.log('                               cfg  set   sig     n     WR     PF      $/yr       DD   $/tr');
for (const [side,thr,seq] of [['short',-173,10],['short',-120,5],['long',173,10],['long',120,5]])
  for (const [T,S] of [[520,160],[320,160],[400,112]]) {
    const tag=`${side} seq${seq} thr${thr} T${T}/S${S}`;
    for (const [nm,a,b] of [['dev',dev[0],dev[1]],['val',val[0],val[1]]]) {
      const r=runMomo(C,{side,thrTicks:thr,seq,targetTicks:T,stopTicks:S},a,b), s=r.summary;
      console.log(`${tag.padStart(34)} ${nm.padEnd(4)} ${String(r.nSig).padStart(5)} ${String(s.n||0).padStart(5)} ${((s.wr||0)*100).toFixed(1).padStart(5)}% ${(s.pf||0).toFixed(3).padStart(6)} ${String(s.n?Math.round(s.usd/y(a,b)):0).padStart(9)} ${String(s.maxDD||0).padStart(8)} ${String(s.n?Math.round(s.usd/s.n):0).padStart(6)}`);
    }
  }
