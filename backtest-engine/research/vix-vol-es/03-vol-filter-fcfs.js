/**
 * Vol-regime FILTER on the 4-strategy FCFS portfolio — CAUSAL, train/test validated.
 *
 * Method: a per-strategy (or portfolio-level) vol gate pre-filters each strategy's trades
 * (a gated signal doesn't fire → the shared NQ slot frees for others), then the REAL FCFS
 * simulator (multi-strategy-rules/_base.js first-in-wins) resolves slot competition.
 *
 * NO LOOKAHEAD: vol regime = VIX trailing-252-day percentile (+ SPY backwardation), sampled as of
 * the PRIOR trading day's close (strictly before the trade's ET date). Thresholds fit on TRAIN
 * (≤2025-09-30), locked, measured on TEST (>2025-09-30). Window = SPY-IV coverage 2025-01-13..2026-01-28.
 *
 * Usage: node 03-vol-filter-fcfs.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate, open, reject, realizeNativeClose } from '../multi-strategy-rules/rules/_base.js';
import { calculateMetrics } from '../multi-strategy-rules/lib/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const WIN_START = '2025-01-13', WIN_END = '2026-01-28', TRAIN_END = '2025-09-30';

function isDST(ms){const d=new Date(ms),y=d.getUTCFullYear(),m=d.getUTCMonth();if(m>=3&&m<=9)return true;if(m===0||m===1||m===11)return false;if(m===2){const fd=new Date(Date.UTC(y,2,1)).getUTCDay();return ms>=Date.UTC(y,2,fd===0?8:15-fd,7);}if(m===10){const fd=new Date(Date.UTC(y,10,1)).getUTCDay();return ms<Date.UTC(y,10,fd===0?1:8-fd,6);}return false;}
const etDate=ms=>{const e=ms-(isDST(ms)?4:5)*3600000;const d=new Date(e);return`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;};

// ---- vol features ----
const vixArr=[]; // {date, close}
for(const r of fs.readFileSync(path.join(DATA,'iv/vix/VIX_History.csv'),'utf8').split('\n')){const p=r.split(',');if(p.length<5||!/^\d/.test(p[0]))continue;const[mm,dd,yy]=p[0].split('/');vixArr.push({date:`${yy}-${mm}-${dd}`,close:+p[4]});}
vixArr.sort((a,b)=>a.date<b.date?-1:1);
const vixPct={}; // date → trailing-252 percentile (0..1)
for(let i=0;i<vixArr.length;i++){const w=vixArr.slice(Math.max(0,i-252),i);if(w.length<30){vixPct[vixArr[i].date]=null;continue;}const below=w.filter(x=>x.close<=vixArr[i].close).length;vixPct[vixArr[i].date]=below/w.length;}
const vixDates=vixArr.map(x=>x.date);
const spyBack={}; // date → backwardation bool
{const lines=fs.readFileSync(path.join(DATA,'iv/spy/spy_short_dte_iv_daily.csv'),'utf8').split('\n');const H=lines[0].split(',');const ix=n=>H.indexOf(n);
 const vmap=Object.fromEntries(vixArr.map(x=>[x.date,x.close]));
 for(let i=1;i<lines.length;i++){const p=lines[i].split(',');if(p.length<H.length)continue;const date=p[0],dte0=+p[ix('dte0_avg_iv')],v=vmap[date];if(v)spyBack[date]=dte0>=v/100;}}
const spyDates=Object.keys(spyBack).sort();

function latestBefore(arr,d){let lo=0,hi=arr.length-1,r=null;while(lo<=hi){const m=(lo+hi)>>1;if(arr[m]<d){r=arr[m];lo=m+1;}else hi=m-1;}return r;}
function volAsOf(tradeDate){const vd=latestBefore(vixDates,tradeDate);const sd=latestBefore(spyDates,tradeDate);return{vixPct:vd?vixPct[vd]:null,backward:sd?spyBack[sd]:null};}

// ---- load strategy trades ----
const POINT_VALUE_NQ=20,COMMISSION_NQ=5;
const STRATEGIES=[{key:'lstb',file:'data/gold-standard/ls-flip-trigger-bar-v3.json'},{key:'gex-lt-3m',file:'data/gold-standard/gex-lt-3m-crossover-v3.json'},{key:'gex-flip-ivpct',file:'data/gold-standard/gex-flip-ivpct-v2.json'},{key:'gex-level-fade',file:'data/gold-standard/gex-level-fade-v2.json'}];
function loadAll(){
  const all=[];
  for(const def of STRATEGIES){const raw=JSON.parse(fs.readFileSync(path.join(ROOT,def.file),'utf8'));
    for(const t of raw.trades){if(t.status!=='completed'||t.entryTime==null||t.exitTime==null)continue;const side=String(t.side||'').toLowerCase();const ns=side==='long'||side==='buy'?'long':(side==='short'||side==='sell'?'short':null);if(!ns)continue;
      const ed=etDate(t.entryTime);if(ed<WIN_START||ed>WIN_END)continue;
      const exitTime=(t.exitTime<=t.entryTime)?t.entryTime+1:t.exitTime;
      all.push({id:`${def.key}:${t.id}`,strategyKey:def.key,side:ns,entryTime:t.entryTime,exitTime,etDate:ed,netPnL:t.netPnL,pointValue:t.pointValue??POINT_VALUE_NQ,commission:t.commission??COMMISSION_NQ,vol:volAsOf(ed)});}}
  return all.sort((a,b)=>a.entryTime-b.entryTime);
}
const ALL=loadAll();
console.log(`Loaded ${ALL.length} trades in ${WIN_START}..${WIN_END} (${ALL.filter(t=>t.vol.vixPct!=null).length} vol-labeled)`);
const counts={};for(const t of ALL)counts[t.strategyKey]=(counts[t.strategyKey]||0)+1;console.log('  per strategy:',counts,'\n');

const rule={name:'fiw',onSignal(s,t){if(s.position==null)open(s,t);else reject(s);},onNativeExit(s,t){if(s.position&&s.position.trade.id===t.id)realizeNativeClose(s,t);}};
function runFCFS(trades){const state=simulate(trades.slice().sort((a,b)=>a.entryTime-b.entryTime),rule);const m=calculateMetrics(state.realizedTrades);
  // $ max drawdown from realized equity curve (sorted by exit)
  const rt=state.realizedTrades.slice().sort((a,b)=>(a.exitTime||a.entryTime)-(b.exitTime||b.entryTime));
  let eq=0,pk=0,dd=0;for(const t of rt){eq+=t.netPnL;if(eq>pk)pk=eq;if(pk-eq>dd)dd=pk-eq;}
  return{...m,ddDollar:dd};}

function sub(trades,seg){if(seg==='train')return trades.filter(t=>t.etDate<=TRAIN_END);if(seg==='test')return trades.filter(t=>t.etDate>TRAIN_END);return trades;}
function show(label,m){console.log(`  ${label.padEnd(34)} n=${String(m.trades).padStart(4)}  PnL=$${String(Math.round(m.totalPnL)).padStart(7)}  PF=${(m.profitFactor===Infinity?'Inf':m.profitFactor.toFixed(2)).padStart(5)}  Sharpe=${m.sharpe.toFixed(2).padStart(5)}  maxDD=$${String(Math.round(m.ddDollar||0)).padStart(6)}  WR=${m.winRate.toFixed(0)}%`);}

// ---- gates ----
// portfolio low-vix gate: drop ALL trades when vixPct < theta
function gatePortfolioLowVix(t,theta){return !(t.vol.vixPct!=null&&t.vol.vixPct<theta);}
// per-strategy gates (economic direction fixed; threshold theta swept)
function gatePerStrat(t,th){const p=t.vol.vixPct;if(p==null)return true;
  if(t.strategyKey==='lstb')return p>=th.lstb;          // favor high vol
  if(t.strategyKey==='gex-level-fade')return p<th.glf;  // avoid high vol
  if(t.strategyKey==='gex-lt-3m')return p>=th.glx;      // avoid low vol
  return true;}                                          // gfi unfiltered

function applyGate(trades,fn){return trades.filter(fn);}

console.log('═══ BASELINE (no filter) ═══');
for(const seg of ['full','train','test']) show(`baseline ${seg}`,fcfsSeg(ALL,seg));
function fcfsSeg(trades,seg){return runFCFS(sub(trades,seg));}

// fit portfolio low-vix theta on TRAIN (maximize train Sharpe)
console.log('\n═══ Portfolio low-VIX gate (skip all when VIX trailing-pct < θ) ═══');
let bestTheta=null,bestSh=-Infinity;
for(const theta of [0.10,0.20,0.33,0.50]){const m=runFCFS(sub(applyGate(ALL,t=>gatePortfolioLowVix(t,theta)),'train'));if(m.sharpe>bestSh){bestSh=m.sharpe;bestTheta=theta;}}
console.log(`  fit θ=${bestTheta} on train (train Sharpe ${bestSh.toFixed(2)})`);
const gP=applyGate(ALL,t=>gatePortfolioLowVix(t,bestTheta));
for(const seg of ['full','train','test']) show(`lowVIX θ=${bestTheta} ${seg}`,fcfsSeg(gP,seg));

// fit per-strategy thresholds on TRAIN (each strategy: best retained standalone PF, dir fixed)
console.log('\n═══ Per-strategy VIX gates (lstb≥, glf<, glx≥) ═══');
function fitStrat(key,dir){ // dir '>=' favor-high or '<' avoid-high
  const tr=sub(ALL.filter(t=>t.strategyKey===key&&t.vol.vixPct!=null),'train');
  let best=null,bestPF=-Infinity;
  for(const th of [0.0,0.2,0.33,0.5,0.67]){const kept=tr.filter(t=>dir==='>='?t.vol.vixPct>=th:t.vol.vixPct<th);if(kept.length<tr.length*0.4)continue;const w=kept.filter(t=>t.netPnL>0).reduce((s,t)=>s+t.netPnL,0),l=-kept.filter(t=>t.netPnL<=0).reduce((s,t)=>s+t.netPnL,0);const pf=l>0?w/l:0;if(pf>bestPF){bestPF=pf;best=th;}}
  return best;}
const th={lstb:fitStrat('lstb','>='),glf:fitStrat('gex-level-fade','<'),glx:fitStrat('gex-lt-3m','>=')};
console.log(`  fit thresholds: lstb≥${th.lstb}  glf<${th.glf}  glx≥${th.glx}`);
const gS=applyGate(ALL,t=>gatePerStrat(t,th));
for(const seg of ['full','train','test']) show(`per-strat ${seg}`,fcfsSeg(gS,seg));
