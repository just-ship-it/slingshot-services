#!/usr/bin/env python3
"""
R4-07 ES generalization of the two headline NQ first-hour signatures:
 (1) minute-of-day drift 09:49 / 10:50 fade, 11:00 up  (points; ES has no B12 atr table)
 (2) opening 15m FAST-drive fade to 10:30 (arr proxy = (ext5-close_5m_ago)/opening-candle-range)
Same causal conventions as NQ. Per-year sign stability is the bar.
"""
import numpy as np, pandas as pd, a1_common as A, r4_common as R
df=A.load_cache("ES")
w=df[(df["mod"]>=570)&(df["mod"]<=719)].copy()
O=w.pivot_table(index="trade_date",columns="mod",values="o",aggfunc="first")
H=w.pivot_table(index="trade_date",columns="mod",values="h",aggfunc="first")
L=w.pivot_table(index="trade_date",columns="mod",values="l",aggfunc="first")
C=w.pivot_table(index="trade_date",columns="mod",values="c",aggfunc="first")
# single-symbol RTH days only
sym=w.groupby("trade_date")["symbol"].nunique(); ok=sym[sym==1].index
O=O.loc[ok];H=H.loc[ok];L=L.loc[ok];C=C.loc[ok]
mods=C.columns.to_numpy(); yr=pd.Series(C.index.year,index=C.index)
Ca=C.to_numpy()
# require full first-hour coverage
good=np.isfinite(Ca).sum(axis=1)>=140
O=O[good];H=H[good];L=L[good];C=C[good];Ca=Ca[good];yr=yr[good]
print(f"=== ES minute drift (points), {len(C)} days ===")
def colidx(M): return int(np.where(mods==M)[0][0])
for mm in [574,580,589,590,600,650,652,660,666]:
    if mm not in mods or (mm-1) not in mods: continue
    ret=Ca[:,colidx(mm)]-Ca[:,colidx(mm-1)]
    g=pd.DataFrame({"year":yr.to_numpy(),"r":ret}); g=g[np.isfinite(g["r"])]
    mu,sd,n,t=R.tstat(g["r"].to_numpy()); out,verd=R.per_year(g,"r")
    hh=mm//60;mn=mm%60
    print(f"  {hh:02d}:{mn:02d}  drift={mu:+.3f}pt t={t:+.2f} n={n} [{verd}]")

print("\n=== ES opening 15m fast-drive fade to 10:30 ===")
o570=O.to_numpy()[:,colidx(570)]; c584=Ca[:,colidx(584)]
side=np.sign(c584-o570)
h580=np.nanmax(H.to_numpy()[:,colidx(580):colidx(584)],axis=1)
l580=np.nanmin(L.to_numpy()[:,colidx(580):colidx(584)],axis=1)
p580=O.to_numpy()[:,colidx(580)]
ocrange=(np.nanmax(H.to_numpy()[:,colidx(570):colidx(584)],axis=1)-
         np.nanmin(L.to_numpy()[:,colidx(570):colidx(584)],axis=1))
ext5=np.where(side>=0,h580,l580)
arr=side*(ext5-p580)/np.where(ocrange>0,ocrange,np.nan)   # arrival speed vs opening range
p585=O.to_numpy()[:,colidx(585)]; p630=O.to_numpy()[:,colidx(630)]
cont=side*(p630-p585)   # +continue, -fade
df2=pd.DataFrame({"year":yr.to_numpy(),"cont":cont,"arr":arr,"side":side})
df2=df2[(df2.side!=0)&np.isfinite(df2.cont)&np.isfinite(df2.arr)]
for lab,mask in [("all",np.ones(len(df2),bool)),
                 ("fast arr (top quartile)",df2.arr>=df2.arr.quantile(0.75)),
                 ("slow arr (bot quartile)",df2.arr<=df2.arr.quantile(0.25))]:
    g=df2[mask]; mu,sd,n,t=R.tstat(g["cont"].to_numpy()); out,verd=R.per_year(g,"cont")
    print(f"  {lab:<26s} cont pts={mu:+.3f} t={t:+.2f} n={n} [{verd}]")
