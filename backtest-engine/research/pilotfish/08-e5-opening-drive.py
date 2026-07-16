#!/usr/bin/env python3
"""PILOTFISH E5 — OPENING DRIVE (PLAN.md Phase 2).

09:30-09:44 drift |>=0.25%| + aligned signed pressure >=0.15 + volume surprise
>=1.2x -> enter 09:45 close, exit 15:30 close in drive direction.
Pre-registered: CONFIRMED drives trend; unconfirmed identical drifts don't
(that comparison IS the beat-the-clock). Discovery 2023-24 / holdout 2025-26.
"""
import sys
import statistics
from collections import defaultdict
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, stat_line

rows = load_minutes()
days = defaultdict(dict)
win = defaultdict(lambda: [0, 0, None, None, None])  # sv, vol, o930, c944, sym
for r in rows:
    hh = r['hhmm']
    d = r['date']
    if '09:30' <= hh <= '09:44':
        w = win[d]
        w[0] += r['sv']
        w[1] += r['v']
        if hh == '09:30':
            w[2], w[4] = r['o'], r['sym']
        if hh == '09:44':
            w[3] = r['c']
    if hh in ('09:45', '15:30'):
        days[d][hh] = (r['c'], r['sym'])

dates = sorted(d for d in days
               if '09:45' in days[d] and '15:30' in days[d]
               and win[d][2] is not None and win[d][3] is not None
               and days[d]['09:45'][1] == days[d]['15:30'][1] == win[d][4])
events = []
volhist = []
for d in dates:
    sv, vv, o, c, _ = win[d]
    vs = vv / statistics.median(volhist[-60:]) if len(volhist) >= 20 else None
    volhist.append(vv)
    if vs is None or vv == 0:
        continue
    drift = 100 * (c - o) / o
    pressure = sv / vv
    payoff_dir = 1 if drift > 0 else -1
    hold = (days[d]['15:30'][0] - days[d]['09:45'][0]) * payoff_dir
    events.append((d, abs(drift), pressure * payoff_dir, vs, hold))

print(f'{len(events)} days\n')
for label in ('DISCOVERY 2023-24', 'HOLDOUT 2025-26'):
    evs = [e for e in events if (e[0] < '2025-01-01') == label.startswith('DISC')]
    print(f'========== {label} ({len(evs)} days) ==========')
    big = [e for e in evs if e[1] >= 0.25]
    stat_line('  PRE-REG drive+press>=.15+vs>=1.2 CONFIRMED',
              [e[4] for e in big if e[2] >= 0.15 and e[3] >= 1.2])
    stat_line('  beat-the-clock: same drift UNCONFIRMED',
              [e[4] for e in big if not (e[2] >= 0.15 and e[3] >= 1.2)])
    stat_line('  baseline: all |drift|>=0.25% days, continuation',
              [e[4] for e in big])
    stat_line('    smaller drives 0.10-0.25%, confirmed',
              [e[4] for e in evs if 0.10 <= e[1] < 0.25 and e[2] >= 0.15 and e[3] >= 1.2])
    print()
