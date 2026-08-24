#!/usr/bin/env node
/**
 * Session mechanics table: overnight range, which ON extreme breaks first in RTH (and whether BOTH
 * break = whipsaw), gap size and fill timing, initial balance and its extension.
 * These are the objects behind two A1 findings that were measured and never traded:
 *   - low overnight-range tercile → BOTH ON extremes broken 38.3% vs 15.7%
 *   - gap fill monotone 96%→24% across |gap|/ATR
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache } from './cache.js';
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i>=0?process.argv[i+1]:d;};
const P=(arg('product','NQ')).toUpperCase();
const C=loadCache(P), TICK=C.meta.tickSize;
function rthOpenSec(td){const [y,m,dd]=td.split('-').map(Number);const g=Date.UTC(y,m-1,dd,14,30)/1000;
  const h=+new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(g*1000));
  return h===9?g:g+3600;}
const days=C.meta.days, keys=Object.keys(days).sort();
const cols=['tradeDate','sym','onHigh','onLow','onRange','onClose','rthOpen','rthHigh','rthLow','rthClose','rthVol',
 'gap','prevRthClose','gapFillMin','onHiBreakMin','onLoBreakMin','bothBroke','firstBreak',
 'ibHigh','ibLow','ibRange','ibHiBreakMin','ibLoBreakMin','atr20'];
const ws=fs.createWriteStream(path.join(__dirname,`mech_${P}.csv`)); ws.write(cols.join(',')+'\n');
let out=[], prevRthClose=null, atrArr=[];
for(const td of keys){
  const [a,b]=days[td]; const ro=rthOpenSec(td), rc=ro+6.5*3600, ibEnd=ro+3600;
  let onH=-2e9,onL=2e9,onC=null, rO=null,rH=-2e9,rL=2e9,rC=null,rV=0, ibH=-2e9,ibL=2e9;
  let onHiB=null,onLoB=null,gapFill=null,ibHiB=null,ibLoB=null,firstBreak=0;
  // pass 1: overnight (session open → RTH open)
  for(let i=a;i<b;i++){ const t=C.ts[i];
    if(t<ro){ if(C.h[i]>onH)onH=C.h[i]; if(C.l[i]<onL)onL=C.l[i]; onC=C.c[i]; } }
  // pass 2: RTH
  for(let i=a;i<b;i++){ const t=C.ts[i];
    if(t<ro||t>=rc) continue;
    if(rO===null)rO=C.o[i];
    if(C.h[i]>rH)rH=C.h[i]; if(C.l[i]<rL)rL=C.l[i]; rC=C.c[i]; rV+=C.v[i];
    if(t<ibEnd){ if(C.h[i]>ibH)ibH=C.h[i]; if(C.l[i]<ibL)ibL=C.l[i]; }
    const m=Math.round((t-ro)/60);
    if(onH>-2e9&&onHiB===null&&C.h[i]>=onH){onHiB=m; if(!firstBreak)firstBreak=1;}
    if(onL<2e9&&onLoB===null&&C.l[i]<=onL){onLoB=m; if(!firstBreak)firstBreak=-1;}
    if(prevRthClose!==null&&gapFill===null&&C.l[i]<=prevRthClose&&C.h[i]>=prevRthClose)gapFill=m;
    if(t>=ibEnd&&ibH>-2e9){ if(ibHiB===null&&C.h[i]>=ibH)ibHiB=m; if(ibLoB===null&&C.l[i]<=ibL)ibLoB=m; }
  }
  if(rO===null){ prevRthClose=rC??prevRthClose; continue; }
  atrArr.push(rH-rL); if(atrArr.length>20)atrArr.shift();
  const atr20=atrArr.reduce((s,x)=>s+x,0)/atrArr.length;
  const px=v=>v===null||v===undefined||Math.abs(v)>1e8?'':(v*TICK).toFixed(2);
  out.push([td,C.meta.symbols[C.sym[a]],px(onH),px(onL),onH>-2e9?((onH-onL)*TICK).toFixed(2):'',px(onC),
   px(rO),px(rH),px(rL),px(rC),rV,
   prevRthClose!==null?((rO-prevRthClose)*TICK).toFixed(2):'', px(prevRthClose),
   gapFill??'', onHiB??'', onLoB??'', (onHiB!==null&&onLoB!==null)?1:0, firstBreak,
   px(ibH),px(ibL),ibH>-2e9?((ibH-ibL)*TICK).toFixed(2):'', ibHiB??'', ibLoB??'', (atr20*TICK).toFixed(2)].join(','));
  prevRthClose=rC;
  if(out.length>=200){ws.write(out.join('\n')+'\n');out=[];}
}
if(out.length)ws.write(out.join('\n')+'\n');
ws.end();
console.log(`${P}: ${keys.length} sessions → mech_${P}.csv`);
