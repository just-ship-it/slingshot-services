#!/usr/bin/env python3
"""
M1-04: Does ANY horizon rescue a defensive SHORT?
 - horizon sweep (3,5,10,20d) for stress shorts and LEADING-divergence shorts
   (credit/breadth weak while equity still strong = classic 'lead' short).
 - if all lose, the defensive multi-day-down thesis is comprehensively dead.
"""
import pandas as pd, numpy as np
from m1_common import load_panel, build_features, measure

P=load_panel(); F=build_features(P)
def ret(c,n=1): return P[c].pct_change(n)
def chg(c,n=1): return P[c].diff(n)
def z(s,w): return (s-s.rolling(w).mean())/s.rolling(w).std()
def pct(s,q): return s.rolling(252,min_periods=120).quantile(q)
F['vix_pctile']=P['vix_close'].rolling(252).apply(lambda x:(x[-1]>x).mean(),raw=True)
F['vix_c5']=chg('vix_close',5); F['nq_r5']=ret('nq_close',5)
F['hyglqd']=P['hyg_close']/P['lqd_close']; F['hyglqd_z']=z(F['hyglqd'],60)
F['hyg_vs_spy_5']=ret('hyg_close',5)-ret('spy_close',5)
F['iwm_vs_spy_5']=ret('iwm_close',5)-ret('spy_close',5)
comp=pd.DataFrame(index=P.index)
comp['credit']=-z(ret('hyg_close',5),120); comp['dollar']=z(ret('dxy_close',5),120)
comp['vix']=z(chg('vix_close',5),120); comp['bonds']=z(ret('tlt_close',5),120)
comp['gold']=z(ret('gld_close',5),120); F['riskoff']=comp.mean(axis=1)

# LEADING-divergence shorts: macro weak WHILE equity still up (short the strength)
sigs={
 'VIX_top_decile':      F['vix_pctile']>=0.90,
 'riskoff_top10':       F['riskoff']>=pct(F['riskoff'],0.90),
 'LEAD credit<spy & NQup': (F['hyg_vs_spy_5']<=pct(F['hyg_vs_spy_5'],0.10))&(F['nq_r5']>0),
 'LEAD breadth<spy & NQup':(F['iwm_vs_spy_5']<=pct(F['iwm_vs_spy_5'],0.10))&(F['nq_r5']>0),
 'LEAD VIXup & NQup':    (F['vix_c5']>0)&(F['nq_r5']>0.01),
 'LEAD credwiden & NQup':(F['hyglqd_z']<=-1.0)&(F['nq_r5']>0),
}
print("SHORT directional move (dir=-1; positive=short profits). win% in parens. Full history.")
print(f"{'signal':28s}"+"".join(f"{'h='+str(h):>16s}" for h in (3,5,10,20)))
for nm,mask in sigs.items():
    sig=P.index[mask.fillna(False).values]
    line=f"{nm:28s}"
    for h in (3,5,10,20):
        r=measure(P,sig,-1,h)
        if len(r)<20: line+=f"{'n/a':>16s}"; continue
        line+=f"{r['move'].mean():+7.0f}({(r['move']>0).mean():.2f},{len(r)})"
    print(line)
print("\nInterpretation: positive mean + win%>0.50 across horizons = a real short. "
      "Negative/<0.50 = NQ rises after signal (short loses).")
