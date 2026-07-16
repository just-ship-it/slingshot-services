#!/usr/bin/env python3
"""PILOTFISH M6 — LT level CROSSOVER continuation (registered 2026-07-14
before outcome look; follows the M4 hint: real levels lose more to fades
than placebo => differential break-through continuation).

Event: 1m close CROSSES a knowable slow LT level (prev close >=1 zone on one
side, current close >=1 zone beyond the other side; zone = 0.05% of level).
Payoff: continuation in the crossing direction at 30/60/120m from the
crossing close. Controls: +37pt-shifted level set, round hundreds.
TFs: LT 15m / 1h / 4h. Splits: 2021-23 / 2024 / 2025-26. Costs 2pt+$4.
"""
import bisect
import csv
import sys
from datetime import datetime
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, stat_line, TF_MS

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
rows = load_minutes()
row_ms = [int(datetime.fromisoformat(r['ts'] + ':00+00:00').timestamp() * 1000) for r in rows]


def load_lt(tf):
    fn = (f'{BASE}/research/lt-extraction/output/nq_lt_15m_full_2021-2026.csv'
          if tf == '15m' else
          f'{BASE}/research/lt-extraction/output/nq_lt_{tf}_raw.csv')
    ts, lvsets = [], []
    with open(fn) as f:
        for r in csv.DictReader(f):
            try:
                lv = [float(r[f'level_{i}']) for i in range(1, 6)]
            except ValueError:
                continue
            if any(x != x for x in lv):
                continue
            ts.append(int(r['unix_ms']) + TF_MS[tf])
            lvsets.append(lv)
    return ts, lvsets


def run(tf, mode):
    lts, lsets = load_lt(tf)
    events = []   # (date, cont30, cont60, cont120)
    cooldown = {}
    li = 0
    for i in range(1, len(rows) - 130):
        r = rows[i]
        ms = row_ms[i]
        while li + 1 < len(lts) and lts[li + 1] <= ms:
            li += 1
        if lts[li] > ms:
            continue
        if mode == 'round100':
            base_ = int(r['c'] // 100) * 100
            levels = [base_, base_ + 100]
        else:
            levels = lsets[li]
            if mode == 'shift37':
                levels = [x + 37 for x in levels]
        prevc = rows[i - 1]['c']
        if rows[i - 1]['sym'] != r['sym'] or rows[i + 120]['sym'] != r['sym']:
            continue
        for L in levels:
            zone = L * 0.05 / 100
            key = round(L)
            if cooldown.get(key, -1) > i:
                continue
            up = prevc <= L - zone and r['c'] >= L + zone
            dn = prevc >= L + zone and r['c'] <= L - zone
            if not (up or dn):
                continue
            cooldown[key] = i + 30
            sgn = 1 if up else -1
            events.append((r['date'],
                           sgn * (rows[i + 30]['c'] - r['c']),
                           sgn * (rows[i + 60]['c'] - r['c']),
                           sgn * (rows[i + 120]['c'] - r['c'])))
    return events


for tf in ('15m', '1h', '4h'):
    print(f'########## LT {tf} level crossovers ##########')
    res = {}
    for m in ('real', 'shift37', 'round100'):
        res[m] = run(tf, m)
    for label, sel in (('2021-23', lambda x: x < '2024-01-01'),
                       ('2024', lambda x: '2024-01-01' <= x < '2025-01-01'),
                       ('2025-26', lambda x: x >= '2025-01-01')):
        print(f'--- {label} ---')
        for m in ('real', 'shift37', 'round100'):
            evs = [e for e in res[m] if sel(e[0])]
            stat_line(f'  {m:9s} continuation 60m', [e[2] for e in evs])
            stat_line(f'  {m:9s} continuation 120m', [e[3] for e in evs])
    print()
