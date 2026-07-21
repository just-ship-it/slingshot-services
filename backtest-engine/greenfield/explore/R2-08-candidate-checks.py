"""R2-08: adversarial stability + generalization checks on R2 candidates.

C1. 15:00->15:30 day-move continuation (from R2-02): per-year sign agreement,
    robust (median) version, effect in points, ES generalization.
C2. Monthly-expiry morning weakness (from R2-03): per-year split + ES check.
C3. Minute-clock anomalies (from R2-05): same minutes on ES (independent
    market, same mechanism should show); monthly sign-consistency for 10:50.
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from R2_common import EXP, load_1m, load_sessions, load_calendar, tstat

s = load_sessions().set_index("trade_date")
cal = load_calendar().set_index("trade_date")
days = set(s.index)


def day_marks(sym):
    df = load_1m(sym, usecols=["et_date", "et_hhmm", "o", "c", "symbol"])
    df = df[df["et_date"].isin(days)]
    piv = df[df["et_hhmm"].isin([1459, 1529, 1559, 959, 1029])].pivot_table(
        index="et_date", columns="et_hhmm", values="c")
    piv["o0930"] = df[df["et_hhmm"] == 930].set_index("et_date")["o"]
    # symbol guard: RTH must be one symbol
    nsym = df[(df["et_hhmm"] >= 930) & (df["et_hhmm"] <= 1559)] \
        .groupby("et_date")["symbol"].nunique()
    piv = piv[nsym.reindex(piv.index) == 1]
    return piv


# ES daily ATR14-prior from its own RTH range
def es_atr():
    df = load_1m("ES", usecols=["et_date", "et_hhmm", "h", "l"])
    rth = df[(df["et_hhmm"] >= 930) & (df["et_hhmm"] <= 1559)]
    rng = rth.groupby("et_date").agg(h=("h", "max"), l=("l", "min"))
    tr = (rng["h"] - rng["l"])
    return tr.rolling(14).mean().shift(1)


nq = day_marks("NQ").join(s[["atr14_prior", "year", "atr_rel"]], how="inner")
es = day_marks("ES")
es = es.join(es_atr().rename("atr14_prior"), how="left").dropna()
es["year"] = pd.Series(es.index, index=es.index).str[:4].astype(int)

print("=== C1. 15:00->15:30 continuation ===")
for name, d in (("NQ", nq), ("ES", es)):
    d = d.copy()
    d["r15"] = (d[1459] - d["o0930"]) / d["atr14_prior"]
    d["cont"] = (d[1529] - d[1459]) / d["atr14_prior"]
    d["cont_pts"] = d[1529] - d[1459]
    d = d.dropna(subset=["r15", "cont"])
    d = d[d["r15"].abs() > 0.10]  # meaningful day move only
    d["agree"] = np.sign(d["cont"]) == np.sign(d["r15"])
    d["aligned_pts"] = d["cont_pts"] * np.sign(d["r15"])
    print(f"-- {name} (|day move|>0.10 ATR) --")
    for yr, g in d.groupby("year"):
        t, n = tstat(g["aligned_pts"])
        print(f"  {yr}: P(cont same sign)={g['agree'].mean():.3f}  "
              f"aligned pts mean={g['aligned_pts'].mean():+.2f} med="
              f"{g['aligned_pts'].median():+.2f} (t={t:+.1f}, n={n})")
    t, n = tstat(d["aligned_pts"])
    print(f"  ALL : P={d['agree'].mean():.3f}  aligned={d['aligned_pts'].mean():+.2f}pts"
          f" med={d['aligned_pts'].median():+.2f} (t={t:+.1f}, n={n})")

print("\n-- NQ by |day move| size (ATR buckets), pooled: aligned pts + P --")
d = nq.copy()
d["r15"] = (d[1459] - d["o0930"]) / d["atr14_prior"]
d["cont_pts"] = d[1529] - d[1459]
d["aligned_pts"] = d["cont_pts"] * np.sign(d["r15"])
d["agree"] = d["cont_pts"] * d["r15"] > 0
d["b"] = pd.cut(d["r15"].abs(), [0, .1, .3, .6, 1.0, np.inf],
                labels=["0-.1", ".1-.3", ".3-.6", ".6-1", ">1"])
print(d.groupby("b", observed=True).agg(P=("agree", "mean"),
      pts=("aligned_pts", "mean"), med=("aligned_pts", "median"),
      n=("agree", "count")).round(3).to_string())

print("\n-- NQ vol-state: aligned pts by atr_rel tercile x era --")
d["era"] = np.where(d["year"] <= 2022, "2021-22",
                    np.where(d["year"] <= 2024, "2023-24", "2025-26"))
d["vt"] = pd.qcut(d["atr_rel"], 3, labels=["loV", "midV", "hiV"])
sub = d[d["r15"].abs() > 0.10]
print(sub.pivot_table(index="vt", columns="era", values="aligned_pts",
                      aggfunc="mean", observed=True).round(2).to_string())
print(sub.pivot_table(index="vt", columns="era", values="agree",
                      aggfunc="mean", observed=True).round(3).to_string())

print("\n=== C2. monthly-expiry morning drift (09:30->10:30), per year ===")
for name, d in (("NQ", nq), ("ES", es)):
    d = d.copy().join(cal[["exp_class"]])
    d["morn"] = (d[1029] - d["o0930"]) / d["atr14_prior"]
    for cls in ("monthly", "quarterly", "weekly_fri"):
        g = d[d["exp_class"] == cls].dropna(subset=["morn"])
        yrs = " ".join(f"{yy}:{gg['morn'].mean():+.3f}(n={len(gg)})"
                       for yy, gg in g.groupby("year"))
        t, n = tstat(g["morn"])
        print(f"  {name} {cls}: ALL={g['morn'].mean():+.4f}(t={t:+.1f},n={n}) | {yrs}")

print("\n=== C3. minute-clock anomalies on ES (same minutes as NQ census) ===")
MINUTES = [1050, 927, 949, 1100, 2300, 325, 1613, 1557, 1830, 532, 1312]
df = load_1m("ES", usecols=["ts_utc", "et_date", "et_hhmm", "c", "symbol"])
from R2_common import assign_trade_date
df = assign_trade_date(df, sorted(days))
df = df[df["trade_date"].notna()].copy()
c = df["c"].to_numpy()
pts = np.full(len(df), np.nan)
pts[1:] = c[1:] - c[:-1]
sym = df["symbol"].to_numpy()
pts[1:][sym[1:] != sym[:-1]] = np.nan
df["pts"] = pts
ea = es_atr()
df["atr"] = df["trade_date"].map(ea)
df = df[df["atr"].notna() & df["pts"].notna()]
df["pa"] = df["pts"] / df["atr"]
df["year"] = df["trade_date"].str[:4].astype(int)
for hm in MINUTES:
    g = df[df["et_hhmm"] == hm]
    ym = g.groupby("year")["pa"].mean()
    t, n = tstat(g["pa"])
    yrs = " ".join(f"{y}:{v:+.4f}" for y, v in ym.items())
    print(f"  ES {hm:04d}: mean={g['pa'].mean():+.5f} (t={t:+.1f}, n={n}) | {yrs}")

print("\n-- NQ 10:50 monthly sign consistency --")
nq1m = load_1m("NQ", usecols=["et_date", "et_hhmm", "c", "symbol"])
nq1m = nq1m[nq1m["et_date"].isin(days)]
g = nq1m[nq1m["et_hhmm"].isin([1049, 1050])].pivot_table(
    index="et_date", columns="et_hhmm", values="c")
g["chg"] = g[1050] - g[1049]
g["ym"] = pd.Series(g.index, index=g.index).str[:7]
mm = g.groupby("ym")["chg"].mean()
print(f"  months negative: {(mm < 0).sum()}/{len(mm)}  "
      f"mean monthly chg={mm.mean():+.2f}pts")
