"""Fine entry/exit grid + per-year stability + bootstrap. Is 15:45 real or a lucky peak?"""
import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd
COST={'es':16.50,'nq':9.00}; PV={'es':50.0,'nq':20.0}
EX=list(range(935,976,5))          # 15:35 .. 16:15
rng=np.random.default_rng(11)
for prod in ('nq','es'):
    d=lib.bars(prod); g=lib.gex(prod)
    marks={'o':570,'m1530':930}; marks.update({f'x{m}':m for m in EX})
    S=lib.sessions(d,marks); G=lib.daily_gex_sign(g,929)
    M=S.merge(G,on='day',how='inner').dropna(subset=['tot']).sort_values('day').reset_index(drop=True)
    M['r_day']=100*(M.m1530/M.o-1); M['gpos']=M.tot>0
    M['yr']=pd.to_datetime(M.day).dt.year
    big=M[M.r_day.abs()>=M.r_day.abs().quantile(.5)].copy()
    big['dirn']=np.where(big.gpos,-np.sign(big.r_day),np.sign(big.r_day))
    pv=PV[prod]; c=COST[prod]
    print(f"\n{'='*104}\n{prod.upper()}  exit grid  (n={len(big)}, costs applied)\n{'='*104}")
    print(f"{'exit':>8}{'PF':>7}{'net':>11}{'maxDD':>10}{'Sharpe':>8}   per-year net")
    res={}
    for m in EX:
        p=(big.dirn*(big[f'x{m}']-big.m1530)*pv-c).values
        w=p[p>0]; l=p[p<=0]; pf=w.sum()/abs(l.sum()) if len(l) else 9.99
        eq=np.cumsum(p); dd=(np.maximum.accumulate(eq)-eq).max()
        sh=p.mean()/p.std()*np.sqrt(252) if p.std()>0 else 0
        yrs=[f"{y}:{p[(big.yr==y).values].sum():+,.0f}" for y in sorted(big.yr.unique())]
        hh=m//60; mm=m%60
        res[m]=p
        print(f"{hh:02d}:{mm:02d}{pf:>7.2f}{p.sum():>+11,.0f}{dd:>10,.0f}{sh:>8.2f}   {'  '.join(yrs)}")
    # is 15:45 significantly better than 16:00? paired bootstrap on daily differences
    a,b=res[945],res[960]
    diff=a-b
    bs=[rng.choice(diff,len(diff),replace=True).sum() for _ in range(5000)]
    lo,hi=np.percentile(bs,[2.5,97.5])
    print(f"\n  15:45 minus 16:00 : ${diff.sum():+,.0f}   bootstrap 95% CI [${lo:+,.0f}, ${hi:+,.0f}]"
          f"   {'SIGNIFICANT' if lo>0 or hi<0 else 'NOT significant — exit choice is noise'}")
