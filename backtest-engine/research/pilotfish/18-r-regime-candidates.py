#!/usr/bin/env python3
"""PILOTFISH Phase 4 — regime-classifier candidates R1-R6 (PLAN.md).

Builds a causal daily table, computes trailing candidate signals, then runs
the pre-registered WITHIN-ERA test: condition next-day opening-drive
follow-through on each candidate's trailing quartile. A real regime variable
must show Q4 (trendy) > Q1 (choppy) follow-through INSIDE 2021-24 AND INSIDE
2025-26 — not merely between eras.
"""
import statistics
import sys
from collections import defaultdict
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, LsSeries

rows = load_minutes()

# ---------- daily table ----------
days = {}
for r in rows:
    d = days.setdefault(r['date'], {})
    hh = r['hhmm']
    if hh == '16:00':
        d['close'], d['csym'] = r['c'], r['sym']
    if hh == '09:30':
        d['o930'], d['osym'] = r['o'], r['sym']
    if hh == '09:45':
        d['c945'] = r['c']
    if hh == '15:30':
        d['c1530'] = r['c']
    if '09:30' <= hh <= '16:00':
        d['travel'] = d.get('travel', 0) + r['travel']

dates = sorted(dt for dt, d in days.items()
               if all(k in d for k in ('close', 'o930', 'c945', 'c1530', 'travel')))
tab = []
prev = None
for dt in dates:
    d = days[dt]
    if prev and days[prev].get('csym') == d.get('osym'):
        pclose = days[prev]['close']
        ret = (d['close'] - pclose) / pclose * 100
        on = (d['o930'] - pclose) / pclose * 100
        intra = (d['close'] - d['o930']) / d['o930'] * 100
        drive = (d['c945'] - d['o930']) / d['o930'] * 100
        follow = (d['c1530'] - d['c945']) / d['c945'] * 100
        eff = abs(d['close'] - d['o930']) / d['travel'] if d['travel'] else 0
        tab.append({'date': dt, 'ret': ret, 'on': on, 'intra': intra,
                    'drive': drive, 'follow': follow, 'eff': eff,
                    'signfollow': (1 if drive > 0 else -1) * follow})
    prev = dt
print(f'{len(tab)} daily rows {tab[0]["date"]} -> {tab[-1]["date"]}')

# LS-15m flips per day
ls15 = LsSeries('15m')
from datetime import datetime, timezone
flipday = defaultdict(int)
for k in range(1, len(ls15.ts)):
    if ls15.st[k] != ls15.st[k - 1]:
        flipday[datetime.fromtimestamp(ls15.ts[k] / 1000, timezone.utc).strftime('%Y-%m-%d')] += 1

# ---------- trailing candidates (value known BEFORE day i) ----------
def trailing(i, n):
    return tab[max(0, i - n):i]


for i, row in enumerate(tab):
    t60 = trailing(i, 60)
    t20 = trailing(i, 20)
    t5 = trailing(i, 5)
    if len(t60) >= 40:
        rets = [x['ret'] for x in t60]
        m = statistics.mean(rets)
        num = sum((rets[j] - m) * (rets[j - 1] - m) for j in range(1, len(rets)))
        den = sum((x - m) ** 2 for x in rets)
        row['R1'] = num / den if den else 0
        ons = [x['on'] for x in t60]
        ints = [x['intra'] for x in t60]
        mo, mi = statistics.mean(ons), statistics.mean(ints)
        dn = sum((o - mo) ** 2 for o in ons)
        row['R3'] = (sum((ons[j] - mo) * (ints[j] - mi) for j in range(len(ons))) / dn) if dn else 0
        row['R6'] = statistics.mean(x['signfollow'] for x in t60)
    if len(t20) >= 15:
        row['R2'] = statistics.mean(x['eff'] for x in t20)
        row['R5'] = (statistics.mean(abs(x['ret']) for x in t5)
                     / statistics.mean(abs(x['ret']) for x in t20)
                     if statistics.mean(abs(x['ret']) for x in t20) else 1)
        fl = [flipday.get(x['date'], 0) for x in t20]
        row['R4'] = statistics.mean(fl)

# ---------- within-era test ----------
ERAS = (('2021-24 (MR era)', lambda d: d < '2025-01-01'),
        ('2025-26 (trend era)', lambda d: d >= '2025-01-01'))
print('\nOutcome = same-day signed opening-drive follow-through (%, drive-signed)')
for cand in ('R1', 'R2', 'R3', 'R4', 'R5', 'R6'):
    print(f'=== {cand} ===')
    for elab, sel in ERAS:
        evs = [x for x in tab if sel(x['date']) and cand in x and abs(x['drive']) >= 0.15]
        if len(evs) < 60:
            print(f'  {elab}: n={len(evs)} --')
            continue
        vals = sorted(x[cand] for x in evs)
        q1c, q3c = vals[len(vals) // 4], vals[3 * len(vals) // 4]
        q1 = [x['signfollow'] for x in evs if x[cand] <= q1c]
        q4 = [x['signfollow'] for x in evs if x[cand] >= q3c]
        print(f'  {elab}: n={len(evs)}  Q1(chop-pred)={statistics.mean(q1):+.3f}%  '
              f'Q4(trend-pred)={statistics.mean(q4):+.3f}%  '
              f'spread={statistics.mean(q4)-statistics.mean(q1):+.3f}%')
