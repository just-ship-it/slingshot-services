#!/usr/bin/env node
/**
 * Session × clock-window table — the substrate for every calendar raid.
 * For each trade date, the OHLC of ten fixed ET windows, plus session stats. One pass, then all
 * date-anchored hypotheses are pandas one-liners against a matched control.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache } from './cache.js';
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i>=0?process.argv[i+1]:d;};
const P=(arg('product','NQ')).toUpperCase();
const C=loadCache(P), TICK=C.meta.tickSize;
const WINDOWS=[['globexOpen',18,0,19,0],['overnight',18,0,9,30],['euro',3,0,8,0],['preOpen',8,30,9,30],
  ['open60',9,30,10,30],['morning',9,30,12,0],['midday',12,0,14,0],['aft',14,0,15,0],
  ['preclose',15,0,16,0],['last30',15,30,16,0],['postSettle',16,0,17,0],['rth',9,30,16,0]];
function etParts(sec){const d=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(sec*1000));const o={};for(const p of d)if(p.type!=='literal')o[p.type]=+p.value;return o;}
const days=C.meta.days, keys=Object.keys(days).sort();
const cols=['tradeDate','sym','nBars','sessOpen','sessHigh','sessLow','sessClose','sessVol'];
for(const [n] of WINDOWS) cols.push(n+'O',n+'H',n+'L',n+'C',n+'V',n+'N');
const ws=fs.createWriteStream(path.join(__dirname,`sessions_${P}.csv`)); ws.write(cols.join(',')+'\n');
let out=[];
for(const td of keys){
  const [a,b]=days[td];
  // precompute ET minute-of-day for each bar boundary lazily (hour changes only)
  const row=[td,C.meta.symbols[C.sym[a]],b-a,(C.o[a]*TICK).toFixed(2)];
  let sh=-2e9,sl=2e9,sv=0;
  for(let i=a;i<b;i++){if(C.h[i]>sh)sh=C.h[i];if(C.l[i]<sl)sl=C.l[i];sv+=C.v[i];}
  row.push((sh*TICK).toFixed(2),(sl*TICK).toFixed(2),(C.c[b-1]*TICK).toFixed(2),sv);
  // window scan: single pass, bucket bars by ET minute
  const acc=WINDOWS.map(()=>({o:null,h:-2e9,l:2e9,c:null,v:0,n:0}));
  let lastHour=-1, etm=0;
  for(let i=a;i<b;i++){
    const s=C.ts[i];
    if((s/3600|0)!==lastHour){ lastHour=(s/3600|0); const p=etParts(s); etm=p.hour*60+p.minute - (s%3600)/60; }
    const m=Math.round(etm + (s%3600)/60)%1440;
    for(let w=0;w<WINDOWS.length;w++){
      const [,h1,m1,h2,m2]=WINDOWS[w]; const s1=h1*60+m1, s2=h2*60+m2;
      const inw = s1<s2 ? (m>=s1&&m<s2) : (m>=s1||m<s2);
      if(!inw) continue;
      const A=acc[w];
      if(A.o===null)A.o=C.o[i];
      if(C.h[i]>A.h)A.h=C.h[i]; if(C.l[i]<A.l)A.l=C.l[i];
      A.c=C.c[i]; A.v+=C.v[i]; A.n++;
    }
  }
  for(const A of acc) row.push(A.o!==null?(A.o*TICK).toFixed(2):'',A.h>-2e9?(A.h*TICK).toFixed(2):'',
    A.l<2e9?(A.l*TICK).toFixed(2):'',A.c!==null?(A.c*TICK).toFixed(2):'',A.v,A.n);
  out.push(row.join(','));
  if(out.length>=200){ws.write(out.join('\n')+'\n');out=[];}
}
if(out.length)ws.write(out.join('\n')+'\n');
ws.end();
console.log(`${P}: ${keys.length} sessions × ${WINDOWS.length} windows → sessions_${P}.csv`);
