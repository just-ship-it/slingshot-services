"""Emit book-letf-daily.csv in the harness contract: date,pnl (net $, 1 NQ, prod 15:45 exit)"""
import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd
d=lib.bars('nq'); g=lib.gex('nq')
S=lib.sessions(d,{'o':570,'m1530':930,'m1545':945}); G=lib.daily_gex_sign(g,929)
M=S.merge(G,on='day',how='inner').dropna(subset=['tot']).sort_values('day').reset_index(drop=True)
M['r_day']=100*(M.m1530/M.o-1); M['gpos']=M.tot>0
thr=M.r_day.abs().quantile(.5)
big=M[M.r_day.abs()>=thr].copy()
big['dirn']=np.where(big.gpos,-np.sign(big.r_day),np.sign(big.r_day))
big['pnl']=big.dirn*(big.m1545-big.m1530)*20.0-9.0
out=big[['day','pnl']].rename(columns={'day':'date'})
out.to_csv('/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore/book-letf-daily.csv',index=False)
print(f"wrote book-letf-daily.csv  n={len(out)}  net=${out.pnl.sum():+,.0f}  {out.date.min()} .. {out.date.max()}")
big[['day','dirn','r_day','tot','gpos','pnl']].to_csv('letf_signals.csv',index=False)
