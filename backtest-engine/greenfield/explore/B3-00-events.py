#!/usr/bin/env python3
"""B3 stage 0: fresh-extreme event extraction + 1m arrival-speed metrics.

Fresh extreme definition (live-computable):
  At the CLOSE of 1m bar t (knowable at t+60s), bar t's high exceeds the max
  high of the prior 120 1m bars (a rolling 120-bar buffer of the same
  contract).  Symmetric for lows.  Event price E = bar t's high (low).
  Cooldown: an event is only sampled if no sampled event of the same side
  occurred within the last 15 bars.  Lookback never spans a symbol change.

Metrics (all computed from data at or before bar t close; ATR from PRIOR days):
  arr3/arr5/arr10/arr15 : dir*(E - close[t-K]) / atr14_prior
  eff10                 : dir*(close[t]-close[t-10]) / sum|1m close moves|
  accel                 : dir*((c[t]-c[t-3])/3 - (c[t-3]-c[t-10])/7) / atr
  dep_bars              : bars since price last traded 0.3*atr away from E
                          (capped at 240); speed = fewer bars
  rv60                  : trailing 60m realized vol (sum |1m close moves|)/atr
                          -- regime covariate, not a candidate metric

Outcomes (1m walk, DESCRIPTIVE ONLY, conservative: break wins ties within a
bar) over 120 bars forward, same symbol only:
  brk0_t / brk5_t : first bar index (1-based) where extreme exceeded by >0 / >=5pts
  ret_R_t for R in {20,35,50} pts and {0.15,0.25}*atr : first bar index where
                  retrace from E reaches R
  hold_R_B = ret_R_t occurs strictly before brk_B_t (ambiguity same bar -> break)
  maxret_prebrk5 : max retrace (pts) before first 5pt break (or horizon end)
  maxret_t       : bar index of that max retrace
Writes greenfield/explore/B3-events.csv
"""
import os
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache_nq_primary_1m.csv')
SESS = os.path.join(HERE, 'cache', 'NQ_daily_sessions.csv')
OUT = os.path.join(HERE, 'B3-events.csv')

LOOKBACK = 120      # bars defining "fresh extreme"
COOLDOWN = 15       # bars between sampled events per side
HORIZON = 120       # forward walk bars
DEP_FRAC = 0.30     # departure distance as fraction of atr14
DEP_CAP = 240

print('loading 1m cache...')
df = pd.read_csv(CACHE)
ts = pd.to_datetime(df['ts'], format='%Y-%m-%dT%H:%M', utc=True)
et = ts.dt.tz_convert('America/New_York')
df['et_date'] = et.dt.strftime('%Y-%m-%d')
df['et_hour'] = et.dt.hour.astype(np.int16)
df['et_min'] = (et.dt.hour * 60 + et.dt.minute).astype(np.int16)
df['epoch'] = (ts.astype(np.int64) // 10**9).astype(np.int64)
# trade date: ET evening (>=18:00) belongs to next trade date
td = et.dt.normalize() + pd.to_timedelta((et.dt.hour >= 18).astype(int), unit='D')
df['trade_date'] = td.dt.strftime('%Y-%m-%d')

sess = pd.read_csv(SESS, usecols=['trade_date', 'atr14_prior'])
atr_map = dict(zip(sess['trade_date'], sess['atr14_prior']))

h = df['high'].to_numpy()
l = df['low'].to_numpy()
c = df['close'].to_numpy()
sym = df['symbol'].to_numpy()
n = len(df)

# symbol run id + position within run
runid = np.zeros(n, dtype=np.int32)
runid[1:] = np.cumsum(sym[1:] != sym[:-1])
runpos = np.arange(n) - np.maximum.accumulate(
    np.where(np.r_[True, sym[1:] != sym[:-1]], np.arange(n), 0))

# rolling prior-120 max/min (excluding current bar)
roll_max = pd.Series(h).rolling(LOOKBACK).max().shift(1).to_numpy()
roll_min = pd.Series(l).rolling(LOOKBACK).min().shift(1).to_numpy()
absmove = np.abs(np.diff(c, prepend=c[0]))
rv60 = pd.Series(absmove).rolling(60).sum().to_numpy()

valid = runpos >= LOOKBACK + 15   # lookback fully inside same symbol run
new_hi = valid & (h > roll_max)
new_lo = valid & (l < roll_min)

atr_arr = df['trade_date'].map(atr_map).to_numpy()
et_min = df['et_min'].to_numpy()
et_date = df['et_date'].to_numpy()
trade_date = df['trade_date'].to_numpy()
epoch = df['epoch'].to_numpy()

R_PTS = (20.0, 35.0, 50.0)
R_ATR = (0.15, 0.25)

rows = []
last_evt = {1: -10**9, -1: -10**9}
cand = np.flatnonzero(new_hi | new_lo)
print(f'candidate new-extreme bars: {len(cand)}')
for t in cand:
    atr = atr_arr[t]
    if not np.isfinite(atr) or atr <= 0:
        continue
    for side in (1, -1):
        if side == 1 and not new_hi[t]:
            continue
        if side == -1 and not new_lo[t]:
            continue
        if t - last_evt[side] <= COOLDOWN:
            continue
        E = h[t] if side == 1 else l[t]
        # metrics
        arr = {}
        for K in (3, 5, 10, 15):
            arr[K] = side * (E - c[t - K]) / atr
        denom = absmove[t - 9:t + 1].sum()
        eff10 = side * (c[t] - c[t - 10]) / denom if denom > 0 else 0.0
        accel = side * ((c[t] - c[t - 3]) / 3.0 - (c[t - 3] - c[t - 10]) / 7.0) / atr
        # bars since departure
        D = DEP_FRAC * atr
        dep = DEP_CAP
        lo_j = max(t - DEP_CAP, t - runpos[t])
        seg = (l[lo_j:t + 1] if side == 1 else h[lo_j:t + 1])
        hitmask = (seg <= E - D) if side == 1 else (seg >= E + D)
        idx = np.flatnonzero(hitmask)
        if len(idx):
            dep = t - (lo_j + idx[-1])
        # bars since last new-extreme-same-side bar (freshness covariate)
        prev_new = new_hi if side == 1 else new_lo
        back = prev_new[max(0, t - 240):t]
        pidx = np.flatnonzero(back)
        fresh_bars = (t - (max(0, t - 240) + pidx[-1])) if len(pidx) else 240

        # ---- outcome walk (1m, conservative) ----
        rid = runid[t]
        brk_t = {0.0: None, 5.0: None}
        rlist = [('p20', 20.0), ('p35', 35.0), ('p50', 50.0),
                 ('a15', 0.15 * atr), ('a25', 0.25 * atr)]
        ret_t = {k: None for k, _ in rlist}
        maxret, maxret_t = 0.0, 0
        end = min(n, t + 1 + HORIZON)
        for j in range(t + 1, end):
            if runid[j] != rid:
                break
            k = j - t
            if side == 1:
                ext = h[j] - E
                ret = E - l[j]
            else:
                ext = E - l[j]
                ret = h[j] - E
            for B in (0.0, 5.0):
                if brk_t[B] is None and ext > B:
                    brk_t[B] = k
            if brk_t[5.0] is None and ret > maxret:
                maxret, maxret_t = ret, k
            for key, R in rlist:
                if ret_t[key] is None and ret >= R:
                    ret_t[key] = k
            if brk_t[5.0] is not None and all(v is not None for v in ret_t.values()):
                break
        hold = {}
        for key, _ in rlist:
            for B in (0.0, 5.0):
                rt, bt = ret_t[key], brk_t[B]
                # conservative: same-bar tie counts as break
                hold[f'{key}_b{int(B)}'] = int(rt is not None and (bt is None or rt < bt))
        rows.append({
            'i': t, 'epoch': epoch[t], 'et_date': et_date[t],
            'trade_date': trade_date[t], 'year': int(et_date[t][:4]),
            'et_min': int(et_min[t]), 'side': side, 'E': E, 'atr': atr,
            'sym': sym[t],
            'arr3': arr[3], 'arr5': arr[5], 'arr10': arr[10], 'arr15': arr[15],
            'eff10': eff10, 'accel': accel, 'dep_bars': dep,
            'fresh_bars': fresh_bars, 'rv60': rv60[t] / atr,
            'brk0_t': brk_t[0.0] or 0, 'brk5_t': brk_t[5.0] or 0,
            'ret_p35_t': ret_t['p35'] or 0,
            'maxret_prebrk5': maxret, 'maxret_t': maxret_t,
            **{f'hold_{k}': v for k, v in hold.items()},
        })
        last_evt[side] = t

ev = pd.DataFrame(rows)
ev.to_csv(OUT, index=False)
print(f'events written: {len(ev)} -> {OUT}')
print(ev.groupby('year').size())
print('base rates (all events):')
for col in [c for c in ev.columns if c.startswith('hold_')]:
    print(f'  {col}: {ev[col].mean():.3f}')
