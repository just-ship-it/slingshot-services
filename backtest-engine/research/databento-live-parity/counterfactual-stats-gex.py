#!/usr/bin/env python3
"""Quantify the stats-GEX close-price lookahead (self-contained A/B).

CONTROL: generate_day with day-D statistics closes (what shipped data/gex/nq
uses — stat_type 11 published 16:00+ ET of day D = lookahead intraday).
CAUSAL:  same code, same spot inputs, but close prices from the PRIOR trading
day's statistics file (knowable premarket along with day-D OI).

Both arms run NOW with identical spot dicts, so every diff is attributable
purely to the close-price swap. (Comparing against the shipped JSONs instead
would conflate a separate issue: the generator's last-row-per-bucket spot
selection is sensitive to raw-CSV row order, which changed when the OHLCV
file was extended/repaired — measured separately.)

Usage: python3 counterfactual-stats-gex.py [--product nq] [--dates d1,d2,...]
"""
import argparse
import importlib.util
import json
from pathlib import Path

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
spec = importlib.util.spec_from_file_location(
    'gengex', BASE / 'scripts' / 'generate-intraday-gex.py')
gengex = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gengex)

DEFAULT_DATES = [
    '2023-06-15', '2023-11-15', '2024-03-14', '2024-08-15',
    '2025-02-13', '2025-04-04', '2025-08-14', '2025-12-11',
    '2026-03-12', '2026-05-14',
]


def prior_stats_date(stats_dir, date_str):
    files = sorted(p.name for p in stats_dir.glob('opra-pillar-*.statistics.csv'))
    key = f'opra-pillar-{date_str.replace("-", "")}.statistics.csv'
    if key not in files:
        return None
    i = files.index(key)
    return None if i == 0 else (lambda d: f'{d[:4]}-{d[4:6]}-{d[6:8]}')(
        files[i - 1].split('-')[2].split('.')[0])


def causal_stats(config, date_str):
    """Day-D OI merged with day-(D-1) close prices."""
    prev = prior_stats_date(config['stats_dir'], date_str)
    if prev is None:
        return None, None
    cur = gengex.load_statistics(config['stats_dir'], date_str)
    prv = gengex.load_statistics(config['stats_dir'], prev)
    if cur is None or prv is None:
        return None, prev
    merged = cur.drop(columns=['close_price']).merge(
        prv[['symbol', 'close_price']], on='symbol', how='inner')
    return merged[merged['close_price'] > 0], prev


def snap_diff(a, b):
    """a = control (lookahead), b = causal."""
    fa, fb = a.get('gamma_flip'), b.get('gamma_flip')
    if fa is None and fb is None:
        fd, fp = 0.0, False
    elif (fa is None) != (fb is None):
        fd, fp = None, True
    else:
        fd, fp = abs(fa - fb), False
    sup_a, sup_b = set(a['support']), set(b['support'])
    res_a, res_b = set(a['resistance']), set(b['resistance'])
    return {
        'regime_changed': a['regime'] != b['regime'],
        'flip_delta': fd,
        'flip_presence_changed': fp,
        'call_wall_moved': a['call_wall'] != b['call_wall'],
        'put_wall_moved': a['put_wall'] != b['put_wall'],
        'support_set_jaccard': len(sup_a & sup_b) / max(1, len(sup_a | sup_b)),
        'resistance_set_jaccard': len(res_a & res_b) / max(1, len(res_a | res_b)),
        'support_order_changed': a['support'] != b['support'],
        'imbalance_delta': abs(a['gamma_imbalance'] - b['gamma_imbalance']),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--product', default='nq')
    ap.add_argument('--dates', default=','.join(DEFAULT_DATES))
    args = ap.parse_args()

    config = gengex.PRODUCTS[args.product]
    out_rows = []
    for date_str in args.dates.split(','):
        stats_control = gengex.load_statistics(config['stats_dir'], date_str)
        stats_causal, prev = causal_stats(config, date_str)
        if stats_control is None or stats_causal is None:
            print(f'{date_str}: missing stats (prev={prev}), skip')
            continue
        etf = gengex.load_ohlcv_for_date(config['etf_ohlcv'], date_str)
        fut = gengex.load_ohlcv_for_date(config['futures_ohlcv'], date_str)
        if not etf or not fut:
            print(f'{date_str}: missing OHLCV, skip')
            continue
        control = gengex.generate_day(date_str, stats_control, etf, fut, config,
                                      iv_source='stats')
        causal = gengex.generate_day(date_str, stats_causal, etf, fut, config,
                                     iv_source='stats')
        if control is None or causal is None:
            print(f'{date_str}: generate_day None, skip')
            continue
        cs = {s['timestamp']: s for s in control['data']}
        ks = {s['timestamp']: s for s in causal['data']}
        shared = sorted(set(cs) & set(ks))
        # Only pre-close snapshots matter (after 20:00 UTC the "lookahead"
        # close is roughly known anyway); keep all, but report RTH-morning too.
        diffs = [snap_diff(cs[t], ks[t]) for t in shared]
        n = len(diffs)
        if n == 0:
            print(f'{date_str}: no shared snapshots, skip')
            continue
        flips = [d['flip_delta'] for d in diffs if d['flip_delta'] is not None]
        row = {
            'date': date_str, 'prev_close_date': prev, 'snapshots': n,
            'contracts_control': len(stats_control), 'contracts_causal': len(stats_causal),
            'pct_regime_changed': 100 * sum(d['regime_changed'] for d in diffs) / n,
            'pct_flip_presence_changed': 100 * sum(d['flip_presence_changed'] for d in diffs) / n,
            'median_flip_delta_pts': sorted(flips)[len(flips) // 2] if flips else None,
            'max_flip_delta_pts': max(flips) if flips else None,
            'pct_call_wall_moved': 100 * sum(d['call_wall_moved'] for d in diffs) / n,
            'pct_put_wall_moved': 100 * sum(d['put_wall_moved'] for d in diffs) / n,
            'mean_support_jaccard': sum(d['support_set_jaccard'] for d in diffs) / n,
            'mean_resistance_jaccard': sum(d['resistance_set_jaccard'] for d in diffs) / n,
            'pct_support_order_changed': 100 * sum(d['support_order_changed'] for d in diffs) / n,
            'median_imbalance_delta': sorted(d['imbalance_delta'] for d in diffs)[n // 2],
        }
        out_rows.append(row)
        print(json.dumps(row))

    if out_rows:
        m = len(out_rows)
        agg = {
            'days': m,
            'total_snapshots': sum(r['snapshots'] for r in out_rows),
            'mean_pct_regime_changed': sum(r['pct_regime_changed'] for r in out_rows) / m,
            'mean_pct_put_wall_moved': sum(r['pct_put_wall_moved'] for r in out_rows) / m,
            'mean_pct_call_wall_moved': sum(r['pct_call_wall_moved'] for r in out_rows) / m,
            'mean_support_jaccard': sum(r['mean_support_jaccard'] for r in out_rows) / m,
            'mean_resistance_jaccard': sum(r['mean_resistance_jaccard'] for r in out_rows) / m,
            'mean_pct_support_order_changed': sum(r['pct_support_order_changed'] for r in out_rows) / m,
            'median_flip_delta_pts_by_day': [r['median_flip_delta_pts'] for r in out_rows],
        }
        print('AGGREGATE', json.dumps(agg, indent=1))
        out = Path(__file__).parent / f'counterfactual-{args.product}-results.json'
        out.write_text(json.dumps({'rows': out_rows, 'aggregate': agg}, indent=1))
        print(f'wrote {out}')


if __name__ == '__main__':
    main()
