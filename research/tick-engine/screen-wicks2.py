#!/usr/bin/env python3
"""Is the wick signal INCREMENTAL to simple mean-reversion? Double-sort: within quintiles of the
   candle's own return, does the wick feature still separate forward returns? Plus a cost yardstick."""
import sys
import pandas as pd, numpy as np
TF = sys.argv[1] if len(sys.argv)>1 else '5m'
def prep(P, ptval):
    d = pd.read_csv(f"wicks/{P}_{TF}_wicks.csv")
    d = d[d.n1s >= 30].reset_index(drop=True)
    d['atr'] = d.rangeTicks.rolling(14).mean()
    d['fwd'] = (d.c.shift(-1) - d.c) / (d.atr*0.25)
    d = d[d.tradeDate == d.tradeDate.shift(-1)]
    d['own'] = (d.c - d.o) / (d.atr*0.25)                      # this candle's own return, ATR units
    d['upRel'] = d.upWickTicks / d.rangeTicks.clip(lower=1)
    d['dnRel'] = d.dnWickTicks / d.rangeTicks.clip(lower=1)
    d['wickSkew'] = d.upVolPct - d.dnVolPct                    # volume imbalance between the wicks
    d['dev'] = d.tradeDate <= '2024-12-31'
    d = d.dropna(subset=['fwd','atr','own'])
    # cost yardstick: $5 RT + 0.5pt round-trip slippage, in ATR units
    atr_pts = d.atr.mean()*0.25
    d.attrs['costATR'] = (5.0 + 0.5*ptval) / (atr_pts*ptval)
    d.attrs['atr_pts'] = atr_pts
    return d
for P, ptval in (('NQ',20.0), ('ES',50.0)):
    d = prep(P, ptval)
    print(f"\n=== {P} {TF} === mean ATR {d.attrs['atr_pts']:.1f} pts = ${d.attrs['atr_pts']*ptval:,.0f} | "
          f"round-trip cost ≈ {d.attrs['costATR']:.3f} ATR  ← any edge must clear this")
    for feat in ['upRel','wickSkew']:
        print(f"\n  {feat}: forward return by feature quintile, WITHIN own-return quintile (dev only)")
        dd = d[d.dev].copy()
        dd['ownQ'] = pd.qcut(dd.own, 5, labels=False, duplicates='drop')
        dd['fQ']  = dd.groupby('ownQ', observed=True)[feat].transform(lambda s: pd.qcut(s, 5, labels=False, duplicates='drop'))
        tab = dd.groupby(['ownQ','fQ'], observed=True).fwd.mean().unstack()
        print('    ownQ ' + ''.join(f'{c:>9}' for c in tab.columns) + '     spread')
        spreads=[]
        for i,row in tab.iterrows():
            sp = row.iloc[-1]-row.iloc[0]; spreads.append(sp)
            print(f'    {i:>4} ' + ''.join(f'{v:+9.4f}' for v in row.values) + f'  {sp:+9.4f}')
        print(f"    mean within-bucket spread {np.mean(spreads):+.4f} ATR  (raw uncontrolled spread was ~{dd.groupby(pd.qcut(dd[feat],5,labels=False,duplicates='drop'),observed=True).fwd.mean().iloc[-1]-dd.groupby(pd.qcut(dd[feat],5,labels=False,duplicates='drop'),observed=True).fwd.mean().iloc[0]:+.4f})")
