"""Lag sensitivity: how old can the GEX snapshot be? (CBOE = 15min delay)"""
import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd
COST={'es':16.50,'nq':9.00}; PV={'es':50.0,'nq':20.0}
for prod in ('nq','es'):
    d=lib.bars(prod); g=lib.gex(prod)
    S=lib.sessions(d,{'o':570,'m1530':930,'m1545':945})
    pv=PV[prod]; c=COST[prod]
    print(f"\n{'='*90}\n{prod.upper()}  GEX snapshot age sensitivity (decision at 15:30)\n{'='*90}")
    for cutoff,lbl in ((929,'15:15 snap  (~15m old) = what we validated / CBOE'),
                       (914,'15:00 snap  (~30m old)'),
                       (899,'14:45 snap  (~45m old)'),
                       (869,'14:15 snap  (~75m old)'),
                       (809,'13:15 snap  (~135m old)'),
                       (719,'11:45 snap  (~3.75h old)')):
        G=lib.daily_gex_sign(g,cutoff)
        M=S.merge(G,on='day',how='inner').dropna(subset=['tot']).sort_values('day').reset_index(drop=True)
        M['r_day']=100*(M.m1530/M.o-1); M['dow']=pd.to_datetime(M.day).dt.dayofweek
        span=(pd.to_datetime(M.day.max())-pd.to_datetime(M.day.min())).days/365.25
        big=M[(M.r_day.abs()>=M.r_day.abs().quantile(.5))&(M.dow!=0)].copy()
        dirn=np.where(big.tot>0,-np.sign(big.r_day),np.sign(big.r_day))
        lib.rep(lbl,(dirn*(big.m1545-big.m1530)*pv-c).values,pv,len(big),years=span)
