#!/usr/bin/env python3
"""PILOTFISH Phase 4 step 3 — TREND-PERMISSION v2 on virgin 2021-22.

Registered predictions (PLAN.md): P1 v2-ON drive days positive (points);
P2 unvetoed rule fails concentrated inside 2022 shock clusters;
P3 v2 >> unvetoed in 2022, ~tie in 2021.
Constants fixed: combo = R2rank252 − R3rank252 >= +0.25; veto R5 <= 1.5.
"""
import csv
import statistics
from collections import defaultdict

F = '/home/drew/projects/slingshot-services/backtest-engine/data/features/pilotfish_minute_features_2021-22.csv'

days = {}
with open(F) as f:
    for r in csv.DictReader(f):
        d = days.setdefault(r['et_date'], {})
        hh = r['et_hhmm']
        if hh == '16:00':
            d['close'], d['csym'] = float(r['close']), r['symbol']
        if hh == '09:30':
            d['o930'], d['osym'] = float(r['open']), r['symbol']
        if hh == '09:45':
            d['c945'] = float(r['close'])
        if hh == '15:30':
            d['c1530'] = float(r['close'])
        if '09:30' <= hh <= '16:00':
            d['travel'] = d.get('travel', 0) + float(r['travel'])

dates = sorted(dt for dt, d in days.items()
               if all(k in d for k in ('close', 'o930', 'c945', 'c1530', 'travel')))
tab = []
prev = None
for dt in dates:
    d = days[dt]
    if prev and days[prev].get('csym') == d.get('osym'):
        pclose = days[prev]['close']
        tab.append({'date': dt,
                    'ret': (d['close'] - pclose) / pclose * 100,
                    'on': (d['o930'] - pclose) / pclose * 100,
                    'intra': (d['close'] - d['o930']) / d['o930'] * 100,
                    'drivepct': (d['c945'] - d['o930']) / d['o930'] * 100,
                    'followpts': d['c1530'] - d['c945'],
                    'drivesign': 1 if d['c945'] > d['o930'] else -1,
                    'eff': abs(d['close'] - d['o930']) / d['travel'] if d['travel'] else 0})
    prev = dt
print(f'{len(tab)} daily rows {tab[0]["date"]} -> {tab[-1]["date"]}')

for i, row in enumerate(tab):
    t20 = tab[max(0, i - 20):i]
    t60 = tab[max(0, i - 60):i]
    t5 = tab[max(0, i - 5):i]
    if len(t20) >= 15:
        row['R2'] = statistics.mean(x['eff'] for x in t20)
        m20 = statistics.mean(abs(x['ret']) for x in t20)
        row['R5'] = statistics.mean(abs(x['ret']) for x in t5) / m20 if m20 else 1
    if len(t60) >= 40:
        ons = [x['on'] for x in t60]
        ints = [x['intra'] for x in t60]
        mo, mi = statistics.mean(ons), statistics.mean(ints)
        dn = sum((o - mo) ** 2 for o in ons)
        row['R3'] = (sum((ons[j] - mo) * (ints[j] - mi) for j in range(len(ons))) / dn) if dn else 0

for cand in ('R2', 'R3'):
    hist = []
    for row in tab:
        v = row.get(cand)
        if v is None:
            continue
        if len(hist) >= 60:
            row[cand + 'rank'] = sum(1 for h in hist[-252:] if h <= v) / min(len(hist), 252)
        hist.append(v)

evs = [x for x in tab if abs(x['drivepct']) >= 0.15 and 'R2rank' in x and 'R3rank' in x
       and 'R5' in x]
for x in evs:
    x['combo'] = x['R2rank'] - x['R3rank']
    x['pay'] = x['followpts'] * x['drivesign']

print(f'{len(evs)} qualifying drive days\n')
print(f'{"year":6s} {"rule":14s} {"n":>4s} {"avg pts":>8s} {"WR":>6s} {"net$/tr":>8s}')
for yr in ('2021', '2022'):
    ye = [x for x in evs if x['date'].startswith(yr)]
    for lab, sel in (('unvetoed ON', lambda x: x['combo'] >= 0.25),
                     ('v2 ON (veto)', lambda x: x['combo'] >= 0.25 and x['R5'] <= 1.5),
                     ('vetoed-out', lambda x: x['combo'] >= 0.25 and x['R5'] > 1.5),
                     ('OFF', lambda x: x['combo'] < 0.25),
                     ('all', lambda x: True)):
        p = [x['pay'] for x in ye if sel(x)]
        if len(p) < 5:
            print(f'{yr:6s} {lab:14s} {len(p):4d}       --')
            continue
        wr = 100 * sum(1 for v in p if v > 0) / len(p)
        print(f'{yr:6s} {lab:14s} {len(p):4d} {statistics.mean(p):+8.1f} {wr:5.1f}% '
              f'{statistics.mean(p)*20-44:+8.0f}')
    print()

print('P2 check — unvetoed-ON months in 2022 (avg pts, n):')
bym = defaultdict(list)
for x in evs:
    if x['date'].startswith('2022') and x['combo'] >= 0.25:
        bym[x['date'][:7]].append((x['pay'], x['R5']))
for mo in sorted(bym):
    p = [v for v, _ in bym[mo]]
    r5 = statistics.mean(r for _, r in bym[mo])
    print(f'  {mo}: {statistics.mean(p):+7.1f}pt n={len(p)} (avg R5={r5:.2f})')
