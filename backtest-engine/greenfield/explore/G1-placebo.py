#!/usr/bin/env python3
"""G1 STEP 3 — placebo: does breakout TIMING beat random same-direction entries
matched by count + holding period? Reproduce M2's p=0.000 independently."""
import numpy as np, pandas as pd
from G1_donchian import load, backtest, PT, RT_COST

def random_pnl(df, n_long, n_short, H, rng):
    o=df["open"].values; c=df["close"].values; n=len(df)
    lo, hi = 100, n-H-1   # valid entry range (need channel warmup + H fwd)
    total=0.0
    for sig,cnt in ((1,n_long),(-1,n_short)):
        idx=rng.integers(lo,hi,size=cnt)
        for e in idx:
            ex=min(e+H,n-1)
            total += sig*(c[ex]-o[e])*PT - RT_COST
    return total

if __name__=="__main__":
    df=load()
    N,H=100,42
    tr=backtest(df,N,H,"fixed")
    n_long=sum(1 for t in tr if t["sig"]==1); n_short=sum(1 for t in tr if t["sig"]==-1)
    actual=sum(t["net"] for t in tr)
    print(f"Actual Donchian {N}/{H}: {len(tr)} trades ({n_long}L/{n_short}S), total=${actual:,.0f}")

    rng=np.random.default_rng(42)
    NSIM=10000
    sims=np.array([random_pnl(df,n_long,n_short,H,rng) for _ in range(NSIM)])
    p=(sims>=actual).mean()
    print(f"\nPlacebo: {NSIM} random same-direction, count/hold-matched draws")
    print(f"  random total: mean=${sims.mean():,.0f} sd=${sims.std():,.0f} "
          f"p95=${np.percentile(sims,95):,.0f} max=${sims.max():,.0f}")
    print(f"  actual=${actual:,.0f}  ->  p(random>=actual) = {p:.4f}")

    # Also placebo on OOS-only (2018+) to confirm timing edge is not just drift capture
    tro=[t for t in tr if t["exit_date"].year>=2018]
    nlo=sum(1 for t in tro if t["sig"]==1); nso=sum(1 for t in tro if t["sig"]==-1)
    # restrict random draws to OOS index window
    d2018=df.index[df["date"]>=pd.Timestamp("2018-01-01")][0]
    sub=df.iloc[d2018-101:].reset_index(drop=True)
    acto=sum(t["net"] for t in tro)
    sims2=np.array([random_pnl(sub,nlo,nso,H,rng) for _ in range(NSIM)])
    p2=(sims2>=acto).mean()
    print(f"\nOOS-only placebo (2018+): actual=${acto:,.0f} ({nlo}L/{nso}S) "
          f"random mean=${sims2.mean():,.0f} -> p={p2:.4f}")
