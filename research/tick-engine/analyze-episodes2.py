#!/usr/bin/env python3
"""(a) distance-controlled real-vs-placebo; (b) does the footprint PREDICT forward returns?"""
import pandas as pd, numpy as np, warnings
warnings.filterwarnings('ignore')
d = pd.read_csv("level-episodes/NQ_episodes.csv")
d = d[(d.volTotal>0) & d.fwd60Ticks.notna() & (d.atrTicks>0)]
d['dev'] = d.tradeDate <= '2024-12-31'
d['adist'] = d.distTicks.abs()
print(f"{len(d):,} episodes\n")
print("(a) DISTANCE-CONTROLLED: real − placebo within |distance| buckets, LT levels")
lt = d[d.src=='lt'].copy()
lt['db'] = pd.cut(lt.adist, [0,10,25,50,100,200,1e9], labels=['≤10','≤25','≤50','≤100','≤200','>200'])
print(f"   {'bucket':>7} {'set':>4} {'nReal':>7} {'nPlc':>7} {'Δ timeAt':>9} {'Δ volAt':>8} {'Δ penUp':>8} {'Δ penDn':>8}")
for b in lt.db.cat.categories:
    for isdev in [True, False]:
        s = lt[(lt.db==b)&(lt.dev==isdev)]
        r, p = s[s.isPlacebo==0], s[s.isPlacebo==1]
        if len(r)<150 or len(p)<150: continue
        print(f"   {str(b):>7} {'dev' if isdev else 'val':>4} {len(r):>7,} {len(p):>7,} "
              f"{r.timeAt.mean()-p.timeAt.mean():+9.4f} {r.volAt.mean()-p.volAt.mean():+8.4f} "
              f"{r.penAboveTicks.mean()-p.penAboveTicks.mean():+8.2f} {r.penBelowTicks.mean()-p.penBelowTicks.mean():+8.2f}")

print("\n(b) DOES THE FOOTPRINT PREDICT? forward 60-min return (ATR units) by feature quintile,")
print("    real LT interactions only, |dist| ≤ 40 ticks. Signed so + = price rose after.")
lt2 = d[(d.src=='lt')&(d.isPlacebo==0)&(d.adist<=40)].copy()
lt2['f60'] = lt2.fwd60Ticks/lt2.atrTicks
lt2['above'] = (lt2.distTicks<0).astype(int)     # level below spot = support-ish
for feat in ['timeAt','volAt','intAt','crossings','penAboveTicks','penBelowTicks','centroidAtV']:
    row=[]
    for isdev in [True, False]:
        s = lt2[lt2.dev==isdev]
        q = pd.qcut(s[feat], 5, labels=False, duplicates='drop')
        g = s.groupby(q, observed=True).f60.mean()
        row.append(g.iloc[-1]-g.iloc[0] if len(g)>=2 else np.nan)
    flag = '★ same sign' if np.sign(row[0])==np.sign(row[1]) and abs(row[0])>0.02 else ''
    print(f"   {feat:>16} dev {row[0]:+7.4f}   val {row[1]:+7.4f}   {flag}")
print("\n(c) same, but does the footprint predict PENETRATION (does the level hold)?")
lt2['heldUp'] = (lt2.fwd60Ticks < 0).astype(float)     # for levels above spot: did price fail to keep rising
for feat in ['timeAt','intAt','crossings']:
    row=[]
    for isdev in [True, False]:
        s = lt2[lt2.dev==isdev]
        q = pd.qcut(s[feat], 5, labels=False, duplicates='drop')
        g = s.groupby(q, observed=True).f60.apply(lambda x: x.abs().mean())
        row.append(g.iloc[-1]-g.iloc[0] if len(g)>=2 else np.nan)
    print(f"   {feat:>16} |fwd60| spread dev {row[0]:+7.4f}  val {row[1]:+7.4f}   (magnitude, not direction)")
