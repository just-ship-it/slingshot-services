"""T1 — LETF close rebalance x gamma sign.
CLAIM (c-279558356): rebalance lands in the final 30 min every day; positive gamma ->
dealers fade -> close REVERTS; negative gamma -> dealers pile on -> close CASCADES.
LETF flow is proportional to the day's return and momentum-amplifying in BOTH long and
inverse funds, so the day's return through 15:30 is the flow proxy."""
import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd
for prod,sym,pv in (('es','es',50.0),('nq','nq',20.0)):
    d=lib.bars(sym); g=lib.gex(prod)
    S=lib.sessions(d,{'o':570,'m1530':930,'c':960})
    G=lib.daily_gex_sign(g,929)
    M=S.merge(G,on='day',how='inner').dropna(subset=['tot'])
    M['r_day']=100*(M.m1530/M.o-1)          # signal: move through 15:30 (drives rebalance size)
    M['r_cl'] =100*(M.c/M.m1530-1)          # outcome: final 30 min
    M['gpos']=M.tot>0
    print(f"\n{'='*94}\nT1  {sym.upper()}  n={len(M)} days  {M.day.min()} .. {M.day.max()}\n{'='*94}")
    for lbl,sub in (('ALL',M),('positive gamma',M[M.gpos]),('negative gamma',M[~M.gpos])):
        if len(sub)<30: continue
        r=np.corrcoef(sub.r_day,sub.r_cl)[0,1]
        t=r*np.sqrt(len(sub)-2)/np.sqrt(max(1-r**2,1e-12))
        print(f"  {lbl:<16} n={len(sub):>4}  corr(day-move, final-30m) = {r:>+7.4f}  t={t:>+6.2f}"
              f"   {'CASCADE' if r>0 else 'REVERT'}")
    print(f"\n  His prediction: positive gamma -> REVERT (corr<0) ; negative gamma -> CASCADE (corr>0)")
    # tradeable: at 15:30 trade in the direction his rule implies, exit 16:00, 1 contract
    print(f"\n  --- tradeable at 1 contract (${pv:.0f}/pt), entry 15:30 exit 16:00 ---")
    thr=M.r_day.abs().quantile(.5)
    for lbl,fn in (('his rule (pos=fade, neg=chase)',
                    lambda r: (-np.sign(r.r_day) if r.gpos else np.sign(r.r_day))),
                   ('always CHASE the day move',   lambda r: np.sign(r.r_day)),
                   ('always FADE the day move',    lambda r:-np.sign(r.r_day))):
        for extreme in (False,True):
            sub=M[M.r_day.abs()>=thr] if extreme else M
            pnl=[fn(r)*(r.c-r.m1530)*pv for _,r in sub.iterrows()]
            lib.rep(lbl+(' | big-move half' if extreme else ''),pnl,pv,len(sub))
