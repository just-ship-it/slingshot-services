"""R2-02 (H1): EOD re-hedge footprint.

Mechanism: dealers short gamma must BUY after up-moves / SELL after down-moves
to stay delta-neutral, concentrated into the close (gamma largest, and MOC/
auction liquidity). Long-gamma dealers do the opposite (damping). If dealer
gamma sign is systematic, the last hour return should be systematically
related to the day's move up to 15:00.

Knowability: day-move r15 uses the 14:59 bar close (knowable 15:00). Outcome =
15:00->16:00 (and sub-windows), strictly after. Conditioners (ATR, 0DTE share)
knowable pre-open.

Also (secondary): overnight-gap re-hedge - first-30m drift conditional on the
overnight gap (dealers re-hedge gap-induced delta at the open).
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from R2_common import EXP, load_1m, load_sessions, load_calendar, load_oi, tstat

df = load_1m("NQ")
s = load_sessions()
cal = load_calendar()
days = set(s["trade_date"])

rth = df[(df["et_hhmm"] >= 930) & (df["et_hhmm"] <= 1559) &
         (df["et_date"].isin(days))].copy()

# per-day key prices (guard: bar must exist)
def day_frame():
    g = rth.groupby("et_date")
    out = pd.DataFrame(index=sorted(rth["et_date"].unique()))
    piv_c = rth.pivot_table(index="et_date", columns="et_hhmm", values="c")
    piv_o = rth.pivot_table(index="et_date", columns="et_hhmm", values="o")
    out["o0930"] = piv_o.get(930)
    for hm in (959, 1459, 1514, 1529, 1544, 1549, 1554, 1559):
        out[f"c{hm}"] = piv_c.get(hm)
    v = rth.copy()
    out["v_rth"] = v.groupby("et_date")["v"].sum()
    out["v_last"] = v[v["et_hhmm"] >= 1500].groupby("et_date")["v"].sum()
    out["v_1550"] = v[v["et_hhmm"] >= 1550].groupby("et_date")["v"].sum()
    return out

d = day_frame().dropna(subset=["o0930", "c1459", "c1559"])
d = d.join(s.set_index("trade_date")[["year", "atr14_prior", "atr_rel", "gap",
                                      "gap_atr", "dow"]], how="inner")
d = d.join(cal.set_index("trade_date")[["exp_class", "me_t"]], how="left")
oi = load_oi()
if oi is not None:
    d = d.join(oi.set_index("date")[["dte0_share", "total_oi"]], how="left")

d["r15"] = d["c1459"] - d["o0930"]
d["r15_atr"] = d["r15"] / d["atr14_prior"]
d["rlast"] = d["c1559"] - d["c1459"]
d["rlast_atr"] = d["rlast"] / d["atr14_prior"]
d["r1500_1530"] = d["c1529"] - d["c1459"]
d["r1530_1600"] = d["c1559"] - d["c1529"]
d["r1545_1600"] = d["c1559"] - d["c1544"]
d["vshare_last"] = d["v_last"] / d["v_rth"]
d = d.dropna(subset=["r15_atr", "rlast_atr", "atr14_prior"])
print(f"clean days: {len(d)}  years {d['year'].min()}-{d['year'].max()}")


def beta_t(x, y):
    m = ~(np.isnan(x) | np.isnan(y))
    x, y = x[m], y[m]
    n = len(x)
    if n < 20:
        return np.nan, np.nan, n
    b = np.cov(x, y)[0, 1] / np.var(x)
    resid = y - b * x - (y.mean() - b * x.mean())
    se = np.sqrt(resid.var(ddof=2) / (n * x.var()))
    return b, b / se, n


print("\n=== A. OLS  rlast_atr ~ r15_atr  (amplification>0 = short-gamma-like) ===")
for yr, g in d.groupby("year"):
    b, t, n = beta_t(g["r15_atr"].to_numpy(), g["rlast_atr"].to_numpy())
    print(f"  {yr}: beta={b:+.4f} t={t:+.2f} n={n}")
b, t, n = beta_t(d["r15_atr"].to_numpy(), d["rlast_atr"].to_numpy())
print(f"  ALL : beta={b:+.4f} t={t:+.2f} n={n}")

print("\n--- sub-windows (pooled + per year) ---")
for col in ("r1500_1530", "r1530_1600", "r1545_1600"):
    d[col + "_atr"] = d[col] / d["atr14_prior"]
    parts = []
    for yr, g in d.groupby("year"):
        b, t, n = beta_t(g["r15_atr"].to_numpy(), (g[col] / g["atr14_prior"]).to_numpy())
        parts.append(f"{yr}:{b:+.3f}({t:+.1f})")
    b, t, n = beta_t(d["r15_atr"].to_numpy(), d[col + "_atr"].to_numpy())
    print(f"  {col}: ALL beta={b:+.4f} t={t:+.2f} | " + " ".join(parts))

print("\n=== B. Quintiles of r15_atr -> last-hour outcome (pooled) ===")
d["q15"] = pd.qcut(d["r15_atr"], 5, labels=False)
tab = d.groupby("q15").agg(
    r15_mean=("r15_atr", "mean"), rlast_pts=("rlast", "mean"),
    rlast_atr=("rlast_atr", "mean"), pos=("rlast", lambda x: (x > 0).mean()),
    n=("rlast", "count"))
print(tab.round(4).to_string())

print("\n--- per-year mean rlast_atr for Q0 (big down) / Q4 (big up) ---")
for yr, g in d.groupby("year"):
    q = pd.qcut(g["r15_atr"], 5, labels=False)
    lo = g.loc[q == 0, "rlast_atr"]
    hi = g.loc[q == 4, "rlast_atr"]
    tl, nl = tstat(lo); th, nh = tstat(hi)
    print(f"  {yr}: Q0={lo.mean():+.4f}(t={tl:+.1f},n={nl})  "
          f"Q4={hi.mean():+.4f}(t={th:+.1f},n={nh})")

print("\n=== C. Volume: last-hour volume share by |r15_atr| quintile ===")
d["aq"] = pd.qcut(d["r15_atr"].abs(), 5, labels=False)
print(d.groupby("aq").agg(absr15=("r15_atr", lambda x: x.abs().mean()),
                          vshare=("vshare_last", "mean"),
                          n=("vshare_last", "count")).round(4).to_string())

print("\n=== D. Conditioning ===")
d["atr_terc"] = pd.qcut(d["atr_rel"], 3, labels=["lowvol", "midvol", "hivol"])
print("-- beta by vol regime (atr_rel terciles), per era --")
d["era"] = np.where(d["year"] <= 2022, "2021-22",
                    np.where(d["year"] <= 2024, "2023-24", "2025-26"))
for (era, terc), g in d.groupby(["era", "atr_terc"], observed=True):
    b, t, n = beta_t(g["r15_atr"].to_numpy(), g["rlast_atr"].to_numpy())
    print(f"  {era} {terc}: beta={b:+.4f} t={t:+.2f} n={n}")

if oi is not None and d["dte0_share"].notna().sum() > 100:
    sub = d[d["dte0_share"].notna()].copy()
    sub["oi_terc"] = pd.qcut(sub["dte0_share"], 3, labels=["lo0dte", "mid0dte", "hi0dte"])
    print("-- beta by 0DTE OI share tercile (2023-03+), per year --")
    for (yr, terc), g in sub.groupby(["year", "oi_terc"], observed=True):
        b, t, n = beta_t(g["r15_atr"].to_numpy(), g["rlast_atr"].to_numpy())
        print(f"  {yr} {terc}: beta={b:+.4f} t={t:+.2f} n={n}")

print("-- beta by expiry class (pooled, then 2023+) --")
for cls, g in d.groupby("exp_class"):
    b, t, n = beta_t(g["r15_atr"].to_numpy(), g["rlast_atr"].to_numpy())
    b2, t2, n2 = beta_t(g.loc[g["year"] >= 2023, "r15_atr"].to_numpy(),
                        g.loc[g["year"] >= 2023, "rlast_atr"].to_numpy())
    print(f"  {cls}: ALL beta={b:+.4f}(t={t:+.2f},n={n})  "
          f"2023+={b2:+.4f}(t={t2:+.2f},n={n2})")

print("\n=== E. Path 15:00->16:00, mean cum ret (ATR units) by day-move tercile, per era ===")
path = rth[rth["et_hhmm"] >= 1500].copy()
path = path.merge(d.reset_index()[["index", "r15_atr", "atr14_prior", "era"]]
                  .rename(columns={"index": "et_date"}), on="et_date")
path["terc"] = pd.qcut(path["r15_atr"], 3, labels=["dn", "flat", "up"])
base = rth[rth["et_hhmm"] == 1459][["et_date", "c"]].rename(columns={"c": "c1459"})
path = path.merge(base, on="et_date")
path["cum_atr"] = (path["c"] - path["c1459"]) / path["atr14_prior"]
pt = path.pivot_table(index="et_hhmm", columns=["era", "terc"],
                      values="cum_atr", aggfunc="mean", observed=True)
print(pt.loc[[1504, 1514, 1529, 1544, 1549, 1554, 1559]].round(4).to_string())

print("\n=== F. Secondary: overnight-gap re-hedge (first 30m drift vs gap) ===")
d["r_open30"] = d["c959"] - d["o0930"]
d["r_open30_atr"] = d["r_open30"] / d["atr14_prior"]
sub = d.dropna(subset=["gap_atr", "r_open30_atr"])
sub = sub[np.isfinite(sub["gap_atr"])]
bins = [-np.inf, -0.5, -0.15, 0.15, 0.5, np.inf]
sub["gb"] = pd.cut(sub["gap_atr"], bins,
                   labels=["gap<-.5", "-.5..-.15", "flat", ".15...5", ">+.5"])
for yr, g in sub.groupby("year"):
    row = []
    for lab, gg in g.groupby("gb", observed=True):
        t, n = tstat(gg["r_open30_atr"])
        row.append(f"{lab}:{gg['r_open30_atr'].mean():+.3f}(n={n})")
    print(f"  {yr}: " + "  ".join(row))
tt = sub.groupby("gb", observed=True)["r_open30_atr"].agg(["mean", "count"])
tt["t"] = [tstat(sub.loc[sub["gb"] == i, "r_open30_atr"])[0] for i in tt.index]
print(tt.round(4).to_string())

d.reset_index().rename(columns={"index": "trade_date"}).to_csv(
    os.path.join(EXP, "R2-eod-daily.csv"), index=False)
print("\nwrote R2-eod-daily.csv")
