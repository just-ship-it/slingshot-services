#!/usr/bin/env python3
"""
I4 — TRIN/COR conditioner study on the PARKED Zarattini ES breakout
(research/intraday-momentum, recommended config, re-derived 2026-08-09:
135 trades / $50,538 / PF 1.94 / Sharpe 2.67, 2021-02 -> 2026-01, 1s-honest).

Question: do the I1/I2 conditioners (breadth alignment, rising-correlation
stress) sharpen a REAL parked edge — the PCC playbook, second application?
Under the capacity-constrained target, the base edge alone may now be a
keeper; conditioners decide sizing/quality tiers.

Features (long-only edge -> alignment = bullish):
  A. COR1M Δ5d prior-day (all 135 trades, full history)
  B. First-hour TRIN < 1 (1h bar labeled 09:30, closes 10:30) — entries >=10:30
     only (n~62; 10:00 entries have NO closed same-day TRIN bar at 1h res)
  C. Prior-day TRIN close < 1 (all trades, weak/stale prior)
  D. 15m TRIN last close <= entry time (2025+ subset only — small n, flagged)

House rules: one feature at a time, permutation placebo (2000x), per-year
splits. SMALL SAMPLES throughout (n=135 total) — this is a screen, not a
verdict; anything interesting needs the same structure checks as I1b/I2b.
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
TRADES = os.path.join(HERE, '..', '..', 'research', 'intraday-momentum',
                      'output', 'trades-recommended.ES.csv')
ET = ZoneInfo('America/New_York')
RNG = np.random.default_rng(20260809)
N_PERM = 2000


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


def load_1h(name):
    by = defaultdict(list)
    with open(os.path.join(MACRO, f'{name}_1h.csv')) as f:
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


def load_15m(name):
    return load_1h(name.replace('_1h', '')) if False else _load_res(name, '15m')


def _load_res(name, res):
    by = defaultdict(list)
    path = os.path.join(MACRO, f'{name}_{res}.csv')
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


def pf(x):
    w = sum(v for v in x if v > 0)
    l = -sum(v for v in x if v < 0)
    return w / l if l > 0 else float('inf')


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


def report(name, rows, note=''):
    """rows: list of (pnl, flag_bool_or_None, year)"""
    keep = [(p, f, y) for p, f, y in rows if f is not None]
    if len(keep) < 15:
        print(f'  {name}: insufficient n={len(keep)} — skipped\n')
        return
    pnls = [p for p, _, _ in keep]
    mask = [f for _, f, _ in keep]
    p = perm_p(mask, pnls)
    a = np.array(pnls)
    pas = [x for x, m in zip(pnls, mask) if m]
    fal = [x for x, m in zip(pnls, mask) if not m]
    flag = ' ***' if p < 0.05 else ''
    print(f'  {name}  (n={len(keep)}, perm-p={p:.3f}){flag}{" " + note if note else ""}')
    print(f'    ALL : n={len(a):<4} pnl=${a.sum():>8,.0f} avg=${a.mean():>6,.0f} pf={pf(pnls):.2f} wr={100*(a>0).mean():.0f}%')
    for lab, sub in [('pass', pas), ('fail', fal)]:
        if sub:
            s = np.array(sub)
            print(f'    {lab:4}: n={len(s):<4} pnl=${s.sum():>8,.0f} avg=${s.mean():>6,.0f} pf={pf(sub):.2f} wr={100*(s>0).mean():.0f}%')
        else:
            print(f'    {lab:4}: n=0')
    by = defaultdict(lambda: [0.0, 0, 0.0, 0])
    for pnl_, f, y in keep:
        b = by[y]
        if f:
            b[0] += pnl_; b[1] += 1
        else:
            b[2] += pnl_; b[3] += 1
    print('    ' + ' | '.join(f'{y}: P${v[0]:,.0f}({v[1]})/F${v[2]:,.0f}({v[3]})' for y, v in sorted(by.items())))
    print()


def main():
    trades = []
    with open(TRADES) as f:
        for row in csv.DictReader(f):
            trades.append({'date': row['date'], 'entry_min': int(row['entry_min']),
                           'pnl': float(row['pnl']), 'year': row['date'][:4]})
    print(f'=== I4: TRIN/COR conditioners on Zarattini ES breakout (n={len(trades)}) ===\n')

    cds, cor = load_daily('cor1m')
    tds, trind = load_daily('trin')
    trin1h = load_1h('trin')
    trin15 = _load_res('trin', '15m')

    def cor_chg5(date):
        i = bisect.bisect_left(cds, date)
        return cor[cds[i - 1]] - cor[cds[i - 6]] if i >= 6 else None

    def prior_trin(date):
        i = bisect.bisect_left(tds, date)
        return trind[tds[i - 1]] if i > 0 else None

    def firsthour_trin(date):
        for lab, c in trin1h.get(date, []):
            if lab == 9 * 60 + 30:
                return c
        return None

    def trin15_at(date, entry_min_from_open):
        cutoff = 9 * 60 + 30 + entry_min_from_open
        best = None
        for lab, c in trin15.get(date, []):
            if lab + 15 <= cutoff:
                best = c
        return best

    # A. COR Δ5d — terciles + I2 cutoff
    vals = [(t, cor_chg5(t['date'])) for t in trades]
    have = [v for _, v in vals if v is not None]
    q1, q2 = np.quantile(have, [1 / 3, 2 / 3])
    print(f'A. COR1M Δ5d prior-day (tercile edges {q1:.2f}/{q2:.2f}; I2 cutoff 2.27)\n')
    report('A1 corΔ5d > 2.27 (I2 stress cutoff)',
           [(t['pnl'], None if v is None else v > 2.27, t['year']) for t, v in vals])
    report('A2 corΔ5d top tercile (own edges)',
           [(t['pnl'], None if v is None else v > q2, t['year']) for t, v in vals])
    report('A3 corΔ5d bottom tercile (falling = calm)',
           [(t['pnl'], None if v is None else v <= q1, t['year']) for t, v in vals])

    # B. first-hour TRIN, entries >= 10:30 only
    print('B. same-day first-hour TRIN (entries >=10:30 only)\n')
    report('B1 first-hour TRIN < 1 (bullish breadth)',
           [(t['pnl'], (None if (v := firsthour_trin(t['date'])) is None else v < 1.0)
             if t['entry_min'] >= 60 else None, t['year']) for t in trades],
           note='[10:00 entries excluded — no closed 1h bar]')

    # C. prior-day TRIN (all trades, stale prior)
    print('C. prior-day TRIN close (stale, all trades)\n')
    report('C1 prior-day TRIN < 1',
           [(t['pnl'], None if (v := prior_trin(t['date'])) is None else v < 1.0, t['year'])
            for t in trades])

    # D. 15m TRIN at entry (2025+ only)
    print('D. 15m TRIN last close <= entry (2025+ subset — POWER-LIMITED)\n')
    report('D1 TRIN@entry < 1 [15m, 2025+]',
           [(t['pnl'], (None if (v := trin15_at(t['date'], t['entry_min'])) is None else v < 1.0)
             if t['date'] >= '2025-01-02' else None, t['year']) for t in trades])

    print('NOTE: n=135 total; every split is small. Screen-grade only — survivors')
    print('need I1b/I2b-style structure checks before any usage decision.')


if __name__ == '__main__':
    main()
