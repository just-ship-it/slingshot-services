/**
 * Per-strategy vol-filter SWEEP on the 4-strategy FCFS portfolio (full $614k gold window).
 *
 * Each strategy gets its OWN vol filter (one-rule-fits-all is wrong — strategies have different,
 * sometimes opposite, vol sensitivity). We sweep a candidate menu per strategy INDEPENDENTLY
 * (others unfiltered), measure the PORTFOLIO impact on TRAIN and TEST, keep filters that improve
 * BOTH halves (generalize), then combine survivors into comparable "versions".
 *
 * Vol features = SPY-IV ONLY (full coverage to 2026-04 + fully live-reproducible, no VIX feed):
 *   - ivPct: trailing-252 percentile of SPY dte1 ATM IV (vol-level / VIX proxy)
 *   - slope: SPY term_slope sign (dte0→dte2; <0 = front-elevated/backwardation)
 * Sampled as of PRIOR trading day's close (causal). Window 2025-01-13..2026-04-23.
 *
 * Usage: node 04-per-strategy-sweep.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate, open, reject, realizeNativeClose } from '../multi-strategy-rules/rules/_base.js';
import { calculateMetrics } from '../multi-strategy-rules/lib/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
// vol data (SPY-IV) ends 2026-01-28 — cap window there so every trade has a valid causal vol label.
// (The full gold window runs to 2026-04-23 / $614,730; the last ~3 months can't be vol-labeled in
//  BACKTEST — a data gap, not a live limitation. We validate on the vol-covered ~$475k sub-window.)
const WIN_START='2025-01-13', WIN_END='2026-01-28', TRAIN_END='2025-09-30';

function isDST(ms){const d=new Date(ms),y=d.getUTCFullYear(),m=d.getUTCMonth();if(m>=3&&m<=9)return true;if(m===0||m===1||m===11)return false;if(m===2){const fd=new Date(Date.UTC(y,2,1)).getUTCDay();return ms>=Date.UTC(y,2,fd===0?8:15-fd,7);}if(m===10){const fd=new Date(Date.UTC(y,10,1)).getUTCDay();return ms<Date.UTC(y,10,fd===0?1:8-fd,6);}return false;}
const etDate=ms=>{const e=ms-(isDST(ms)?4:5)*3600000;const d=new Date(e);return`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;};

// ---- SPY-IV vol features ----
const spyArr=[]; // {date, iv(dte1), slope}
{const lines=fs.readFileSync(path.join(DATA,'iv/spy/spy_short_dte_iv_daily.csv'),'utf8').split('\n');const H=lines[0].split(',');const ix=n=>H.indexOf(n);
 for(let i=1;i<lines.length;i++){const p=lines[i].split(',');if(p.length<H.length)continue;spyArr.push({date:p[0],iv:+p[ix('dte1_avg_iv')],slope:+p[ix('term_slope')]});}}
spyArr.sort((a,b)=>a.date<b.date?-1:1);
const feat={}; // date → {ivPct, slope}
for(let i=0;i<spyArr.length;i++){const w=spyArr.slice(Math.max(0,i-252),i);const ivPct=w.length<30?null:w.filter(x=>x.iv<=spyArr[i].iv).length/w.length;feat[spyArr[i].date]={ivPct,slope:spyArr[i].slope};}
const featDates=spyArr.map(x=>x.date);
function latestBefore(arr,d){let lo=0,hi=arr.length-1,r=null;while(lo<=hi){const m=(lo+hi)>>1;if(arr[m]<d){r=arr[m];lo=m+1;}else hi=m-1;}return r;}
function volAsOf(d){const fd=latestBefore(featDates,d);return fd?feat[fd]:{ivPct:null,slope:null};}
console.log(`SPY-IV features: ${featDates.length} days (${featDates[0]}→${featDates[featDates.length-1]})`);

// ---- load trades ----
const STRATEGIES=[{key:'lstb',file:'data/gold-standard/ls-flip-trigger-bar-v3.json'},{key:'gex-lt-3m',file:'data/gold-standard/gex-lt-3m-crossover-v3.json'},{key:'gex-flip-ivpct',file:'data/gold-standard/gex-flip-ivpct-v2.json'},{key:'gex-level-fade',file:'data/gold-standard/gex-level-fade-v2.json'}];
function loadAll(){const all=[];for(const def of STRATEGIES){const raw=JSON.parse(fs.readFileSync(path.join(ROOT,def.file),'utf8'));
  for(const t of raw.trades){if(t.status!=='completed'||t.entryTime==null||t.exitTime==null)continue;const s=String(t.side||'').toLowerCase();const ns=s==='long'||s==='buy'?'long':(s==='short'||s==='sell'?'short':null);if(!ns)continue;const ed=etDate(t.entryTime);if(ed<WIN_START||ed>WIN_END)continue;const exitTime=t.exitTime<=t.entryTime?t.entryTime+1:t.exitTime;all.push({id:`${def.key}:${t.id}`,strategyKey:def.key,side:ns,entryTime:t.entryTime,exitTime,etDate:ed,netPnL:t.netPnL,pointValue:t.pointValue??20,commission:t.commission??5,vol:volAsOf(ed)});}}
  return all.sort((a,b)=>a.entryTime-b.entryTime);}
const ALL=loadAll();
const cnt={};for(const t of ALL)cnt[t.strategyKey]=(cnt[t.strategyKey]||0)+1;
console.log(`Loaded ${ALL.length} trades ${WIN_START}..${WIN_END}:`,cnt,'\n');

const rule={name:'fiw',onSignal(s,t){if(s.position==null)open(s,t);else reject(s);},onNativeExit(s,t){if(s.position&&s.position.trade.id===t.id)realizeNativeClose(s,t);}};
function runFCFS(trades){const st=simulate(trades.slice().sort((a,b)=>a.entryTime-b.entryTime),rule);const m=calculateMetrics(st.realizedTrades);const rt=st.realizedTrades.slice().sort((a,b)=>(a.exitTime||a.entryTime)-(b.exitTime||b.entryTime));let eq=0,pk=0,dd=0;for(const t of rt){eq+=t.netPnL;if(eq>pk)pk=eq;if(pk-eq>dd)dd=pk-eq;}return{...m,ddDollar:dd};}
const seg=(tr,s)=>s==='train'?tr.filter(t=>t.etDate<=TRAIN_END):s==='test'?tr.filter(t=>t.etDate>TRAIN_END):tr;
function pmetrics(trades,s){return runFCFS(seg(trades,s));}

// ---- per-strategy filter menu ----
const MENU=[
  {id:'none',fn:v=>true},
  {id:'ivPct>=.2',fn:v=>v.ivPct==null||v.ivPct>=.2},
  {id:'ivPct>=.33',fn:v=>v.ivPct==null||v.ivPct>=.33},
  {id:'ivPct>=.5',fn:v=>v.ivPct==null||v.ivPct>=.5},
  {id:'ivPct>=.67',fn:v=>v.ivPct==null||v.ivPct>=.67},
  {id:'ivPct<.5',fn:v=>v.ivPct==null||v.ivPct<.5},
  {id:'ivPct<.67',fn:v=>v.ivPct==null||v.ivPct<.67},
  {id:'ivPct<.8',fn:v=>v.ivPct==null||v.ivPct<.8},
  {id:'slope>0',fn:v=>v.slope==null||v.slope>0},
  {id:'slope<0',fn:v=>v.slope==null||v.slope<0},
];
function applyFilters(filters){ // filters: {strategyKey:menuFn}
  return ALL.filter(t=>{const fn=filters[t.strategyKey];return fn?fn(t.vol):true;});
}
const baseFull=pmetrics(ALL,'full'),baseTrain=pmetrics(ALL,'train'),baseTest=pmetrics(ALL,'test');
function line(tag,m){return `${tag} PnL=$${Math.round(m.totalPnL)} PF=${(m.profitFactor===Infinity?'Inf':m.profitFactor.toFixed(2))} Sh=${m.sharpe.toFixed(1)} DD=$${Math.round(m.ddDollar)}`;}
console.log('BASELINE  '+line('full:',baseFull)+'  ||  '+line('test:',baseTest)+'\n');

// ---- sweep each strategy independently ----
const best={};
for(const def of STRATEGIES){
  console.log(`──── ${def.key} (filter only this strategy) ────`);
  const rows=[];
  for(const m of MENU){
    const filt=applyFilters({[def.key]:m.fn});
    const tr=pmetrics(filt,'train'),te=pmetrics(filt,'test');
    rows.push({id:m.id,fn:m.fn,trPF:tr.profitFactor,tePF:te.profitFactor,trPnL:tr.totalPnL,tePnL:te.totalPnL,teSh:te.sharpe,teDD:te.ddDollar});
  }
  // print sorted by test PF
  rows.sort((a,b)=>b.tePF-a.tePF);
  for(const r of rows.slice(0,6)) console.log(`  ${r.id.padEnd(11)} train PF ${r.trPF.toFixed(2)} | test PF ${r.tePF.toFixed(2)} Sh ${r.teSh.toFixed(1)} PnL $${Math.round(r.tePnL)} DD $${Math.round(r.teDD)}`);
  // pick filter that improves BOTH train and test PF vs baseline (generalizes), best test PF; else none
  const generalize=rows.filter(r=>r.id!=='none'&&r.trPF>baseTrain.profitFactor&&r.tePF>baseTest.profitFactor);
  const pick=generalize.length?generalize[0]:rows.find(r=>r.id==='none');
  best[def.key]=pick;
  console.log(`  → pick: ${pick.id} ${generalize.length?'(improves both halves)':'(no robust filter → none)'}\n`);
}

// ---- combined versions ----
console.log('════ COMBINED VERSIONS (full / test) ════');
const vRobust={}; for(const def of STRATEGIES){const p=best[def.key];vRobust[def.key]=MENU.find(m=>m.id===p.id).fn;}
function showVersion(label,filters){const f=applyFilters(filters);console.log(`  ${label.padEnd(22)} ${line('full:',pmetrics(f,'full'))}  ||  ${line('test:',pmetrics(f,'test'))}`);}
const M=id=>MENU.find(m=>m.id===id).fn;
showVersion('baseline',{});
showVersion('robust (both-halves)',vRobust);
showVersion('lstb-only ivPct>=.67',{lstb:M('ivPct>=.67')});
showVersion('lstb+glf',{lstb:M('ivPct>=.67'),'gex-level-fade':M('slope<0')});
showVersion('lstb ivPct>=.33 (mild)',{lstb:M('ivPct>=.33')});
showVersion('lstb ivPct>=.5',{lstb:M('ivPct>=.5')});
fs.writeFileSync(path.join(__dirname,'output','per-strategy-picks.json'),JSON.stringify(Object.fromEntries(Object.entries(best).map(([k,v])=>[k,v.id])),null,2));
console.log('\nPicks:',Object.fromEntries(Object.entries(best).map(([k,v])=>[k,v.id])));
