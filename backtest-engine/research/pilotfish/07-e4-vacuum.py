#!/usr/bin/env python3
"""PILOTFISH E4 — VACUUM vs BATTLE (PLAN.md Phase 2).

5m move |>=0.06%|: LOW participation (5m volume surprise <0.7x) = vacuum ->
pre-registered continuation 15-30m; EXTREME (>2.5x) = battle -> reversion.
Baseline: mid-participation moves (0.7-2.5x). RTH 09:30-15:30 only.
Discovery 2023-24 / holdout 2025-26. Screening on minute closes.
"""
import sys
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, causal_baseline, stat_line

rows = load_minutes()
vbase = causal_baseline(rows, 'v')

samples = []   # (date, vs5, cont15, cont30)  cont = signed with move dir
for i in range(5, len(rows) - 40):
    r = rows[i]
    if not ('09:30' <= r['hhmm'] <= '15:30'):
        continue
    p5 = rows[i - 5]
    if p5['sym'] != r['sym'] or rows[i + 30]['sym'] != r['sym']:
        continue
    move = r['c'] - p5['c']
    if abs(move) / r['c'] * 100 < 0.06:
        continue
    v5 = sum(rows[k]['v'] for k in range(i - 4, i + 1))
    b5 = 0.0
    ok = True
    for k in range(i - 4, i + 1):
        b = vbase.get((rows[k]['date'], rows[k]['hhmm']))
        if not b:
            ok = False
            break
        b5 += b
    if not ok:
        continue
    ms = 1 if move > 0 else -1
    samples.append((r['date'], v5 / b5,
                    ms * (rows[i + 15]['c'] - r['c']),
                    ms * (rows[i + 30]['c'] - r['c'])))

print(f'{len(samples)} qualifying 5m moves\n')
for label in ('DISCOVERY 2023-24', 'HOLDOUT 2025-26'):
    evs = [s for s in samples if (s[0] < '2025-01-01') == label.startswith('DISC')]
    print(f'========== {label} ({len(evs)}) ==========')
    stat_line('  PRE-REG vacuum (vs<0.7): CONTINUATION 30m',
              [s[3] for s in evs if s[1] < 0.7])
    stat_line('  PRE-REG battle (vs>2.5): REVERSION 30m',
              [-s[3] for s in evs if s[1] > 2.5])
    stat_line('  baseline mid (0.7-2.5): continuation 30m',
              [s[3] for s in evs if 0.7 <= s[1] <= 2.5])
    stat_line('    vacuum continuation 15m', [s[2] for s in evs if s[1] < 0.7])
    stat_line('    battle reversion 15m', [-s[2] for s in evs if s[1] > 2.5])
    print()
