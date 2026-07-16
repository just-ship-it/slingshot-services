#!/usr/bin/env python3
"""FLIP-ANALOG stage 1b — emit engine-compatible flip CSVs for public detectors.

Same schema as the LS dumper file consumed by --ls-1m-file:
    timestamp_iso,unix_ms,state,source_symbol
timestamp = flip BAR OPEN minute (engine matches candle.timestamp exactly and
evaluates at that bar's close — identical knowability to the LS feed).
state = 1 bullish flip, 0 bearish flip.

Detectors (defaults only, defined in 05-flip-analog.py): Supertrend(10,3),
EMA 9x21 cross, sign(close-close[15]). Computed on the pilotfish minute library
(primary contract, raw prices), reset at contract roll with 60-bar warmup.

Output: research/vp-defended-wick/output/flips_{st,ema,drift}.csv
"""
import csv
from datetime import datetime, timezone

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
FEATS = [f'{BASE}/data/features/pilotfish_minute_features_2021-22.csv',
         f'{BASE}/data/features/pilotfish_minute_features.csv']
OUTD = f'{BASE}/research/vp-defended-wick/output'

import importlib.util
spec = importlib.util.spec_from_loader('det', loader=None)
# inline copy of the Detectors class from 05 (kept in sync by hand)
WARMUP = 60

class Detectors:
    def __init__(self):
        self.reset()

    def reset(self):
        self.n = 0
        self.ema9 = self.ema21 = self.atr = None
        self.prev_close = None
        self.closes = []
        self.st_upper = self.st_lower = None
        self.st_state = self.ema_state = self.drift_state = 0

    def update(self, o, h, l, c):
        flips = []
        self.n += 1
        tr = (h - l) if self.prev_close is None else max(h - l, abs(h - self.prev_close), abs(l - self.prev_close))
        self.atr = tr if self.atr is None else (self.atr * 9 + tr) / 10
        k9, k21 = 2 / 10, 2 / 22
        self.ema9 = c if self.ema9 is None else c * k9 + self.ema9 * (1 - k9)
        self.ema21 = c if self.ema21 is None else c * k21 + self.ema21 * (1 - k21)
        self.closes.append(c)
        if len(self.closes) > 16:
            self.closes.pop(0)
        hl2 = (h + l) / 2
        ub = hl2 + 3.0 * self.atr
        lb = hl2 - 3.0 * self.atr
        if self.st_upper is None:
            self.st_upper, self.st_lower = ub, lb
        else:
            self.st_upper = min(ub, self.st_upper) if (self.prev_close is not None and self.prev_close <= self.st_upper) else ub
            self.st_lower = max(lb, self.st_lower) if (self.prev_close is not None and self.prev_close >= self.st_lower) else lb
        st = self.st_state
        if st >= 0 and c < self.st_lower:
            st = -1
        elif st <= 0 and c > self.st_upper:
            st = 1
        elif st == 0:
            st = 1 if c > hl2 else -1
        ok = self.n > WARMUP
        if st != self.st_state:
            if ok and self.st_state != 0:
                flips.append(('st', st))
            self.st_state = st
        es = 1 if self.ema9 > self.ema21 else (-1 if self.ema9 < self.ema21 else self.ema_state)
        if es != self.ema_state:
            if ok and self.ema_state != 0:
                flips.append(('ema', es))
            self.ema_state = es
        if len(self.closes) == 16:
            d = self.closes[-1] - self.closes[0]
            ds = 1 if d > 0 else (-1 if d < 0 else self.drift_state)
            if ds != self.drift_state:
                if ok and self.drift_state != 0:
                    flips.append(('drift', ds))
                self.drift_state = ds
        self.prev_close = c
        return flips

outs = {}
for name in ('st', 'ema', 'drift'):
    f = open(f'{OUTD}/flips_{name}.csv', 'w', newline='')
    w = csv.writer(f)
    w.writerow(['timestamp_iso', 'unix_ms', 'state', 'source_symbol'])
    outs[name] = (f, w)

det = Detectors()
prev_sym = None
counts = {'st': 0, 'ema': 0, 'drift': 0}
for src in FEATS:
    with open(src) as f:
        rd = csv.reader(f)
        hdr = next(rd)
        ix = {c: i for i, c in enumerate(hdr)}
        for row in rd:
            sym = row[ix['symbol']]
            if sym != prev_sym:
                det.reset()
                prev_sym = sym
            try:
                o, h, l, c = (float(row[ix['open']]), float(row[ix['high']]),
                              float(row[ix['low']]), float(row[ix['close']]))
            except ValueError:
                continue
            for dname, s in det.update(o, h, l, c):
                ts_min = row[ix['ts_min']]
                ms = int(datetime.fromisoformat(ts_min + ':00+00:00').timestamp() * 1000)
                iso = ts_min + ':00.000Z'
                outs[dname][1].writerow([iso, ms, 1 if s > 0 else 0, 'NQ1!'])
                counts[dname] += 1
for f, _ in outs.values():
    f.close()
print(counts)
