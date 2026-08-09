#!/usr/bin/env python3
"""
I5 — LT-level state study: does breadth/stress state (TRIN, COR1M Δ5d)
separate WHEN LT levels act as barriers vs accelerants?

Motivation (Drew, 2026-08-09): LT levels are forward-looking by construction;
naked LT reactions were placebo-equivalent (A2 census), but the one level
study that ever beat placebo (DWF) did it with a STATE variable (dealer gamma
sign). TRIN/COR are the cheap analogs: rising correlation = index-driven
forced-flow tape (levels should BREAK); calm two-sided tape (liquidity pools
should HOLD).

Design (A2 episodes.csv re-cut, identical machinery for real + placebo):
  - classes: lt_real vs lt_rand0/1/2 (per-identity random-offset placebos)
    and grid50 (round numbers) as a second family. X=5pt touches.
  - PRIMARY METRIC = real-minus-placebo DELTA within each state, and the
    INTERACTION (delta_stateA - delta_stateB). A state that shifts real and
    placebo equally is tape behavior, NOT level information.
  - Endpoints:
      E1 bounce share (resolved 30m race)      x COR-rising state
      E2 penetration depth beyond30/vol30      x COR-rising state (A2's one
         surviving real-level effect = follow-through damping)
      E3 both endpoints x TRIN-at-touch state (touches >=10:30 ET only)
      E4 breadth-aligned approach: TRIN bull + approach-from-below (and the
         mirror) — does alignment change real-vs-placebo behavior?
  - Significance: day-cluster permutation — shuffle the DAY -> state mapping
    (2000x), preserving within-day correlation of episodes.

Honest notes: pre-registered endpoints only; per-year deltas reported;
2025-04 tariff week flagged (house rule) via with/without headline.
"""
import bisect
import csv
import os
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MACRO = os.path.join(HERE, '..', '..', 'data', 'macro')
ET = ZoneInfo('America/New_York')
RNG = np.random.default_rng(20260809)
N_PERM = 2000
COR_CUT = 2.27          # I2 pre-registered stress cutoff
TARIFF_WEEK = {'2025-04-07', '2025-04-08', '2025-04-09', '2025-04-10', '2025-04-11'}

REAL = 'lt_real'
PLACEBOS = ['lt_rand0', 'lt_rand1', 'lt_rand2']
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


def main():
    cds, cor = load_daily('cor1m')
    trin1h = load_trin_1h()

    def cor_chg5(date):
        i = bisect.bisect_left(cds, date)
        return cor[cds[i - 1]] - cor[cds[i - 6]] if i >= 6 else None

    def trin_at(date, etmin):
        best = None
        for lab, c in trin1h.get(date, []):
            if lab + 60 <= etmin:
                best = c
        return best

    # ---- load episodes (X=5, wanted classes, resolved or with depth) ----
    eps = []
    path = os.path.join(HERE, 'episodes.csv')
    wanted = {REAL, GRID, *PLACEBOS}
    with open(path) as f:
        for row in csv.DictReader(f):
            if row['class'] not in wanted or row['X'] != '5':
                continue
            date = row['date']
            race = row['race30']
            try:
                vol30 = float(row['vol30']) if row['vol30'] else None
                beyond30 = float(row['beyond30']) if row['beyond30'] else None
            except ValueError:
                vol30 = beyond30 = None
            eps.append({
                'date': date, 'cls': row['class'], 'etmin': int(row['etmin']),
                'dir': row['dir'], 'race': race,
                'bey': (beyond30 / vol30) if (beyond30 is not None and vol30 and vol30 > 0) else None,
            })
    dates = sorted({e['date'] for e in eps})
    print(f'=== I5: LT state study — {len(eps):,} X=5 episodes, {len(dates)} days, '
          f'{dates[0]} -> {dates[-1]} ===\n')

    # ---- day-level states ----
    cor_state = {}
    for d in dates:
        v = cor_chg5(d)
        cor_state[d] = None if v is None else ('rising' if v > COR_CUT else 'calm')

    # ---- helpers ----
    def bounce_share(sub):
        b = sum(1 for e in sub if e['race'] == 'bounce')
        k = sum(1 for e in sub if e['race'] in ('bounce', 'break'))
        return (b / k, k) if k else (None, 0)

    def depth_mean(sub):
        v = [e['bey'] for e in sub if e['bey'] is not None]
        return (float(np.mean(v)), len(v)) if v else (None, 0)

    def delta_by_state(pool, statefn, metric):
        """-> {state: {cls_group: (value, n)}} for real / placeboAvg / grid"""
        out = defaultdict(dict)
        for state in ('rising', 'calm'):
            sub = [e for e in pool if statefn(e) == state]
            out[state]['real'] = metric([e for e in sub if e['cls'] == REAL])
            pl = [metric([e for e in sub if e['cls'] == p]) for p in PLACEBOS]
            vals = [v for v, n in pl if v is not None]
            out[state]['placebo'] = (float(np.mean(vals)) if vals else None,
                                     sum(n for _, n in pl))
            out[state]['grid'] = metric([e for e in sub if e['cls'] == GRID])
        return out

    def interaction_perm(pool, kind, label):
        """Observed interaction + day-permutation p (vectorized: per-day
        per-class aggregates precomputed; each permutation is array math).
        interaction = (real-placebo)|rising - (real-placebo)|calm.
        kind: 'bounce' (share of resolved) or 'depth' (mean beyond30/vol30)."""
        day_state = {d: cor_state[d] for d in dates if cor_state[d] is not None}
        ds = sorted({e['date'] for e in pool if e['date'] in day_state})
        di = {d: i for i, d in enumerate(ds)}
        nd = len(ds)
        classes = [REAL] + PLACEBOS
        # per-day numerator/denominator per class
        num = {c: np.zeros(nd) for c in classes}
        den = {c: np.zeros(nd) for c in classes}
        for e in pool:
            c = e['cls']
            if c not in num or e['date'] not in di:
                continue
            i = di[e['date']]
            if kind == 'bounce':
                if e['race'] in ('bounce', 'break'):
                    den[c][i] += 1
                    if e['race'] == 'bounce':
                        num[c][i] += 1
            else:
                if e['bey'] is not None:
                    den[c][i] += 1
                    num[c][i] += e['bey']

        states0 = np.array([day_state[d] == 'rising' for d in ds])

        def calc(rising_mask):
            out = []
            for mask in (rising_mask, ~rising_mask):
                r = num[REAL][mask].sum() / max(den[REAL][mask].sum(), 1e-9)
                pls = [num[p][mask].sum() / max(den[p][mask].sum(), 1e-9) for p in PLACEBOS]
                out.append(r - float(np.mean(pls)))
            return out[0] - out[1]

        obs = calc(states0)
        null = np.empty(N_PERM)
        for i in range(N_PERM):
            null[i] = calc(RNG.permutation(states0))
        p = float((np.abs(null) >= abs(obs)).mean())
        flag = ' ***' if p < 0.05 else ''
        print(f'  {label}: interaction={obs:+.4f}  day-perm p={p:.3f}{flag}')

    # ================= E1/E2: COR state =================
    print('---- E1: bounce share by COR state (real vs placebo families) ----')
    tab = delta_by_state(eps, lambda e: cor_state[e['date']], bounce_share)
    for st in ('rising', 'calm'):
        r, rn = tab[st]['real']
        pl, pn = tab[st]['placebo']
        g, gn = tab[st]['grid']
        print(f'  {st:>6}: real {100*r:.1f}% (n={rn:,}) | rand-placebo {100*pl:.1f}% (n={pn:,}) '
              f'| grid50 {100*g:.1f}% (n={gn:,}) | real-vs-rand delta {100*(r-pl):+.1f}pp')
    interaction_perm(eps, 'bounce', 'E1 interaction (bounce)')
    print()

    print('---- E2: penetration depth beyond30/vol30 (A2 damping survivor) ----')
    tab = delta_by_state(eps, lambda e: cor_state[e['date']], depth_mean)
    for st in ('rising', 'calm'):
        r, rn = tab[st]['real']
        pl, pn = tab[st]['placebo']
        print(f'  {st:>6}: real {r:.3f} (n={rn:,}) | rand-placebo {pl:.3f} (n={pn:,}) '
              f'| delta {r-pl:+.3f} ({100*(r/pl-1):+.1f}%)')
    interaction_perm(eps, 'depth', 'E2 interaction (depth)')
    print()

    # tariff-week exclusion variant (headline robustness)
    eps_ex = [e for e in eps if e['date'] not in TARIFF_WEEK]
    print('---- E1/E2 repeated EXCLUDING 2025-04 tariff week ----')
    interaction_perm(eps_ex, 'bounce', 'E1-ex interaction (bounce)')
    interaction_perm(eps_ex, 'depth', 'E2-ex interaction (depth)')
    print()

    # ================= E3: TRIN-at-touch state =================
    print('---- E3: TRIN at touch (1h, touches >=10:30 ET; bull = TRIN<1) ----')
    pool = []
    for e in eps:
        v = trin_at(e['date'], e['etmin'])
        if v is not None:
            pool.append({**e, 'trin_bull': v < 1.0})
    print(f'  usable episodes with TRIN reading: {len(pool):,}')
    for st, cond in [('bull', True), ('bear', False)]:
        sub = [e for e in pool if e['trin_bull'] == cond]
        r, rn = bounce_share([e for e in sub if e['cls'] == REAL])
        pls = [bounce_share([e for e in sub if e['cls'] == p])[0] for p in PLACEBOS]
        pl = float(np.mean([v for v in pls if v is not None]))
        print(f'  TRIN-{st}: real bounce {100*r:.1f}% (n={rn:,}) vs placebo {100*pl:.1f}% '
              f'| delta {100*(r-pl):+.1f}pp')
    print()

    # ================= E4: breadth-aligned approach =================
    print('---- E4: approach direction x TRIN (aligned = approach WITH breadth) ----')
    print('  (dir=1 approach from below; aligned means with-trend touch: bull+from-below / bear+from-above)')
    for lab, alignfn in [
        ('aligned', lambda e: (e['dir'] == '1') == e['trin_bull']),
        ('counter', lambda e: (e['dir'] == '1') != e['trin_bull']),
    ]:
        sub = [e for e in pool if alignfn(e)]
        r, rn = bounce_share([e for e in sub if e['cls'] == REAL])
        pls = [bounce_share([e for e in sub if e['cls'] == p])[0] for p in PLACEBOS]
        pl = float(np.mean([v for v in pls if v is not None]))
        rd, _ = depth_mean([e for e in sub if e['cls'] == REAL])
        pld = float(np.mean([v for v in [depth_mean([e for e in sub if e['cls'] == p])[0]
                                         for p in PLACEBOS] if v is not None]))
        print(f'  {lab}: real bounce {100*r:.1f}% vs placebo {100*pl:.1f}% (Δ{100*(r-pl):+.1f}pp, n={rn:,}) '
              f'| depth real {rd:.3f} vs pl {pld:.3f} (Δ{rd-pld:+.3f})')

    print('\nRead: only state-dependent REAL-vs-PLACEBO divergence counts as level')
    print('information. Uniform shifts across classes = tape behavior (not tradable via levels).')


if __name__ == '__main__':
    main()
