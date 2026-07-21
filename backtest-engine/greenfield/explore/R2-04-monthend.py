"""R2-04 (H3): Calendar-forced rebalancing - month-end / quarter-end.

Mechanism: pensions/target-date funds rebalance bond-equity mixes at month and
quarter ends; the direction is state-dependent and knowable intramonth: if
equities rallied MTD, rebalancers must SELL equities into month-end (and vice
versa). Execution concentrates in the last sessions' afternoons (MOC).

Tests:
- day/late-day drift by trading-day offset to month end (me_t: 0 = last day)
- late-day (14:00-16:00) drift on ME-1/ME0 conditional on MTD move sign
- quarter-end vs plain month-end (disentangle: TW is mid-month, 2 weeks away)
Controls: mid-month days (|me_t| >= 5) as baseline. Per-year splits.

All returns computed from raw session columns + 1m closes (sessions cache
derived-return columns are not used).
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from R2_common import EXP, load_1m, load_sessions, load_calendar, tstat

s = load_sessions().set_index("trade_date")
cal = load_calendar().set_index("trade_date")
df = load_1m("NQ", usecols=["et_date", "et_hhmm", "c", "symbol"])
days = set(s.index)
rth = df[(df["et_hhmm"].isin([1359, 1459, 1529, 1559])) & df["et_date"].isin(days)]
piv = rth.pivot_table(index="et_date", columns="et_hhmm", values="c")

d = s.join(cal[["me_t", "qe_t", "exp_class"]]).join(piv)
d["day_atr"] = (d["rth_close"] - d["rth_open"]) / d["atr14_prior"]
d["late_atr"] = (d[1559] - d[1359]) / d["atr14_prior"]     # 14:00->16:00
d["last30_atr"] = (d[1559] - d[1529]) / d["atr14_prior"]   # 15:30->16:00

# MTD return through PRIOR close (knowable at open): prior close / last close
# of previous month - 1
d = d.reset_index().rename(columns={"index": "trade_date"})
d["ym"] = d["trade_date"].str[:7]
month_last_close = d.groupby("ym")["rth_close"].last()
prev_ym = {ym: pym for ym, pym in zip(month_last_close.index[1:],
                                      month_last_close.index[:-1])}
d["prev_month_close"] = d["ym"].map(lambda ym: month_last_close.get(prev_ym.get(ym)))
d["mtd"] = d["prior_rth_close"] / d["prev_month_close"] - 1.0
d.loc[d["me_t"] == 9, "mtd"] = np.nan  # censored offsets

print(f"days: {len(d)}")

print("\n=== A. drift by me_t (trading days to month end; 0=last day) ===")
print(f"{'me_t':>5} {'day_atr':>18} {'late(14-16)':>18} {'last30':>18} {'n':>4}")
base = d[d["me_t"].abs() >= 5]
for off in range(-4, 4):
    g = d[d["me_t"] == off]
    ta, _ = tstat(g["day_atr"]); tl, _ = tstat(g["late_atr"]); t3, _ = tstat(g["last30_atr"])
    print(f"{off:>5} {g['day_atr'].mean():+.4f} (t={ta:+.1f})  "
          f"{g['late_atr'].mean():+.4f} (t={tl:+.1f})  "
          f"{g['last30_atr'].mean():+.4f} (t={t3:+.1f})  {len(g):>4}")
ta, _ = tstat(base["day_atr"]); tl, _ = tstat(base["late_atr"]); t3, _ = tstat(base["last30_atr"])
print(f"CTRL(|me_t|>=5): {base['day_atr'].mean():+.4f} (t={ta:+.1f})  "
      f"{base['late_atr'].mean():+.4f} (t={tl:+.1f})  "
      f"{base['last30_atr'].mean():+.4f} (t={t3:+.1f})  {len(base):>4}")

print("\n--- per-year late_atr for me_t in {-1,0} vs control ---")
for yr, g in d.groupby("year"):
    me = g[g["me_t"].isin([-1, 0])]["late_atr"]
    ct = g[g["me_t"].abs() >= 5]["late_atr"]
    t1, n1 = tstat(me); t0, n0 = tstat(ct)
    print(f"  {yr}: ME={me.mean():+.4f}(t={t1:+.1f},n={n1})  "
          f"ctrl={ct.mean():+.4f}(t={t0:+.1f},n={n0})")

print("\n=== B. state-dependent: late-day ret on ME-1/ME0 by MTD sign ===")
me = d[d["me_t"].isin([-1, 0]) & d["mtd"].notna()].copy()
me["mtd_sign"] = np.where(me["mtd"] > 0, "MTD_up", "MTD_dn")
for sgn, g in me.groupby("mtd_sign"):
    t, n = tstat(g["late_atr"])
    print(f"  {sgn}: late={g['late_atr'].mean():+.4f} (t={t:+.1f}, n={n})  "
          f"day={g['day_atr'].mean():+.4f}")
print("--- per-year ---")
for (yr, sgn), g in me.groupby(["year", "mtd_sign"]):
    t, n = tstat(g["late_atr"])
    print(f"  {yr} {sgn}: late={g['late_atr'].mean():+.4f} (t={t:+.1f}, n={n})")
# control: same conditional off month-end
ct = d[(d["me_t"].abs() >= 5) & d["mtd"].notna()].copy()
ct["mtd_sign"] = np.where(ct["mtd"] > 0, "MTD_up", "MTD_dn")
print("--- control (|me_t|>=5), same split ---")
for sgn, g in ct.groupby("mtd_sign"):
    t, n = tstat(g["late_atr"])
    print(f"  {sgn}: late={g['late_atr'].mean():+.4f} (t={t:+.1f}, n={n})")

print("\n=== C. quarter-end vs plain month-end (late_atr, day_atr) ===")
qe = d[(d["qe_t"].isin([-1, 0]))]
pme = d[d["me_t"].isin([-1, 0]) & ~d["qe_t"].isin([-1, 0])]
for name, g in (("QE-1/QE0", qe), ("plain ME-1/ME0", pme)):
    t, n = tstat(g["late_atr"]); td_, _ = tstat(g["day_atr"])
    print(f"  {name}: late={g['late_atr'].mean():+.4f}(t={t:+.1f},n={n})  "
          f"day={g['day_atr'].mean():+.4f}(t={td_:+.1f})")
print("--- QE with MTD-up vs MTD-dn (pension-rebalance direction) ---")
qe2 = qe[qe["mtd"].notna()].copy()
qe2["mtd_sign"] = np.where(qe2["mtd"] > 0, "MTD_up", "MTD_dn")
for sgn, g in qe2.groupby("mtd_sign"):
    t, n = tstat(g["late_atr"])
    yrs = " ".join(f"{yy}:{gg['late_atr'].mean():+.3f}"
                   for yy, gg in g.groupby("year"))
    print(f"  {sgn}: late={g['late_atr'].mean():+.4f} (t={t:+.1f}, n={n}) | {yrs}")

print("\n=== D. first days of new month (me_t 1..3): day drift ===")
for off in (1, 2, 3):
    g = d[d["me_t"] == off]
    t, n = tstat(g["day_atr"])
    yrs = " ".join(f"{yy}:{gg['day_atr'].mean():+.3f}" for yy, gg in g.groupby("year"))
    print(f"  me_t=+{off}: day={g['day_atr'].mean():+.4f} (t={t:+.1f}, n={n}) | {yrs}")
