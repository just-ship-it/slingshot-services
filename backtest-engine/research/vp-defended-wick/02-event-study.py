#!/usr/bin/env python3
"""VP-DEFENDED-WICK Phase 2 — wick-touch event study on 1s OHLCV, 2021→2026.

For every 1s wick touch of a reference level, record approach, penetration,
post-touch absorption (vol / (max penetration + 0.25), the regime-flow metric),
and honest forward outcomes from the touch instant with entry = level price
(resting-limit convention, as research/regime-flow/06+).

ARMS (level families, evaluated independently, same machinery):
  vp   : prior-day RTH volume profile POC / VAH / VAL   <-- hypothesis
  rth  : prior-day RTH high / low                        <-- mined-family control
  r100 : round hundreds                                  <-- weak-prior control (pilotfish E6 null at minute scale)
  plc  : vp levels + 37.5pt offset placebo               <-- placebo control
         (placebo dropped if within 5pt of any real level or round-50)

Outcomes per event: first-passage resolution for T x S grid (target/stop pts,
first-to-hit on 1s highs/lows, tie = loss), MFE/MAE at 60/300/900/1800s,
close-to-close drift at 1800s. Walks truncate at ET-day end.

Levels are knowable: profile levels seal at prior 16:00 ET; round hundreds are
timeless. Primary contract per day from the profile file; roll days (prior
primary != today primary) are skipped.

Output: research/vp-defended-wick/output/events.csv
Usage:  python3 02-event-study.py [--start 2021-01-19] [--end 2026-06-15]
"""
import csv
import sys
import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
F1S = f'{BASE}/data/ohlcv/nq/NQ_ohlcv_1s.csv'
PROF = f'{BASE}/research/vp-defended-wick/output/nq_daily_profiles.csv'
OUT = f'{BASE}/research/vp-defended-wick/output/events.csv'
ET = ZoneInfo('America/New_York')

def argval(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

START = argval('--start', '2021-01-19')
END = argval('--end', '2026-06-15')

EPS = 0.5            # touch tolerance (pt)
LOOKBACK = 60        # s before touch for approach read
MIN_APPROACH = 2.0   # |preClose - L| must exceed this
COOLDOWN = 300       # s per (arm, level)
HOLD = 1800          # s max walk
TGT = [6.0, 10.0, 15.0]
STP = [6.0, 9.0, 12.0]
MFE_H = [60, 300, 900, 1800]

# ---- profiles / day levels ----
prof = {}   # et_date -> dict
dates = []
with open(PROF) as f:
    for r in csv.DictReader(f):
        prof[r['et_date']] = r
        dates.append(r['et_date'])
prev_date = {dates[i]: dates[i - 1] for i in range(1, len(dates))}

def day_levels(d):
    """levels for trading day d, from prior trading day. None if unusable."""
    p = prev_date.get(d)
    if p is None or d not in prof:
        return None
    pp, dd = prof[p], prof[d]
    if pp['symbol'] != dd['symbol']:
        return None            # roll day: prior levels in a different contract's space
    if int(pp['nbars']) < 300:
        return None            # partial prior session, unreliable profile
    lv = [('vp', 'poc', float(pp['poc'])), ('vp', 'vah', float(pp['vah'])),
          ('vp', 'val', float(pp['val'])),
          ('rth', 'rthh', float(pp['rth_high'])), ('rth', 'rthl', float(pp['rth_low']))]
    real = [x[2] for x in lv]
    for name, base in (('poc', float(pp['poc'])), ('vah', float(pp['vah'])), ('val', float(pp['val']))):
        pl = base + 37.5
        if min(abs(pl - r) for r in real) < 5.0:
            continue
        if abs(pl - round(pl / 50.0) * 50.0) < 5.0:
            continue           # placebo colliding with round-50 grid: drop
        lv.append(('plc', 'p' + name, pl))
    return {'symbol': dd['symbol'], 'levels': lv}

# ---- ET calendar cache (per UTC hour) ----
_et = {}
def et_info(ts13):
    v = _et.get(ts13)
    if v is None:
        t = datetime.fromisoformat(ts13 + ':00:00+00:00').astimezone(ET)
        if len(_et) > 8:
            _et.clear()
        v = (t.strftime('%Y-%m-%d'), t.hour, t.weekday(),
             int(datetime.fromisoformat(ts13 + ':00:00+00:00').timestamp()))
        _et[ts13] = v
    return v

# ---- per-day processing ----
out = open(OUT, 'w', newline='')
w = csv.writer(out)
w.writerow(['date', 'ts', 'hour_et', 'dow', 'arm', 'ltype', 'level', 'dir',
            'approach', 'pen_touch', 'abs10', 'abs30', 'vol30',
            *[f'o_t{int(t)}s{int(s)}' for t in TGT for s in STP],
            *[f'mfe{h}' for h in MFE_H], *[f'mae{h}' for h in MFE_H], 'drift1800'])

nev = 0

def process_day(date, hour_et_arr, dow, T, H, L, C, V):
    """arrays are the day's primary-contract 1s bars in time order."""
    global nev
    dl = day_levels(date)
    if dl is None:
        return
    n = len(T)
    if n < 100:
        return
    levels = list(dl['levels'])
    last_fire = {}
    # closes ring for approach lookup: binary search on T
    import bisect
    for i in range(n):
        lo, hi = L[i], H[i]
        # round-100 candidates spanned by this bar (grid materialized lazily)
        r0 = int((lo - EPS) // 100.0) * 100
        cand = levels
        extra = []
        r = r0
        while r <= hi + EPS:
            if lo - EPS <= r <= hi + EPS:
                extra.append(('r100', 'r100', float(r)))
            r += 100
        if extra:
            cand = levels + extra
        for arm, ltype, lev in cand:
            if not (lo - EPS <= lev <= hi + EPS):
                continue
            key = (arm, lev)
            lf = last_fire.get(key)
            if lf is not None and T[i] - lf < COOLDOWN:
                continue
            # approach: close at ts <= T[i]-LOOKBACK
            j = bisect.bisect_right(T, T[i] - LOOKBACK) - 1
            if j < 0:
                continue
            pre = C[j]
            app = pre - lev
            if abs(app) < MIN_APPROACH:
                continue
            last_fire[key] = T[i]
            d = 1 if app > 0 else -1     # price above level, falls into it -> fade long
            # touch-bar penetration beyond level (adverse side)
            pen = (lev - lo) if d > 0 else (hi - lev)
            if pen < 0:
                pen = 0.0
            # absorption windows (time-based)
            e10 = bisect.bisect_right(T, T[i] + 10) - 1
            e30 = bisect.bisect_right(T, T[i] + 30) - 1
            v10 = v30 = 0.0
            p10 = p30 = pen
            for k in range(i, min(e30, n - 1) + 1):
                pk = (lev - L[k]) if d > 0 else (H[k] - lev)
                vk = V[k]
                if k <= e10:
                    v10 += vk
                    if pk > p10:
                        p10 = pk
                v30 += vk
                if pk > p30:
                    p30 = pk
            a10 = v10 / (p10 + 0.25)
            a30 = v30 / (p30 + 0.25)
            # forward walk from touch bar: first-passage times for each threshold
            endw = bisect.bisect_right(T, T[i] + HOLD) - 1
            tgt_t = [None] * len(TGT)
            stp_t = [None] * len(STP)
            mfe = 0.0
            mae = 0.0
            mfe_at = {}
            mae_at = {}
            hidx = 0
            for k in range(i, endw + 1):
                fav = (H[k] - lev) if d > 0 else (lev - L[k])
                adv = (lev - L[k]) if d > 0 else (H[k] - lev)
                if fav > mfe:
                    mfe = fav
                    for ti, tv in enumerate(TGT):
                        if tgt_t[ti] is None and mfe >= tv:
                            tgt_t[ti] = T[k]
                if adv > mae:
                    mae = adv
                    for si, sv in enumerate(STP):
                        if stp_t[si] is None and mae >= sv:
                            stp_t[si] = T[k]
                while hidx < len(MFE_H) and T[k] - T[i] > MFE_H[hidx]:
                    mfe_at[MFE_H[hidx]] = mfe
                    mae_at[MFE_H[hidx]] = mae
                    hidx += 1
            for hh in MFE_H:
                mfe_at.setdefault(hh, mfe)
                mae_at.setdefault(hh, mae)
            outc = []
            for ti in range(len(TGT)):
                for si in range(len(STP)):
                    tt, st = tgt_t[ti], stp_t[si]
                    if tt is None and st is None:
                        outc.append('0')
                    elif st is None:
                        outc.append('1')
                    elif tt is None:
                        outc.append('-1')
                    else:
                        outc.append('1' if tt < st else '-1')   # tie -> loss
            drift = ((C[endw] - lev) if d > 0 else (lev - C[endw]))
            w.writerow([date, T[i], hour_et_arr[i], dow, arm, ltype, f'{lev:.2f}', d,
                        f'{app:.2f}', f'{pen:.2f}', f'{a10:.1f}', f'{a30:.1f}', int(v30),
                        *outc,
                        *[f'{mfe_at[hh]:.2f}' for hh in MFE_H],
                        *[f'{mae_at[hh]:.2f}' for hh in MFE_H], f'{drift:.2f}'])
            nev += 1

# ---- per-day slice via the minute byte index + pandas C parser ----
import json
import bisect as _bis
import io
import pandas as pd

IDX = json.load(open(F1S.replace('.csv', '.index.json')))['minutes']
idx_keys = sorted(int(k) for k in IDX)
fsize = os.path.getsize(F1S)

def byte_range(utc_ms_a, utc_ms_b):
    i = _bis.bisect_right(idx_keys, utc_ms_a) - 1
    j = _bis.bisect_left(idx_keys, utc_ms_b)
    off_a = IDX[str(idx_keys[max(i, 0)])]['offset'] if i >= 0 else IDX[str(idx_keys[0])]['offset']
    off_b = IDX[str(idx_keys[j])]['offset'] if j < len(idx_keys) else fsize
    return off_a, off_b

t0 = datetime.now()
fh = open(F1S, 'rb')
COLS = ['ts_event', 'rtype', 'publisher_id', 'instrument_id', 'open', 'high', 'low', 'close', 'volume', 'symbol']

run_dates = [d for d in dates if START <= d <= END]
for di, date in enumerate(run_dates):
    if day_levels(date) is None:
        continue
    psym = prof[date]['symbol']
    d0 = datetime.fromisoformat(date + 'T00:00:00').replace(tzinfo=ET)
    a = int(d0.timestamp() * 1000)
    b = a + 86400_000
    off_a, off_b = byte_range(a, b)
    if off_b <= off_a:
        continue
    fh.seek(off_a)
    raw = fh.read(off_b - off_a)
    # ensure we start at a line boundary (index offsets are line-aligned; guard anyway)
    df = pd.read_csv(io.BytesIO(raw), names=COLS, header=None,
                     usecols=['ts_event', 'high', 'low', 'close', 'volume', 'symbol'],
                     dtype={'high': 'f8', 'low': 'f8', 'close': 'f8', 'volume': 'f8'},
                     engine='c', on_bad_lines='skip')
    df = df[df['symbol'] == psym]
    if df.empty:
        continue
    ts = df['ts_event'].to_numpy()
    # epoch seconds from ISO string via per-hour cache
    epochs = []
    hrs = []
    dow = 0
    keep = []
    for k, s in enumerate(ts):
        ed, eh, dw, he = et_info(s[:13])
        if ed != date:
            continue
        keep.append(k)
        epochs.append(he + int(s[14:16]) * 60 + int(s[17:19]))
        hrs.append(eh)
        dow = dw
    if not keep:
        continue
    sub = df.iloc[keep]
    process_day(date, hrs, dow,
                epochs,
                sub['high'].tolist(), sub['low'].tolist(),
                sub['close'].tolist(), sub['volume'].tolist())
    if di % 100 == 0:
        el = (datetime.now() - t0).total_seconds()
        print(f'  {date} ({di+1}/{len(run_dates)}) events={nev} {el:.0f}s', flush=True)

out.close()
print(f'{nev} events -> {OUT}  ({(datetime.now()-t0).total_seconds():.0f}s)')
