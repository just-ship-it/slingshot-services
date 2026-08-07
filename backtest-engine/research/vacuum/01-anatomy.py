#!/usr/bin/env python3
"""Liquidity-vacuum anatomy — Drew's theory (2026-07-23): large 1m NQ moves (40..100+ pts) are made
by THIN BOOKS (pulled quotes), not just volume. Phase 1 uses 1s OHLCV only (volume-based fingerprint):

  impact = points of price path per 1000 contracts traded. A vacuum move traverses many points on
  LITTLE volume (high impact); a volume-driven move has normal impact on huge volume.

Per event (|1m close-open| >= 40pt, tiers 40/60/80/100), from 1s bars:
  - event minute: range, |move|, volume, path length (sum |dClose|), impact
  - pre-window (prior 120s): volume, path, impact, drift  (PRECURSOR question: does impact rise
    or volume dry up BEFORE the big candle?)
  - forward returns +60/300/900s in move direction (REVERT-vs-CONTINUE conditioned on impact —
    the tradable hook: thin-book moves should snap back, real-flow moves should stick)
Controls: 5 seeded random same-TOD minutes with |move| < 10pt from other days, identical measurement.
Window: 2025-01-13..2026-01-23 (matches MBP-1/MBO coverage for phase 2). All sessions, tagged.
Output: events.csv / controls.csv
"""
import bisect
import csv
import json
import random
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
ET = ZoneInfo('America/New_York')
PRIM1M = BASE / 'research/causal-gex-screen/nq_1m_primary_ohlc.csv'
S1S = BASE / 'data/ohlcv/nq/NQ_ohlcv_1s.csv'
S1IDX = BASE / 'data/ohlcv/nq/NQ_ohlcv_1s.index.json'
WIN_START, WIN_END = '2025-01-13', '2026-01-23'
EVENT_MIN = 40.0
CONTROL_MAX = 10.0
PRE_S = 120
RNG = random.Random(20260723)


def to_ms(iso):
    return int(datetime.strptime(iso, '%Y-%m-%dT%H:%M').replace(tzinfo=timezone.utc).timestamp() * 1000)


def session_of(ms):
    dt = datetime.fromtimestamp(ms / 1000, ET)
    em = dt.hour * 60 + dt.minute
    if 570 <= em < 960:
        s = 'rth'
    elif 240 <= em < 570:
        s = 'premarket'
    elif 960 <= em < 1080:
        s = 'afterhours'
    else:
        s = 'overnight'
    return s, em, dt.strftime('%Y-%m-%d')


class S1:
    def __init__(self):
        idx = json.load(open(S1IDX))
        self.minutes = idx['minutes']
        self.keys = sorted(int(k) for k in self.minutes)
        self.f = open(S1S, 'rb')

    def read(self, mkey, sym):
        m = self.minutes.get(str(mkey))
        if not m:
            return []
        self.f.seek(m['offset'])
        out = []
        for line in self.f.read(m['length']).decode('utf-8', 'replace').split('\n'):
            p = line.split(',')
            if len(p) < 10 or p[9].strip() != sym:
                continue
            try:
                out.append((p[0], float(p[4]), float(p[5]), float(p[6]), float(p[7]), float(p[8])))
            except ValueError:
                continue
        return out

    def window(self, ms0, ms1, sym):
        """all 1s bars with minute-key in [ms0, ms1)"""
        rows = []
        j = bisect.bisect_left(self.keys, ms0)
        while j < len(self.keys) and self.keys[j] < ms1:
            rows.extend(self.read(self.keys[j], sym))
            j += 1
        return rows


def seg_stats(rows):
    """volume, path length, range, net move from a list of 1s bars."""
    if not rows:
        return None
    vol = sum(r[5] for r in rows)
    closes = [r[4] for r in rows]
    path = sum(abs(closes[k] - closes[k - 1]) for k in range(1, len(closes)))
    hi = max(r[2] for r in rows); lo = min(r[3] for r in rows)
    return dict(vol=vol, path=round(path, 2), range=round(hi - lo, 2),
                net=round(closes[-1] - rows[0][1], 2), n=len(rows))


def measure(s1, ms, sym):
    """event/control minute at ms: pre 120s, the minute itself, forward 60/300/900s."""
    ev = s1.window(ms, ms + 60000, sym)
    if not ev or len(ev) < 20:
        return None
    pre = s1.window(ms - PRE_S * 1000, ms, sym)
    e = seg_stats(ev)
    p = seg_stats(pre) or dict(vol=0, path=0, range=0, net=0, n=0)
    entry = ev[-1][4]   # close of the event minute
    fwd = {}
    for horizon in (60, 300, 900):
        rows = s1.window(ms + 60000, ms + 60000 + horizon * 1000, sym)
        fwd[f'fwd{horizon}'] = round(rows[-1][4] - entry, 2) if rows else ''
    imp = e['path'] / e['vol'] * 1000 if e['vol'] else ''
    imp_pre = p['path'] / p['vol'] * 1000 if p['vol'] else ''
    return dict(ev_vol=e['vol'], ev_path=e['path'], ev_range=e['range'], ev_net=e['net'],
                impact=round(imp, 3) if imp != '' else '',
                pre_vol=p['vol'], pre_path=p['path'], pre_net=p['net'],
                impact_pre=round(imp_pre, 3) if imp_pre != '' else '', **fwd)


def main():
    bars = []
    with open(PRIM1M) as f:
        r = csv.reader(f); next(r)
        for row in r:
            if row[0][:10] < WIN_START or row[0][:10] > WIN_END:
                continue
            bars.append((to_ms(row[0]), float(row[1]), float(row[2]), float(row[3]), float(row[4]), row[5]))
    bars.sort()
    print(f'{len(bars)} 1m bars', flush=True)

    events = [(i, b) for i, b in enumerate(bars) if abs(b[4] - b[1]) >= EVENT_MIN]
    print(f'{len(events)} event candles |move|>={EVENT_MIN}', flush=True)

    # controls: same TOD (minute-of-day), |move|<10, other days, 5 per event
    by_tod = {}
    for i, b in enumerate(bars):
        s, em, date = session_of(b[0])
        if abs(b[4] - b[1]) < CONTROL_MAX:
            by_tod.setdefault(em, []).append(i)

    s1 = S1()
    out_e, out_c = [], []
    for k, (i, b) in enumerate(events):
        ms, o, h, l, c, sym = b
        s, em, date = session_of(ms)
        m = measure(s1, ms, sym)
        if not m:
            continue
        direction = 1 if c > o else -1
        out_e.append(dict(date=date, tod=em, session=s, sym=sym, move=round(c - o, 2),
                          dir=direction, tier=(40 if abs(c-o) < 60 else 60 if abs(c-o) < 80 else 80 if abs(c-o) < 100 else 100),
                          **m))
        pool = [j for j in by_tod.get(em, []) if bars[j][0] // 86400000 != ms // 86400000]
        for j in RNG.sample(pool, min(5, len(pool))):
            cb = bars[j]
            cm = measure(s1, cb[0], cb[5])
            if cm:
                _, _, cdate = session_of(cb[0])
                out_c.append(dict(date=cdate, tod=em, session=s, sym=cb[5],
                                  move=round(cb[4] - cb[1], 2), dir=0, tier=0, **cm))
        if k % 100 == 0:
            print(f'  {k}/{len(events)} events done', flush=True)

    for name, rows in (('events', out_e), ('controls', out_c)):
        fp = BASE / f'research/vacuum/{name}.csv'
        with open(fp, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader(); w.writerows(rows)
        print(f'{name}: {len(rows)} -> {fp}', flush=True)


if __name__ == '__main__':
    main()
