#!/usr/bin/env node
import { loadCache } from './cache.js';
import { runHtfBreak } from './lib-htfbreak.js';
const C = loadCache('NQ');
const dev=C.range(null,'2024-12-31'), val=C.range('2025-01-01',null);
const y=(a,b)=>(C.ts[b-1]-C.ts[a])/(365.25*86400);
console.log("mid-range zone (symmetric payoff), direction from the 5-candle signature, limit-nested entries");
console.log('  mode  edge netMin  cool   results');
for (const mode of ['mid'])
 for (const edge of [0,4,8,16])
  for (const netMin of [0,8,20])
   for (const cool of [900]) {
    const out=[];
    for (const [nm,a,b] of [['dev',dev[0],dev[1]],['val',val[0],val[1]]]) {
      const r=runHtfBreak(C,{mode,entryMode:edge?'limit':'market',edgeTicks:edge,netMoveMinTicks:netMin,
                             cooldownSec:cool,timeCapMin:60},a,b);
      const s=r.summary;
      out.push(`${nm} n=${String(s.n||0).padStart(5)} WR ${((s.wr||0)*100).toFixed(1)}% PF ${(s.pf||0).toFixed(3)} $${String(s.n?Math.round(s.usd/y(a,b)):0).padStart(8)}/yr DD ${String(s.maxDD||0).padStart(7)} ${String(s.n?Math.round(s.usd/s.n):0).padStart(4)}/tr`);
    }
    console.log(`${mode.padStart(6)} ${String(edge).padStart(5)} ${String(netMin).padStart(6)} ${String(cool).padStart(5)}  ${out[0]}`);
    console.log(`${''.padStart(6)} ${''.padStart(5)} ${''.padStart(6)} ${''.padStart(5)}  ${out[1]}`);
   }
