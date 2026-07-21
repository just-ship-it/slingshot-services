#!/usr/bin/env python3
"""
A1-04: Return autocorrelation & momentum/mean-reversion.
- Lag-1 autocorrelation of non-overlapping 1/5/15/30/60m returns, intraday only
  (both bars inside the same trade_date session, no roll in between).
- First-N-minutes RTH direction -> rest-of-day return (conditioning closes before
  outcome window starts: knowable).
- ON return -> RTH return; RTH return -> next ON; day t -> day t+1.
Per-year splits for everything.
"""
import numpy as np, pandas as pd
from a1_common import load_cache, build_daily, sign_stability

pd.set_option("display.width", 220)

df = load_cache("NQ")
dd = pd.read_csv("cache/NQ_daily_sessions.csv", parse_dates=["trade_date"])
dd = dd[dd["full_rth"]].copy()

# ---- intraday non-overlapping k-min return lag-1 AC (RTH only, same day, same symbol) ----
rth = df[df["session"] == "rth"].copy()
print("=== Lag-1 autocorrelation of non-overlapping k-min RTH returns ===")
print("(returns in ATR units per day via merge; corr is scale-free anyway)")
res = {}
for k in [1, 5, 15, 30, 60]:
    sub = rth[rth["mod"] % (5 if False else 1) == 0]
    g = rth[( (rth["mod"] - 570) % k == 0)][["trade_date", "year", "mod", "o", "c", "symbol"]].copy()
    # k-min bucket return: close of bucket - open of bucket needs last bar close; approximate with
    # open-to-open of consecutive bucket starts within same day (equivalent for AC purposes)
    g = g.sort_values(["trade_date", "mod"])
    g["ret"] = g["o"].shift(-1) - g["o"]
    g["ok"] = (g["trade_date"] == g["trade_date"].shift(-1)) & (g["symbol"] == g["symbol"].shift(-1))
    g = g[g["ok"]]
    g["ret_prev"] = g["ret"].shift(1)
    g["ok2"] = g["trade_date"].eq(g["trade_date"].shift(1))
    v = g[g["ok2"] & g["ret"].notna() & g["ret_prev"].notna()]
    ac_all = v["ret"].corr(v["ret_prev"])
    per_year = {y: gg["ret"].corr(gg["ret_prev"]) for y, gg in v.groupby("year") if len(gg) > 50}
    res[k] = (ac_all, len(v), per_year)
    ys = " ".join(f"{y}:{a:+.3f}" for y, a in per_year.items())
    print(f"k={k:3d}m: AC={ac_all:+.4f} n={len(v):7d}  {ys}  [{sign_stability(per_year.values())}]")

# ---- first-N RTH minutes -> rest of day ----
print("\n=== First-N-min RTH direction -> rest-of-day (N-min close -> 15:59 close) ===")
rth_by_day = {td: g for td, g in rth.groupby("trade_date")}
dd = dd.set_index("trade_date")
for N in [15, 30, 60]:
    rows = []
    for td, g in rth_by_day.items():
        if td not in dd.index or not dd.loc[td, "rth_same_sym"]:
            continue
        head = g[g["mod"] < 570 + N]
        if len(head) < N - 2 or len(g) < 300:
            continue
        c_n = head["c"].iloc[-1]; o = g["o"].iloc[0]; close = g["c"].iloc[-1]
        atr = dd.loc[td, "atr14_prior"]
        if not np.isfinite(atr):
            continue
        rows.append({"td": td, "year": td.year, "f": (c_n - o) / atr, "rest": (close - c_n) / atr})
    t = pd.DataFrame(rows)
    t["dir"] = np.sign(t["f"])
    cont = (np.sign(t["rest"]) == t["dir"]).mean()
    m_ali = (t["rest"] * t["dir"]).mean()
    corr = t["f"].corr(t["rest"])
    py = {y: (g["rest"] * g["dir"]).mean() for y, g in t.groupby("year")}
    ys = " ".join(f"{y}:{a:+.3f}" for y, a in py.items())
    print(f"N={N:2d}: n={len(t)} P(rest follows first-N dir)={cont:.3f}  mean aligned rest-ret={m_ali:+.4f} ATR  corr={corr:+.3f}")
    print(f"      per-year aligned: {ys}  [{sign_stability(py.values())}]")
    # magnitude split: strong first-N moves
    big = t[t["f"].abs() > t["f"].abs().median()]
    pyb = {y: (g["rest"] * g["dir"]).mean() for y, g in big.groupby("year")}
    print(f"      |f|>median: n={len(big)} P(cont)={(np.sign(big['rest'])==big['dir']).mean():.3f} "
          f"aligned={ (big['rest']*big['dir']).mean():+.4f}  [{sign_stability(pyb.values())}]")

# ---- first hour -> LAST hour (intraday momentum literature form) ----
print("\n=== First-60m direction -> last-60m return (15:00->15:59), gap day excluded/incl ===")
rows = []
for td, g in rth_by_day.items():
    if td not in dd.index or not dd.loc[td, "rth_same_sym"] or len(g) < 300:
        continue
    atr = dd.loc[td, "atr14_prior"]
    if not np.isfinite(atr):
        continue
    head = g[g["mod"] < 630]
    tail = g[g["mod"] >= 900]
    if len(head) < 55 or len(tail) < 55:
        continue
    f = (head["c"].iloc[-1] - g["o"].iloc[0]) / atr
    last = (tail["c"].iloc[-1] - tail["o"].iloc[0]) / atr
    mid = (tail["o"].iloc[0] - head["c"].iloc[-1]) / atr  # 10:30->15:00, also knowable at 15:00
    rows.append({"year": td.year, "f": f, "last": last, "mid": mid})
t = pd.DataFrame(rows)
for cond_col, label in [("f", "first60 dir -> last60"), ("mid", "10:30-15:00 dir -> last60")]:
    t["dir"] = np.sign(t[cond_col])
    aligned = (t["last"] * t["dir"]).mean()
    hit = (np.sign(t["last"]) == t["dir"]).mean()
    py = {y: (g["last"] * np.sign(g[cond_col])).mean() for y, g in t.groupby("year")}
    ys = " ".join(f"{y}:{a:+.3f}" for y, a in py.items())
    print(f"{label:28s} n={len(t)} hit={hit:.3f} aligned={aligned:+.4f} ATR  {ys} [{sign_stability(py.values())}]")

# ---- session-to-session ----
print("\n=== Session-to-session predictiveness (ATR units) ===")
d2 = dd.reset_index().copy()
d2["on_ret_atr"] = (d2["on_close"] - d2["on_open"]) / d2["atr14_prior"]
d2["rth_ret_atr"] = (d2["rth_close"] - d2["rth_open"]) / d2["atr14_prior"]
d2["next_on_ret_atr"] = d2["on_ret_atr"].shift(-1)
d2["next_rth_ret_atr"] = d2["rth_ret_atr"].shift(-1)
d2["next_same"] = d2["sym_rth_last"] == d2["sym_on_first"].shift(-1)

def rel(a, b, mask, label):
    v = d2[mask & d2[a].notna() & d2[b].notna()]
    corr = v[a].corr(v[b])
    aligned = (v[b] * np.sign(v[a])).mean()
    hit = (np.sign(v[b]) == np.sign(v[a])).mean()
    py = {y: (g[b] * np.sign(g[a])).mean() for y, g in v.groupby("year") if len(g) > 30}
    ys = " ".join(f"{y}:{x:+.3f}" for y, x in py.items())
    print(f"{label:28s} n={len(v)} corr={corr:+.3f} hit={hit:.3f} aligned={aligned:+.4f}  {ys} [{sign_stability(py.values())}]")

m_on_rth = d2["on_same_sym"] & d2["on_to_rth_same_sym"] & d2["rth_same_sym"]
rel("on_ret_atr", "rth_ret_atr", m_on_rth, "ON ret -> same-day RTH ret")
rel("rth_ret_atr", "next_on_ret_atr", d2["rth_same_sym"] & d2["next_same"], "RTH ret -> next ON ret")
rel("rth_ret_atr", "next_rth_ret_atr", d2["rth_same_sym"] & d2["next_same"], "RTH ret -> next RTH ret")
