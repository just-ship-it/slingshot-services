#!/usr/bin/env python3
"""
I2 — Vol-web / dispersion / VIX-tailwind gate study on the book sleeves.

Closes out the remaining untested axes from the 6-Pillars review (I1 = internals):
  A. VIX term structure   (VIX9D/VIX, VIX/VIX3M — prior-day close)
  B. Falling-VIX tailwind (5d change, vs 20d SMA — prior-day)
  C. Vol levels           (VIX, VXN, VVIX terciles — prior-day)
  D. Vol-web breadth      (z20 of VIX/MOVE/OVX/GVZ: count>0.5, dispersion,
                           equity-vs-web divergence — prior-day)
  E. Correlation regime   (COR1M level, COR1M-COR3M, 5d change — prior-day)
  F. PCC same-day vol     (VXN change prior-close -> last 1h bar closing <=14:30,
                           aligned with trade side; VIX variant 2023+)

Sleeves: book-pcc-daily.csv (n~709, sides from I1-pcc-joined.csv),
book-monday-daily.csv (n~249, long), book-gapfade-daily.csv (n~125, short).
Gold sleeve excluded (frozen, 42-day holds, not in shadow).

House rules: ONE feature at a time, two-sided permutation placebo (2000x),
per-year splits. ~40 tests -> expect ~2 false positives at alpha=.05; any
survivor goes to I2b structure checks before being called a lead.
Tercile edges computed on the joined trade sample (screening only — noted).
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
RNG = np.random.default_rng(20260808)
N_PERM = 2000


# ---------------------------------------------------------------- loaders

def load_daily(name):
    """-> (sorted_dates, {date: close})"""
    m = {}
    with open(os.path.join(MACRO, f'{name}_1d.csv')) as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split(',')
            if len(p) < 6:
                continue
            try:
                m[p[0]] = float(p[5])
            except ValueError:
                continue
    ds = sorted(m)
    return ds, m


def load_1h(name):
    by = defaultdict(list)
    path = os.path.join(MACRO, f'{name}_1h.csv')
    if not os.path.exists(path):
        return by
    with open(path) as f:
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


def load_book(name):
    out = []
    with open(os.path.join(HERE, f'book-{name}-daily.csv')) as f:
        next(f)
        for line in f:
            d, pnl = line.strip().split(',')
            out.append({'date': d, 'pnl': float(pnl)})
    return out


def prior_val(ds, m, date, lag=1):
    """close of the lag-th trading day strictly before `date` in this series."""
    i = bisect.bisect_left(ds, date)
    j = i - lag
    return m[ds[j]] if j >= 0 else None


def rolling_z(ds, m, win=20):
    """{date: z of close vs its own trailing win-day window (incl. that date)}"""
    vals = np.array([m[d] for d in ds])
    z = {}
    for i in range(win, len(ds)):
        w = vals[i - win + 1:i + 1]
        sd = w.std()
        if sd > 0:
            z[ds[i]] = (vals[i] - w.mean()) / sd
    return z


# ------------------------------------------------------------- analysis

def pf(pnls):
    w = sum(p for p in pnls if p > 0)
    l = -sum(p for p in pnls if p < 0)
    return w / l if l > 0 else float('inf')


def stats_line(label, pnls):
    if not pnls:
        return f'    {label:<30} n=0'
    a = np.array(pnls)
    return (f'    {label:<30} n={len(a):<4} pnl=${a.sum():>9,.0f}  avg=${a.mean():>6,.0f}  '
            f'wr={100 * (a > 0).mean():.1f}%  pf={pf(pnls):.2f}')


def perm_p(mask, pnls):
    mask = np.asarray(mask, bool)
    pnls = np.asarray(pnls, float)
    k = int(mask.sum())
    if k < 5 or k == len(pnls):
        return float('nan')
    obs = pnls[mask].mean() - pnls.mean()
    null = np.empty(N_PERM)
    for i in range(N_PERM):
        idx = RNG.choice(len(pnls), size=k, replace=False)
        null[i] = pnls[idx].mean() - pnls.mean()
    return float((np.abs(null) >= abs(obs)).mean())


def per_year(dates, pnls, mask):
    by = defaultdict(lambda: [[], []])
    for d, p, m in zip(dates, pnls, mask):
        by[d[:4]][0 if m else 1].append(p)
    return [f"{y}: pass ${sum(v[0]):,.0f}({len(v[0])}) / fail ${sum(v[1]):,.0f}({len(v[1])})"
            for y, v in sorted(by.items())]


SURVIVORS = []


def report_binary(name, pnls, feat, dates, hypothesis=''):
    keep = [(t, f, d) for t, f, d in zip(pnls, feat, dates) if f is not None]
    if len(keep) < 20:
        print(f'  {name}: insufficient n={len(keep)} — skipped\n')
        return
    ps = [t for t, _, _ in keep]
    mask = [f > 0 for _, f, _ in keep]
    ds = [d for _, _, d in keep]
    p = perm_p(mask, ps)
    flag = ' ***' if p < 0.05 else ''
    if p < 0.05:
        SURVIVORS.append((name, p))
    print(f'  {name}  (n={len(keep)}, perm-p={p:.3f}){flag}'
          + (f'  [{hypothesis}]' if hypothesis else ''))
    print(stats_line('pass', [x for x, m in zip(ps, mask) if m]))
    print(stats_line('fail', [x for x, m in zip(ps, mask) if not m]))
    for line in per_year(ds, ps, mask):
        print(f'      {line}')
    print()


def report_terciles(name, pnls, feat, dates):
    keep = [(t, f, d) for t, f, d in zip(pnls, feat, dates) if f is not None]
    if len(keep) < 30:
        print(f'  {name}: insufficient n={len(keep)} — skipped\n')
        return
    vals = np.array([f for _, f, _ in keep], float)
    ps = [t for t, _, _ in keep]
    q1, q2 = np.quantile(vals, [1 / 3, 2 / 3])
    print(f'  {name}  (n={len(keep)}, edges {q1:.3f}/{q2:.3f})')
    subs = {}
    for lab, lo, hi in [('T1 low', -np.inf, q1), ('T2 mid', q1, q2), ('T3 high', q2, np.inf)]:
        sub = [p for p, v in zip(ps, vals)
               if (v <= hi if lo == -np.inf else lo < v <= hi)]
        subs[lab] = sub
        print(stats_line(lab, sub))
    for lab, edge_mask in [('T3', vals > q2), ('T1', vals <= q1)]:
        p = perm_p(edge_mask, ps)
        if p < 0.05:
            SURVIVORS.append((f'{name} [{lab}]', p))
            print(f'    {lab} perm-p={p:.3f} ***')
        else:
            print(f'    {lab} perm-p={p:.3f}')
    print()


# ----------------------------------------------------------------- main

def main():
    print('=== I2: vol-web / dispersion / VIX-tailwind gates on the book ===\n')

    names = ['vix', 'vxn', 'vvix', 'vix9d', 'vix3m', 'move', 'ovx', 'gvz', 'cor1m', 'cor3m']
    D = {nm: load_daily(nm) for nm in names}
    Z = {nm: rolling_z(*D[nm]) for nm in ['vix', 'move', 'ovx', 'gvz']}
    vxn_1h = load_1h('vxn')
    vix_1h = load_1h('vix')

    sleeves = {}
    for nm in ['pcc', 'monday', 'gapfade']:
        sleeves[nm] = load_book(nm)
    sides = {}
    with open(os.path.join(HERE, 'I1-pcc-joined.csv')) as f:
        for row in csv.DictReader(f):
            sides[row['date']] = int(row['side'])

    def F(nm, date, lag=1):
        ds, m = D[nm]
        return prior_val(ds, m, date, lag)

    def zprior(nm, date):
        ds, _ = D[nm]
        i = bisect.bisect_left(ds, date)
        return Z[nm].get(ds[i - 1]) if i > 0 else None

    # ---- feature functions (prior-day, causal for all decision times)
    def ts9d(d):
        a, b = F('vix9d', d), F('vix', d)
        return a / b if a and b else None

    def ts3m(d):
        a, b = F('vix', d), F('vix3m', d)
        return a / b if a and b else None

    def vix_chg5(d):
        a, b = F('vix', d, 1), F('vix', d, 6)
        return a / b - 1 if a and b else None

    def vix_vs_sma20(d):
        ds, m = D['vix']
        i = bisect.bisect_left(ds, d)
        if i < 20:
            return None
        w = [m[x] for x in ds[i - 20:i]]
        return m[ds[i - 1]] - np.mean(w)

    def web_count(d):
        zs = [zprior(nm, d) for nm in ['vix', 'move', 'ovx', 'gvz']]
        if any(z is None for z in zs):
            return None
        return sum(1 for z in zs if z > 0.5)

    def web_disp(d):
        zs = [zprior(nm, d) for nm in ['vix', 'move', 'ovx', 'gvz']]
        if any(z is None for z in zs):
            return None
        return float(np.std(zs))

    def eq_div(d):
        zs = {nm: zprior(nm, d) for nm in ['vix', 'move', 'ovx', 'gvz']}
        if any(v is None for v in zs.values()):
            return None
        return zs['vix'] - np.mean([zs['move'], zs['ovx'], zs['gvz']])

    def cor_ts(d):
        a, b = F('cor1m', d), F('cor3m', d)
        return a - b if a and b else None

    def cor_chg5(d):
        a, b = F('cor1m', d, 1), F('cor1m', d, 6)
        return a - b if a and b else None

    # ================= per-sleeve battery =================
    for sleeve, label, side_note in [('pcc', 'PCC (dir-agnostic, 15:00)', None),
                                     ('monday', 'MONDAY (long 09:30)', 'long'),
                                     ('gapfade', 'GAP-FADE (short 09:30)', 'short')]:
        tr = sleeves[sleeve]
        dates = [t['date'] for t in tr]
        pnls = [t['pnl'] for t in tr]
        print(f'================ {label}, n={len(tr)} ================\n')

        # A. term structure
        report_binary('A1 VIX9D/VIX < 1 (calm front)', pnls,
                      [None if (v := ts9d(d)) is None else (1 if v < 1 else -1) for d in dates],
                      dates, 'stress-front inverts edge?')
        report_binary('A2 VIX/VIX3M < 1 (contango)', pnls,
                      [None if (v := ts3m(d)) is None else (1 if v < 1 else -1) for d in dates],
                      dates, 'backwardation = stress')
        report_terciles('A3 VIX/VIX3M terciles', pnls, [ts3m(d) for d in dates], dates)

        # B. falling-VIX tailwind
        report_binary('B1 VIX 5d-change < 0 (falling)', pnls,
                      [None if (v := vix_chg5(d)) is None else (1 if v < 0 else -1) for d in dates],
                      dates, 'vol-target tailwind')
        report_binary('B2 VIX below 20d SMA', pnls,
                      [None if (v := vix_vs_sma20(d)) is None else (1 if v < 0 else -1) for d in dates],
                      dates)
        report_terciles('B3 VIX 5d-change terciles', pnls, [vix_chg5(d) for d in dates], dates)

        # C. vol levels
        report_terciles('C1 VIX level terciles', pnls, [F('vix', d) for d in dates], dates)
        report_terciles('C2 VXN level terciles', pnls, [F('vxn', d) for d in dates], dates)
        report_terciles('C3 VVIX level terciles', pnls, [F('vvix', d) for d in dates], dates)

        # D. vol-web breadth
        report_terciles('D1 web z-count >0.5 (0-4)', pnls, [web_count(d) for d in dates], dates)
        report_terciles('D2 web z-dispersion', pnls, [web_disp(d) for d in dates], dates)
        report_terciles('D3 equity-vs-web z divergence', pnls, [eq_div(d) for d in dates], dates)

        # E. correlation regime
        report_terciles('E1 COR1M level terciles', pnls, [F('cor1m', d) for d in dates], dates)
        report_terciles('E2 COR1M-COR3M term structure', pnls, [cor_ts(d) for d in dates], dates)
        report_terciles('E3 COR1M 5d-change terciles', pnls, [cor_chg5(d) for d in dates], dates)

    # F. PCC same-day vol-change alignment (VXN 2020+, VIX 2023+)
    print('================ PCC same-day vol alignment (F) ================\n')
    tr = sleeves['pcc']
    joined = [t for t in tr if t['date'] in sides]
    pnls = [t['pnl'] for t in joined]
    dates = [t['date'] for t in joined]

    def sameday_vol_align(by_1h, nm):
        out = []
        for t in joined:
            prior = F(nm, t['date'])
            bars = by_1h.get(t['date'], [])
            last = None
            for lab, c in bars:
                if lab + 60 <= 14 * 60 + 30:
                    last = c
            if prior is None or last is None:
                out.append(None)
                continue
            vol_falling = last < prior
            s = sides[t['date']]
            out.append(1 if (vol_falling == (s > 0)) else -1)
        return out

    report_binary('F1 VXN falling-by-14:30 aligns w/ side', pnls,
                  sameday_vol_align(vxn_1h, 'vxn'), dates, 'vol drop confirms long drift')
    report_binary('F2 VIX falling-by-14:30 aligns w/ side [2023+]', pnls,
                  sameday_vol_align(vix_1h, 'vix'), dates)

    # ---- summary
    print('================ SURVIVORS (p<0.05, pre-robustness) ================')
    if SURVIVORS:
        for nm, p in sorted(SURVIVORS, key=lambda x: x[1]):
            print(f'  p={p:.3f}  {nm}')
        print(f'\n  NOTE: ~{40} tests run -> ~2 expected false positives at alpha=.05.'
              '\n  Each survivor needs I2b-style structure checks before "lead" status.')
    else:
        print('  none')


if __name__ == '__main__':
    main()
