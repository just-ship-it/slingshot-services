#!/usr/bin/env python3
"""Shape the two year-stable touch candidates into event strategies (1m sim).

  A retest-long:   price ABOVE a causal GEX resistance touches back onto it
                   -> long continuation. Variants: wick-only, no-LT-confluence.
  B support-bounce: price above support, WICK touch (close holds above)
                   -> long scalp back up.

Single 1-NQ slot per strategy, entry next 1m bar close after event, $4 RT +
0.5pt slip/side, exits on 1m high/low (stops/targets anchored to the LEVEL,
not entry, for A; to entry for B). Per-year output — keep only all-years-
positive cells. 1s validation follows for survivors.
"""
import csv
import json
import math
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

HERE = Path(__file__).parent
ET = ZoneInfo('America/New_York')
PT, COMM, SLIP = 20.0, 4.0, 0.5


def load_prices():
    ts, o, h, l, c, sym = [], [], [], [], [], []
    with open(HERE / 'nq_1m_primary_ohlc.csv') as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split(',')
            ts.append(p[0]); o.append(float(p[1])); h.append(float(p[2]))
            l.append(float(p[3])); c.append(float(p[4])); sym.append(p[5])
    return ts, o, h, l, c, sym


def run(events, prices, cfg):
    ts, o, h, l, c, sym = prices
    trades = []
    busy_until = ''
    for e in events:
        if e['ts'] <= busy_until:
            continue
        i0 = e['i'] + 1                      # entry bar = next 1m bar
        if i0 >= len(ts) or ts[i0][:10] != e['ts'][:10]:
            continue
        entry = c[i0] + SLIP
        L = e['level']
        if cfg['anchor'] == 'level':
            stop = L - cfg['stop_pts']
            tgt = entry + cfg['tgt_pts'] if cfg['tgt_pts'] else None
        else:
            stop = entry - cfg['stop_pts']
            tgt = entry + cfg['tgt_pts'] if cfg['tgt_pts'] else None
        t_entry = datetime.fromisoformat(ts[i0] + ':00+00:00')
        bound_key = (t_entry + timedelta(minutes=cfg['max_hold_min'])
                     ).strftime('%Y-%m-%dT%H:%M')
        pnl = exit_ts = None
        for j in range(i0 + 1, min(i0 + cfg['max_hold_min'] + 300, len(ts))):
            if sym[j] != sym[i0]:
                pnl = c[j - 1] - entry
                exit_ts = ts[j - 1]
                break
            if l[j] <= stop:
                pnl = (stop - entry) - SLIP
                exit_ts = ts[j]
                break
            if tgt and h[j] >= tgt:
                pnl = (tgt - entry) - SLIP
                exit_ts = ts[j]
                break
            if ts[j] >= bound_key:
                pnl = (c[j] - entry) - SLIP
                exit_ts = ts[j]
                break
        if pnl is None:
            continue
        trades.append({'ts': e['ts'], 'exit': exit_ts,
                       'usd': pnl * PT - COMM, 'year': e['year']})
        busy_until = exit_ts
    return trades


def metrics(trades):
    if len(trades) < 15:
        return None
    usd = [t['usd'] for t in trades]
    wins = [u for u in usd if u > 0]
    losses = [u for u in usd if u <= 0]
    eq = peak = dd = 0.0
    for u in usd:
        eq += u; peak = max(peak, eq); dd = max(dd, peak - eq)
    daily = defaultdict(float)
    for t in trades:
        daily[t['ts'][:10]] += t['usd']
    dv = list(daily.values())
    shp = (np.mean(dv) / np.std(dv) * math.sqrt(252)
           if len(dv) > 20 and np.std(dv) > 0 else 0.0)
    return {'n': len(trades), 'wr': round(100 * len(wins) / len(usd), 1),
            'pnl': round(sum(usd)),
            'pf': round(sum(wins) / abs(sum(losses)), 2) if losses else 99.0,
            'maxdd': round(dd), 'sharpe': round(float(shp), 2)}


def main():
    prices = load_prices()
    events = json.load(open(HERE / 'touch-events.json'))
    events.sort(key=lambda e: e['ts'])

    fams = {
        'A-retest': [e for e in events if e['kind'] == 'res'
                     and e['approach'] == 'above'],
        'A-retest-wick': [e for e in events if e['kind'] == 'res'
                          and e['approach'] == 'above' and not e['closed_through']],
        'A-retest-noLT': [e for e in events if e['kind'] == 'res'
                          and e['approach'] == 'above' and not e['lt_confl']],
        'B-supbounce-wick': [e for e in events if e['kind'] == 'sup'
                             and e['approach'] == 'above' and not e['closed_through']],
    }

    grids = {
        'A': [{'anchor': 'level', 'stop_pts': s, 'tgt_pts': t, 'max_hold_min': m}
              for s in (25, 40) for t in (None, 60, 100) for m in (120, 240)],
        'B': [{'anchor': 'level', 'stop_pts': s, 'tgt_pts': t, 'max_hold_min': m}
              for s in (15, 25) for t in (30, 50) for m in (45, 90)],
    }

    print(f"{'family':18s} {'cfg':28s} {'n':>5s} {'WR':>5s} {'PnL$':>8s} "
          f"{'PF':>5s} {'DD$':>7s} {'Shp':>6s}  yearly_pnl")
    results = []
    for fam, evs in fams.items():
        for cfg in grids[fam[0]]:
            trades = run(evs, prices, cfg)
            m = metrics(trades)
            if not m:
                continue
            ypnl = defaultdict(float)
            for t in trades:
                ypnl[t['year']] += t['usd']
            yr = {y: round(v) for y, v in sorted(ypnl.items())}
            all_pos = all(v > 0 for v in yr.values()) and len(yr) >= 4
            tag = ' *ALL-YEARS+*' if all_pos else ''
            cs = f"s{cfg['stop_pts']}/t{cfg['tgt_pts']}/m{cfg['max_hold_min']}"
            print(f'{fam:18s} {cs:28s} {m["n"]:5d} {m["wr"]:5.1f} '
                  f'{m["pnl"]:8d} {m["pf"]:5.2f} {m["maxdd"]:7d} '
                  f'{m["sharpe"]:6.2f}  {yr}{tag}')
            results.append({'family': fam, **cfg, **m, 'yearly': yr,
                            'all_years_pos': all_pos})
    (HERE / 'shape-touch.json').write_text(json.dumps(results, indent=1))


if __name__ == '__main__':
    main()
