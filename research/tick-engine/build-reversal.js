#!/usr/bin/env node
/**
 * "Can the 3m formations tell you the 15m has bottomed?"
 *
 * Target (symmetric barrier, exactly the trade being asked about): from each 3m close, does price
 * travel +K ticks before −K ticks? 1:1 R/R, so any P(win) above ~50% + costs is money.
 * Walked on 1s bars; a second touching both barriers is resolved ADVERSELY.
 *
 * Features = the basing signature visible on the chart, computed over the trailing window:
 *   rejection sequence  — candles that probed lower and closed back in their upper half
 *   higher lows         — successive lows rising
 *   shallowing probes   — each downside excursion smaller than the last
 *   compression         — range shrinking
 *   absorption          — bottom-wick volume share rising while price stops falling
 *   plus HTF context    — where price sits in the previous 15m candle's range, distance to its low
 *
 *   node build-reversal.js --product NQ --ltf 3m --htf 15m --K 20
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache } from './cache.js';
import { analyzeCandle } from './wick-anatomy.js';
import { analyzeTimeProfile } from './time-profile.js';
import { sliceProfile } from './slice-profile.js';
import { velocityProfile } from './velocity.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const P = (arg('product','NQ')).toUpperCase(), LTF = arg('ltf','3m'), HTF = arg('htf','15m');
const KS = (arg('K','20')).split(',').map(Number);
const OUT = path.join(__dirname,'reversal'); fs.mkdirSync(OUT,{recursive:true});
const C = loadCache(P), TICK = C.meta.tickSize;
const secOf = (tf) => +tf.slice(0,-1) * (tf.endsWith('m')?60:3600);
const LS = secOf(LTF), HS = secOf(HTF);
const days = C.meta.days, dayKeys = Object.keys(days).sort();
const build = (a,b,sOpen,sec) => { const o=[]; let i=a;
  while(i<b){ const k=Math.floor((C.ts[i]-sOpen)/sec), cO=sOpen+k*sec, cE=cO+sec;
    let j=i,hi=-2e9,lo=2e9,v=0; while(j<b&&C.ts[j]<cE){if(C.h[j]>hi)hi=C.h[j];if(C.l[j]<lo)lo=C.l[j];v+=C.v[j];j++;}
    if(j>i)o.push({i,j,cO,cE,hi,lo,v,o:C.o[i],c:C.c[j-1]}); i=j>i?j:i+1;} return o; };

const COLS = ['tradeDate','ts','px','atrTicks',
  'rej3','rej5','rej10','hl3','hl5','shallow3','shallow5','comp5','dnVol5','upVol5','volTrend5',
  'lowDist5','lowDist10','netMove5','netMove10','dnWickSum5','upWickSum5','closePos5',
  'htfPos','htfDistLo','htfDistHi','htfRange','minOfDay',
  'volCentroid','moveCentroid','driveCentroid','moveLast10Rel','moveLast30Rel','lateRange30Rel','lateRange10Rel',
  'lateFightsBody','closeOffLateHi','closeOffLateLo','volLastQ','volFirstQ','closingBurst','pathEff','revs','maxSliceVol',
  'volCentroid5','lateFights5','closingBurst5',
  'maxVel5','maxVel10','maxVel30','velShare5','velShare10','velShare30','velDir','timeAtVel','giveBack','sweepUp','sweepDn','sweepUp5','sweepDn5',
  'v1','v2','v3','v4','v5','v6','m1','m2','m3','m4','m5','m6','r1','r2','r3','r4','r5','r6',
  ...KS.flatMap(k=>[`y${k}`,`t${k}`])];
const ws = fs.createWriteStream(path.join(OUT,`${P}_${LTF}_rev.csv`));
ws.write(COLS.join(',')+'\n');
let rows=0, buf=[], wins={}, tot=0; KS.forEach(k=>wins[k]=0);
const t0=Date.now();
for (const td of dayKeys){
  const [a,b]=days[td]; const sOpen=C.ts[a];
  const L=build(a,b,sOpen,LS), H=build(a,b,sOpen,HS);
  if(L.length<20||H.length<3) continue;
  let atr=0,n=0; const A=[];
  for(const l of L){const r=l.hi-l.lo; atr=n?(atr*13+r)/14:r; n++; A.push(atr);}
  // anatomy per LTF candle
  const AN = L.map(l=>analyzeCandle(C.l,C.h,C.v,C.ts,l.i,l.j,l.o,l.hi,l.lo,l.c,l.cO,LS));
  const TP = L.map(l=>analyzeTimeProfile(C.l,C.h,C.v,C.c,C.ts,l.i,l.j,l.cO,LS,l.o,l.c));
  const SP = L.map(l=>sliceProfile(C.l,C.h,C.v,C.c,C.ts,l.i,l.j,l.cO,LS,l.o,6));
  const VP = L.map(l=>velocityProfile(C.l,C.h,C.c,C.ts,l.i,l.j,l.cO,LS,l.o,l.c));
  let hIdx=0;
  for(let x=14;x<L.length;x++){
    const cur=L[x], px=cur.c, at=A[x]||1;
    while(hIdx+1<H.length && H[hIdx+1].cE<=cur.cE) hIdx++;
    const prevH = H[hIdx].cE<=cur.cE ? H[hIdx] : (hIdx>0?H[hIdx-1]:null);
    if(!prevH) continue;
    const hr = prevH.hi-prevH.lo; if(hr<=0) continue;
    const w = (m)=>L.slice(x-m+1,x+1), wa=(m)=>AN.slice(x-m+1,x+1);
    const rej=(m)=>w(m).filter((l,q)=>{const r=l.hi-l.lo; return r>0 && (l.c-l.lo)/r>0.5 && (Math.min(l.o,l.c)-l.lo)/r>0.25;}).length;
    const hl=(m)=>{let c2=0;const ww=w(m);for(let q=1;q<ww.length;q++) if(ww[q].lo>ww[q-1].lo)c2++;return c2;};
    const shallow=(m)=>{const ww=w(m);let c2=0;for(let q=1;q<ww.length;q++){const d1=Math.min(o=>0,0);const p1=ww[q-1].c-ww[q-1].lo,p2=ww[q].c-ww[q].lo;if(p2<p1)c2++;}return c2;};
    const rng=(m)=>w(m).reduce((s,l)=>s+(l.hi-l.lo),0)/m;
    const vol=(m)=>w(m).reduce((s,l)=>s+l.v,0)/m;
    const dnv=(m)=>wa(m).reduce((s,d)=>s+d.dnVolPct,0)/m, upv=(m)=>wa(m).reduce((s,d)=>s+d.upVolPct,0)/m;
    const lo5=Math.min(...w(5).map(l=>l.lo)), lo10=Math.min(...w(10).map(l=>l.lo));
    const dnW=(m)=>w(m).reduce((s,l)=>s+(Math.min(l.o,l.c)-l.lo),0), upW=(m)=>w(m).reduce((s,l)=>s+(l.hi-Math.max(l.o,l.c)),0);
    const cp5=w(5).reduce((s,l)=>{const r=l.hi-l.lo;return s+(r>0?(l.c-l.lo)/r:0.5);},0)/5;
    const tp=TP[x]; const sp=SP[x]; const vp=VP[x];
    const tp5=TP.slice(x-4,x+1).reduce((s,t)=>({vc:s.vc+(t?.volCentroid??0.5),lf:s.lf+(t?.lateFightsBody??0),cb:s.cb+(t?.closingBurst??1)}),{vc:0,lf:0,cb:0});
    // ---- symmetric-barrier targets
    const ys=[];
    for(const K of KS){
      let y=0,tt=null;
      for(let r=cur.j;r<b && C.ts[r]<cur.cE+3600;r++){
        const up=C.h[r]>=px+K, dn=C.l[r]<=px-K;
        if(up&&dn){y=-1;tt=C.ts[r]-cur.cE;break;}
        if(up){y=1;tt=C.ts[r]-cur.cE;break;}
        if(dn){y=-1;tt=C.ts[r]-cur.cE;break;}
      }
      ys.push(y,tt??'');
      if(y===1)wins[K]++;
    }
    tot++;
    buf.push([td,cur.cO,(px*TICK).toFixed(2),Math.round(at),
      rej(3),rej(5),rej(10),hl(3),hl(5),shallow(3),shallow(5),+(rng(5)/at).toFixed(3),
      +dnv(5).toFixed(4),+upv(5).toFixed(4),+(vol(3)/(vol(10)||1)).toFixed(3),
      px-lo5,px-lo10,px-w(5)[0].o,px-w(10)[0].o,dnW(5),upW(5),+cp5.toFixed(4),
      +(((px-prevH.lo)/hr)).toFixed(4),px-prevH.lo,prevH.hi-px,hr,
      Math.floor(((cur.cO-sOpen)/60))%1440,
      tp?.volCentroid ?? '', tp?.moveCentroid ?? '', tp?.driveCentroid ?? '', tp?.moveLast10Rel ?? '', tp?.moveLast30Rel ?? '',
      tp?.lateRange30Rel ?? '', tp?.lateRange10Rel ?? '', tp?.lateFightsBody ?? '', tp?.closeOffLateHi ?? '', tp?.closeOffLateLo ?? '',
      tp?.volLastQ ?? '', tp?.volFirstQ ?? '', tp?.closingBurst ?? '', tp?.pathEff ?? '', tp?.reversals ?? '', tp?.maxSliceVolPct ?? '',
      +(tp5.vc/5).toFixed(4), +(tp5.lf/5).toFixed(4), +(tp5.cb/5).toFixed(4),
      vp?.maxVel5 ?? '', vp?.maxVel10 ?? '', vp?.maxVel30 ?? '', vp?.velShare5 ?? '', vp?.velShare10 ?? '', vp?.velShare30 ?? '',
      vp?.velDir ?? '', vp?.timeAtVel ?? '', vp?.giveBack ?? '', vp?.sweepUp ?? '', vp?.sweepDn ?? '',
      VP.slice(x-4,x+1).reduce((s2,t)=>s2+(t?.sweepUp||0),0), VP.slice(x-4,x+1).reduce((s2,t)=>s2+(t?.sweepDn||0),0),
      ...(sp? sp.v: new Array(6).fill('')), ...(sp? sp.m: new Array(6).fill('')), ...(sp? sp.r: new Array(6).fill('')),
      ...ys].join(','));
    rows++;
    if(buf.length>=20000){ws.write(buf.join('\n')+'\n');buf=[];}
  }
}
if(buf.length)ws.write(buf.join('\n')+'\n');
ws.end();
console.log(`${P} ${LTF} reversal set: ${rows.toLocaleString()} points in ${((Date.now()-t0)/1000).toFixed(1)}s → reversal/${P}_${LTF}_rev.csv`);
KS.forEach(k=>console.log(`   K=${k} ticks (${(k*TICK).toFixed(1)} pts): base rate P(+K before −K) = ${(wins[k]/tot*100).toFixed(2)}%`));
