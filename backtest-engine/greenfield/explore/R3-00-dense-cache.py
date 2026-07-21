#!/usr/bin/env python3
"""
R3-00: dense (day x second-of-day) cache of the RTH 1s CSV.

Output R3-dense.npz:
  v    (D, 23580) float32  per-second volume, 0 where no trades
  c    (D, 23580) float32  close, forward-filled within day (bfilled at head)
  rng  (D, 23580) float32  high-low of the 1s bar, 0 where no trades
  days_str (D,) unicode    trade dates
  open_epoch (D,) int64    epoch of 09:28:00 ET
  first_s, last_s (D,) int32  first/last second index with a real row
Pure format conversion (zero-fill / ffill are declared conventions, no lookahead:
ffill uses only past values within the day).
"""
import json
import numpy as np
import pandas as pd
from datetime import datetime
from R3_common import BASE, ET, N_SEC

print("reading CSV...", flush=True)
df = pd.read_csv(f"{BASE}/cache_nq_rth_1s.csv",
                 dtype={"ts": np.int64, "o": np.float32, "h": np.float32,
                        "l": np.float32, "c": np.float32, "v": np.float32})
ts = df["ts"].to_numpy()
cc = df["c"].to_numpy()
vv = df["v"].to_numpy()
rr = (df["h"] - df["l"]).to_numpy()
del df

with open(f"{BASE}/cache_nq_rth_1s.days.json") as f:
    dayidx = json.load(f)
days = list(dayidx.keys())
D = len(days)
v = np.zeros((D, N_SEC), np.float32)
c = np.full((D, N_SEC), np.nan, np.float32)
rng = np.zeros((D, N_SEC), np.float32)
open_epoch = np.zeros(D, np.int64)
first_s = np.zeros(D, np.int32)
last_s = np.zeros(D, np.int32)

bad = 0
for i, d in enumerate(days):
    a, b = dayidx[d]
    y, m, dd = map(int, d.split("-"))
    oe = int(datetime(y, m, dd, 9, 28, tzinfo=ET).timestamp())
    open_epoch[i] = oe
    idx = (ts[a:b] - oe).astype(np.int64)
    ok = (idx >= 0) & (idx < N_SEC)
    if not ok.all():
        bad += int((~ok).sum())
        idx = idx[ok]
    v[i, idx] = vv[a:b][ok] if not ok.all() else vv[a:b]
    c[i, idx] = cc[a:b][ok] if not ok.all() else cc[a:b]
    rng[i, idx] = rr[a:b][ok] if not ok.all() else rr[a:b]
    first_s[i] = idx[0]
    last_s[i] = idx[-1]
print(f"days={D} out-of-window rows dropped={bad}", flush=True)

# forward-fill close within each day (past-only), then backfill the head
valid = ~np.isnan(c)
pos = np.where(valid, np.arange(N_SEC, dtype=np.int32)[None, :], np.int32(0))
np.maximum.accumulate(pos, axis=1, out=pos)
c = c[np.arange(D)[:, None], pos]
# heads before first trade: fill with first traded close
for i in range(D):
    if first_s[i] > 0:
        c[i, :first_s[i]] = c[i, first_s[i]]
assert not np.isnan(c).any()

np.savez(f"{BASE}/R3-dense.npz", v=v, c=c, rng=rng,
         days_str=np.array(days), open_epoch=open_epoch,
         first_s=first_s, last_s=last_s)
tot_v = float(v.sum())
print(f"saved R3-dense.npz  total volume={tot_v:,.0f} "
      f"mean nonzero-sec/day={(v > 0).sum() / D:,.0f}", flush=True)
