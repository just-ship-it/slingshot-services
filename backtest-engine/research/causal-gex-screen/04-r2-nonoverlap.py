#!/usr/bin/env python3
"""R2: non-overlapping event-based re-test of the R1 survivors.

Three fixed sample times per day (ET): 03:00 (overnight), 09:30 (RTH open),
14:00 (afternoon). Each r4h window is disjoint from the others, killing the
overlapping-sample inflation in R1. One observation = first snapshot at or
after the sample time (within 30 min). Discovery split (2025) only.
"""
import csv
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
from scipy.stats import spearmanr

HERE = Path(__file__).parent
ET = ZoneInfo('America/New_York')
SURVIVORS = ['abs_flip_dist_pct', 'iv', 'call_wall_dist_pct',
             'wall_gex_ratio', 'gamma_imbalance',
             'near_res_dist_pct', 'log_total_gex_abs']  # last two: unstable-in-R1 controls
SAMPLE_TIMES = ['03:00', '09:30', '14:00']


def fnum(v):
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def main():
    rows = [r for r in csv.DictReader(open(HERE / 'features.csv'))
            if r['date'].startswith('2025')]
    # index snapshots by date, in ET-time order
    by_date = defaultdict(list)
    for r in rows:
        t = datetime.fromisoformat(r['ts'] + ':00+00:00').astimezone(ET)
        by_date[r['date']].append((t.strftime('%H:%M'), r))
    for d in by_date:
        by_date[d].sort()

    samples = defaultdict(list)   # sample_time -> [row]
    for d, lst in by_date.items():
        for st in SAMPLE_TIMES:
            pick = next(((hm, r) for hm, r in lst if st <= hm <= f'{st[:2]}:59'
                         and hm <= f'{int(st[:2]):02d}:{int(st[3:]) + 30:02d}'), None)
            if pick:
                samples[st].append(pick[1])

    print(f"{'feature':22s} {'sample':6s} {'n':>5s} {'IC_r4h':>8s} {'p':>9s} "
          f"{'IC_r1h':>8s}")
    agg = []
    for feat in SURVIVORS:
        pooled = []
        for st in SAMPLE_TIMES:
            obs = samples[st]
            pairs4 = [(fnum(r[feat]), fnum(r['r4h'])) for r in obs]
            pairs4 = [(x, y) for x, y in pairs4 if x is not None and y is not None]
            pairs1 = [(fnum(r[feat]), fnum(r['r1h'])) for r in obs]
            pairs1 = [(x, y) for x, y in pairs1 if x is not None and y is not None]
            if len(pairs4) < 50:
                continue
            ic4, p4 = spearmanr(*zip(*pairs4))
            ic1 = spearmanr(*zip(*pairs1))[0] if len(pairs1) >= 50 else float('nan')
            print(f'{feat:22s} {st:6s} {len(pairs4):5d} {ic4:8.4f} {p4:9.1e} {ic1:8.4f}')
            pooled += pairs4
        if len(pooled) >= 100:
            ic, p = spearmanr(*zip(*pooled))
            print(f'{feat:22s} POOLED {len(pooled):5d} {ic:8.4f} {p:9.1e}')
            agg.append((feat, ic, p, len(pooled)))
        print()

    print('Summary (pooled non-overlapping):')
    for feat, ic, p, n in sorted(agg, key=lambda x: -abs(x[1])):
        print(f'  {feat:22s} IC {ic:+.4f}  p {p:.1e}  n {n}')


if __name__ == '__main__':
    main()
