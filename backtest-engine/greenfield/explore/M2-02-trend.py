#!/usr/bin/env python3
"""
M2-02 Track B family 1: TREND / MOMENTUM (long & short).
Mechanism: commodities carry a structural CTA/time-series-momentum premium — trends
persist because of slow supply/demand adjustment and producer/consumer hedging flow.
Tests: time-series momentum (sign of trailing R-day return), Donchian breakout, MA cross.
"""
import pandas as pd, numpy as np, sys
import M2_lib as L

def tsmom(sym):
    df = L.load(sym)
    print(f"\n{'='*72}\n  {sym.upper()} — TIME-SERIES MOMENTUM (dir=sign of trailing R-day ret, N-day hold, non-overlap)\n{'='*72}")
    print(f"  {'lookR':>6} {'hold':>5} | {'n':>4} {'WR%':>5} {'mean$':>7} {'tot$':>9} {'PF':>4} {'t':>5} | baseLong drift")
    best=None
    for R in [21, 42, 63, 126, 189, 250]:
        trail = df["close"]/df["close"].shift(R) - 1.0
        for hold in [5, 10, 21, 42]:
            dirs = np.sign(trail.fillna(0)).values
            mask = (~trail.isna())
            tr = L.simulate(df, mask, dirs, hold, sym, min_gap=1)
            s = L.stats(tr, sym)
            base = L.baseline_forward(df, hold, sym, 1)
            flag = "  <" if (s.get('pf',0) and s['pf']>1.05 and s['n']>40) else ""
            print(f"  {R:>6} {hold:>5} | {s['n']:>4} {s['wr']*100:>5.1f} {s['mean_usd']:>7.0f} {s['tot_usd']:>9.0f} {s['pf']:>4.2f} {s['sharpe']:>5.2f} | base mean=${base['mean_usd']:.0f}{flag}")
            if s['n']>40 and (best is None or s['tot_usd']>best[1]['tot_usd']):
                best=((R,hold,dirs,mask),s)
    return df, best

def donchian(sym):
    df = L.load(sym)
    print(f"\n{'='*72}\n  {sym.upper()} — DONCHIAN BREAKOUT (close breaks N-day extreme -> trade dir, M-day hold)\n{'='*72}")
    print(f"  {'chan':>5} {'hold':>5} | {'n':>4} {'WR%':>5} {'mean$':>7} {'tot$':>9} {'PF':>4} {'t':>5}")
    best=None
    for chan in [20, 40, 55, 100]:
        hh = df["high"].rolling(chan).max().shift(1)
        ll = df["low"].rolling(chan).min().shift(1)
        up = df["close"] > hh
        dn = df["close"] < ll
        sig = up | dn
        dirs = np.where(up, 1, np.where(dn, -1, 0))
        for hold in [10, 21, 42, 63]:
            tr = L.simulate(df, sig, dirs, hold, sym, min_gap=1)
            s = L.stats(tr, sym)
            print(f"  {chan:>5} {hold:>5} | {s['n']:>4} {s['wr']*100:>5.1f} {s['mean_usd']:>7.0f} {s['tot_usd']:>9.0f} {s['pf']:>4.2f} {s['sharpe']:>5.2f}")
            if s['n']>30 and (best is None or s['tot_usd']>best[1]['tot_usd']):
                best=((chan,hold,dirs,sig),s)
    return df, best

def detail(sym, df, spec, label):
    (a,b,dirs,mask), s = spec
    tr = L.simulate(df, mask, dirs, b if False else b, sym, min_gap=1)
    print(f"\n  --- {sym.upper()} {label} detail (param={a}, hold={b}) ---")
    print("  overall:", L.fmt_stats(s))
    # per year sign stability
    yrs = L.per_year(tr, sym)
    pos = sum(1 for y,ss in yrs if ss.get('mean_usd',0)>0); tot=len(yrs)
    print(f"  per-year: {pos}/{tot} years positive mean")
    line="   "
    for y,ss in yrs:
        if ss.get('n',0)==0: continue
        line += f" {str(y)[2:]}:{ss['mean_usd']:+.0f}"
    print(line)
    print("  per-regime:")
    for name,ss in L.per_regime(tr, sym):
        print(f"    {name:18}: {L.fmt_stats(ss)}")
    # placebo
    dseries = pd.Series(dirs, index=df.index)
    # use median direction for placebo (approx). Run placebo with same n and hold, random dir per entry via majority
    pm, pt = L.placebo(df, s['n'], dirs, b, sym, iters=300)
    p = (pm >= s['mean_usd']).mean()
    print(f"  placebo(300x random entries, same signed dirs): mean$ p={p:.3f}  (placebo mean$ ~ {pm.mean():.0f} +/- {pm.std():.0f})")
    return tr

if __name__=="__main__":
    for sym in ["gc","cl"]:
        df,b = tsmom(sym)
        if b: detail(sym, df, b, "TSMOM-best")
    for sym in ["gc","cl"]:
        df,b = donchian(sym)
        if b: detail(sym, df, b, "Donchian-best")
