#!/usr/bin/env python3
"""
B5-01: causal thrust-fade signal builder.

Reproduces the census (R3-04) thrust signature CAUSALLY from the raw 1s RTH
cache, independent of R3-baselines.npz:

  minute m (from 09:28 ET, m in 0..392) close = last 1s close in [m*60, m*60+60),
  fwd-filled across empty minutes.  minute volume = sum of 1s volume in the minute.
  net3[m]  = mclose[m] - mclose[m-3]                       (trailing-3m price move)
  netb3[m] = median over previous 20 ELIGIBLE days of |net3[m]| (strictly prior)
  THRUST   = |net3[m]| >= k * netb3[m], dir = sign(net3[m]), 5-min per-day cooldown
  vm3[m]   = (Vmin[m]+Vmin[m-1]+Vmin[m-2]) / (volb[m]+volb[m-1]+volb[m-2])
             volb[m] = median over prev 20 eligible days of that minute's volume.
  ATR regime: trailing-250d ATR14 tercile of atr14_prior (knowable 09:30).

Eligible day = full RTH present + >=20000 traded seconds.  Detection minutes
5..391 (net3 needs m-3>=2; census masks <5 and >=392).

Every input is knowable at the minute-m CLOSE second (base + m*60 + 59). Order
placement second = that +1 (base + (m+1)*60).

Emits B5-events.csv (superset: all thrusts with mult>=1.5) for the sim to subset.
"""
import json, sys
import numpy as np
import pandas as pd
from datetime import datetime
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
ET = ZoneInfo("America/New_York")
N_MIN = 393
BASE_WIN, BASE_MIN = 20, 15
DAYS_LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 0  # 0 = all

def et_base(dstr):
    y, m, d = map(int, dstr.split("-"))
    return int(datetime(y, m, d, 9, 28, tzinfo=ET).timestamp())

# --- load days.json index + B12-days meta ---
with open(f"{BASE}/cache_nq_rth_1s.days.json") as f:
    dayidx = json.load(f)
days_all = sorted(dayidx.keys())
if DAYS_LIMIT:
    days_all = days_all[:DAYS_LIMIT]

meta = pd.read_csv(f"{BASE}/B12-days.csv", parse_dates=["trade_date"])
meta["date_str"] = meta["trade_date"].dt.strftime("%Y-%m-%d")
meta = meta.set_index("date_str")

# --- load 1s cache (ts, c, v only) ---
print(f"loading 1s cache ({len(days_all)} days)...", file=sys.stderr)
maxrow = max(dayidx[d][1] for d in days_all)
df = pd.read_csv(f"{BASE}/cache_nq_rth_1s.csv", usecols=["ts", "c", "v"],
                 dtype={"ts": np.int64, "c": np.float64, "v": np.int64},
                 nrows=maxrow)
TS, C, V = df["ts"].to_numpy(), df["c"].to_numpy(), df["v"].to_numpy()
print("loaded rows:", len(TS), file=sys.stderr)

# --- per-day per-minute close (ffill) and volume ---
D = len(days_all)
mclose = np.full((D, N_MIN), np.nan)
mvol = np.zeros((D, N_MIN))
n_traded = np.zeros(D, int)
elig = np.zeros(D, bool)
for di, dstr in enumerate(days_all):
    lo, hi = dayidx[dstr]
    base = et_base(dstr)
    ts, c, v = TS[lo:hi], C[lo:hi], V[lo:hi]
    m = (ts - base) // 60
    ok = (m >= 0) & (m < N_MIN)
    m, c, v = m[ok], c[ok], v[ok]
    mc = np.full(N_MIN, np.nan)
    mc[m] = c                     # sorted ts -> last write per minute = close
    mv = np.zeros(N_MIN)
    np.add.at(mv, m, v)
    # forward-fill closes across empty minutes
    idx = np.where(~np.isnan(mc), np.arange(N_MIN), -1)
    np.maximum.accumulate(idx, out=idx)
    valid = idx >= 0
    mc[valid] = mc[idx[valid]]
    mclose[di] = mc
    mvol[di] = mv
    nt = int((v > 0).sum())
    n_traded[di] = nt
    fr = bool(meta.at[dstr, "full_rth"]) if dstr in meta.index else False
    elig[di] = fr and nt >= 20000

# --- per-minute net3, vm-components ---
net3 = np.full((D, N_MIN), np.nan)
net3[:, 3:] = mclose[:, 3:] - mclose[:, :-3]
V3 = np.full((D, N_MIN), np.nan)
V3[:, 2:] = mvol[:, 2:] + mvol[:, 1:-1] + mvol[:, :-2]

# --- causal trailing-20-eligible-day baselines ---
def rolling_prior_median(M):
    out = np.full((D, N_MIN), np.nan)
    E = M[elig]
    eidx = np.where(elig)[0]
    for j, d in enumerate(eidx):
        lo = max(0, j - BASE_WIN)
        if j - lo >= BASE_MIN:
            out[d] = np.nanmedian(E[lo:j], axis=0)
    return out

netb3 = rolling_prior_median(np.abs(net3))
volb = rolling_prior_median(mvol)
B3 = np.full((D, N_MIN), np.nan)
B3[:, 2:] = volb[:, 2:] + volb[:, 1:-1] + volb[:, :-2]
vm3 = V3 / B3
base_ok = ~np.isnan(netb3[:, 200])

# --- causal ATR terciles (trailing 250d of atr14_prior) ---
atr = np.array([meta.at[d, "atr14_prior"] if d in meta.index else np.nan
                for d in days_all], float)
atr_top = np.zeros(D, bool); atr_known = np.zeros(D, bool)
for i in range(D):
    w = atr[max(0, i - 250):i]; w = w[~np.isnan(w)]
    if len(w) >= 60 and not np.isnan(atr[i]):
        atr_known[i] = True
        atr_top[i] = atr[i] >= np.quantile(w, 2 / 3)

# --- roll / same-symbol day flags ---
def dflag(d, col, default=False):
    if d in meta.index:
        val = meta.at[d, col]
        return bool(val) if pd.notna(val) else default
    return default
roll_ok = np.array([dflag(d, "rth_same_sym") and not dflag(d, "roll_in_day", False)
                    for d in days_all])

# --- emit events: superset mult>=1.5 on eligible+base_ok days ---
rows = []
for di, dstr in enumerate(days_all):
    if not (elig[di] and base_ok[di]):
        continue
    base = et_base(dstr)
    n3, nb3 = net3[di], netb3[di]
    with np.errstate(invalid="ignore", divide="ignore"):
        mult = np.abs(n3) / nb3
    for m in range(5, 392):
        if not np.isfinite(mult[m]) or mult[m] < 1.5:
            continue
        v3 = vm3[di, m]
        if not np.isfinite(v3):
            continue
        rows.append((dstr, m, base + m * 60 + 59, base + (m + 1) * 60,
                     int(np.sign(n3[m])), round(float(mult[m]), 3),
                     round(float(v3), 3), round(float(mclose[di, m]), 2),
                     round(float(atr[di]), 1), bool(atr_top[di]),
                     bool(atr_known[di]), bool(roll_ok[di])))

ev = pd.DataFrame(rows, columns=["date", "m", "det_ts", "place_ts", "dir",
                                 "mult", "vm3", "det_close", "atr14",
                                 "atr_top", "atr_known", "roll_ok"])
ev.to_csv(f"{BASE}/B5-events.csv", index=False)
print(f"\neligible days={elig.sum()} base_ok={ (elig&base_ok).sum()}")
print(f"events (mult>=1.5): {len(ev)}")
print("mult>=2.0:", (ev.mult >= 2.0).sum(), " vm3>=1.5:", (ev.vm3 >= 1.5).sum(),
      " vm3>=2.5:", (ev.vm3 >= 2.5).sum(), " atr_top:", ev.atr_top.sum())
if len(ev):
    print("dir balance:", ev.dir.value_counts().to_dict())
    print("vm3 pctiles:", {q: round(float(np.percentile(ev.vm3, q)), 2)
                           for q in [10, 50, 90]})
