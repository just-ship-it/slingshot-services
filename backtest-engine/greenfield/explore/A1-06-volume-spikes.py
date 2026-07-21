#!/usr/bin/env python3
"""
A1-06: What follows abnormal 1m volume spikes?
Baseline is CAUSAL: per minute-of-day rolling median of the previous 20 same-minute
observations (shifted, never includes today). Spike ratio = v / baseline.
Outcomes: forward 5/15/30/60m returns from the spike bar CLOSE (knowable), signed by
spike-bar direction; plus forward absolute-return (vol persistence).
Climax context: spike bar making a 60m high/low (breakout) vs interior.
Sessions kept separate (RTH only for the main table; forward window must stay in-session
and same symbol).
"""
import numpy as np, pandas as pd
from a1_common import load_cache, sign_stability

pd.set_option("display.width", 220)

df = load_cache("NQ")
dd = pd.read_csv("cache/NQ_daily_sessions.csv", parse_dates=["trade_date"])
atr = dd.set_index("trade_date")["atr14_prior"]

df = df.sort_values(["ts_utc"]).reset_index(drop=True)
# causal same-minute baseline
df["v_base"] = df.groupby("mod")["v"].transform(lambda s: s.shift(1).rolling(20, min_periods=10).median())
df["spike"] = df["v"] / df["v_base"]
df = df.merge(atr.rename("atr"), left_on="trade_date", right_index=True, how="left")

rth = df[(df["session"] == "rth") & df["atr"].notna() & df["v_base"].notna()].copy().reset_index(drop=True)
rth["bar_dir"] = np.sign(rth["c"] - rth["o"])
# rolling 60m high/low BEFORE this bar (causal, prior 60 bars)
rth["hi60"] = rth.groupby("trade_date")["h"].transform(lambda s: s.shift(1).rolling(60, min_periods=15).max())
rth["lo60"] = rth.groupby("trade_date")["l"].transform(lambda s: s.shift(1).rolling(60, min_periods=15).min())
rth["breakout"] = np.where(rth["c"] > rth["hi60"], 1, np.where(rth["c"] < rth["lo60"], -1, 0))

# forward returns within same day & symbol
for k in [5, 15, 30, 60]:
    fc = rth.groupby("trade_date")["c"].shift(-k)
    fs = rth.groupby("trade_date")["symbol"].shift(-k)
    ok = fs.eq(rth["symbol"])
    rth[f"fret{k}"] = np.where(ok, (fc - rth["c"]) / rth["atr"], np.nan)

rth["spike_b"] = pd.cut(rth["spike"], [0, 2, 4, 8, 16, np.inf], labels=["<2", "2-4", "4-8", "8-16", ">16"])
print(f"RTH bars with baseline: {len(rth)}; spike distribution:")
print(rth["spike_b"].value_counts(sort=False).to_string())

print("\n=== Forward returns after volume spikes (ATR units), signed by spike-bar direction ===")
tab = rth[rth["bar_dir"] != 0].copy()
for k in [5, 15, 30, 60]:
    tab[f"al{k}"] = tab[f"fret{k}"] * tab["bar_dir"]
agg = tab.groupby("spike_b", observed=True).agg(
    n=("al15", "count"),
    al5=("al5", "mean"), al15=("al15", "mean"), al30=("al30", "mean"), al60=("al60", "mean"),
    abs15=("fret15", lambda s: s.abs().mean()))
print(agg.to_string())

big = tab[tab["spike"] >= 8]
py = {y: g["al30"].mean() for y, g in big.groupby("year") if g["al30"].notna().sum() > 100}
print(f"\nspike>=8, aligned 30m fwd per-year: ", " ".join(f"{y}:{a:+.4f}" for y, a in py.items()), f"[{sign_stability(py.values())}]")
pyv = {y: g["fret15"].abs().mean() / tab[tab["year"].eq(y) & (tab['spike']<2)]["fret15"].abs().mean()
       for y, g in big.groupby("year") if g["fret15"].notna().sum() > 100}
print("spike>=8 fwd |15m ret| vs quiet-bar |ret| ratio per-year:", " ".join(f"{y}:{a:.2f}" for y, a in pyv.items()))

print("\n=== Spike >= 8x split by context (breakout of prior-60m range vs interior) ===")
for ctx, name in [(0, "interior"), (1, "breakout-up"), (-1, "breakout-dn")]:
    s = big[big["breakout"] == ctx]
    if ctx == 0:
        al30 = (s["fret30"] * s["bar_dir"]).mean(); n = s["fret30"].notna().sum()
        py = {y: (g["fret30"] * g["bar_dir"]).mean() for y, g in s.groupby("year") if g["fret30"].notna().sum() > 50}
    else:
        al30 = (s["fret30"] * ctx).mean(); n = s["fret30"].notna().sum()
        py = {y: (g["fret30"] * ctx).mean() for y, g in s.groupby("year") if g["fret30"].notna().sum() > 30}
    ys = " ".join(f"{y}:{a:+.4f}" for y, a in py.items())
    print(f"{name:12s} n={n:6d} aligned fwd30={al30:+.4f} ATR  {ys} [{sign_stability(py.values())}]")

# extreme climax: spike>=16 at breakout
xx = tab[(tab["spike"] >= 16) & (tab["breakout"] != 0)]
al = (xx["fret30"] * xx["breakout"]).mean()
py = {y: (g["fret30"] * g["breakout"]).mean() for y, g in xx.groupby("year") if g["fret30"].notna().sum() > 20}
print(f"\nspike>=16 AT breakout: n={xx['fret30'].notna().sum()} aligned fwd30={al:+.4f} "
      + " ".join(f"{y}:{a:+.4f}" for y, a in py.items()) + f" [{sign_stability(py.values())}]")
