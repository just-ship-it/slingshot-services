#!/usr/bin/env python3
"""Analyze ES dealer-reaction events: GEX vs LT vs priorday vs placebos.
Mirrors NQ 02-analyze + 03-feature-analysis. ES scale = 0.208x NQ:
pen buckets NQ [0,10,20,30] -> ES [0, 2, 4.25, 6.25]; target 4.25 (NQ 20).
Key questions:
  1. Does ANY family beat the placebos on P(target before stop) / realized PF? (NQ: no, 7x)
  2. Does the NQ pen-4.25-6.25 fade cell (NQ 20-30) replicate/strengthen on ES?
  3. Is wick_beyond still the one real GEX-specific tell (+7.6pp on NQ)?
Report pooled, per-quarter, per-year. Run after the harness finishes all families."""
import os
import numpy as np
import pandas as pd

BASE = os.path.dirname(os.path.abspath(__file__))
FAMS = ['gex', 'lt', 'priorday', 'placebo_round', 'placebo_rand']
PENB = [(-99, 0, '<0'), (0, 2, '0-2'), (2, 4.25, '2-4.25'), (4.25, 6.25, '4.25-6.25'), (6.25, 999, '>6.25')]
HIT = 'hitT_s2p0'   # target-before-2.0-stop (NQ analog: 20pt target / 10pt stop)


def pf(x):
    x = x[np.isfinite(x)]
    w, l = x[x > 0].sum(), -x[x < 0].sum()
    return w / l if l > 0 else np.inf


def stats(d):
    if len(d) == 0:
        return "n=0"
    return (f"n={len(d):5d} P(tgt)={100*d[HIT].mean():4.1f}% realPF={pf(d.realized.values):.2f} "
            f"avgReal={d.realized.mean():+.2f} medMFE={d.mfe.median():.1f} medMAE={d.mae.median():.1f}")


def main():
    D = {}
    for f in FAMS:
        fp = os.path.join(BASE, f'events_{f}.csv')
        if os.path.exists(fp):
            D[f] = pd.read_csv(fp)
    print("=== 1. POOLED by family x arm (5m confirm) ===")
    for f, d in D.items():
        for arm in ('fade', 'breakout'):
            print(f"  {f:14s} {arm:8s} {stats(d[(d.arm==arm)&(d.tf=='5m')])}")

    print("\n=== 2. FADE by penetration bucket (5m) — the NQ 20-30 cell = ES 4.25-6.25 ===")
    for lo, hi, lbl in PENB:
        print(f"  pen {lbl}:")
        for f, d in D.items():
            s = d[(d.arm == 'fade') & (d.tf == '5m') & (d.pen >= lo) & (d.pen < hi)]
            print(f"    {f:14s} {stats(s)}")

    print("\n=== 3. WICK read: fade success by wick_beyond tercile at pen>=2 (5m) ===")
    for f, d in D.items():
        s = d[(d.arm == 'fade') & (d.tf == '5m') & (d.pen >= 2)].copy()
        if len(s) < 30:
            print(f"  {f:14s} n={len(s)} too small")
            continue
        try:
            s['wt'] = pd.qcut(s.wick_beyond.rank(method='first'), 3, labels=['w-lo', 'w-mid', 'w-hi'])
        except ValueError:
            continue
        row = ' '.join(f"{lbl}:{100*s[s.wt==lbl][HIT].mean():.1f}%(n={len(s[s.wt==lbl])})" for lbl in ['w-lo', 'w-mid', 'w-hi'])
        print(f"  {f:14s} {row}  spread={100*(s[s.wt=='w-hi'][HIT].mean()-s[s.wt=='w-lo'][HIT].mean()):+.1f}pp")

    print("\n=== 4. GEX fade pen>=4.25 per-year (stability) ===")
    if 'gex' in D:
        g = D['gex']
        s = g[(g.arm == 'fade') & (g.tf == '5m') & (g.pen >= 4.25)]
        for y in sorted(s.date.str[:4].unique()):
            print(f"  {y}: {stats(s[s.date.str[:4]==y])}")
        print("\n=== 5. GEX by kind, fade pen>=2 (5m) ===")
        s = g[(g.arm == 'fade') & (g.tf == '5m') & (g.pen >= 2)]
        for k in sorted(s.kind.unique()):
            print(f"  {k:12s} {stats(s[s.kind==k])}")


if __name__ == '__main__':
    main()
