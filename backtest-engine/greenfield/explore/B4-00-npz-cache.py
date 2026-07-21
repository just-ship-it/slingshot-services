#!/usr/bin/env python3
"""B4 helper: one-time npz cache of the RTH 1s CSV for fast repeated loading.
Pure format conversion — no data transformation."""
import json
import numpy as np
import pandas as pd

BASE = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
OUT = f"{BASE}/cache_nq_rth_1s.npz"

df = pd.read_csv(f"{BASE}/cache_nq_rth_1s.csv",
                 dtype={"ts": np.int64, "o": np.float64, "h": np.float64,
                        "l": np.float64, "c": np.float64, "v": np.int64})
np.savez(OUT, ts=df["ts"].to_numpy(), o=df["o"].to_numpy(), h=df["h"].to_numpy(),
         l=df["l"].to_numpy(), c=df["c"].to_numpy())
print("rows:", len(df), "->", OUT)
# sanity: monotone ts within each day range
with open(f"{BASE}/cache_nq_rth_1s.days.json") as f:
    dayidx = json.load(f)
ts = df["ts"].to_numpy()
bad = 0
for d, (a, b) in dayidx.items():
    if np.any(np.diff(ts[a:b]) <= 0):
        bad += 1
print("days with non-monotone ts:", bad, "days:", len(dayidx))
