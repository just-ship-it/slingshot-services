#!/usr/bin/env python3
"""Do wick-anatomy features predict the NEXT candle? Full discipline: dev/val split, both products,
   forward returns in ATR units, decile buckets vs the unconditional base rate."""
import sys
import pandas as pd, numpy as np
TF = sys.argv[1] if len(sys.argv)>1 else '5m'
H  = int(sys.argv[2]) if len(sys.argv)>2 else 1          # forward horizon in candles
def prep(P):
    d = pd.read_csv(f"wicks/{P}_{TF}_wicks.csv")
    d = d[d.n1s >= 30].reset_index(drop=True)
    d['atr'] = d.rangeTicks.rolling(14).mean()
    d['fwd'] = (d.c.shift(-H) - d.c) / (d.atr*0.25)      # forward return in ATR units
    d = d[d.tradeDate == d.tradeDate.shift(-H)]          # same session only
    d['up'] = d.c >= d.o
    d['upRel'] = d.upWickTicks / d.rangeTicks.clip(lower=1)
    d['dnRel'] = d.dnWickTicks / d.rangeTicks.clip(lower=1)
    d['upInt'] = d.upVolPct / d.upTimePct.replace(0,np.nan)
    d['dnInt'] = d.dnVolPct / d.dnTimePct.replace(0,np.nan)
    d['dev'] = d.tradeDate <= '2024-12-31'
    return d.dropna(subset=['fwd','atr'])
F = ['upVolPct','dnVolPct','upCentroidV','dnCentroidV','upTouches','dnTouches','upInt','dnInt','upRel','dnRel']
NQ, ES = prep('NQ'), prep('ES')
print(f"=== wick features → forward {H}-candle return ({TF}) ===")
print(f"NQ {len(NQ):,} candles (dev {NQ.dev.sum():,}), ES {len(ES):,}\n")
print(f"base rate: NQ dev fwd mean {NQ[NQ.dev].fwd.mean():+.4f} ATR | ES dev {ES[ES.dev].fwd.mean():+.4f}\n")
print(f"{'feature':14s} {'NQ dev spread':>14s} {'NQ val':>9s} {'ES dev':>9s} {'ES val':>9s}   verdict")
rows=[]
for f in F:
    out=[]
    for D in (NQ, ES):
        for isdev in (True, False):
            d = D[D.dev==isdev]
            q = pd.qcut(d[f], 5, labels=False, duplicates='drop')
            g = d.groupby(q, observed=True).fwd.mean()
            out.append(g.iloc[-1]-g.iloc[0] if len(g)>=2 else np.nan)   # top-quintile minus bottom
    nqd,nqv,esd,esv = out
    same = np.sign(nqd)==np.sign(esd) and np.sign(nqd)==np.sign(nqv) and np.sign(nqd)==np.sign(esv)
    v = "★ consistent all 4" if same and abs(nqd)>0.01 else ("sign flips" if not same else "tiny")
    print(f"{f:14s} {nqd:+14.4f} {nqv:+9.4f} {esd:+9.4f} {esv:+9.4f}   {v}")
    rows.append((f,nqd,nqv,esd,esv,same))
print("\n(spread = mean forward return of top quintile minus bottom quintile, in ATR units)")
print("A real effect must keep its sign in all four cells AND be big enough to clear ~0.02 ATR of costs.")
