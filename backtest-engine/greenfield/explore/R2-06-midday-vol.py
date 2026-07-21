"""R2-06 (H5): Intraday vol-selling / overwriting footprint.

Mechanism: systematic option-selling programs (overwriting, 0DTE premium
selling) supply gamma that dealers hedge counter-directionally, damping
realized vol beyond the liquidity-driven U-shape - strongest midday when
event flow is absent. If real, midday suppression should scale with same-day
expiring OI (0DTE share, knowable pre-open) and weaken/break on high-vol days
(short-gamma regimes).

Metric: per-day suppression ratio S = median|1m ret| 12:00-13:29 divided by
median|1m ret| 10:00-10:59 (same day, so level effects cancel).
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from R2_common import EXP, load_1m, load_sessions, load_calendar, load_oi, tstat

df = load_1m("NQ", usecols=["et_date", "et_hhmm", "c", "symbol"])
s = load_sessions().set_index("trade_date")
days = set(s.index)
rth = df[(df["et_hhmm"] >= 930) & (df["et_hhmm"] <= 1559)
         & df["et_date"].isin(days)].copy()
c = rth["c"].to_numpy()
pts = np.full(len(rth), np.nan)
pts[1:] = c[1:] - c[:-1]
sym = rth["symbol"].to_numpy()
pts[1:][sym[1:] != sym[:-1]] = np.nan
rth["apts"] = np.abs(pts)
rth.loc[rth["et_hhmm"] == 930, "apts"] = np.nan  # crosses overnight gap
rth["atr"] = rth["et_date"].map(s["atr14_prior"])
rth["aret_atr"] = rth["apts"] / rth["atr"]

print("=== A. U-shape baseline: median |1m ret|/ATR by half-hour, per era ===")
rth["hh"] = (rth["et_hhmm"] // 100) * 100 + (rth["et_hhmm"] % 100 >= 30) * 30
rth["year"] = rth["et_date"].str[:4].astype(int)
rth["era"] = np.where(rth["year"] <= 2022, "2021-22",
                      np.where(rth["year"] <= 2024, "2023-24", "2025-26"))
print(rth.pivot_table(index="hh", columns="era", values="aret_atr",
                      aggfunc="median").round(4).to_string())

mid = rth[(rth["et_hhmm"] >= 1200) & (rth["et_hhmm"] <= 1329)]
morn = rth[(rth["et_hhmm"] >= 1000) & (rth["et_hhmm"] <= 1059)]
S = (mid.groupby("et_date")["aret_atr"].median() /
     morn.groupby("et_date")["aret_atr"].median()).rename("S")
d = s.join(S).join(load_calendar().set_index("trade_date")[["exp_class"]])
oi = load_oi()
if oi is not None:
    d = d.join(oi.set_index("date")[["dte0_share"]])
d = d[d["S"].notna()]

print("\n=== B. suppression ratio S by year (lower = deeper midday damping) ===")
print(d.groupby("year")["S"].agg(["median", "mean", "count"]).round(4).to_string())

print("\n=== C. S by 0DTE-share tercile (2023-03+), overall and per year ===")
if oi is not None:
    sub = d[d["dte0_share"].notna()].copy()
    sub["terc"] = pd.qcut(sub["dte0_share"], 3, labels=["lo", "mid", "hi"])
    print(sub.groupby("terc", observed=True)["S"].agg(["median", "count"]).round(4).to_string())
    for yr, g in sub.groupby("year"):
        if len(g) < 60:
            continue
        g = g.copy()
        g["terc"] = pd.qcut(g["dte0_share"], 3, labels=["lo", "mid", "hi"])
        m = g.groupby("terc", observed=True)["S"].median()
        print(f"  {yr}: lo={m.get('lo'):.4f} mid={m.get('mid'):.4f} "
              f"hi={m.get('hi'):.4f} (n={len(g)})")

print("\n=== D. does suppression break in high-vol regimes? S by atr_rel bucket ===")
d["vb"] = pd.qcut(d["atr_rel"], [0, .25, .5, .75, .9, 1.0],
                  labels=["q1", "q2", "q3", "q4", "top10%"])
print(d.groupby("vb", observed=True)["S"].agg(["median", "count"]).round(4).to_string())
print("--- per era ---")
d["era"] = np.where(d["year"] <= 2022, "2021-22",
                    np.where(d["year"] <= 2024, "2023-24", "2025-26"))
print(d.pivot_table(index="vb", columns="era", values="S",
                    aggfunc="median", observed=True).round(4).to_string())

print("\n=== E. midday ABS level (median |ret|/ATR 12:00-13:29) by 0DTE tercile"
      " within ATR terciles (2023+) ===")
if oi is not None:
    lvl = mid.groupby("et_date")["aret_atr"].median().rename("midlvl")
    d2 = d.join(lvl)
    sub = d2[d2["dte0_share"].notna()].copy()
    sub["atr_terc"] = pd.qcut(sub["atr_rel"], 3, labels=["loV", "midV", "hiV"])
    for at, g in sub.groupby("atr_terc", observed=True):
        g = g.copy()
        g["oterc"] = pd.qcut(g["dte0_share"], 3, labels=["lo0", "mid0", "hi0"])
        m = g.groupby("oterc", observed=True)["midlvl"].median()
        print(f"  {at}: lo0={m.get('lo0'):.4f} mid0={m.get('mid0'):.4f} "
              f"hi0={m.get('hi0'):.4f} (n={len(g)})")
