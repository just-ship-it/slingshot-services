// Ablation: is the support-ladder divergence caused by the SELECTION METHOD?
// Take live's OWN exposuresByStrike (real calc), rank the support ladder two ways:
//   (1) GEX-ranked  (live's actual method)
//   (2) OI-weighted putOI + |gex|/1e6  (backtest generate-cbbo-gex.js method)
// Compare each to B's ladder. If (2)-on-live-GEX matches B, selection method is THE driver.
import fs from 'fs';
import ExposureCalculator from '../../../signal-generator/src/tradier/exposure-calculator.js';

const day = process.argv[2];
const B = JSON.parse(fs.readFileSync(new URL(`../../data/gex/nq-cbbo/nq_gex_${day}.json`, import.meta.url),'utf8')).data;
const dir = new URL(`../../data/schwab-snapshots/${day}/`, import.meta.url);
const swFiles = fs.readdirSync(dir).filter(f=>f.startsWith('snapshot_')).sort();
const swSnaps = swFiles.map(f=>{const s=JSON.parse(fs.readFileSync(new URL(f,dir),'utf8'));return {t:new Date(s.timestamp).getTime(),chains:s.chains.QQQ||[]};});
const calc = new ExposureCalculator({ riskFreeRate: 0.05, excludeZeroDTE:false });
const nearest=ts=>{let b=null,bd=Infinity;for(const s of swSnaps){const d=Math.abs(s.t-ts);if(s.t<=ts+90000&&d<bd){bd=d;b=s;}}return b;};

function gexRanked(byStrike, spot){ // live method
  return Array.from(Object.entries(byStrike)).map(([k,v])=>[+k,v]).filter(([k,v])=>k<spot&&v.gex<0)
    .sort((a,b)=>a[1].gex-b[1].gex).slice(0,5).map(([k])=>Math.round(k));
}
function oiWeighted(byStrike, spot){ // backtest method
  return Array.from(Object.entries(byStrike)).map(([k,v])=>[+k,v]).filter(([k])=>+k<spot)
    .map(([k,v])=>({k:+k,score:v.putOI+Math.abs(v.gex)/1e6})).sort((a,b)=>b.score-a.score).slice(0,5).map(o=>Math.round(o.k));
}
const eq=(a,b)=>a.length&&b.length&&a.every((x,i)=>Math.abs(x-Math.round(b[i]))<=1);
const s4eq=(a,b)=>a[3]!=null&&b[3]!=null&&Math.abs(a[3]-Math.round(b[3]))<=1;

let n=0, gexMatchesB=0, oiMatchesB=0, s4_gex=0, s4_oi=0;
for(const b of B){
  const sw=nearest(new Date(b.timestamp).getTime()); if(!sw) continue;
  const spot=b.qqq_spot, mult=b.multiplier;
  const res=calc.calculateExposures({QQQ:sw.chains},{QQQ:spot},{asOf:new Date(b.timestamp)});
  const byStrike=res.QQQ.exposuresByStrike;
  const bSup=(b.support||[]).map(x=>x/mult); // QQQ space
  const lgex=gexRanked(byStrike,spot);   // live-actual
  const loi=oiWeighted(byStrike,spot);   // backtest-method on live GEX
  n++;
  if(eq(lgex,bSup)) gexMatchesB++;
  if(eq(loi,bSup)) oiMatchesB++;
  if(s4eq(lgex,bSup)) s4_gex++;
  if(s4eq(loi,bSup)) s4_oi++;
}
console.log(JSON.stringify({day,n,
  liveGEXladder_matches_B: `${gexMatchesB}/${n}`,
  OIweighted_on_liveGEX_matches_B: `${oiMatchesB}/${n}`,
  S4_liveGEX_matches_B: `${s4_gex}/${n}`,
  S4_OIweighted_matches_B: `${s4_oi}/${n}`}));
