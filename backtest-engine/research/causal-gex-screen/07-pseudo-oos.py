#!/usr/bin/env python3
"""Pseudo-OOS: run the three matrix finalists on 2023-2024 (prevday-IV
segment — data never touched during shaping). Two threshold conventions:

  fixed2025 — the exact 2025-discovery quantile values (regime-mismatch risk)
  local     — quantiles recomputed on the 2023-24 segment itself (mirrors a
              live implementation using a rolling calibration window)

1m research sim (same engine as the matrix); finalists that pass go to a 1s
confirmation pass. Per-year breakdown printed.
"""
import csv
import importlib.util
import json
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
]


def thresholds_for(feats):
    fd = [v for v in (m5.fnum(r['abs_flip_dist_pct']) for r in feats) if v is not None]
    imb = [v for v in (m5.fnum(r['gamma_imbalance']) for r in feats) if v is not None]
    res = [v for v in (m5.fnum(r['near_res_dist_pct']) for r in feats) if v is not None]
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
    return th


def main():
    prices_ts, prices_px, _ = m5.load()   # loads 2025 feats; we refilter below
    all_rows = list(csv.DictReader(open(HERE / 'features.csv')))
    feats_oos = sorted((r for r in all_rows if r['date'][:4] in ('2023', '2024')),
                       key=lambda r: r['ts'])
    feats_2025 = sorted((r for r in all_rows if r['date'].startswith('2025')),
                        key=lambda r: r['ts'])
    print(f'{len(feats_oos)} OOS snapshots (2023-24), {len(feats_2025)} discovery')

    th_2025 = thresholds_for(feats_2025)
    th_local = thresholds_for(feats_oos)
    print('flip@0.9  2025:', round(th_2025[('flip', 0.9)], 3),
          ' local23-24:', round(th_local[('flip', 0.9)], 3))

    for mode, th in (('fixed2025', th_2025), ('local', th_local)):
        print(f'\n=== thresholds: {mode} ===')
        for cfg in FINALISTS:
            m = m5.run_config(prices_ts, prices_px, feats_oos, cfg, th)
            if not m:
                print(f"{cfg['name']:28s} <15 trades")
                continue
            print(f"{cfg['name']:28s} n={m['n']:4d} WR={m['wr']:5.1f} "
                  f"PnL=${m['pnl']:,} PF={m['pf']:.2f} DD=${m['maxdd']:,} "
                  f"Shp={m['sharpe']:.2f}")
            # per-year
            for yr in ('2023', '2024'):
                fy = [r for r in feats_oos if r['date'].startswith(yr)]
                my = m5.run_config(prices_ts, prices_px, fy, cfg, th)
                if my:
                    print(f"    {yr}: n={my['n']:4d} WR={my['wr']:5.1f} "
                          f"PnL=${my['pnl']:,} PF={my['pf']:.2f} Shp={my['sharpe']:.2f}")


if __name__ == '__main__':
    main()
