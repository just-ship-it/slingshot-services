#!/usr/bin/env node
/**
 * TOUCH GRID — the tool that lets R/R be CHOSEN instead of inherited.
 *
 * For every LTF close, walk 1s bars forward and record the first second at which price touches
 * each rung of a ladder above and below. Any (target T, stop S) pair can then be resolved offline:
 *     win  ⇔  tUp[T] exists and (tDn[S] missing or tUp[T] < tDn[S])
 * so one pass over the data prices EVERY R/R combination, and we can pick the R/R that actually
 * fits each signal's win rate instead of forcing the trade into the HTF candle's geometry.
 * A second that touches both rungs is resolved ADVERSELY (counts as the stop).
 *
 *   node build-touchgrid.js --product NQ --ltf 3m [--horizonMin 60]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache } from './cache.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i>=0?process.argv[i+1]:d;};
const P=(arg('product','NQ')).toUpperCase(), LTF=arg('ltf','3m'), HOR=+arg('horizonMin',60)*60;
const LAD=(arg('lad','')||'').length?arg('lad').split(',').map(Number):[4,8,12,16,20,24,32,40,52,68,88,112];
const TAG=arg('tag',''); const OUT=path.join(__dirname,'touchgrid'); fs.mkdirSync(OUT,{recursive:true});
const C=loadCache(P), TICK=C.meta.tickSize;
const sec=+LTF.slice(0,-1)*(LTF.endsWith('m')?60:3600);
const days=C.meta.days, dayKeys=Object.keys(days).sort();
const COLS=['tradeDate','ts','px','atrTicks','pxEnd',...LAD.map(k=>'u'+k),...LAD.map(k=>'d'+k)];
const ws=fs.createWriteStream(path.join(OUT,`${P}_${LTF}${TAG}_grid.csv`));
ws.write(COLS.join(',')+'\n');
let rows=0,buf=[]; const t0=Date.now();
for(const td of dayKeys){
  const [a,b]=days[td]; const sOpen=C.ts[a];
  // LTF candle boundaries
  const cand=[]; let i=a;
  while(i<b){ const k=Math.floor((C.ts[i]-sOpen)/sec), cO=sOpen+k*sec, cE=cO+sec;
    let j=i,hi=-2e9,lo=2e9; while(j<b&&C.ts[j]<cE){if(C.h[j]>hi)hi=C.h[j];if(C.l[j]<lo)lo=C.l[j];j++;}
    if(j>i)cand.push({i,j,cO,cE,hi,lo,c:C.c[j-1]}); i=j>i?j:i+1; }
  let atr=0,n=0;
  for(let x=0;x<cand.length;x++){
    const cd=cand[x]; atr=n?(atr*13+(cd.hi-cd.lo))/14:(cd.hi-cd.lo); n++;
    if(n<15) continue;
    const px=cd.c;
    const tu=new Array(LAD.length).fill(-1), tdn=new Array(LAD.length).fill(-1);
    let doneU=0, doneD=0, lastR=cd.j;
    for(let r=cd.j; r<b && C.ts[r]<cd.cE+HOR && (doneU<LAD.length||doneD<LAD.length); r++){
      lastR=r;
      const up=C.h[r]-px, dn=px-C.l[r], el=C.ts[r]-cd.cE;
      if(up>0) for(let q=doneU;q<LAD.length;q++){ if(up>=LAD[q]){tu[q]=el;doneU=q+1;} else break; }
      if(dn>0) for(let q=doneD;q<LAD.length;q++){ if(dn>=LAD[q]){tdn[q]=el;doneD=q+1;} else break; }
    }
    buf.push([td,cd.cO,(px*TICK).toFixed(2),Math.round(atr),C.c[lastR]-px,...tu,...tdn].join(','));
    rows++;
    if(buf.length>=20000){ws.write(buf.join('\n')+'\n');buf=[];}
  }
}
if(buf.length)ws.write(buf.join('\n')+'\n');
ws.end();
console.log(`${P} ${LTF}: ${rows.toLocaleString()} decision points × ${LAD.length} rungs each way in ${((Date.now()-t0)/1000).toFixed(1)}s → touchgrid/${P}_${LTF}_grid.csv`);
console.log(`   ladder (ticks): ${LAD.join(',')}  = ${LAD.map(k=>(k*TICK)).join(',')} NQ points`);
