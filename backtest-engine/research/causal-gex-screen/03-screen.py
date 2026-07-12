#!/usr/bin/env python3
"""R1 predictive screen: Spearman IC + decile spreads of causal GEX/IV
features vs forward NQ returns.

Discipline: run with --split discovery (2025) for exploration. The 2026
holdout is NOT to be touched until a final shortlist exists.

Usage: python3 03-screen.py [--split discovery|holdout] [--min-n 500]
"""
import argparse
import csv
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.stats import spearmanr

HERE = Path(__file__).parent

FEATURES = [
    'flip_present', 'flip_dist_pct', 'abs_flip_dist_pct',
    'call_wall_dist_pct', 'put_wall_dist_pct',
    'near_res_dist_pct', 'near_sup_dist_pct',
    'gamma_imbalance', 'total_gex_sign', 'log_total_gex_abs',
    'wall_gex_ratio', 'top_sup_share', 'top_res_share',
    'iv', 'iv_skew', 'iv_chg_15m', 'iv_chg_1h',
]
TARGETS = ['r15m', 'r1h', 'r4h']
SESSIONS = {'overnight': range(0, 9), 'rth_am': range(9, 12), 'rth_pm': range(12, 17)}


def fnum(v):
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def ic(pairs):
    if len(pairs) < 30:
        return None, len(pairs)
    x, y = zip(*pairs)
    r, p = spearmanr(x, y)
    return (r, p, len(pairs))


def decile_spread(pairs):
    if len(pairs) < 100:
        return None
    pairs = sorted(pairs)
    n = len(pairs)
    lo = [y for _, y in pairs[: n // 10]]
    hi = [y for _, y in pairs[-(n // 10):]]
    return (float(np.mean(hi)), float(np.mean(lo)),
            float(np.mean(hi)) - float(np.mean(lo)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--split', choices=['discovery', 'holdout'], default='discovery')
    ap.add_argument('--features-csv', default=str(HERE / 'features.csv'))
    args = ap.parse_args()

    year = '2025' if args.split == 'discovery' else '2026'
    rows = [r for r in csv.DictReader(open(args.features_csv))
            if r['date'].startswith(year)]
    print(f'{args.split}: {len(rows)} snapshot rows ({year})')

    results = []
    for feat in FEATURES:
        for tgt in TARGETS:
            pairs = [(fnum(r[feat]), fnum(r[tgt])) for r in rows]
            pairs = [(x, y) for x, y in pairs if x is not None and y is not None]
            out = ic(pairs)
            if out is None or out[0] is None:
                continue
            r_all, p_all, n_all = out
            # quarterly stability
            q_ics = []
            for q in range(1, 5):
                months = {f'{year}-{m:02d}' for m in range(3 * q - 2, 3 * q + 1)}
                qp = [(fnum(r[feat]), fnum(r[tgt])) for r in rows
                      if r['date'][:7] in months]
                qp = [(x, y) for x, y in qp if x is not None and y is not None]
                if len(qp) >= 100:
                    q_ics.append(round(spearmanr(*zip(*qp))[0], 4))
            dec = decile_spread(pairs)
            # session-conditioned IC
            sess_ics = {}
            for sname, hours in SESSIONS.items():
                sp = [(fnum(r[feat]), fnum(r[tgt])) for r in rows
                      if int(r['et_hour']) in hours]
                sp = [(x, y) for x, y in sp if x is not None and y is not None]
                if len(sp) >= 200:
                    sess_ics[sname] = round(spearmanr(*zip(*sp))[0], 4)
            results.append({
                'feature': feat, 'target': tgt, 'n': n_all,
                'ic': round(r_all, 4), 'p': float(f'{p_all:.2e}'),
                'q_ics': q_ics,
                'stable_sign': (len(q_ics) >= 3 and
                                all(math.copysign(1, q) == math.copysign(1, q_ics[0])
                                    for q in q_ics)),
                'decile_hi': round(dec[0], 4) if dec else None,
                'decile_lo': round(dec[1], 4) if dec else None,
                'decile_spread': round(dec[2], 4) if dec else None,
                'session_ics': sess_ics,
            })

    # regime (categorical): mean forward return per class
    regime_stats = defaultdict(lambda: defaultdict(list))
    for r in rows:
        for tgt in TARGETS:
            v = fnum(r[tgt])
            if v is not None and r['regime']:
                regime_stats[r['regime']][tgt].append(v)
    regime_out = {
        reg: {tgt: {'n': len(v), 'mean': round(float(np.mean(v)), 4)}
              for tgt, v in tgts.items()}
        for reg, tgts in regime_stats.items()
    }

    results.sort(key=lambda x: -abs(x['ic']))
    print(f"\n{'feature':22s} {'tgt':5s} {'n':>6s} {'IC':>8s} {'p':>9s} "
          f"{'stable':>6s} {'dec_spread':>10s}  q_ICs / sessions")
    for x in results:
        print(f"{x['feature']:22s} {x['target']:5s} {x['n']:6d} {x['ic']:8.4f} "
              f"{x['p']:9.1e} {str(x['stable_sign']):>6s} "
              f"{str(x['decile_spread']):>10s}  {x['q_ics']} {x['session_ics']}")
    print('\nRegime class means (fwd log-return %):')
    print(json.dumps(regime_out, indent=1))
    print(f'\nTests run: {len(results)} feature-target pairs '
          f'(Bonferroni p* ~ {0.05 / max(1, len(results)):.1e})')

    out = HERE / f'screen-{args.split}.json'
    out.write_text(json.dumps({'results': results, 'regime': regime_out}, indent=1))
    print(f'wrote {out}')


if __name__ == '__main__':
    main()
