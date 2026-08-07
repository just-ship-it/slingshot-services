#!/usr/bin/env python3
"""
M2-04 Track B family 3: MEAN-REVERSION / OVEREXTENSION.
Mechanism: after an outsized short-horizon move, liquidity providers/speculative
positioning overshoot and partially revert (esp. gold, a store-of-value with no
cashflow to justify momentum at short horizons). Tests: N-day return z-score fade,
RSI-style extremes. Fade direction = opposite the stretch. Baseline = unconditional.
"""
import pandas as pd, numpy as np
import M2_lib as L

def rsi(close, n=14):
    d=close.diff(); up=d.clip(lower=0); dn=(-d).clip(lower=0)
    ru=up.ewm(alpha=1/n,adjust=False).mean(); rd=dn.ewm(alpha=1/n,adjust=False).mean()
    rs=ru/rd.replace(0,np.nan); return 100-100/(1+rs)

def zfade(sym):
    df=L.load(sym)
    print(f"\n{'='*72}\n  {sym.upper()} — N-DAY RETURN Z-SCORE FADE (enter next open, hold M; fade the stretch)\n{'='*72}")
    print(f"  {'lookN':>5} {'z':>4} {'hold':>4} {'side':>5} | {'n':>4} {'WR%':>5} {'mean$':>7} {'tot$':>9} {'PF':>4} {'t':>5} | base(sameDir)")
    best=None
    for N in [3,5,10]:
        r=df["close"].pct_change(N)
        mu=r.rolling(252).mean().shift(1); sd=r.rolling(252).std().shift(1)
        z=(r-mu)/sd
        for zt in [1.0,1.5,2.0]:
            for hold in [3,5,10]:
                # stretched DOWN -> long (fade); stretched UP -> short (fade)
                long_mask=(z<=-zt); short_mask=(z>=zt)
                for side,mask,d in [("long",long_mask,1),("short",short_mask,-1)]:
                    tr=L.simulate(df,mask.fillna(False),d,hold,sym,min_gap=1)
                    s=L.stats(tr,sym)
                    if s['n']<25: continue
                    base=L.baseline_forward(df,hold,sym,d)
                    flag="  <" if s['pf']>1.1 and s['n']>=40 else ""
                    print(f"  {N:>5} {zt:>4.1f} {hold:>4} {side:>5} | {s['n']:>4} {s['wr']*100:>5.1f} {s['mean_usd']:>7.0f} {s['tot_usd']:>9.0f} {s['pf']:>4.2f} {s['sharpe']:>5.2f} | ${base['mean_usd']:.0f}{flag}")
                    if s['n']>=50 and (best is None or s['sharpe']>best[1]['sharpe']):
                        best=((N,zt,hold,side,mask.fillna(False),d),s)
    return df,best

def detail(sym,df,spec,label):
    (N,zt,hold,side,mask,d),s=spec
    tr=L.simulate(df,mask,d,hold,sym,min_gap=1)
    print(f"\n  --- {sym.upper()} {label}: N={N} z={zt} hold={hold} {side} ---")
    print("  overall:",L.fmt_stats(s))
    yrs=L.per_year(tr,sym); pos=sum(1 for y,ss in yrs if ss.get('mean_usd',0)>0)
    print(f"  per-year: {pos}/{len(yrs)} positive; ", " ".join(f"{str(y)[2:]}:{ss.get('mean_usd',0):+.0f}" for y,ss in yrs if ss.get('n',0)))
    for name,ss in L.per_regime(tr,sym): print(f"    {name:18}: {L.fmt_stats(ss)}")
    pm,_=L.placebo(df,s['n'],d,hold,sym,iters=300)
    print(f"  placebo p={(pm>=s['mean_usd']).mean():.3f} (plc ${pm.mean():.0f}+/-{pm.std():.0f})")

if __name__=="__main__":
    for sym in ["gc","cl"]:
        df,b=zfade(sym)
        if b: detail(sym,df,b,"zfade-best(by t)")
