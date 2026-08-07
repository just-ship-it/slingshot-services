#!/usr/bin/env python3
"""
M1-05: Correlation of macro-swing signals to the existing intraday-long book.
Builds daily mark-to-market PnL ($20/NQ pt, 1 contract while 'in the trade') for:
  - FADE-FEAR LONG (VIX top decile, riskoff top decile)  [the only signals with edge]
  - hypothetical DEFENSIVE SHORT (riskoff top decile, dir=-1) [for completeness/hedge test]
Correlates with each book member + combined book over 2021-2026.
Then: behaviour on the book's WORST drawdown days (does it earn when the book bleeds?).
"""
import pandas as pd, numpy as np
from m1_common import load_panel, build_features

P=load_panel(); F=build_features(P)
def ret(c,n=1): return P[c].pct_change(n)
def chg(c,n=1): return P[c].diff(n)
def z(s,w): return (s-s.rolling(w).mean())/s.rolling(w).std()
def pct(s,q): return s.rolling(252,min_periods=120).quantile(q)
F['vix_pctile']=P['vix_close'].rolling(252).apply(lambda x:(x[-1]>x).mean(),raw=True)
comp=pd.DataFrame(index=P.index)
comp['credit']=-z(ret('hyg_close',5),120); comp['dollar']=z(ret('dxy_close',5),120)
comp['vix']=z(chg('vix_close',5),120); comp['bonds']=z(ret('tlt_close',5),120)
comp['gold']=z(ret('gld_close',5),120); F['riskoff']=comp.mean(axis=1)

DOLLAR_PER_PT=20.0
H=5
def daily_mtm(mask, direction):
    """1-contract MTM PnL series: in-market (dir) if a signal fired in trailing H days."""
    sig=mask.fillna(False).values
    n=len(P); active=np.zeros(n,dtype=int)
    idx=np.where(sig)[0]
    for i in idx:
        a=i+1; b=min(i+H, n-1)          # hold entry(i+1) .. i+H close
        active[a:b+1]=direction
    cc=P['nq_close'].values
    dpnl=np.zeros(n)
    for t in range(1,n):
        if active[t]!=0:
            dpnl[t]=active[t]*(cc[t]-cc[t-1])*DOLLAR_PER_PT
    return pd.Series(dpnl,index=P.index)

series={
 'FADE_LONG_VIXtop':   daily_mtm(F['vix_pctile']>=0.90, +1),
 'FADE_LONG_riskoff':  daily_mtm(F['riskoff']>=pct(F['riskoff'],0.90), +1),
 'SHORT_riskoff(hedge)': daily_mtm(F['riskoff']>=pct(F['riskoff'],0.90), -1),
}

# book
def bk(f):
    d=pd.read_csv(f+'.csv',parse_dates=['date']).set_index('date')['pnl']; return d
pcc=bk('book-pcc-daily'); mon=bk('book-monday-daily'); gap=bk('book-gapfade-daily')
alldates=pcc.index.union(mon.index).union(gap.index)
book=pd.DataFrame(index=alldates)
book['pcc']=pcc.reindex(alldates,fill_value=0)
book['monday']=mon.reindex(alldates,fill_value=0)
book['gapfade']=gap.reindex(alldates,fill_value=0)
book['combined']=book.sum(axis=1)

# align on book trading days within 2021-2026
lo,hi=pd.Timestamp('2021-01-01'),pd.Timestamp('2026-06-30')
bd=book[(book.index>=lo)&(book.index<=hi)]
print("### Correlation of macro-swing daily PnL vs book (book trading days, 2021-2026) ###")
print(f"{'signal':22s}{'vs pcc':>10s}{'vs monday':>11s}{'vs gapfade':>12s}{'vs combined':>13s}{'sig$mean':>10s}")
for nm,s in series.items():
    a=s.reindex(bd.index,fill_value=0)
    def c(col):
        x=bd[col];
        return np.corrcoef(a.values,x.values)[0,1] if a.std()>0 else np.nan
    print(f"{nm:22s}{c('pcc'):>10.3f}{c('monday'):>11.3f}{c('gapfade'):>12.3f}{c('combined'):>13.3f}{a.mean():>10.1f}")

# also correlation on ALL calendar trading days (macro signal is active on many non-book days)
print("\n(note: above uses only ~book trading days; macro swing is active most days)")

# ---- behaviour on book's worst days ----
print("\n### Book's WORST 20 combined days: what does each macro signal earn? ###")
worst=bd['combined'].nsmallest(20)
print(f"book worst-20 mean = ${worst.mean():.0f}/day, total ${worst.sum():.0f}")
for nm,s in series.items():
    a=s.reindex(bd.index,fill_value=0)
    on_worst=a.reindex(worst.index,fill_value=0)
    # next-5-day sum after each worst day (swing recovery capture)
    fwd=[]
    for d in worst.index:
        pos=P.index.get_indexer([d])[0]
        if pos>=0 and pos+5<len(P):
            fwd.append(s.iloc[pos+1:pos+6].sum())
    print(f"  {nm:22s} same-day ${on_worst.mean():+7.0f}/day (tot ${on_worst.sum():+.0f}) | "
          f"next-5d-sum after worst days mean ${np.mean(fwd):+.0f}")

# full-period annualized-ish stats for the fade-long
print("\n### FADE_LONG_VIXtop standalone (2021-2026, book days only, $20/pt, 1 contract) ###")
a=series['FADE_LONG_VIXtop'].reindex(bd.index,fill_value=0)
act=a[a!=0]
print(f"  active days={len(act)} total ${a.sum():.0f} mean/active ${act.mean():.0f} "
      f"daily sharpe(active)={act.mean()/act.std():.3f}")
