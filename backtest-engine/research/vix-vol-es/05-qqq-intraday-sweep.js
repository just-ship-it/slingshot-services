/**
 * Per-strategy vol-filter sweep v2 — QQQ (Nasdaq-native) intraday vol, richer features, joint
 * selection, per-slice stability. Filters the 4-strategy FCFS NQ portfolio.
 *
 * Why QQQ: the strategies trade NQ (=Nasdaq); QQQ IV is the native vol (vs S&P VIX/SPY used in v1).
 * qqq_atm_iv_1m.csv covers the FULL gold window (2025-01→2026-04) at 1-min res → solves the SPY
 * data wall for the vol-LEVEL feature and gives intraday regime AT trade time (live-deployable).
 *
 * Features (causal): ivNow = QQQ ATM IV at the trade's entry minute (intraday, carry-fwd);
 *   ivPct = pctile of ivNow vs trailing-252 daily-close QQQ IV; ivChg5 = daily-close IV vs 5d ago
 *   (vol momentum); slope = QQQ term_slope as of prior day (short-DTE file, ≤2026-01-28 → null after,
 *   slope filters keep when null). Window 2025-01-13..2026-04-23 ($614,730 baseline).
 *
 * Usage: node 05-qqq-intraday-sweep.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate, open, reject, realizeNativeClose } from '../multi-strategy-rules/rules/_base.js';
import { calculateMetrics } from '../multi-strategy-rules/lib/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const WIN_START='2025-01-13', WIN_END='2026-04-23', TRAIN_END='2025-09-30';

function isDST(ms){const d=new Date(ms),y=d.getUTCFullYear(),m=d.getUTCMonth();if(m>=3&&m<=9)return true;if(m===0||m===1||m===11)return false;if(m===2){const fd=new Date(Date.UTC(y,2,1)).getUTCDay();return ms>=Date.UTC(y,2,fd===0?8:15-fd,7);}if(m===10){const fd=new Date(Date.UTC(y,10,1)).getUTCDay();return ms<Date.UTC(y,10,fd===0?1:8-fd,6);}return false;}
const etDate=ms=>{const e=ms-(isDST(ms)?4:5)*3600000;const d=new Date(e);return`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;};

// ---- QQQ intraday 1m ATM IV → minute map + daily-close series ----
console.log('Loading QQQ 1m ATM IV...');
const ivByMin=new Map(); const dailyClose={};
{const lines=fs.readFileSync(path.join(DATA,'iv/qqq/qqq_atm_iv_1m.csv'),'utf8').split('\n');const H=lines[0].split(',');const tI=H.indexOf('timestamp'),vI=H.indexOf('iv');
 for(let i=1;i<lines.length;i++){const p=lines[i].split(',');if(p.length<=vI)continue;const ts=new Date(p[tI]).getTime();const iv=+p[vI];if(isNaN(ts)||!(iv>0))continue;ivByMin.set(Math.floor(ts/60000),iv);dailyClose[etDate(ts)]=iv;}}
const dcDates=Object.keys(dailyClose).sort();const dcVals=dcDates.map(d=>dailyClose[d]);
console.log(`  ${ivByMin.size} minute IVs, ${dcDates.length} daily closes (${dcDates[0]}→${dcDates[dcDates.length-1]})`);
function ivNowAt(ms){let mk=Math.floor(ms/60000);for(let k=0;k<120;k++){if(ivByMin.has(mk-k))return ivByMin.get(mk-k);}return null;} // carry-fwd up to 2h
function trailingPct(dateStr,val){ // pctile of val vs trailing 252 daily closes strictly before dateStr
  let lo=0,hi=dcDates.length-1,idx=-1;while(lo<=hi){const m=(lo+hi)>>1;if(dcDates[m]<dateStr){idx=m;lo=m+1;}else hi=m-1;}
  if(idx<30)return null;const w=dcVals.slice(Math.max(0,idx-251),idx+1);return w.filter(x=>x<=val).length/w.length;}
function ivChg5(dateStr){let lo=0,hi=dcDates.length-1,idx=-1;while(lo<=hi){const m=(lo+hi)>>1;if(dcDates[m]<dateStr){idx=m;lo=m+1;}else hi=m-1;}if(idx<6)return null;return dcVals[idx]/dcVals[idx-5]-1;}

// ---- QQQ term_slope daily (≤2026-01-28) ----
const slopeByDate={};
{const lines=fs.readFileSync(path.join(DATA,'iv/qqq/qqq_short_dte_iv_daily.csv'),'utf8').split('\n');const H=lines[0].split(',');const sI=H.indexOf('term_slope');
 for(let i=1;i<lines.length;i++){const p=lines[i].split(',');if(p.length<=sI)continue;slopeByDate[p[0]]=+p[sI];}}
const slDates=Object.keys(slopeByDate).sort();
function slopeAsOf(dateStr){let lo=0,hi=slDates.length-1,r=null;while(lo<=hi){const m=(lo+hi)>>1;if(slDates[m]<dateStr){r=slDates[m];lo=m+1;}else hi=m-1;}return r?slopeByDate[r]:null;}

// ---- load trades + attach features ----
const STRATEGIES=[{key:'lstb',file:'data/gold-standard/ls-flip-trigger-bar-v3.json'},{key:'gex-lt-3m',file:'data/gold-standard/gex-lt-3m-crossover-v3.json'},{key:'gex-flip-ivpct',file:'data/gold-standard/gex-flip-ivpct-v2.json'},{key:'gex-level-fade',file:'data/gold-standard/gex-level-fade-v2.json'}];
function loadAll(){const all=[];for(const def of STRATEGIES){const raw=JSON.parse(fs.readFileSync(path.join(ROOT,def.file),'utf8'));
  for(const t of raw.trades){if(t.status!=='completed'||t.entryTime==null||t.exitTime==null)continue;const s=String(t.side||'').toLowerCase();const ns=s==='long'||s==='buy'?'long':(s==='short'||s==='sell'?'short':null);if(!ns)continue;const ed=etDate(t.entryTime);if(ed<WIN_START||ed>WIN_END)continue;const exitTime=t.exitTime<=t.entryTime?t.entryTime+1:t.exitTime;
    const ivN=ivNowAt(t.entryTime);const vol={ivPct:ivN!=null?trailingPct(ed,ivN):null,ivChg:ivChg5(ed),slope:slopeAsOf(ed)};
    all.push({id:`${def.key}:${t.id}`,strategyKey:def.key,side:ns,entryTime:t.entryTime,exitTime,etDate:ed,netPnL:t.netPnL,pointValue:t.pointValue??20,commission:t.commission??5,vol});}}
  return all.sort((a,b)=>a.entryTime-b.entryTime);}
const ALL=loadAll();
const cnt={};let labeled=0;for(const t of ALL){cnt[t.strategyKey]=(cnt[t.strategyKey]||0)+1;if(t.vol.ivPct!=null)labeled++;}
console.log(`Loaded ${ALL.length} trades (${labeled} ivPct-labeled), ${WIN_START}..${WIN_END}:`,cnt,'\n');

const rule={name:'fiw',onSignal(s,t){if(s.position==null)open(s,t);else reject(s);},onNativeExit(s,t){if(s.position&&s.position.trade.id===t.id)realizeNativeClose(s,t);}};
function runFCFS(trades){const st=simulate(trades.slice().sort((a,b)=>a.entryTime-b.entryTime),rule);const m=calculateMetrics(st.realizedTrades);const rt=st.realizedTrades.slice().sort((a,b)=>(a.exitTime||a.entryTime)-(b.exitTime||b.entryTime));let eq=0,pk=0,dd=0;for(const t of rt){eq+=t.netPnL;if(eq>pk)pk=eq;if(pk-eq>dd)dd=pk-eq;}return{...m,ddDollar:dd};}
const within=(tr,a,b)=>tr.filter(t=>t.etDate>=a&&t.etDate<=b);
function pmetrics(trades,a,b){return runFCFS(within(trades,a,b));}

// ---- richer feature menu ----
const MENU=[
  {id:'none',fn:v=>true},
  {id:'ivPct>=.33',fn:v=>v.ivPct==null||v.ivPct>=.33},{id:'ivPct>=.5',fn:v=>v.ivPct==null||v.ivPct>=.5},{id:'ivPct>=.67',fn:v=>v.ivPct==null||v.ivPct>=.67},
  {id:'ivPct<.5',fn:v=>v.ivPct==null||v.ivPct<.5},{id:'ivPct<.67',fn:v=>v.ivPct==null||v.ivPct<.67},
  {id:'ivPct[.2,.8]',fn:v=>v.ivPct==null||(v.ivPct>=.2&&v.ivPct<=.8)},{id:'ivPct[.33,.9]',fn:v=>v.ivPct==null||(v.ivPct>=.33&&v.ivPct<=.9)},
  {id:'slope>0',fn:v=>v.slope==null||v.slope>0},{id:'slope<0',fn:v=>v.slope==null||v.slope<0},
  {id:'ivChg>0',fn:v=>v.ivChg==null||v.ivChg>0},{id:'ivChg<0',fn:v=>v.ivChg==null||v.ivChg<0},
  {id:'ivPct>=.5&ivChg>0',fn:v=>(v.ivPct==null||v.ivPct>=.5)&&(v.ivChg==null||v.ivChg>0)},
  {id:'ivPct>=.5&slope<0',fn:v=>(v.ivPct==null||v.ivPct>=.5)&&(v.slope==null||v.slope<0)},
];
const apply=(filters)=>ALL.filter(t=>{const fn=filters[t.strategyKey];return fn?fn(t.vol):true;});
const base={full:pmetrics(ALL,WIN_START,WIN_END),tr:pmetrics(ALL,WIN_START,TRAIN_END),te:pmetrics(ALL,'2025-10-01',WIN_END)};
const L=m=>`PnL=$${Math.round(m.totalPnL)} PF=${(m.profitFactor===Infinity?'Inf':m.profitFactor.toFixed(2))} Sh=${m.sharpe.toFixed(1)} DD=$${Math.round(m.ddDollar)}`;
console.log(`BASELINE full: ${L(base.full)}\n  train: ${L(base.tr)}  ||  test: ${L(base.te)}\n`);

// ---- per-strategy independent sweep (richer menu) ----
console.log('════ Per-strategy sweep (richer features) — top robust picks ════');
const robustPick={};
for(const def of STRATEGIES){
  const rows=MENU.map(m=>{const f=apply({[def.key]:m.fn});return{id:m.id,fn:m.fn,trPF:pmetrics(f,WIN_START,TRAIN_END).profitFactor,te:pmetrics(f,'2025-10-01',WIN_END)};});
  const gen=rows.filter(r=>r.id!=='none'&&r.trPF>base.tr.profitFactor&&r.te.profitFactor>base.te.profitFactor).sort((a,b)=>b.te.profitFactor-a.te.profitFactor);
  robustPick[def.key]=gen.length?gen[0]:rows.find(r=>r.id==='none');
  const top=gen.slice(0,3).map(r=>`${r.id}(tesPF ${r.te.profitFactor.toFixed(2)})`).join(', ')||'none robust';
  console.log(`  ${def.key.padEnd(15)} → ${robustPick[def.key].id.padEnd(18)} | robust: ${top}`);
}

// ---- greedy JOINT selection on train portfolio PF (accounts for slot reallocation) ----
console.log('\n════ Greedy joint selection (maximize TRAIN portfolio PF) ════');
let chosen={};let curPF=base.tr.profitFactor;
for(let iter=0;iter<4;iter++){
  let best=null;
  for(const def of STRATEGIES){for(const m of MENU){if(m.id==='none')continue;const trial={...chosen,[def.key]:m.fn};const pf=pmetrics(apply(trial),WIN_START,TRAIN_END).profitFactor;if(pf>curPF+0.005&&(!best||pf>best.pf)){best={key:def.key,id:m.id,fn:m.fn,pf};}}}
  if(!best)break;chosen[best.key]=best.fn;chosen[best.key+'_id']=best.id;curPF=best.pf;console.log(`  + ${best.key} ${best.id} → train PF ${best.pf.toFixed(2)}`);
}
const jf=Object.fromEntries(Object.entries(chosen).filter(([k])=>!k.endsWith('_id')));

// ---- compare versions + per-slice stability ----
console.log('\n════ VERSIONS (full / test) ════');
const rf=Object.fromEntries(Object.entries(robustPick).map(([k,v])=>[k,v.fn]));
function ver(label,filters){const f=apply(filters);console.log(`  ${label.padEnd(24)} full: ${L(pmetrics(f,WIN_START,WIN_END))}  ||  test: ${L(pmetrics(f,'2025-10-01',WIN_END))}`);return f;}
ver('baseline',{});
const vR=ver('per-strat robust',rf);
const vJ=ver('greedy joint',jf);

console.log('\n════ Per-slice stability (quarterly PF) — baseline vs robust vs joint ════');
const slices=[['Q1','2025-01-13','2025-04-15'],['Q2','2025-04-16','2025-07-15'],['Q3','2025-07-16','2025-10-15'],['Q4','2025-10-16','2026-01-15'],['Q5','2026-01-16','2026-04-23']];
for(const[name,a,b] of slices){
  const bp=pmetrics(ALL,a,b).profitFactor,rp=pmetrics(vR,a,b).profitFactor,jp=pmetrics(vJ,a,b).profitFactor;
  console.log(`  ${name} ${a}..${b}:  base PF ${bp.toFixed(2)}  robust ${rp.toFixed(2)}  joint ${jp.toFixed(2)}`);
}
console.log('\nrobust picks:',Object.fromEntries(Object.entries(robustPick).map(([k,v])=>[k,v.id])));
console.log('joint picks:',Object.fromEntries(Object.entries(chosen).filter(([k])=>k.endsWith('_id')).map(([k,v])=>[k.replace('_id',''),v])));
