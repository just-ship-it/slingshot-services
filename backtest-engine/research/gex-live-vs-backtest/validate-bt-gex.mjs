import fs from 'fs';
import { computeGEX, parseOpraSym } from './engine.mjs';
const day='2026-05-08';
const cbbo=JSON.parse(fs.readFileSync(`research/gex-live-vs-backtest/opra-cbbo-${day}.json`,'utf8'));
const oi=new Map(); for(const l of fs.readFileSync(`research/gex-live-vs-backtest/opra-oi-${day}.tsv`,'utf8').trim().split('\n')){const [s,v]=l.split('\t');oi.set(s.trim(),+v);}
const B=JSON.parse(fs.readFileSync(`data/gex/nq-cbbo/nq_gex_${day}.json`,'utf8')).data;
const btcfg=t=>({r:0.05,q:0.01,tteFloorYr:2.5/(24*365.25),ivMode:'bt',spot:t.spot,refDateMs:t.refMs,selection:"gex",wall:"gex"});
let n=0,cwOK=0,pwOK=0,supOK=0;
for(const b of B){
  const iso=b.timestamp.replace('+00:00','.000Z'); // match cbbo key format? cbbo keys are toISOString
  const key=new Date(b.timestamp).toISOString();
  const quotes=cbbo[key]; if(!quotes) continue;
  const spot=b.qqq_spot, mult=b.multiplier, refMs=new Date(b.timestamp).getTime();
  const contracts=[];
  for(const [sym,ba] of Object.entries(quotes)){ const p=parseOpraSym(sym); if(!p)continue; const o=oi.get(sym.trim())||0; if(!o)continue; contracts.push({strike:p.strike,type:p.type,expMs:p.expMs,oi:o,mid:(ba[0]+ba[1])/2}); }
  const r=computeGEX(contracts, btcfg({spot,refMs}));
  n++;
  const bCall=Math.round(b.call_wall/mult), bPut=Math.round(b.put_wall/mult);
  const bSup=(b.support||[]).map(x=>Math.round(x/mult));
  if(r.callWall!=null&&Math.abs(r.callWall-bCall)<=1)cwOK++;
  if(r.putWall!=null&&Math.abs(r.putWall-bPut)<=1)pwOK++;
  if(r.support.length&&bSup.length&&r.support.slice(0,5).every((x,i)=>bSup[i]!=null&&Math.abs(x-bSup[i])<=1))supOK++;
  if(n<=3) console.log(`  ${b.timestamp.slice(11,16)} engineBT: cw=${r.callWall} pw=${r.putWall} sup=[${r.support}]  |  nq-cbbo: cw=${bCall} pw=${bPut} sup=[${bSup}]`);
}
console.log(JSON.stringify({day,n,callWall_reproduced:`${cwOK}/${n}`,putWall_reproduced:`${pwOK}/${n}`,support_reproduced:`${supOK}/${n}`}));
