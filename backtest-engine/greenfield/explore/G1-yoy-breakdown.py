#!/usr/bin/env python3
"""
Gold Donchian sleeve — year-by-year P&L / drawdown / Sharpe / Sortino.
Reads book-gold-daily.csv (daily MTM at 1 MGC, $10/pt, session-dated).
Risk metrics annualized on the all-trading-day (business-day, 0-filled) calendar
so they're comparable to how the NQ book is reported.

Usage: python3 G1-yoy-breakdown.py [mgc|gc]   (default mgc; gc = full-size, 10x $)
"""
import sys
import pandas as pd
import numpy as np

ANN = np.sqrt(252)
SCALE = 10.0 if (len(sys.argv) > 1 and sys.argv[1].lower() == 'gc') else 1.0
LABEL = 'GC ($100/pt)' if SCALE == 10.0 else 'MGC ($10/pt)'

df = pd.read_csv('book-gold-daily.csv', parse_dates=['date']).sort_values('date').set_index('date')['pnl'] * SCALE


def metrics(pnl):
    v = pnl.values
    total = v.sum()
    eq = np.cumsum(v)
    mdd = float((eq - np.maximum.accumulate(eq)).min())
    sd = v.std(ddof=1)
    sharpe = v.mean() / sd * ANN if sd > 0 else float('nan')
    dn = np.minimum(v, 0.0)
    dstd = np.sqrt((dn ** 2).mean())
    sortino = v.mean() / dstd * ANN if dstd > 0 else float('nan')
    posdays = int((v != 0).sum())
    wr = 100 * (v[v != 0] > 0).mean() if posdays else float('nan')
    return total, mdd, sharpe, sortino, posdays, wr


def bdays(lo, hi):
    return df.reindex(pd.bdate_range(f'{lo}-01-01', f'{hi}-12-31')).fillna(0.0)


print(f"Gold Donchian sleeve — {LABEL}\nYEAR     PnL($)    maxDD($)  Sharpe Sortino  dayWR")
for y in sorted(df.index.year.unique()):
    s = bdays(y, y)
    if s.abs().sum() == 0:
        continue
    t, mdd, sh, so, _, wr = metrics(s)
    print(f"{y}  {t:9.0f}  {mdd:9.0f}  {sh:6.2f} {so:6.2f}  {wr:4.0f}%")

print("\nWINDOW            PnL($)    maxDD($)  Sharpe Sortino  ann$/yr")
for lo, hi, lab in [(1995, 2026, 'full 1995-2026'), (2018, 2026, '2018-2026 OOS'), (2021, 2026, '2021-2026 book')]:
    t, mdd, sh, so, _, wr = metrics(bdays(lo, hi))
    print(f"{lab:16s} {t:10.0f}  {mdd:9.0f}  {sh:6.2f} {so:6.2f}  {t/(hi-lo+1):8.0f}")
