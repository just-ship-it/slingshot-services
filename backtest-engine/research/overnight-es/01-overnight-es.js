/**
 * Overnight ES — directional isolation + repaint-robustness battery.
 *
 * Strategy concept (from overnight-composite research, NQ): hold overnight in the LT-sentiment
 * direction, confirmed by GEX regime, exit ~2am ET. Prior NQ result (77% WR / PF 7.3) was never
 * controlled for overnight DRIFT and used possibly-repainted EOD sentiment. This re-validates on ES
 * with the two checks that matter:
 *   (A) CONTROL: always-long / always-short overnight = the pure overnight risk premium. Any LT/GEX
 *       edge must BEAT always-long, and that can only come from the SHORT side (bearish nights
 *       actually falling) or skipping bad long nights.
 *   (B) REPAINT PROBE: pick LT sentiment as-of progressively earlier times (eod→noon→open→prevclose).
 *       A real causal edge survives a sane lag; a repaint-lookahead edge decays as you lag it.
 *
 * Entry: overnight open (first bar >=18:00 ET). Exit: 2am ET (or stop). 1 contract, ES $50/pt.
 * Uses ES continuous 1m (LT/GEX used as LABELS not price levels → continuous is the CLAUDE.md-
 * sanctioned choice for pure price-action; avoids roll-gap contamination in the overnight PnL).
 *
 * Usage: node 01-overnight-es.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', '..', 'data');
const PV = 50, STOP_PTS = 100, EXIT_HOUR_ET = 2;

// ---- ET (DST-aware) ----
function isDST(ms){const d=new Date(ms),y=d.getUTCFullYear(),m=d.getUTCMonth();if(m>=3&&m<=9)return true;if(m===0||m===1||m===11)return false;if(m===2){const fd=new Date(Date.UTC(y,2,1)).getUTCDay();return ms>=Date.UTC(y,2,fd===0?8:15-fd,7);}if(m===10){const fd=new Date(Date.UTC(y,10,1)).getUTCDay();return ms<Date.UTC(y,10,fd===0?1:8-fd,6);}return false;}
const offH = ms => isDST(ms) ? 4 : 5;
function etParts(ms){const e=ms-offH(ms)*3600000;const d=new Date(e);return{h:d.getUTCHours()+d.getUTCMinutes()/60,date:`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`,dow:d.getUTCDay()};}
function etToUtc(dateStr,hourET){const noon=new Date(dateStr+'T12:00:00Z').getTime();const off=isDST(noon)?4:5;const[y,m,d]=dateStr.split('-').map(Number);return Date.UTC(y,m-1,d,Math.floor(hourET)+off,(hourET%1)*60);}

// ---- load ES continuous 1m ----
console.log('Loading ES continuous 1m...');
const candles=[];
{
  const lines=fs.readFileSync(path.join(DATA,'ohlcv/es/ES_ohlcv_1m_continuous.csv'),'utf8').split('\n');
  for(let i=1;i<lines.length;i++){const p=lines[i].split(',');if(p.length<6)continue;const ts=new Date(p[0].replace(' ','T')).getTime();if(isNaN(ts))continue;candles.push({ts,open:+p[1],high:+p[2],low:+p[3],close:+p[4]});}
}
console.log(`  ${candles.length.toLocaleString()} candles`);

// ---- load ES LT (sorted [ts, sentiment]) ----
console.log('Loading ES LT...');
const lt=[];
{
  const lines=fs.readFileSync(path.join(DATA,'liquidity/es/ES_liquidity_levels_15m.csv'),'utf8').split('\n');
  for(let i=1;i<lines.length;i++){const p=lines[i].split(',');if(p.length<3)continue;const ts=+p[1];if(!ts)continue;lt.push({ts,s:p[2]});}
  lt.sort((a,b)=>a.ts-b.ts);
}
console.log(`  ${lt.length.toLocaleString()} LT rows (${lt[0]?new Date(lt[0].ts).toISOString().slice(0,10):''}→${lt.length?new Date(lt[lt.length-1].ts).toISOString().slice(0,10):''})`);
function sentimentAsOf(tsUtc){ // last LT row <= tsUtc (binary search)
  let lo=0,hi=lt.length-1,res=null;
  while(lo<=hi){const mid=(lo+hi)>>1;if(lt[mid].ts<=tsUtc){res=lt[mid];lo=mid+1;}else hi=mid-1;}
  return res?res.s:null;
}

// ---- load ES GEX (date → EOD regime) ----
console.log('Loading ES GEX...');
const gex={};
{
  const dir=path.join(DATA,'gex/es');
  for(const f of fs.readdirSync(dir).filter(f=>f.startsWith('es_gex_')&&f.endsWith('.json'))){
    try{const d=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));if(!d.metadata?.date||!d.data?.length)continue;
      // regime sampled at morning(~09:30ET), midday(~12:00ET), eod(last). snapshot ts are ISO w/ +00:00.
      const snaps=d.data.map(x=>({et:etParts(new Date(x.timestamp).getTime()).h,r:x.regime}));
      const at=(h)=>{let best=null;for(const s of snaps){if(s.et<=h)best=s.r;}return best||d.data[d.data.length-1].regime;};
      gex[d.metadata.date]={morning:at(9.5),midday:at(12),eod:d.data[d.data.length-1].regime};
    }catch(e){}
  }
}
console.log(`  ${Object.keys(gex).length} GEX dates\n`);

// ---- build overnight sessions ----
const byDate={};
for(const c of candles){const et=etParts(c.ts);(byDate[et.date]??=[]).push({...c,h:et.h});}
const dates=Object.keys(byDate).sort();
const sessions=[];
for(let i=0;i<dates.length-1;i++){
  const D=dates[i],N=dates[i+1];
  const dEt=etParts(new Date(D+'T16:00:00Z').getTime()-offH(new Date(D+'T16:00:00Z').getTime())*0); // dow via D
  const dow=new Date(D+'T12:00:00Z').getUTCDay();
  if(dow===5||dow===6||dow===0)continue; // skip Fri(5)/Sat/Sun overnight starts
  const today=byDate[D]||[],nxt=byDate[N]||[];
  const on=[...today.filter(c=>c.h>=18),...nxt.filter(c=>c.h<8)].sort((a,b)=>a.ts-b.ts);
  if(on.length<60)continue;
  sessions.push({date:D,dow,on});
}
console.log(`${sessions.length} overnight sessions (${sessions[0]?.date}→${sessions[sessions.length-1]?.date})\n`);

// ---- run one config ----
// dirMode: 'long'|'short'|{lt:'eod'|'noon'|'open'|'prevclose', gex:bool}
function run(dirMode,startDate){
  const trades=[];
  for(const s of sessions){
    if(startDate&&s.date<startDate)continue;
    let side; // +1 long / -1 short / 0 skip
    if(dirMode==='long')side=1;
    else if(dirMode==='short')side=-1;
    else if(dirMode.gexdir){const g=gex[s.date];if(!g)continue;const reg=g[dirMode.gexdir];if(!reg)continue;
      if(dirMode.strong){if(reg==='strong_positive')side=1;else if(reg==='strong_negative')side=-1;else continue;}
      else{if(reg.includes('positive'))side=1;else if(reg.includes('negative'))side=-1;else continue;}}
    else{
      const tH={eod:16,noon:12,open:9.75,prevclose:-8}[dirMode.lt]; // prevclose = prev day 16:00 = -8h from D 00:00 ≈ use D-? ; handle below
      let sentTs;
      if(dirMode.lt==='prevclose'){const pi=dates.indexOf(s.date)-1;const pd=pi>=0?dates[pi]:s.date;sentTs=etToUtc(pd,16);}
      else sentTs=etToUtc(s.date,tH);
      const sent=sentimentAsOf(sentTs);
      if(!sent)continue;
      side=sent==='BULLISH'?1:-1;
      if(dirMode.gex){const g=gex[s.date];if(!g)continue;const reg=g.eod;const pos=reg.includes('positive'),neg=reg.includes('negative');if(side>0&&!pos)continue;if(side<0&&!neg)continue;}
    }
    const cn=s.on,entry=cn[0].open,stop=side>0?entry-STOP_PTS:entry+STOP_PTS;
    let exit=null,reason=null;
    for(let j=1;j<cn.length;j++){const c=cn[j];
      if(c.h>=EXIT_HOUR_ET&&c.h<18){exit=c.open;reason='time';break;}
      if(side>0&&c.low<=stop){exit=stop;reason='stop';break;}
      if(side<0&&c.high>=stop){exit=stop;reason='stop';break;}
    }
    if(exit==null){exit=cn[cn.length-1].close;reason='end';}
    const pnlPts=side>0?exit-entry:entry-exit;
    trades.push({date:s.date,side,pnlPts,pnl$:pnlPts*PV,reason});
  }
  return trades;
}

function stats(trades){
  const n=trades.length;if(!n)return null;
  const w=trades.filter(t=>t.pnlPts>0);
  const tot=trades.reduce((s,t)=>s+t.pnlPts,0);
  const gw=w.reduce((s,t)=>s+t.pnlPts,0),gl=-trades.filter(t=>t.pnlPts<=0).reduce((s,t)=>s+t.pnlPts,0);
  const avg=tot/n,sd=Math.sqrt(trades.reduce((s,t)=>s+(t.pnlPts-avg)**2,0)/n);
  // daily-ish Sharpe: ~1 trade/night, annualize by sqrt(252)
  const sharpe=sd>0?avg/sd*Math.sqrt(252):0;
  let eq=0,pk=0,dd=0;for(const t of trades){eq+=t.pnlPts;if(eq>pk)pk=eq;if(pk-eq>dd)dd=pk-eq;}
  const longs=trades.filter(t=>t.side>0),shorts=trades.filter(t=>t.side<0);
  return{n,wr:w.length/n,pf:gl>0?gw/gl:Infinity,totPts:tot,tot$:tot*PV,sharpe,ddPts:dd,dd$:dd*PV,
    nL:longs.length,nS:shorts.length,lPts:longs.reduce((s,t)=>s+t.pnlPts,0),sPts:shorts.reduce((s,t)=>s+t.pnlPts,0)};
}
function row(label,st){if(!st){console.log(label.padEnd(26)+'  (no trades)');return;}
  console.log(label.padEnd(26),String(st.n).padStart(4),(st.wr*100).toFixed(1).padStart(5),
    (st.pf===Infinity?'Inf':st.pf.toFixed(2)).padStart(6),String(Math.round(st.tot$)).padStart(9),
    st.sharpe.toFixed(2).padStart(6),String(Math.round(st.dd$)).padStart(8),
    `  L:${Math.round(st.lPts*PV)} S:${Math.round(st.sPts*PV)}`);
}

console.log('config                       n    WR%    PF     tot$  Sharpe    maxDD$   long$/short$');
console.log('-'.repeat(96));
console.log('-- CONTROLS (pure overnight drift) --');
row('always-long',stats(run('long')));
row('always-short',stats(run('short')));
console.log('-- LT-directed (repaint-lag probe) --');
for(const t of ['eod','noon','open','prevclose']) row(`LT@${t}`,stats(run({lt:t,gex:false})));
console.log('-- GEX-period matched controls + GEX-only direction (2023-03+) --');
const GS='2023-03-28';
row('always-long [23-26]',stats(run('long',GS)));
console.log('-- GEX-regime direction, lookahead-lag probe (sample regime at...) --');
for(const t of ['eod','midday','morning']) row(`GEXdir@${t}`,stats(run({gexdir:t},GS)));
console.log('-- LT + GEX confirm (2023-03+) --');
for(const t of ['eod','noon']) row(`LT@${t}+GEX`,stats(run({lt:t,gex:true},GS)));

// H1/H2 stability of the GEXdir@morning (most lookahead-safe) and @eod
console.log('\n-- H1/H2 stability (GEX-regime direction) --');
const gexTrades=run({gexdir:'morning'},GS);
const mid=gexTrades.length>0?gexTrades[Math.floor(gexTrades.length/2)].date:null;
for(const samp of ['morning','eod']){
  const tr=run({gexdir:samp},GS);
  const h=Math.floor(tr.length/2);
  row(`GEXdir@${samp} H1`,stats(tr.slice(0,h)));
  row(`GEXdir@${samp} H2`,stats(tr.slice(h)));
}
console.log('-- strong-regime only --');
for(const samp of ['eod','morning']){const tr=run({gexdir:samp,strong:true},GS);const h=Math.floor(tr.length/2);
  row(`GEXdir-strong@${samp}`,stats(tr));row(`  H1`,stats(tr.slice(0,h)));row(`  H2`,stats(tr.slice(h)));}

// save the eod LT-directed trades for inspection
fs.mkdirSync(path.join(__dirname,'output'),{recursive:true});
fs.writeFileSync(path.join(__dirname,'output','lt-eod-trades.json'),JSON.stringify(run({lt:'eod',gex:false}),null,2));
