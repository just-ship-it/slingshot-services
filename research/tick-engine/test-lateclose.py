#!/usr/bin/env python3
"""Is what a candle does in its FINAL SECONDS predictive? Tested against the same required-edge bar."""
import pandas as pd, numpy as np, warnings, itertools
warnings.filterwarnings('ignore')
LAD=[4,8,12,16,20,24,32,40,52,68,88,112]
g=pd.read_csv("touchgrid/NQ_3m_grid.csv",low_memory=False)
r=pd.read_csv("reversal/NQ_3m_rev.csv",low_memory=False)
NEW=['volCentroid','moveCentroid','driveCentroid','moveLast10Rel','moveLast30Rel','lateRange30Rel',
     'lateRange10Rel','lateFightsBody','closeOffLateHi','closeOffLateLo','volLastQ','volFirstQ',
     'closingBurst','pathEff','revs','maxSliceVol','volCentroid5','lateFights5','closingBurst5']
d=g.merge(r[['tradeDate','ts']+NEW],on=['tradeDate','ts'],how='inner'); d['dev']=d.tradeDate<='2024-12-31'
INF=10**9; dv=d[d.dev]
print(f"{len(d):,} points | {len(NEW)} new time-profile features\n")
def pw(df,K,side=1):
    u=df[f'u{K}'].replace(-1,INF); dn=df[f'd{K}'].replace(-1,INF)
    if side<0: u,dn=df[f'd{K}'].replace(-1,INF),df[f'u{K}'].replace(-1,INF)
    return ((u<dn)&(u<INF)).mean()
print("Directional power: P(+K before −K) in the top vs bottom DECILE of each feature (dev, K=20)")
print(f"   {'feature':>16} {'D0':>7} {'D9':>7} {'spread':>8} {'val spread':>11}")
res=[]
for f in NEW:
    o=[]
    for isdev in [True,False]:
        s=d[d.dev==isdev].dropna(subset=[f])
        if len(s)<5000 or s[f].nunique()<10: o.append((np.nan,np.nan,np.nan)); continue
        q=pd.qcut(s[f],10,labels=False,duplicates='drop')
        p0,p9=pw(s[q==0],20),pw(s[q==9],20)
        o.append((p0,p9,p9-p0))
    star='★' if not np.isnan(o[1][2]) and np.sign(o[0][2])==np.sign(o[1][2]) and abs(o[1][2])>0.015 else ''
    print(f"   {f:>16} {o[0][0]:>7.4f} {o[0][1]:>7.4f} {o[0][2]:>+8.4f} {o[1][2]:>+11.4f} {star}")
    res.append((f,o[0][2],o[1][2],star))
print("\nRequired edge to break even (from the cost arithmetic): K=20 → 7.1pp, K=40 → 3.7pp, K=88 → 1.7pp")
best=max((abs(x[1]) for x in res if not np.isnan(x[1])),default=0)
print(f"Largest dev decile spread from any new feature: {best*100:.2f} pp")
# best achievable P at larger K for the strongest features
print("\nBest P(win) at each K for the strongest new features (dev deciles):")
strong=[x[0] for x in sorted(res,key=lambda z:-abs(z[1] if not np.isnan(z[1]) else 0))[:4]]
print(f"   {'feature':>16} " + ' '.join(f'K={k:>3}' for k in [20,40,88,112]))
for f in strong:
    s=dv.dropna(subset=[f])
    if len(s)<5000 or s[f].nunique()<10: continue
    q=pd.qcut(s[f],10,labels=False,duplicates='drop')
    row=[]
    for K in [20,40,88,112]:
        pbest=max(pw(s[q==9],K,1), pw(s[q==0],K,-1))
        need=(K+4)/(2*K+2)
        row.append(f"{pbest:.3f}{'*' if pbest>need else ' '}")
    print(f"   {f:>16} " + '  '.join(f'{x:>5}' for x in row))
print("   (* = clears the break-even bar)")
