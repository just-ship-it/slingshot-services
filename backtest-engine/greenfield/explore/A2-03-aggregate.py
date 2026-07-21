#!/usr/bin/env python3
"""A2-03: aggregate episodes.csv into census tables.

Core metric definitions (all from A2-02 fields):
  bounce_share = bounce / (bounce + break) among RESOLVED race30 outcomes
                 (race30: first of +-10pts beyond level vs 10pts rejection,
                  walked bar-by-bar for 30m after the touch bar close).
  fwd30        = 30m close-to-close move in the APPROACH direction
                 (positive = continued toward/through the level).
  reject30/beyond30 = max excursion (pts) each side of the level within 30m.
  norm         = points / vol30 (trailing-20-RTH-day median |30m move|).

Placebo classes ran through IDENTICAL machinery; rand draws pooled.
"""
import csv
import math
import os
import statistics as st
from collections import defaultdict

from a2_common import HERE

EP = os.path.join(HERE, 'episodes.csv')

FAMS = {'gex': ['gex_real', 'gex_rand', 'grid50', 'grid100'],
        'lt': ['lt_real', 'lt_rand', 'grid50', 'grid100']}


def canon(cls):
    if cls.startswith('gex_rand'):
        return 'gex_rand'
    if cls.startswith('lt_rand'):
        return 'lt_rand'
    return cls


def load():
    eps = []
    with open(EP, newline='') as f:
        for r in csv.DictReader(f):
            r['X'] = int(r['X'])
            eps.append(r)
    return eps


def fnum(s):
    return float(s) if s not in ('', None) else None


class Cell:
    def __init__(self):
        self.n = 0
        self.bounce = 0
        self.brk = 0
        self.other = 0        # both/none among walked-30 episodes
        self.fwd30 = []
        self.fwd30n = []
        self.rej30n = []
        self.bey30n = []
        self.rej30 = []
        self.bey30 = []

    def add(self, r):
        self.n += 1
        rc = r['race30']
        if rc == 'bounce':
            self.bounce += 1
        elif rc == 'break':
            self.brk += 1
        elif rc in ('both', 'none'):
            self.other += 1
        f30, v = fnum(r['fwd30']), fnum(r['vol30'])
        if f30 is not None:
            self.fwd30.append(f30)
            if v:
                self.fwd30n.append(f30 / v)
        rj, by = fnum(r['reject30']), fnum(r['beyond30'])
        if rj is not None:
            self.rej30.append(rj)
            self.bey30.append(by)
            if v:
                self.rej30n.append(rj / v)
                self.bey30n.append(by / v)

    @property
    def bounce_share(self):
        d = self.bounce + self.brk
        return self.bounce / d if d else float('nan')

    @property
    def se(self):
        d = self.bounce + self.brk
        if not d:
            return float('nan')
        p = self.bounce_share
        return math.sqrt(p * (1 - p) / d)

    def row(self):
        med = lambda xs: st.median(xs) if xs else float('nan')
        d = self.bounce + self.brk
        return (f'n={self.n:6d} resolved={d:6d} bounce%={100*self.bounce_share:5.1f}'
                f'±{100*self.se:4.1f} medFwd30={med(self.fwd30):+6.1f}pts'
                f' ({med(self.fwd30n):+5.2f}v) medRej30={med(self.rej30):5.1f}'
                f' ({med(self.rej30n):4.2f}v) medBey30={med(self.bey30):5.1f}'
                f' ({med(self.bey30n):4.2f}v)')


def tab(eps, keyfn, title, order=None):
    cells = defaultdict(Cell)
    for r in eps:
        k = keyfn(r)
        if k is not None:
            cells[k].add(r)
    print(f'\n### {title}')
    keys = order if order else sorted(cells)
    for k in keys:
        if k in cells:
            print(f'  {str(k):34s} {cells[k].row()}')
    return cells


def session_bucket(etmin):
    if etmin >= 1080 or etmin < 240:
        return '1-overnight(18-04)'
    if etmin < 570:
        return '2-premkt(04-9:30)'
    if etmin < 660:
        return '3-rth-open(9:30-11)'
    if etmin < 840:
        return '4-rth-mid(11-14)'
    if etmin < 960:
        return '5-rth-close(14-16)'
    return '6-ah(16-18)'


def main():
    eps = load()
    print(f'loaded {len(eps)} episode rows')
    # per-family date windows (real coverage)
    win = {}
    for fam in FAMS:
        ds = [r['date'] for r in eps if r['class'] == f'{fam}_real']
        win[fam] = (min(ds), max(ds))
        print(f'{fam} real coverage: {win[fam]}')

    for fam, classes in FAMS.items():
        lo, hi = win[fam]
        sub = [r for r in eps if canon(r['class']) in classes
               and lo <= r['date'] <= hi]
        print(f'\n================ FAMILY {fam.upper()} (dates {lo}..{hi}) ================')
        for X in (2, 5, 10):
            tab([r for r in sub if r['X'] == X],
                lambda r: canon(r['class']),
                f'{fam} touch census, X={X}',
                order=classes)

        # ---- conditioning (X=5), real vs pooled rand
        x5 = [r for r in sub if r['X'] == 5
              and canon(r['class']) in (f'{fam}_real', f'{fam}_rand')]
        tab(x5, lambda r: (canon(r['class']), session_bucket(int(r['etmin']))),
            f'{fam} X=5 by session')
        tab(x5, lambda r: (canon(r['class']),
                           'first' if r['touch_num'] == '1' else 'retouch'),
            f'{fam} X=5 first-touch vs re-touch')
        def speed_bucket(r):
            a = fnum(r['appr15'])
            v = fnum(r['vol30'])
            if a is None or not v:
                return None
            a = a / v
            b = 'slow(<0.25v)' if a < 0.25 else ('med(0.25-1v)' if a < 1 else 'fast(>1v)')
            return (canon(r['class']), b)
        tab(x5, speed_bucket, f'{fam} X=5 by approach speed (15m move toward level / vol30)')
        def age_bucket(r):
            a = int(r['level_age_min'])
            b = '<30m' if a < 30 else ('30-120m' if a < 120 else '>120m')
            return (canon(r['class']), b)
        tab(x5, age_bucket, f'{fam} X=5 by level age')
        def conf_bucket(r):
            if canon(r['class']) != f'{fam}_real':
                return None
            d = fnum(r['dist_cross'])
            if d is None:
                return None
            return 'confluent(<=10)' if d <= 10 else ('near(10-25)' if d <= 25
                                                      else 'solo(>25)')
        tab(x5, conf_bucket, f'{fam} X=5 real-only: cross-feed confluence')
        def crowd_bucket(r):
            d = fnum(r['dist_same'])
            if d is None:
                return None
            b = 'crowded(<=25)' if d <= 25 else ('mid(25-75)' if d <= 75 else 'isolated(>75)')
            return (canon(r['class']), b)
        tab(x5, crowd_bucket, f'{fam} X=5 by distance to nearest same-feed level')

        # ---- stability: per-year and per-half-year (X=5)
        tab(x5, lambda r: (canon(r['class']), r['date'][:4]),
            f'{fam} X=5 per-year')
        tab(x5, lambda r: (canon(r['class']),
                           r['date'][:4] + ('H1' if r['date'][5:7] <= '06' else 'H2')),
            f'{fam} X=5 per-half-year')

        # ---- dir split (support-test vs resistance-test)
        tab(x5, lambda r: (canon(r['class']),
                           'from-below(res)' if r['dir'] == '1' else 'from-above(sup)'),
            f'{fam} X=5 by approach direction')


if __name__ == '__main__':
    main()
