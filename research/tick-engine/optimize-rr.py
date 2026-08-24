#!/usr/bin/env python3
"""For each signal, find the R/R that actually fits its win rate. Every (target, stop) pair is priced
   from the touch ladder; costs charged honestly (win −2 ticks, loss +4)."""
import pandas as pd, numpy as np, warnings, itertools, sys
warnings.filterwarnings('ignore')
LAD=[4,8,12,16,20,24,32,40,52,68,88,112]
g=pd.read_csv("touchgrid/NQ_3m_grid.csv",low_memory=False)
r=pd.read_csv("reversal/NQ_3m_rev.csv",low_memory=False)
seq=['rej5','rej10','hl5','shallow5','comp5','dnVol5','upVol5','volTrend5','netMove5','netMove10','closePos5','dnWickSum5']
d=g.merge(r[['tradeDate','ts']+seq],on=['tradeDate','ts'],how='inner')
d['dev']=d.tradeDate<='2024-12-31'
print(f"{len(d):,} decision points joined (dev {d.dev.sum():,} / val {(~d.dev).sum():,})\n")
INF=10**9
def outcome(df,T,S,side):
    """side +1 = long: win if up-T touched before down-S."""
    u=df[f'u{T}'].replace(-1,INF); dn=df[f'd{S}'].replace(-1,INF)
    if side<0: u,dn=df[f'd{T}'].replace(-1,INF),df[f'u{S}'].replace(-1,INF)
    return (u<dn)&(u<INF)
def ev(df,T,S,side):
    w=outcome(df,T,S,side); n=len(df)
    if n<300: return None
    p=w.mean(); return p*(T-2)-(1-p)*(S+4), p, n
print("1) BASELINE — best R/R with NO signal at all (all decision points, dev)")
dv=d[d.dev]
best=[]
for T,S in itertools.product(LAD,LAD):
    e=ev(dv,T,S,1)
    if e: best.append((e[0],T,S,e[1],e[2]))
best.sort(reverse=True)
print(f"   {'T':>4} {'S':>4} {'R/R':>6} {'P(win)':>7} {'EV tk':>7} {'EV $':>8}")
for e,T,S,p,n in best[:5]: print(f"   {T:>4} {S:>4} {T/S:>6.2f} {p:>7.4f} {e:>+7.3f} {e*5:>+8.2f}")
print(f"   (a coin flip with costs should be negative everywhere — sanity check)\n")
print("2) WITH SIGNAL — for each feature's extreme quintile, the EV-optimal R/R, dev then val")
print(f"   {'feature':>12} {'side':>5} {'T':>4} {'S':>4} {'devP':>7} {'devEV$':>8} {'devN':>7} | {'valP':>7} {'valEV$':>8} {'valN':>7}")
hits=[]
for f in seq:
    dvf=dv.dropna(subset=[f])
    if len(dvf)<5000: continue
    q=pd.qcut(dvf[f],5,labels=False,duplicates='drop')
    for qq,side in [(4,1),(0,-1)]:
        sub=dvf[q==qq]
        if len(sub)<1000: continue
        cands=[]
        for T,S in itertools.product(LAD,LAD):
            e=ev(sub,T,S,side)
            if e and e[2]>=800: cands.append((e[0],T,S,e[1],e[2]))
        if not cands: continue
        cands.sort(reverse=True)
        eD,T,S,pD,nD=cands[0]
        if eD<=0: continue
        # validation with the SAME frozen T,S and the SAME dev quintile cut-point
        cut=dvf[f].quantile(0.8 if qq==4 else 0.2)
        vl=d[~d.dev].dropna(subset=[f])
        vsub=vl[vl[f]>=cut] if qq==4 else vl[vl[f]<=cut]
        eV=ev(vsub,T,S,side)
        if not eV: continue
        print(f"   {f:>12} {'long' if side>0 else 'short':>5} {T:>4} {S:>4} {pD:>7.4f} {eD*5:>+8.2f} {nD:>7,} | {eV[1]:>7.4f} {eV[0]*5:>+8.2f} {eV[2]:>7,}")
        if eV[0]>0: hits.append((f,side,T,S,eD*5,eV[0]*5,nD,eV[2]))
print(f"\n   configs positive on dev AND validation: {len(hits)}")
for h in hits: print(f"     {h[0]} {'long' if h[1]>0 else 'short'} T={h[2]} S={h[3]}  dev ${h[4]:+.2f}/tr (n={h[6]:,})  val ${h[5]:+.2f}/tr (n={h[7]:,})")
