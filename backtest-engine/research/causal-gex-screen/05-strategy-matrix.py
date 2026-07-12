#!/usr/bin/env python3
"""Strategy matrix on the causal GEX factors — single 1-NQ slot, research sim.

Simulation: signals at snapshot rows (features.csv, time-ordered); entry at the
first cache minute AFTER the snapshot minute; one position at a time; exits by
time (4h / EOD 15:45 ET), optional stop/target on 1m closes. Costs: $4 RT
commission + 0.5 pt slippage per side. $20/pt. Research-grade (1m) — finalists
must go through 1s-honest validation before any number is trusted.

Split: 2025 discovery ONLY (holdout 2026 sealed).
"""
import bisect
import csv
import itertools
import json
import math
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

HERE = Path(__file__).parent
ET = ZoneInfo('America/New_York')
PT = 20.0
COMM = 4.0
SLIP_PTS = 0.5          # per side
EOD_ET = '15:45'


def fnum(v):
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def load():
    prices_ts, prices_px = [], []
    with open(HERE / 'nq_1m_primary_2023plus.csv') as f:
        next(f)
        for line in f:
            ts, close, sym = line.rstrip('\n').split(',')
            prices_ts.append(ts)
            prices_px.append((float(close), sym))
    feats = [r for r in csv.DictReader(open(HERE / 'features.csv'))
             if r['date'].startswith('2025')]
    feats.sort(key=lambda r: r['ts'])
    return prices_ts, prices_px, feats


def et_fields(ts_utc_min):
    t = datetime.fromisoformat(ts_utc_min + ':00+00:00').astimezone(ET)
    return t, t.strftime('%H:%M')


def quantile(vals, q):
    return float(np.quantile(vals, q))


def run_config(prices_ts, prices_px, feats, cfg, thresholds):
    """cfg keys: side, flip_q, imb_q, res_q, session, exit, stop_pts, tgt_pts"""
    trades = []
    busy_until = ''
    for r in feats:
        ts = r['ts']
        if ts < busy_until:
            continue
        t_et, hm = et_fields(ts)
        if cfg['session'] == 'rth_am' and not ('09:30' <= hm <= '11:59'):
            continue
        if cfg['session'] == 'day' and not ('04:00' <= hm <= '14:30'):
            continue

        fd = fnum(r['abs_flip_dist_pct'])
        imb = fnum(r['gamma_imbalance'])
        nres = fnum(r['near_res_dist_pct'])
        cond = True
        if cfg.get('short'):  # mirrored adverse conditions
            if cfg['flip_q'] is not None:
                cond &= fd is not None and fd <= thresholds[('flip_lo', cfg['flip_q'])]
            if cfg['imb_q'] is not None:
                cond &= imb is not None and imb >= thresholds[('imb_hi', cfg['imb_q'])]
        else:
            if cfg['flip_q'] is not None:
                cond &= fd is not None and fd >= thresholds[('flip', cfg['flip_q'])]
            if cfg['imb_q'] is not None:
                cond &= imb is not None and imb <= thresholds[('imb', cfg['imb_q'])]
            if cfg['res_q'] is not None:
                cond &= nres is not None and nres >= thresholds[('res', cfg['res_q'])]
        if not cond:
            continue

        i0 = bisect.bisect_right(prices_ts, ts)
        if i0 >= len(prices_ts) or prices_ts[i0][:10] != ts[:10]:
            continue
        e_px, e_sym = prices_px[i0]
        side = -1 if cfg.get('short') else 1
        entry = e_px + side * SLIP_PTS

        # exit boundary
        t_entry = datetime.fromisoformat(prices_ts[i0] + ':00+00:00')
        if cfg['exit'] == '4h':
            t_stop_at = t_entry + timedelta(hours=4)
        else:  # eod
            eod_et = t_entry.astimezone(ET).replace(
                hour=15, minute=45, second=0, microsecond=0)
            t_stop_at = eod_et.astimezone(t_entry.tzinfo)
            if t_stop_at <= t_entry:
                continue
        exit_key = t_stop_at.strftime('%Y-%m-%dT%H:%M')

        pnl_pts, exit_ts = None, None
        j = i0 + 1
        while j < len(prices_ts):
            if prices_px[j][1] != e_sym:
                pnl_pts = side * (prices_px[j - 1][0] - entry)
                exit_ts = prices_ts[j - 1]
                break
            px = prices_px[j][0]
            move = side * (px - entry)
            if cfg['stop_pts'] and move <= -cfg['stop_pts']:
                pnl_pts = -cfg['stop_pts'] - SLIP_PTS
                exit_ts = prices_ts[j]
                break
            if cfg['tgt_pts'] and move >= cfg['tgt_pts']:
                pnl_pts = cfg['tgt_pts'] - SLIP_PTS
                exit_ts = prices_ts[j]
                break
            if prices_ts[j] >= exit_key:
                pnl_pts = move - SLIP_PTS
                exit_ts = prices_ts[j]
                break
            j += 1
        if pnl_pts is None:
            continue
        trades.append({'ts': ts, 'exit_ts': exit_ts, 'pts': pnl_pts,
                       'usd': pnl_pts * PT - COMM, 'date': ts[:10]})
        busy_until = exit_ts

    if len(trades) < 15:
        return None
    usd = [t['usd'] for t in trades]
    wins = [u for u in usd if u > 0]
    losses = [u for u in usd if u <= 0]
    eq, peak, dd = 0.0, 0.0, 0.0
    for u in usd:
        eq += u
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    daily = defaultdict(float)
    for t in trades:
        daily[t['date']] += t['usd']
    dvals = list(daily.values())
    sharpe = (np.mean(dvals) / np.std(dvals) * math.sqrt(252)
              if len(dvals) > 20 and np.std(dvals) > 0 else 0.0)
    return {
        'n': len(trades), 'wr': round(100 * len(wins) / len(trades), 1),
        'pnl': round(sum(usd)), 'pf': round(sum(wins) / abs(sum(losses)), 2)
        if losses and sum(losses) != 0 else 99.0,
        'maxdd': round(dd), 'sharpe': round(float(sharpe), 2),
        'avg_usd': round(float(np.mean(usd))),
    }


def main():
    prices_ts, prices_px, feats = load()
    print(f'{len(feats)} discovery snapshots')

    fd_vals = [fnum(r['abs_flip_dist_pct']) for r in feats]
    fd_vals = [v for v in fd_vals if v is not None]
    imb_vals = [v for v in (fnum(r['gamma_imbalance']) for r in feats) if v is not None]
    res_vals = [v for v in (fnum(r['near_res_dist_pct']) for r in feats) if v is not None]
    thresholds = {}
    for q in (0.5, 0.7, 0.8, 0.9):
        thresholds[('flip', q)] = quantile(fd_vals, q)
        thresholds[('res', q)] = quantile(res_vals, q)
    for q in (0.3, 0.5):
        thresholds[('imb', q)] = quantile(imb_vals, q)
    for q in (0.2, 0.3):
        thresholds[('flip_lo', q)] = quantile(fd_vals, q)
    for q in (0.7, 0.8):
        thresholds[('imb_hi', q)] = quantile(imb_vals, q)
    print('thresholds:', {f'{k[0]}@{k[1]}': round(v, 4) for k, v in thresholds.items()})

    grid = []
    # LONG matrix
    for flip_q in (None, 0.7, 0.8, 0.9):
        for imb_q in (None, 0.3, 0.5):
            for res_q in (None, 0.5):
                for session in ('rth_am', 'day'):
                    for exit_, stop in (('4h', None), ('4h', 60), ('4h', 100),
                                        ('eod', None), ('eod', 100)):
                        if flip_q is None and imb_q is None and res_q is None \
                                and not (session == 'rth_am' and stop is None):
                            continue  # unconditional baselines: keep 2 only
                        grid.append({'flip_q': flip_q, 'imb_q': imb_q,
                                     'res_q': res_q, 'session': session,
                                     'exit': exit_, 'stop_pts': stop,
                                     'tgt_pts': None, 'short': False})
    # SHORT matrix (mirrored, smaller)
    for flip_q in (0.2, 0.3):
        for imb_q in (0.7, 0.8):
            for session in ('rth_am', 'day'):
                for exit_, stop in (('4h', 60), ('eod', 100)):
                    grid.append({'flip_q': flip_q, 'imb_q': imb_q, 'res_q': None,
                                 'session': session, 'exit': exit_,
                                 'stop_pts': stop, 'tgt_pts': None, 'short': True})

    results = []
    for cfg in grid:
        m = run_config(prices_ts, prices_px, feats, cfg, thresholds)
        if m:
            results.append({**cfg, **m})

    results.sort(key=lambda x: -x['sharpe'])
    hdr = (f"{'dir':5s} {'flip':>4s} {'imb':>4s} {'res':>4s} {'sess':7s} "
           f"{'exit':4s} {'stop':>4s} {'n':>4s} {'WR':>5s} {'PnL$':>8s} "
           f"{'PF':>5s} {'DD$':>7s} {'Shp':>6s} {'avg$':>6s}")
    print('\n' + hdr)
    for x in results[:40]:
        print(f"{'SHORT' if x['short'] else 'LONG':5s} "
              f"{str(x['flip_q']):>4s} {str(x['imb_q']):>4s} {str(x['res_q']):>4s} "
              f"{x['session']:7s} {x['exit']:4s} {str(x['stop_pts']):>4s} "
              f"{x['n']:4d} {x['wr']:5.1f} {x['pnl']:8d} {x['pf']:5.2f} "
              f"{x['maxdd']:7d} {x['sharpe']:6.2f} {x['avg_usd']:6d}")

    (HERE / 'matrix-discovery.json').write_text(json.dumps(results, indent=1))
    print(f'\n{len(results)} configs -> matrix-discovery.json')


if __name__ == '__main__':
    main()
