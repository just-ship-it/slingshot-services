/**
 * Phase 4 — Granular big-algo detection at the level: what separates REJECT from BREAK?
 *
 * Builds on Phase 3 (wick touches at levels, high/low honest). For each touch we now
 * compute CAUSAL granular 1s features available at/approaching the touch (usable with a
 * limit-at-level entry), plus the +5/-5 and +5/-3 outcome, then measure P(reject) by
 * feature bucket. The features encode the footprint of a large algo:
 *
 *   touch_vol_z   — touch-bar volume vs 120s baseline (surge = participation)
 *   absorption    — touch volume / penetration depth (high vol, little pierce = defense)
 *   penetration   — how far the wick pierced PAST the level on the touch bar
 *   approach_vel  — pts/sec into the level over the prior 30s (sweep vs grind)
 *   ofi_into      — BVC pressure pushing INTO the level (aggression being absorbed)
 *   prior_touches — same level touched in the last 2h (contested/defended)
 *   at_day_extreme— level sits within 5pt of the trailing 1h high/low (range edge)
 *   hour_et       — ET hour bucket (the 09:30 open behaves differently)
 *
 * Dumps a compact touches CSV (~thousands of rows) so later passes skip the 7.6GB read.
 *
 * Usage: node research/regime-flow/07-touch-features-and-separation.js \
 *          --start 2025-09-01 --end 2025-12-28 --out data/features/nq_touches_2025Q4.csv
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const DATA = path.join(ROOT, 'data');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const START = arg('start', '2025-09-01'), END = arg('end', '2025-12-28');
const HOLD = +arg('hold', 900), TOUCH_EPS = +arg('touch-eps', 0.5);
const LOOKBACK = +arg('lookback', 30), COOLDOWN = +arg('cooldown', 300);
const OUT = arg('out', 'data/features/nq_touches_2025Q4.csv');
const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
const PRODUCT = 'NQ';

console.log(`\n=== Touch features & reject/break separation ===\nWindow ${START}→${END}\n`);

// ---- levels ----
function loadLT(){const r=fs.readFileSync(path.join(DATA,'liquidity/nq/NQ_liquidity_levels.csv'),'utf8').trim().split('\n');const o=[];for(let i=1;i<r.length;i++){const f=r[i].split(',');const ts=+f[1];const lv=[f[3],f[4],f[5],f[6],f[7]].map(Number).filter(Number.isFinite);if(Number.isFinite(ts))o.push({ts,lv});}o.sort((a,b)=>a.ts-b.ts);return o;}
function loadGEX(){const r=fs.readFileSync(path.join(DATA,'gex/nq/NQ_gex_levels.csv'),'utf8').trim().split('\n');const m=new Map();for(let i=1;i<r.length;i++){const f=r[i].split(',');m.set(f[0],{put:[f[2],f[3],f[4]].map(Number),call:[f[5],f[6],f[7]].map(Number),flip:+f[1]});}return m;}
const LT=loadLT(),GEX=loadGEX();
function ltAt(t){let lo=0,hi=LT.length-1,a=-1;while(lo<=hi){const m=(lo+hi)>>1;if(LT[m].ts<=t){a=m;lo=m+1;}else hi=m-1;}return a>=0?LT[a].lv:null;}

// ---- primary-by-hour ----
async function loadOneMin(){const fp=path.join(DATA,'ohlcv',PRODUCT.toLowerCase(),`${PRODUCT}_ohlcv_1m.csv`);const s=new Date(START).getTime(),e=new Date(END).getTime()+864e5;const rows=[];await new Promise((res,rej)=>fs.createReadStream(fp).pipe(csv()).on('data',r=>{if(r.symbol&&r.symbol.includes('-'))return;const ts=new Date(r.ts_event).getTime();if(isNaN(ts)||ts<s||ts>e)return;rows.push({ts,v:+r.volume||0,s:r.symbol});}).on('end',res).on('error',rej));return rows;}
const oneMin=await loadOneMin();
const primaryByHour=new Map();
{const hv=new Map();for(const c of oneMin){const h=Math.floor(c.ts/36e5);if(!hv.has(h))hv.set(h,new Map());const m=hv.get(h);m.set(c.s,(m.get(c.s)||0)+c.v);}for(const[h,m]of hv){let bs='',bv=-1;for(const[s,v]of m)if(v>bv){bv=v;bs=s;}primaryByHour.set(h,bs);}}

// ---- stream 1s into arrays ----
const T=[],O=[],H=[],L=[],C=[],V=[],SY=[];
{const fp=path.join(DATA,'ohlcv',PRODUCT.toLowerCase(),`${PRODUCT}_ohlcv_1s.csv`);const sD=START.slice(0,10),eD=END.slice(0,10);const sTs=new Date(START).getTime(),eTs=new Date(END).getTime()+864e5;const rl=readline.createInterface({input:fs.createReadStream(fp),crlfDelay:Infinity});let hdr=false;console.log('Streaming 1s OHLC ...');for await(const line of rl){if(!hdr){hdr=true;continue;}const dp=line.slice(0,10);if(dp<sD)continue;if(dp>eD)break;const f=line.split(',');const sym=f[9];if(!sym||sym.includes('-'))continue;const ts=new Date(f[0]).getTime();if(ts<sTs||ts>eTs)continue;if(primaryByHour.get(Math.floor(ts/36e5))!==sym)continue;T.push(ts);O.push(+f[4]);H.push(+f[5]);L.push(+f[6]);C.push(+f[7]);V.push(+f[8]);SY.push(sym);}}
const N=T.length;console.log(`  ${N.toLocaleString()} primary 1s bars\n`);

// ---- inline BVC ofi (60s) ----
function normCdf(z){const t=1/(1+0.2316419*Math.abs(z)),d=0.3989422804014327*Math.exp(-z*z/2);let p=d*t*(0.31938153+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));return z>=0?1-p:p;}
const OFI=new Float64Array(N);
{let sym=null,prev=NaN,dpSum=0,dpSum2=0,dpN=0,sgn=new Float64Array(1024),vol=new Float64Array(1024),n=0,sSgn=0,sVol=0;for(let i=0;i<N;i++){if(SY[i]!==sym){sym=SY[i];prev=NaN;dpSum=dpSum2=dpN=0;n=0;sSgn=sVol=0;sgn.fill(0);vol.fill(0);}const c=C[i],v=V[i];const dc=Number.isNaN(prev)?0:c-prev;const sig=dpN>=30?Math.sqrt(Math.max(1e-9,dpSum2/dpN-(dpSum/dpN)**2)):NaN;let sv=0;if(Number.isFinite(sig)&&sig>1e-6)sv=v*(2*normCdf(dc/sig)-1);const slot=n%1024;const oS=n-60>=0?sgn[(n-60)%1024]:0,oV=n-60>=0?vol[(n-60)%1024]:0;sgn[slot]=sv;vol[slot]=v;sSgn+=sv-oS;sVol+=v-oV;OFI[i]=sVol>0?sSgn/sVol:0;dpSum+=dc;dpSum2+=dc*dc;dpN++;prev=c;n++;}}

// ---- helpers ----
function preClose(i){const tg=T[i]-LOOKBACK*1000;for(let j=i-1;j>=0;j--){if(SY[j]!==SY[i])return NaN;if(T[j]<=tg)return C[j];}return NaN;}
function avgVol(i,w){let s=0,c=0;for(let j=i-1;j>=0&&c<w;j--){if(SY[j]!==SY[i])break;s+=V[j];c++;}return c?s/c:NaN;}
function trailHL(i,w){let hi=-Infinity,lo=Infinity,c=0;for(let j=i-1;j>=0&&c<w;j--){if(SY[j]!==SY[i])break;if(H[j]>hi)hi=H[j];if(L[j]<lo)lo=L[j];c++;}return{hi,lo};}
function rejectOrBreak(i,L0,dir,Tgt,Stop){const hm=HOLD*1000,s=SY[i];for(let j=i;j<N;j++){if(SY[j]!==s||T[j]-T[i]>hm)return 'to';if(dir<0){if(L0-L[j]>=Tgt)return 'rej';if(H[j]-L0>=Stop)return 'brk';}else{if(H[j]-L0>=Tgt)return 'rej';if(L0-L[j]>=Stop)return 'brk';}}return 'to';}
const etHour=ts=>{const d=new Date(ts);return (d.getUTCHours()+24-5)%24;}; // approx ET (EST)

// ---- detect touches + features ----
const lastTouchTs=new Map(), touchHist=new Map();
const rows=[]; let touches=0;
for(let i=LOOKBACK;i<N;i++){
  const lt=ltAt(T[i]); const date=new Date(T[i]).toISOString().slice(0,10); const gx=GEX.get(date);
  const cands=[]; if(lt)for(const l of lt)cands.push([l,'LT']);
  if(gx){for(const l of gx.put)if(Number.isFinite(l))cands.push([l,'GEX_PUT']);for(const l of gx.call)if(Number.isFinite(l))cands.push([l,'GEX_CALL']);if(Number.isFinite(gx.flip))cands.push([gx.flip,'GEX_FLIP']);}
  if(!cands.length)continue;
  for(const[L0,src]of cands){
    if(!(L[i]-TOUCH_EPS<=L0&&L0<=H[i]+TOUCH_EPS))continue;
    const pc=preClose(i); if(!Number.isFinite(pc))continue;
    const dir=Math.sign(pc-L0); if(dir===0)continue;
    const k=Math.round(L0); const last=lastTouchTs.get(k);
    if(last!==undefined&&(T[i]-last)<COOLDOWN*1000)continue;
    lastTouchTs.set(k,T[i]);
    // prior touches in last 2h
    let hist=touchHist.get(k)||[]; const prior=hist.filter(t=>T[i]-t<=2*36e5).length; hist.push(T[i]); touchHist.set(k,hist);
    touches++;
    // features (causal, at touch)
    const penetration = dir<0 ? Math.max(0,H[i]-L0) : Math.max(0,L0-L[i]); // pierce past level on touch bar
    const av=avgVol(i,120); const touch_vol_z = (Number.isFinite(av)&&av>0)? V[i]/av : 1;
    const absorption = V[i]/(penetration+0.25);                      // vol per pt of pierce
    const approach_vel = Math.abs(C[i]-pc)/LOOKBACK;                  // pts/sec into level
    const ofi_into = OFI[i]*( -dir );                                 // >0 = pressure pushing toward level
    const {hi,lo}=trailHL(i,3600); const at_extreme = (dir<0 ? (hi-L0<=5) : (L0-lo<=5)) ? 1 : 0;
    const hr=etHour(T[i]);
    const o55=rejectOrBreak(i,L0,dir,5,5), o53=rejectOrBreak(i,L0,dir,5,3);
    rows.push({ts:T[i],L0,src,dir,penetration,touch_vol_z,absorption,approach_vel,ofi_into,prior,at_extreme,hr,o55,o53});
  }
}
console.log(`Qualifying touches: ${touches.toLocaleString()}\n`);

// ---- dump compact CSV ----
fs.mkdirSync(path.dirname(outPath),{recursive:true});
const ws=fs.createWriteStream(outPath);
ws.write('ts,level,src,dir,penetration,touch_vol_z,absorption,approach_vel,ofi_into,prior_touches,at_extreme,hour_et,o55,o53\n');
for(const r of rows)ws.write(`${new Date(r.ts).toISOString()},${r.L0},${r.src},${r.dir},${r.penetration.toFixed(2)},${r.touch_vol_z.toFixed(3)},${r.absorption.toFixed(2)},${r.approach_vel.toFixed(3)},${r.ofi_into.toFixed(4)},${r.prior},${r.at_extreme},${r.hr},${r.o55},${r.o53}\n`);
ws.end();
console.log(`Wrote ${outPath}\n`);

// ---- separation analysis: P(reject) on +5/-5 by feature quantile ----
function reject(r){return r.o55==='rej'?1:(r.o55==='brk'?0:null);} // timeouts excluded
const base = rows.filter(r=>reject(r)!==null);
const baseP = base.reduce((a,r)=>a+reject(r),0)/base.length;
console.log(`Baseline +5/-5 P(reject | resolved) = ${(baseP*100).toFixed(1)}%  (n=${base.length.toLocaleString()})\n`);

function quantileReport(name,valFn,asc=true){
  const arr=base.map(r=>({v:valFn(r),y:reject(r)})).filter(x=>Number.isFinite(x.v));
  arr.sort((a,b)=>a.v-b.v); const m=arr.length;
  console.log(`  ${name}:`);
  for(let q=0;q<5;q++){const lo=Math.floor(q*m/5),hi=Math.floor((q+1)*m/5);let s=0;for(let i=lo;i<hi;i++)s+=arr[i].y;const p=s/(hi-lo);const vlo=arr[lo].v,vhi=arr[hi-1].v;console.log(`    Q${q+1} [${vlo.toFixed(2)}..${vhi.toFixed(2)}]: P(reject)=${(p*100).toFixed(1)}%  (n=${hi-lo})`);}
}
console.log(`Separation by feature (quintiles, +5/-5, timeouts excluded):\n`);
quantileReport('absorption (vol/pierce)', r=>r.absorption);
quantileReport('touch_vol_z', r=>r.touch_vol_z);
quantileReport('penetration (pierce pts)', r=>r.penetration);
quantileReport('approach_vel (pts/s)', r=>r.approach_vel);
quantileReport('ofi_into (pressure into level)', r=>r.ofi_into);
quantileReport('prior_touches (2h)', r=>r.prior_touches ?? r.prior);

// categorical: src, at_extreme, hour
function catReport(name,keyFn){
  const m=new Map();
  for(const r of base){const k=keyFn(r);if(!m.has(k))m.set(k,{s:0,n:0});const e=m.get(k);e.s+=reject(r);e.n++;}
  console.log(`\n  ${name}:`);
  for(const[k,e]of [...m.entries()].sort((a,b)=>b[1].s/b[1].n-a[1].s/a[1].n))console.log(`    ${String(k).padEnd(10)} P(reject)=${(e.s/e.n*100).toFixed(1)}%  (n=${e.n})`);
}
catReport('by level source', r=>r.src);
catReport('at_extreme (level at 1h range edge)', r=>r.at_extreme);
catReport('by ET hour', r=>r.hr);

console.log(`\nRead: features whose top/bottom quintile P(reject) departs far from the ${(baseP*100).toFixed(0)}% baseline`);
console.log(`are the big-algo tells. Stack the best 2-3 into an entry filter and the wick-fade hit-rate climbs.\n`);
