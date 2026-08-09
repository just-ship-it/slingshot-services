#!/usr/bin/env python3
"""
I3 — build the PCC conditioner file for engine backtests (and, later, live
shadow logging). One row per ET trading date:

  date,trin_1430,cor_chg5

  trin_1430 : NYSE TRIN, last 1h bar CLOSING <= 14:30 ET that day (label <=13:30).
              Same reading as I1/I2b (causal for the 15:00 decision).
  cor_chg5  : CBOE COR1M implied correlation, prior-day close minus the close
              5 sessions before that (causal prior-day 5d change; I2 E3).

Sources: data/macro/trin_1h.csv (2020+), data/macro/cor1m_1d.csv (2006+).
Output: data/macro/pcc-conditioner.csv
"""
import bisect
import os
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
MACRO = os.path.join(HERE, '..', '..', 'data', 'macro')
ET = ZoneInfo('America/New_York')

# TRIN: last 1h bar labeled <=13:30 ET per date (closes <=14:30)
trin = {}
with open(os.path.join(MACRO, 'trin_1h.csv')) as f:
    next(f)
    for line in f:
        p = line.rstrip('\n').split(',')
        if len(p) < 6:
            continue
        et = datetime.fromtimestamp(int(p[1]), tz=ET)
        if et.hour * 60 + et.minute <= 13 * 60 + 30:
            trin[et.strftime('%Y-%m-%d')] = float(p[5])  # later labels overwrite

# COR1M daily closes
cor = {}
with open(os.path.join(MACRO, 'cor1m_1d.csv')) as f:
    next(f)
    for line in f:
        p = line.rstrip('\n').split(',')
        if len(p) < 6:
            continue
        cor[p[0]] = float(p[5])
cds = sorted(cor)


def cor_chg5(date):
    i = bisect.bisect_left(cds, date)
    if i < 6:
        return None
    return cor[cds[i - 1]] - cor[cds[i - 6]]


dates = sorted(set(trin) | set(d for d in cds if d >= min(trin, default='2020-01-01')))
out = os.path.join(MACRO, 'pcc-conditioner.csv')
n_both = 0
with open(out, 'w') as f:
    f.write('date,trin_1430,cor_chg5\n')
    for d in dates:
        t = trin.get(d)
        c = cor_chg5(d)
        if t is None and c is None:
            continue
        if t is not None and c is not None:
            n_both += 1
        f.write(f"{d},{'' if t is None else f'{t:.3f}'},{'' if c is None else f'{c:.3f}'}\n")

print(f'wrote {out}: {len(dates)} dates scanned, {n_both} with both fields')
print(f'trin coverage {min(trin)} -> {max(trin)}; cor1m {cds[0]} -> {cds[-1]}')
