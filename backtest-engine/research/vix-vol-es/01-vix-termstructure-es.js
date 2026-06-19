/**
 * VIX / vol term-structure → ES daily timing signal (cross-asset/vol arm of deep-research).
 *
 * Datasets (all daily):
 *   - VIX index (30-day constant maturity)            iv/vix/VIX_History.csv
 *   - SPY ATM IV 0/1/2-DTE + skew + term_slope        iv/spy/spy_short_dte_iv_daily.csv
 *   - ES realized vol (computed from ES daily returns)
 *
 * Term structure = SPY short-DTE ATM IV (front) vs VIX/100 (30d back).
 *   ratio = shortIV / (VIX/100).  <1 = contango/calm (risk-on),  >1 = backwardation/stress (risk-off).
 * Documented edge: contango predicts positive equity returns; backwardation predicts weak/negative.
 *
 * Signal from day D-1 CLOSE → position for day D (close-to-close hold). No lookahead.
 * CONTROL: always-long (buy-and-hold). Any edge must beat it on risk-adjusted terms. ES $50/pt.
 *
 * Usage: node 01-vix-termstructure-es.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', '..', 'data');
const PV = 50;

function isDST(ms){const d=new Date(ms),y=d.getUTCFullYear(),m=d.getUTCMonth();if(m>=3&&m<=9)return true;if(m===0||m===1||m===11)return false;if(m===2){const fd=new Date(Date.UTC(y,2,1)).getUTCDay();return ms>=Date.UTC(y,2,fd===0?8:15-fd,7);}if(m===10){const fd=new Date(Date.UTC(y,10,1)).getUTCDay();return ms<Date.UTC(y,10,fd===0?1:8-fd,6);}return false;}
const offH=ms=>isDST(ms)?4:5;
function etParts(ms){const e=ms-offH(ms)*3600000;const d=new Date(e);return{h:d.getUTCHours()+d.getUTCMinutes()/60,date:`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`};}

// ---- ES daily RTH close (continuous) ----
console.log('Loading ES continuous 1m → daily RTH closes...');
const esClose={}; // date → last RTH(<=16:00) close
{const lines=fs.readFileSync(path.join(DATA,'ohlcv/es/ES_ohlcv_1m_continuous.csv'),'utf8').split('\n');
 for(let i=1;i<lines.length;i++){const p=lines[i].split(',');if(p.length<6)continue;const ts=new Date(p[0].replace(' ','T')).getTime();if(isNaN(ts))continue;const et=etParts(ts);if(et.h>=9.5&&et.h<16)esClose[et.date]=+p[4];}}
const esDates=Object.keys(esClose).sort();
console.log(`  ${esDates.length} ES RTH days (${esDates[0]}→${esDates[esDates.length-1]})`);

// ---- VIX daily close ----
const vix={};
{for(const r of fs.readFileSync(path.join(DATA,'iv/vix/VIX_History.csv'),'utf8').split('\n')){const p=r.split(',');if(p.length<5||!/^\d/.test(p[0]))continue;const[mm,dd,yy]=p[0].split('/');vix[`${yy}-${mm}-${dd}`]=+p[4];}}
console.log(`  ${Object.keys(vix).length} VIX days`);

// ---- SPY short-DTE ATM IV ----
const spy={};
{const lines=fs.readFileSync(path.join(DATA,'iv/spy/spy_short_dte_iv_daily.csv'),'utf8').split('\n');const H=lines[0].split(',');
 const ix=n=>H.indexOf(n);
 for(let i=1;i<lines.length;i++){const p=lines[i].split(',');if(p.length<H.length)continue;spy[p[0]]={dte0:+p[ix('dte0_avg_iv')],dte1:+p[ix('dte1_avg_iv')],dte2:+p[ix('dte2_avg_iv')],slope:+p[ix('term_slope')],skew0:+p[ix('dte0_skew')]};}}
console.log(`  ${Object.keys(spy).length} SPY-IV days\n`);

// ---- build aligned daily series with prior-day signals ----
// realized vol: trailing 10-day annualized from ES daily log returns
const rows=[]; // {date, esRet(pts), retNext...}; we attach D-1 signals
for(let i=1;i<esDates.length;i++){
  const d=esDates[i],pd=esDates[i-1];
  const ret=esClose[d]-esClose[pd]; // close-to-close points for day d
  rows.push({date:d,prev:pd,ret,c:esClose[d],pc:esClose[pd]});
}
// trailing realized vol (annualized, decimal) as of each prev day
for(let i=0;i<rows.length;i++){
  const win=[];for(let k=Math.max(0,i-10);k<i;k++){const r=rows[k];if(r.pc>0)win.push(Math.log(r.c/r.pc));}
  const mean=win.reduce((s,v)=>s+v,0)/(win.length||1);
  const sd=Math.sqrt(win.reduce((s,v)=>s+(v-mean)**2,0)/(win.length||1));
  rows[i].rvPrev=sd*Math.sqrt(252); // realized vol as of prev close
}

// ---- signal → position for each day (uses PREV day data only) ----
function position(r,sig){
  const pd=r.prev;const v=vix[pd],s=spy[pd];
  if(sig==='long')return 1;
  if(sig.startsWith('vixlvl')){if(v==null)return null;const th=+sig.split(':')[1];return v<th?1:0;} // long when calm
  if(sig.startsWith('ts')){ // term structure: short-DTE vs VIX
    if(v==null||!s)return null;const leg=sig.split(':')[1];const shortIV=s[leg];if(!(shortIV>0))return null;
    const ratio=shortIV/(v/100);
    // contango (ratio<1) risk-on long; backwardation (ratio>1) risk-off
    const mode=sig.split(':')[2]||'flat';
    if(ratio<1)return 1; return mode==='short'?-1:0;
  }
  if(sig.startsWith('slope')){if(!s)return null;const mode=sig.split(':')[1];// term_slope sign
    return s.slope>0?1:(mode==='short'?-1:0);}
  if(sig.startsWith('vrp')){if(v==null||r.rvPrev==null)return null;const k=+sig.split(':')[1];return (v/100)>k*r.rvPrev?1:0;} // long when implied richly above realized
  return null;
}
function run(sig,startDate){
  const tr=[];
  for(const r of rows){if(startDate&&r.date<startDate)continue;const pos=position(r,sig);if(pos==null)continue;tr.push({date:r.date,pos,pnl:pos*r.ret*PV});}
  return tr;
}
function stats(tr){const n=tr.length;if(!n)return null;const act=tr.filter(t=>t.pos!==0);const w=act.filter(t=>t.pnl>0);
  const tot=tr.reduce((s,t)=>s+t.pnl,0);const dvals=tr.map(t=>t.pnl);const mean=dvals.reduce((s,v)=>s+v,0)/n;
  const sd=Math.sqrt(dvals.reduce((s,v)=>s+(v-mean)**2,0)/n);const sharpe=sd>0?mean/sd*Math.sqrt(252):0;
  const gw=w.reduce((s,t)=>s+t.pnl,0),gl=-act.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0);
  let eq=0,pk=0,dd=0;for(const t of tr){eq+=t.pnl;if(eq>pk)pk=eq;if(pk-eq>dd)dd=pk-eq;}
  const nLong=tr.filter(t=>t.pos>0).length,nFlat=tr.filter(t=>t.pos===0).length,nShort=tr.filter(t=>t.pos<0).length;
  return{n,nAct:act.length,wr:act.length?w.length/act.length:0,pf:gl>0?gw/gl:Infinity,tot$:tot,sharpe,dd$:dd,nLong,nFlat,nShort};}
function row(l,st){if(!st){console.log(l.padEnd(24)+' (none)');return;}console.log(l.padEnd(24),String(st.n).padStart(4),(st.wr*100).toFixed(1).padStart(5),(st.pf===Infinity?'Inf':st.pf.toFixed(2)).padStart(6),String(Math.round(st.tot$)).padStart(9),st.sharpe.toFixed(2).padStart(6),String(Math.round(st.dd$)).padStart(8),`  L/F/S:${st.nLong}/${st.nFlat}/${st.nShort}`);}

const GS='2023-03-28'; // SPY-IV start
console.log('config                    n    WR%    PF     tot$  Sharpe    maxDD$    long/flat/short');
console.log('-'.repeat(96));
console.log('-- CONTROL --');
row('always-long [23-26]',stats(run('long',GS)));
row('always-long [21-26]',stats(run('long')));
console.log('-- VIX level regime --');
for(const th of [18,20,25]) row(`vix<${th} long`,stats(run(`vixlvl:${th}`,GS)));
console.log('-- term structure (SPY shortIV vs VIX/100) --');
for(const leg of ['dte0','dte1','dte2']) row(`ts ${leg} (contango=long)`,stats(run(`ts:${leg}:flat`,GS)));
for(const leg of ['dte1','dte2']) row(`ts ${leg} +short`,stats(run(`ts:${leg}:short`,GS)));
console.log('-- SPY term_slope sign --');
row('slope>0 long',stats(run('slope:flat',GS)));
row('slope +short',stats(run('slope:short',GS)));
console.log('-- VRP (VIX vs ES realized) --');
for(const k of [1.0,1.2,1.5]) row(`vrp VIX>${k}xRV`,stats(run(`vrp:${k}`,GS)));

console.log('\n-- H1/H2 stability (best variants vs control) --');
for(const sig of ['long','ts:dte0:flat','vixlvl:25','vrp:1.2']){const tr=run(sig,GS);const h=Math.floor(tr.length/2);row(`${sig} H1`,stats(tr.slice(0,h)));row(`${sig} H2`,stats(tr.slice(h)));}
