#!/usr/bin/env python3
"""PILOTFISH E2 — DEALER_DAMP / absorption exhaustion (PLAN.md Phase 2).

Event: minute with volume>=500, travel>=1pt, absorption surprise >=5x AND
volume surprise >=2x, following a directional 15m move (|drift15| >= 0.10%).
Pre-registered: forward 15-30m drift REVERSES the prior move.
Baseline (beat-the-clock analog): same prior-move condition WITHOUT the
absorption event — does any 15m move simply mean-revert?
Discovery 2023-24 / holdout 2025-26. Screening on minute closes.
"""
import sys
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, causal_baseline, stat_line, split_years

rows = load_minutes()
vbase = causal_baseline(rows, 'v')
abase = causal_baseline(rows, 'absn')
print(f'{len(rows)} minutes loaded')

events = []      # (date, revsign_outcome15, outcome30, is_event)
n_evt = 0
for i in range(15, len(rows) - 40):
    r = rows[i]
    if not ('09:30' <= r['hhmm'] <= '15:30'):
        continue
    p15 = rows[i - 15]
    if p15['sym'] != r['sym']:
        continue
    move = r['c'] - p15['c']
    if abs(move) / r['c'] * 100 < 0.10:
        continue
    vb = vbase.get((r['date'], r['hhmm']))
    ab = abase.get((r['date'], r['hhmm']))
    if not vb or not ab:
        continue
    is_event = (r['v'] >= 500 and r['travel'] >= 1.0
                and r['absn'] / ab >= 5.0 and r['v'] / vb >= 2.0)
    # forward closes at +15/+30 traded minutes, same symbol
    f15 = rows[i + 15]
    f30 = rows[i + 30]
    if f30['sym'] != r['sym']:
        continue
    msign = 1 if move > 0 else -1
    # reversal payoff: opposite the prior move
    events.append((r['date'],
                   -msign * (f15['c'] - r['c']),
                   -msign * (f30['c'] - r['c']),
                   is_event))
    n_evt += is_event

print(f'{len(events)} qualifying move-minutes, {n_evt} absorption events\n')

for label, evs in zip(('DISCOVERY 2023-24', 'HOLDOUT 2025-26'), split_years(events)):
    print(f'========== {label} ==========')
    ev = [e for e in evs if e[3]]
    base = [e for e in evs if not e[3]]
    stat_line('  PRE-REG absorption event -> REVERSAL 15m', [e[1] for e in ev])
    stat_line('  PRE-REG absorption event -> REVERSAL 30m', [e[2] for e in ev])
    stat_line('  baseline same move, no event: reversal 15m', [e[1] for e in base])
    stat_line('  baseline same move, no event: reversal 30m', [e[2] for e in base])
    print()
