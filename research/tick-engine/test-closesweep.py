#!/usr/bin/env python3
"""The one promising cell: fade an up-sweep in the final 30 min of RTH. Sweep target/stop, honest EV."""
import pandas as pd, numpy as np, warnings, itertools
warnings.filterwarnings('ignore')
LAD=[4,8,12,16,20,24,32,40,52,68,88,112]
g=pd.read_csv("touchgrid/NQ_3m_grid.csv",low_memory=False)
r=pd.read_csv("reversal/NQ_3m_rev.csv",low_memory=False)
c=['minOfDay','sweepUp','sweepDn','velShare10','giveBack','atrTicks']
d=g.merge(r[['tradeDate','ts']+c],on=['tradeDate','ts'],how='inner',suffixes=('','_r')).dropna(subset=['sweepUp'])
d['dev']=d.tradeDate<='2024-12-31'; d['etMin']=((d.minOfDay+18*60)%1440)
INF=10**9
def ev(df,T,S,side):
    u=df[f'u{T}'].replace(-1,INF); dn=df[f'd{S}'].replace(-1,INF)
    if side<0: u,dn=df[f'd{T}'].replace(-1,INF),df[f'u{S}'].replace(-1,INF)
    win=(u<dn)&(u<INF); lose=(dn<u)&(dn<INF)
    pnl=np.where(win,T-2,np.where(lose,-(S+4),side*df.pxEnd-2))
    return pnl.mean(), win.mean(), len(df)
for lab,mask,side in [('sweepUp in 15:30-16:00 → SHORT', (d.sweepUp==1)&(d.etMin>=930)&(d.etMin<960), -1),
                      ('sweepUp in 15:00-16:00 → SHORT', (d.sweepUp==1)&(d.etMin>=900)&(d.etMin<960), -1),
                      ('sweepUp RTH 09:30-16:00 → SHORT',(d.sweepUp==1)&(d.etMin>=570)&(d.etMin<960), -1)]:
    sd,sv=d[mask&d.dev],d[mask&~d.dev]
    if len(sd)<200: continue
    print(f"\n{lab}   dev n={len(sd):,}  val n={len(sv):,}")
    print(f"   {'T':>4} {'S':>4} {'devP':>7} {'devEV$':>8} | {'valP':>7} {'valEV$':>8}")
    cands=[]
    for T,S in itertools.product(LAD,LAD):
        e=ev(sd,T,S,side)
        if e[2]>=200: cands.append((e[0],T,S,e[1]))
    cands.sort(reverse=True)
    for eD,T,S,pD in cands[:5]:
        eV=ev(sv,T,S,side) if len(sv)>80 else (np.nan,np.nan,0)
        fl='★★' if eD>0 and eV[0]>0 else ''
        print(f"   {T:>4} {S:>4} {pD:>7.4f} {eD*5:>+8.2f} | {eV[1]:>7.4f} {eV[0]*5:>+8.2f} {fl}")
    # how many trades per year would this be?
    yrs_d, yrs_v = 4.0, 1.45
    print(f"   frequency: {len(sd)/yrs_d:.0f} signals/yr dev, {len(sv)/yrs_v:.0f}/yr val")
