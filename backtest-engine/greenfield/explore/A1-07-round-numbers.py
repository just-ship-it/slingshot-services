#!/usr/bin/env python3
"""
A1-07: Round-number interaction with placebo control.
Grids: multiples of 100 (true), plus placebo offsets (+23, +41, +59, +77 pts),
plus coarser 250/500/1000-pt multiples (500 offset +137 as its placebo).
Event: FIRST touch of a grid level per trade day (RTH only), approach direction
from previous bar close. Outcome from touch-bar CLOSE (knowable): penetration
(close_t+k - level) * approach_dir in ATR units at k = 15, 30 min, and
P(price is beyond level at +30m). A level "effect" must differ from placebo.
Raw contract prices (levels live in traded-price space).
"""
import numpy as np, pandas as pd
from a1_common import load_cache, sign_stability

pd.set_option("display.width", 220)

df = load_cache("NQ")
dd = pd.read_csv("cache/NQ_daily_sessions.csv", parse_dates=["trade_date"])
atr = dd.set_index("trade_date")["atr14_prior"]
df = df.merge(atr.rename("atr"), left_on="trade_date", right_index=True, how="left")
rth = df[(df["session"] == "rth") & df["atr"].notna()].copy().sort_values("ts_utc").reset_index(drop=True)
rth["prev_c"] = rth.groupby("trade_date")["c"].shift(1)
rth["prev_sym_ok"] = rth.groupby("trade_date")["symbol"].shift(1).eq(rth["symbol"])
for k in [15, 30]:
    fc = rth.groupby("trade_date")["c"].shift(-k)
    fs = rth.groupby("trade_date")["symbol"].shift(-k)
    rth[f"fc{k}"] = np.where(fs.eq(rth["symbol"]), fc, np.nan)

def grid_events(g, spacing, offset):
    """First touch per (day, level). Returns DataFrame of events."""
    lo_i = np.ceil((g["l"] - offset) / spacing)
    hi_i = np.floor((g["h"] - offset) / spacing)
    touch = (hi_i >= lo_i) & (hi_i == lo_i)  # exactly one level inside bar
    e = g[touch & g["prev_sym_ok"] & g["prev_c"].notna()].copy()
    e["level"] = lo_i[touch & g["prev_sym_ok"] & g["prev_c"].notna()] * spacing + offset
    e = e[e["prev_c"] != e["level"]]
    e["dir"] = np.sign(e["level"] - e["prev_c"])  # +1 approaching from below
    e = e.drop_duplicates(subset=["trade_date", "level"], keep="first")
    for k in [15, 30]:
        e[f"pen{k}"] = (e[f"fc{k}"] - e["level"]) * e["dir"] / e["atr"]
    e["beyond30"] = np.where(e["fc30"].notna(), ((e["fc30"] - e["level"]) * e["dir"]) > 0, np.nan)
    return e

def summarize(name, e):
    v = e[e["pen30"].notna()]
    py = {y: g["pen30"].mean() for y, g in v.groupby("year") if len(g) > 60}
    ys = " ".join(f"{y}:{a:+.4f}" for y, a in py.items())
    print(f"{name:14s} n={len(v):6d} pen15={v['pen15'].mean():+.4f} pen30={v['pen30'].mean():+.4f} "
          f"P(beyond@30m)={v['beyond30'].mean():.3f}  {ys} [{sign_stability(py.values())}]")
    return v["pen30"].mean(), v["beyond30"].mean(), len(v)

print("pen = (close[t+k] - level)*approach_dir / ATR; >0 = pass-through, <0 = rejection\n")
print("=== 100-pt grid: true vs placebo offsets ===")
res = {}
res["true+0"] = summarize("100s (true)", grid_events(rth, 100, 0))
for off in [23, 41, 59, 77]:
    res[f"off+{off}"] = summarize(f"100s +{off}", grid_events(rth, 100, off))

print("\n=== Coarser grids ===")
summarize("250s (true)", grid_events(rth, 250, 0))
summarize("500s (true)", grid_events(rth, 500, 0))
summarize("500s +137", grid_events(rth, 500, 137))
summarize("1000s (true)", grid_events(rth, 1000, 0))
summarize("1000s +413", grid_events(rth, 1000, 413))

# Also: does price stall NEAR round numbers? distribution of 1m closes mod 100
print("\n=== Close-price clustering: distribution of RTH close mod 100 (2-pt bins, uniform=2%) ===")
m = (rth["c"] % 100 // 2 * 2).astype(int)
freq = m.value_counts(normalize=True).sort_index()
top = freq.sort_values(ascending=False).head(5)
bot = freq.sort_values().head(3)
print("top bins:", {int(k): round(v * 100, 2) for k, v in top.items()}, "| bottom:", {int(k): round(v * 100, 2) for k, v in bot.items()})
print(f"bin [0,2) freq = {freq.get(0, 0)*100:.2f}% vs uniform 2.00%")
