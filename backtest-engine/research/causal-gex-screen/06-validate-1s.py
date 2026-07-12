#!/usr/bin/env python3
"""1s-honest validation of matrix finalists (CLAUDE.md research mandate).

Entry: market at the OPEN of the first 1s bar at/after signal_minute+1min
(primary contract only), + 0.5 pt slippage. Exits walk 1s bars chronologically
from the fill: stop = stop-market fill at stop_level -/+ 0.5 pt slip when bar
low/high breaches; time boundary = open of first bar at/after boundary; roll =
exit at last bar of old contract. $4 RT commission, $20/pt.

Uses NQ_ohlcv_1s.index.json minute-offset seeks (7.6GB file, window reads only).
"""
import bisect
import csv
import json
import math
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

HERE = Path(__file__).parent
BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
F1S = BASE / 'data/ohlcv/nq/NQ_ohlcv_1s.csv'
IDX = json.load(open(BASE / 'data/ohlcv/nq/NQ_ohlcv_1s.index.json'))['minutes']
ET = ZoneInfo('America/New_York')
PT, COMM, SLIP = 20.0, 4.0, 0.5

FINALISTS = [
    {'name': 'F1-long-flip90-imb50-am', 'short': False, 'flip_q': 0.9,
     'imb_q': 0.5, 'res_q': None, 'session': 'rth_am', 'exit': '4h', 'stop_pts': 100},
    {'name': 'F2-short-flip20-imb80-day', 'short': True, 'flip_q': 0.2,
     'imb_q': 0.8, 'res_q': None, 'session': 'day', 'exit': 'eod', 'stop_pts': 100},
    {'name': 'F3-long-flip80-res50-day', 'short': False, 'flip_q': 0.8,
     'imb_q': None, 'res_q': 0.5, 'session': 'day', 'exit': '4h', 'stop_pts': 100},
]


def fnum(v):
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def minute_epoch(ts_min):
    return int(datetime.fromisoformat(ts_min + ':00+00:00').timestamp() * 1000)


_f = open(F1S, 'rb')


def bars_for_minute(ts_min):
    ent = IDX.get(str(minute_epoch(ts_min)))
    if not ent:
        return []
    _f.seek(ent['offset'])
    chunk = _f.read(ent['length']).decode('utf-8', 'replace')
    out = []
    for line in chunk.splitlines():
        p = line.split(',')
        if len(p) < 10 or '-' in p[9]:
            continue
        try:
            out.append((p[0], float(p[4]), float(p[5]), float(p[6]),
                        float(p[7]), p[9].strip()))
        except ValueError:
            continue
    return out


def minute_iter(start_min, max_minutes):
    t = datetime.fromisoformat(start_min + ':00+00:00')
    for _ in range(max_minutes):
        yield t.strftime('%Y-%m-%dT%H:%M')
        t += timedelta(minutes=1)


def load_inputs():
    prices_sym = {}
    with open(HERE / 'nq_1m_primary_2023plus.csv') as f:
        next(f)
        for line in f:
            ts, close, sym = line.rstrip('\n').split(',')
            prices_sym[ts] = sym
    feats = [r for r in csv.DictReader(open(HERE / 'features.csv'))
             if r['date'].startswith('2025')]
    feats.sort(key=lambda r: r['ts'])
    return prices_sym, feats


def thresholds_from(feats):
    fd = [v for v in (fnum(r['abs_flip_dist_pct']) for r in feats) if v is not None]
    imb = [v for v in (fnum(r['gamma_imbalance']) for r in feats) if v is not None]
    res = [v for v in (fnum(r['near_res_dist_pct']) for r in feats) if v is not None]
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


def signal_ok(r, cfg, th):
    t_et = datetime.fromisoformat(r['ts'] + ':00+00:00').astimezone(ET)
    hm = t_et.strftime('%H:%M')
    if cfg['session'] == 'rth_am' and not ('09:30' <= hm <= '11:59'):
        return False
    if cfg['session'] == 'day' and not ('04:00' <= hm <= '14:30'):
        return False
    fd, imb = fnum(r['abs_flip_dist_pct']), fnum(r['gamma_imbalance'])
    nres = fnum(r['near_res_dist_pct'])
    if cfg['short']:
        if cfg['flip_q'] is not None and not (fd is not None and fd <= th[('flip_lo', cfg['flip_q'])]):
            return False
        if cfg['imb_q'] is not None and not (imb is not None and imb >= th[('imb_hi', cfg['imb_q'])]):
            return False
    else:
        if cfg['flip_q'] is not None and not (fd is not None and fd >= th[('flip', cfg['flip_q'])]):
            return False
        if cfg['imb_q'] is not None and not (imb is not None and imb <= th[('imb', cfg['imb_q'])]):
            return False
        if cfg['res_q'] is not None and not (nres is not None and nres >= th[('res', cfg['res_q'])]):
            return False
    return True


def simulate(cfg, feats, prices_sym, th):
    side = -1 if cfg['short'] else 1
    trades = []
    busy_until = ''
    for r in feats:
        ts = r['ts']
        if ts <= busy_until or not signal_ok(r, cfg, th):
            continue
        entry_min = (datetime.fromisoformat(ts + ':00+00:00')
                     + timedelta(minutes=1)).strftime('%Y-%m-%dT%H:%M')
        # find entry bar
        entry_px = entry_sym = entry_bar_ts = None
        for m in minute_iter(entry_min, 6):
            psym = prices_sym.get(m)
            if not psym:
                continue
            for b in bars_for_minute(m):
                if b[5] == psym:
                    entry_px, entry_sym, entry_bar_ts = b[1] + side * SLIP, psym, b[0]
                    break
            if entry_px:
                entry_min = m
                break
        if not entry_px:
            continue

        t_entry = datetime.fromisoformat(entry_min + ':00+00:00')
        if cfg['exit'] == '4h':
            t_bound = t_entry + timedelta(hours=4)
        else:
            eod = t_entry.astimezone(ET).replace(hour=15, minute=45, second=0)
            t_bound = eod.astimezone(t_entry.tzinfo)
            if t_bound <= t_entry:
                continue
        bound_key = t_bound.strftime('%Y-%m-%dT%H:%M')
        stop_lvl = entry_px - side * cfg['stop_pts'] if cfg['stop_pts'] else None

        pnl = exit_min = None
        last_close = entry_px
        for m in minute_iter(entry_min, 60 * 30):
            bars = bars_for_minute(m)
            psym = prices_sym.get(m)
            if bars and psym and psym != entry_sym:      # roll
                pnl = side * (last_close - entry_px)
                exit_min = m
                break
            hit_bound = m >= bound_key
            for b in bars:
                if b[5] != entry_sym:
                    continue
                if m == entry_min and b[0] < entry_bar_ts:
                    continue
                if hit_bound:
                    pnl = side * (b[1] - entry_px) - SLIP
                    exit_min = m
                    break
                if stop_lvl is not None and (
                        (side == 1 and b[3] <= stop_lvl) or
                        (side == -1 and b[2] >= stop_lvl)):
                    pnl = -cfg['stop_pts'] - SLIP
                    exit_min = m
                    break
                last_close = b[4]
            if pnl is not None:
                break
        if pnl is None:
            continue
        trades.append({'ts': ts, 'exit': exit_min, 'usd': pnl * PT - COMM,
                       'date': ts[:10]})
        busy_until = exit_min

    usd = [t['usd'] for t in trades]
    if not usd:
        return None
    wins = [u for u in usd if u > 0]
    losses = [u for u in usd if u <= 0]
    eq = peak = dd = 0.0
    for u in usd:
        eq += u
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    daily = defaultdict(float)
    for t in trades:
        daily[t['date']] += t['usd']
    dv = list(daily.values())
    sharpe = (np.mean(dv) / np.std(dv) * math.sqrt(252)
              if len(dv) > 20 and np.std(dv) > 0 else 0.0)
    return {'n': len(trades), 'wr': round(100 * len(wins) / len(usd), 1),
            'pnl': round(sum(usd)),
            'pf': round(sum(wins) / abs(sum(losses)), 2) if losses else 99.0,
            'maxdd': round(dd), 'sharpe': round(float(sharpe), 2),
            'trades': trades}


def main():
    prices_sym, feats = load_inputs()
    th = thresholds_from(feats)
    out = {}
    for cfg in FINALISTS:
        m = simulate(cfg, feats, prices_sym, th)
        if m:
            print(f"{cfg['name']:28s} n={m['n']:4d} WR={m['wr']:5.1f} "
                  f"PnL=${m['pnl']:,} PF={m['pf']:.2f} DD=${m['maxdd']:,} "
                  f"Shp={m['sharpe']:.2f}")
            out[cfg['name']] = {k: v for k, v in m.items() if k != 'trades'}
            (HERE / f"trades-1s-{cfg['name']}.json").write_text(
                json.dumps(m['trades'], indent=1))
    (HERE / 'validate-1s.json').write_text(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()
