/**
 * Phase 6 — Honest confirmation-entry re-test of the absorption wick-fade.
 *
 * Phase 5's +1.39pt assumed a passive LIMIT fill AT the level — but absorption is only
 * knowable AFTER the touch second prints. The live-honest mechanic:
 *   1. Wick touches level L at second i.
 *   2. Observe a K-second confirmation window [i, i+K]: absorption = Σvolume / pierce-depth.
 *   3. If absorption >= THRESH AND the level hasn't already broken, ENTER at the REAL
 *      price C[i+K] (not the wick), which is a worse entry than L.
 *   4. Forward walk on 1s high/low from entry:
 *        reject WIN  = price moves +T from ENTRY (limit exit, no slip)
 *        break LOSS  = price pierces the level by S_break (stop, + slippage)
 *        timeout     = marked to market at hold end
 *   Realized PnL is measured in points FROM THE ACTUAL ENTRY, with stop slippage.
 *
 * Compares confirmed-entry expectancy to the optimistic limit-at-level baseline, with a
 * train/test time split. This decides live tradeability.
 *
 * Usage: node research/regime-flow/09-confirmation-entry-retest.js --start 2025-09-01 --end 2025-12-28
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
const THRESH = +arg('absorption', 40), SLIP = +arg('slip', 0.5);
const PRODUCT = 'NQ';

console.log(`\n=== Confirmation-entry honest re-test (absorption≥${THRESH}, slip ${SLIP}pt) ===\nWindow ${START}→${END}\n`);

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

// simulate one confirmed entry; returns {entered, win, pnl, ts} or null
function simulate(i,L0,dir,K,T_tgt,S_break){
  // confirmation window [i, i+K]
  let winVol=0, pen=0; let end=i+K;
  if(end>=N||SY[end]!==SY[i])return null;
  for(let j=i;j<=end;j++){ if(SY[j]!==SY[i])return null; winVol+=V[j];
    if(dir<0){ const p=H[j]-L0; if(p>pen)pen=p; if(H[j]-L0>=S_break)return {entered:false}; } // broke during confirm
    else { const p=L0-L[j]; if(p>pen)pen=p; if(L0-L[j]>=S_break)return {entered:false}; }
  }
  const absorption = winVol/(pen+0.25);
  if(absorption<THRESH) return {entered:false};
  const Pe=C[end];                                   // real entry price after confirmation
  // forward walk from end+1
  const hm=HOLD*1000;
  for(let j=end+1;j<N;j++){
    if(SY[j]!==SY[i]||T[j]-T[i]>hm){ // timeout — mark to market
      const mtm = dir<0 ? (Pe-C[j-1]) : (C[j-1]-Pe);
      return {entered:true,win:mtm>0,pnl:mtm,to:true};
    }
    if(dir<0){
      if(Pe-L[j]>=T_tgt) return {entered:true,win:true,pnl:T_tgt};            // target (limit, no slip)
      if(H[j]-L0>=S_break) return {entered:true,win:false,pnl:-((L0+S_break)-Pe)-SLIP}; // break+slip
    } else {
      if(H[j]-Pe>=T_tgt) return {entered:true,win:true,pnl:T_tgt};
      if(L0-L[j]>=S_break) return {entered:true,win:false,pnl:-(Pe-(L0-S_break))-SLIP};
    }
  }
  return {entered:true,win:false,pnl:0,to:true};
}

// detect touches, simulate across configs
const lastTouchTs=new Map();
const configs=[]; for(const K of [1,2,3])for(const T_tgt of [5,10])for(const S_break of [3,5]) configs.push({K,T_tgt,S_break});
const agg={}; for(const c of configs)agg[`K${c.K}_T${c.T_tgt}_S${c.S_break}`]={trades:[],triggers:0};

for(let i=LOOKBACK;i<N-5;i++){
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
    for(const c of configs){
      const r=simulate(i,L0,dir,c.K,c.T_tgt,c.S_break);
      if(!r)continue;
      const a=agg[`K${c.K}_T${c.T_tgt}_S${c.S_break}`];
      a.triggers++;
      if(r.entered) a.trades.push({ts:T[i],win:r.win,pnl:r.pnl});
    }
  }
}

function summarize(trades){
  const n=trades.length; if(!n)return null;
  const wins=trades.filter(t=>t.win).length;
  const pnl=trades.reduce((a,t)=>a+t.pnl,0);
  return {n,wr:wins/n,exp:pnl/n,total:pnl};
}
console.log(`Confirmation-entry results (entered trades only; PnL in NQ points, after ${SLIP}pt stop slip):\n`);
console.log(`  ${'config'.padEnd(14)} ${'entries'.padStart(8)}  win%   exp(pt)  total(pt)   train→test exp`);
const mid=T[Math.floor(N/2)];
for(const key of Object.keys(agg)){
  const tr=agg[key].trades;
  const all=summarize(tr); if(!all||all.n<30){console.log(`  ${key.padEnd(14)} ${String(all?all.n:0).padStart(8)}  (too few)`);continue;}
  const trn=summarize(tr.filter(t=>t.ts<mid)), tst=summarize(tr.filter(t=>t.ts>=mid));
  console.log(`  ${key.padEnd(14)} ${String(all.n).padStart(8)}  ${(all.wr*100).toFixed(1)}%  ${all.exp>=0?'+':''}${all.exp.toFixed(2)}   ${all.total>=0?'+':''}${all.total.toFixed(0)}    ${trn?(trn.exp>=0?'+':'')+trn.exp.toFixed(2):'–'}→${tst?(tst.exp>=0?'+':'')+tst.exp.toFixed(2):'–'}`);
}
console.log(`\nKey: config = K(confirm secs)_T(target)_S(break stop). exp(pt) = avg points/trade after slippage.`);
console.log(`Compare to optimistic limit-at-level baseline (+1.39pt @ 64%). If exp stays clearly`);
console.log(`positive and train≈test, the edge survives honest fills → green light to build the strategy.\n`);
