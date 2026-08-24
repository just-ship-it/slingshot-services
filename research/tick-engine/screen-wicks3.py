#!/usr/bin/env python3
"""Can the wick effect clear costs anywhere? Scan timeframe × horizon × tail-depth, all four cells."""
import pandas as pd, numpy as np, itertools, warnings
warnings.filterwarnings('ignore')
PT = {'NQ':20.0,'ES':50.0}
def prep(P, TF, H):
    d = pd.read_csv(f"wicks/{P}_{TF}_wicks.csv")
    d = d[d.n1s >= 30].reset_index(drop=True)
    d['atr'] = d.rangeTicks.rolling(14).mean()
    d['fwd'] = (d.c.shift(-H) - d.c) / (d.atr*0.25)
    d = d[d.tradeDate == d.tradeDate.shift(-H)]
    d['upRel'] = d.upWickTicks/d.rangeTicks.clip(lower=1)
    d['skew'] = d.upVolPct - d.dnVolPct
    d['dev'] = d.tradeDate <= '2024-12-31'
    d = d.dropna(subset=['fwd','atr'])
    d.attrs['cost'] = (5.0 + 0.5*PT[P]) / (d.atr.mean()*0.25*PT[P])
    return d
print(f"{'tf':>4} {'H':>3} {'feat':>6} {'cost(ATR)':>10} | {'NQdev':>8} {'NQval':>8} {'ESdev':>8} {'ESval':>8} | {'tail@10%':>9} {'verdict':>12}")
best=[]
for TF, H in itertools.product(['3m','5m','15m'], [1,2,3,6,12]):
    for feat in ['upRel','skew']:
        cells=[]; tails=[]; cost=None
        for P in ['NQ','ES']:
            d = prep(P,TF,H); cost = cost or d.attrs['cost']
            if P=='NQ': cost_nq = d.attrs['cost']
            for isdev in (True,False):
                x = d[d.dev==isdev]
                q = pd.qcut(x[feat],5,labels=False,duplicates='drop')
                g = x.groupby(q,observed=True).fwd.mean()
                cells.append(g.iloc[-1]-g.iloc[0] if len(g)>=2 else np.nan)
                if P=='NQ' and isdev:
                    dq = pd.qcut(x[feat],10,labels=False,duplicates='drop')
                    gg = x.groupby(dq,observed=True).fwd.mean()
                    tails.append(gg.iloc[-1]-gg.iloc[0] if len(gg)>=2 else np.nan)
        ok = all(np.sign(c)==np.sign(cells[0]) for c in cells if not np.isnan(c)) and not any(np.isnan(cells))
        tail = tails[0] if tails else np.nan
        clears = ok and abs(tail) > cost_nq
        v = "★ CLEARS COST" if clears else ("consistent" if ok else "flips")
        print(f"{TF:>4} {H:>3} {feat:>6} {cost_nq:>10.3f} | {cells[0]:+8.4f} {cells[1]:+8.4f} {cells[2]:+8.4f} {cells[3]:+8.4f} | {tail:+9.4f} {v:>12}")
        if clears: best.append((TF,H,feat,tail,cost_nq))
print("\ntail@10% = NQ dev top-decile minus bottom-decile spread (the tradable extreme).")
print("A config 'clears cost' when |tail spread| > round-trip cost AND all four cells agree in sign.")
if best: print("\nCandidates:", best)
