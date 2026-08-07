#!/usr/bin/env python3
"""M2-07: trade-sequence max drawdown ($, per micro 1-lot) for the top candidates."""
import pandas as pd, numpy as np, sys
sys.path.insert(0,"/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore")
import M2_lib as L

def maxdd(pnls):
    eq=np.cumsum(pnls); peak=np.maximum.accumulate(eq); dd=eq-peak
    return dd.min(), eq[-1]

def zsig(sym,N,zt,side,hold):
    df=L.load(sym); r=df["close"].pct_change(N); mu=r.rolling(252).mean().shift(1); sd=r.rolling(252).std().shift(1); z=(r-mu)/sd
    if side=="long": mask=(z<=-zt); d=1
    else: mask=(z>=zt); d=-1
    return df,L.simulate(df,mask.fillna(False),d,hold,sym,min_gap=1)

# GC Donchian
df=L.load("gc"); hh=df["high"].rolling(100).max().shift(1); ll=df["low"].rolling(100).min().shift(1)
up=df["close"]>hh; dn=df["close"]<ll; dirs=np.where(up,1,np.where(dn,-1,0))
tr=L.simulate(df,up|dn,dirs,42,"gc",min_gap=1)
dd,tot=maxdd(tr["net_usd"].values); print(f"GC-Donchian100/h42 : n={len(tr):>3} tot=${tot:>7.0f} maxDD=${dd:>7.0f}  (MGC)")

df,tr=zsig("gc",5,2.0,"long",5)
dd,tot=maxdd(tr["net_usd"].values); print(f"GC-longfade z2/h5  : n={len(tr):>3} tot=${tot:>7.0f} maxDD=${dd:>7.0f}  (MGC)")

df,tr=zsig("cl",5,1.5,"short",5)
dd,tot=maxdd(tr["net_usd"].values); print(f"CL-shortfade z1.5/h5: n={len(tr):>3} tot=${tot:>7.0f} maxDD=${dd:>7.0f}  (MCL)")
print("  CL-shortfade recent years:")
for y,ss in L.per_year(tr,"cl"):
    if y>=2019: print(f"    {y}: n={ss.get('n',0)} mean=${ss.get('mean_usd',0):.0f} tot=${ss.get('tot_usd',0):.0f}")
