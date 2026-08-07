#!/usr/bin/env python3
"""
M1-02: Focused analysis of shortlisted signals.
 - per-YEAR mean directional move sign (stability)
 - per-REGIME table
 - RECENT-ERA (2018+, 2021+) point distribution + option-relevant hit-rates
 - percent-move version (stationary) for sign consistency
 - placebo test (matched-count random entries)
Prints tables; writes M1-focus-peryear.csv, M1-focus-summary.csv.
"""
import pandas as pd, numpy as np, os
from m1_common import (load_panel, build_features, build_signals, measure,
                       baseline_moves, dist_stats, regime_of, STRESS_WINDOWS)

DIRP=os.path.dirname(os.path.abspath(__file__))
P=load_panel(); F=build_features(P); S=build_signals(P,F)

def pct_moves(P, entry_dates, direction, h):
    """percent directional move: dir*(exit_close/entry_open - 1)*100"""
    o=P['nq_open'].values; c=P['nq_close'].values; dates=P.index
    pos={d:i for i,d in enumerate(dates)}
    out=[]
    for D in entry_dates:
        i=pos.get(D)
        if i is None: continue
        ei=i+1; xi=ei+(h-1)
        if xi>=len(dates): continue
        out.append((D, direction*(c[xi]/o[ei]-1)*100, D.year, regime_of(D)))
    return pd.DataFrame(out,columns=['date','pmove','year','regime'])

H=5  # focus horizon (5d = the swing/option horizon)
summary=[]
peryear_rows=[]
print("="*110)
b5=baseline_moves(P,H).dropna()
bp=(P['nq_close'].shift(-H)/P['nq_open'].shift(-1)-1)*100  # unconditional pct (long)
bp=bp.dropna()
print(f"UNCONDITIONAL {H}d: pts mean={b5.mean():+.1f} med={b5.median():+.1f} | "
      f"pct mean={bp.mean():+.2f}% med={bp.median():+.2f}% wr_up={(bp>0).mean():.3f}")
print("="*110)

for name,(mask,direction,note,fam) in S.items():
    sig=P.index[mask.fillna(False).values]
    r=measure(P,sig,direction,H)
    if len(r)<20: continue
    pm=pct_moves(P,sig,direction,H)
    # baseline directional pct (matched frame)
    base_dir_pct=direction*bp.mean()
    # ---- per-year sign ----
    yrs=pm.groupby('year')['pmove'].agg(['mean','count'])
    pos_years=(yrs['mean']>0).sum(); tot_years=len(yrs)
    peryear_rows.append(pd.DataFrame({'name':name,'year':yrs.index,
                                      'pmove_mean':yrs['mean'].values,'n':yrs['count'].values}))
    # ---- recent eras ----
    def era(lo):
        rr=r[r.signal_date>=pd.Timestamp(lo)]
        pp=pm[pm.date>=pd.Timestamp(lo)]
        if len(rr)<10: return None
        st=dist_stats(rr['move'].values, rr['mfe'].values)
        st['pct_mean']=pp['pmove'].mean(); st['pct_med']=pp['pmove'].median()
        st['mae_med']=np.median(rr['mae'].values); st['mae_p10']=np.percentile(rr['mae'].values,10)
        return st
    e18=era('2018-01-01'); e21=era('2021-01-01')
    # ---- placebo (percent, matched count, in same era 2018+ for fairness) ----
    rng=np.random.default_rng(7)
    pool=P.index[(P.index>=pd.Timestamp('2010-01-01'))&(P.index<P.index[-H])]
    pmv_all=(P['nq_close'].shift(-H)/P['nq_open'].shift(-1)-1)*100*direction
    pmv_all=pmv_all.reindex(pool).dropna()
    nsig=min((pm['date']>=pd.Timestamp('2010-01-01')).sum(), len(pmv_all))
    plc=np.array([rng.choice(pmv_all.values,size=nsig,replace=False).mean() for _ in range(2000)])
    real_pct_2010=pm[pm.date>=pd.Timestamp('2010-01-01')]['pmove'].mean()
    pctile=(plc<real_pct_2010).mean()  # for short, real should be HIGH (more positive dir move) => want high pctile
    summary.append(dict(name=name,family=fam,dir=direction,note=note,
        n=len(r), full_pct_mean=pm['pmove'].mean(), full_pct_med=pm['pmove'].median(),
        pos_years=pos_years, tot_years=tot_years, year_consistency=pos_years/tot_years,
        base_dir_pct=base_dir_pct,
        e18_n=e18['n'] if e18 else 0, e18_pts_med=e18['median'] if e18 else np.nan,
        e18_hit100=e18['hit100'] if e18 else np.nan, e18_hit150=e18['hit150'] if e18 else np.nan,
        e21_n=e21['n'] if e21 else 0, e21_pts_mean=e21['mean'] if e21 else np.nan,
        e21_pts_med=e21['median'] if e21 else np.nan,
        e21_hit100=e21['hit100'] if e21 else np.nan, e21_hit150=e21['hit150'] if e21 else np.nan,
        e21_hit200=e21['hit200'] if e21 else np.nan,
        e21_mae_med=e21['mae_med'] if e21 else np.nan,
        placebo_pctile=pctile, real_pct_2010=real_pct_2010, placebo_mean=plc.mean()))

SUM=pd.DataFrame(summary)
SUM.to_csv(f"{DIRP}/M1-focus-summary.csv",index=False)
pd.concat(peryear_rows).to_csv(f"{DIRP}/M1-focus-peryear.csv",index=False)

pd.set_option('display.width',200,'display.max_columns',40)
print("\n### SUMMARY (H=5d) ###")
print("dir<0 = defensive/short. year_consistency = frac of calendar years with correct-sign mean move.")
print("base_dir_pct = unconditional directional pct (what signal must beat). placebo_pctile: >0.95 => real beats random.\n")
for _,x in SUM.iterrows():
    print(f"{x['name']:24s} dir={int(x['dir']):+d} n={int(x['n']):4d} | fullPct={x['full_pct_mean']:+.2f}% "
          f"(base {x['base_dir_pct']:+.2f}%) yrConsist={x['year_consistency']:.2f} ({int(x['pos_years'])}/{int(x['tot_years'])}) "
          f"| plc%ile={x['placebo_pctile']:.2f}")
    print(f"{'':24s}   2021+: n={int(x['e21_n'])} ptsMean={x['e21_pts_mean']:+.0f} ptsMed={x['e21_pts_med']:+.0f} "
          f"hit100/150/200={x['e21_hit100']:.2f}/{x['e21_hit150']:.2f}/{x['e21_hit200']:.2f} MAEmed={x['e21_mae_med']:+.0f}")

# ---- per-regime table for the strongest defensive candidates ----
print("\n### PER-REGIME directional pct-move (mean) ###")
regs=[w[0] for w in STRESS_WINDOWS]+['calm']
hdr="signal".ljust(24)+"".join(f"{r[:9]:>11s}" for r in regs)
print(hdr)
for name,(mask,direction,note,fam) in S.items():
    sig=P.index[mask.fillna(False).values]
    pm=pct_moves(P,sig,direction,H)
    line=name.ljust(24)
    for rg in regs:
        v=pm[pm.regime==rg]['pmove']
        line+=(f"{v.mean():+7.1f}({len(v):>2d})" if len(v)>0 else f"{'--':>11s}")
    print(line)
