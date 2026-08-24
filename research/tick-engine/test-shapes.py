#!/usr/bin/env python3
"""The time DISTRIBUTION as the feature: cluster candles by their volume/movement shape, then ask
   whether any shape predicts. Shapes are learned on dev only and frozen for validation."""
import pandas as pd, numpy as np, warnings, itertools
warnings.filterwarnings('ignore')
LAD=[4,8,12,16,20,24,32,40,52,68,88,112]
V=[f'v{k}' for k in range(1,7)]; M=[f'm{k}' for k in range(1,7)]
g=pd.read_csv("touchgrid/NQ_3m_grid.csv",low_memory=False)
r=pd.read_csv("reversal/NQ_3m_rev.csv",low_memory=False)
d=g.merge(r[['tradeDate','ts']+V+M],on=['tradeDate','ts'],how='inner').dropna(subset=V+M)
d['dev']=d.tradeDate<='2024-12-31'
INF=10**9
def ev(df,T,S,side):
    u=df[f'u{T}'].replace(-1,INF); dn=df[f'd{S}'].replace(-1,INF)
    if side<0: u,dn=df[f'd{T}'].replace(-1,INF),df[f'u{S}'].replace(-1,INF)
    win=(u<dn)&(u<INF); lose=(dn<u)&(dn<INF)
    pnl=np.where(win,T-2,np.where(lose,-(S+4),side*df.pxEnd-2))
    return pnl.mean(), win.mean(), len(df)
print(f"{len(d):,} candles with full 6-slice volume + movement distributions\n")
print("Mean shape (dev): where volume and directional movement sit across the candle")
dv=d[d.dev]
print("   slice:      " + " ".join(f"{k:>7}" for k in range(1,7)))
print("   volume %:   " + " ".join(f"{dv[f'v{k}'].mean()*100:>6.2f}%" for k in range(1,7)))
print("   |move| %:   " + " ".join(f"{dv[f'm{k}'].abs().mean()*100:>6.2f}%" for k in range(1,7)))
# k-means on the joint shape, fit on dev only
from sklearn.cluster import KMeans
X=dv[V+M].to_numpy()
km=KMeans(n_clusters=8,n_init=4,random_state=0).fit(X)
dv=dv.copy(); dv['cl']=km.labels_
vl=d[~d.dev].copy(); vl['cl']=km.predict(vl[V+M].to_numpy())
print(f"\n8 shape-clusters (learned on dev, frozen for val). Best R/R per cluster, K swept:")
print(f"   {'cl':>3} {'n dev':>7} {'shape (vol → | move →)':<44} {'side':>5} {'T':>4} {'S':>4} {'devEV$':>8} {'valEV$':>8} {'valN':>7}")
hits=[]
for c in range(8):
    sd=dv[dv.cl==c]; sv=vl[vl.cl==c]
    if len(sd)<2000 or len(sv)<500: continue
    vshape=''.join('▁▂▃▄▅▆▇█'[min(7,int(sd[f'v{k}'].mean()*24))] for k in range(1,7))
    mshape=''.join('▁▂▃▄▅▆▇█'[min(7,int(abs(sd[f'm{k}'].mean())*40))] for k in range(1,7))
    best=None
    for T,S in itertools.product(LAD,LAD):
        for side in (1,-1):
            e=ev(sd,T,S,side)
            if e[2]>=1500 and (best is None or e[0]>best[0]): best=(e[0],T,S,side,e[1])
    if not best: continue
    eD,T,S,side,pD=best
    eV=ev(sv,T,S,side)
    fl='★★' if eD>0 and eV[0]>0 else ''
    print(f"   {c:>3} {len(sd):>7,} {vshape+'  |  '+mshape:<44} {'long' if side>0 else 'short':>5} {T:>4} {S:>4} {eD*5:>+8.2f} {eV[0]*5:>+8.2f} {eV[2]:>7,} {fl}")
    if eD>0 and eV[0]>0: hits.append(c)
print(f"\n   clusters positive on dev AND val: {hits or 'none'}")
