/**
 * Vol-regime FILTER on the existing book.
 * Label each day by vol term-structure regime (from PRIOR day's close vol = causal/deployable):
 *   - backwardation: SPY 0-DTE ATM IV >= VIX/100 (front-end elevated = stress)
 *   - contango:      SPY 0-DTE ATM IV <  VIX/100 (calm)
 *   - also: SPY term_slope sign, and VIX-level tercile.
 * Then split each strategy's actual trades by regime → does PF/WR/PnL differ enough to filter on?
 *
 * Strategies: 4 NQ golds (lstb, gfi, glx, glf) from gold-standard JSONs + combined FCFS daily PnL.
 * Overlap with SPY-IV data: 2025-01-13 .. 2026-01-28.
 *
 * Usage: node 02-vol-regime-filter.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', '..', 'data');
const GS = path.join(DATA, 'gold-standard');

// ---- vol features per date ----
const vix={};
for(const r of fs.readFileSync(path.join(DATA,'iv/vix/VIX_History.csv'),'utf8').split('\n')){const p=r.split(',');if(p.length<5||!/^\d/.test(p[0]))continue;const[mm,dd,yy]=p[0].split('/');vix[`${yy}-${mm}-${dd}`]=+p[4];}
const volByDate={};
{const lines=fs.readFileSync(path.join(DATA,'iv/spy/spy_short_dte_iv_daily.csv'),'utf8').split('\n');const H=lines[0].split(',');const ix=n=>H.indexOf(n);
 for(let i=1;i<lines.length;i++){const p=lines[i].split(',');if(p.length<H.length)continue;const date=p[0];const v=vix[date];if(v==null)continue;
   const dte0=+p[ix('dte0_avg_iv')],slope=+p[ix('term_slope')];
   volByDate[date]={vix:v,dte0,slope,backward:dte0>=v/100,slopeInv:slope<0};}}
const volDates=Object.keys(volByDate).sort();
// VIX terciles over the overlap window
const vixVals=volDates.map(d=>volByDate[d].vix).sort((a,b)=>a-b);
const vixLo=vixVals[Math.floor(vixVals.length/3)],vixHi=vixVals[Math.floor(2*vixVals.length/3)];
function regimeAsOf(date){ // latest vol-date STRICTLY before `date` (causal)
  let lo=0,hi=volDates.length-1,res=null;while(lo<=hi){const m=(lo+hi)>>1;if(volDates[m]<date){res=volDates[m];lo=m+1;}else hi=m-1;}
  if(!res)return null;const f=volByDate[res];
  return{ts:f.backward?'backward':'contango',slope:f.slopeInv?'inverted':'normal',vix:f.vix>=vixHi?'vixHi':(f.vix<=vixLo?'vixLo':'vixMid')};
}
console.log(`Vol data: ${volDates.length} days (${volDates[0]}→${volDates[volDates.length-1]}) | VIX terciles ${vixLo.toFixed(1)}/${vixHi.toFixed(1)}\n`);

// ---- load strategy trades ----
const stratFiles={lstb:'ls-flip-trigger-bar-v3.json',gfi:'gex-flip-ivpct-v2.json',glx:'gex-lt-3m-crossover-v3.json',glf:'gex-level-fade-v2.json'};
const strat={};
for(const[k,f] of Object.entries(stratFiles)){
  const j=JSON.parse(fs.readFileSync(path.join(GS,f),'utf8'));const trades=j.results?.trades||j.trades||[];
  strat[k]=trades.map(t=>({date:new Date(t.entryTime).toISOString().slice(0,10),pnl:t.netPnL||0})).filter(t=>t.date>='2025-01-13'&&t.date<=volDates[volDates.length-1]);
}

function bucket(trades,dim){
  const g={};
  for(const t of trades){const r=regimeAsOf(t.date);if(!r)continue;const key=r[dim];(g[key]??={n:0,w:0,gw:0,gl:0,pnl:0});g[key].n++;if(t.pnl>0){g[key].w++;g[key].gw+=t.pnl;}else g[key].gl-=t.pnl;g[key].pnl+=t.pnl;}
  return g;
}
function fmt(g){return Object.entries(g).map(([k,v])=>`${k}: n=${v.n} WR=${(100*v.w/v.n).toFixed(0)}% PF=${v.gl>0?(v.gw/v.gl).toFixed(2):'Inf'} $${Math.round(v.pnl)} (avg $${(v.pnl/v.n).toFixed(0)})`).join('  |  ');}

for(const dim of ['ts','vix','slope']){
  console.log(`\n════ REGIME DIMENSION: ${dim==='ts'?'term-structure (contango/backwardation)':dim==='vix'?'VIX level tercile':'SPY term_slope sign'} ════`);
  for(const k of Object.keys(strat)){
    const g=bucket(strat[k],dim);
    console.log(`  ${k.padEnd(5)}: ${fmt(g)}`);
  }
}

// combined FCFS daily PnL (MNQ×10 NQ-equiv) by regime
console.log(`\n════ Combined 4-strat FCFS daily PnL by regime ════`);
const daily=[];
for(const line of fs.readFileSync(path.join(__dirname,'..','4strategy-portfolio','output','daily-pnl-mnq-4strat.csv'),'utf8').trim().split('\n').slice(1)){const[d,p]=line.split(',');if(d>='2025-01-13'&&d<=volDates[volDates.length-1])daily.push({date:d,pnl:(+p)*10});}
for(const dim of ['ts','vix','slope']){
  const g=bucket(daily,dim);
  console.log(`  ${dim.padEnd(5)}: ${fmt(g)}`);
}
