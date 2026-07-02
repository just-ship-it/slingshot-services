// Cheap test: does the VOLUME GATE (live drops volume==0) drive the support-ladder gap?
// Rank put strikes below spot by total putOI, full-universe vs volume-gated, compare to B.
import fs from 'fs';
const day = process.argv[2];
const B = JSON.parse(fs.readFileSync(new URL(`../../data/gex/nq-cbbo/nq_gex_${day}.json`, import.meta.url),'utf8')).data;
const dir = new URL(`../../data/schwab-snapshots/${day}/`, import.meta.url);
const swFiles = fs.readdirSync(dir).filter(f=>f.startsWith('snapshot_')).sort();
const swSnaps = swFiles.map(f=>{const s=JSON.parse(fs.readFileSync(new URL(f,dir),'utf8'));return {t:new Date(s.timestamp).getTime(),chains:s.chains.QQQ||[]};});
const nearest=ts=>{let b=null,bd=Infinity;for(const s of swSnaps){const d=Math.abs(s.t-ts);if(s.t<=ts+90000&&d<bd){bd=d;b=s;}}return b;};
// aggregate put OI by strike, full vs volume-gated
function putOIByStrike(chains, gated){
  const m=new Map();
  for(const c of chains) for(const o of (c.options||[])){
    if(o.option_type!=='put')continue; if(!o.open_interest)continue;
    if(gated && !(o.volume>0)) continue;
    m.set(o.strike,(m.get(o.strike)||0)+o.open_interest);
  }
  return m;
}
const ladder=(m,spot)=>Array.from(m).filter(([k])=>k<spot).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k])=>Math.round(k));
const eq=(a,b)=>a.length&&b.length&&a.slice(0,5).every((x,i)=>b[i]!=null&&Math.abs(x-Math.round(b[i]))<=1);
const s4=(a,b)=>a[3]!=null&&b[3]!=null&&Math.abs(a[3]-Math.round(b[3]))<=1;
let n=0,full_m=0,gated_m=0,full_s4=0,gated_s4=0;
for(const b of B){
  const sw=nearest(new Date(b.timestamp).getTime()); if(!sw)continue;
  const spot=b.qqq_spot,mult=b.multiplier;
  const bSup=(b.support||[]).map(x=>x/mult);
  const lf=ladder(putOIByStrike(sw.chains,false),spot);
  const lg=ladder(putOIByStrike(sw.chains,true),spot);
  n++; if(eq(lf,bSup))full_m++; if(eq(lg,bSup))gated_m++; if(s4(lf,bSup))full_s4++; if(s4(lg,bSup))gated_s4++;
}
console.log(JSON.stringify({day,n,fullOI_ladder_matches_B:`${full_m}/${n}`,gatedOI_ladder_matches_B:`${gated_m}/${n}`,fullOI_S4:`${full_s4}/${n}`,gatedOI_S4:`${gated_s4}/${n}`}));
