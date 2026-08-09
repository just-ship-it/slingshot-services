#!/usr/bin/env python3
"""
I6 — first-hour breadth gate screen (3rd of the TRIN/COR re-look series).

R4 (2026-07-17) established the first 15 minutes CONTINUES rather than
reverses, but no gate converted it into a strategy (B6 dead). The 09:30-09:45
internals reading is a feature that did NOT exist in our data then. Question:
does opening breadth confirmation select the days where the continuation
actually pays?

Data window = intersection of 15m internals (2025-01+) and the primary-1m NQ
cache (-> 2026-06-15): ~355 trading days. SCREEN-GRADE by construction.

Setup per day:
  r15   = 09:30 open -> 09:45 close (primary 1m cache, raw contract)
  side  = sign(r15); |r15| must exceed a noise floor (0.05%)
  outcomes (aligned with side): r45 = 09:45->10:30, rday = 09:45->15:00
Gates (knowable at 09:45:00+, from 15m internals bars labeled 09:30):
  G1 ADD sign == side           G2 ADDQ sign == side
  G3 TICK 15m-bar extreme confirm (bar high>=+800 for up / low<=-800 for down)
  G4 TRIN < 1 for up / > 1 for down
  G5 VOLD sign == side
Permutation placebo per gate (2000x), day-level (one obs per day = no
clustering issue). Continuation measured in POINTS aligned with side.
"""
import csv
import os
from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MACRO = os.path.join(HERE, '..', '..', 'data', 'macro')
CACHE = os.path.join(HERE, 'cache_nq_primary_1m.csv')
ET = ZoneInfo('America/New_York')
RNG = np.random.default_rng(20260809)
N_PERM = 2000
NOISE_FLOOR = 0.0005  # |r15| >= 0.05% of price


def load_15m(name):
    by = {}
    with open(os.path.join(MACRO, f'{name}_15m.csv')) as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split(',')
            if len(p) < 6:
                continue
            et = datetime.fromtimestamp(int(p[1]), tz=ET)
            if et.hour == 9 and et.minute == 30:  # bar closes 09:45
                try:
                    by[et.strftime('%Y-%m-%d')] = {
                        'o': float(p[2]), 'h': float(p[3]), 'l': float(p[4]), 'c': float(p[5])}
                except ValueError:
                    pass
    return by


def main():
    # ---- price: per-day 09:30 open, 09:45 close, 10:30 close, 15:00 close ----
    days = defaultdict(dict)
    with open(CACHE) as f:
        next(f)
        for line in f:
            p = line.split(',')
            ts = p[0]
            if ts < '2024-12-31':
                continue
            dt = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc).astimezone(ET)
            hm = dt.hour * 100 + dt.minute
            d = dt.strftime('%Y-%m-%d')
            if hm == 930:
                days[d]['o930'] = float(p[1])
                days[d]['sym930'] = p[6].strip()
            elif hm == 944:
                days[d]['c945'] = float(p[4])
            elif hm == 1029:
                days[d]['c1030'] = float(p[4])
            elif hm == 1459:
                days[d]['c1500'] = float(p[4])
                days[d]['sym1500'] = p[6].strip()

    tick = load_15m('tick')
    add = load_15m('add')
    addq = load_15m('addq')
    vold = load_15m('vold')
    trin = load_15m('trin')

    rows = []
    for d in sorted(days):
        v = days[d]
        if not all(k in v for k in ('o930', 'c945', 'c1030', 'c1500')):
            continue
        if v.get('sym930') != v.get('sym1500'):  # rollover day guard
            continue
        if d < '2025-01-02' or d not in add:
            continue
        r15 = v['c945'] - v['o930']
        if abs(r15) / v['o930'] < NOISE_FLOOR:
            continue
        side = 1 if r15 > 0 else -1
        rows.append({
            'date': d, 'side': side,
            'r45': (v['c1030'] - v['c945']) * side,
            'rday': (v['c1500'] - v['c945']) * side,
            'add': add[d]['c'], 'addq': addq.get(d, {}).get('c'),
            'vold': vold.get(d, {}).get('c'),
            'trin': trin.get(d, {}).get('c'),
            'tick_h': tick.get(d, {}).get('h'), 'tick_l': tick.get(d, {}).get('l'),
        })
    print(f'=== I6: first-hour breadth screen — {len(rows)} qualifying days '
          f'(2025-01 -> 2026-06, |r15|>=0.05%) ===\n')

    def perm_p(mask, vals):
        mask = np.asarray(mask, bool)
        vals = np.asarray(vals, float)
        k = int(mask.sum())
        if k < 5 or k == len(vals):
            return float('nan')
        obs = vals[mask].mean() - vals.mean()
        null = np.empty(N_PERM)
        for i in range(N_PERM):
            idx = RNG.choice(len(vals), size=k, replace=False)
            null[i] = vals[idx].mean() - vals.mean()
        return float((np.abs(null) >= abs(obs)).mean())

    for out_key, out_lab in [('r45', '09:45->10:30'), ('rday', '09:45->15:00')]:
        vals = [r[out_key] for r in rows]
        a = np.array(vals)
        print(f'---- outcome: aligned continuation {out_lab} (pts) ----')
        print(f'  ALL: n={len(a)} mean {a.mean():+.1f}pt  wr {100*(a>0).mean():.0f}%')
        gates = [
            ('G1 ADD confirms', lambda r: None if r['add'] is None else (r['add'] > 0) == (r['side'] > 0)),
            ('G2 ADDQ confirms', lambda r: None if r['addq'] is None else (r['addq'] > 0) == (r['side'] > 0)),
            ('G3 TICK extreme confirms', lambda r: None if r['tick_h'] is None else
                (r['tick_h'] >= 800 if r['side'] > 0 else r['tick_l'] <= -800)),
            ('G4 TRIN confirms', lambda r: None if r['trin'] is None else
                (r['trin'] < 1) == (r['side'] > 0)),
            ('G5 VOLD confirms', lambda r: None if r['vold'] is None else
                (r['vold'] > 0) == (r['side'] > 0)),
        ]
        for lab, fn in gates:
            keep = [(r[out_key], fn(r)) for r in rows if fn(r) is not None]
            m = [f for _, f in keep]
            v = [x for x, _ in keep]
            va = np.array(v)
            pas = va[np.array(m)]
            fal = va[~np.array(m)]
            p = perm_p(m, v)
            flag = ' ***' if p < 0.05 else ''
            print(f'  {lab:<26} pass n={len(pas):<3} {pas.mean():+6.1f}pt wr{100*(pas>0).mean():3.0f}% | '
                  f'fail n={len(fal):<3} {fal.mean():+6.1f}pt wr{100*(fal>0).mean():3.0f}% | p={p:.3f}{flag}')
        print()

    print('NOTE: 19-month window, screen-grade. Survivors need OOS accumulation')
    print('(the 15m internals archive grows via --merge) before any sim.')


if __name__ == '__main__':
    main()
