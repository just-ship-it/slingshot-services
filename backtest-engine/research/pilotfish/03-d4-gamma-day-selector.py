#!/usr/bin/env python3
"""PILOTFISH D4 — dealer-gamma sign as a momentum/fade day selector.

Pre-registered (PLAN.md): dealer long gamma damps (fades work), short gamma
chases (momentum works). A SIMPLE, untuned momentum module must be profitable
ONLY on dealer-short days; fade modules better on dealer-long days.

Momentum module (fixed, no tuning): direction = sign(10:00 close − 09:30 open)
(first-30-min move); enter 10:00 close, exit 15:30 close. Fade = the inverse.

Confound control (beat-the-clock analog): dealer-short days may just be
high-vol days where momentum works anyway. Report the split within trailing
5-day realized-vol halves (|daily return| mean) — gamma sign must add
separation BEYOND vol.

Also: DWF gold trades (a validated fade strategy) split by day book sign.
Costs: 2.0 pt slip + $4 RT, $20/pt. Inventory window 2025-02 -> 2026-01.
"""
import csv
import glob
import json
import statistics
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
PT, SLIP, COMM = 20.0, 2.0, 4.0
ET = ZoneInfo('America/New_York')

book = {}
for fp in sorted(glob.glob(BASE + '/data/flow/qqq/dealer-strikes-*.csv')):
    d8 = fp.split('-')[-1].split('.')[0]
    day = f'{d8[:4]}-{d8[4:6]}-{d8[6:8]}'
    book[day] = sum(float(r['dealer_gamma']) for r in csv.DictReader(open(fp)))

days = defaultdict(dict)
with open(BASE + '/data/features/pilotfish_minute_features.csv') as f:
    for row in csv.DictReader(f):
        hh = row['et_hhmm']
        if hh in ('09:30', '10:00', '15:30', '16:00'):
            days[row['et_date']][hh] = (float(row['open']), float(row['close']),
                                        row['symbol'])

dates = sorted(days)
# trailing 5-day realized vol from 16:00 closes (same-symbol pairs only)
closes = [(d, days[d]['16:00'][1], days[d]['16:00'][2]) for d in dates
          if '16:00' in days[d]]
rets = {}
for i in range(1, len(closes)):
    d, c, s = closes[i]
    _, pc, ps = closes[i - 1]
    if s == ps:
        rets[d] = abs(100 * (c - pc) / pc)
rv = {}
rlist = []
for d, _, _ in closes:
    if len(rlist) >= 5:
        rv[d] = statistics.mean(rlist[-5:])
    if d in rets:
        rlist.append(rets[d])

events = []
for d in dates:
    m = days[d]
    if d not in book or d not in rv:
        continue
    if not all(k in m for k in ('09:30', '10:00', '15:30')):
        continue
    if len({m[k][2] for k in ('09:30', '10:00', '15:30')}) != 1:
        continue
    sig = m['10:00'][1] - m['09:30'][0]
    if sig == 0:
        continue
    mom = (m['15:30'][1] - m['10:00'][1]) * (1 if sig > 0 else -1)
    events.append((d, book[d] > 0, rv[d], mom))

vmed = statistics.median(e[2] for e in events)
print(f'{len(events)} days ({events[0][0]} -> {events[-1][0]}), '
      f'vol median {vmed:.2f}%/day\n')


def stat(label, picks):
    if len(picks) < 8:
        print(f'{label:46s} n={len(picks):3d}  (too few)')
        return
    g = statistics.mean(picks)
    wr = 100 * sum(1 for p in picks if p > 0) / len(picks)
    net = g * PT - SLIP * PT - COMM
    print(f'{label:46s} n={len(picks):3d} avg={g:+7.2f}pt WR={wr:4.1f}% '
          f'net/tr=${net:+7.0f} total=${net*len(picks):+10,.0f}')


print('=== D4 pre-registered: momentum module by dealer book sign ===')
stat('MOMENTUM, dealer-SHORT days', [e[3] for e in events if not e[1]])
stat('MOMENTUM, dealer-LONG days', [e[3] for e in events if e[1]])
stat('MOMENTUM, all days (clock baseline)', [e[3] for e in events])
print('(fade = same numbers × −1)\n')

print('=== vol-confound control: 2×2 (book sign × trailing vol) ===')
for vlab, vsel in (('LOW-vol', False), ('HIGH-vol', True)):
    for blab, bsel in (('dealer-SHORT', False), ('dealer-LONG', True)):
        stat(f'MOM, {blab}, {vlab}',
             [e[3] for e in events if e[1] == bsel and (e[2] >= vmed) == vsel])
print()

print('=== DWF gold trades (validated fade) by day book sign ===')
tr = json.load(open(BASE + '/data/gold-standard/dealer-wall-fade-v1-candidate.json'))['trades']
bysign = {True: [], False: []}
for t in tr:
    d = datetime.fromtimestamp(t['timestamp'] / 1000, ET).strftime('%Y-%m-%d')
    if d in book:
        bysign[book[d] > 0].append(t['netPnL'])
for lab, sel in (('DWF on dealer-LONG days', True), ('DWF on dealer-SHORT days', False)):
    p = bysign[sel]
    if p:
        w = sum(x for x in p if x > 0)
        l = -sum(x for x in p if x < 0)
        print(f'{lab:46s} n={len(p):3d} pnl=${sum(p):>8,.0f} PF={w/l if l else 99:5.2f} '
              f'WR={100*sum(1 for x in p if x>0)/len(p):4.1f}%')
