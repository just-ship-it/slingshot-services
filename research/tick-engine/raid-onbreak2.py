#!/usr/bin/env python3
"""Kill-tests for the wide-ON breakout: drift twin, real loss distribution, tighter stops."""
import pandas as pd, numpy as np, json, warnings
warnings.filterwarnings('ignore')
meta=json.load(open('cache/NQ/meta.json')); symcol=np.fromfile('cache/NQ/sym.u8',dtype=np.uint8)
multi={td for td,(a,b) in meta['days'].items() if len(np.unique(symcol[a:b]))>1}
d=pd.read_csv("mech_NQ.csv"); sym=d.sym.values
dirty=np.array(d.tradeDate.isin(multi))|np.array([sym[i+1]!=sym[i] if i+1<len(sym) else False for i in range(len(d))])|np.array([sym[i]!=sym[i-1] if i>0 else False for i in range(len(d))])
d=d[~dirty].dropna(subset=['onRange','atr20']).reset_index(drop=True)
d['dev']=d.tradeDate<='2024-12-31'; d['year']=d.tradeDate.str[:4]
PT=20.0; COST=15.0; d['onAtr']=d.onRange/d.atr20
thr=d[d.dev].onAtr.quantile(0.67)
W=d[d.onAtr>=thr].copy()
print(f"wide-ON sessions (onRange ≥ {thr:.2f} ATR): {len(W)}  ({W.dev.sum()} dev / {(~W.dev).sum()} val)\n")
def bo(g):
    out=[]
    for _,r in g.iterrows():
        if r.firstBreak==0: continue
        s=int(r.firstBreak); e=r.onHigh if s>0 else r.onLow; st=r.onLow if s>0 else r.onHigh
        tb=r.onHiBreakMin if s>0 else r.onLoBreakMin; to=r.onLoBreakMin if s>0 else r.onHiBreakMin
        stopped=(not np.isnan(to)) and to>tb
        pnl=((st-e)*s if stopped else (r.rthClose-e)*s)*PT-COST
        out.append({'d':r.tradeDate,'dev':r.dev,'s':s,'pnl':pnl,'yr':r.year})
    return pd.DataFrame(out)
T=bo(W)
print("1) DRIFT TWIN — the same wide-ON days, but take the LONG side regardless of which extreme broke")
for nm,m in [('dev',T.dev),('val',~T.dev)]:
    sig=T[m]
    twin=W[W.dev==(nm=='dev')]
    tw=((twin.rthClose-twin.rthOpen)*PT-COST)          # unconditional long, RTH open→close, same days
    print(f"   {nm}: signal ${sig.pnl.mean():>+7.0f} (n={len(sig)})   |   unconditional-long twin ${tw.mean():>+7.0f} (n={len(tw)})   edge ${sig.pnl.mean()-tw.mean():>+7.0f}")
print("\n   and on ALL sessions (not just wide-ON), unconditional long RTH:")
for nm,m in [('dev',d.dev),('val',~d.dev)]:
    g=d[m]; print(f"   {nm}: ${((g.rthClose-g.rthOpen)*PT-COST).mean():>+7.0f} (n={len(g)})")
print("\n2) SHORT SIDE ONLY (drift works against it — the honest half)")
for nm,m in [('dev',T.dev),('val',~T.dev)]:
    s=T[(T.s<0)&m]
    print(f"   {nm}: n={len(s):>4} mean ${s.pnl.mean():>+7.0f} median ${s.pnl.median():>+7.0f} WR {(s.pnl>0).mean()*100:>3.0f}%")
print("\n3) REAL LOSS DISTRIBUTION (the $6,444 'risk' is the stop, but it is almost never hit)")
for nm,m in [('dev',T.dev),('val',~T.dev)]:
    p=T[m].pnl
    print(f"   {nm}: worst ${p.min():>+8,.0f}  p5 ${p.quantile(.05):>+8,.0f}  p25 ${p.quantile(.25):>+7,.0f}  p75 ${p.quantile(.75):>+7,.0f}  best ${p.max():>+9,.0f}")
    eq=p.cumsum(); print(f"        maxDD ${(eq.cummax()-eq).max():>8,.0f}   PF {p[p>0].sum()/-p[p<0].sum():.2f}")
print("\n4) DOES A TIGHTER STOP HELP? (stop = X × ATR20 from entry instead of the far ON extreme)")
print(f"   {'stop':>8} {'devEV$':>8} {'devWR':>6} {'valEV$':>8} {'valWR':>6}   (exit still RTH close)")
for k in [0.5,0.75,1.0,1.5,None]:
    rows=[]
    for _,r in W.iterrows():
        if r.firstBreak==0: continue
        s=int(r.firstBreak); e=r.onHigh if s>0 else r.onLow
        st=(e-s*k*r.atr20) if k else (r.onLow if s>0 else r.onHigh)
        hit = (r.rthLow<=st) if s>0 else (r.rthHigh>=st)
        pnl=((st-e)*s if hit else (r.rthClose-e)*s)*PT-COST
        rows.append({'dev':r.dev,'pnl':pnl})
    R=pd.DataFrame(rows)
    a,b=R[R.dev].pnl,R[~R.dev].pnl
    print(f"   {str(k)+'×ATR' if k else 'far ON':>8} {a.mean():>+8.0f} {(a>0).mean()*100:>5.0f}% {b.mean():>+8.0f} {(b>0).mean()*100:>5.0f}%")
