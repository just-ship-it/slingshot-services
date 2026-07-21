#!/usr/bin/env python3
"""
A1-01: Volatility & volume seasonality — hour-of-day ET, day-of-week, interaction.
Descriptive only. Range normalized by prior-14-day ATR (knowable) so years compare.
"""
import numpy as np, pandas as pd
from a1_common import load_cache, build_daily

pd.set_option("display.width", 200); pd.set_option("display.float_format", lambda x: f"{x:.4f}")

df = load_cache("NQ")
dd = build_daily(df)
atr = dd.set_index("trade_date")["atr14_prior"]
df = df.merge(atr.rename("atr"), left_on="trade_date", right_index=True, how="inner")
df = df[df["atr"].notna()].copy()
df["rng"] = df["h"] - df["l"]
df["rng_atr"] = df["rng"] / df["atr"]
df["hour_et"] = df["et_hhmm"] // 100

print(f"bars: {len(df)}, days: {df['trade_date'].nunique()}, span {df['et_date'].min()}..{df['et_date'].max()}\n")

# ---- Hour-of-day: range + volume ----
day_vol = df.groupby("trade_date")["v"].sum().rename("day_vol")
df = df.merge(day_vol, left_on="trade_date", right_index=True)
df["vshare"] = df["v"] / df["day_vol"]

h = df.groupby("hour_et").agg(
    n=("rng", "size"), rng_pts=("rng", "mean"), rng_atr=("rng_atr", "mean"),
    vshare_per_min=("vshare", "mean"))
h["hour_vshare"] = df.groupby(["trade_date", "hour_et"])["vshare"].sum().groupby("hour_et").mean()
print("=== Range & volume by ET hour (all years) ===")
print(h.to_string())

# per-year hour profile (rng_atr) to check stability
py = df.pivot_table(index="hour_et", columns="year", values="rng_atr", aggfunc="mean")
print("\n=== Mean 1m range / ATR14 by ET hour x year ===")
print(py.to_string())

# ---- Day-of-week (RTH only, full days) ----
full = set(dd[dd["full_rth"]]["trade_date"])
rth = df[(df["session"] == "rth") & (df["trade_date"].isin(full))]
ddf = dd[dd["full_rth"] & dd["atr14_prior"].notna() & dd["rth_same_sym"]].copy()
ddf["rth_range_atr"] = ddf["rth_range"] / ddf["atr14_prior"]
dw = ddf.groupby("dow").agg(n=("rth_range_atr", "size"), rth_range_pts=("rth_range", "mean"),
                            rth_range_atr=("rth_range_atr", "mean"), rth_vol=("rth_vol", "mean"))
print("\n=== RTH day range & volume by day-of-week (0=Mon) ===")
print(dw.to_string())
pyd = ddf.pivot_table(index="dow", columns="year", values="rth_range_atr", aggfunc="mean")
print("\nper-year RTH range/ATR by dow:")
print(pyd.to_string())

# ---- Hour x DOW interaction (RTH hours, rng_atr) ----
inter = rth[rth["atr"].notna()].pivot_table(index="hour_et", columns="dow", values="rng_atr", aggfunc="mean")
print("\n=== RTH: mean 1m range/ATR by hour x dow ===")
print(inter.to_string())

# ---- Within-RTH minute profile (5m buckets) pooled + volume ----
rth5 = rth.copy(); rth5["m5"] = (rth5["mod"] // 5) * 5
prof = rth5.groupby("m5").agg(rng_atr=("rng_atr", "mean"), vshare=("vshare", "mean"), n=("rng", "size"))
prof.index = [f"{m//60:02d}:{m%60:02d}" for m in prof.index]
print("\n=== RTH 5-min profile: mean 1m range/ATR, mean per-min volume share ===")
print(prof.to_string())
