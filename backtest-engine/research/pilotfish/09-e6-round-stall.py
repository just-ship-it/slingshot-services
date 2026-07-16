#!/usr/bin/env python3
"""PILOTFISH E6 — ROUND-STALL: the DWF episode shape at round hundreds.

Pre-registered in PLAN.md BEFORE any outcome look. Levels = NQ round 100s.
Shape (mirrors shared/strategies/dealer-wall-fade.js): prev minute close
outside the +/-0.05% zone, minute range intersects zone with prev close BELOW
level -> stalling; after 5 more minute closes, if |log(c/entry_c)|*100 <
0.05 -> SHORT at that close. Cooldown 15 traded minutes per level from zone
entry. Outcomes: 60m / 120m fixed horizons (signed, short payoff).
Controls: (a) zone entry WITHOUT stall requirement (fade at entry+5m close
regardless), (b) approach from ABOVE -> LONG. All sessions (DWF trades all
hours). Discovery 2023-24 / holdout 2025-26.
"""
import math
import sys
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, stat_line

rows = load_minutes()
ZONE_PCT, STALL_BARS, STALL_MAX = 0.05, 5, 0.05
COOLDOWN = 15

events = []   # (date, from_below, stalled, pay60, pay120)
eps = {}      # level -> dict(state, entry_c, entry_i, cd_until, below)
cur_date = None
for i, r in enumerate(rows):
    if r['date'] != cur_date:
        cur_date = r['date']
        eps = {}
    c, prevc = r['c'], rows[i - 1]['c'] if i else None
    if prevc is None or rows[i - 1]['sym'] != r['sym']:
        eps = {}
        continue
    base = int(r['l'] // 100) * 100
    for L in (base, base + 100):
        zone = L * ZONE_PCT / 100
        ep = eps.get(L)
        if ep is None or ep['state'] == 'idle':
            if ep and i < ep['cd_until']:
                continue
            if (abs(prevc - L) > zone and r['l'] <= L + zone
                    and r['h'] >= L - zone):
                eps[L] = {'state': 'stall', 'entry_c': c, 'entry_i': i,
                          'below': prevc < L, 'cd_until': i + COOLDOWN}
            continue
        if ep['state'] == 'stall':
            if i - ep['entry_i'] < STALL_BARS:
                continue
            ep['state'] = 'idle'
            stalled = abs(math.log(c / ep['entry_c'])) * 100 < STALL_MAX
            j60, j120 = i + 60, i + 120
            if j120 >= len(rows) or rows[j120]['sym'] != r['sym']:
                continue
            sgn = -1 if ep['below'] else 1   # below->short, above->long
            events.append((r['date'], ep['below'], stalled,
                           sgn * (rows[j60]['c'] - c),
                           sgn * (rows[j120]['c'] - c)))

print(f'{len(events)} zone-entry episodes at round hundreds\n')
for label in ('DISCOVERY 2023-24', 'HOLDOUT 2025-26'):
    evs = [e for e in events if (e[0] < '2025-01-01') == label.startswith('DISC')]
    print(f'========== {label} ({len(evs)} episodes) ==========')
    stat_line('  PRE-REG below+STALL -> short, 60m',
              [e[3] for e in evs if e[1] and e[2]])
    stat_line('  PRE-REG below+STALL -> short, 120m',
              [e[4] for e in evs if e[1] and e[2]])
    stat_line('  ctrl below NO-stall -> short, 120m',
              [e[4] for e in evs if e[1] and not e[2]])
    stat_line('  ctrl above+STALL -> long, 120m',
              [e[4] for e in evs if not e[1] and e[2]])
    stat_line('  ctrl above NO-stall -> long, 120m',
              [e[4] for e in evs if not e[1] and not e[2]])
    print()
