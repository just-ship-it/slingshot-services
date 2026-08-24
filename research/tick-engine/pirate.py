#!/usr/bin/env python3
"""ASYMMETRIC / TAIL SEARCH — stop hunting mean shifts, hunt rare setups with lopsided payoffs.
   Question is no longer 'does P(+20 before -20) rise 3pp' but 'does any configuration make a
   BIG move before a small one, often enough to pay at 5:1 or 10:1?'"""
import pandas as pd, numpy as np, warnings, itertools
warnings.filterwarnings('ignore')
LAD=[4,8,12,16,20,24,32,40,52,68,88,112]
g=pd.read_csv("touchgrid/NQ_3m_grid.csv",low_memory=False)
r=pd.read_csv("reversal/NQ_3m_rev.csv",low_memory=False)
F=['moveLast10Rel','moveLast30Rel','velShare10','maxVel10','giveBack','sweepUp','sweepDn','closingBurst',
   'netMove5','netMove10','rej5','comp5','volTrend5','maxSliceVol','pathEff','lateRange30Rel','timeAtVel','minOfDay']
d=g.merge(r[['tradeDate','ts']+F],on=['tradeDate','ts'],how='inner',suffixes=('','_r'))
d['dev']=d.tradeDate<='2024-12-31'; d['etMin']=((d.minOfDay+18*60)%1440)
INF=10**9
def stats(df,T,S,side):
    u=df[f'u{T}'].replace(-1,INF); dn=df[f'd{S}'].replace(-1,INF)
    if side<0: u,dn=df[f'd{T}'].replace(-1,INF),df[f'u{S}'].replace(-1,INF)
    win=(u<dn)&(u<INF); lose=(dn<u)&(dn<INF)
    pnl=np.where(win,T-2,np.where(lose,-(S+4),side*df.pxEnd-2))
    return win.mean(), pnl.mean(), len(df)
dv=d[d.dev]
print("ASYMMETRIC PAYOFFS — base rates first (dev, no signal at all)\n")
print(f"{'target':>7} {'stop':>6} {'R:R':>6} {'P(win)':>8} {'need':>7} {'EV$':>8}")
for T,S in [(112,20),(112,16),(112,12),(88,16),(88,12),(112,8),(88,8),(112,4)]:
    p,e,n=stats(dv,T,S,1); need=(S+4)/(T-2+S+4)
    print(f"{T:>6}tk {S:>5}tk {T/S:>6.1f} {p:>8.4f} {need:>7.4f} {e*5:>+8.2f}")
print("\nNow: can ANY configuration beat the required rate at 5:1 or better? (dev, both directions)")
print(f"{'feature':>16} {'cut':>10} {'side':>5} {'T':>4} {'S':>4} {'n':>6} {'P':>7} {'need':>7} {'devEV$':>8} {'valEV$':>8}")
hits=[]
for f in F:
    if f in ('sweepUp','sweepDn','minOfDay'): continue
    s=dv.dropna(subset=[f])
    if len(s)<20000 or s[f].nunique()<20: continue
    for qq,lab in [(0.99,'top 1%'),(0.95,'top 5%'),(0.01,'bot 1%'),(0.05,'bot 5%')]:
        cut=s[f].quantile(qq)
        sub=s[s[f]>=cut] if qq>0.5 else s[s[f]<=cut]
        if len(sub)<400: continue
        for side in (1,-1):
            for T,S in [(112,20),(112,16),(112,12),(88,16),(88,12),(112,8)]:
                p,e,n=stats(sub,T,S,side); need=(S+4)/(T-2+S+4)
                if e>0 and n>=400:
                    vl=d[~d.dev].dropna(subset=[f])
                    vs=vl[vl[f]>=cut] if qq>0.5 else vl[vl[f]<=cut]
                    pv,ev_,nv=stats(vs,T,S,side)
                    hits.append((e,f,lab,side,T,S,n,p,need,e,ev_,nv))
hits.sort(reverse=True)
seen=set()
for h in hits[:14]:
    k=(h[1],h[2],h[3])
    if k in seen: continue
    seen.add(k)
    _,f,lab,side,T,S,n,p,need,e,ev_,nv=h
    fl='★★' if ev_>0 else ''
    print(f"{f:>16} {lab:>10} {'long' if side>0 else 'short':>5} {T:>4} {S:>4} {n:>6,} {p:>7.4f} {need:>7.4f} {e*5:>+8.2f} {ev_*5:>+8.2f} {fl}")
print(f"\n   dev-positive asymmetric configs found: {len(hits)}")
