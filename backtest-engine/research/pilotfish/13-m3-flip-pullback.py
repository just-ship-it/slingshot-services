#!/usr/bin/env python3
"""PILOTFISH M3 — HTF flip + LTF pullback entry (PLAN.md Phase 3b).

Event: a 15m (or 1h) flip becomes KNOWABLE. Variant A enters immediately at
the knowability instant, direction = flip. Variant B (pre-registered winner)
waits for the first 5m counter-state to appear and enters when the 5m state
returns to alignment (pullback resolution), timeout 4h. Exit: 60m / 120m.
Splits: 2021-23 / 2024 / 2025-26.
"""
import statistics
import sys
from datetime import datetime
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, LsSeries, stat_line

rows = load_minutes()
row_ms = [int(datetime.fromisoformat(r['ts'] + ':00+00:00').timestamp() * 1000) for r in rows]
import bisect
ls5 = LsSeries('5m')

for HTF in ('15m', '1h'):
    hs = LsSeries(HTF)
    events = []   # (date, dir, immediate60, immediate120, pull60, pull120)
    for k in range(1, len(hs.ts)):
        if hs.st[k] == hs.st[k - 1]:
            continue
        ms = hs.ts[k]          # knowability instant (already shifted)
        d = hs.st[k]
        i = bisect.bisect_left(row_ms, ms)
        if i + 120 >= len(rows) or row_ms[i] - ms > 5 * 60000:
            continue
        if rows[i + 120]['sym'] != rows[i]['sym']:
            continue
        sgn = 1 if d == 1 else -1
        imm60 = sgn * (rows[i + 60]['c'] - rows[i]['c'])
        imm120 = sgn * (rows[i + 120]['c'] - rows[i]['c'])
        # pullback: first 5m counter, then realign, within 240m of flip
        pull60 = pull120 = None
        seen_counter = False
        j = i
        while j < min(i + 240, len(rows) - 130):
            s5 = ls5.state_at(row_ms[j])
            if s5 is not None:
                if s5 != d:
                    seen_counter = True
                elif seen_counter:
                    if rows[j + 120]['sym'] == rows[j]['sym']:
                        pull60 = sgn * (rows[j + 60]['c'] - rows[j]['c'])
                        pull120 = sgn * (rows[j + 120]['c'] - rows[j]['c'])
                    break
            j += 1
        events.append((rows[i]['date'], d, imm60, imm120, pull60, pull120))

    print(f'########## HTF = {HTF} ({len(events)} flips) ##########')
    for label, sel in (('2021-23', lambda x: x < '2024-01-01'),
                       ('2024', lambda x: '2024-01-01' <= x < '2025-01-01'),
                       ('2025-26', lambda x: x >= '2025-01-01')):
        evs = [e for e in events if sel(e[0])]
        print(f'--- {label} ({len(evs)}) ---')
        stat_line('  A immediate entry, 120m', [e[3] for e in evs])
        stat_line('  B pullback entry, 120m', [e[5] for e in evs if e[5] is not None])
    print()
