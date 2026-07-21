#!/usr/bin/env python3
"""
R7-01: One streaming pass over the NQ 1m primary cache to extract, per trade_date,
the CLOSE price and SYMBOL at a fixed set of ET clock anchors, plus volume-spike
windows (08:30 macro, 14:00 FOMC) and an RTH avg-volume baseline.

NQ cache ts is UTC (verified: winter 14:30Z=09:30 EST, summer 13:30Z=09:30 EDT).
trade_date rolls at 18:00 ET (Globex). Symbol column carried so segments can be
same-symbol gated (never span a rollover -> phantom 200pt jumps).

Output: R7-nq-anchors.csv  (one row per trade_date)
"""
import pandas as pd, numpy as np

SRC = "cache_nq_primary_1m.csv"
OUT = "R7-nq-anchors.csv"

# ET hhmm anchors (hour*100+minute)
ANCHORS = [1800, 2000, 0, 400, 600, 830, 900, 915,
           930, 945, 1000, 1030, 1100, 1200, 1300, 1330,
           1400, 1430, 1500, 1515, 1530, 1545, 1600]

print("reading...")
df = pd.read_csv(SRC)
# parse UTC, convert to ET
ts = pd.to_datetime(df["ts"], format="%Y-%m-%dT%H:%M", utc=True)
et = ts.dt.tz_convert("America/New_York")
df["et_date"] = et.dt.strftime("%Y-%m-%d")
hh = et.dt.hour.to_numpy()
mm = et.dt.minute.to_numpy()
df["hhmm"] = hh * 100 + mm
# trade_date via 18:00 roll
roll = et + pd.to_timedelta(np.where(hh >= 18, 1, 0), unit="D")
df["trade_date"] = roll.dt.strftime("%Y-%m-%d")
df["_hh"] = hh

print("bars:", len(df))

# ---- anchor closes + symbols ----
amask = df["hhmm"].isin(ANCHORS)
adf = df.loc[amask, ["trade_date", "hhmm", "close", "symbol"]].drop_duplicates(
    subset=["trade_date", "hhmm"], keep="last")
close_p = adf.pivot(index="trade_date", columns="hhmm", values="close")
sym_p = adf.pivot(index="trade_date", columns="hhmm", values="symbol")
close_p = close_p.add_prefix("c_")
sym_p = sym_p.add_prefix("s_")

# ---- volume spike windows ----
def winvol(lo, hi):
    m = (df["hhmm"] >= lo) & (df["hhmm"] <= hi)
    return df.loc[m].groupby("trade_date")["volume"].sum()

vol0830 = winvol(830, 834).rename("vol0830_5m")   # 08:30-08:34
vol1400 = winvol(1400, 1404).rename("vol1400_5m") # 14:00-14:04
vol0930 = winvol(930, 934).rename("vol0930_5m")   # open ref

# RTH avg 1m volume baseline (09:30-15:59)
rthm = (df["hhmm"] >= 930) & (df["hhmm"] <= 1559)
grp = df.loc[rthm].groupby("trade_date")["volume"]
rthavg = (grp.sum() / grp.count()).rename("rth_avg1m_vol")

out = close_p.join(sym_p).join(vol0830).join(vol1400).join(vol0930).join(rthavg)
out.index.name = "trade_date"
out = out.reset_index()
out.to_csv(OUT, index=False)
print("wrote", OUT, "rows:", len(out))
print(out.columns.tolist())
