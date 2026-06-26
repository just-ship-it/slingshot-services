#!/usr/bin/env python3
"""
LS-Flip Meta-Labeling — univariate predictive analysis.

For each candidate feature, measure how well it separates winners (netPnL>0)
from losers, BEFORE any model. Reports:
  - point-biserial correlation of feature vs win label
  - per-quintile WR / avg netPnL / profit factor
  - WR spread (top quintile - bottom quintile)
Also handles the trade-economics view (avg $/trade by bucket), since WR alone
can be raised trivially by exit geometry — we want features that move $ too.

Out: output/02-univariate.txt  (also printed)
"""
import numpy as np, pandas as pd, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
df = pd.read_csv(os.path.join(HERE, 'output', 'features.csv'))
out = []
def p(*a):
    s = ' '.join(str(x) for x in a); print(s); out.append(s)

N = len(df)
base_wr = df['label'].mean()
base_pnl = df['netPnL'].sum()
p(f"N={N}  baseWR={base_wr*100:.1f}%  totalNetPnL=${base_pnl:,.0f}  avg=${base_pnl/N:.1f}/trade")
p("="*100)

NUMERIC = ['range','cbAtr','rangeRatio','closePos','retraceDepth','bodyFrac','upperWick','lowerWick',
           'secsSinceLast','flips1h','flips2h','distHi20','distLo20','distHi60','distLo60','posInRange60',
           'ret20','ret60','emaSlope20','entryVsEma20','volRatio','volZ','ltDist','gexDistFlip','gexDistWall',
           'barsToFill','fillDelay']
CATEG = ['counterTrend','ltAlign','gexAboveFlip','gexRegimePos','isLong','hourEt','dowEt']

def pf(sub):
    w = sub.loc[sub.netPnL>0,'netPnL'].sum(); l = -sub.loc[sub.netPnL<0,'netPnL'].sum()
    return (w/l) if l>0 else float('inf')

# ---- numeric: point-biserial corr + quintile table ----
rows = []
for c in NUMERIC:
    s = df[[c,'label','netPnL']].dropna()
    if len(s) < 200 or s[c].nunique() < 5:
        continue
    corr = np.corrcoef(s[c], s['label'])[0,1]
    # quintiles
    try:
        s = s.copy(); s['q'] = pd.qcut(s[c].rank(method='first'), 5, labels=False)
    except Exception:
        continue
    g = s.groupby('q')
    wr = g['label'].mean(); avg = g['netPnL'].mean(); n = g.size()
    spread = wr.iloc[-1]-wr.iloc[0]
    rows.append((c, corr, spread, wr, avg, n, s, len(s)))

rows.sort(key=lambda r: -abs(r[1]))
p("\n### NUMERIC FEATURES — ranked by |point-biserial corr| with win\n")
p(f"{'feature':<16}{'corr':>7}{'WRspread':>9}   quintile WR% (low→high)            quintile avg$/trade")
for c,corr,spread,wr,avg,n,s,cov in rows:
    wrs = ' '.join(f"{x*100:4.0f}" for x in wr)
    avgs = ' '.join(f"{x:5.0f}" for x in avg)
    p(f"{c:<16}{corr:>7.3f}{spread*100:>8.0f}%   [{wrs}]   [{avgs}]")

# ---- detailed PF for the top movers ----
p("\n### Top-8 numeric movers — full quintile detail (WR / avg$ / PF / n)\n")
for c,corr,spread,wr,avg,n,s,cov in rows[:8]:
    p(f"\n{c}  (corr={corr:.3f}, coverage={cov}/{N})")
    s2 = s.copy()
    edges = pd.qcut(s2[c], 5, retbins=True, duplicates='drop')[1]
    s2['q'] = pd.qcut(s2[c].rank(method='first'),5,labels=False)
    for q in sorted(s2['q'].unique()):
        sub = s2[s2['q']==q]
        rng = f"[{sub[c].min():.2f},{sub[c].max():.2f}]"
        p(f"  Q{q+1} {rng:<22} n={len(sub):4d}  WR={sub['label'].mean()*100:4.1f}%  avg=${sub['netPnL'].mean():6.1f}  PF={pf(sub):.2f}")

# ---- categorical ----
p("\n### CATEGORICAL FEATURES\n")
for c in CATEG:
    if c not in df: continue
    p(f"\n{c}:")
    g = df.groupby(c)
    for k, sub in g:
        if len(sub) < 30: continue
        p(f"  {c}={k:<6} n={len(sub):4d}  WR={sub['label'].mean()*100:4.1f}%  avg=${sub['netPnL'].mean():6.1f}  PF={pf(sub):.2f}  totPnL=${sub['netPnL'].sum():>8,.0f}")

with open(os.path.join(HERE,'output','02-univariate.txt'),'w') as f:
    f.write('\n'.join(out))
print("\n[wrote output/02-univariate.txt]")
