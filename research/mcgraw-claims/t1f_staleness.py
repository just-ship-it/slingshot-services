"""How stale can the GEX sign be before the LETF edge dies?
Strategy needs ONE BIT/day: sign(total_gex) at 15:29. Test lagged signs."""
import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd
COST={'es':16.50,'nq':9.00}; PV={'es':50.0,'nq':20.0}
for prod in ('nq','es'):
    d=lib.bars(prod); g=lib.gex(prod)
    S=lib.sessions(d,{'o':570,'m1530':930,'m1545':945}); G=lib.daily_gex_sign(g,929)
    M=S.merge(G,on='day',how='inner').dropna(subset=['tot']).sort_values('day').reset_index(drop=True)
    M['r_day']=100*(M.m1530/M.o-1); M['sign']=np.sign(M.tot)
    M['dow']=pd.to_datetime(M.day).dt.dayofweek
    span=(pd.to_datetime(M.day.max())-pd.to_datetime(M.day.min())).days/365.25
    pv=PV[prod]; c=COST[prod]
    print(f"\n{'='*92}\n{prod.upper()}  GEX-sign persistence  (n={len(M)})\n{'='*92}")
    for lag in (1,2,3,5,10):
        agree=(M['sign']==M['sign'].shift(lag)).mean()
        print(f"  sign(t) == sign(t-{lag:>2}) : {100*agree:>5.1f}%")
    # Monday-only refresh: carry each week's FIRST available sign across the week
    M['wk']=pd.to_datetime(M.day).dt.isocalendar().week.astype(int)
    M['yr']=pd.to_datetime(M.day).dt.year
    first=M.groupby(['yr','wk'])['sign'].transform('first')
    print(f"  weekly-carry (Mon sign all week) agrees with live: {100*(M['sign']==first).mean():.1f}%")
    print(f"\n  --- PnL with STALE sign (1s-honest window is 15:30-15:45, 1m marks here, non-Monday) ---")
    big=M[(M.r_day.abs()>=M.r_day.abs().quantile(.5))&(M.dow!=0)].copy()
    firstb=big.groupby([big.yr,big.wk])['sign'].transform('first')
    for lbl,sg in (('LIVE sign (today 15:29)',big['sign']),
                   ('sign lagged 1 day',big['sign'].shift(1)),
                   ('sign lagged 2 days',big['sign'].shift(2)),
                   ('sign lagged 5 days',big['sign'].shift(5)),
                   ('WEEKLY carry (first of week)',firstb)):
        s=sg.copy()
        m=s.notna()
        dirn=np.where(s[m]>0,-np.sign(big.r_day[m]),np.sign(big.r_day[m]))
        p=dirn*(big.m1545[m]-big.m1530[m])*pv-c
        lib.rep(lbl,p.values,pv,int(m.sum()),years=span)
