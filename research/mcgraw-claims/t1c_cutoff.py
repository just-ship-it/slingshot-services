"""Does the LETF x gamma edge survive the PRODUCTION 15:45 ET force-flat?"""
import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd
COST={'es':16.50,'nq':9.00}; PV={'es':50.0,'nq':20.0}
for prod in ('nq','es'):
    d=lib.bars(prod); g=lib.gex(prod)
    S=lib.sessions(d,{'o':570,'m1530':930,'m1535':935,'m1540':940,'m1545':945,'m1550':950,'c':960})
    G=lib.daily_gex_sign(g,929)
    M=S.merge(G,on='day',how='inner').dropna(subset=['tot']).sort_values('day').reset_index(drop=True)
    M['r_day']=100*(M.m1530/M.o-1); M['gpos']=M.tot>0
    M['dow']=pd.to_datetime(M.day).dt.dayofweek
    thr=M.r_day.abs().quantile(.5); pv=PV[prod]; c=COST[prod]
    big=M[M.r_day.abs()>=thr]
    print(f"\n{'='*96}\n{prod.upper()}  exit-time sensitivity (his rule, big-move half, costs applied)\n{'='*96}")
    for exitcol,lbl in (('m1535','15:35 (5m hold)'),('m1540','15:40 (10m)'),
                        ('m1545','15:45 (15m) <- PRODUCTION CUTOFF'),
                        ('m1550','15:50 (20m)'),('c','16:00 (30m) <- backtest')):
        pnl=[(-np.sign(r.r_day) if r.gpos else np.sign(r.r_day))*(r[exitcol]-r.m1530)*pv-c
             for _,r in big.iterrows()]
        lib.rep(lbl,pnl,pv,len(big))
    # how much of the slot is actually available? Monday sleeve holds 09:30-15:45
    nonmon=big[big.dow!=0]
    print(f"\n  slot availability: {len(big)} big-move days total, {len(nonmon)} are non-Monday")
    print(f"  (Monday sleeve occupies the single FCFS slot 09:30-15:45, blocking this window entirely)")
    for exitcol,lbl in (('m1545','15:45 exit, NON-MONDAY only'),('c','16:00 exit, NON-MONDAY only')):
        pnl=[(-np.sign(r.r_day) if r.gpos else np.sign(r.r_day))*(r[exitcol]-r.m1530)*pv-c
             for _,r in nonmon.iterrows()]
        lib.rep(lbl,pnl,pv,len(nonmon))
