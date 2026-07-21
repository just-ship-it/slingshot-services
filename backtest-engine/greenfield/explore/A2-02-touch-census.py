#!/usr/bin/env python3
"""A2-02: touch-episode census — real levels vs placebos, identical machinery.

Level classes (all run through the SAME state machine):
  gex_real          - support[5]+resistance[5]+gamma_flip from causal GEX snapshots
  gex_rand0..2      - each GEX level identity shifted by a fixed random +-30..120pt
  lt_real           - LT feed level_1..5 (sentiment column never read)
  lt_rand0..2       - LT identities shifted the same way
  grid50, grid100   - round-number placebo: 50/100-pt grid lines near price

Touch definition: a level identity must first be ARMED by a 1m bar whose
traded range is >=25pts away from the level; the first subsequent bar whose
range comes within X pts (X in {2,5,10}, independent flags) fires a touch.
Approach direction = side of price while armed (+1 = approaching from below).

Knowability: bar OHLC used only at bar close (ts+60s); level sets joined
as-of <= bar-close with 45min staleness cap; forward outcomes measured
strictly from the touch bar's close onward. Roll days (multi-symbol) skipped.

Output: episodes.csv (one row per touch x X-threshold) for A2-03/04/05.
"""
import csv
import os
import statistics as st
from collections import defaultdict

from a2_common import (HERE, iter_et_days, load_gex_day, gex_levels_of,
                       load_lt_feed, AsOfFeed, LevelTracker, Level, bar_dist,
                       grid_values, ARM_DIST)

N_RAND = 3
STALE = 45 * 60
EP_OUT = os.path.join(HERE, 'episodes.csv')
VOL_CSV = os.path.join(HERE, 'vol_daily.csv')

FIELDS = ['date', 'class', 'X', 'ts', 'etmin', 'sym', 'level', 'dir',
          'touch_num', 'level_age_min', 'appr15', 'dist_same', 'dist_cross',
          'vol30',
          'fwd5', 'fwd15', 'fwd30', 'fwd60',
          'beyond30', 'beyond60', 'reject30', 'reject60',
          'race30', 'race60', 'raceV30']


# ------------------------------------------------------------ vol baseline
def load_vol_baseline():
    """date -> trailing-20-RTH-day median of absmove_30m_rth (strictly prior
    dates only; Sundays/holidays inherit the baseline, contribute nothing)."""
    rows = []
    with open(VOL_CSV, newline='') as f:
        for r in csv.DictReader(f):
            v = r.get('absmove_30m_rth') or ''
            rows.append((r['date'], float(v) if v else None))
    rows.sort()
    out = {}
    window = []
    for d, v in rows:
        if len(window) >= 5:
            out[d] = st.median(window[-20:])
        if v is not None:
            window.append(v)
    return out


# ------------------------------------------------------------ measurement
def measure(bars, i, level, dirn, vol30):
    """Forward outcomes from touch bar i's close. dirn=+1: approach from
    below (break = up through). Returns dict of outcome fields."""
    n = len(bars)
    anchor = bars[i]['c']
    out = {}
    for h in (5, 15, 30, 60):
        j = i + h
        if j < n and bars[j]['ts'] - bars[i]['ts'] <= h * 60 + 120 \
                and bars[j]['sym'] == bars[i]['sym']:
            out[f'fwd{h}'] = round(dirn * (bars[j]['c'] - anchor), 2)
        else:
            out[f'fwd{h}'] = ''
    beyond = reject = 0.0
    race30 = race60 = racev = ''
    thr = 10.0
    thrv = vol30 if vol30 else None
    prev_ts = bars[i]['ts']
    walked = 0
    for k in range(1, 61):
        j = i + k
        if j >= n or bars[j]['sym'] != bars[i]['sym'] \
                or bars[j]['ts'] - prev_ts > 300:
            break
        walked = k
        prev_ts = bars[j]['ts']
        b = bars[j]
        if dirn > 0:
            beyond = max(beyond, b['h'] - level)
            reject = max(reject, level - b['l'])
        else:
            beyond = max(beyond, level - b['l'])
            reject = max(reject, b['h'] - level)
        if race60 == '':
            brk, bnc = beyond >= thr, reject >= thr
            if brk or bnc:
                res = 'both' if (brk and bnc) else ('break' if brk else 'bounce')
                race60 = res
                if k <= 30 and race30 == '':
                    race30 = res
        if k == 30:
            out['beyond30'] = round(max(beyond, 0), 2)
            out['reject30'] = round(max(reject, 0), 2)
        if racev == '' and thrv and k <= 30:
            brk, bnc = beyond >= thrv, reject >= thrv
            if brk or bnc:
                racev = 'both' if (brk and bnc) else ('break' if brk else 'bounce')
    out.setdefault('beyond30', '')
    out.setdefault('reject30', '')
    out['beyond60'] = round(max(beyond, 0), 2) if walked >= 60 else ''
    out['reject60'] = round(max(reject, 0), 2) if walked >= 60 else ''
    # unresolved race = 'none' only if the full window was observable
    out['race30'] = race30 if race30 else ('none' if walked >= 30 else '')
    out['race60'] = race60 if race60 else ('none' if walked >= 60 else '')
    if racev:
        out['raceV30'] = racev
    else:
        out['raceV30'] = 'none' if (thrv and walked >= 30) else ''
    return out


# ------------------------------------------------------------ per-day engine
class DayEngine:
    def __init__(self, date, bars, gex_snaps, lt_feed, vol30, writer, counts):
        self.date, self.bars, self.vol30 = date, bars, vol30
        self.writer, self.counts = writer, counts
        self.gex_feed = AsOfFeed(gex_snaps, STALE) if gex_snaps else None
        self.lt_feed = lt_feed
        self.trk = {'gex_real': LevelTracker(N_RAND, f'gex|{date}'),
                    'lt_real': LevelTracker(N_RAND, f'lt|{date}'),
                    'grid50': LevelTracker(0), 'grid100': LevelTracker(0)}
        for k in range(N_RAND):
            self.trk[f'gex_rand{k}'] = LevelTracker(0)
            self.trk[f'lt_rand{k}'] = LevelTracker(0)
        self._last_gex = self._last_lt = object()

    def sync_levels(self, i, tknow):
        b = self.bars[i]
        if self.gex_feed:
            snap = self.gex_feed.at(tknow)
            if snap is not self._last_gex:
                self._last_gex = snap
                vals = gex_levels_of(snap) if snap else []
                self._update_family('gex', vals, b['ts'])
        payload = self.lt_feed.at(tknow)
        if payload is not self._last_lt:
            self._last_lt = payload
            self._update_family('lt', payload or [], b['ts'])
        if i % 15 == 0:
            px = b['c']
            self.trk['grid50'].update(grid_values(px, 50), b['ts'])
            self.trk['grid100'].update(grid_values(px, 100), b['ts'])

    def _update_family(self, fam, vals, ts):
        real = self.trk[f'{fam}_real']
        real.update(vals, ts)
        for k in range(N_RAND):
            pv = [lv.value + lv.offsets[k] for lv in real.levels.values()]
            self.trk[f'{fam}_rand{k}'].update(pv, ts)

    def run(self):
        bars = self.bars
        for i, b in enumerate(bars):
            tknow = b['ts'] + 60
            self.sync_levels(i, tknow)
            if i == 0 or b['ts'] - bars[i - 1]['ts'] > 300:
                for t in self.trk.values():
                    t.reset_state()   # gap: stale armed state is unsafe
                continue
            for cls, trk in self.trk.items():
                for lv in trk.levels.values():
                    d = bar_dist(b, lv.value)
                    if d >= ARM_DIST:
                        lv.armed = {2: True, 5: True, 10: True}
                        lv.side = 1 if b['c'] < lv.value else -1
                        continue
                    for X in (10, 5, 2):
                        if lv.armed[X] and d <= X:
                            lv.armed[X] = False
                            lv.touches[X] += 1
                            self.fire(cls, X, i, lv)

    def fire(self, cls, X, i, lv):
        b = self.bars[i]
        dirn = lv.side
        if dirn == 0:
            return
        m = measure(self.bars, i, lv.value, dirn, self.vol30)
        appr = ''
        if i >= 15 and b['ts'] - self.bars[i - 15]['ts'] <= 16 * 60:
            appr = round(dirn * (b['c'] - self.bars[i - 15]['c']), 2)
        others = [o.value for o in self.trk[cls].levels.values()
                  if o.ident != lv.ident]
        dist_same = round(min(abs(lv.value - v) for v in others), 2) if others else ''
        dist_cross = ''
        if cls == 'gex_real' and self.trk['lt_real'].levels:
            dist_cross = round(min(abs(lv.value - o.value)
                               for o in self.trk['lt_real'].levels.values()), 2)
        elif cls == 'lt_real' and self.trk['gex_real'].levels:
            dist_cross = round(min(abs(lv.value - o.value)
                               for o in self.trk['gex_real'].levels.values()), 2)
        row = {'date': self.date, 'class': cls, 'X': X, 'ts': b['ts'],
               'etmin': b['etmin'], 'sym': b['sym'],
               'level': round(lv.value, 2), 'dir': dirn,
               'touch_num': lv.touches[X],
               'level_age_min': int((b['ts'] - lv.born_ts) / 60),
               'appr15': appr, 'dist_same': dist_same,
               'dist_cross': dist_cross,
               'vol30': self.vol30 if self.vol30 else ''}
        row.update(m)
        self.writer.writerow(row)
        self.counts[cls, X] += 1


def main():
    import sys
    start = sys.argv[1] if len(sys.argv) > 1 else '0000'
    end = sys.argv[2] if len(sys.argv) > 2 else '9999'
    out = EP_OUT if len(sys.argv) <= 3 else sys.argv[3]
    vol = load_vol_baseline()
    lt_rows = load_lt_feed()
    lt_feed = AsOfFeed(lt_rows, STALE)
    counts = defaultdict(int)
    n_days = n_skip_roll = 0
    with open(out, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for date, bars in iter_et_days():
            if not (start <= date <= end):
                continue
            if len(set(b['sym'] for b in bars)) > 1:
                n_skip_roll += 1
                continue
            gex_snaps = load_gex_day(date)
            n_days += 1
            eng = DayEngine(date, bars, gex_snaps, lt_feed,
                            vol.get(date), w, counts)
            eng.run()
    print(f'days processed={n_days} roll days skipped={n_skip_roll}')
    for (cls, X), n in sorted(counts.items()):
        print(f'  {cls:10s} X={X:2d}: {n}')


if __name__ == '__main__':
    main()
