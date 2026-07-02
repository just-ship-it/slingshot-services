// CLEAN one-factor test: hold EVERYTHING fixed (universe, OI, div, tte, ivMode, selection),
// swap ONLY the quote source (Schwab mid vs OPRA cbbo mid). Isolates the quote effect on levels.
import fs from 'fs';
import { computeGEX, parseOpraSym } from './engine.mjs';
const day=process.argv[2];
const cbbo=JSON.parse(fs.readFileSync(`research/gex-live-vs-backtest/opra-cbbo-${day}.json`,'utf8'));
const B=JSON.parse(fs.readFileSync(`data/gex/nq-cbbo/nq_gex_${day}.json`,'utf8')).data;
const swDir=`data/schwab-snapshots/${day}`;
const swFiles=fs.readdirSync(swDir).filter(f=>f.startsWith('snapshot_')).sort();
const swSnaps=swFiles.map(f=>{const s=JSON.parse(fs.readFileSync(swDir+'/'+f));return {t:new Date(s.timestamp).getTime(),qqq:s.chains.QQQ||[]};});
const nearest=ts=>{let b=null,bd=Infinity;for(const s of swSnaps){const d=Math.abs(s.t-ts);if(s.t<=ts+90000&&d<bd){bd=d;b=s;}}return b;};
// build schwab per-(strike,type,exp) mid+oi
function swMap(qqq){const m=new Map();for(const c of qqq)for(const o of c.options||[]){if(!o.open_interest)continue;const mid=(o.bid>0&&o.ask>0)?(o.bid+o.ask)/2:(o.ask>0?o.ask:o.bid);const exp=new Date(o.expiration_date+'T16:00:00').getTime();const t=o.option_type==='call'?'C':'P';m.set(`${o.strike}|${t}|${exp}`,{mid,oi:o.open_interest,strike:o.strike,type:t,expMs:exp});}return m;}
const cfg=(spot,refMs)=>({r:0.05,q:0,tteFloorYr:0.001,ivMode:'live',spot,refDateMs:refMs,selection:'gex',wall:'gex'});
const s4diff=[],ladderExact=[],cwdiff=[],pwdiff=[]; let n=0;
for(const b of B){
  const key=new Date(b.timestamp).toISOString(); const q=cbbo[key]; if(!q)continue;
  const sw=nearest(new Date(b.timestamp).getTime()); if(!sw)continue;
  const sm=swMap(sw.qqq); const spot=b.qqq_spot, refMs=new Date(b.timestamp).getTime();
  // intersection universe
  const schwabC=[],opraC=[];
  for(const [sym,ba] of Object.entries(q)){const p=parseOpraSym(sym);if(!p)continue;const k=`${p.strike}|${p.type}|${p.expMs}`;const s=sm.get(k);if(!s)continue;const om=(ba[0]+ba[1])/2;schwabC.push({strike:p.strike,type:p.type,expMs:p.expMs,oi:s.oi,mid:s.mid});opraC.push({strike:p.strike,type:p.type,expMs:p.expMs,oi:s.oi,mid:om});}
  if(!schwabC.length)continue; n++;
  const rS=computeGEX(schwabC,cfg(spot,refMs)); const rO=computeGEX(opraC,cfg(spot,refMs));
  if(rS.support[3]!=null&&rO.support[3]!=null)s4diff.push(Math.abs(rS.support[3]-rO.support[3]));
  ladderExact.push(rS.support.slice(0,5).every((x,i)=>rO.support[i]===x)?1:0);
  if(rS.callWall!=null&&rO.callWall!=null)cwdiff.push(Math.abs(rS.callWall-rO.callWall));
  if(rS.putWall!=null&&rO.putWall!=null)pwdiff.push(Math.abs(rS.putWall-rO.putWall));
}
const med=a=>{a=a.filter(x=>x!=null).sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]:null;};
console.log(JSON.stringify({day,n,med_callWallDiff_quotesOnly:med(cwdiff),med_putWallDiff_quotesOnly:med(pwdiff),med_S4Diff_quotesOnly_QQQ:med(s4diff),ladderExactMatch:`${ladderExact.filter(x=>x).length}/${n}`}));
