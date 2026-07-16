#!/usr/bin/env python3
"""PILOTFISH M9 — vendor-semantic LT tests: RIP/DIP CURRENTS + eager/organic
(registered 2026-07-15 pre-outcome, after decoding the DeepDive papers).

Vendor claims under test (LT levels = LDPM values at fib windows, NOT S/R):
  RIP current:  all levels below spot AND moving down away from spot -> UP move
  DIP current:  all levels above spot AND moving up away from spot -> DOWN move
  Eager (level_1..4, short windows) vs Organic (level_5) may differ.

Event (15m LT series, knowability-shifted): at each new LT row, config =
(#levels below spot, median level velocity over last 3 rows as % of spot).
RIP = 5 below + median velocity < -vmin (moving down, away).
DIP = 5 above + median velocity > +vmin.
vmin = 0.02% per row (fixed). Outcomes 60/120m points, direction = vendor
prediction (RIP long, DIP short). Controls: same config WITHOUT the motion
condition (position-only), and motion WITHOUT position. Eras x3.
"""
import csv
import statistics
import sys
from datetime import datetime
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, stat_line, TF_MS

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
rows = load_minutes(include_2021=True)
N = len(rows)
row_ms = [int(datetime.fromisoformat(r['ts'] + ':00+00:00').timestamp() * 1000) for r in rows]
import bisect

lt = []   # (knowable_ms, [lv1..lv5])
for r in csv.DictReader(open(f'{BASE}/research/lt-extraction/output/nq_lt_15m_full_2021-2026.csv')):
    try:
        lv = [float(r[f'level_{i}']) for i in range(1, 6)]
    except ValueError:
        continue
    if any(x != x for x in lv):
        continue
    lt.append((int(r['unix_ms']) + TF_MS['15m'], lv))

VMIN = 0.02   # % of spot per 15m row
events = {'RIP': [], 'DIP': [], 'pos_only_bull': [], 'pos_only_bear': [],
          'vel_only_dn': [], 'vel_only_up': []}
for k in range(3, len(lt)):
    ms, lv = lt[k]
    i = bisect.bisect_left(row_ms, ms)
    if i + 120 >= N or row_ms[i] - ms > 5 * 60000:
        continue
    if rows[i + 120]['sym'] != rows[i]['sym']:
        continue
    spot = rows[i]['c']
    below = sum(1 for x in lv if x < spot)
    # median velocity over last 3 rows, % of spot per row
    vels = []
    for j in range(5):
        vels.append((lt[k][1][j] - lt[k - 3][1][j]) / 3 / spot * 100)
    mv = statistics.median(vels)
    date = rows[i]['date']
    c0 = rows[i]['c']
    f60 = rows[i + 60]['c'] - c0
    f120 = rows[i + 120]['c'] - c0
    if below == 5 and mv < -VMIN:
        events['RIP'].append((date, f60, f120))          # long payoff
    if below == 0 and mv > VMIN:
        events['DIP'].append((date, -f60, -f120))        # short payoff
    if below == 5 and abs(mv) <= VMIN:
        events['pos_only_bull'].append((date, f60, f120))
    if below == 0 and abs(mv) <= VMIN:
        events['pos_only_bear'].append((date, -f60, -f120))
    if below < 5 and mv < -VMIN:
        events['vel_only_dn'].append((date, f60, f120))
    if below > 0 and mv > VMIN:
        events['vel_only_up'].append((date, -f60, -f120))

ERAS = (('21-22', lambda d: d < '2023-01-01'),
        ('23-24', lambda d: '2023-01-01' <= d < '2025-01-01'),
        ('25-26', lambda d: d >= '2025-01-01'))
for name, evs in events.items():
    print(f'=== {name} ({len(evs)} events) ===')
    for elab, sel in ERAS:
        e = [x for x in evs if sel(x[0])]
        stat_line(f'  {elab} 120m', [x[2] for x in e])
