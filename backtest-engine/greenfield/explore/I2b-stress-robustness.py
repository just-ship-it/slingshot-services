#!/usr/bin/env python3
"""
I2b — structure checks on the I2 finding: PCC edge concentrates in STRESS
regimes (rising COR1M p=0.004, inverted VIX term structure, high VVIX; VIX
level/change same direction sub-threshold). All proxies correlated -> treat as
ONE factor. Checks:

  1. SCALE CONFOUND (make-or-break): high-vol days have bigger point moves, so
     $-PnL uplift may be pure scale. Re-test stress terciles on ATR-normalized
     PnL (pnl / prior-day NQ ATR14 from TV daily ranges). Also WR per tercile
     (scale-free).
  2. E3 cutoff sweep: COR1M 5d-change > {-2,-1,0,1,2,3} — plateau or knife-edge?
  3. Lag placebo: COR1M change lagged 5 extra days — timely-info check.
  4. Flag agreement matrix across the 5 "survivors" — how redundant?
  5. TRIN(I1) x stress 2x2 — overlap diagnostic (NOT combo tuning).
  6. Per-year for E3 top tercile.
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


def load_daily(name):
    m = {}
    with open(os.path.join(MACRO, f'{name}_1d.csv')) as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split(',')
            if len(p) < 6:
                continue
            try:
                m[p[0]] = {'c': float(p[5]), 'h': float(p[3]), 'l': float(p[4])}
            except ValueError:
                continue
    return sorted(m), m


def prior(ds, m, date, lag=1):
    i = bisect.bisect_left(ds, date)
    j = i - lag
    return m[ds[j]] if j >= 0 else None


def pf(x):
    w = sum(v for v in x if v > 0)
    l = -sum(v for v in x if v < 0)
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


def main():
    # trades + sides
    trades = []
    with open(os.path.join(HERE, 'I1-pcc-joined.csv')) as f:
        for row in csv.DictReader(f):
            trades.append({'date': row['date'], 'pnl': float(row['pnl']),
                           'side': int(row['side'])})

    D = {nm: load_daily(nm) for nm in
         ['vix', 'vix9d', 'vix3m', 'vvix', 'cor1m', 'cor3m', 'nq']}

    # NQ ATR14 (TV daily session ranges, ending prior day) as scale normalizer
    nq_ds, nq_m = D['nq']
    atr = {}
    ranges = [nq_m[d]['h'] - nq_m[d]['l'] for d in nq_ds]
    for i in range(14, len(nq_ds)):
        atr[nq_ds[i]] = float(np.mean(ranges[i - 14:i]))  # ends day i-1 (causal)

    def cor_chg5(date, extra_lag=0):
        ds, m = D['cor1m']
        a = prior(ds, m, date, 1 + extra_lag)
        b = prior(ds, m, date, 6 + extra_lag)
        return a['c'] - b['c'] if a and b else None

    def stress_flags(date):
        f = {}
        v9, v, v3, vv = (prior(*D['vix9d'], date), prior(*D['vix'], date),
                         prior(*D['vix3m'], date), prior(*D['vvix'], date))
        c1 = prior(*D['cor1m'], date)
        f['ts9d_inv'] = None if not (v9 and v) else v9['c'] / v['c'] >= 1
        f['backwd'] = None if not (v and v3) else v['c'] / v3['c'] >= 1
        f['vvix_hi'] = None if not vv else vv['c'] > 106.45   # I2 T3 edge
        f['cor_hi'] = None if not c1 else c1['c'] > 15.70     # I2 T1 edge (NOT-low)
        cc = cor_chg5(date)
        f['cor_rising'] = None if cc is None else cc > 2.27   # I2 T3 edge
        return f

    print('=== I2b: PCC stress-regime structure checks ===\n')

    # ---- 1. scale confound: ATR-normalized terciles for E3 + VIX level
    print('-- 1. ATR-normalized re-test (pnl / prior-day ATR14, unit = $/pt-of-ATR) --')
    for label, featfn in [
        ('E3 COR1M 5d-change', lambda d: cor_chg5(d)),
        ('C1 VIX level', lambda d: (lambda r: r['c'] if r else None)(prior(*D['vix'], d))),
    ]:
        rows = []
        for t in trades:
            v = featfn(t['date'])
            a = atr.get(t['date'])
            if v is None or a is None or a <= 0:
                continue
            rows.append((v, t['pnl'], t['pnl'] / a))
        vals = np.array([r[0] for r in rows])
        q1, q2 = np.quantile(vals, [1 / 3, 2 / 3])
        print(f'  {label} (n={len(rows)}, edges {q1:.2f}/{q2:.2f})')
        for lab, lo, hi in [('T1', -np.inf, q1), ('T2', q1, q2), ('T3', q2, np.inf)]:
            sub = [(p, pn) for v, p, pn in rows if (v <= hi if lo == -np.inf else lo < v <= hi)]
            dol = [s[0] for s in sub]
            nrm = [s[1] for s in sub]
            wr = 100 * np.mean([1 if x > 0 else 0 for x in dol])
            print(f'    {lab}: $pf={pf(dol):.2f} avg$={np.mean(dol):>6.0f} | '
                  f'NORM pf={pf(nrm):.2f} avg={np.mean(nrm):>6.2f} | wr={wr:.1f}%')
        m3 = vals > q2
        nrm_all = np.array([r[2] for r in rows])
        print(f'    T3 perm-p on NORMALIZED units: {perm_p(m3, nrm_all):.3f}\n')

    # ---- 2. E3 cutoff sweep
    print('-- 2. E3 cutoff sweep: pass = COR1M 5d-change > X --')
    for x in [-2, -1, 0, 1, 2, 3]:
        ps, fl, mask, pnls = [], [], [], []
        for t in trades:
            v = cor_chg5(t['date'])
            if v is None:
                continue
            (ps if v > x else fl).append(t['pnl'])
            mask.append(v > x)
            pnls.append(t['pnl'])
        print(f'  x={x:>3}: pass pf={pf(ps):.2f} (n={len(ps)}) | '
              f'fail pf={pf(fl):.2f} (n={len(fl)}) | perm-p={perm_p(mask, pnls):.3f}')

    # ---- 3. lag placebo
    print('\n-- 3. lag placebo: COR1M 5d-change lagged 5 extra days, T3-style cut >2.27 --')
    for lag, lab in [(0, 'live'), (5, 'lag5'), (10, 'lag10')]:
        ps, fl, mask, pnls = [], [], [], []
        for t in trades:
            v = cor_chg5(t['date'], extra_lag=lag)
            if v is None:
                continue
            hit = v > 2.27
            (ps if hit else fl).append(t['pnl'])
            mask.append(hit)
            pnls.append(t['pnl'])
        print(f'  {lab:>5}: pass pf={pf(ps):.2f} (n={len(ps)}) | '
              f'fail pf={pf(fl):.2f} (n={len(fl)}) | perm-p={perm_p(mask, pnls):.3f}')

    # ---- 4. flag agreement matrix
    print('\n-- 4. stress-flag agreement (fraction of trade days where both true/false match) --')
    keys = ['ts9d_inv', 'backwd', 'vvix_hi', 'cor_hi', 'cor_rising']
    flags = {k: [] for k in keys}
    for t in trades:
        f = stress_flags(t['date'])
        for k in keys:
            flags[k].append(f[k])
    print('           ' + '  '.join(f'{k:>10}' for k in keys))
    for a in keys:
        row = []
        for b in keys:
            pair = [(x, y) for x, y in zip(flags[a], flags[b])
                    if x is not None and y is not None]
            agree = np.mean([x == y for x, y in pair]) if pair else float('nan')
            row.append(f'{agree:>10.2f}')
        print(f'  {a:>9} ' + '  '.join(row))

    # ---- 5. TRIN x stress 2x2 (diagnostic)
    print('\n-- 5. TRIN alignment (I1) x stress (E3-T3) 2x2 --')
    trin_by = defaultdict(list)
    with open(os.path.join(MACRO, 'trin_1h.csv')) as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split(',')
            if len(p) < 6:
                continue
            et = datetime.fromtimestamp(int(p[1]), tz=ET)
            trin_by[et.strftime('%Y-%m-%d')].append((et.hour * 60 + et.minute, float(p[5])))
    for d in trin_by:
        trin_by[d].sort()
    cells = defaultdict(list)
    for t in trades:
        c = None
        for lab, v in trin_by.get(t['date'], []):
            if lab <= 13 * 60 + 30:
                c = v
        v = cor_chg5(t['date'])
        if c is None or v is None:
            continue
        trin_al = (c < 1.0) == (t['side'] > 0)
        stress = v > 2.27
        cells[(trin_al, stress)].append(t['pnl'])
    for (ta, st), sub in sorted(cells.items(), reverse=True):
        print(f'  TRIN-{"aligned" if ta else "misalgn"} x '
              f'{"stress" if st else "calm  "}: n={len(sub):<4} '
              f'pf={pf(sub):.2f} avg=${np.mean(sub):>6,.0f} pnl=${sum(sub):>9,.0f}')

    # ---- 6. E3-T3 per-year
    print('\n-- 6. E3 top tercile (>2.27) per-year --')
    by = defaultdict(lambda: [[], []])
    for t in trades:
        v = cor_chg5(t['date'])
        if v is None:
            continue
        by[t['date'][:4]][0 if v > 2.27 else 1].append(t['pnl'])
    for y in sorted(by):
        g, b = by[y]
        print(f'  {y}: T3 ${sum(g):>8,.0f} ({len(g):>3})  rest ${sum(b):>8,.0f} ({len(b):>3})')


if __name__ == '__main__':
    main()
