#!/usr/bin/env python3
"""
I1b — robustness checks on the one I1 lead: PCC x TRIN alignment
(pass = TRIN<1 on longs / TRIN>1 on shorts, last 1h bar closing <=14:30 ET).

I1 result: perm-p=0.034, pass PF 1.77 (n=398) vs fail 1.10 (n=310), pass
positive all 6 years. But it was 1 of ~13 tests -> needs structure checks:
  1. Threshold sweep 0.8..1.2 — plateau or knife-edge?
  2. Cutoff-time sweep (12:30 / 13:30 / 14:30 label limit) — stable?
  3. |day-move| control — does alignment survive within move-size terciles,
     or is TRIN just proxying "big aligned day"?
  4. PLACEBO: prior-day TRIN alignment (same machinery, stale info) — should
     be materially weaker if the signal is same-day information.
"""
import csv
import os
from importlib import import_module
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
I1 = import_module('I1-internals-gate'.replace('-', '_')) if False else None

# lightweight local copies (I1 module name has dashes; just re-implement)
import sys
sys.path.insert(0, HERE)
from datetime import datetime
from zoneinfo import ZoneInfo
from collections import defaultdict

ET = ZoneInfo('America/New_York')
MACRO = os.path.join(HERE, '..', '..', 'data', 'macro')
RNG = np.random.default_rng(20260808)


def load_trin_1h():
    by = defaultdict(list)
    with open(os.path.join(MACRO, 'trin_1h.csv')) as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split(',')
            if len(p) < 6:
                continue
            et = datetime.fromtimestamp(int(p[1]), tz=ET)
            by[et.strftime('%Y-%m-%d')].append((et.hour * 60 + et.minute, float(p[5])))
    for d in by:
        by[d].sort()
    return by


def trin_at(by, date, label_limit_min):
    bars = by.get(date, [])
    best = None
    for lab, c in bars:
        if lab <= label_limit_min:
            best = c
    return best


def pf(pnls):
    w = sum(p for p in pnls if p > 0)
    l = -sum(p for p in pnls if p < 0)
    return w / l if l > 0 else float('inf')


def perm_p(mask, pnls, n=2000):
    mask = np.asarray(mask, bool)
    pnls = np.asarray(pnls, float)
    k = int(mask.sum())
    if k < 5 or k == len(pnls):
        return float('nan')
    obs = pnls[mask].mean() - pnls.mean()
    null = np.empty(n)
    for i in range(n):
        idx = RNG.choice(len(pnls), size=k, replace=False)
        null[i] = pnls[idx].mean() - pnls.mean()
    return float((np.abs(null) >= abs(obs)).mean())


def line(label, pnls):
    if not pnls:
        return f'  {label:<34} n=0'
    a = np.array(pnls)
    return (f'  {label:<34} n={len(a):<4} pnl=${a.sum():>9,.0f} avg=${a.mean():>6,.0f} '
            f'pf={pf(pnls):.2f}')


def main():
    trades = []
    with open(os.path.join(HERE, 'I1-pcc-joined.csv')) as f:
        r = csv.DictReader(f)
        for row in r:
            trades.append({'date': row['date'], 'pnl': float(row['pnl']),
                           'side': int(row['side']), 'move': float(row['day_move'])})
    by = load_trin_1h()
    dates_sorted = sorted(by)

    print('=== I1b: PCC x TRIN alignment robustness ===\n')

    # 1. threshold sweep at 14:30 label cutoff (bar closes 14:30 when labeled 13:30
    #    -- label_limit 13:30 = 810 min gives closes <=14:30)
    print('-- 1. TRIN threshold sweep (1h bars closing <=14:30) --')
    for th in [0.8, 0.9, 1.0, 1.1, 1.2]:
        passes, fails, mask, pnls = [], [], [], []
        for t in trades:
            c = trin_at(by, t['date'], 13 * 60 + 30)
            if c is None:
                continue
            aligned = (c < th) == (t['side'] > 0)
            (passes if aligned else fails).append(t['pnl'])
            mask.append(aligned)
            pnls.append(t['pnl'])
        p = perm_p(mask, pnls)
        print(f'  th={th}: pass pf={pf(passes):.2f} (n={len(passes)}) | '
              f'fail pf={pf(fails):.2f} (n={len(fails)}) | perm-p={p:.3f}')

    # 2. cutoff-time sweep at th=1.0
    print('\n-- 2. cutoff-time sweep (label limit; bar closes limit+60m) --')
    for lab_hm, lab_min in [('11:30', 690), ('12:30', 750), ('13:30', 810)]:
        passes, fails = [], []
        for t in trades:
            c = trin_at(by, t['date'], lab_min)
            if c is None:
                continue
            (passes if (c < 1.0) == (t['side'] > 0) else fails).append(t['pnl'])
        print(f'  closes<={int(lab_hm[:2])+1}:30: pass pf={pf(passes):.2f} '
              f'(n={len(passes)}) | fail pf={pf(fails):.2f} (n={len(fails)})')

    # 3. |move| control: within move-size terciles
    print('\n-- 3. |day-move| tercile control (th=1.0, closes<=14:30) --')
    moves = np.array([abs(t['move']) for t in trades])
    q1, q2 = np.quantile(moves, [1 / 3, 2 / 3])
    for lab, lo, hi in [('small', 0, q1), ('mid', q1, q2), ('large', q2, 1e9)]:
        passes, fails = [], []
        for t in trades:
            if not (lo < abs(t['move']) <= hi):
                continue
            c = trin_at(by, t['date'], 810)
            if c is None:
                continue
            (passes if (c < 1.0) == (t['side'] > 0) else fails).append(t['pnl'])
        print(f'  |move| {lab:<5} ({lo:.0f}-{hi:.0f}pt): '
              f'pass pf={pf(passes):.2f} (n={len(passes)}) | '
              f'fail pf={pf(fails):.2f} (n={len(fails)})')

    # 4. placebo: PRIOR-day TRIN (last bar of prior trading day), same machinery
    print('\n-- 4. placebo: prior-day TRIN alignment (stale info) --')
    import bisect
    passes, fails, mask, pnls = [], [], [], []
    for t in trades:
        i = bisect.bisect_left(dates_sorted, t['date'])
        if i == 0:
            continue
        prev = by[dates_sorted[i - 1]]
        c = prev[-1][1] if prev else None
        if c is None:
            continue
        aligned = (c < 1.0) == (t['side'] > 0)
        (passes if aligned else fails).append(t['pnl'])
        mask.append(aligned)
        pnls.append(t['pnl'])
    p = perm_p(mask, pnls)
    print(f'  prior-day: pass pf={pf(passes):.2f} (n={len(passes)}) | '
          f'fail pf={pf(fails):.2f} (n={len(fails)}) | perm-p={p:.3f}')

    # context: same-day headline for comparison
    print('\n-- headline (same-day, th=1.0, closes<=14:30) --')
    passes, fails = [], []
    for t in trades:
        c = trin_at(by, t['date'], 810)
        if c is None:
            continue
        (passes if (c < 1.0) == (t['side'] > 0) else fails).append(t['pnl'])
    print(line('pass', passes))
    print(line('fail', fails))


if __name__ == '__main__':
    main()
