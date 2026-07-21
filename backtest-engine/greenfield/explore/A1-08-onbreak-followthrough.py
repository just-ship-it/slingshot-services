#!/usr/bin/env python3
"""
A1-08: After RTH first breaks an overnight extreme, what happens?
Conditioning: time + which extreme broke first (knowable at the break bar close).
Outcomes: P(RTH close beyond that extreme), P(other extreme also breaks later),
mean continuation from break-bar close to RTH close (ATR).
"""
import numpy as np, pandas as pd
from a1_common import load_cache, sign_stability

pd.set_option("display.width", 220)

df = load_cache("NQ")
dd = pd.read_csv("cache/NQ_daily_sessions.csv", parse_dates=["trade_date"])
dd = dd[dd["full_rth"]].set_index("trade_date")
rth = df[df["session"] == "rth"]
rth_by_day = {td: g for td, g in rth.groupby("trade_date")}

rows = []
for td, r in dd.iterrows():
    g = rth_by_day.get(td)
    if g is None or not r["rth_same_sym"] or not r["on_to_rth_same_sym"] or not np.isfinite(r["atr14_prior"]):
        continue
    hi_bars = g[g["h"] > r["on_high"]]; lo_bars = g[g["l"] < r["on_low"]]
    t_hi = hi_bars["mod"].iloc[0] if len(hi_bars) else 99999
    t_lo = lo_bars["mod"].iloc[0] if len(lo_bars) else 99999
    if t_hi == 99999 and t_lo == 99999:
        continue
    first_up = t_hi < t_lo
    t0 = min(t_hi, t_lo)
    lvl = r["on_high"] if first_up else r["on_low"]
    d = 1 if first_up else -1
    bbar = g[g["mod"] == t0]
    bclose = bbar["c"].iloc[0]
    close = g["c"].iloc[-1]
    other_broke = (t_lo if first_up else t_hi) != 99999
    rows.append({"year": td.year, "min_after_open": t0 - 570, "dir": d,
                 "cont_atr": (close - bclose) * d / r["atr14_prior"],
                 "close_beyond": (close - lvl) * d > 0,
                 "other_broke": other_broke,
                 "break_close_beyond": (bclose - lvl) * d > 0})
t = pd.DataFrame(rows)
print(f"days with an ON-extreme break: {len(t)}")
t["tb"] = pd.cut(t["min_after_open"], [-1, 15, 30, 60, 120, 240, 390],
                 labels=["0-15", "15-30", "30-60", "60-120", "120-240", "240+"])
tab = t.groupby("tb", observed=True).agg(n=("cont_atr", "size"),
                                         close_beyond=("close_beyond", "mean"),
                                         other_broke=("other_broke", "mean"),
                                         cont_atr=("cont_atr", "mean"))
print("\nBy time of FIRST ON-extreme break (minutes after 09:30):")
print(tab.to_string())

early = t[t["min_after_open"] < 30]
py = {y: g["cont_atr"].mean() for y, g in early.groupby("year")}
print("\nbreak in first 30m: cont_atr per-year:", " ".join(f"{y}:{a:+.3f}" for y, a in py.items()),
      f"[{sign_stability(py.values())}]")
pyc = {y: g["close_beyond"].mean() for y, g in early.groupby("year")}
print("P(close beyond) per-year:", " ".join(f"{y}:{a:.3f}" for y, a in pyc.items()))

late = t[(t["min_after_open"] >= 60) & (t["min_after_open"] < 240)]
py = {y: g["cont_atr"].mean() for y, g in late.groupby("year")}
print(f"\nbreak 60-240m (n={len(late)}): cont_atr per-year:", " ".join(f"{y}:{a:+.3f}" for y, a in py.items()),
      f"[{sign_stability(py.values())}]")
pyc = {y: g["close_beyond"].mean() for y, g in late.groupby("year")}
print("P(close beyond) per-year:", " ".join(f"{y}:{a:.3f}" for y, a in pyc.items()))

# up vs down asymmetry
for d, name in [(1, "first break = ON HIGH"), (-1, "first break = ON LOW")]:
    s = t[t["dir"] == d]
    py = {y: g["cont_atr"].mean() for y, g in s.groupby("year")}
    print(f"\n{name}: n={len(s)} close_beyond={s['close_beyond'].mean():.3f} cont={s['cont_atr'].mean():+.4f} "
          + " ".join(f"{y}:{a:+.3f}" for y, a in py.items()) + f" [{sign_stability(py.values())}]")
