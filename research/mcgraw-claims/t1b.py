import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd
COST={'es':4.0+12.50, 'nq':4.0+5.00}     # commission RT + 1 tick slippage
PV={'es':50.0,'nq':20.0}
for prod in ('es','nq'):
    d=lib.bars(prod); g=lib.gex(prod)
    S=lib.sessions(d,{'o':570,'m1500':900,'m1530':930,'c':960}); G=lib.daily_gex_sign(g,929)
    M=S.merge(G,on='day',how='inner').dropna(subset=['tot']).sort_values('day').reset_index(drop=True)
    M['r_day']=100*(M.m1530/M.o-1); M['gpos']=M.tot>0
    M['pts']=(M.c-M.m1530)
    M['yr']=pd.to_datetime(M.day).dt.year
    thr=M.r_day.abs().quantile(.5)
    pv=PV[prod]; c=COST[prod]
    def pnl(sub,mode):
        s=[]
        for _,r in sub.iterrows():
            if mode=='his':  dirn=(-np.sign(r.r_day) if r.gpos else np.sign(r.r_day))
            elif mode=='fade': dirn=-np.sign(r.r_day)
            elif mode=='gexonly': dirn=(1 if r.gpos else -1)
            if dirn==0: continue
            s.append(dirn*r.pts*pv-c)
        return np.array(s)
    print(f"\n{'='*100}\n{prod.upper()}  — costs applied (${c:.2f}/RT: $4 comm + 1 tick slip), 1 contract\n{'='*100}")
    big=M[M.r_day.abs()>=thr]
    for lbl,sub,mode in (('his rule, ALL days',M,'his'),
                         ('his rule, big-move half',big,'his'),
                         ('always fade, ALL days',M,'fade'),
                         ('always fade, big-move half',big,'fade'),
                         ('gamma-sign only (no day move)',M,'gexonly')):
        lib.rep(lbl,pnl(sub,mode),pv,len(sub))
    print(f"\n  --- what the GAMMA SPLIT adds: negative-gamma days only ---")
    ng=big[~big.gpos]
    lib.rep('  neg-gamma big moves: CHASE (his)',pnl(ng,'his'),pv,len(ng))
    lib.rep('  neg-gamma big moves: FADE (naive)',pnl(ng,'fade'),pv,len(ng))
    print(f"\n  --- year by year, his rule on big-move half ---")
    for y,sub in big.groupby('yr'):
        if len(sub)<25: continue
        a=pnl(sub,'his'); w=a[a>0]; l=a[a<=0]
        pf=w.sum()/abs(l.sum()) if len(l) and l.sum()!=0 else 9.99
        print(f"    {y}  n={len(a):>4}  PF={pf:>4.2f}  net=${a.sum():>+9,.0f}")
