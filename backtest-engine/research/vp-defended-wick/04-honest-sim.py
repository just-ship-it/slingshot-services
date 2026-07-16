#!/usr/bin/env python3
"""VP-DEFENDED-WICK Phase 4 — honest confirmation-entry simulation ("DWS": defended-wick scalp).

Event = 1s wick touch of an anchor level (union: prior-day VP POC/VAH/VAL,
prior RTH H/L, round-100s), approach >= 2pt, per-level cooldown 300s.
At touch+CONFIRM_S seconds compute absorption = vol/(max_pen+0.25) over the
window (fully causal at decision time). If absorption >= rolling q-threshold
(trailing TRAIL_EV events, causal, warmup skipped) -> FADE signal.

Plan A: market entry at close of confirm bar +/- ENTRY_SLIP.
Plan B: resting limit AT the touched level, TTL_S; fills when a later 1s bar
        trades to the level; entry = level exactly (limit convention).

Exits (both plans): fixed target T (limit, no slip) / stop S (market, 1.5pt
slip); tie within one 1s bar = loss; max hold HOLD_S -> market out 1.0 slip;
force-flat at ET-day end. Commission 0.2pt/trade ($4/RT NQ). Single slot per
plan; signals while in trade / pending are dropped (stats still updated).

Usage: python3 04-honest-sim.py [--start ...] [--end ...] [--q 0.75]
       [--t 10] [--s 9] [--confirm 10] [--ttl 600] [--out trades.csv]
"""
import csv
import io
import json
import os
import sys
import bisect as _bis
from collections import deque
from datetime import datetime
from zoneinfo import ZoneInfo

import pandas as pd

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
F1S = f'{BASE}/data/ohlcv/nq/NQ_ohlcv_1s.csv'
PROF = f'{BASE}/research/vp-defended-wick/output/nq_daily_profiles.csv'
ET = ZoneInfo('America/New_York')

def argval(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

START = argval('--start', '2021-01-19')
END = argval('--end', '2026-06-15')
QTH = float(argval('--q', '0.75'))
T_PT = float(argval('--t', '10'))
S_PT = float(argval('--s', '9'))
CONFIRM_S = int(argval('--confirm', '10'))
TTL_S = int(argval('--ttl', '600'))
OUTCSV = argval('--out', f'{BASE}/research/vp-defended-wick/output/dws_trades.csv')

EPS = 0.5
LOOKBACK = 60
MIN_APPROACH = 2.0
COOLDOWN = 300
HOLD_S = 1800
TRAIL_EV = 2000
WARMUP_EV = 2000
STOP_SLIP = 1.5
MKT_SLIP = 1.0
COMM = 0.2

# ---- profiles ----
prof = {}
dates = []
with open(PROF) as f:
    for r in csv.DictReader(f):
        prof[r['et_date']] = r
        dates.append(r['et_date'])
prev_date = {dates[i]: dates[i - 1] for i in range(1, len(dates))}

def day_levels(d):
    p = prev_date.get(d)
    if p is None or d not in prof:
        return None
    pp, dd = prof[p], prof[d]
    if pp['symbol'] != dd['symbol'] or int(pp['nbars']) < 300:
        return None
    return [float(pp['poc']), float(pp['vah']), float(pp['val']),
            float(pp['rth_high']), float(pp['rth_low'])]

_et = {}
def et_info(ts13):
    v = _et.get(ts13)
    if v is None:
        t = datetime.fromisoformat(ts13 + ':00:00+00:00')
        loc = t.astimezone(ET)
        if len(_et) > 8:
            _et.clear()
        v = (loc.strftime('%Y-%m-%d'), loc.hour, int(t.timestamp()))
        _et[ts13] = v
    return v

IDX = json.load(open(F1S.replace('.csv', '.index.json')))['minutes']
idx_keys = sorted(int(k) for k in IDX)
fsize = os.path.getsize(F1S)

def byte_range(a, b):
    i = _bis.bisect_right(idx_keys, a) - 1
    j = _bis.bisect_left(idx_keys, b)
    off_a = IDX[str(idx_keys[max(i, 0)])]['offset']
    off_b = IDX[str(idx_keys[j])]['offset'] if j < len(idx_keys) else fsize
    return off_a, off_b

COLS = ['ts_event', 'rtype', 'publisher_id', 'instrument_id', 'open', 'high', 'low', 'close', 'volume', 'symbol']

# ---- rolling absorption distribution (causal) ----
absq = deque(maxlen=TRAIL_EV)
seen_events = 0

def threshold():
    if seen_events < WARMUP_EV or len(absq) < 200:
        return None
    s = sorted(absq)
    return s[int(QTH * (len(s) - 1))]

# ---- trade log ----
trades = {'A': [], 'B': []}

class Slot:
    __slots__ = ('state', 'dir', 'entry', 'lvl', 'e_i', 'deadline', 'ttl')
    def __init__(self):
        self.state = 'flat'   # flat | pending_limit | long | short

def close_trade(plan, day, ts, e_ts, entry, dir_, exit_px, reason):
    pnl = (exit_px - entry) * dir_ - COMM
    trades[plan].append({'date': day, 'entry_ts': e_ts, 'exit_ts': ts, 'dir': dir_,
                         'entry': entry, 'exit': exit_px, 'pnl_pt': round(pnl, 2),
                         'reason': reason})

def run_day(day, T, H, L, C, V, HRs):
    global seen_events
    base_levels = day_levels(day)
    if base_levels is None or len(T) < 100:
        return
    n = len(T)
    last_fire = {}
    confirms = []          # [(i_touch, level, dir)] pending stat/trade confirms
    slots = {'A': Slot(), 'B': Slot()}

    for i in range(n):
        lo, hi, c = L[i], H[i], C[i]
        ts = T[i]

        # 1) manage open positions / pending limits
        for plan, sl in slots.items():
            if sl.state in ('long', 'short'):
                d = 1 if sl.state == 'long' else -1
                tgt = sl.entry + d * T_PT
                stp = sl.entry - d * S_PT
                hit_t = (hi >= tgt) if d > 0 else (lo <= tgt)
                hit_s = (lo <= stp) if d > 0 else (hi >= stp)
                if hit_s:   # tie -> loss (conservative)
                    close_trade(plan, day, ts, sl.e_i, sl.entry, d, stp - d * STOP_SLIP, 'stop')
                    sl.state = 'flat'
                elif hit_t:
                    close_trade(plan, day, ts, sl.e_i, sl.entry, d, tgt, 'target')
                    sl.state = 'flat'
                elif ts - sl.e_i >= HOLD_S or i == n - 1:
                    close_trade(plan, day, ts, sl.e_i, sl.entry, d, c - d * MKT_SLIP, 'timeout')
                    sl.state = 'flat'
            elif sl.state == 'pending_limit':
                d = sl.dir
                touched = (lo <= sl.lvl) if d > 0 else (hi >= sl.lvl)
                if touched:
                    sl.state = 'long' if d > 0 else 'short'
                    sl.entry = sl.lvl
                    sl.e_i = ts
                    # immediate exit check on the fill bar (post-fill side only is
                    # unknowable intrabar -> conservative: stop if bar extreme breaches)
                    stp = sl.lvl - d * S_PT
                    if (lo <= stp) if d > 0 else (hi >= stp):
                        close_trade('B', day, ts, ts, sl.lvl, d, stp - d * STOP_SLIP, 'stop')
                        sl.state = 'flat'
                elif ts >= sl.ttl or i == n - 1:
                    sl.state = 'flat'

        # 2) resolve pending confirms
        if confirms:
            kept = []
            for (i0, lev, d) in confirms:
                if ts - T[i0] < CONFIRM_S:
                    kept.append((i0, lev, d))
                    continue
                # window sealed at this bar: compute absorption over [i0, i-? ] bars with T<=T[i0]+CONFIRM
                vol = 0.0
                pen = 0.0
                k = i0
                while k < n and T[k] <= T[i0] + CONFIRM_S:
                    pk = (lev - L[k]) if d > 0 else (H[k] - lev)
                    if pk > pen:
                        pen = pk
                    vol += V[k]
                    k += 1
                a = vol / (pen + 0.25)
                th = threshold()
                absq.append(a)
                seen_events += 1
                if th is None or a < th:
                    continue
                # signal fires NOW (bar i): dispatch to flat slots
                sA = slots['A']
                if sA.state == 'flat':
                    sA.state = 'long' if d > 0 else 'short'
                    sA.entry = c + d * MKT_SLIP
                    sA.e_i = ts
                sB = slots['B']
                if sB.state == 'flat':
                    sB.state = 'pending_limit'
                    sB.dir = d
                    sB.lvl = lev
                    sB.ttl = ts + TTL_S
            confirms = kept

        # 3) detect new touches (always, for stats; trade gating happens above)
        r0 = int((lo - EPS) // 100.0) * 100
        cand = list(base_levels)
        r = r0
        while r <= hi + EPS:
            cand.append(float(r))
            r += 100
        for lev in cand:
            if not (lo - EPS <= lev <= hi + EPS):
                continue
            key = round(lev, 2)
            lf = last_fire.get(key)
            if lf is not None and ts - lf < COOLDOWN:
                continue
            j = _bis.bisect_right(T, ts - LOOKBACK) - 1
            if j < 0:
                continue
            app = C[j] - lev
            if abs(app) < MIN_APPROACH:
                continue
            last_fire[key] = ts
            confirms.append((i, lev, 1 if app > 0 else -1))

# ---- main loop over days ----
fh = open(F1S, 'rb')
t0 = datetime.now()
run_dates = [d for d in dates if START <= d <= END]
for di, day in enumerate(run_dates):
    if day_levels(day) is None:
        continue
    psym = prof[day]['symbol']
    d0 = datetime.fromisoformat(day + 'T00:00:00').replace(tzinfo=ET)
    a = int(d0.timestamp() * 1000)
    off_a, off_b = byte_range(a, a + 86400_000)
    if off_b <= off_a:
        continue
    fh.seek(off_a)
    df = pd.read_csv(io.BytesIO(fh.read(off_b - off_a)), names=COLS, header=None,
                     usecols=['ts_event', 'high', 'low', 'close', 'volume', 'symbol'],
                     dtype={'high': 'f8', 'low': 'f8', 'close': 'f8', 'volume': 'f8'},
                     engine='c', on_bad_lines='skip')
    df = df[df['symbol'] == psym]
    if df.empty:
        continue
    ts_s = df['ts_event'].tolist()
    epochs, hrs, keep = [], [], []
    for k, s in enumerate(ts_s):
        ed, eh, he = et_info(s[:13])
        if ed != day:
            continue
        keep.append(k)
        epochs.append(he + int(s[14:16]) * 60 + int(s[17:19]))
        hrs.append(eh)
    if not keep:
        continue
    sub = df.iloc[keep]
    run_day(day, epochs, sub['high'].tolist(), sub['low'].tolist(),
            sub['close'].tolist(), sub['volume'].tolist(), hrs)
    if di % 200 == 0:
        print(f'  {day} ({di+1}/{len(run_dates)}) A={len(trades["A"])} B={len(trades["B"])} '
              f'({(datetime.now()-t0).total_seconds():.0f}s)', flush=True)

# ---- results ----
def report(plan):
    tl = trades[plan]
    if not tl:
        print(f'plan {plan}: no trades')
        return
    df = pd.DataFrame(tl)
    df['pnl_usd'] = df['pnl_pt'] * 20.0
    wins = df[df.pnl_pt > 0]
    losses = df[df.pnl_pt <= 0]
    pf = wins.pnl_pt.sum() / max(1e-9, -losses.pnl_pt.sum())
    daily = df.groupby('date')['pnl_usd'].sum()
    sharpe = daily.mean() / max(1e-9, daily.std()) * (252 ** 0.5)
    eq = daily.cumsum()
    dd = (eq - eq.cummax()).min()
    print(f'\n=== PLAN {plan}  (T={T_PT}/S={S_PT}, confirm={CONFIRM_S}s, q={QTH}) ===')
    print(f'trades={len(df)}  WR={len(wins)/len(df):.1%}  PF={pf:.2f}  '
          f'PnL={df.pnl_pt.sum():+.0f}pt (${df.pnl_usd.sum():+,.0f} NQ)  '
          f'Sharpe(daily)={sharpe:.2f}  maxDD=${-dd:,.0f}')
    print('yearly:')
    df['year'] = df['date'].str[:4]
    for y, g in df.groupby('year'):
        w = (g.pnl_pt > 0).mean()
        gpf = g[g.pnl_pt > 0].pnl_pt.sum() / max(1e-9, -g[g.pnl_pt <= 0].pnl_pt.sum())
        print(f'  {y}: n={len(g):>5} WR={w:.0%} PF={gpf:.2f} PnL=${g.pnl_usd.sum():+,.0f}')
    df.to_csv(OUTCSV.replace('.csv', f'_{plan}.csv'), index=False)

report('A')
report('B')
print(f'\ndone in {(datetime.now()-t0).total_seconds():.0f}s')
