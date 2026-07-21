#!/usr/bin/env python3
"""
A1-03: When do the RTH session high and low form?
Descriptive distribution + by day type (day type classified AFTER the fact for
description only — clearly labeled; no predictive claim without knowable split).
"""
import numpy as np, pandas as pd
from a1_common import load_cache, build_daily

pd.set_option("display.width", 220)

dd = pd.read_csv("cache/NQ_daily_sessions.csv", parse_dates=["trade_date"])
dd = dd[dd["full_rth"]].copy()
print(f"full RTH days: {len(dd)}\n")

for col, name in [("rth_high_mod", "HIGH"), ("rth_low_mod", "LOW")]:
    m = dd[col] - 570  # minutes after 09:30
    b = pd.cut(m, [-1, 14, 29, 59, 89, 119, 179, 239, 299, 359, 389],
               labels=["0-15", "15-30", "30-60", "60-90", "90-120", "120-180", "180-240", "240-300", "300-360", "360-390"])
    t = b.value_counts(sort=False)
    print(f"=== Minute of RTH {name} (after 09:30) ===")
    print((t / len(dd)).round(3).to_string())
    print(f"P({name} in first 30m) = {(m < 30).mean():.3f}   P(in first 60m) = {(m < 60).mean():.3f}   P(in last 30m) = {(m >= 360).mean():.3f}\n")

first60_either = ((dd["rth_high_mod"] - 570 < 60) | (dd["rth_low_mod"] - 570 < 60))
first30_either = ((dd["rth_high_mod"] - 570 < 30) | (dd["rth_low_mod"] - 570 < 30))
both60 = ((dd["rth_high_mod"] - 570 < 60) & (dd["rth_low_mod"] - 570 < 60))
print(f"P(at least one RTH extreme set in first 30m) = {first30_either.mean():.3f}")
print(f"P(at least one RTH extreme set in first 60m) = {first60_either.mean():.3f}")
print(f"P(BOTH extremes in first 60m, i.e. rest of day inside) = {both60.mean():.3f}")

print("\nper-year P(one extreme in first 30m / 60m):")
for y, g in dd.groupby("year"):
    f30 = ((g["rth_high_mod"] - 570 < 30) | (g["rth_low_mod"] - 570 < 30)).mean()
    f60 = ((g["rth_high_mod"] - 570 < 60) | (g["rth_low_mod"] - 570 < 60)).mean()
    print(f"  {y}: 30m={f30:.3f} 60m={f60:.3f} n={len(g)}")

# ---- by day type (descriptive; day type uses full-day info) ----
dd["ret_atr"] = (dd["rth_close"] - dd["rth_open"]) / dd["atr14_prior"]
dd["close_pos"] = (dd["rth_close"] - dd["rth_low"]) / (dd["rth_high"] - dd["rth_low"])
trend_up = (dd["close_pos"] > 0.85) & (dd["rth_range"] / dd["atr14_prior"] > 0.8)
trend_dn = (dd["close_pos"] < 0.15) & (dd["rth_range"] / dd["atr14_prior"] > 0.8)
dd["day_type"] = np.select([trend_up, trend_dn], ["trend_up", "trend_dn"], "range")
print(f"\nday type counts: {dd['day_type'].value_counts().to_dict()}")
for ty, g in dd.groupby("day_type"):
    hm = g["rth_high_mod"] - 570; lm = g["rth_low_mod"] - 570
    print(f"{ty:9s} n={len(g)}: P(high first 60m)={ (hm<60).mean():.3f}  P(low first 60m)={(lm<60).mean():.3f}  "
          f"P(high last 30m)={(hm>=360).mean():.3f}  P(low last 30m)={(lm>=360).mean():.3f}")
