"""R2-00: Build QQQ expiry calendar + month/quarter-end structure.

Sources:
- data/definition/qqq/*.definition.csv  (field 11 = expiration) -> union of all
  option expiry dates that ever existed 2021-2026. A trade date with an expiry
  in this set has same-day-expiring options (0DTE available).
- NQ_daily_sessions.csv -> trading-day universe.

Classification per trading day:
- has_0dte: an option series expires this date
- exp_class: none | daily (Mon-Thu) | weekly_fri | monthly (3rd-Fri window,
  incl. holiday-shifted Thursday) | quarterly (monthly in Mar/Jun/Sep/Dec =
  triple witching)
- me_t / qe_t: trading-day offset to month/quarter end (0 = last trading day,
  -1 = day before, +1 = first day of next month). Range clipped to [-9, +9].

Output: greenfield/explore/R2-calendar.csv
"""
import os
import subprocess
import sys
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from R2_common import ROOT, EXP, load_sessions

RAW = os.path.join(EXP, "R2-expiries-raw.txt")

if not os.path.exists(RAW):
    print("extracting expirations from definition files (one pass, ~2 min)...")
    cmd = ("cut -d, -f11 " + os.path.join(ROOT, "data/definition/qqq") +
           "/opra-pillar-*.definition.csv | sort -u > " + RAW)
    subprocess.run(cmd, shell=True, check=True)

exp_dates = set()
with open(RAW) as f:
    for line in f:
        line = line.strip()
        if line.startswith("20") and "T" in line:
            exp_dates.add(line[:10])

# definition files end early 2026; union in expiry dates observed in the OPRA
# statistics symbols (built by R2-01) to cover 2026 daily expiries
STATS_EXP = os.path.join(EXP, "R2-expiries-from-stats.txt")
if os.path.exists(STATS_EXP):
    with open(STATS_EXP) as f:
        exp_dates |= {l.strip() for l in f if l.strip()}
    print("merged expiries from statistics symbols")
print(f"unique expiry dates: {len(exp_dates)}  "
      f"[{min(exp_dates)} .. {max(exp_dates)}]")

s = load_sessions()
tds = pd.to_datetime(s["trade_date"])
rows = []
for td, dow in zip(tds, s["dow"]):
    d = td.strftime("%Y-%m-%d")
    has = d in exp_dates
    cls = "none"
    if has:
        if dow == 4:  # Friday
            cls = ("quarterly" if td.month in (3, 6, 9, 12) else "monthly") \
                if 15 <= td.day <= 21 else "weekly_fri"
        elif dow == 3:  # Thursday: holiday-shifted Friday expiry?
            fri = td + pd.Timedelta(days=1)
            fri_s = fri.strftime("%Y-%m-%d")
            # Friday is a market holiday (weekday, not in trading days)
            if fri_s not in set(s["trade_date"]):
                if 15 <= fri.day <= 21:
                    cls = "quarterly" if fri.month in (3, 6, 9, 12) else "monthly"
                else:
                    cls = "weekly_fri"
                # only if Thursday itself is not a plain daily... a shifted
                # weekly is still classified as weekly (bigger OI than daily)
            else:
                cls = "daily"
        else:
            cls = "daily"
    rows.append({"trade_date": d, "dow": dow, "has_0dte": has, "exp_class": cls})

cal = pd.DataFrame(rows)

# month/quarter-end offsets: signed trading-day distance to the NEAREST period
# end (0 = last trading day of month/quarter, -1 = day before, +1 = day after).
import numpy as np
t = pd.to_datetime(cal["trade_date"])
cal["ym"] = t.dt.strftime("%Y-%m")
cal["yq"] = t.dt.year.astype(str) + "Q" + t.dt.quarter.astype(str)
for col, key in (("me_t", "ym"), ("qe_t", "yq")):
    pe = np.sort(cal.groupby(key).tail(1).index.to_numpy())  # period-end rows
    offs = []
    for i in range(len(cal)):
        j = np.searchsorted(pe, i)                 # next end at/after i
        cand = []
        if j < len(pe):
            cand.append(i - pe[j])                 # <= 0
        if j > 0:
            cand.append(i - pe[j - 1])             # > 0
        offs.append(min(cand, key=abs))
    cal[col] = np.clip(offs, -9, 9)

cal = cal.drop(columns=["ym", "yq"])
cal["year"] = t.dt.year
out = os.path.join(EXP, "R2-calendar.csv")
cal.to_csv(out, index=False)
print(f"wrote {out}  n={len(cal)}")
print(cal["exp_class"].value_counts())
print("\n0DTE availability by year x dow (count of has_0dte days):")
print(cal[cal["has_0dte"]].pivot_table(index="year", columns="dow",
      values="has_0dte", aggfunc="count").fillna(0).astype(int))
print("\nme_t distribution:", cal["me_t"].value_counts().sort_index().to_dict())
