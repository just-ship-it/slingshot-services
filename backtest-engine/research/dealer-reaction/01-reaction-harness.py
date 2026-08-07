#!/usr/bin/env python3
"""Dealer-reaction harness — Drew's spec (2026-07-23).

Trade archetype:
  1. A candidate LEVEL is TOUCHED (1m bar range contains it), approached from one side.
  2. Wait for the containing 3m OR 5m candle to CLOSE (dealer algos engage at the close;
     filters out getting run over while price blows through).
  3. Classify by where the confirming candle CLOSED, relative to the level + approach side:
       closes back on the ORIGIN side  -> REJECTED -> FADE  (ride rejection away from level)
       closes THROUGH the level        -> ACCEPTED -> BREAKOUT (go with the break)
  4. Enter at the confirming candle's close; walk 1s bars forward (max-hold 30m, EOD cut 15:45 ET,
     rollover cut) to get MFE/MAE + first-passage (target before stop) + realized BE-trail PnL.
  Success metric = P(MFE>=20 before stop) and realized expectancy — NOT mean forward return.

Levels are CAUSAL (snapshot at-or-before the touch), raw-contract NQ space. Placebo families
(round-100 + seeded-random) run through the IDENTICAL machinery — a real level must beat them.

Usage: python3 01-reaction-harness.py <family> [start_date]
  family: gex | lt | priorday | placebo_round | placebo_rand
Output: research/dealer-reaction/events_<family>.csv
"""
import bisect
import csv
import glob
import json
import os
import random
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
ET = ZoneInfo('America/New_York')
PRIM1M = BASE / 'research/causal-gex-screen/nq_1m_primary_ohlc.csv'
S1S = BASE / 'data/ohlcv/nq/NQ_ohlcv_1s.csv'
S1IDX = BASE / 'data/ohlcv/nq/NQ_ohlcv_1s.index.json'
WIN_START = os.environ.get('WIN_START', '2025-01-13')   # causal GEX coverage start
WIN_END = os.environ.get('WIN_END', '2026-06-16')
TOUCH_ZONE = 3.0           # pts: bar must come within this of the level to count as a touch
REARM = 20.0               # pts: price must leave by this before the level can re-trigger
MAXHOLD_S = 30 * 60        # 30-min max hold
EOD_ET = 15 * 60 + 45      # 15:45 ET cut
STOP_SLIP = 1.5
STOPS = [8, 10, 12, 15]
TARGET = 20.0
BE_TRIG, INIT_STOP, TRAIL_GAP = 15.0, 10.0, 10.0
RNG = random.Random(20260723)


# ---------------- data loading ----------------
def to_ms(iso):
    # "2025-06-06T14:00" (UTC, no seconds) -> epoch ms
    return int(datetime.strptime(iso, '%Y-%m-%dT%H:%M').replace(tzinfo=timezone.utc).timestamp() * 1000)


def et_min_of(ms):
    dt = datetime.fromtimestamp(ms / 1000, ET)
    return dt.hour * 60 + dt.minute, dt.strftime('%Y-%m-%d')


def load_1m():
    bars = []
    with open(PRIM1M) as f:
        r = csv.reader(f); next(r)
        for row in r:
            ts = row[0]
            if ts[:10] < WIN_START or ts[:10] > WIN_END:
                continue
            bars.append((to_ms(ts), float(row[1]), float(row[2]), float(row[3]), float(row[4]), row[5]))
    bars.sort()
    return bars


def bucket_ohlc(bars, n):
    """N-min bucket -> dict(open,high,low,close,close_ts,sym,prange). prange = prior same-tf bucket range."""
    span = n * 60000
    b = {}
    for ms, o, h, l, c, sym in bars:
        bs = (ms // span) * span
        if bs not in b:
            b[bs] = dict(open=o, high=h, low=l, close=c, close_ts=bs + span, sym=sym)
        else:
            d = b[bs]
            d['high'] = max(d['high'], h); d['low'] = min(d['low'], l)
            d['close'] = c; d['sym'] = sym   # last 1m close/sym in bucket
    starts = sorted(b)
    for i, bs in enumerate(starts):
        prev = b[starts[i - 1]] if i > 0 else None
        b[bs]['prange'] = (prev['high'] - prev['low']) if prev else None
    return b


def atr14(bars):
    """rolling 14-bar 1m ATR (mean high-low) per bar index."""
    out = [None] * len(bars)
    win = []
    for i, (ms, o, h, l, c, sym) in enumerate(bars):
        win.append(h - l)
        if len(win) > 14:
            win.pop(0)
        out[i] = sum(win) / len(win)
    return out


# ---------------- level sources (per day -> list of (snap_ts_ms, {kind:price})) ----------------
def load_gex_levels():
    days = {}
    for fp in sorted(glob.glob(str(BASE / 'data/gex/nq-cbbo-causal/nq_gex_*.json'))):
        d = json.load(open(fp))
        date = os.path.basename(fp).split('_')[-1][:10]
        snaps = []
        for s in d['data']:
            ts = s['timestamp']
            ms = int(datetime.fromisoformat(ts).timestamp() * 1000)
            lv = {}
            for k in ('call_wall', 'put_wall', 'gamma_flip'):
                if s.get(k):
                    lv[k] = float(s[k])
            if s.get('resistance'):
                lv['R1'] = float(s['resistance'][0])
            if s.get('support'):
                lv['S1'] = float(s['support'][0])
            snaps.append((ms, lv))
        snaps.sort()
        days[date] = snaps
    return days


def load_lt_levels():
    days = defaultdict(list)
    with open(BASE / 'data/liquidity/nq/NQ_liquidity_levels.csv') as f:
        for row in csv.DictReader(f):
            date = row['datetime'][:10]
            if date < WIN_START or date > WIN_END:
                continue
            ms = int(row['unix_timestamp'])
            lv = {f'L{i}': float(row[f'level_{i}']) for i in range(1, 6) if row.get(f'level_{i}')}
            days[date].append((ms, lv))
    for d in days:
        days[d].sort()
    return dict(days)


def load_priorday_levels(bars):
    """PDH/PDL/PDC from prior RTH day; one static set per day valid all day."""
    byday = defaultdict(list)
    for ms, o, h, l, c, sym in bars:
        em, date = et_min_of(ms)
        if 570 <= em < 960:   # RTH 9:30-16:00
            byday[date].append((h, l, c))
    dates = sorted(byday)
    days = {}
    for i in range(1, len(dates)):
        prev = byday[dates[i - 1]]
        pdh = max(x[0] for x in prev); pdl = min(x[1] for x in prev); pdc = prev[-1][2]
        # valid from start of day; use ms=0 so snapshot_at_or_before always returns it
        days[dates[i]] = [(0, {'PDH': pdh, 'PDL': pdl, 'PDC': pdc})]
    return days


def make_placebo(bars, kind):
    """Per-day round-100 levels (kind='round') or seeded-random levels (kind='rand')."""
    byday = defaultdict(list)
    for ms, o, h, l, c, sym in bars:
        em, date = et_min_of(ms)
        if 570 <= em < 945:
            byday[date].append((h, l))
    days = {}
    for date, hl in byday.items():
        dhi = max(x[0] for x in hl); dlo = min(x[1] for x in hl)
        lv = {}
        if kind == 'round':
            lo100 = int(dlo // 100 + 1) * 100
            for j, x in enumerate(range(lo100, int(dhi), 100)):
                lv[f'RND{j}'] = float(x)
        else:
            for j in range(5):
                lv[f'RN{j}'] = RNG.uniform(dlo, dhi)
        days[date] = [(0, lv)]
    return days


def snapshot_at(snaps, ms):
    """most recent snapshot with ts <= ms."""
    lo, hi, best = 0, len(snaps) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if snaps[mid][0] <= ms:
            best = snaps[mid][1]; lo = mid + 1
        else:
            hi = mid - 1
    return best


# ---------------- 1s resolution ----------------
class S1Reader:
    def __init__(self):
        idx = json.load(open(S1IDX))
        self.minutes = idx['minutes']
        self.keys = sorted(int(k) for k in self.minutes)
        self.f = open(S1S, 'rb')

    def read_minute(self, mkey, sym):
        m = self.minutes.get(str(mkey))
        if not m:
            return []
        self.f.seek(m['offset'])
        blob = self.f.read(m['length']).decode('utf-8', 'replace')
        out = []
        for line in blob.split('\n'):
            p = line.split(',')
            if len(p) < 10 or p[9].strip() != sym:
                continue
            try:
                out.append((p[0], float(p[5]), float(p[6]), float(p[7])))  # ts, high, low, close
            except ValueError:
                continue
        return out

    def walk(self, entry_ts_ms, sym):
        """yield (ts_ms, high, low, close) for signal contract from entry to +MAXHOLD, chronological."""
        start_min = (entry_ts_ms // 60000) * 60000
        end_ms = entry_ts_ms + MAXHOLD_S * 1000
        j = bisect.bisect_left(self.keys, start_min)
        while j < len(self.keys) and self.keys[j] <= end_ms:
            for ts, hi, lo, cl in self.read_minute(self.keys[j], sym):
                tms = int(datetime.strptime(ts[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc).timestamp() * 1000)
                if tms < entry_ts_ms or tms > end_ms:
                    continue
                yield tms, hi, lo, cl
            j += 1


def resolve_bidir(reader, entry_ts, entry_px, sym):
    """One 1s walk -> outcomes for BOTH long (d=+1) and short (d=-1), in favorable-excursion space.
    Conservative: check stop (f_low) before ratcheting peak (f_high). Returns {1:res, -1:res}."""
    st = {d: dict(mfe=0.0, mae=0.0, ss={s: None for s in STOPS}, peak=0.0,
                  stop_f=-INIT_STOP, realized=None, exited=None, last_fc=0.0) for d in (1, -1)}
    n = 0
    for tms, hi, lo, cl in reader.walk(entry_ts, sym):
        n += 1
        em, _ = et_min_of(tms)
        for d in (1, -1):
            if d > 0:
                f_high, f_low, f_close = hi - entry_px, lo - entry_px, cl - entry_px
            else:
                f_high, f_low, f_close = entry_px - lo, entry_px - hi, entry_px - cl
            s = st[d]
            s['mfe'] = max(s['mfe'], f_high); s['mae'] = max(s['mae'], -f_low); s['last_fc'] = f_close
            for stp in STOPS:
                if s['ss'][stp] is None:
                    if f_low <= -stp:
                        s['ss'][stp] = 'stop'
                    elif f_high >= TARGET:
                        s['ss'][stp] = 'target'
            if s['exited'] is None:
                if f_low <= s['stop_f']:
                    s['realized'] = s['stop_f'] - STOP_SLIP; s['exited'] = 'trail_stop'
                elif em >= EOD_ET:
                    s['realized'] = f_close - STOP_SLIP; s['exited'] = 'eod'
                else:
                    s['peak'] = max(s['peak'], f_high)
                    s['stop_f'] = max(s['stop_f'], (s['peak'] - TRAIL_GAP) if s['peak'] >= BE_TRIG else -INIT_STOP)
    out = {}
    for d in (1, -1):
        s = st[d]
        if s['exited'] is None:
            s['realized'] = s['last_fc']; s['exited'] = 'timeout'
        out[d] = dict(mfe=round(s['mfe'], 2), mae=round(s['mae'], 2), realized=round(s['realized'], 2),
                      exit=s['exited'], n_bars=n,
                      **{f'hit20_s{stp}': int(s['ss'][stp] == 'target') for stp in STOPS})
    return out


# ---------------- touch detection + confirmation ----------------
def run(family):
    bars = load_1m()
    print(f'loaded {len(bars)} primary 1m bars {bars[0][0]}..{bars[-1][0]}', flush=True)
    if family == 'gex':
        levels = load_gex_levels()
    elif family == 'lt':
        levels = load_lt_levels()
    elif family == 'priorday':
        levels = load_priorday_levels(bars)
    elif family == 'placebo_round':
        levels = make_placebo(bars, 'round')
    elif family == 'placebo_rand':
        levels = make_placebo(bars, 'rand')
    else:
        raise SystemExit(f'unknown family {family}')

    bc3 = bucket_ohlc(bars, 3)
    bc5 = bucket_ohlc(bars, 5)
    atr = atr14(bars)
    reader = S1Reader()

    # index bars by date for level lookup; track per-(kind) hysteresis arm state
    events = []
    armed = {}   # kind -> bool (True = ready to fire)
    prev_c = None
    for i, (ms, o, h, l, c, sym) in enumerate(bars):
        em, date = et_min_of(ms)
        if not (570 <= em < EOD_ET):   # RTH touches only
            prev_c = c
            continue
        snaps = levels.get(date)
        if not snaps:
            prev_c = c
            continue
        lv = snapshot_at(snaps, ms)
        if not lv:
            prev_c = c
            continue
        for kind, L in lv.items():
            gk = f'{date}:{kind}'
            a = armed.get(gk, True)
            if prev_c is None:
                continue
            # re-arm when price is far from the level
            if abs(c - L) > REARM:
                armed[gk] = True
                a = True
            if not a:
                continue
            # touch: bar range reaches within TOUCH_ZONE of L, approach from prev close
            if l - TOUCH_ZONE <= L <= h + TOUCH_ZONE and abs(prev_c - L) > TOUCH_ZONE:
                approach = 'below' if prev_c < L else 'above'
                armed[gk] = False   # disarm until price leaves
                q = f'{date[:4]}Q{(int(date[5:7])-1)//3+1}'
                a = atr[i] or 1.0
                run10 = c - bars[max(0, i - 10)][4]
                approach_vel = (run10 if approach == 'below' else -run10) / a   # signed toward approach
                for tf, bc in (('3m', bc3), ('5m', bc5)):
                    span = (3 if tf == '3m' else 5) * 60000
                    bstart = (ms // span) * span
                    conf = bc.get(bstart)
                    if not conf:
                        continue
                    close_ts, close_px, close_sym = conf['close_ts'], conf['close'], conf['sym']
                    copen, chigh, clow = conf['open'], conf['high'], conf['low']
                    crange = max(chigh - clow, 0.25)
                    pen = (close_px - L) if approach == 'below' else (L - close_px)
                    poke = (chigh - L) if approach == 'below' else (L - clow)   # candle extreme past level
                    wick_beyond = max(0.0, poke - pen)                          # poked past then pulled back
                    close_loc = (close_px - clow) / crange
                    feats = dict(
                        entry_ts=close_ts,
                        wick_beyond=round(wick_beyond, 2),
                        wick_frac=round(wick_beyond / crange, 3),
                        body_frac=round(abs(close_px - copen) / crange, 3),
                        close_loc_sig=round((1 - close_loc) if approach == 'below' else close_loc, 3),  # stall-favorable
                        range_ratio=round(crange / conf['prange'], 3) if conf.get('prange') else '',
                        range_vs_atr=round(crange / a, 3),
                        approach_vel=round(approach_vel, 3))
                    res_bi = resolve_bidir(reader, close_ts, close_px, close_sym)
                    for arm in ('fade', 'breakout'):
                        d = (-1 if approach == 'below' else +1) if arm == 'fade' else (+1 if approach == 'below' else -1)
                        events.append(dict(date=date, quarter=q, kind=kind, tf=tf, arm=arm,
                                           approach=approach, level=round(L, 2), entry=round(close_px, 2),
                                           pen=round(pen, 2), dir=d, **feats, **res_bi[d]))
        prev_c = c
        if i % 100000 == 0:
            print(f'  {date} bars={i} events={len(events)}', flush=True)

    out = BASE / f'research/dealer-reaction/events_{family}.csv'
    if events:
        with open(out, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(events[0].keys()))
            w.writeheader(); w.writerows(events)
    print(f'{family}: {len(events)} events -> {out}')


if __name__ == '__main__':
    run(sys.argv[1] if len(sys.argv) > 1 else 'gex')
