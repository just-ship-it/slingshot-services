// CLEAN one-factor test: hold quotes (OPRA) + config fixed, swap ONLY the universe:
// full (all OPRA-quoted w/ OI) vs volume-gated (only strikes where Schwab volume>0). Isolates the VOLUME GATE.
import fs from 'fs';
import { computeGEX, parseOpraSym } from './engine.mjs';
const day=process.argv[2];
const cbbo=JSON.parse(fs.readFileSync(`research/gex-live-vs-backtest/opra-cbbo-${day}.json`,'utf8'));
const oi=new Map();for(const l of fs.readFileSync(`research/gex-live-vs-backtest/opra-oi-${day}.tsv`,'utf8').trim().split('\n')){const [s,v]=l.split('\t');oi.set(s.trim(),+v);}
const B=JSON.parse(fs.readFileSync(`data/gex/nq-cbbo/nq_gex_${day}.json`,'utf8')).data;
const swDir=`data/schwab-snapshots/${day}`;
const swFiles=fs.readdirSync(swDir).filter(f=>f.startsWith('snapshot_')).sort();
const swSnaps=swFiles.map(f=>{const s=JSON.parse(fs.readFileSync(swDir+'/'+f));return {t:new Date(s.timestamp).getTime(),qqq:s.chains.QQQ||[]};});
const nearest=ts=>{let b=null,bd=Infinity;for(const s of swSnaps){const d=Math.abs(s.t-ts);if(s.t<=ts+90000&&d<bd){bd=d;b=s;}}return b;};
function swVol(qqq){const m=new Map();for(const c of qqq)for(const o of c.options||[]){const exp=new Date(o.expiration_date+'T16:00:00').getTime();const t=o.option_type==='call'?'C':'P';m.set(`${o.strike}|${t}|${exp}`,o.volume||0);}return m;}
const cfg=(spot,refMs)=>({r:0.05,q:0,tteFloorYr:0.001,ivMode:'live',spot,refDateMs:refMs,selection:'gex',wall:'gex'});
const med=a=>{a=a.filter(x=>x!=null).sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]:null;};
const s4=[],cw=[],pw=[],supOv=[],droppedPct=[]; let n=0;
for(const b of B){
  const key=new Date(b.timestamp).toISOString(); const q=cbbo[key]; if(!q)continue;
  const sw=nearest(new Date(b.timestamp).getTime()); if(!sw)continue;
  const vol=swVol(sw.qqq); const spot=b.qqq_spot, refMs=new Date(b.timestamp).getTime();
  const full=[],gated=[]; let drop=0,tot=0;
  for(const [sym,ba] of Object.entries(q)){const p=parseOpraSym(sym);if(!p)continue;const o=oi.get(sym.trim())||0;if(!o)continue;const mid=(ba[0]+ba[1])/2;const c={strike:p.strike,type:p.type,expMs:p.expMs,oi:o,mid};full.push(c);tot++;const v=vol.get(`${p.strike}|${p.type}|${p.expMs}`);if(v>0)gated.push(c);else drop++;}
  if(!gated.length)continue; n++;
  const rF=computeGEX(full,cfg(spot,refMs)), rG=computeGEX(gated,cfg(spot,refMs));
  if(rF.support[3]!=null&&rG.support[3]!=null)s4.push(Math.abs(rF.support[3]-rG.support[3]));
  if(rF.callWall!=null&&rG.callWall!=null)cw.push(Math.abs(rF.callWall-rG.callWall));
  if(rF.putWall!=null&&rG.putWall!=null)pw.push(Math.abs(rF.putWall-rG.putWall));
  supOv.push(rF.support.slice(0,5).filter(x=>rG.support.includes(x)).length);
  droppedPct.push(Math.round(100*drop/tot));
}
console.log(JSON.stringify({day,n,pctContractsDroppedByVolGate:med(droppedPct),med_callWallDiff:med(cw),med_putWallDiff:med(pw),med_S4Diff_volGate_QQQ:med(s4),med_supOverlap_of5:med(supOv)}));
