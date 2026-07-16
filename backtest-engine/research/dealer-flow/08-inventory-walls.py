#!/usr/bin/env python3
"""P1.4 — Inventory-native walls: levels straight from dealer positioning.

Level source per day (fully causal, NO snapshot ranking):
  from dealer-strikes-YYYYMMDD.csv (positioning as of prior close), take the
  top-K strikes by |dealer_gamma| within ±2.5% of prior-day spot, split by
  sign. Strike -> NQ price via prior-day close ratio (NQ_close / QQQ_close).

Identity is continuous by construction: a strike's level exists as long as
dealer inventory does — no rank churn, no ghosts.

Test = the P1 capstone experiment re-run on these levels:
  zone entry from below + flat first 5 min ->
    dealer-LONG strike:  expect downward drift (fade)
    dealer-SHORT strike: expect upward drift
  vs the SAME placebo baseline machinery (fresh placebo levels).

If separation >= snapshot walls (with comparable or better episode counts),
inventory-native becomes the strategy's level source.
"""
import bisect
import csv
import glob
import json
import math
import random
from collections import defaultdict
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
FLOW = BASE / 'data/flow/qqq'
ZONE_PCT, EXIT_PCT = 0.10, 0.20
MAX_MIN = 120
TOP_K = 5
NEAR_PCT = 2.5


def load_prices():
    ts, h, l, c, sym = [], [], [], [], []
    with open(BASE / 'research/causal-gex-screen/nq_1m_primary_ohlc.csv') as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split(',')
            ts.append(p[0]); h.append(float(p[2])); l.append(float(p[3]))
            c.append(float(p[4])); sym.append(p[5])
    return ts, h, l, c, sym


def daily_closes(path, ts_col='ts_event', close_col='close'):
    closes = {}
    with open(path) as f:
        r = csv.reader(f)
        header = next(r)
        i_ts, i_c = header.index(ts_col), header.index(close_col)
        for row in r:
            if len(row) <= max(i_ts, i_c):
                continue
            try:
                closes[row[i_ts][:10]] = float(row[i_c])
            except ValueError:
                continue
    return closes


def main():
    ts, h, l, c, sym = load_prices()
    qqq_close = daily_closes(BASE / 'data/ohlcv/qqq/QQQ_ohlcv_1m.csv')
    # NQ prior close from the primary cache (last close per day)
    nq_close = {}
    for i, t in enumerate(ts):
        nq_close[t[:10]] = c[i]

    day_idx = defaultdict(list)
    for i, t in enumerate(ts):
        day_idx[t[:10]].append(i)

    files = sorted(glob.glob(str(FLOW / 'dealer-strikes-*.csv')))
    rng = random.Random(99)
    episodes = []

    all_days = sorted(day_idx.keys())

    for fp in files:
        d8 = fp.split('-')[-1].split('.')[0]
        day = f'{d8[:4]}-{d8[4:6]}-{d8[6:8]}'
        idxs = day_idx.get(day)
        if not idxs:
            continue
        # prior trading day for the ratio (causal)
        pi = bisect.bisect_left(all_days, day) - 1
        if pi < 0:
            continue
        pday = all_days[pi]
        if pday not in qqq_close or pday not in nq_close:
            continue
        ratio = nq_close[pday] / qqq_close[pday]
        spot_q = qqq_close[pday]

        strikes = []
        for r in csv.DictReader(open(fp)):
            k = float(r['strike'])
            g = float(r['dealer_gamma'])
            if g == 0 or abs(k - spot_q) / spot_q * 100 > NEAR_PCT:
                continue
            strikes.append((abs(g), 1 if g > 0 else -1, k))
        strikes.sort(reverse=True)
        levels = [(k * ratio, sign, 'inv') for (_, sign, k) in strikes[:TOP_K * 2]]
        # fresh placebo, same count
        i0, i1 = idxs[0], idxs[-1]
        day_hi = max(h[i0:i1 + 1]); day_lo = min(l[i0:i1 + 1])
        levels += [(rng.uniform(day_lo, day_hi), 0, 'plc') for _ in range(len(levels))]

        for (L, sign, cls) in levels:
            zone = L * ZONE_PCT / 100
            j = i0 + 1
            visits = 0
            while j <= i1:
                if abs(c[j - 1] - L) > zone and (l[j] <= L + zone and h[j] >= L - zone):
                    entry_i = j
                    visits += 1
                    side = 'below' if c[j - 1] < L else 'above'
                    # walk with fixed-horizon outcomes
                    outc = {}
                    resolution = 'expired'
                    end_i = min(entry_i + MAX_MIN, i1)
                    ok = True
                    for k2 in range(entry_i, end_i + 1):
                        if sym[k2] != sym[entry_i]:
                            ok = False
                            break
                        mins = k2 - entry_i
                        dev = (c[k2] - L) / L * 100
                        sgn = dev if side == 'below' else -dev
                        for m_ in (5, 60, 120):
                            if mins == m_:
                                outc[f'r{m_}'] = math.log(c[k2] / c[entry_i]) * 100
                        if resolution == 'expired':
                            if sgn >= EXIT_PCT:
                                resolution = 'accepted'
                            elif sgn <= -EXIT_PCT:
                                resolution = 'rejected'
                    if ok and 'r5' in outc:
                        episodes.append({'cls': cls, 'sign': sign, 'side': side,
                                         'res': resolution, **outc,
                                         'year': day[:4]})
                    j = entry_i + 15
                else:
                    j += 1

    print(f'{len(episodes)} episodes')
    (HERE / 'inv-episodes.json').write_text(json.dumps(episodes))

    import statistics
    def show(label, rows):
        if len(rows) < 40:
            return
        rej = 100 * sum(e['res'] == 'rejected' for e in rows) / len(rows)
        r60 = [e['r60'] - e['r5'] for e in rows if 'r60' in e]
        r120 = [e['r120'] - e['r5'] for e in rows if 'r120' in e]
        print(f'{label:36s} n={len(rows):5d} rej={rej:5.1f} '
              f'post r5→r60={statistics.mean(r60) if r60 else float("nan"):+.4f} '
              f'r5→r120={statistics.mean(r120) if r120 else float("nan"):+.4f}')

    print('\n=== capstone re-test on INVENTORY-NATIVE levels (flat-stall, below) ===')
    flat = [e for e in episodes if e['side'] == 'below' and -0.05 < e['r5'] < 0.05]
    show('dealer-LONG strikes', [e for e in flat if e['cls'] == 'inv' and e['sign'] == 1])
    show('dealer-SHORT strikes', [e for e in flat if e['cls'] == 'inv' and e['sign'] == -1])
    show('placebo', [e for e in flat if e['cls'] == 'plc'])
    print('\n(snapshot-wall reference: dgLong −0.041/hr, dgShort +0.027/hr, placebo +0.01)')


if __name__ == '__main__':
    main()
