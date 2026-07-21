#!/usr/bin/env python3
"""
A1-02: Session structure — overnight vs RTH ranges, RTH gap stats (open vs prior
RTH close): distribution, fill frequency by size, time-to-fill; ON high/low breaks.
All conditioning info (gap size, ON range, ON extremes) is knowable at 09:30 ET.
Outcomes are measured in the RTH window that follows. Roll days excluded from
cross-session price comparisons.
"""
import numpy as np, pandas as pd
from a1_common import load_cache, build_daily

pd.set_option("display.width", 220)

df = load_cache("NQ")
dd = build_daily(df)
dd = dd[dd["full_rth"] & dd["atr14_prior"].notna()].copy()

# prior RTH close (same symbol only)
dd["prior_rth_close"] = dd["rth_close"].shift(1)
dd["prior_td"] = dd["trade_date"].shift(1)
ok = dd["same_sym_prev_rth"] & dd["on_same_sym"] & dd["on_to_rth_same_sym"] & ~dd["roll_in_day"]
dd = dd[ok].copy()
dd["gap"] = dd["rth_open"] - dd["prior_rth_close"]
dd["gap_atr"] = dd["gap"] / dd["atr14_prior"]
dd["on_range_atr"] = dd["on_range"] / dd["atr14_prior"]
dd["rth_range_atr"] = dd["rth_range"] / dd["atr14_prior"]
dd["on_ret"] = dd["on_close"] - dd["on_open"]
dd["rth_ret"] = dd["rth_close"] - dd["rth_open"]

print(f"days usable: {len(dd)} ({dd['trade_date'].min().date()}..{dd['trade_date'].max().date()})\n")

# ---- ON vs RTH range relationship ----
print("=== ON vs RTH range (ATR units) ===")
print(dd[["on_range_atr", "rth_range_atr"]].describe().loc[["mean", "50%", "std"]].to_string())
print(f"corr(on_range_atr, rth_range_atr) = {dd['on_range_atr'].corr(dd['rth_range_atr']):.3f}  n={len(dd)}")
for y, g in dd.groupby("year"):
    print(f"  {y}: corr={g['on_range_atr'].corr(g['rth_range_atr']):.3f} n={len(g)}")

# ON range terciles -> RTH range (conditioning knowable at 09:30)
dd["on_rng_terc"] = dd.groupby("year")["on_range_atr"].transform(
    lambda s: pd.qcut(s, 3, labels=["low", "mid", "high"]))
t = dd.groupby("on_rng_terc", observed=True).agg(n=("rth_range_atr", "size"),
                                                 rth_range_atr=("rth_range_atr", "mean"),
                                                 rth_abs_ret_atr=("rth_ret", lambda s: (s.abs() / dd.loc[s.index, "atr14_prior"]).mean()))
print("\nON-range tercile (per-year terciles) -> RTH range:")
print(t.to_string())

# ---- Gap stats ----
print("\n=== Gap (RTH open - prior RTH close) ===")
g = dd["gap_atr"]
print(f"n={len(g)} mean={g.mean():.4f} med={g.median():.4f} std={g.std():.4f} |gap| med={g.abs().median():.4f} ATR")
print(f"pts: mean={dd['gap'].mean():.1f} med={dd['gap'].median():.1f} |gap| med={dd['gap'].abs().median():.1f}")
print("gap_atr quantiles:", {q: round(g.quantile(q), 3) for q in [.05, .25, .5, .75, .95]})

# gap fill: first RTH bar touching prior_rth_close
rth = df[df["session"] == "rth"][["trade_date", "mod", "h", "l", "c"]]
rth_by_day = {td: gg for td, gg in rth.groupby("trade_date")}
fill_min, filled = [], []
for _, r in dd.iterrows():
    gg = rth_by_day.get(r["trade_date"])
    tgt = r["prior_rth_close"]
    if r["gap"] > 0:
        hit = gg[gg["l"] <= tgt]
    else:
        hit = gg[gg["h"] >= tgt]
    if len(hit):
        filled.append(True); fill_min.append(hit["mod"].iloc[0] - 570)  # minutes after 09:30
    else:
        filled.append(False); fill_min.append(np.nan)
dd["gap_filled"] = filled
dd["fill_min"] = fill_min

dd["gap_bucket"] = pd.cut(dd["gap_atr"].abs(), [0, .05, .1, .2, .35, .6, 10],
                          labels=["0-.05", ".05-.1", ".1-.2", ".2-.35", ".35-.6", ">.6"])
fb = dd.groupby("gap_bucket", observed=True).agg(
    n=("gap_filled", "size"), fill_rate=("gap_filled", "mean"),
    med_fill_min=("fill_min", "median"))
print("\nGap fill rate by |gap| (ATR) bucket (fill = touch prior RTH close during RTH):")
print(fb.to_string())
print("\nper-year fill rate, |gap| ATR > 0.2:")
big = dd[dd["gap_atr"].abs() > 0.2]
print(big.groupby("year")["gap_filled"].agg(["mean", "size"]).to_string())
print("\nper-year fill rate, |gap| ATR <= 0.1:")
small = dd[dd["gap_atr"].abs() <= 0.1]
print(small.groupby("year")["gap_filled"].agg(["mean", "size"]).to_string())

# gap direction vs RTH return (gap-and-go vs fade)
dd["gap_dir"] = np.sign(dd["gap"])
dd["rth_ret_atr"] = dd["rth_ret"] / dd["atr14_prior"]
print("\nRTH return (ATR) conditioned on gap direction & size:")
rows = []
for (b, d), s in dd[dd["gap_dir"] != 0].groupby(["gap_bucket", "gap_dir"], observed=True):
    rows.append({"gap_bucket": b, "gap_dir": d, "n": len(s),
                 "mean_rth_ret_atr": s["rth_ret_atr"].mean(), "med": s["rth_ret_atr"].median(),
                 "pct_continue": (np.sign(s["rth_ret"]) == s["gap_dir"]).mean()})
cond = pd.DataFrame(rows).set_index(["gap_bucket", "gap_dir"])
print(cond.to_string())
# per-year: does big gap fade or go?
print("\nper-year mean RTH ret (ATR) x gap dir, |gap|>0.2 ATR:")
big2 = dd[dd["gap_atr"].abs() > 0.2]
print(big2.groupby(["year", "gap_dir"])["rth_ret_atr"].agg(["mean", "size"]).to_string())

# ---- ON high/low breaks ----
brk_hi, brk_lo, hi_min, lo_min = [], [], [], []
for _, r in dd.iterrows():
    gg = rth_by_day.get(r["trade_date"])
    hh = gg[gg["h"] > r["on_high"]]; ll = gg[gg["l"] < r["on_low"]]
    brk_hi.append(len(hh) > 0); brk_lo.append(len(ll) > 0)
    hi_min.append(hh["mod"].iloc[0] - 570 if len(hh) else np.nan)
    lo_min.append(ll["mod"].iloc[0] - 570 if len(ll) else np.nan)
dd["brk_hi"], dd["brk_lo"] = brk_hi, brk_lo
dd["hi_min"], dd["lo_min"] = hi_min, lo_min
both = dd["brk_hi"] & dd["brk_lo"]; neither = ~dd["brk_hi"] & ~dd["brk_lo"]
print("\n=== RTH vs overnight extremes ===")
print(f"n={len(dd)} break ON-high: {dd['brk_hi'].mean():.3f}  break ON-low: {dd['brk_lo'].mean():.3f}  "
      f"both: {both.mean():.3f}  neither(inside day): {neither.mean():.3f}")
print(f"median minutes to first ON-high break: {dd['hi_min'].median():.0f}, ON-low: {dd['lo_min'].median():.0f}")
print("\nper-year break rates:")
print(dd.groupby("year").agg(brk_hi=("brk_hi", "mean"), brk_lo=("brk_lo", "mean"),
                             both=("brk_hi", lambda s: (dd.loc[s.index, "brk_lo"] & s).mean()),
                             n=("brk_hi", "size")).to_string())
# conditioned on ON range: does a wide ON session contain RTH?
t2 = dd.groupby("on_rng_terc", observed=True).agg(n=("brk_hi", "size"), brk_hi=("brk_hi", "mean"),
                                                  brk_lo=("brk_lo", "mean"),
                                                  both=("brk_hi", lambda s: (dd.loc[s.index, "brk_lo"] & s).mean()))
print("\nbreak rates by ON-range tercile:")
print(t2.to_string())

dd.to_csv("cache/NQ_daily_sessions.csv", index=False)
print("\nsaved cache/NQ_daily_sessions.csv")
