#!/usr/bin/env python3
"""
A1-05: Volatility dynamics.
- Daily range persistence (range/ATR lag-1 AC); NR7 compression -> next-day expansion.
- Intraday vol clustering: 15m realized-range AC within RTH.
- Trend-day frequency + EARLY signatures (signature measured strictly BEFORE the
  outcome window: signature uses bars closing <= 10:30; outcome = 10:30 -> close).
"""
import numpy as np, pandas as pd
from a1_common import load_cache, sign_stability

pd.set_option("display.width", 220)

df = load_cache("NQ")
dd = pd.read_csv("cache/NQ_daily_sessions.csv", parse_dates=["trade_date"])
dd = dd[dd["full_rth"]].copy().sort_values("trade_date").reset_index(drop=True)
dd["rng_atr"] = dd["day_range"] / dd["atr14_prior"]

# ---- daily range persistence ----
dd["rng_atr_prev"] = dd["rng_atr"].shift(1)
v = dd.dropna(subset=["rng_atr", "rng_atr_prev"])
print("=== Daily range/ATR persistence ===")
print(f"lag-1 corr = {v['rng_atr'].corr(v['rng_atr_prev']):+.3f} n={len(v)}")
py = {y: g["rng_atr"].corr(g["rng_atr_prev"]) for y, g in v.groupby("year")}
print("  per-year:", " ".join(f"{y}:{a:+.3f}" for y, a in py.items()), f"[{sign_stability(py.values())}]")

# NR7: today's day_range smallest of last 7 (knowable at 16:00 close) -> next day range
dd["nr7"] = dd["day_range"] == dd["day_range"].rolling(7).min()
dd["next_rng_atr"] = dd["rng_atr"].shift(-1)
dd["next_abs_ret_atr"] = ((dd["rth_close"] - dd["rth_open"]).abs() / dd["atr14_prior"]).shift(-1)
n7 = dd.dropna(subset=["next_rng_atr"])
print("\nNR7 (narrowest range of last 7) -> next-day range/ATR:")
a = n7[n7["nr7"] == True]; b = n7[n7["nr7"] == False]
print(f"  NR7 days: n={len(a)} next rng/ATR={a['next_rng_atr'].mean():.3f} | non-NR7: n={len(b)} {b['next_rng_atr'].mean():.3f}  ratio={a['next_rng_atr'].mean()/b['next_rng_atr'].mean():.3f}")
py = {}
for y, g in n7.groupby("year"):
    ga, gb = g[g["nr7"]], g[~g["nr7"]]
    if len(ga) > 5:
        py[y] = ga["next_rng_atr"].mean() - gb["next_rng_atr"].mean()
print("  per-year diff (NR7 - non):", " ".join(f"{y}:{a:+.3f}" for y, a in py.items()), f"[{sign_stability(py.values())}]")

# ---- intraday vol clustering: 15m realized range AC within day ----
rth = df[df["session"] == "rth"].copy()
rth["b15"] = (rth["mod"] - 570) // 15
g15 = rth.groupby(["trade_date", "b15"]).agg(hi=("h", "max"), lo=("l", "min"), year=("year", "first")).reset_index()
g15["rng"] = g15["hi"] - g15["lo"]
# de-season: divide by bucket median (per year) to remove smile
g15["rng_n"] = g15["rng"] / g15.groupby(["year", "b15"])["rng"].transform("median")
g15 = g15.sort_values(["trade_date", "b15"])
g15["rng_n_prev"] = g15["rng_n"].shift(1)
ok = g15["trade_date"].eq(g15["trade_date"].shift(1))
vv = g15[ok]
print("\n=== Intraday 15m range clustering (de-seasoned, within-day lag-1) ===")
print(f"corr = {vv['rng_n'].corr(vv['rng_n_prev']):+.3f} n={len(vv)}")
py = {y: g["rng_n"].corr(g["rng_n_prev"]) for y, g in vv.groupby("year")}
print("  per-year:", " ".join(f"{y}:{a:+.3f}" for y, a in py.items()), f"[{sign_stability(py.values())}]")

# ---- trend days + early signatures ----
dd["close_pos"] = (dd["rth_close"] - dd["rth_low"]) / (dd["rth_high"] - dd["rth_low"])
dd["is_trend"] = (dd["close_pos"].sub(0.5).abs() > 0.35) & (dd["rth_range"] / dd["atr14_prior"] > 0.8)
print(f"\n=== Trend days (close in outer 15% of range AND range>0.8 ATR) ===")
print(f"frequency: {dd['is_trend'].mean():.3f} (n={len(dd)})")
print("per-year:", dd.groupby("year")["is_trend"].mean().round(3).to_dict())

# early signatures at 10:30 (knowable) -> outcome 10:30->close continuation
rth_by_day = {td: g for td, g in rth.groupby("trade_date")}
ddi = dd.set_index("trade_date")
rows = []
for td, g in rth_by_day.items():
    if td not in ddi.index or not ddi.loc[td, "rth_same_sym"] or len(g) < 300:
        continue
    atr = ddi.loc[td, "atr14_prior"]
    if not np.isfinite(atr):
        continue
    head = g[g["mod"] < 630]  # 09:30-10:29 bars, all closed by 10:30
    tail = g[g["mod"] >= 630]
    o = g["o"].iloc[0]; c1030 = head["c"].iloc[-1]
    h1 = head["h"].max(); l1 = head["l"].min(); r1 = h1 - l1
    rows.append({
        "td": td, "year": td.year, "atr": atr,
        "f60_rng_atr": r1 / atr,
        "drive": abs(c1030 - o) / r1 if r1 > 0 else 0,   # close-to-open dominance of 1st hour
        "pos_in_rng": (c1030 - l1) / r1 if r1 > 0 else .5, # where we sit in 1st-hour range
        "dir": np.sign(c1030 - o),
        "rest_aligned_atr": None, "rest_rng_atr": (g[g['mod']>=630]['h'].max() - g[g['mod']>=630]['l'].min()) / atr,
        "rest_ret": (tail["c"].iloc[-1] - c1030) / atr,
    })
t = pd.DataFrame(rows)
t["rest_aligned"] = t["rest_ret"] * t["dir"]
print("\n=== 10:30 signatures -> 10:30-close aligned continuation (ATR) ===")
print("(drive = |10:30 close - open| / first-hour range; pos = 10:30 close position in first-hour range)")
t["drive_q"] = pd.qcut(t["drive"], 4, labels=["q1", "q2", "q3", "q4(drive)"])
tab = t.groupby("drive_q", observed=True).agg(n=("rest_aligned", "size"),
                                              aligned=("rest_aligned", "mean"),
                                              hit=("rest_aligned", lambda s: (s > 0).mean()))
print(tab.to_string())
q4 = t[t["drive_q"] == "q4(drive)"]
py = {y: g["rest_aligned"].mean() for y, g in q4.groupby("year")}
print("q4 drive per-year aligned:", " ".join(f"{y}:{a:+.3f}" for y, a in py.items()), f"[{sign_stability(py.values())}]")

# first-hour range compression -> rest-of-day expansion?
t["f60_q"] = pd.qcut(t["f60_rng_atr"], 4, labels=["narrow", "q2", "q3", "wide"])
tab2 = t.groupby("f60_q", observed=True).agg(n=("rest_rng_atr", "size"), rest_rng=("rest_rng_atr", "mean"),
                                             rest_absret=("rest_ret", lambda s: s.abs().mean()))
print("\nfirst-hour range quartile -> rest-of-day range/|ret| (ATR):")
print(tab2.to_string())
nar = t[t["f60_q"] == "narrow"]; wid = t[t["f60_q"] == "wide"]
py = {y: t[(t["year"]==y) & (t["f60_q"]=="narrow")]["rest_rng_atr"].mean() - t[(t["year"]==y) & (t["f60_q"]=="wide")]["rest_rng_atr"].mean() for y in sorted(t["year"].unique())}
print("narrow-minus-wide rest range per-year:", " ".join(f"{y}:{a:+.3f}" for y, a in py.items()), f"[{sign_stability(py.values())}]")
