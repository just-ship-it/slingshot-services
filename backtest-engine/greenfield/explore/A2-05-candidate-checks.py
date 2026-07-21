#!/usr/bin/env python3
"""A2-05: artifact controls + per-year deltas for the two candidate effects
that emerged from A2-03.

Candidate 1 — LT excursion damping: 30m excursions (both sides of the level)
are smaller after touching real LT levels than matched random-offset placebo.
ARTIFACT RISK: LT levels drift; a level can drift ONTO a quiet price, firing
a "touch" while price does nothing (its placebo twin, offset 30-120pts away,
does not fire). Control: restrict to PRICE-DRIVEN touches, appr15 >= 20pts
(price itself covered most of the arm distance in the prior 15m).

Candidate 2 — GEX permeability: fwd30 (drift in approach direction) and
beyond30 (penetration) slightly LARGER at real GEX levels than placebo.
Report per-year real-vs-rand deltas with a paired-dates bootstrap-free view:
median deltas + sign stability.
"""
import csv
import os
import statistics as st
from collections import defaultdict

from a2_common import HERE

EP = os.path.join(HERE, 'episodes.csv')


def canon(cls):
    if cls.startswith('gex_rand'):
        return 'gex_rand'
    if cls.startswith('lt_rand'):
        return 'lt_rand'
    return cls


def fnum(s):
    return float(s) if s not in ('', None) else None


def med(xs):
    return st.median(xs) if xs else float('nan')


def main():
    rows = defaultdict(lambda: defaultdict(list))   # (fam, kind, year) -> field -> vals
    with open(EP, newline='') as f:
        for r in csv.DictReader(f):
            if r['X'] != '5':
                continue
            c = canon(r['class'])
            year = r['date'][:4]
            targets = []
            if c in ('lt_real', 'lt_rand', 'gex_real', 'gex_rand'):
                targets.append(tuple(c.split('_')))
            elif c in ('grid50', 'grid100'):
                # grids join BOTH family comparisons, window-restricted
                targets.append(('lt', c))
                if r['date'] >= '2023-03-29':
                    targets.append(('gex', c))
            else:
                continue
            v = fnum(r['vol30'])
            rj, by, f30 = fnum(r['reject30']), fnum(r['beyond30']), fnum(r['fwd30'])
            a15 = fnum(r['appr15'])
            for fam, kind in targets:
                for yk in (year, 'ALL'):
                    d = rows[(fam, kind, yk)]
                    if rj is not None and v:
                        d['rejn'].append(rj / v)
                        d['beyn'].append(by / v)
                        if a15 is not None and a15 >= 20:
                            d['rejn_pd'].append(rj / v)   # price-driven subset
                            d['beyn_pd'].append(by / v)
                    if f30 is not None and v:
                        d['fwdn'].append(f30 / v)
                        if a15 is not None and a15 >= 20:
                            d['fwdn_pd'].append(f30 / v)

    def table(fam, fields, title):
        print(f'\n### {title}')
        years = sorted({y for (f, k, y) in rows if f == fam and y != 'ALL'}) + ['ALL']
        for y in years:
            re = rows.get((fam, 'real', y), {})
            ra = rows.get((fam, 'rand', y), {})
            g5 = rows.get((fam, 'grid50', y), {})
            parts = [f'{y}:']
            for fld in fields:
                a, b, g = re.get(fld, []), ra.get(fld, []), g5.get(fld, [])
                if a and b:
                    s = (f'{fld} real={med(a):+.3f}(n={len(a)}) '
                         f'rand={med(b):+.3f}(n={len(b)}) '
                         f'Δr={med(a)-med(b):+.3f}')
                    if g:
                        s += f' grid50={med(g):+.3f} Δg={med(a)-med(g):+.3f}'
                    parts.append(s)
            print('  ' + '  |  '.join(parts))

    table('lt', ['rejn', 'beyn'],
          'LT damping, ALL touches (X=5, vol-normalized 30m excursions)')
    table('lt', ['rejn_pd', 'beyn_pd'],
          'LT damping, PRICE-DRIVEN touches only (appr15>=20pts)')
    table('gex', ['fwdn', 'beyn'],
          'GEX permeability, ALL touches (X=5)')
    table('gex', ['fwdn_pd', 'beyn_pd'],
          'GEX permeability, PRICE-DRIVEN touches only (appr15>=20pts)')


if __name__ == '__main__':
    main()
