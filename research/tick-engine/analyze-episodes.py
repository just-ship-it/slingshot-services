#!/usr/bin/env python3
"""Does price interact DIFFERENTLY with a real level than with a displaced one — and does that
   difference depend on the gamma regime? (The dealer-flow footprint question.)"""
import pandas as pd, numpy as np, warnings
warnings.filterwarnings('ignore')
d = pd.read_csv("level-episodes/NQ_episodes.csv")
d = d[d.volTotal > 0]
d['dev'] = d.tradeDate <= '2024-12-31'
d['near'] = d.distTicks.abs() <= 40            # level within 10 NQ pts of the window open
print(f"{len(d):,} episodes | real {(~d.isPlacebo.astype(bool)).sum():,} placebo {d.isPlacebo.sum():,}")
print(f"GEX-dated rows: {d.totalGex.notna().sum():,}\n")

def cmp(sub, label, cols=('timeAt','volAt','intAt','crossings','penAboveTicks','penBelowTicks')):
    r = sub[sub.isPlacebo==0]; p = sub[sub.isPlacebo==1]
    if len(r) < 200 or len(p) < 200: return None
    out = {'n_real': len(r), 'n_plc': len(p)}
    for c in cols:
        out[c] = r[c].mean() - p[c].mean()
        out[c+'_rel'] = (r[c].mean()/p[c].mean() - 1) if p[c].mean() else np.nan
    return out

print("1) REAL minus PLACEBO, by level source (all windows where the level was in reach)")
print(f"   {'src':>6} {'n real':>8} {'Δ timeAt':>9} {'Δ volAt':>8} {'Δ intAt':>8} {'Δ cross':>8} {'Δ penUp':>8} {'Δ penDn':>8}")
for src in ['gex','lt']:
    for isdev in [True, False]:
        s = d[(d.src==src)&(d.dev==isdev)]
        c = cmp(s, src)
        if c: print(f"   {src+('/dev' if isdev else '/val'):>10} {c['n_real']:>8,} {c['timeAt']:+9.4f} {c['volAt']:+8.4f} {c['intAt']:+8.4f} {c['crossings']:+8.3f} {c['penAboveTicks']:+8.2f} {c['penBelowTicks']:+8.2f}")

print("\n2) The dealer-gamma prediction: long gamma should DAMPEN (more time, lower intensity,")
print("   more re-probes, shallower penetration); short gamma should AMPLIFY.")
g = d[d.totalGex.notna() & d.near].copy()
g['gam'] = np.where(g.totalGex>0, 'long gamma', 'short gamma')
print(f"   {'regime':>12} {'set':>4} {'n real':>7} {'Δ timeAt':>9} {'Δ intAt':>8} {'Δ cross':>8} {'Δ penUp':>8} {'Δ penDn':>8}")
for gam in ['long gamma','short gamma']:
    for isdev in [True, False]:
        s = g[(g.gam==gam)&(g.dev==isdev)]
        c = cmp(s, gam)
        if c: print(f"   {gam:>12} {'dev' if isdev else 'val':>4} {c['n_real']:>7,} {c['timeAt']:+9.4f} {c['intAt']:+8.4f} {c['crossings']:+8.3f} {c['penAboveTicks']:+8.2f} {c['penBelowTicks']:+8.2f}")

print("\n3) Per named GEX level (dev), real vs placebo — which levels have ANY footprint?")
print(f"   {'level':>10} {'n real':>7} {'Δ timeAt':>9} {'Δ intAt':>8} {'Δ cross':>8} {'Δ penUp':>8} {'Δ penDn':>8}")
for nm in ['callWall','putWall','gammaFlip','res0','sup0','lt1','lt2']:
    s = d[(d.name==nm)&d.dev&d.near]
    c = cmp(s, nm)
    if c: print(f"   {nm:>10} {c['n_real']:>7,} {c['timeAt']:+9.4f} {c['intAt']:+8.4f} {c['crossings']:+8.3f} {c['penAboveTicks']:+8.2f} {c['penBelowTicks']:+8.2f}")
