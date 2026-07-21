#!/usr/bin/env python3
"""A2-04: do levels shape the broader path (beyond touch episodes)?

Three probes, each real-vs-placebo through identical machinery:

1. SESSION-EXTREME TERMINATION: is the RTH high/low within N pts of a level
   already knowable at 09:30 ET (pre-open set, frozen)? If levels cap moves,
   real levels should host session extremes more often than placebo levels.

2. ATTRACTION FROM AFAR: sampled every 5 RTH minutes, for each level whose
   current distance from close is 25-75pts, P(price trades within 10pts of
   the FROZEN level value within the next 60m). Attractor: real > placebo.
   (Frozen value = what a resting order at the level would experience;
   immune to "levels chase price" artifacts.)

3. TIME-NEAR (context only, NOT causal evidence): fraction of RTH minutes
   with price within 10pts of any as-of level. Real feeds spawn levels near
   spot, so real>placebo here is expected mechanically — reported to size
   that bias, not to claim attraction.

Placebos: per-identity random +-30..120 offsets (3 draws, same seeds as
A2-02 via shared LevelTracker) and 50/100 round-number grids.
Per-year splits printed for probes 1 and 2.
"""
import math
import os
import statistics as st
from collections import defaultdict

from a2_common import (HERE, iter_et_days, load_gex_day, gex_levels_of,
                       load_lt_feed, AsOfFeed, LevelTracker, bar_dist,
                       grid_values)

N_RAND = 3
STALE = 45 * 60
RTH0, RTH1 = 570, 960


def near(v, levels, tol):
    return any(abs(v - w) <= tol for w in levels)


class Agg:
    def __init__(self):
        self.d = defaultdict(lambda: [0, 0])   # key -> [hits, n]

    def add(self, key, hit):
        c = self.d[key]
        c[0] += int(hit)
        c[1] += 1

    def report(self, title, keys=None):
        print(f'\n### {title}')
        for k in (keys if keys else sorted(self.d)):
            h, n = self.d.get(k, (0, 0))
            if n:
                p = h / n
                se = math.sqrt(p * (1 - p) / n)
                print(f'  {str(k):40s} {100*p:5.1f}% ±{100*se:4.1f} (n={n})')


def main():
    lt_feed = AsOfFeed(load_lt_feed(), STALE)
    ext10, ext25 = Agg(), Agg()
    ext10_yr = Agg()
    attract = Agg()
    attract_yr = Agg()
    timenear = defaultdict(list)

    n_days = 0
    for date, bars in iter_et_days():
        if len(set(b['sym'] for b in bars)) > 1:
            continue
        rth = [b for b in bars if RTH0 <= b['etmin'] < RTH1]
        if len(rth) < 300:
            continue
        gex_snaps = load_gex_day(date)
        gex_feed = AsOfFeed(gex_snaps, STALE) if gex_snaps else None
        year = date[:4]

        # trackers so rand offsets follow the SAME per-identity seeding
        trk = {'gex_real': LevelTracker(N_RAND, f'gex|{date}'),
               'lt_real': LevelTracker(N_RAND, f'lt|{date}')}

        def family_sets(tknow, now_ts, px):
            """dict class -> list of level values, as-of tknow."""
            out = {}
            if gex_feed:
                snap = gex_feed.at(tknow)
                if snap:
                    trk['gex_real'].update(gex_levels_of(snap), now_ts)
                    real = list(trk['gex_real'].levels.values())
                    out['gex_real'] = [l.value for l in real]
                    for k in range(N_RAND):
                        out[f'gex_rand{k}'] = [l.value + l.offsets[k] for l in real]
            lt = lt_feed.at(tknow)
            if lt:
                trk['lt_real'].update(lt, now_ts)
                real = list(trk['lt_real'].levels.values())
                out['lt_real'] = [l.value for l in real]
                for k in range(N_RAND):
                    out[f'lt_rand{k}'] = [l.value + l.offsets[k] for l in real]
            out['grid50'] = grid_values(px, 50)
            out['grid100'] = grid_values(px, 100)
            return out

        # ---------- probe 1: pre-open frozen sets vs session extremes
        open_bar = rth[0]
        pre = family_sets(open_bar['ts'], open_bar['ts'], open_bar['o'])
        hi = max(b['h'] for b in rth)
        lo = min(b['l'] for b in rth)
        n_days += 1
        for cls, levels in pre.items():
            if not levels:
                continue
            c = cls if 'rand' not in cls else cls[:cls.index('rand') + 4]
            for name, v in (('high', hi), ('low', lo)):
                ext10.add((c, name), near(v, levels, 10))
                ext25.add((c, name), near(v, levels, 25))
                ext10_yr.add((c, year), near(v, levels, 10))

        # ---------- probes 2+3: intraday walk
        nearmin = defaultdict(int)
        for i, b in enumerate(rth):
            tknow = b['ts'] + 60
            sets = family_sets(tknow, b['ts'], b['c'])
            for cls, levels in sets.items():
                # keep rand draws separate here: "any level near" must
                # compare equal level counts (5 vs 5), not 5 vs 15
                if levels and any(bar_dist(b, v) <= 10 for v in levels):
                    nearmin[cls] += 1
            if i % 5 == 0:
                for cls, levels in sets.items():
                    c = cls if 'rand' not in cls else cls[:cls.index('rand') + 4]
                    for v in levels:
                        d0 = abs(v - b['c'])
                        if not (25 <= d0 <= 75):
                            continue
                        hit = False
                        walked = 0
                        prev_ts = b['ts']
                        for j in range(i + 1, min(i + 61, len(rth))):
                            if rth[j]['ts'] - prev_ts > 300:
                                break
                            walked += 1
                            prev_ts = rth[j]['ts']
                            if bar_dist(rth[j], v) <= 10:
                                hit = True
                                break
                        if hit or walked >= 60:   # full window or resolved
                            attract.add(c, hit)
                            attract_yr.add((c, year), hit)
        for c, n in nearmin.items():
            timenear[c].append(n / len(rth))

    print(f'RTH days analyzed: {n_days}')
    order = ['gex_real', 'gex_rand', 'lt_real', 'lt_rand', 'grid50', 'grid100']
    ext10.report('P(session extreme within 10pts of pre-open level)',
                 [(c, s) for c in order for s in ('high', 'low')])
    ext25.report('P(session extreme within 25pts of pre-open level)',
                 [(c, s) for c in order for s in ('high', 'low')])
    ext10_yr.report('extreme-within-10 per year (high+low pooled)')
    attract.report('ATTRACTION: P(reach within 10pts of frozen level in 60m | start 25-75pts away)',
                   order)
    attract_yr.report('attraction per year')
    print('\n### TIME-NEAR (context only; % of RTH minutes within 10pts of any level)')
    print('    (rand shown per-draw so level counts match real: 5 vs 5 / 11 vs 11)')
    full_order = ['gex_real', 'gex_rand0', 'gex_rand1', 'gex_rand2',
                  'lt_real', 'lt_rand0', 'lt_rand1', 'lt_rand2',
                  'grid50', 'grid100']
    for c in full_order:
        xs = timenear.get(c, [])
        if xs:
            print(f'  {c:10s} mean={100*st.mean(xs):5.1f}%  median={100*st.median(xs):5.1f}%  (days={len(xs)})')


if __name__ == '__main__':
    main()
