#!/usr/bin/env python3
"""FLIP-ANALOG — is LSTB's edge in the LS signal or in the trade architecture?

Runs the EXACT LSTB v3-live trade architecture on public price-only 1m flip
detectors, 1s-honest, 2021->2026:

  architecture (mirrors ls-flip-trigger-bar v3 plain no-BE, live config):
    trigger bar   = 1m bar on which detector state flips
    direction     = LONG on flip to bullish, SHORT on flip to bearish
    min-range     = trigger bar range >= 3pt else skip
    blocked hours = {0,5,16,17,18,19,20,21,22,23} ET (live set)
    entry         = limit at fib 0.5 of trigger bar (long: high-0.5*range,
                    rounded down to tick; short: low+0.5*range rounded up),
                    TTL 600s (10 x 1m bars)
    exits         = fixed +15pt target (limit) / -12pt stop (market, 1.5 slip),
                    same-1s-bar tie -> loss; EOD 15:45 ET flat (1.0 slip)
    commission    = 0.2pt/RT ($4 NQ); single slot; pending cancelled on new day

  detectors (default params only, no sweep — multiplicity control):
    st    Supertrend(10, 3.0) state flip        (ATR channel regime)
    ema   EMA(9) x EMA(21) cross                (MA regime)
    drift sign(close - close[15]) flip          (momentum sign)

  Signals from data/features/pilotfish_minute_features*.csv (primary contract,
  2021-01-17->2026-06-15). Indicators RESET at contract roll (60-bar warmup,
  no signals during warmup) — raw-contract price space, no roll contamination.

Benchmark: LSTB v3 plain no-BE full-window gold = 13,049tr / $480,820 /
PF 1.31 / Sharpe 8.79 / all 12 quarters positive (2023-07->2026-06; LS data
walls there — these detectors have no such wall).

Usage: python3 05-flip-analog.py [--start 2021-01-19] [--end 2026-06-15]
"""
import csv
import io
import json
import os
import sys
import bisect as _bis
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

import pandas as pd

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
F1S = f'{BASE}/data/ohlcv/nq/NQ_ohlcv_1s.csv'
PROF = f'{BASE}/research/vp-defended-wick/output/nq_daily_profiles.csv'
FEATS = [f'{BASE}/data/features/pilotfish_minute_features_2021-22.csv',
         f'{BASE}/data/features/pilotfish_minute_features.csv']
ET = ZoneInfo('America/New_York')

def argval(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

START = argval('--start', '2021-01-19')
INVERT = '--invert' in sys.argv
ADV_MODE = argval('--adv-mode', 'close')  # close (honest) | stamp (engine-like, -60s) | off
ADV_X = float(argval('--adv-x', '-1'))    # >=0: cancel at stamp+X seconds (overrides adv-mode)
MKT_ENTRY = '--market-entry' in sys.argv   # enter at market on signal (no pending limit)
END = argval('--end', '2026-06-15')

T_PT = 15.0
S_PT = 12.0
MIN_RANGE = 3.0
FIB = 0.5
TTL_S = 600
MAX_HOLD_S = 3600         # maxHoldBars 60 x 1m (strategy default)
# v3 preset blocked set (the $480k full-window gold predates the block-0 deploy)
BLOCKED = {5, 16, 17, 18, 19, 20, 21, 22, 23}
EOD_ET = (15, 45)
STOP_SLIP = 1.5
MKT_SLIP = 1.0
COMM = 0.2
WARMUP = 60

# ---------------- stage 1: signals from the 1m library ----------------
print('stage 1: computing flip signals from minute library ...', flush=True)

class Detectors:
    """Streaming detectors; reset() on contract roll."""
    def __init__(self):
        self.reset()

    def reset(self):
        self.n = 0
        self.ema9 = None
        self.ema21 = None
        self.atr = None          # RMA ATR(10)
        self.atr20 = None        # SMA ATR(20) for the cb_atr noise filter
        self.tr20 = []
        self.prev_close = None
        self.closes = []         # last 16 closes for drift15
        self.st_upper = None
        self.st_lower = None
        self.st_state = 0        # 1 bull, -1 bear
        self.ema_state = 0
        self.drift_state = 0

    def update(self, o, h, l, c):
        """returns list of (detector, new_state) flips at this bar close."""
        flips = []
        self.n += 1
        tr = (h - l) if self.prev_close is None else max(h - l, abs(h - self.prev_close), abs(l - self.prev_close))
        self.atr = tr if self.atr is None else (self.atr * 9 + tr) / 10
        # SMA ATR(20) with full warmup — mirrors ls-flip-trigger-bar._updateAtr
        self.tr20.append(tr)
        if len(self.tr20) > 20:
            self.tr20.pop(0)
        self.atr20 = sum(self.tr20) / 20 if len(self.tr20) == 20 else None
        k9, k21 = 2 / 10, 2 / 22
        self.ema9 = c if self.ema9 is None else c * k9 + self.ema9 * (1 - k9)
        self.ema21 = c if self.ema21 is None else c * k21 + self.ema21 * (1 - k21)
        self.closes.append(c)
        if len(self.closes) > 16:
            self.closes.pop(0)
        # supertrend
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

# LS 1m flips (control arm: the REAL LSTB signal through this same harness).
# Dumper stamps the flip bar's OPEN minute; state is knowable at bar CLOSE,
# which is exactly how signals are timed below (ts_min close + 60s).
LS_MAP = {}
ls_path = f'{BASE}/research/lt-extraction/output/nq_ls_1m_raw.csv'
with open(ls_path) as f:
    next(f)
    for line in f:
        p = line.rstrip('\n').split(',')
        LS_MAP[p[0][:16]] = 1 if p[2] == '1' else -1

signals = defaultdict(list)   # et_date -> [(epoch_close, det, dir, limit_px, sym, next_flip_ts)]
raw_flips = defaultdict(list)  # det -> [epoch of EVERY flip, unfiltered] for adverse-cancel
nsig = {'st': 0, 'ema': 0, 'drift': 0, 'ls': 0}
det = Detectors()
prev_sym = None
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
            flips = det.update(o, h, l, c)
            ls_dir = LS_MAP.get(row[ix['ts_min']][:16])
            if ls_dir is not None:
                flips = flips + [('ls', ls_dir)]
            if not flips:
                continue
            date = row[ix['et_date']]
            ts = datetime.fromisoformat(row[ix['ts_min']] + ':00+00:00').timestamp() + 60  # flip knowable at bar CLOSE
            for dname, s in flips:
                raw_flips[dname].append(ts)
            if not (START <= date <= END):
                continue
            hh = int(row[ix['et_hhmm']][:2])
            mm = int(row[ix['et_hhmm']][3:5])
            if hh in BLOCKED:
                continue
            if hh > EOD_ET[0] or (hh == EOD_ET[0] and mm >= EOD_ET[1] - 10):
                continue                      # no fresh signals within 10m of EOD flat
            rng = h - l
            if rng < MIN_RANGE:
                continue
            # LSTB noise filter: reject big-body momentum flips (body/ATR20 >= 1.81).
            # ATR must be warm (engine rejects signals otherwise).
            if det.atr20 is None or abs(c - o) / det.atr20 >= 1.81:
                continue
            for dname, s in flips:
                if INVERT:
                    s = -s
                px = (h - FIB * rng) if s > 0 else (l + FIB * rng)
                px = round(px / 0.25) * 0.25              # nearest tick (engine convention)
                signals[date].append((ts, dname, s, px, sym, None))
                nsig[dname] += 1

# adverse-flip cancel ts = next RAW flip of the same detector (engine convention:
# every LS row is a state change; the loader precomputes next-record ts)
for dname in raw_flips:
    raw_flips[dname].sort()
for date in signals:
    upd = []
    for (ts, dname, s, px, sym, _) in signals[date]:
        arr = raw_flips[dname]
        j = _bis.bisect_right(arr, ts)
        nxt = arr[j] if j < len(arr) else float('inf')
        if ADV_X >= 0:
            nxt = nxt - 60 + ADV_X   # cancel at stamp+X seconds (X=0 engine-like, X=60 honest close)
        elif ADV_MODE == 'stamp':
            nxt -= 60          # engine adverseFlipCancelTs = next flip BAR OPEN (60s before knowable)
        elif ADV_MODE == 'off':
            nxt = float('inf') # live orchestrator: no adverse-cancel handler at all
        upd.append((ts, dname, s, px, sym, nxt))
    signals[date] = upd

print(f'signals: {nsig}', flush=True)

# ---------------- stage 2: 1s-honest execution ----------------
prof = {}
dates = []
with open(PROF) as f:
    for r in csv.DictReader(f):
        prof[r['et_date']] = r
        dates.append(r['et_date'])

_et = {}
def et_info(ts13):
    v = _et.get(ts13)
    if v is None:
        t = datetime.fromisoformat(ts13 + ':00:00+00:00')
        loc = t.astimezone(ET)
        if len(_et) > 8:
            _et.clear()
        v = (loc.strftime('%Y-%m-%d'), loc.hour, loc.minute, int(t.timestamp()))
        _et[ts13] = v
    return v

IDX = json.load(open(F1S.replace('.csv', '.index.json')))['minutes']
idx_keys = sorted(int(k) for k in IDX)
fsize = os.path.getsize(F1S)
COLS = ['ts_event', 'rtype', 'publisher_id', 'instrument_id', 'open', 'high', 'low', 'close', 'volume', 'symbol']

def byte_range(a, b):
    i = _bis.bisect_right(idx_keys, a) - 1
    j = _bis.bisect_left(idx_keys, b)
    return (IDX[str(idx_keys[max(i, 0)])]['offset'],
            IDX[str(idx_keys[j])]['offset'] if j < len(idx_keys) else fsize)

trades = defaultdict(list)   # det -> [dict]

def run_day(day, sigs, T, H, L, C, MINET):
    """MINET = (hour, minute) ET per bar. sigs sorted by ts."""
    n = len(T)
    eod_i = n - 1
    for k in range(n):
        if MINET[k] >= (15, 45):
            eod_i = k
            break
    for dname in ('st', 'ema', 'drift', 'ls'):
        ds = [s for s in sigs if s[1] == dname]
        si = 0
        state = 'flat'
        entry = d = lim = 0
        e_ts = ttl = 0
        adv = float('inf')
        for i in range(n):
            ts = T[i]
            if i >= eod_i:
                if state == 'open':
                    trades[dname].append({'date': day, 'sig_ts': sig_ts, 'lim': lim, 'e_ts': e_ts, 'x_ts': ts, 'dir': d,
                                          'pnl': (C[i] - entry) * d - MKT_SLIP - COMM, 'r': 'eod'})
                state = 'done'
            if state == 'done':
                break
            if state == 'open':
                tgt = entry + d * T_PT
                stp = entry - d * S_PT
                hit_s = (L[i] <= stp) if d > 0 else (H[i] >= stp)
                hit_t = (H[i] >= tgt) if d > 0 else (L[i] <= tgt)
                if hit_s:
                    trades[dname].append({'date': day, 'sig_ts': sig_ts, 'lim': lim, 'e_ts': e_ts, 'x_ts': ts, 'dir': d,
                                          'pnl': -(S_PT + STOP_SLIP) - COMM, 'r': 'stop'})
                    state = 'flat'
                elif hit_t:
                    trades[dname].append({'date': day, 'sig_ts': sig_ts, 'lim': lim, 'e_ts': e_ts, 'x_ts': ts, 'dir': d,
                                          'pnl': T_PT - COMM, 'r': 'target'})
                    state = 'flat'
                elif ts - e_ts >= MAX_HOLD_S:
                    trades[dname].append({'date': day, 'sig_ts': sig_ts, 'lim': lim, 'e_ts': e_ts, 'x_ts': ts, 'dir': d,
                                          'pnl': (C[i] - entry) * d - MKT_SLIP - COMM, 'r': 'maxhold'})
                    state = 'flat'
            elif state == 'pending':
                # adverse-flip cancel: the next RAW flip of this detector
                # invalidates the pending thesis (engine adverseFlipCancelTs)
                if ts >= adv:
                    state = 'flat'
                elif ts > ttl:
                    state = 'flat'
                else:
                    filled = (L[i] <= lim) if d > 0 else (H[i] >= lim)
                    tgt = lim + d * T_PT
                    stp = lim - d * S_PT
                    ext_t = (H[i] >= tgt) if d > 0 else (L[i] <= tgt)
                    ext_s = (L[i] <= stp) if d > 0 else (H[i] >= stp)
                    if not filled and (ext_t or ext_s):
                        # pre-fill invalidation (cancelOnPreFillExtreme)
                        state = 'flat'
                    elif filled:
                        entry = lim
                        e_ts = ts
                        state = 'open'
                        if ext_s:                     # same-bar breach -> loss (conservative)
                            trades[dname].append({'date': day, 'sig_ts': sig_ts, 'lim': lim, 'e_ts': ts, 'x_ts': ts, 'dir': d,
                                                  'pnl': -(S_PT + STOP_SLIP) - COMM, 'r': 'stop'})
                            state = 'flat'
            if state == 'flat' and si < len(ds) and ds[si][0] <= ts:
                # take newest eligible signal (skip stale ones while busy)
                while si < len(ds) and ds[si][0] <= ts:
                    sig = ds[si]
                    si += 1
                d = sig[2]
                lim = sig[3]
                sig_ts = sig[0]
                ttl = sig[0] + TTL_S
                adv = sig[5]
                if MKT_ENTRY:
                    if ts - sig_ts <= 90:      # skip stale signals
                        entry = C[i] + d * MKT_SLIP
                        e_ts = ts
                        state = 'open'
                elif ts <= ttl and ts < adv:
                    state = 'pending'

fh = open(F1S, 'rb')
t0 = datetime.now()
run_dates = [dd for dd in dates if START <= dd <= END and dd in signals]
for di, day in enumerate(run_dates):
    psym = prof[day]['symbol']
    sigs = sorted([s for s in signals[day] if s[4] == psym])
    if not sigs:
        continue
    d0 = datetime.fromisoformat(day + 'T00:00:00').replace(tzinfo=ET)
    a = int(d0.timestamp() * 1000)
    off_a, off_b = byte_range(a, a + 86400_000)
    if off_b <= off_a:
        continue
    fh.seek(off_a)
    df = pd.read_csv(io.BytesIO(fh.read(off_b - off_a)), names=COLS, header=None,
                     usecols=['ts_event', 'high', 'low', 'close', 'symbol'],
                     dtype={'high': 'f8', 'low': 'f8', 'close': 'f8'},
                     engine='c', on_bad_lines='skip')
    df = df[df['symbol'] == psym]
    if df.empty:
        continue
    ts_s = df['ts_event'].tolist()
    T, MINET, keep = [], [], []
    for k, s in enumerate(ts_s):
        ed, eh, em0, he = et_info(s[:13])
        if ed != day:
            continue
        keep.append(k)
        T.append(he + int(s[14:16]) * 60 + int(s[17:19]))
        # ET offset is whole hours, so minute-of-hour is the UTC minute
        MINET.append((eh, int(s[14:16])))
    sub = df.iloc[keep]
    run_day(day, sigs, T, sub['high'].tolist(), sub['low'].tolist(), sub['close'].tolist(), MINET)
    if di % 200 == 0:
        print(f'  {day} ({di+1}/{len(run_dates)}) st={len(trades["st"])} ema={len(trades["ema"])} drift={len(trades["drift"])} ({(datetime.now()-t0).total_seconds():.0f}s)', flush=True)

# ---------------- report ----------------
for dname in ('st', 'ema', 'drift', 'ls'):
    tl = trades[dname]
    if not tl:
        print(f'\n=== {dname}: no trades ===')
        continue
    df = pd.DataFrame(tl)
    df['usd'] = df['pnl'] * 20
    df['year'] = df['date'].str[:4]
    wins = df[df.pnl > 0]
    pf = wins.pnl.sum() / max(1e-9, -df[df.pnl <= 0].pnl.sum())
    daily = df.groupby('date')['usd'].sum()
    sh = daily.mean() / max(1e-9, daily.std()) * (252 ** 0.5)
    eq = daily.cumsum()
    dd = (eq - eq.cummax()).min()
    print(f'\n=== {dname}: n={len(df)} WR={len(wins)/len(df):.1%} PF={pf:.2f} '
          f'PnL=${df.usd.sum():+,.0f} Sh={sh:.2f} maxDD=${-dd:,.0f} ===')
    for y, g in df.groupby('year'):
        gpf = g[g.pnl > 0].pnl.sum() / max(1e-9, -g[g.pnl <= 0].pnl.sum())
        print(f'  {y}: n={len(g):>5} WR={(g.pnl>0).mean():.0%} PF={gpf:.2f} PnL=${g.usd.sum():+,.0f}')
    df.to_csv(f'{BASE}/research/vp-defended-wick/output/flip_analog_{dname}.csv', index=False)
print(f'\ndone {(datetime.now()-t0).total_seconds():.0f}s')
