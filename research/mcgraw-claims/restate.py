import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd
COST={'es':16.50,'nq':9.00}; PV={'es':50.0,'nq':20.0}
print("CORRECTED annualisation — calendar span, not n_trades/252\n")
for prod in ('nq','es'):
    d=lib.bars(prod); g=lib.gex(prod)
    S=lib.sessions(d,{'o':570,'m1530':930,'m1545':945,'c':960}); G=lib.daily_gex_sign(g,929)
    M=S.merge(G,on='day',how='inner').dropna(subset=['tot']).sort_values('day').reset_index(drop=True)
    M['r_day']=100*(M.m1530/M.o-1); M['gpos']=M.tot>0
    M['dow']=pd.to_datetime(M.day).dt.dayofweek
    span=(pd.to_datetime(M.day.max())-pd.to_datetime(M.day.min())).days/365.25
    big=M[M.r_day.abs()>=M.r_day.abs().quantile(.5)].copy()
    big['dirn']=np.where(big.gpos,-np.sign(big.r_day),np.sign(big.r_day))
    pv=PV[prod]; c=COST[prod]
    print(f"{prod.upper()}  calendar span {span:.2f} yr  ({M.day.min()} .. {M.day.max()})")
    for lbl,sub,ex in (('  15:45 exit, all days',big,'m1545'),
                       ('  15:45 exit, NON-Monday (FCFS)',big[big.dow!=0],'m1545'),
                       ('  16:00 exit, all days',big,'c')):
        p=(sub.dirn*(sub[ex]-sub.m1530)*pv-c).values
        lib.rep(lbl,p,pv,len(sub),years=span)
    print()
