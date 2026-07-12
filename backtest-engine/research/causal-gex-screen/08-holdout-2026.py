#!/usr/bin/env python3
"""ONE-SHOT 2026 holdout unseal (same-regime: intraday cbbo IV, as 2025).

Finalist configs were frozen (F1/F2/F3, 2025 thresholds) BEFORE any 2026 or
2023-24 data was examined. This runs them exactly once on 2026-01→06 plus the
unconditional-long control. 1m research sim; 1s confirmation follows if pass.
"""
import csv
import importlib.util
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('m5', HERE / '05-strategy-matrix.py')
m5 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m5)

FINALISTS = [
    {'name': 'F1-long-flip90-imb50-am', 'short': False, 'flip_q': 0.9,
     'imb_q': 0.5, 'res_q': None, 'session': 'rth_am', 'exit': '4h',
     'stop_pts': 100, 'tgt_pts': None},
    {'name': 'F2-short-flip20-imb80-day', 'short': True, 'flip_q': 0.2,
     'imb_q': 0.8, 'res_q': None, 'session': 'day', 'exit': 'eod',
     'stop_pts': 100, 'tgt_pts': None},
    {'name': 'F3-long-flip80-res50-day', 'short': False, 'flip_q': 0.8,
     'imb_q': None, 'res_q': 0.5, 'session': 'day', 'exit': '4h',
     'stop_pts': 100, 'tgt_pts': None},
    {'name': 'CONTROL-uncond-long-am', 'short': False, 'flip_q': None,
     'imb_q': None, 'res_q': None, 'session': 'rth_am', 'exit': '4h',
     'stop_pts': None, 'tgt_pts': None},
]


def main():
    prices_ts, prices_px, feats_2025 = m5.load()
    all_rows = list(csv.DictReader(open(HERE / 'features.csv')))
    feats_hold = sorted((r for r in all_rows
                         if r['date'].startswith('2026') and r['segment'] == 'cbbo'),
                        key=lambda r: r['ts'])
    print(f'2026 holdout snapshots (cbbo segment): {len(feats_hold)} '
          f'({feats_hold[0]["date"]} → {feats_hold[-1]["date"]})')

    # thresholds = 2025 discovery values (frozen convention)
    fd = [v for v in (m5.fnum(r['abs_flip_dist_pct']) for r in feats_2025) if v is not None]
    imb = [v for v in (m5.fnum(r['gamma_imbalance']) for r in feats_2025) if v is not None]
    res = [v for v in (m5.fnum(r['near_res_dist_pct']) for r in feats_2025) if v is not None]
    th = {}
    for q in (0.5, 0.7, 0.8, 0.9):
        th[('flip', q)] = float(np.quantile(fd, q))
        th[('res', q)] = float(np.quantile(res, q))
    for q in (0.3, 0.5):
        th[('imb', q)] = float(np.quantile(imb, q))
    for q in (0.2, 0.3):
        th[('flip_lo', q)] = float(np.quantile(fd, q))
    for q in (0.7, 0.8):
        th[('imb_hi', q)] = float(np.quantile(imb, q))

    for cfg in FINALISTS:
        m = m5.run_config(prices_ts, prices_px, feats_hold, cfg, th)
        if not m:
            # relax the n>=15 floor for a 5.5-month window: report raw
            print(f"{cfg['name']:28s} <15 trades (holdout window)")
            continue
        print(f"{cfg['name']:28s} n={m['n']:4d} WR={m['wr']:5.1f} "
              f"PnL=${m['pnl']:,} PF={m['pf']:.2f} DD=${m['maxdd']:,} "
              f"Shp={m['sharpe']:.2f} avg=${m['avg_usd']}")


if __name__ == '__main__':
    main()
