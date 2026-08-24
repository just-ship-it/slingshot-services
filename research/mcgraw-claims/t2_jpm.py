"""T2 - JPM collar quarter-end roll. CLAIM (c-285520867): last trading day of quarter,
~$10B NET TO BUY, lands 14:30-15:30 ET = mechanical bid into the back half."""
import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd
COST={'es':16.50,'nq':9.00}; PV={'es':50.0,'nq':20.0}
for prod in ('nq','es'):
    d=lib.bars(prod)
    S=lib.sessions(d,{'o':570,'m1200':720,'m1430':870,'m1530':930,'m1545':945,'c':960})
    S['dt']=pd.to_datetime(S.day); S['q']=S.dt.dt.quarter; S['yr']=S.dt.dt.year
    last=S.groupby([S.yr,S.q]).tail(1)          # last trading day of each quarter
    S['isqe']=S.day.isin(set(last.day))
    pv=PV[prod]; c=COST[prod]
    S['w']=(S.m1530-S.m1430)*pv                 # his stated window 14:30-15:30
    print(f"\n{'='*88}\n{prod.upper()}  JPM collar: 14:30->15:30 on last trading day of quarter\n{'='*88}")
    qe=S[S.isqe]; oth=S[~S.isqe]
    print(f"  quarter-end days n={len(qe)}   mean ${qe.w.mean():+,.0f}  median ${qe.w.median():+,.0f}  "
          f"%up {100*(qe.w>0).mean():.0f}%")
    print(f"  all other days  n={len(oth)}   mean ${oth.w.mean():+,.0f}  median ${oth.w.median():+,.0f}  "
          f"%up {100*(oth.w>0).mean():.0f}%")
    se=np.sqrt(qe.w.var()/len(qe)+oth.w.var()/len(oth))
    print(f"  difference: ${qe.w.mean()-oth.w.mean():+,.0f}  t={(qe.w.mean()-oth.w.mean())/se:+.2f}")
    lib.rep('  LONG 14:30->15:30 on quarter-end',(qe.w-c).values,pv,len(qe))
    print(f"  per-quarter: "+"  ".join(f"{r.yr}Q{r.q}:{r.w-c:+,.0f}" for _,r in qe.iterrows()))
