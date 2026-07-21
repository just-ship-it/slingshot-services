"""R2-05 (H4): Time-locked micro-flow census - minute-of-day anomalies.

Mechanism: systematic hedging programs execute on clocks (auction windows,
MOC imbalance publication 15:50 ET, cash open/close, Europe open, futures
settlement window, maintenance-break reopen). If flows are one-directional on
average they leave signed drift at fixed minutes; if two-sided they leave only
vol/volume spikes (event vol = known, less interesting).

Bar stamped HHMM covers [HHMM, HHMM+1); its close-to-close return is the move
DURING that minute. Everything descriptive; per-year sign agreement mandatory.
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from R2_common import EXP, load_1m, load_sessions, assign_trade_date, tstat

df = load_1m("NQ")
s = load_sessions()
df = assign_trade_date(df, s["trade_date"].tolist())
df = df[df["trade_date"].notna()].copy()

# same-symbol 1m point change
c = df["c"].to_numpy()
pts = np.full(len(df), np.nan)
pts[1:] = c[1:] - c[:-1]
sym = df["symbol"].to_numpy()
pts[1:][sym[1:] != sym[:-1]] = np.nan
ts = pd.to_datetime(df["ts_utc"], utc=True).dt.tz_localize(None).to_numpy()
gap = np.full(len(df), np.nan)
gap[1:] = (ts[1:] - ts[:-1]) / np.timedelta64(1, "m")
pts[np.where(gap > 90)] = np.nan
df["pts"] = pts

atr = s.set_index("trade_date")["atr14_prior"]
df["atr"] = df["trade_date"].map(atr)
df = df[df["atr"].notna() & df["pts"].notna()].copy()
df["pts_atr"] = df["pts"] / df["atr"]
df["year"] = df["trade_date"].str[:4].astype(int)
dayvol = df.groupby("trade_date")["v"].transform("sum")
df["vshare"] = df["v"] / dayvol

print(f"bars: {len(df)}  days: {df['trade_date'].nunique()}")

g = df.groupby("et_hhmm")["pts_atr"]
tab = g.agg(["mean", "count", "std"])
tab["t"] = tab["mean"] / (tab["std"] / np.sqrt(tab["count"]))
tab["med_abs"] = df.groupby("et_hhmm")["pts_atr"].apply(lambda x: x.abs().median())
tab["vshare"] = df.groupby("et_hhmm")["vshare"].mean()
tab["mean_pts"] = df.groupby("et_hhmm")["pts"].mean()
tab.to_csv(os.path.join(EXP, "R2-minute-census.csv"))

# candidate signed-drift minutes: |t| >= 3.5 pooled (Bonferroni across ~1380
# minutes needs ~4.2 for p<.05; report both) + per-year sign agreement
cand = tab[(tab["t"].abs() >= 3.5) & (tab["count"] >= 800)].copy()
print(f"\n=== minutes with pooled |t|>=3.5 (n={len(cand)}) ===")
yr_means = df.pivot_table(index="et_hhmm", columns="year", values="pts_atr",
                          aggfunc="mean")
yr_n = df.pivot_table(index="et_hhmm", columns="year", values="pts_atr",
                      aggfunc="count")
for hm, row in cand.sort_values("t").iterrows():
    ym = yr_means.loc[hm]
    agree = (np.sign(ym.dropna()) == np.sign(row["mean"])).mean()
    yrs = " ".join(f"{y}:{v:+.4f}" for y, v in ym.items() if not np.isnan(v))
    print(f"  {hm:04d}: mean={row['mean']:+.5f} ({row['mean_pts']:+.2f}pts) "
          f"t={row['t']:+.1f} n={int(row['count'])} sign-agree={agree:.2f}")
    print(f"        {yrs}")

print("\n=== named windows: signed drift per year (ATR units, sum over window) ===")
WINDOWS = {
    "0200-0359_europe": (200, 359), "0830-0834_data": (830, 834),
    "0930-0934_open": (930, 934), "0935-0959": (935, 959),
    "1000-1004_data": (1000, 1004), "1400-1429": (1400, 1429),
    "1500-1529": (1500, 1529), "1530-1549": (1530, 1549),
    "1550-1559_moc": (1550, 1559), "1600-1614_settle": (1600, 1614),
    "1800-1804_reopen": (1800, 1804),
}
for name, (a, b) in WINDOWS.items():
    w = df[(df["et_hhmm"] >= a) & (df["et_hhmm"] <= b)]
    daily = w.groupby("trade_date")["pts_atr"].sum()
    yy = w.groupby(["trade_date"]).agg(x=("pts_atr", "sum")).reset_index()
    yy["year"] = yy["trade_date"].str[:4].astype(int)
    parts = []
    for yr, gg in yy.groupby("year"):
        t, n = tstat(gg["x"])
        parts.append(f"{yr}:{gg['x'].mean():+.4f}(t={t:+.1f})")
    t, n = tstat(yy["x"])
    print(f"  {name}: ALL={yy['x'].mean():+.4f} (t={t:+.1f}, n={n}) | " + " ".join(parts))

print("\n=== zoom: 10:40-11:05 shape (mean pts_atr per minute, pooled) ===")
z = tab.loc[(tab.index >= 1040) & (tab.index <= 1105),
            ["mean", "t", "count"]].round(5)
print(z.to_string())

print("\n=== vol/volume clock (context, known events): top-15 minutes by mean vshare ===")
print(tab.sort_values("vshare", ascending=False).head(15)[
    ["mean", "t", "med_abs", "vshare", "count"]].round(5).to_string())
