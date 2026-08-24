#!/usr/bin/env python3
"""Proper formulation: split by whether the level sits ABOVE or BELOW spot, control for the window's
   own return (is the footprint incremental to simple reversion?), and price it against costs."""
import pandas as pd, numpy as np, warnings
warnings.filterwarnings('ignore')
d = pd.read_csv("level-episodes/NQ_episodes.csv")
d = d[(d.volTotal>0) & d.fwd60Ticks.notna() & (d.atrTicks>0) & (d.isPlacebo==0)].copy()
d['dev'] = d.tradeDate <= '2024-12-31'
d['f60'] = d.fwd60Ticks/d.atrTicks
d['f15'] = d.fwd15Ticks/d.atrTicks
d['own'] = (d.timeAbove - d.timeBelow)                       # where price sat during the window
d['adist'] = d.distTicks.abs()
COST = 0.026
print(f"real episodes: {len(d):,}   cost line ≈ {COST} ATR (15m NQ)\n")
for src in ['lt','gex']:
    for side, lab in [(1,'level ABOVE spot (resistance)'), (0,'level BELOW spot (support)')]:
        s0 = d[(d.src==src)&(d.adist<=40)&((d.distTicks>0).astype(int)==side)]
        if len(s0) < 2000: continue
        print(f"── {src.upper()} · {lab} · n={len(s0):,}")
        print(f"   {'feature':>14} {'dev spread':>11} {'val spread':>11} {'dev|own-ctrl':>13} {'verdict':>16}")
        for feat in ['timeAt','intAt','crossings','penAboveTicks','penBelowTicks']:
            row=[]
            for isdev in [True,False]:
                s = s0[s0.dev==isdev]
                if len(s)<400: row.append(np.nan); continue
                q = pd.qcut(s[feat],5,labels=False,duplicates='drop')
                g = s.groupby(q,observed=True).f60.mean()
                row.append(g.iloc[-1]-g.iloc[0] if len(g)>=2 else np.nan)
            # own-return control on dev: within quintiles of where price sat, redo the spread
            sd = s0[s0.dev].copy()
            sd['oq'] = pd.qcut(sd.own,4,labels=False,duplicates='drop')
            sd['fq'] = sd.groupby('oq',observed=True)[feat].transform(lambda x: pd.qcut(x,5,labels=False,duplicates='drop'))
            t = sd.groupby(['oq','fq'],observed=True).f60.mean().unstack()
            ctrl = np.nanmean([r.iloc[-1]-r.iloc[0] for _,r in t.iterrows() if r.notna().sum()>=2]) if len(t) else np.nan
            ok = (not np.isnan(row[1])) and np.sign(row[0])==np.sign(row[1]) and np.sign(row[0])==np.sign(ctrl)
            big = abs(row[1])>COST and abs(ctrl)>COST
            v = '★ survives+clears' if ok and big else ('consistent' if ok else '')
            print(f"   {feat:>14} {row[0]:+11.4f} {row[1]:+11.4f} {ctrl:+13.4f} {v:>16}")
        print()
