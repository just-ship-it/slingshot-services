#!/usr/bin/env python3
"""P1.3 — GEX level lifecycle: persistence, ghosts, and dissolution.

Builds a registry of every strike's appearances in the top-5 support/
resistance across ALL intraday snapshots (nq-cbbo-causal), then tests:

  H-persist: episodes at walls with longer consecutive-snapshot tenure
             reject more than fresh walls.
  H-ghost:   zone entries at levels that were walls RECENTLY (dropped out of
             the ranking <= N hours ago) still beat placebo.
  Dissolution telemetry: per-strike |gex| trajectory across snapshots
             (feeds the "wall is failing" in-trade exit overlay).

Level identity = QQQ strike (via snapshot multiplier), so identity is stable
across snapshots even as the futures-space price drifts with the multiplier.
"""
import bisect
import json
import glob
import math
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
GEX_DIR = BASE / 'data/gex/nq-cbbo-causal'
ET = ZoneInfo('America/New_York')


def build_registry():
    """Per snapshot: set of wall strikes (+magnitudes). Returns:
       snaps: [(minute_key, {strike: (kind, |gex|, nq_level)})] sorted."""
    snaps = []
    for fp in sorted(glob.glob(str(GEX_DIR / 'nq_gex_*.json'))):
        d = json.load(open(fp))
        for s in d.get('data', []):
            mk = s['timestamp'][:16]
            mult = s.get('multiplier') or 0
            if not mult:
                continue
            m = {}
            for kind, key, gkey in (('sup', 'support', 'support_gex'),
                                    ('res', 'resistance', 'resistance_gex')):
                for lv, g in zip(s.get(key) or [], s.get(gkey) or []):
                    if lv:
                        m[round(lv / mult)] = (kind, abs(g or 0), lv)
            if m:
                snaps.append((mk, m))
    snaps.sort(key=lambda x: x[0])
    return snaps


def main():
    snaps = build_registry()
    print(f'{len(snaps)} snapshots in registry')

    # Per-strike tenure tracking: walk snapshots; for each strike maintain
    # consecutive-presence count and last-seen index.
    tenure = {}           # strike -> consecutive snapshots present (as of current)
    last_seen = {}        # strike -> (snap_idx, minute_key, nq_level)
    # Enriched per-snapshot view for the episode join:
    #   at each snapshot: strike -> tenure (age in snapshots)
    snap_keys = [mk for mk, _ in snaps]
    age_at = []           # idx -> {strike: age}
    ghosts_at = []        # idx -> {strike: (snaps_since_dropped, nq_level)}
    prev_strikes = set()
    dropped = {}          # strike -> (drop_idx, nq_level)

    for idx, (mk, m) in enumerate(snaps):
        cur = set(m.keys())
        for k in cur:
            tenure[k] = tenure.get(k, 0) + 1 if k in prev_strikes else 1
            last_seen[k] = (idx, mk, m[k][2])
            dropped.pop(k, None)
        for k in prev_strikes - cur:
            dropped[k] = (idx, last_seen[k][2])
            tenure.pop(k, None)
        age_at.append({k: tenure[k] for k in cur})
        ghosts_at.append({k: (idx - v[0], v[1]) for k, v in dropped.items()
                          if idx - v[0] <= 16})   # ghost horizon: ~4h of snapshots
        prev_strikes = cur

    # ---- Join tenure onto the P1 episodes (wall class only) ----
    eps = json.load(open(HERE / 'episodes.json'))
    walls = [e for e in eps if e['cls'] == 'wall']
    # NOTE: episodes were built from each day's ~09:45 snapshot; find that
    # snapshot's index by day for the age lookup.
    day_first_idx = {}
    for idx, mk in enumerate(snap_keys):
        # snapshot minute in ET >= 09:45 handled at build time in episodes;
        # here take the first snapshot of each day at/after 13:45 UTC approx —
        # match by day + closest snapshot at-or-before the episode entry.
        day = mk[:10]
        day_first_idx.setdefault(day, idx)

    def age_for(e):
        i = bisect.bisect_right(snap_keys, e['ts']) - 1
        if i < 0:
            return None
        # strike identity: reconstruct from level via that snapshot's map
        m = snaps[i][1]
        best = min(m.keys(), key=lambda k: abs(m[k][2] - e['level']), default=None)
        if best is None or abs(m[best][2] - e['level']) / e['level'] > 0.001:
            return None
        return age_at[i].get(best)

    buckets = defaultdict(list)
    for e in walls:
        a = age_for(e)
        if a is None:
            continue
        b = 'fresh(1-2)' if a <= 2 else 'young(3-8)' if a <= 8 else 'aged(9+)'
        buckets[(b, e['side'])].append(e)

    print('\n=== H-persist: wall tenure (consecutive snapshots) x approach ===')
    print(f"{'group':28s} {'n':>6s} {'rej%':>6s} {'acc%':>6s}")
    for g in sorted(buckets):
        ev = buckets[g]
        if len(ev) < 60:
            continue
        rej = 100 * sum(e['resolution'] == 'rejected' for e in ev) / len(ev)
        acc = 100 * sum(e['resolution'] == 'accepted' for e in ev) / len(ev)
        print(f'{str(g):28s} {len(ev):6d} {rej:6.1f} {acc:6.1f}')

    # ---- H-ghost: zone entries at recently-dropped walls ----
    # Build ghost episodes directly on the price series.
    ts_l, o_l, h_l, l_l, c_l, sym_l = [], [], [], [], [], []
    with open(BASE / 'research/causal-gex-screen/nq_1m_primary_ohlc.csv') as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split(',')
            ts_l.append(p[0]); h_l.append(float(p[2])); l_l.append(float(p[3]))
            c_l.append(float(p[4])); sym_l.append(p[5])
    print(f'\nprice minutes: {len(ts_l)}')

    ghost_eps = []
    CONT = 0.10; ZONE = 0.10
    minute_by_day = defaultdict(list)
    for i, t in enumerate(ts_l):
        minute_by_day[t[:10]].append(i)

    # sample ghosts at each snapshot boundary; episode machinery (simplified:
    # zone entry within the following 15m, resolution over 30m)
    seen = set()
    for idx, (mk, m) in enumerate(snaps):
        for k, (since, lv) in ghosts_at[idx].items():
            gkey = (mk[:10], k)
            if gkey in seen:
                continue
            seen.add(gkey)
            day = mk[:10]
            idxs = minute_by_day.get(day)
            if not idxs:
                continue
            start = bisect.bisect_left(ts_l, mk)
            end = min(start + 15, idxs[-1])
            zone = lv * ZONE / 100
            for j in range(max(start, idxs[0] + 1), end):
                if abs(c_l[j - 1] - lv) > zone and (l_l[j] <= lv + zone and h_l[j] >= lv - zone):
                    side = 'below' if c_l[j - 1] < lv else 'above'
                    k30 = min(j + 30, idxs[-1])
                    if sym_l[k30] != sym_l[j]:
                        break
                    dev = (c_l[k30] - lv) / lv * 100
                    sgn = dev if side == 'below' else -dev
                    lab = 'accepted' if sgn >= CONT else 'rejected' if sgn <= -CONT else 'flat'
                    ghost_eps.append({'since': since, 'side': side, 'label': lab,
                                      'year': day[:4]})
                    break

    print(f'\n=== H-ghost: entries at recently-DROPPED walls (30m resolution) ===')
    gb = defaultdict(list)
    for e in ghost_eps:
        b = '<=1h' if e['since'] <= 4 else '1-2h' if e['since'] <= 8 else '2-4h'
        gb[b].append(e)
    print(f"{'ghost age':10s} {'n':>6s} {'rej%':>6s} {'acc%':>6s}")
    for g in sorted(gb):
        ev = gb[g]
        if len(ev) < 40:
            continue
        rej = 100 * sum(e['label'] == 'rejected' for e in ev) / len(ev)
        acc = 100 * sum(e['label'] == 'accepted' for e in ev) / len(ev)
        print(f'{g:10s} {len(ev):6d} {rej:6.1f} {acc:6.1f}')
    print('(compare vs live-wall 30m-resolution baseline printed by 03: walls ~59-65 rej)')


if __name__ == '__main__':
    main()
