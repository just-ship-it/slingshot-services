#!/usr/bin/env python3
"""PILOTFISH M7 — LT structure × moving-anchor crossovers (PLAN.md).

Event: median of the knowable LT level set (15m / 1h) crosses an indicator
line with 0.03% deadband. Direction = side after the cross. Payoff:
continuation 60/120m. Control: +37pt-shifted levels.
"""
import csv
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, stat_line, TF_MS

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
ET = ZoneInfo('America/New_York')
rows = load_minutes()
row_ms = [int(datetime.fromisoformat(r['ts'] + ':00+00:00').timestamp() * 1000) for r in rows]
closes = [r['c'] for r in rows]

# ---------- indicators on the 1m grid ----------
IND = {}
for span in (20, 50, 200, 300, 1200, 3000):
    k = 2 / (span + 1)
    out = [closes[0]]
    for c in closes[1:]:
        out.append(out[-1] + k * (c - out[-1]))
    IND[f'EMA{span}'] = out

for name, anchor in (('VWAPsess', 'day'), ('VWAPweek', 'week')):
    out = []
    pv = vv = 0.0
    cur = None
    for i, r in enumerate(rows):
        et = datetime.fromisoformat(r['ts'] + ':00+00:00').astimezone(ET)
        # session key: 18:00 ET starts the new day; week key: Sunday session
        sess = (et - timedelta(hours=18)).date()
        key = sess if anchor == 'day' else sess - timedelta(days=sess.weekday())
        if key != cur:
            cur = key
            pv = vv = 0.0
        px = (r['h'] + r['l'] + r['c']) / 3
        pv += px * r['v']
        vv += r['v']
        out.append(pv / vv if vv else px)
    IND[name] = out

# ---------- LT median series (knowability-shifted) ----------
def lt_median(tf, shift_pts=0.0):
    fn = (f'{BASE}/research/lt-extraction/output/nq_lt_15m_full_2021-2026.csv'
          if tf == '15m' else
          f'{BASE}/research/lt-extraction/output/nq_lt_{tf}_raw.csv')
    ts, med = [], []
    for r in csv.DictReader(open(fn)):
        try:
            lv = sorted(float(r[f'level_{i}']) + shift_pts for i in range(1, 6))
        except ValueError:
            continue
        if any(x != x for x in lv):
            continue
        ts.append(int(r['unix_ms']) + TF_MS[tf])
        med.append(lv[2])
    return ts, med


def sweep(tf, shift_pts, label):
    lts, lmed = lt_median(tf, shift_pts)
    results = {}
    for ind_name, ind in IND.items():
        events = []   # (date, dir, c60, c120)
        li = 0
        state = 0     # -1 below, +1 above, 0 unknown (deadband)
        for i in range(1, len(rows) - 130):
            ms = row_ms[i]
            while li + 1 < len(lts) and lts[li + 1] <= ms:
                li += 1
            if lts[li] > ms:
                continue
            m = lmed[li]
            band = IND[ind_name][i] * 0.0003
            diff = m - ind[i]
            ns = 1 if diff > band else -1 if diff < -band else 0
            if ns != 0 and state != 0 and ns != state:
                if rows[i + 120]['sym'] == rows[i]['sym']:
                    sgn = ns
                    events.append((rows[i]['date'], sgn,
                                   sgn * (rows[i + 60]['c'] - rows[i]['c']),
                                   sgn * (rows[i + 120]['c'] - rows[i]['c'])))
            if ns != 0:
                state = ns
        results[ind_name] = events
    print(f'########## LT-{tf} median × indicators ({label}) ##########')
    for ind_name, events in results.items():
        cells = []
        for plab, sel in (('21-23', lambda x: x < '2024-01-01'),
                          ('2024', lambda x: '2024-01-01' <= x < '2025-01-01'),
                          ('25-26', lambda x: x >= '2025-01-01')):
            evs = [e for e in events if sel(e[0])]
            if len(evs) < 15:
                cells.append(f'{plab}: n={len(evs)} --')
                continue
            import statistics
            a = statistics.mean(e[3] for e in evs)
            wr = 100 * sum(1 for e in evs if e[3] > 0) / len(evs)
            cells.append(f'{plab}: n={len(evs)} {a:+.1f}pt {wr:.0f}%')
        print(f'  {ind_name:9s} cont120 | ' + ' | '.join(cells))
    print()
    return results


for tf in ('15m', '1h'):
    sweep(tf, 0.0, 'REAL')
    sweep(tf, 37.0, 'shift37 control')
