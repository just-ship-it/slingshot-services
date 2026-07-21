#!/usr/bin/env python3
"""A2 shared machinery: cache streaming, as-of level feeds, level tracking.

KNOWABILITY rules implemented here:
  - 1m bar stamped at open ts covers [ts, ts+60s); its OHLC is knowable at
    ts+60s ("bar close time").
  - A GEX snapshot / LT row stamped S is usable for a bar only if
    S <= bar_close_time (as-of join, at-or-before, with staleness cap).
"""
import csv
import json
import os
import random
from bisect import bisect_right
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache_nq_primary_1m.csv')
GEX_DIR = '/home/drew/projects/slingshot-services/backtest-engine/data/gex/nq'
LT_CSV = '/home/drew/projects/slingshot-services/backtest-engine/data/liquidity/nq/NQ_liquidity_levels.csv'

ET = ZoneInfo('America/New_York')
_UTC = timezone.utc

# ---------------------------------------------------------------- time utils
_hour_cache = {}


def et_parts(ts_min):
    """ts_min = 'YYYY-MM-DDTHH:MM' UTC -> (et_date_str, et_minute_of_day)."""
    hour_key = ts_min[:13]
    got = _hour_cache.get(hour_key)
    if got is None:
        dt = datetime(int(ts_min[:4]), int(ts_min[5:7]), int(ts_min[8:10]),
                      int(ts_min[11:13]), tzinfo=_UTC).astimezone(ET)
        got = (dt.strftime('%Y-%m-%d'), dt.hour)
        _hour_cache[hour_key] = got
    minute = int(ts_min[14:16])
    return got[0], got[1] * 60 + minute


def utc_epoch(ts_min):
    """'YYYY-MM-DDTHH:MM' UTC -> epoch seconds of bar OPEN."""
    return int(datetime(int(ts_min[:4]), int(ts_min[5:7]), int(ts_min[8:10]),
                        int(ts_min[11:13]), int(ts_min[14:16]),
                        tzinfo=_UTC).timestamp())


# ---------------------------------------------------------------- cache walk
def iter_et_days(cache_path=CACHE):
    """Yield (et_date, bars). bars = list of dicts with keys
    ts(epoch open sec), etmin(minute-of-day ET), o,h,l,c,v,sym.
    Grouped by ET calendar date."""
    cur_date, bars = None, []
    with open(cache_path, newline='') as f:
        r = csv.reader(f)
        next(r)
        for row in r:
            d, etmin = et_parts(row[0])
            if d != cur_date:
                if bars:
                    yield cur_date, bars
                cur_date, bars = d, []
            bars.append({'ts': utc_epoch(row[0]), 'etmin': etmin,
                         'o': float(row[1]), 'h': float(row[2]),
                         'l': float(row[3]), 'c': float(row[4]),
                         'v': int(row[5]), 'sym': row[6]})
    if bars:
        yield cur_date, bars


# ---------------------------------------------------------------- GEX feed
def gex_dates():
    return sorted(fn[7:17] for fn in os.listdir(GEX_DIR)
                  if fn.startswith('nq_gex_') and fn.endswith('.json'))


def load_gex_day(date):
    """Return sorted list of (epoch_sec_stamp, snapshot_dict) for an ET date,
    or [] if no file. Snapshot stamp = the instant it became knowable."""
    path = os.path.join(GEX_DIR, f'nq_gex_{date}.json')
    if not os.path.exists(path):
        return []
    with open(path) as f:
        d = json.load(f)
    out = []
    for s in d['data']:
        ts = datetime.fromisoformat(s['timestamp']).timestamp()
        out.append((int(ts), s))
    out.sort(key=lambda x: x[0])
    return out


def gex_levels_of(snap):
    """All price levels a snapshot supplies (support+resistance arrays;
    walls are members of those arrays; gamma_flip added as its own level)."""
    levels = []
    for k in ('support', 'resistance'):
        for v in snap.get(k) or []:
            if v and v > 0:
                levels.append(float(v))
    gf = snap.get('gamma_flip')
    if gf and gf > 0:
        levels.append(float(gf))
    return levels


class AsOfFeed:
    """Generic at-or-before lookup over (stamp, payload) rows."""

    def __init__(self, rows, staleness_sec):
        self.stamps = [r[0] for r in rows]
        self.payloads = [r[1] for r in rows]
        self.cap = staleness_sec

    def at(self, t):
        i = bisect_right(self.stamps, t) - 1
        if i < 0:
            return None
        if t - self.stamps[i] > self.cap:
            return None
        return self.payloads[i]


def load_lt_feed():
    """Full LT feed -> sorted rows (epoch_sec, [levels...]). Sentiment column
    is BANNED and never read. 0/empty level = absent."""
    rows = []
    with open(LT_CSV, newline='') as f:
        r = csv.DictReader(f)
        for row in r:
            ts = int(row['unix_timestamp']) // 1000
            lv = []
            for i in range(1, 6):
                s = row[f'level_{i}']
                if s:
                    v = float(s)
                    if v > 0:
                        lv.append(v)
            rows.append((ts, lv))
    rows.sort(key=lambda x: x[0])
    return rows


# ---------------------------------------------------------------- tracking
MATCH_TOL = 10.0  # a level value within 10pt of a tracked one = same level
                  # (A2-01: feeds drift a few pts per update; 1pt fragments)
ARM_DIST = 25.0   # must be >=25pts away to (re)arm a touch


class Level:
    __slots__ = ('ident', 'value', 'born_ts', 'armed', 'side', 'touches',
                 'offsets')

    def __init__(self, ident, value, born_ts):
        self.ident = ident
        self.value = value
        self.born_ts = born_ts
        self.armed = {2: False, 5: False, 10: False}  # per touch-X threshold
        self.side = 0
        self.touches = {2: 0, 5: 0, 10: 0}
        self.offsets = {}   # draw index -> placebo offset


class LevelTracker:
    """Maintains level identities across as-of set updates (values drift a
    little snapshot-to-snapshot; within MATCH_TOL = same identity)."""

    def __init__(self, n_rand_draws=0, seed_prefix=''):
        self.levels = {}         # ident -> Level
        self._next = 0
        self.n_rand = n_rand_draws
        self.seed_prefix = seed_prefix

    def update(self, values, now_ts):
        """Reconcile with the latest as-of value set."""
        values = sorted(set(round(v * 4) / 4 for v in values))
        old = list(self.levels.values())
        used = set()
        new_map = {}
        for v in values:
            best, bd = None, MATCH_TOL + 1
            for lv in old:
                if lv.ident in used:
                    continue
                d = abs(lv.value - v)
                if d < bd:
                    best, bd = lv, d
            if best is not None and bd <= MATCH_TOL:
                used.add(best.ident)
                best.value = v
                new_map[best.ident] = best
            else:
                lv = Level(self._next, v, now_ts)
                self._next += 1
                if self.n_rand:
                    rng = random.Random(f'{self.seed_prefix}|{v:.2f}|{now_ts // 86400}')
                    for k in range(self.n_rand):
                        mag = rng.uniform(30, 120)
                        sign = 1 if rng.random() < 0.5 else -1
                        lv.offsets[k] = sign * mag
                new_map[lv.ident] = lv
        self.levels = new_map

    def reset_state(self):
        for lv in self.levels.values():
            lv.armed = {2: False, 5: False, 10: False}
            lv.side = 0
            lv.touches = {2: 0, 5: 0, 10: 0}


def bar_dist(bar, value):
    """Distance from bar's traded range to a level (0 if bar spans it)."""
    if bar['l'] > value:
        return bar['l'] - value
    if bar['h'] < value:
        return value - bar['h']
    return 0.0


def grid_values(px, step, span=250):
    """Round-number grid lines of `step` within +-span of px."""
    lo = int((px - span) // step) * step
    out = []
    v = lo
    while v <= px + span:
        if v > 0:
            out.append(float(v))
        v += step
    return out
