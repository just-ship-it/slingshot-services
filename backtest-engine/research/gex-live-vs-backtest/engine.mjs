// Parametrized GEX engine — faithful to BOTH exposure-calculator.js (live) and
// generate-cbbo-gex.js (backtest). Toggle every differing factor.
export function normalPDF(x){ return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI); }
export function gamma(S,K,r,iv,T,q){ if(T<=0||iv<=0||S<=0||K<=0)return 0; const d1=(Math.log(S/K)+(r-q+0.5*iv*iv)*T)/(iv*Math.sqrt(T)); return Math.exp(-q*T)*normalPDF(d1)/(S*iv*Math.sqrt(T)); }
export function brennerIV(mid,S,K,T,type,mode){
  const intrinsic = type==='C'?Math.max(0,S-K):Math.max(0,K-S);
  let tv = mid-intrinsic;
  if(mode==='live'){ if(mid<=0||S<=0)return 0.05; if(tv<=0)return 0.05; }
  else { tv = Math.max(tv,0.01); } // bt
  const iv=(tv/S)*Math.sqrt(2*Math.PI/T);
  return Math.max(0.05,Math.min(2.0,iv));
}
// contracts: [{strike,type:'C'|'P',expMs,oi,mid}]
// cfg: {r,q,tteFloorYr,ivMode,spot,refDateMs,selection:'gex'|'oiw',wall:'gex'|'oi'}
export function computeGEX(contracts, cfg){
  const {r,q,tteFloorYr,ivMode,spot,refDateMs,selection,wall}=cfg;
  const byStrike=new Map();
  for(const c of contracts){
    if(!c.oi) continue;
    let T=(c.expMs-refDateMs)/(1000*60*60*24*365.25);
    T=Math.max(tteFloorYr, ivMode==='live'?Math.max(T,0):T); // live floors at tteFloorYr via max; bt max(MIN_TTE,max(0,T))
    T=Math.max(tteFloorYr,Math.max(0,T));
    const iv=brennerIV(c.mid,spot,c.strike,T,c.type,ivMode);
    const g=gamma(spot,c.strike,r,iv,T,q);
    const sign=c.type==='C'?1:-1;
    const gex=sign*g*c.oi*100*spot*spot*0.01;
    if(!byStrike.has(c.strike)) byStrike.set(c.strike,{gex:0,callOI:0,putOI:0});
    const sd=byStrike.get(c.strike); sd.gex+=gex;
    if(c.type==='C')sd.callOI+=c.oi; else sd.putOI+=c.oi;
  }
  // walls
  let callWall=null,putWall=null;
  if(wall==='oi'){ let mc=0,mp=0; for(const[k,v]of byStrike){ if(v.callOI>mc){mc=v.callOI;callWall=k;} if(v.putOI>mp){mp=v.putOI;putWall=k;} } }
  else { let cg=0,pg=0; for(const[k,v]of byStrike){ if(k>spot&&v.gex>cg){cg=v.gex;callWall=k;} if(k<spot&&v.gex<pg){pg=v.gex;putWall=k;} } }
  // support/resistance
  let support,resistance;
  if(selection==='oiw'){
    support=[...byStrike].filter(([k])=>k<spot).map(([k,v])=>({k,s:v.putOI+Math.abs(v.gex)/1e6})).sort((a,b)=>b.s-a.s).slice(0,5).map(o=>Math.round(o.k));
    resistance=[...byStrike].filter(([k])=>k>spot).map(([k,v])=>({k,s:v.callOI+Math.abs(v.gex)/1e6})).sort((a,b)=>b.s-a.s).slice(0,5).map(o=>Math.round(o.k));
  } else {
    support=[...byStrike].filter(([k,v])=>k<spot&&v.gex<0).sort((a,b)=>a[1].gex-b[1].gex).slice(0,5).map(([k])=>Math.round(k));
    resistance=[...byStrike].filter(([k,v])=>k>spot&&v.gex>0).sort((a,b)=>b[1].gex-a[1].gex).slice(0,5).map(([k])=>Math.round(k));
  }
  return {callWall,putWall,support,resistance,byStrike};
}
export function parseOpraSym(sym){
  const m=sym.match(/QQQ\s+(\d{6})([CP])(\d{8})/); if(!m)return null;
  const yy=+m[1].slice(0,2),mm=+m[1].slice(2,4)-1,dd=+m[1].slice(4,6);
  return { expMs:new Date(2000+yy,mm,dd,16,0,0).getTime(), type:m[2], strike:+m[3]/1000 };
}
