#!/usr/bin/env python3
"""
GammaLab short basket as a risk-appetite conditioner — first screen.

Series: top-20 most-shorted basket, SI-weighted (W) + equal-weighted (E),
2025-08-14 -> 2026-08-12 (n=250). Signals known at day D close:

  rE1 / rW1   : basket 1d return (raw risk-appetite read)
  spread1     : rW1 - rE1 (concentration: extreme names vs the group)
  excess1     : rE1 - beta*rSPY1 (beta-adjusted; beta = full-sample OLS,
                in-sample — acceptable for a screen, flagged)
  excess5     : 5d sum of excess1 (smoothed squeeze/derisking impulse)

Forward: SPY close->close returns, H in {1,3,5} days.
Stats: Spearman IC, circular-shift placebo p. 12 cells — expect ~1 spurious
p<0.10 cell; only broad consistency counts.
"""
import csv, math, os

HERE = os.path.dirname(__file__)
SB = os.path.join(HERE, '..', '..', 'backtest-engine', 'data', 'gammalab', 'short_basket_daily.csv')
SPY = os.path.join(HERE, '..', '..', 'backtest-engine', 'data', 'macro', 'spy_1d.csv')

sb = [(r['date'], float(r['weighted_index']), float(r['equal_weighted_index']))
      for r in csv.DictReader(open(SB))]
spy = {}
for row in csv.reader(open(SPY)):
    if row[0] == 'date' or len(row) < 6:
        continue
    spy[row[0]] = float(row[5])

rows = []  # date, rW1, rE1, rSPY1
for i in range(1, len(sb)):
    d0, w0, e0 = sb[i-1]
    d1, w1, e1 = sb[i]
    if d0 in spy and d1 in spy:
        rows.append((d1, (w1/w0-1)*100, (e1/e0-1)*100, (spy[d1]/spy[d0]-1)*100))
print(f'joined daily returns: n={len(rows)}')

# full-sample beta of rE on rSPY (screen-grade, in-sample)
re = [r[2] for r in rows]; rs = [r[3] for r in rows]
mre, mrs = sum(re)/len(re), sum(rs)/len(rs)
beta = sum((a-mre)*(b-mrs) for a, b in zip(re, rs)) / sum((b-mrs)**2 for b in rs)
print(f'basket beta vs SPY: {beta:.2f}')

sig = {}
sig['rE1'] = {r[0]: r[2] for r in rows}
sig['rW1'] = {r[0]: r[1] for r in rows}
sig['spread1'] = {r[0]: r[1]-r[2] for r in rows}
sig['excess1'] = {r[0]: r[2]-beta*r[3] for r in rows}
dates = [r[0] for r in rows]
ex1 = sig['excess1']
sig['excess5'] = {dates[i]: sum(ex1[dates[j]] for j in range(i-4, i+1))
                  for i in range(4, len(dates))}

spy_dates = sorted(spy)
idx = {d: i for i, d in enumerate(spy_dates)}

def spearman(a, b):
    def rk(v):
        o = sorted(range(len(v)), key=lambda i: v[i]); r = [0]*len(v)
        for i, j in enumerate(o):
            r[j] = i
        return r
    ra, rb = rk(a), rk(b)
    ma, mb = sum(ra)/len(ra), sum(rb)/len(rb)
    cov = sum((x-ma)*(y-mb) for x, y in zip(ra, rb))
    va = math.sqrt(sum((x-ma)**2 for x in ra)); vb = math.sqrt(sum((y-mb)**2 for y in rb))
    return cov/(va*vb) if va and vb else float('nan')

def pval(s, r, obs):
    n = len(s); w = 0
    for k in range(1, n):
        if abs(spearman(s[k:]+s[:k], r)) >= abs(obs):
            w += 1
    return w/(n-1)

print(f'\n{"signal":9s} ' + ' '.join(f'H={h}: IC / p       ' for h in (1, 3, 5)))
for name, sd in sig.items():
    line = f'{name:9s} '
    for H in (1, 3, 5):
        ss, rr = [], []
        for d, v in sorted(sd.items()):
            if d in idx and idx[d]+H < len(spy_dates):
                c0 = spy[d]; cH = spy[spy_dates[idx[d]+H]]
                ss.append(v); rr.append((cH-c0)/c0*100)
        ic = spearman(ss, rr)
        line += f'{ic:+.3f}/{pval(ss, rr, ic):.2f} (n={len(ss)})  '
    print(line)
