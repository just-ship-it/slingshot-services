#!/usr/bin/env python3
"""PILOTFISH M4 — slow LT levels (1h/4h) as intraday S/R (PLAN.md Phase 3b).

Touch episode: prev 1m close outside the ±0.05% zone around a level from the
CURRENT knowable HTF LT row (stamp+TF shift), bar range intersects zone.
Fade payoff = drift back toward the approach side at 30/60m from touch close.
Controls: same machinery on (a) the level set shifted +37pt, (b) round 100s.
Pre-registered: real levels reject more than both controls.
Splits: 2021-23 / 2024 / 2025-26.
"""
import bisect
import csv
import statistics
import sys
from datetime import datetime
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, stat_line, TF_MS

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
rows = load_minutes()
row_ms = [int(datetime.fromisoformat(r['ts'] + ':00+00:00').timestamp() * 1000) for r in rows]


def load_lt(tf):
    ts, lvsets = [], []
    with open(f'{BASE}/research/lt-extraction/output/nq_lt_{tf}_raw.csv') as f:
        for r in csv.DictReader(f):
            try:
                lv = [float(r[f'level_{i}']) for i in range(1, 6)]
            except ValueError:
                continue
            if any(x != x for x in lv):
                continue
            ts.append(int(r['unix_ms']) + TF_MS[tf])   # knowable-from
            lvsets.append(lv)
    return ts, lvsets


def run(tf, mode):
    """mode: 'real' | 'shift37' | 'round100'"""
    lts, lsets = load_lt(tf)
    events = []   # (date, fade30, fade60)
    cooldown = {}  # level key -> row index until
    li = 0
    for i in range(1, len(rows) - 70):
        r = rows[i]
        ms = row_ms[i]
        while li + 1 < len(lts) and lts[li + 1] <= ms:
            li += 1
        if lts[li] > ms:
            continue
        if mode == 'round100':
            base_ = int(r['l'] // 100) * 100
            levels = [base_, base_ + 100]
        else:
            levels = lsets[li]
            if mode == 'shift37':
                levels = [x + 37 for x in levels]
        prevc = rows[i - 1]['c']
        if rows[i - 1]['sym'] != r['sym'] or rows[i + 60]['sym'] != r['sym']:
            continue
        for L in levels:
            zone = L * 0.05 / 100
            key = round(L)
            if cooldown.get(key, -1) > i:
                continue
            if abs(prevc - L) > zone and r['l'] <= L + zone and r['h'] >= L - zone:
                cooldown[key] = i + 30
                sgn = -1 if prevc < L else 1   # fade = back toward approach side
                events.append((r['date'],
                               sgn * (rows[i + 30]['c'] - r['c']),
                               sgn * (rows[i + 60]['c'] - r['c'])))
    return events


for tf in ('1h', '4h'):
    print(f'########## LT {tf} levels ##########')
    res = {m: run(tf, m) for m in ('real', 'shift37', 'round100')}
    for label, sel in (('2021-23', lambda x: x < '2024-01-01'),
                       ('2024', lambda x: '2024-01-01' <= x < '2025-01-01'),
                       ('2025-26', lambda x: x >= '2025-01-01')):
        print(f'--- {label} ---')
        for m in ('real', 'shift37', 'round100'):
            evs = [e for e in res[m] if sel(e[0])]
            stat_line(f'  {m:9s} fade 60m', [e[2] for e in evs])
    print()
