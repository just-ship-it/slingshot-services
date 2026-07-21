#!/usr/bin/env python3
"""A2-01: characterize the two level feeds (GEX, LT) before any touch work.

Outputs:
  - stdout report (counts, cadence, turnover, distance-from-spot, agreement)
  - vol_daily.csv : per-ET-date volatility scales from the primary-contract
    cache (median |dClose| at 5/15/30/60m horizons, daily range, n bars) —
    used by later scripts to normalize effect sizes across the 3x price drift.
"""
import csv
import json
import os
import statistics as st
from collections import Counter, defaultdict

from a2_common import (HERE, iter_et_days, gex_dates, load_gex_day,
                       gex_levels_of, load_lt_feed, AsOfFeed)

VOL_OUT = os.path.join(HERE, 'vol_daily.csv')


def pct(xs, q):
    if not xs:
        return float('nan')
    xs = sorted(xs)
    i = min(len(xs) - 1, max(0, int(q * (len(xs) - 1))))
    return xs[i]


def dist_summary(name, xs):
    print(f'  {name}: n={len(xs)} p10={pct(xs,0.10):.1f} p25={pct(xs,0.25):.1f} '
          f'median={pct(xs,0.50):.1f} p75={pct(xs,0.75):.1f} p90={pct(xs,0.90):.1f}')


# ---------------------------------------------------------------- GEX
def characterize_gex():
    dates = gex_dates()
    print(f'== GEX feed: {len(dates)} day files, {dates[0]} .. {dates[-1]}')
    snap_counts, spacings, level_counts = [], [], []
    dists = []                       # |level - nq_spot| at snapshot time
    persist1, persist5, tot_pairs = 0, 0, 0
    lifetimes = []                   # snapshots survived per level identity
    first_last = []
    per_year_days = Counter()
    for d in dates:
        snaps = load_gex_day(d)
        if not snaps:
            continue
        per_year_days[d[:4]] += 1
        snap_counts.append(len(snaps))
        stamps = [s[0] for s in snaps]
        spacings += [(b - a) / 60 for a, b in zip(stamps, stamps[1:])]
        first_last.append((snaps[0][1]['timestamp'], snaps[-1][1]['timestamp']))
        prev_levels = None
        alive = {}                   # rounded level value -> snapshots alive
        for _, s in snaps:
            lv = gex_levels_of(s)
            level_counts.append(len(lv))
            spot = s.get('nq_spot') or 0
            if spot:
                dists += [abs(v - spot) for v in lv]
            if prev_levels is not None:
                tot_pairs += len(prev_levels)
                for v in prev_levels:
                    if any(abs(v - w) <= 1.0 for w in lv):
                        persist1 += 1
                    if any(abs(v - w) <= 5.0 for w in lv):
                        persist5 += 1
            # lifetime tracking (5pt identity)
            nxt = {}
            for v in lv:
                key = None
                for pv in alive:
                    if abs(pv - v) <= 5.0:
                        key = pv
                        break
                nxt[v] = alive.get(key, 0) + 1 if key is not None else 1
            for pv, life in alive.items():
                if not any(abs(pv - v) <= 5.0 for v in lv):
                    lifetimes.append(life)
            alive = nxt
            prev_levels = lv
        lifetimes += list(alive.values())
    print(f'  days per year: {dict(sorted(per_year_days.items()))}')
    print(f'  snapshots/day: median={pct(snap_counts,0.5)} p10={pct(snap_counts,0.1)} p90={pct(snap_counts,0.9)}')
    print(f'  snapshot spacing (min): median={pct(spacings,0.5):.0f} p90={pct(spacings,0.9):.0f}')
    print(f'  first/last snapshot example: {first_last[len(first_last)//2]}')
    print(f'  levels per snapshot: median={pct(level_counts,0.5)} min={min(level_counts)} max={max(level_counts)}')
    dist_summary('distance from spot (pts)', dists)
    print(f'  snapshot-to-snapshot persistence: within 1pt {persist1/tot_pairs:.1%}, within 5pt {persist5/tot_pairs:.1%} (n={tot_pairs})')
    lt_h = [x / 4 for x in lifetimes]   # snapshots -> hours (15m each)
    dist_summary('level lifetime (hours, 5pt identity, within-day)', lt_h)


# ---------------------------------------------------------------- LT
def characterize_lt(lt_rows):
    print(f'\n== LT feed: {len(lt_rows)} rows')
    per_year = Counter()
    changes, tot = 0, 0
    lifetimes = defaultdict(int)
    life_done = []
    prev = None
    for ts, lv in lt_rows:
        import datetime
        y = datetime.datetime.utcfromtimestamp(ts).year
        per_year[y] += 1
        if prev is not None and ts - prev[0] <= 3600:
            tot += 1
            same = (sorted(round(v, 1) for v in lv) ==
                    sorted(round(v, 1) for v in prev[1]))
            if not same:
                changes += 1
            nxt = {}
            for v in lv:
                key = None
                for pv in lifetimes:
                    if abs(pv - v) <= 5.0:
                        key = pv
                        break
                nxt[v] = lifetimes.get(key, 0) + 1 if key is not None else 1
            for pv, life in lifetimes.items():
                if not any(abs(pv - v) <= 5.0 for v in lv):
                    life_done.append(life)
            lifetimes = nxt
        else:
            life_done += list(lifetimes.values())
            lifetimes = {v: 1 for v in lv}
        prev = (ts, lv)
    print(f'  rows per year: {dict(sorted(per_year.items()))}')
    print(f'  set changed row-to-row (0.1pt): {changes/tot:.1%} of {tot} consecutive pairs')
    life_h = [x / 4 for x in life_done]
    dist_summary('level lifetime (hours, 5pt identity)', life_h)


# ------------------------------------------------ LT distance from spot + vol
def cache_pass(lt_feed):
    print('\n== cache pass: LT distance-from-spot + daily vol table')
    lt_dists = []
    vol_rows = []
    n_days = 0
    multi_sym_days = []
    for date, bars in iter_et_days():
        n_days += 1
        syms = set(b['sym'] for b in bars)
        if len(syms) > 1:
            multi_sym_days.append(date)
        closes = [b['c'] for b in bars]
        # vol scales (all-day and RTH-only; RTH = ET 09:30-16:00)
        row = {'date': date, 'n_bars': len(bars),
               'day_range': max(b['h'] for b in bars) - min(b['l'] for b in bars)}
        for h in (5, 15, 30, 60):
            moves = [abs(closes[i + h] - closes[i])
                     for i in range(0, len(closes) - h, h)]
            row[f'absmove_{h}m'] = round(st.median(moves), 2) if moves else ''
        rth = [b['c'] for b in bars if 570 <= b['etmin'] < 960]
        if len(rth) >= 300:
            for h in (30,):
                moves = [abs(rth[i + h] - rth[i])
                         for i in range(0, len(rth) - h, h)]
                row['absmove_30m_rth'] = round(st.median(moves), 2)
        else:
            row['absmove_30m_rth'] = ''
        vol_rows.append(row)
        # LT distances sampled every 15 bars
        for i in range(0, len(bars), 15):
            b = bars[i]
            payload = lt_feed.at(b['ts'] + 60)
            if payload:
                lt_dists += [abs(v - b['c']) for v in payload]
    with open(VOL_OUT, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['date', 'n_bars', 'day_range',
                                          'absmove_5m', 'absmove_15m',
                                          'absmove_30m', 'absmove_60m',
                                          'absmove_30m_rth'])
        w.writeheader()
        w.writerows(vol_rows)
    print(f'  cache days: {n_days}; days with >1 contract symbol (roll days, EXCLUDED from touch census): {len(multi_sym_days)}')
    print(f'  roll days: {multi_sym_days}')
    dist_summary('LT distance from spot (pts)', lt_dists)
    print(f'  wrote {VOL_OUT} ({len(vol_rows)} days)')


# ---------------------------------------------------------------- agreement
def agreement(lt_feed):
    print('\n== GEX vs LT agreement (at GEX snapshot stamps, LT as-of<=stamp, cap 2h)')
    within10 = within25 = total = 0
    lt_w10 = lt_w25 = lt_tot = 0
    for d in gex_dates():
        for ts, s in load_gex_day(d):
            lt = lt_feed.at(ts)
            if not lt:
                continue
            gx = gex_levels_of(s)
            for v in gx:
                total += 1
                md = min(abs(v - w) for w in lt)
                if md <= 10:
                    within10 += 1
                if md <= 25:
                    within25 += 1
            for w in lt:
                lt_tot += 1
                md = min(abs(v - w) for v in gx)
                if md <= 10:
                    lt_w10 += 1
                if md <= 25:
                    lt_w25 += 1
    print(f'  GEX level near an LT level: within10 {within10/total:.1%}, within25 {within25/total:.1%} (n={total})')
    print(f'  LT level near a GEX level: within10 {lt_w10/lt_tot:.1%}, within25 {lt_w25/lt_tot:.1%} (n={lt_tot})')


def main():
    lt_rows = load_lt_feed()
    # sanity: datetime column tz vs unix stamp
    import datetime
    with open('/home/drew/projects/slingshot-services/backtest-engine/data/liquidity/nq/NQ_liquidity_levels.csv') as f:
        r = csv.DictReader(f)
        row = next(r)
    print('LT tz check: datetime col =', row['datetime'], '| unix->UTC =',
          datetime.datetime.utcfromtimestamp(int(row['unix_timestamp']) / 1000).isoformat())
    characterize_gex()
    characterize_lt(lt_rows)
    lt_feed = AsOfFeed(lt_rows, staleness_sec=2 * 3600)
    cache_pass(lt_feed)
    agreement(lt_feed)


if __name__ == '__main__':
    main()
