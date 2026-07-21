"""R2-03 (H2): Expiration-cycle flows.

Mechanisms:
- Expiring OI forces delta re-hedge unwind and (near large strikes) pinning:
  dealers long gamma at a big strike trade against price, compressing the path
  toward the strike into expiry afternoon. Prior-day OI is knowable pre-open.
- Quarterly triple-witching adds index-futures SOQ settlement (09:30 open).

Part 1: flow census by expiry class (drift / realized vol / volume by window),
        controls = same-weekday non-expiry or lighter-expiry days.
Part 2: pinning as a PATH question in QQQ space: distance of spot to the
        near-money max-OI expiring strike at 10:00 vs into the close, vs
        placebo pins (offset strikes, and round-strike-nearest-morning-spot
        to control for mean reversion to the morning price).
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from R2_common import ROOT, EXP, load_1m, load_sessions, load_calendar, load_oi, tstat

s = load_sessions().set_index("trade_date")
cal = load_calendar().set_index("trade_date")

# ---------- Part 1: NQ flow census by expiry class ----------
df = load_1m("NQ", usecols=["et_date", "et_hhmm", "c", "v", "symbol"])
days = set(s.index)
rth = df[(df["et_hhmm"] >= 930) & (df["et_hhmm"] <= 1559)
         & df["et_date"].isin(days)].copy()
c = rth["c"].to_numpy()
pts = np.full(len(rth), np.nan)
pts[1:] = c[1:] - c[:-1]
sym = rth["symbol"].to_numpy()
pts[1:][sym[1:] != sym[:-1]] = np.nan
rth["pts"] = pts
rth.loc[rth["et_hhmm"] == 930, "pts"] = np.nan
rth["atr"] = rth["et_date"].map(s["atr14_prior"])
rth["pa"] = rth["pts"] / rth["atr"]

WIN = {"0930_0959": (930, 959), "1000_1029": (1000, 1029),
       "1130_1359": (1130, 1359), "1400_1459": (1400, 1459),
       "1500_1529": (1500, 1529), "1530_1559": (1530, 1559)}
rows = []
for name, (a, b) in WIN.items():
    w = rth[(rth["et_hhmm"] >= a) & (rth["et_hhmm"] <= b)]
    g = w.groupby("et_date").agg(drift=("pa", "sum"),
                                 rvol=("pa", lambda x: x.abs().median()),
                                 vol=("v", "sum"))
    g["win"] = name
    rows.append(g.reset_index())
day_win = pd.concat(rows)
day_win = day_win.merge(cal[["exp_class"]], left_on="et_date", right_index=True)
day_win["year"] = day_win["et_date"].str[:4].astype(int)
dayvol = rth.groupby("et_date")["v"].sum().rename("dayvol")
day_win = day_win.merge(dayvol, on="et_date")
day_win["vshare"] = day_win["vol"] / day_win["dayvol"]

print("=== P1a. drift (sum ATR) by window x expiry class (Fridays only: weekly vs monthly vs quarterly) ===")
fri = day_win[day_win["exp_class"].isin(["weekly_fri", "monthly", "quarterly"])]
for name in WIN:
    parts = []
    for clsn, g in fri[fri["win"] == name].groupby("exp_class"):
        t, n = tstat(g["drift"])
        parts.append(f"{clsn}: {g['drift'].mean():+.4f}(t={t:+.1f},n={n})")
    print(f"  {name}: " + "  ".join(parts))

print("\n=== P1b. realized vol (median |1m|/ATR) by window x class (Fridays) ===")
print(fri.pivot_table(index="win", columns="exp_class", values="rvol",
                      aggfunc="median").round(4).to_string())

print("\n=== P1c. volume share by window x class (Fridays) ===")
print(fri.pivot_table(index="win", columns="exp_class", values="vshare",
                      aggfunc="mean").round(4).to_string())

print("\n--- quarterly (TW) open-window vol per year vs monthly ---")
ow = day_win[day_win["win"] == "0930_0959"]
for clsn in ("monthly", "quarterly"):
    g = ow[ow["exp_class"] == clsn]
    yrs = " ".join(f"{y}:{gg['rvol'].median():.3f}" for y, gg in g.groupby("year"))
    print(f"  {clsn}: {yrs}")

print("\n--- Mon-Thu: daily-expiry vs none (2021-2022 only, where 'none' exists) ---")
mt = day_win[day_win["exp_class"].isin(["daily", "none"]) & (day_win["year"] <= 2022)]
for name in WIN:
    parts = []
    for clsn, g in mt[mt["win"] == name].groupby("exp_class"):
        t, n = tstat(g["drift"])
        parts.append(f"{clsn}: d={g['drift'].mean():+.4f}(t={t:+.1f},n={n}) "
                     f"rv={g['rvol'].median():.4f}")
    print(f"  {name}: " + "  ".join(parts))

# ---------- Part 2: pinning in QQQ space ----------
print("\n\n========== Part 2: pinning (QQQ, 2023-03+) ==========")
strikes = pd.read_csv(os.path.join(EXP, "R2-oi-strikes.csv"))
oi = load_oi().set_index("date")

q = pd.read_csv(os.path.join(ROOT, "data/ohlcv/qqq/QQQ_ohlcv_1m.csv"),
                usecols=["ts_event", "close"])
ts = pd.to_datetime(q["ts_event"], utc=True).dt.tz_convert("America/New_York")
q["et_date"] = ts.dt.strftime("%Y-%m-%d")
q["hhmm"] = ts.dt.hour * 100 + ts.dt.minute
MARKS = {"d10": 959, "d12": 1159, "d14": 1359, "d15": 1459,
         "d1545": 1544, "d16": 1559}
qq = q[q["hhmm"].isin(list(MARKS.values()))]
piv = qq.pivot_table(index="et_date", columns="hhmm", values="close")

res = []
for date, grp in strikes[strikes["kind"] == "dte0"].groupby("date"):
    if date not in piv.index or piv.loc[date].isna().any():
        continue
    spot10 = piv.loc[date, 959]
    near = grp[(grp["strike"] > spot10 * 0.97) & (grp["strike"] < spot10 * 1.03)]
    if near.empty or near["oi"].max() < 5000:
        continue
    pin = near.loc[near["oi"].idxmax(), "strike"]
    pin_oi = near["oi"].max()
    # placebos: offset strikes, and round-$5-nearest-morning-spot anchor
    anchors = {"pin": pin, "p_m5": pin - 5, "p_p5": pin + 5,
               "p_m2": pin - 2, "p_p2": pin + 2,
               "p_round": round(spot10 / 5) * 5}
    row = {"date": date, "pin": pin, "pin_oi": pin_oi, "spot10": spot10}
    for an, lvl in anchors.items():
        for mk, hm in MARKS.items():
            row[f"{an}_{mk}"] = abs(piv.loc[date, hm] - lvl) / spot10 * 100
    res.append(row)
pn = pd.DataFrame(res)
pn = pn.merge(cal[["exp_class"]], left_on="date", right_index=True)
pn["year"] = pn["date"].str[:4].astype(int)
pn = pn.merge(oi[["dte0_oi"]], left_on="date", right_index=True)
print(f"pin days: {len(pn)}  classes: {pn['exp_class'].value_counts().to_dict()}")

def pin_table(g, label):
    if len(g) < 15:
        print(f"  {label}: n={len(g)} (too few)")
        return
    med10 = g["pin_d10"].median(); med16 = g["pin_d16"].median()
    conv = (g["pin_d16"] < g["pin_d10"]).mean()
    close_frac = (g["pin_d16"] < 0.25).mean()
    # placebo averages
    pl16 = np.mean([g[f"{p}_d16"].median() for p in ("p_m5", "p_p5", "p_m2", "p_p2")])
    pl10 = np.mean([g[f"{p}_d10"].median() for p in ("p_m5", "p_p5", "p_m2", "p_p2")])
    plconv = np.mean([(g[f"{p}_d16"] < g[f"{p}_d10"]).mean()
                      for p in ("p_m5", "p_p5", "p_m2", "p_p2")])
    rconv = (g["p_round_d16"] < g["p_round_d10"]).mean()
    print(f"  {label}: n={len(g)}  med d10={med10:.3f}% d16={med16:.3f}%  "
          f"P(d16<d10)={conv:.2f}  P(|d16|<.25%)={close_frac:.2f}")
    print(f"      placebo(offsets): d10={pl10:.3f}% d16={pl16:.3f}% "
          f"P(conv)={plconv:.2f} | round-anchor P(conv)={rconv:.2f}")

print("\n=== pinning path: real pin vs placebos ===")
for clsn in ("quarterly", "monthly", "weekly_fri", "daily"):
    pin_table(pn[pn["exp_class"] == clsn], clsn)
print("--- per-year (all Fridays: weekly+monthly+quarterly) ---")
fr = pn[pn["exp_class"].isin(["weekly_fri", "monthly", "quarterly"])]
for yr, g in fr.groupby("year"):
    pin_table(g, str(yr))
print("--- pin OI magnitude terciles (all classes) ---")
pn["oiterc"] = pd.qcut(pn["pin_oi"], 3, labels=["loOI", "midOI", "hiOI"])
for tc, g in pn.groupby("oiterc", observed=True):
    pin_table(g, str(tc))
print("--- distance path medians (all Fri): 10->12->14->15->15:45->16 ===")
for clsn, g in fr.groupby("exp_class"):
    path = [g[f"pin_{k}"].median() for k in ("d10", "d12", "d14", "d15", "d1545", "d16")]
    print(f"  {clsn}: " + " -> ".join(f"{v:.3f}" for v in path))
pn.to_csv(os.path.join(EXP, "R2-pinning-daily.csv"), index=False)
