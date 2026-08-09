#!/usr/bin/env python3
"""
I5b — robustness on the I5 finding: LT-level follow-through damping is a
CALM-REGIME effect (real-vs-placebo depth delta −11% calm vs −4% COR-rising,
interaction p=0.018 / 0.003 ex-tariff).

Checks:
  1. Per-year real-vs-rand depth delta in each state — sign stability.
  2. Second placebo family: real-vs-GRID50 interaction (round numbers).
  3. Monotonicity: COR Δ5d terciles (falling / mid / rising) — damping should
     weaken monotonically toward rising.
  4. X=10 touches (wider arm) — same pattern?
"""
import bisect
import csv
import os
from collections import defaultdict

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MACRO = os.path.join(HERE, '..', '..', 'data', 'macro')
RNG = np.random.default_rng(20260809)

REAL = 'lt_real'
RANDS = ['lt_rand0', 'lt_rand1', 'lt_rand2']
GRID = 'grid50'


def load_daily(name):
    m = {}
    with open(os.path.join(MACRO, f'{name}_1d.csv')) as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split(',')
            if len(p) >= 6:
                try:
                    m[p[0]] = float(p[5])
                except ValueError:
                    pass
    return sorted(m), m


def main():
    cds, cor = load_daily('cor1m')

    def cor_chg5(date):
        i = bisect.bisect_left(cds, date)
        return cor[cds[i - 1]] - cor[cds[i - 6]] if i >= 6 else None

    wanted = {REAL, GRID, *RANDS}
    eps = defaultdict(list)  # X -> episodes
    with open(os.path.join(HERE, 'episodes.csv')) as f:
        for row in csv.DictReader(f):
            if row['class'] not in wanted or row['X'] not in ('5', '10'):
                continue
            try:
                vol30 = float(row['vol30']) if row['vol30'] else None
                beyond30 = float(row['beyond30']) if row['beyond30'] else None
            except ValueError:
                continue
            if vol30 is None or beyond30 is None or vol30 <= 0:
                continue
            eps[row['X']].append((row['date'], row['class'], beyond30 / vol30))

    cor_cache = {}

    def state3(date):
        if date not in cor_cache:
            cor_cache[date] = cor_chg5(date)
        v = cor_cache[date]
        if v is None:
            return None
        return 'rising' if v > 2.27 else ('falling' if v < -1.77 else 'mid')

    def depth(sub_iter):
        v = [b for b in sub_iter]
        return float(np.mean(v)) if v else None

    def delta(pool, statewant, placebo_classes):
        r = [b for d, c, b in pool if c == REAL and state3(d) == statewant]
        pl = []
        for pc in placebo_classes:
            x = [b for d, c, b in pool if c == pc and state3(d) == statewant]
            if x:
                pl.append(float(np.mean(x)))
        if not r or not pl:
            return None, 0
        return float(np.mean(r)) - float(np.mean(pl)), len(r)

    # ---- 1. per-year deltas (X=5, rand placebos, binary state) ----
    print('=== 1. per-year real-vs-rand depth delta by state (X=5) ===')
    years = sorted({d[:4] for d, _, _ in eps['5']})
    for y in years:
        pool = [(d, c, b) for d, c, b in eps['5'] if d[:4] == y]
        row = [f'{y}:']
        for st in ('falling', 'mid', 'rising'):
            dl, n = delta(pool, st, RANDS)
            row.append(f'{st} {dl:+.3f}(n={n})' if dl is not None else f'{st} n/a')
        print('  ' + '  '.join(row))

    # ---- 2. grid50 family ----
    print('\n=== 2. real-vs-GRID50 (second placebo family, X=5) ===')
    for st in ('falling', 'mid', 'rising'):
        dl, n = delta(eps['5'], st, [GRID])
        print(f'  {st:>7}: delta {dl:+.3f} (real n={n})')

    # ---- 3. tercile monotonicity (rand placebos) ----
    print('\n=== 3. COR tercile monotonicity (X=5, rand placebos) ===')
    for st in ('falling', 'mid', 'rising'):
        dl, n = delta(eps['5'], st, RANDS)
        print(f'  {st:>7}: real-vs-rand delta {dl:+.3f} (real n={n})')

    # ---- 4. X=10 ----
    print('\n=== 4. X=10 touches (wider arm) ===')
    for st in ('falling', 'mid', 'rising'):
        dl, n = delta(eps['10'], st, RANDS)
        print(f'  {st:>7}: real-vs-rand delta {dl:+.3f} (real n={n})')


if __name__ == '__main__':
    main()
