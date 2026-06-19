/**
 * Overnight ES — LT-LEVELS directional signal (Drew's idea, repaint-robust).
 *   "LT level below candle = bullish, LT level above candle = bearish."
 * The signal is the price-vs-level RELATIONSHIP, computed from actual price (no repaint) and the
 * LT levels (level_1..5). At overnight entry (18:00 ET) compare entry price P to the 5 LT levels:
 *   nBelow = #{Li < P}, nAbove = #{Li > P}. Price above the cluster → bullish → long.
 *
 * Price space: continuous candles + BACKADJUSTED LT levels (verified same space). PnL in $50/pt.
 * Same battery as 01: always-long control, long/short split, H1/H2 stability.
 *
 * Usage: node 02-lt-levels-es.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', '..', 'data');
const PV = 50, STOP_PTS = 100, EXIT_HOUR_ET = 2;

function isDST(ms){const d=new Date(ms),y=d.getUTCFullYear(),m=d.getUTCMonth();if(m>=3&&m<=9)return true;if(m===0||m===1||m===11)return false;if(m===2){const fd=new Date(Date.UTC(y,2,1)).getUTCDay();return ms>=Date.UTC(y,2,fd===0?8:15-fd,7);}if(m===10){const fd=new Date(Date.UTC(y,10,1)).getUTCDay();return ms<Date.UTC(y,10,fd===0?1:8-fd,6);}return false;}
const offH=ms=>isDST(ms)?4:5;
function etParts(ms){const e=ms-offH(ms)*3600000;const d=new Date(e);return{h:d.getUTCHours()+d.getUTCMinutes()/60,date:`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`};}

console.log('Loading ES continuous 1m...');
const candles=[];
{const lines=fs.readFileSync(path.join(DATA,'ohlcv/es/ES_ohlcv_1m_continuous.csv'),'utf8').split('\n');
 for(let i=1;i<lines.length;i++){const p=lines[i].split(',');if(p.length<6)continue;const ts=new Date(p[0].replace(' ','T')).getTime();if(isNaN(ts))continue;candles.push({ts,open:+p[1],high:+p[2],low:+p[3],close:+p[4]});}}
console.log(`  ${candles.length.toLocaleString()} candles`);

console.log('Loading ES LT levels (backadjusted)...');
const ltl=[];
{const lines=fs.readFileSync(path.join(DATA,'liquidity/es/ES_liquidity_levels_15m_backadjusted.csv'),'utf8').split('\n');
 for(let i=1;i<lines.length;i++){const p=lines[i].split(',');if(p.length<8)continue;const ts=+p[1];if(!ts)continue;const L=[+p[3],+p[4],+p[5],+p[6],+p[7]].filter(x=>x>0);if(L.length<3)continue;ltl.push({ts,L});}
 ltl.sort((a,b)=>a.ts-b.ts);}
console.log(`  ${ltl.length.toLocaleString()} LT-level rows\n`);
function levelsAsOf(ts){let lo=0,hi=ltl.length-1,r=null;while(lo<=hi){const m=(lo+hi)>>1;if(ltl[m].ts<=ts){r=ltl[m];lo=m+1;}else hi=m-1;}return r?r.L:null;}

// overnight sessions
const byDate={};for(const c of candles){const et=etParts(c.ts);(byDate[et.date]??=[]).push({...c,h:et.h});}
const dates=Object.keys(byDate).sort();
const sessions=[];
for(let i=0;i<dates.length-1;i++){const D=dates[i],N=dates[i+1];const dow=new Date(D+'T12:00:00Z').getUTCDay();if(dow===5||dow===6||dow===0)continue;
  const on=[...(byDate[D]||[]).filter(c=>c.h>=18),...(byDate[N]||[]).filter(c=>c.h<8)].sort((a,b)=>a.ts-b.ts);
  if(on.length<60)continue;sessions.push({date:D,on});}
console.log(`${sessions.length} overnight sessions\n`);

// direction from LT levels: mode = {k: minCountForSignal} or 'median'/'nearest'
function ltDirection(P,L,mode){
  if(mode==='median'){const s=[...L].sort((a,b)=>a-b);const med=s[Math.floor(s.length/2)];return P>med?1:P<med?-1:0;}
  if(mode==='nearest'){let nl=L[0],nd=Math.abs(P-L[0]);for(const x of L){const d=Math.abs(P-x);if(d<nd){nd=d;nl=x;}}return P>nl?1:-1;}
  const below=L.filter(x=>x<P).length,above=L.filter(x=>x>P).length;
  if(below>=mode)return 1; if(above>=mode)return -1; return 0;
}

function run(dirMode,startDate){
  const trades=[];
  for(const s of sessions){
    if(startDate&&s.date<startDate)continue;
    const cn=s.on,entry=cn[0].open;let side;
    if(dirMode==='long')side=1;
    else{const L=levelsAsOf(cn[0].ts);if(!L)continue;side=ltDirection(entry,L,dirMode);if(side===0)continue;}
    const stop=side>0?entry-STOP_PTS:entry+STOP_PTS;let exit=null;
    for(let j=1;j<cn.length;j++){const c=cn[j];if(c.h>=EXIT_HOUR_ET&&c.h<18){exit=c.open;break;}if(side>0&&c.low<=stop){exit=stop;break;}if(side<0&&c.high>=stop){exit=stop;break;}}
    if(exit==null)exit=cn[cn.length-1].close;
    const pts=side>0?exit-entry:entry-exit;trades.push({date:s.date,side,pts});
  }
  return trades;
}
function stats(t){const n=t.length;if(!n)return null;const w=t.filter(x=>x.pts>0);const tot=t.reduce((s,x)=>s+x.pts,0);
  const gw=w.reduce((s,x)=>s+x.pts,0),gl=-t.filter(x=>x.pts<=0).reduce((s,x)=>s+x.pts,0);
  const avg=tot/n,sd=Math.sqrt(t.reduce((s,x)=>s+(x.pts-avg)**2,0)/n);const sharpe=sd>0?avg/sd*Math.sqrt(252):0;
  let eq=0,pk=0,dd=0;for(const x of t){eq+=x.pts;if(eq>pk)pk=eq;if(pk-eq>dd)dd=pk-eq;}
  const L=t.filter(x=>x.side>0),S=t.filter(x=>x.side<0);
  return{n,wr:w.length/n,pf:gl>0?gw/gl:Infinity,tot$:tot*PV,sharpe,dd$:dd*PV,nL:L.length,nS:S.length,lP:L.reduce((s,x)=>s+x.pts,0)*PV,sP:S.reduce((s,x)=>s+x.pts,0)*PV};}
function row(l,st){if(!st){console.log(l.padEnd(22)+' (none)');return;}console.log(l.padEnd(22),String(st.n).padStart(4),(st.wr*100).toFixed(1).padStart(5),(st.pf===Infinity?'Inf':st.pf.toFixed(2)).padStart(6),String(Math.round(st.tot$)).padStart(9),st.sharpe.toFixed(2).padStart(6),String(Math.round(st.dd$)).padStart(8),`  L:${st.nL}/$${Math.round(st.lP)} S:${st.nS}/$${Math.round(st.sP)}`);}

console.log('config                  n    WR%    PF     tot$  Sharpe    maxDD$   long(n/$) short(n/$)');
console.log('-'.repeat(100));
row('always-long',stats(run('long')));
console.log('-- LT-levels direction (price vs level cluster) --');
row('all-5 (strict)',stats(run(5)));
row('>=4 below/above',stats(run(4)));
row('majority >=3',stats(run(3)));
row('median level',stats(run('median')));
row('nearest level',stats(run('nearest')));
console.log('\n-- H1/H2 stability (majority >=3) --');
const t3=run(3);const h=Math.floor(t3.length/2);row('maj>=3 H1',stats(t3.slice(0,h)));row('maj>=3 H2',stats(t3.slice(h)));
const t5=run(5);const h5=Math.floor(t5.length/2);row('all-5 H1',stats(t5.slice(0,h5)));row('all-5 H2',stats(t5.slice(h5)));
