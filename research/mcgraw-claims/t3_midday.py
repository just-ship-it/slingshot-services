"""T3 - the 12-2pm low-vol box (his A11), futures translation.
Rule: after a local extreme in 12:00-14:00, fade toward the middle, conditioned on
positive GEX + VIX9D/VIX<1.0 + >=60% of daily EM already printed. Exclude Mondays.
T4 - morning vs afternoon break extension (c-309236036: 'morning breaks travel further')."""
import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd
DATA='/home/drew/projects/slingshot-services/backtest-engine/data/'
COST={'es':16.50,'nq':9.00}; PV={'es':50.0,'nq':20.0}
def vseries(f,n):
    x=pd.read_csv(DATA+'macro/'+f); c=[k for k in x.columns if k.lower() in ('datetime','date','time','ts_event')][0]
    v=[k for k in x.columns if k.lower()=='close'][0]
    x=x[[c,v]].copy(); x.columns=['day',n]; x['day']=pd.to_datetime(x.day,utc=True,errors='coerce').dt.date
    return x.dropna()
vix=vseries('vix_1d.csv','vix'); v9=vseries('vix9d_1d.csv','vix9d')
for prod in ('es','nq'):
    d=lib.bars(prod); g=lib.gex(prod); pv=PV[prod]; c=COST[prod]
    S=lib.sessions(d,{'o':570,'m1200':720,'m1400':840,'m1545':945})
    G=lib.daily_gex_sign(g,719)          # causal: last snapshot before noon
    M=S.merge(G,on='day',how='inner').merge(vix,on='day').merge(v9,on='day')
    M['dow']=pd.to_datetime(M.day).dt.dayofweek
    M['ratio']=M.vix9d/M.vix
    M['em']=M.o*(M.vix/100/15.87)                       # rule of 16 daily 1-sigma
    M['pre_rng']=M.hi-M.lo
    M['gpos']=M.tot>0
    M['box']=(M.m1400-M.m1200)*pv                        # noon->2pm move in $
    print(f"\n{'='*92}\nT3  {prod.upper()}  12-2pm box, n={len(M)}\n{'='*92}")
    for lbl,sub in (('all days',M),
                    ('positive GEX',M[M.gpos]),
                    ('pos GEX + VIX9D/VIX<1.0',M[M.gpos&(M.ratio<1.0)]),
                    ('pos GEX + ratio<1.0 + non-Mon',M[M.gpos&(M.ratio<1.0)&(M.dow!=0)])):
        if len(sub)<30: continue
        print(f"  {lbl:<32} n={len(sub):>4}  mean |box| ${sub.box.abs().mean():>6,.0f}  "
              f"median ${sub.box.abs().median():>6,.0f}  mean signed ${sub.box.mean():>+6,.0f}")
    # tradeable: fade the noon->1pm move over 1pm->2pm, gated
    S2=lib.sessions(d,{'o':570,'m1200':720,'m1300':780,'m1400':840})
    M2=S2.merge(G,on='day').merge(vix,on='day').merge(v9,on='day')
    M2['gpos']=M2.tot>0; M2['ratio']=M2.vix9d/M2.vix; M2['dow']=pd.to_datetime(M2.day).dt.dayofweek
    span=(pd.to_datetime(M2.day.max())-pd.to_datetime(M2.day.min())).days/365.25
    for lbl,sub in (('fade 12-1 move over 1-2, ALL',M2),
                    ('  + pos GEX',M2[M2.gpos]),
                    ('  + pos GEX + ratio<1.0',M2[M2.gpos&(M2.ratio<1.0)]),
                    ('  + all gates, non-Monday',M2[M2.gpos&(M2.ratio<1.0)&(M2.dow!=0)])):
        if len(sub)<30: continue
        p=(-np.sign(sub.m1300-sub.m1200)*(sub.m1400-sub.m1300)*pv-c).values
        lib.rep(lbl,p,pv,len(sub),years=span)
