#!/usr/bin/env python3
"""PILOTFISH E3 — MOC_RUN (PLAN.md Phase 2).

Signal: 15:45-15:51 ET signed pressure |sum(svol)/sum(vol)| >= 0.2 with window
volume surprise >= 1.5x. Trade 15:52 close -> 16:00 close in the pressure
direction. Pre-registered: imbalance execution continues into the bell.
Baselines: unconditional 15:52->16:00 (random sign), pressure-only (no volume
surprise gate). Discovery 2023-24 / holdout 2025-26.
"""
import sys
import statistics
from collections import defaultdict
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, stat_line

rows = load_minutes()
days = defaultdict(dict)
winvol = defaultdict(lambda: [0, 0])   # date -> [svol, vol] over 15:45-15:51
for r in rows:
    hh = r['hhmm']
    if hh in ('15:52', '16:00'):
        days[r['date']][hh] = (r['c'], r['sym'])
    if '15:45' <= hh <= '15:51':
        w = winvol[r['date']]
        w[0] += r['sv']
        w[1] += r['v']

# causal volume baseline for the window (trailing 60 days)
dates = sorted(d for d in days if '15:52' in days[d] and '16:00' in days[d]
               and days[d]['15:52'][1] == days[d]['16:00'][1] and winvol[d][1] > 0)
events = []
volhist = []
for d in dates:
    sv, vv = winvol[d]
    vs = vv / statistics.median(volhist[-60:]) if len(volhist) >= 20 else None
    volhist.append(vv)
    if vs is None:
        continue
    pressure = sv / vv
    drift = days[d]['16:00'][0] - days[d]['15:52'][0]
    events.append((d, pressure, vs, drift))

print(f'{len(events)} days\n')
for label in ('DISCOVERY 2023-24', 'HOLDOUT 2025-26'):
    evs = [e for e in events if (e[0] < '2025-01-01') == label.startswith('DISC')]
    print(f'========== {label} ({len(evs)} days) ==========')
    stat_line('  PRE-REG |p|>=0.2 & vs>=1.5: trade pressure dir',
              [(1 if p > 0 else -1) * dr for _, p, vs, dr in evs
               if abs(p) >= 0.2 and vs >= 1.5])
    stat_line('  baseline pressure-only |p|>=0.2 (no vol gate)',
              [(1 if p > 0 else -1) * dr for _, p, vs, dr in evs if abs(p) >= 0.2])
    stat_line('  baseline unconditional (long every day)',
              [dr for _, p, vs, dr in evs])
    for pth in (0.1, 0.3, 0.4):
        stat_line(f'    grid |p|>={pth} & vs>=1.5',
                  [(1 if p > 0 else -1) * dr for _, p, vs, dr in evs
                   if abs(p) >= pth and vs >= 1.5])
    print()
