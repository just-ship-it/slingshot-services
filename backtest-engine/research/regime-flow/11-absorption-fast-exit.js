/**
 * Phase 7 — Absorption-driven fast EXIT: bail when the level isn't being defended.
 *
 * Entry = honest resting limit AT the level, filled on the wick (entry price = L0),
 * gated by pre-touch features (default RTH ET 8-15). Then the new lever:
 *   • Observe absorption over the first E seconds AFTER fill.
 *   • If absorption < BAIL (big algo NOT defending → break likely), EXIT now at market
 *     (C[i+E], + slip) — a small scratch — instead of riding to the -S_break stop.
 *   • Else ride to target +T or break -(S_break+slip); timeout marked to market.
 *
 * Compares the SAME entries under: no-bail baseline vs fast-exit across (E, BAIL).
 * The bail only helps if the low-absorption set is break-skewed enough that the avg
 * ride loss exceeds the bail cost — so we scan thresholds and let the data decide.
 * Train/test time split included.
 *
 * Usage: node research/regime-flow/11-absorption-fast-exit.js --start 2025-09-01 --end 2025-12-28
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
const SLIP = +arg('slip', 0.5), T_TGT = +arg('target', 5), S_BREAK = +arg('break', 5);
const PRODUCT = 'NQ';

console.log(`\n=== Absorption fast-exit (entry@level, +${T_TGT}/-${S_BREAK}, slip ${SLIP}) ===\n${START}→${END}\n`);

function loadLT(){const r=fs.readFileSync(path.join(DATA,'liquidity/nq/NQ_liquidity_levels.csv'),'utf8').trim().split('\n');const o=[];for(let i=1;i<r.length;i++){const f=r[i].split(',');const ts=+f[1];const lv=[f[3],f[4],f[5],f[6],f[7]].map(Number).filter(Number.isFinite);if(Number.isFinite(ts))o.push({ts,lv});}o.sort((a,b)=>a.ts-b.ts);return o;}
function loadGEX(){const r=fs.readFileSync(path.join(DATA,'gex/nq/NQ_gex_levels.csv'),'utf8').trim().split('\n');const m=new Map();for(let i=1;i<r.length;i++){const f=r[i].split(',');m.set(f[0],{put:[f[2],f[3],f[4]].map(Number),call:[f[5],f[6],f[7]].map(Number),flip:+f[1]});}return m;}
const LT=loadLT(),GEX=loadGEX();
function ltAt(t){let lo=0,hi=LT.length-1,a=-1;while(lo<=hi){const m=(lo+hi)>>1;if(LT[m].ts<=t){a=m;lo=m+1;}else hi=m-1;}return a>=0?LT[a].lv:null;}

async function loadOneMin(){const fp=path.join(DATA,'ohlcv',PRODUCT.toLowerCase(),`${PRODUCT}_ohlcv_1m.csv`);const s=new Date(START).getTime(),e=new Date(END).getTime()+864e5;const rows=[];await new Promise((res,rej)=>fs.createReadStream(fp).pipe(csv()).on('data',r=>{if(r.symbol&&r.symbol.includes('-'))return;const ts=new Date(r.ts_event).getTime();if(isNaN(ts)||ts<s||ts>e)return;rows.push({ts,v:+r.volume||0,s:r.symbol});}).on('end',res).on('error',rej));return rows;}
const oneMin=await loadOneMin();
const primaryByHour=new Map();
{const hv=new Map();for(const c of oneMin){const h=Math.floor(c.ts/36e5);if(!hv.has(h))hv.set(h,new Map());const m=hv.get(h);m.set(c.s,(m.get(c.s)||0)+c.v);}for(const[h,m]of hv){let bs='',bv=-1;for(const[s,v]of m)if(v>bv){bv=v;bs=s;}primaryByHour.set(h,bs);}}

const T=[],H=[],L=[],C=[],V=[],SY=[];
{const fp=path.join(DATA,'ohlcv',PRODUCT.toLowerCase(),`${PRODUCT}_ohlcv_1s.csv`);const sD=START.slice(0,10),eD=END.slice(0,10);const sTs=new Date(START).getTime(),eTs=new Date(END).getTime()+864e5;const rl=readline.createInterface({input:fs.createReadStream(fp),crlfDelay:Infinity});let hdr=false;console.log('Streaming 1s OHLC ...');for await(const line of rl){if(!hdr){hdr=true;continue;}const dp=line.slice(0,10);if(dp<sD)continue;if(dp>eD)break;const f=line.split(',');const sym=f[9];if(!sym||sym.includes('-'))continue;const ts=new Date(f[0]).getTime();if(ts<sTs||ts>eTs)continue;if(primaryByHour.get(Math.floor(ts/36e5))!==sym)continue;T.push(ts);H.push(+f[5]);L.push(+f[6]);C.push(+f[7]);V.push(+f[8]);SY.push(sym);}}
const N=T.length;console.log(`  ${N.toLocaleString()} primary 1s bars\n`);

function preClose(i){const tg=T[i]-LOOKBACK*1000;for(let j=i-1;j>=0;j--){if(SY[j]!==SY[i])return NaN;if(T[j]<=tg)return C[j];}return NaN;}
const etHour=ts=>{const d=new Date(ts);return (d.getUTCHours()+24-5)%24;};

// Single integrated walk from entry i0 (entry price Pe=L0). If bail is enabled and the
// position is STILL OPEN at bar i0+E with absorption<BAIL, exit at market there.
// Otherwise resolve at target / break / timeout. (Correct: non-bailed trades behave
// exactly like the baseline — only genuinely-open low-absorption trades get cut.)
function walk(i0,L0,dir,E,BAIL,absA){
  const hm=HOLD*1000, Pe=L0, bailIdx=i0+E;
  for(let j=i0;j<N;j++){
    if(SY[j]!==SY[i0]||T[j]-T[i0]>hm){ const mtm=dir<0?(Pe-C[j-1]):(C[j-1]-Pe); return {pnl:mtm,bailed:false}; }
    // target / break first (they take priority if hit within this bar)
    if(dir<0){ if(Pe-L[j]>=T_TGT)return {pnl:T_TGT,bailed:false}; if(H[j]-L0>=S_BREAK)return {pnl:-((L0+S_BREAK)-Pe)-SLIP,bailed:false}; }
    else { if(H[j]-Pe>=T_TGT)return {pnl:T_TGT,bailed:false}; if(L0-L[j]>=S_BREAK)return {pnl:-(Pe-(L0-S_BREAK))-SLIP,bailed:false}; }
    // still open at the bail bar?
    if(BAIL>0 && j===bailIdx && absA!==null && absA<BAIL){ const p=(dir<0?(L0-C[j]):(C[j]-L0))-SLIP; return {pnl:p,bailed:true}; }
  }
  return {pnl:0,bailed:false};
}

// collect entries (RTH-gated), with absorption over first E secs computed per config
const E_LIST=[2,3], BAIL_LIST=[0,10,20,40]; // BAIL=0 => no-bail baseline
const entries=[]; // each: {ts, dir, L0, i}
const lastTouchTs=new Map();
for(let i=LOOKBACK;i<N-5;i++){
  const hr=etHour(T[i]); if(hr<8||hr>15)continue; // RTH gate (pre-touch)
  const lt=ltAt(T[i]); const date=new Date(T[i]).toISOString().slice(0,10); const gx=GEX.get(date);
  const cands=[]; if(lt)for(const l of lt)cands.push(l);
  if(gx){for(const l of gx.put)if(Number.isFinite(l))cands.push(l);for(const l of gx.call)if(Number.isFinite(l))cands.push(l);if(Number.isFinite(gx.flip))cands.push(gx.flip);}
  for(const L0 of cands){
    if(!(L[i]-TOUCH_EPS<=L0&&L0<=H[i]+TOUCH_EPS))continue;
    const pc=preClose(i); if(!Number.isFinite(pc))continue;
    const dir=Math.sign(pc-L0); if(dir===0)continue;
    const k=Math.round(L0); const last=lastTouchTs.get(k);
    if(last!==undefined&&(T[i]-last)<COOLDOWN*1000)continue;
    lastTouchTs.set(k,T[i]);
    entries.push({ts:T[i],dir,L0,i});
  }
}
console.log(`RTH-gated entries: ${entries.length.toLocaleString()}\n`);

// absorption over [i, i+E] post-fill
function absorpAfter(i,E,dir,L0){
  let vol=0,pen=0,end=i+E; if(end>=N||SY[end]!==SY[i])return null;
  for(let j=i;j<=end;j++){ if(SY[j]!==SY[i])return null; vol+=V[j]; const p=dir<0?H[j]-L0:L0-L[j]; if(p>pen)pen=p; }
  return {a:vol/(pen+0.25),Pe:C[end],end};
}

function evalConfig(E,BAIL,subset){
  let n=0,pnl=0,wins=0,bailed=0;
  for(const e of subset){
    const ab = BAIL>0 ? absorpAfter(e.i,E,e.dir,e.L0) : null;
    const r=walk(e.i,e.L0,e.dir,E,BAIL,ab?ab.a:null);
    n++; pnl+=r.pnl; if(r.pnl>0)wins++; if(r.bailed)bailed++;
  }
  return {n,exp:pnl/n,wr:wins/n,total:pnl,bailed};
}

const mid=entries[Math.floor(entries.length/2)].ts;
const trainSet=entries.filter(e=>e.ts<mid), testSet=entries.filter(e=>e.ts>=mid);
console.log(`${'config'.padEnd(18)} ${'exp(pt)'.padStart(8)} ${'WR'.padStart(6)} ${'bailed%'.padStart(8)}   train→test exp`);
function row(label,E,BAIL){
  const all=evalConfig(E,BAIL,entries),trn=evalConfig(E,BAIL,trainSet),tst=evalConfig(E,BAIL,testSet);
  console.log(`${label.padEnd(18)} ${(all.exp>=0?'+':'')+all.exp.toFixed(2)} ${(all.wr*100).toFixed(1)}% ${(all.bailed/all.n*100).toFixed(0).padStart(7)}%   ${(trn.exp>=0?'+':'')+trn.exp.toFixed(2)}→${(tst.exp>=0?'+':'')+tst.exp.toFixed(2)}`);
}
row('no-bail baseline',0,0);
for(const E of E_LIST)for(const BAIL of BAIL_LIST.filter(b=>b>0)) row(`bail E${E} <${BAIL}`,E,BAIL);

console.log(`\nRead: a bail config whose exp & test-exp beat the no-bail baseline = the fast-exit`);
console.log(`adds real edge. If none beat it, low absorption isn't break-skewed enough to cut early,`);
console.log(`and the resting-limit + pre-touch gate stands on its own.\n`);
