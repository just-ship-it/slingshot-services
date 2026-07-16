#!/usr/bin/env python3
"""PILOTFISH Phase 0 — minute feature library from the 1s tape.

One sequential pass over NQ_ohlcv_1s.csv from 2023-01-02 (seek via the minute
index), primary contract only (per-minute symbol map from the causal-gex
screen), calendar spreads dropped. Emits one row per minute with the tape
signatures every PILOTFISH detector reads: signed pressure, travel, absorption,
directional run lengths. See research/pilotfish/PLAN.md.

Output: data/features/pilotfish_minute_features.csv
"""
import bisect
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
F1S = BASE / 'data/ohlcv/nq/NQ_ohlcv_1s.csv'
IDX = BASE / 'data/ohlcv/nq/NQ_ohlcv_1s.index.json'
PRIM = BASE / 'research/pilotfish/nq_1m_primary_2021-22.csv'
OUT = BASE / 'data/features/pilotfish_minute_features_2021-22.csv'
ET = ZoneInfo('America/New_York')
START_UTC = datetime(2021, 1, 17, tzinfo=timezone.utc)

primary = {}
with open(PRIM) as f:
    next(f)
    for line in f:
        ts, _, sym = line.rstrip('\n').split(',')
        primary[ts] = sym

idx = json.load(open(IDX))['minutes']
keys = sorted(int(k) for k in idx)
i0 = bisect.bisect_left(keys, int(START_UTC.timestamp() * 1000))
offset = idx[str(keys[i0])]['offset']

out = open(OUT, 'w', newline='')
w = csv.writer(out)
w.writerow(['ts_min', 'et_date', 'et_hhmm', 'dow', 'symbol',
            'open', 'high', 'low', 'close', 'volume', 'nbars',
            'svol_co', 'svol_tick', 'travel', 'range', 'drift',
            'absorption', 'maxrun_up', 'maxrun_dn', 'runvol_up', 'runvol_dn'])

_et_cache = {}


def et_fields(ts_min):
    """minute 'YYYY-MM-DDTHH:MM' UTC -> (et_date, et_hhmm, dow). Cache per hour."""
    hour_key = ts_min[:13]
    got = _et_cache.get(hour_key)
    if got is None:
        t = datetime.fromisoformat(ts_min[:13] + ':00:00+00:00').astimezone(ET)
        got = (t, t.strftime('%Y-%m-%d'), t.strftime('%H'), t.weekday())
        _et_cache.clear() if len(_et_cache) > 8 else None
        _et_cache[hour_key] = got
    t, d, hh, dow = got
    return d, hh + ':' + ts_min[14:16], dow


class MinuteAgg:
    __slots__ = ('o', 'h', 'l', 'c', 'v', 'n', 'svco', 'svtk', 'travel',
                 'prevc', 'rundir', 'runlen', 'runvol',
                 'mru', 'mrd', 'rvu', 'rvd')

    def __init__(self):
        self.o = None
        self.h = -1e18
        self.l = 1e18
        self.c = 0.0
        self.v = 0
        self.n = 0
        self.svco = 0.0
        self.svtk = 0.0
        self.travel = 0.0
        self.prevc = None
        self.rundir = 0
        self.runlen = 0
        self.runvol = 0
        self.mru = self.mrd = 0
        self.rvu = self.rvd = 0

    def add(self, o, h, l, c, v):
        if self.o is None:
            self.o = o
        if h > self.h:
            self.h = h
        if l < self.l:
            self.l = l
        self.c = c
        self.v += v
        self.n += 1
        if c > o:
            self.svco += v
        elif c < o:
            self.svco -= v
        if self.prevc is not None:
            d = c - self.prevc
            self.travel += d if d >= 0 else -d
            tick = 1 if d > 0 else -1 if d < 0 else 0
            if tick:
                self.svtk += v * tick
                if tick == self.rundir:
                    self.runlen += 1
                    self.runvol += v
                else:
                    self._closerun()
                    self.rundir, self.runlen, self.runvol = tick, 1, v
        self.prevc = c

    def _closerun(self):
        if self.rundir > 0 and self.runlen > self.mru:
            self.mru, self.rvu = self.runlen, self.runvol
        elif self.rundir < 0 and self.runlen > self.mrd:
            self.mrd, self.rvd = self.runlen, self.runvol

    def row(self, ts_min, sym):
        self._closerun()
        d, hhmm, dow = et_fields(ts_min)
        trav = self.travel
        absn = self.v / (trav if trav > 0.25 else 0.25)
        return [ts_min, d, hhmm, dow, sym,
                self.o, self.h, self.l, self.c, self.v, self.n,
                int(self.svco), int(self.svtk), round(trav, 2),
                round(self.h - self.l, 2), round(self.c - self.o, 2),
                round(absn, 1), self.mru, self.mrd, self.rvu, self.rvd]


cur_min = None
cur_sym = None
agg = None
rows = 0
skipped_nomap = 0

with open(F1S, 'rb') as f:
    f.seek(offset)
    END = '2023-01-01'
    for raw in f:
        if raw[:10].decode('ascii','replace') >= END:
            break
        line = raw.decode('ascii', 'replace')
        p = line.split(',')
        if len(p) < 10:
            continue
        sym = p[9].strip()
        if '-' in sym:
            continue
        ts_min = p[0][:16]
        if ts_min != cur_min:
            if agg is not None and agg.n:
                w.writerow(agg.row(cur_min, cur_sym))
                rows += 1
                if rows % 200000 == 0:
                    print(f'{rows} minutes... at {cur_min}', flush=True)
            cur_min = ts_min
            cur_sym = primary.get(ts_min)
            agg = MinuteAgg() if cur_sym else None
            if cur_sym is None:
                skipped_nomap += 1
        if agg is None or sym != cur_sym:
            continue
        try:
            agg.add(float(p[4]), float(p[5]), float(p[6]), float(p[7]),
                    int(p[8]))
        except ValueError:
            continue

if agg is not None and agg.n:
    w.writerow(agg.row(cur_min, cur_sym))
    rows += 1
out.close()
print(f'done: {rows} minute rows -> {OUT} ({skipped_nomap} minutes without primary map)')
