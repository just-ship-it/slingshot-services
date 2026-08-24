#!/usr/bin/env python3
"""The sweep signature, catalogued across TIME OF DAY and TIME OF MONTH.
   sweepUp = a fast up-burst covering ≥50% of the candle's range that then closed in its lower third."""
import pandas as pd, numpy as np, warnings
warnings.filterwarnings('ignore')
g=pd.read_csv("touchgrid/NQ_3m_grid.csv",low_memory=False)
cols=['minOfDay','sweepUp','sweepDn','velShare10','giveBack','maxVel10','timeAtVel','velDir','sweepUp5','sweepDn5','atrTicks']
r=pd.read_csv("reversal/NQ_3m_rev.csv",low_memory=False)
d=g.merge(r[['tradeDate','ts']+cols],on=['tradeDate','ts'],how='inner',suffixes=('','_r')).dropna(subset=['sweepUp'])
d['dev']=d.tradeDate<='2024-12-31'
d['etMin']=((d.minOfDay+18*60)%1440)                      # minutes since ET midnight
dt=pd.to_datetime(d.tradeDate); d['dom']=dt.dt.day; d['dow']=dt.dt.dayofweek
INF=10**9
def pdown(df,K):     # P(price falls K before rising K) — the fade of an up-sweep
    u=df[f'u{K}'].replace(-1,INF); dn=df[f'd{K}'].replace(-1,INF)
    return ((dn<u)&(dn<INF)).mean()
def pup(df,K):
    u=df[f'u{K}'].replace(-1,INF); dn=df[f'd{K}'].replace(-1,INF)
    return ((u<dn)&(u<INF)).mean()
K=20
print(f"{len(d):,} candles | sweepUp {d.sweepUp.sum():,} ({d.sweepUp.mean()*100:.1f}%)  sweepDn {d.sweepDn.sum():,}")
print(f"base rate P(down {K}tk first) = {pdown(d[d.dev],K):.4f}   break-even needs {(K+4)/(2*K+2):.4f}\n")
def band(m):
    if 570<=m<600: return '09:30-10:00 open'
    if 600<=m<720: return '10:00-12:00'
    if 720<=m<840: return '12:00-14:00 midday'
    if 840<=m<930: return '14:00-15:30'
    if 930<=m<960: return '15:30-16:00 close'
    if 960<=m<1080 or m<240: return 'evening/overnight'
    if 240<=m<570: return 'europe/premkt'
    return 'other'
d['tod']=d.etMin.map(band)
print("SWEEP-UP → P(down first), by time of day  [dev | val], n = dev sweeps")
print(f"   {'band':>20} {'nDev':>6} {'devP':>7} {'valP':>7} {'edge vs base':>13}")
base=pdown(d[d.dev],K)
for b,sub in d[d.sweepUp==1].groupby('tod'):
    sd,sv=sub[sub.dev],sub[~sub.dev]
    if len(sd)<300: continue
    pd_,pv=pdown(sd,K),pdown(sv,K) if len(sv)>100 else np.nan
    print(f"   {b:>20} {len(sd):>6,} {pd_:>7.4f} {pv:>7.4f} {(pd_-base)*100:>+12.2f}pp")
print("\nSWEEP-DOWN → P(up first), by time of day")
baseU=pup(d[d.dev],K)
for b,sub in d[d.sweepDn==1].groupby('tod'):
    sd,sv=sub[sub.dev],sub[~sub.dev]
    if len(sd)<300: continue
    pd_,pv=pup(sd,K),pup(sv,K) if len(sv)>100 else np.nan
    print(f"   {b:>20} {len(sd):>6,} {pd_:>7.4f} {pv:>7.4f} {(pd_-baseU)*100:>+12.2f}pp")
print("\nBy TIME OF MONTH (sweepUp → down), dev:")
d['domB']=pd.cut(d.dom,[0,10,20,32],labels=['1st third','2nd third','3rd third'])
for b,sub in d[(d.sweepUp==1)&d.dev].groupby('domB',observed=True):
    if len(sub)<300: continue
    print(f"   {str(b):>12} n={len(sub):>6,} P(down first)={pdown(sub,K):.4f}  {(pdown(sub,K)-base)*100:+.2f}pp")
print("\nBy DAY OF WEEK (sweepUp → down), dev:")
for b,sub in d[(d.sweepUp==1)&d.dev].groupby('dow'):
    if len(sub)<200: continue
    print(f"   {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][b]:>12} n={len(sub):>6,} P={pdown(sub,K):.4f}  {(pdown(sub,K)-base)*100:+.2f}pp")
