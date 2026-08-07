#!/usr/bin/env python3
"""
M1-03: (a) UNCONDITIONAL 2021+ hit-rate control (kills the 'high hit-rate' illusion),
       (b) sign sanity check, (c) TREND-conditioned short variants (does shorting work
           only when NQ already in a downtrend / bear regime?),
       (d) same-side LONG 'fade the fear' variants.
"""
import pandas as pd, numpy as np, os
from m1_common import (load_panel, build_features, measure, dist_stats, regime_of)

P=load_panel(); F=build_features(P)
def ret(c,n=1): return P[c].pct_change(n)
def chg(c,n=1): return P[c].diff(n)
def z(s,w): return (s-s.rolling(w).mean())/s.rolling(w).std()
def pct(s,q): return s.rolling(252,min_periods=120).quantile(q)

# NQ trend context
F['nq_ma50']=P['nq_close'].rolling(50).mean()
F['nq_ma200']=P['nq_close'].rolling(200).mean()
F['nq_below50']=P['nq_close']<F['nq_ma50']
F['nq_below200']=P['nq_close']<F['nq_ma200']
F['vix_pctile']=P['vix_close'].rolling(252).apply(lambda x:(x[-1]>x).mean(),raw=True)
F['vix_c5']=chg('vix_close',5)
F['hyglqd']=P['hyg_close']/P['lqd_close']; F['hyglqd_z']=z(F['hyglqd'],60)
comp=pd.DataFrame(index=P.index)
comp['credit']=-z(ret('hyg_close',5),120); comp['dollar']=z(ret('dxy_close',5),120)
comp['vix']=z(chg('vix_close',5),120); comp['bonds']=z(ret('tlt_close',5),120)
comp['gold']=z(ret('gld_close',5),120)
F['riskoff']=comp.mean(axis=1)

H=5
def hitrates(r):
    f=r['mfe'].values
    return (f>=100).mean(),(f>=150).mean(),(f>=200).mean()

# (a) UNCONDITIONAL control by era: every day, LONG and SHORT, hit100/150/200
print("="*100)
print("(a) UNCONDITIONAL hit-rate control (MFE>=X within 5d), by era & direction")
print("    Shows how trivial 100-200pt moves are at current price levels.")
for lo in ['2010-01-01','2018-01-01','2021-01-01','2024-01-01']:
    days=P.index[(P.index>=pd.Timestamp(lo))]
    for d in (+1,-1):
        r=measure(P,days,d,H)
        h100,h150,h200=hitrates(r)
        print(f"   era>={lo[:4]} dir={d:+d} n={len(r):5d} medMove={np.median(r['move']):+6.0f} "
              f"hit100/150/200={h100:.2f}/{h150:.2f}/{h200:.2f} avgNQpx={int(P.loc[days,'nq_close'].mean())}")
print()

# (b) sign check: are the stress SHORTS profitable? (directional move mean/median)
print("="*100)
print("(b) STRESS SHORT sign check (dir=-1 move = profit if positive). Full history + 2021+.")
shorts={
 'VIX_top_decile': F['vix_pctile']>=0.90,
 'VIX_5d_spike':   F['vix_c5']>=pct(F['vix_c5'],0.90),
 'riskoff_top10':  F['riskoff']>=pct(F['riskoff'],0.90),
 'hyglqd_z_low':   F['hyglqd_z']<=-1.5,
}
for nm,mask in shorts.items():
    sig=P.index[mask.fillna(False).values]
    r=measure(P,sig,-1,H); r21=r[r.signal_date>=pd.Timestamp('2021-01-01')]
    print(f"   {nm:16s} full: n={len(r):4d} shortMove mean={r['move'].mean():+6.1f} med={r['move'].median():+6.1f} "
          f"win%={(r['move']>0).mean():.2f} | 2021+: mean={r21['move'].mean():+6.1f} med={r21['move'].median():+6.1f} win%={(r21['move']>0).mean():.2f}")
print("   (positive shortMove = short profits; negative = short loses / NQ bounced)")
print()

# (c) TREND-conditioned shorts: stress AND NQ already in downtrend
print("="*100)
print("(c) TREND-conditioned SHORT: stress signal AND NQ<MA50 (or <MA200 bear). dir=-1")
trend_variants={
 'VIXtop & NQ<MA50':   (F['vix_pctile']>=0.90)&F['nq_below50'],
 'VIXtop & NQ<MA200':  (F['vix_pctile']>=0.90)&F['nq_below200'],
 'riskoff & NQ<MA50':  (F['riskoff']>=pct(F['riskoff'],0.90))&F['nq_below50'],
 'riskoff & NQ<MA200': (F['riskoff']>=pct(F['riskoff'],0.90))&F['nq_below200'],
 'creditwiden & NQ<MA50': (F['hyglqd_z']<=-1.0)&F['nq_below50'],
 'VIXspike & NQ<MA200': (F['vix_c5']>=pct(F['vix_c5'],0.90))&F['nq_below200'],
}
for nm,mask in trend_variants.items():
    sig=P.index[mask.fillna(False).values]
    r=measure(P,sig,-1,H)
    if len(r)<20: print(f"   {nm:26s} n={len(r)} too few"); continue
    r21=r[r.signal_date>=pd.Timestamp('2021-01-01')]
    yrs=r.assign(y=r.signal_date.dt.year).groupby('y')['move'].mean()
    posyr=(yrs>0).mean()
    print(f"   {nm:26s} n={len(r):4d} shortMove mean={r['move'].mean():+6.1f} med={r['move'].median():+6.1f} "
          f"win%={(r['move']>0).mean():.2f} yrPos={posyr:.2f} | 2021+ mean={r21['move'].mean():+6.1f}(n={len(r21)})")
print()

# (d) FADE-THE-FEAR long: same stress signals but dir=+1
print("="*100)
print("(d) FADE-THE-FEAR LONG (stress signal, dir=+1). Does buying the fear work?")
for nm,mask in shorts.items():
    sig=P.index[mask.fillna(False).values]
    r=measure(P,sig,+1,H); r21=r[r.signal_date>=pd.Timestamp('2021-01-01')]
    yrs=r.assign(y=r.signal_date.dt.year).groupby('y')['move'].mean(); posyr=(yrs>0).mean()
    print(f"   {nm:16s} full: n={len(r):4d} longMove mean={r['move'].mean():+6.1f} med={r['move'].median():+6.1f} "
          f"win%={(r['move']>0).mean():.2f} yrPos={posyr:.2f} | 2021+ mean={r21['move'].mean():+6.1f} med={r21['move'].median():+6.1f}")
