#!/usr/bin/env python3
"""
A1-09: Do the top NQ census candidates generalize to ES? (2021-01 .. 2026-01)
Tests: (1) gap-fill monotonicity, (2) ON-range compression -> RTH expansion &
ON-extreme break rates, (3) first-60m -> rest-of-day momentum, (4) intraday 15m
vol clustering, (5) timing of extremes.
"""
import numpy as np, pandas as pd
from a1_common import load_cache, build_daily, sign_stability

pd.set_option("display.width", 220)

df = load_cache("ES")
dd = build_daily(df)
dd = dd[dd["full_rth"] & dd["atr14_prior"].notna()].copy()
dd["prior_rth_close"] = dd["rth_close"].shift(1)
ok = dd["same_sym_prev_rth"] & dd["on_same_sym"] & dd["on_to_rth_same_sym"] & ~dd["roll_in_day"]
dd = dd[ok].copy()
dd["gap"] = dd["rth_open"] - dd["prior_rth_close"]
dd["gap_atr"] = dd["gap"] / dd["atr14_prior"]
dd["on_range_atr"] = dd["on_range"] / dd["atr14_prior"]
dd["rth_range_atr"] = dd["rth_range"] / dd["atr14_prior"]
print(f"ES usable days: {len(dd)} ({dd['trade_date'].min().date()}..{dd['trade_date'].max().date()})\n")

rth = df[df["session"] == "rth"]
rth_by_day = {td: g for td, g in rth.groupby("trade_date")}

# ---- 1. gap fill ----
filled, fill_min = [], []
for _, r in dd.iterrows():
    g = rth_by_day.get(r["trade_date"])
    tgt = r["prior_rth_close"]
    hit = g[g["l"] <= tgt] if r["gap"] > 0 else g[g["h"] >= tgt]
    filled.append(len(hit) > 0)
    fill_min.append(hit["mod"].iloc[0] - 570 if len(hit) else np.nan)
dd["gap_filled"] = filled; dd["fill_min"] = fill_min
dd["gap_bucket"] = pd.cut(dd["gap_atr"].abs(), [0, .05, .1, .2, .35, .6, 10],
                          labels=["0-.05", ".05-.1", ".1-.2", ".2-.35", ".35-.6", ">.6"])
print("=== ES gap fill rate by |gap| ATR bucket ===")
print(dd.groupby("gap_bucket", observed=True).agg(n=("gap_filled", "size"), fill_rate=("gap_filled", "mean"),
                                                  med_fill_min=("fill_min", "median")).to_string())
big = dd[dd["gap_atr"].abs() > 0.2]
print("per-year fill rate |gap|>0.2 ATR:", {y: round(g["gap_filled"].mean(), 3) for y, g in big.groupby("year")})

# ---- 2. ON-range tercile -> RTH range + break rates ----
dd["on_rng_terc"] = dd.groupby("year")["on_range_atr"].transform(lambda s: pd.qcut(s, 3, labels=["low", "mid", "high"]))
brk_hi, brk_lo = [], []
for _, r in dd.iterrows():
    g = rth_by_day.get(r["trade_date"])
    brk_hi.append((g["h"] > r["on_high"]).any()); brk_lo.append((g["l"] < r["on_low"]).any())
dd["brk_hi"], dd["brk_lo"] = brk_hi, brk_lo
t = dd.groupby("on_rng_terc", observed=True).agg(n=("rth_range_atr", "size"), rth_range_atr=("rth_range_atr", "mean"),
                                                 brk_hi=("brk_hi", "mean"), brk_lo=("brk_lo", "mean"),
                                                 both=("brk_hi", lambda s: (dd.loc[s.index, "brk_lo"] & s).mean()))
print("\n=== ES ON-range tercile -> RTH range & ON-extreme breaks ===")
print(t.to_string())
print(f"overall: brk_hi={dd['brk_hi'].mean():.3f} brk_lo={dd['brk_lo'].mean():.3f} "
      f"neither={((~dd['brk_hi']) & (~dd['brk_lo'])).mean():.3f}")
py = {y: g[g["on_rng_terc"] == "low"]["rth_range_atr"].mean() - g[g["on_rng_terc"] == "high"]["rth_range_atr"].mean()
      for y, g in dd.groupby("year")}
print("per-year (low-terc minus high-terc RTH range/ATR):", " ".join(f"{y}:{a:+.3f}" for y, a in py.items()),
      f"[{sign_stability(py.values())}]")

# ---- 3. first-60m -> rest of day ----
ddi = dd.set_index("trade_date")
rows = []
for td, g in rth_by_day.items():
    if td not in ddi.index or not ddi.loc[td, "rth_same_sym"] or len(g) < 300:
        continue
    atr = ddi.loc[td, "atr14_prior"]
    head = g[g["mod"] < 630]
    if len(head) < 55 or not np.isfinite(atr):
        continue
    c60 = head["c"].iloc[-1]; o = g["o"].iloc[0]
    rows.append({"year": td.year, "f": (c60 - o) / atr, "rest": (g["c"].iloc[-1] - c60) / atr})
t = pd.DataFrame(rows)
t["dir"] = np.sign(t["f"])
py = {y: (g["rest"] * np.sign(g["f"])).mean() for y, g in t.groupby("year")}
print(f"\n=== ES first-60m dir -> rest-of-day ===\nn={len(t)} hit={(np.sign(t['rest'])==t['dir']).mean():.3f} "
      f"aligned={(t['rest']*t['dir']).mean():+.4f} ATR  "
      + " ".join(f"{y}:{a:+.3f}" for y, a in py.items()) + f" [{sign_stability(py.values())}]")

# ---- 4. intraday 15m vol clustering ----
r2 = rth.copy(); r2["b15"] = (r2["mod"] - 570) // 15
g15 = r2.groupby(["trade_date", "b15"]).agg(hi=("h", "max"), lo=("l", "min"), year=("year", "first")).reset_index()
g15["rng"] = g15["hi"] - g15["lo"]
g15["rng_n"] = g15["rng"] / g15.groupby(["year", "b15"])["rng"].transform("median")
g15 = g15.sort_values(["trade_date", "b15"])
g15["prev"] = g15["rng_n"].shift(1)
vv = g15[g15["trade_date"].eq(g15["trade_date"].shift(1))]
py = {y: g["rng_n"].corr(g["prev"]) for y, g in vv.groupby("year")}
print(f"\n=== ES intraday 15m range clustering === corr={vv['rng_n'].corr(vv['prev']):+.3f} n={len(vv)}  "
      + " ".join(f"{y}:{a:+.3f}" for y, a in py.items()) + f" [{sign_stability(py.values())}]")

# ---- 5. timing of extremes ----
f30 = ((ddi["rth_high_mod"] - 570 < 30) | (ddi["rth_low_mod"] - 570 < 30)).mean()
f60 = ((ddi["rth_high_mod"] - 570 < 60) | (ddi["rth_low_mod"] - 570 < 60)).mean()
print(f"\n=== ES timing === P(one RTH extreme in first 30m)={f30:.3f}, first 60m={f60:.3f} (n={len(ddi)})")
