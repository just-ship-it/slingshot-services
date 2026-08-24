#!/usr/bin/env python3
"""FADE THE LATE PUSH: after a candle whose final seconds surged, bet AGAINST that push.
   Correct direction, honest EV with time-exits, R/R swept, dev-chosen then frozen on validation."""
import pandas as pd, numpy as np, warnings, itertools
warnings.filterwarnings('ignore')
LAD=[4,8,12,16,20,24,32,40,52,68,88,112]
g=pd.read_csv("touchgrid/NQ_3m_grid.csv",low_memory=False)
r=pd.read_csv("reversal/NQ_3m_rev.csv",low_memory=False)
F=['moveLast10Rel','moveLast30Rel']
d=g.merge(r[['tradeDate','ts']+F],on=['tradeDate','ts'],how='inner'); d['dev']=d.tradeDate<='2024-12-31'
INF=10**9
def ev(df,T,S,side):
    u=df[f'u{T}'].replace(-1,INF); dn=df[f'd{S}'].replace(-1,INF)
    if side<0: u,dn=df[f'd{T}'].replace(-1,INF),df[f'u{S}'].replace(-1,INF)
    win=(u<dn)&(u<INF); lose=(dn<u)&(dn<INF); un=~win&~lose
    pnl=np.where(win,T-2,np.where(lose,-(S+4),side*df.pxEnd-2))
    return pnl.mean(), win.mean(), un.mean(), len(df)
dv=d[d.dev]
print("FADE THE LATE PUSH — D9 (big late up-push) → SHORT ; D0 (big late down-push) → LONG\n")
for f in F:
    s=dv.dropna(subset=[f]); q=pd.qcut(s[f],10,labels=False,duplicates='drop')
    for dec,side,lab in [(9,-1,'late UP-push → short'),(0,1,'late DOWN-push → long')]:
        sub=s[q==dec]
        if len(sub)<1000: continue
        c=[]
        for T,S in itertools.product(LAD,LAD):
            e=ev(sub,T,S,side)
            if e and e[3]>=800: c.append((e[0],T,S,e[1],e[2]))
        c.sort(reverse=True); eD,T,S,pD,unD=c[0]
        cut=s[f].quantile(0.9 if dec==9 else 0.1)
        vl=d[~d.dev].dropna(subset=[f]); vs=vl[vl[f]>=cut] if dec==9 else vl[vl[f]<=cut]
        eV=ev(vs,T,S,side)
        flag='★★ POSITIVE BOTH' if eD>0 and eV[0]>0 else ('dev only' if eD>0 else '')
        print(f"{f:>16} {lab:<24} best T={T:>3} S={S:>3}")
        print(f"{'':>16}   dev: P={pD:.4f} unres={unD:.3f} n={len(sub):,} EV={eD*5:+.2f}$/trade")
        print(f"{'':>16}   val: P={eV[1]:.4f} unres={eV[2]:.3f} n={eV[3]:,} EV={eV[0]*5:+.2f}$/trade   {flag}\n")
print("Top-5 R/R combos for the strongest cell (dev), to see if the optimum is a plateau or a spike:")
s=dv.dropna(subset=['moveLast10Rel']); q=pd.qcut(s['moveLast10Rel'],10,labels=False,duplicates='drop')
sub=s[q==9]; c=[]
for T,S in itertools.product(LAD,LAD):
    e=ev(sub,T,S,-1)
    if e and e[3]>=800: c.append((e[0]*5,T,S,e[1]))
c.sort(reverse=True)
for e,T,S,p in c[:5]: print(f"   T={T:>3} S={S:>3} R/R={T/S:.2f} P={p:.4f} EV=${e:+.2f}")
