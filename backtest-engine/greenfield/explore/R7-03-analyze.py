#!/usr/bin/env python3
"""R7-03: run every calendar/event hypothesis, print tables. Redirect to R7-out.txt."""
import numpy as np, pandas as pd
from R7lib import load, summ, fmt, SEGMENTS

df = load("R7-nq-anchors.csv")
DOW = {0:"Mon",1:"Tue",2:"Wed",3:"Thu",4:"Fri"}
print(f"# NQ calendar-flow census  days={len(df)}  {df.trade_date.min()}..{df.trade_date.max()}")
print(f"# one drift per day per segment -> pooled == day-weighted (rule 8 satisfied by construction)\n")

def block(title):
    print("\n" + "="*100 + "\n" + title + "\n" + "="*100)

# ---------- H0 SANITY: confirmed pre-close edge should appear ----------
block("H0 SANITY: all-days segment drifts (baseline; confirmed 15:00->15:30 pre-close should show)")
allm = pd.Series(True, index=df.index)
for seg in ["rth_full","pre30_1500_1530","close30_1530_1600","lasthr_1500_1600","pm_1400_1600","am1_0930_1030","on_sess_1800_0930","gap"]:
    print(fmt(summ(df, allm, seg, "ALL DAYS")))

# ---------- H1 DOW x TIME ----------
block("H1 DAY-OF-WEEK x TIME-OF-DAY (signed drift). control=pooled all-weekdays")
segs_dow = ["rth_full","am1_0930_1030","pm_1400_1600","lasthr_1500_1600","pre30_1500_1530","on_sess_1800_0930","gap"]
for seg in segs_dow:
    print(f"\n-- segment {seg} --")
    print(fmt(summ(df, allm, seg, "  (control) all wkdays")))
    for d in range(5):
        print(fmt(summ(df, df["dow"]==d, seg, f"  {DOW[d]}")))

# ---------- H2 TURN OF MONTH ----------
block("H2 TURN-OF-MONTH (trading-day-of-month). control=mid-month (tdom 8..-8)")
mid = (df["tdom"]>=8) & (df["tdom_rev"]<=-8)
tom_last = df["tdom_rev"]==-1
tom_first = df["tdom"].isin([1])
tom_f3 = df["tdom"].isin([1,2,3])
tom_window = tom_last | tom_f3           # classic ToM: last day + first 3
tom_lastn = df["tdom_rev"].isin([-1,-2,-3])
for seg in ["rth_full","pm_1400_1600","lasthr_1500_1600","on_sess_1800_0930","gap"]:
    print(f"\n-- segment {seg} --")
    print(fmt(summ(df, mid, seg,        "  (control) mid-month")))
    print(fmt(summ(df, tom_last, seg,   "  last trading day")))
    print(fmt(summ(df, tom_lastn, seg,  "  last 3 trading days")))
    print(fmt(summ(df, tom_first, seg,  "  first trading day")))
    print(fmt(summ(df, tom_f3, seg,     "  first 3 trading days")))
    print(fmt(summ(df, tom_window, seg, "  ToM window(last1+first3)")))

# tdom sweep on rth_full to see monotonic structure
block("H2b tdom sweep (rth_full mean pts by forward tdom 1..10 and reverse -1..-5)")
for k in list(range(1,11)):
    r = summ(df, df["tdom"]==k, "rth_full", f"  tdom={k}")
    print(fmt(r))
for k in [-1,-2,-3,-4,-5]:
    r = summ(df, df["tdom_rev"]==k, "rth_full", f"  tdom_rev={k}")
    print(fmt(r))

# ---------- H3 OPEX WEEK ----------
block("H3 OPEX-WEEK (week containing 3rd Friday). control=non-opex weeks. day-by-day within week")
nonopex = ~df["opex_week"]
for seg in ["rth_full","am1_0930_1030","pm_1400_1600","lasthr_1500_1600"]:
    print(f"\n-- segment {seg} --")
    print(fmt(summ(df, nonopex, seg,       "  (control) non-opex wks")))
    print(fmt(summ(df, df["opex_week"], seg,"  opex week (all days)")))
    for d in range(5):
        print(fmt(summ(df, df["opex_week"] & (df["dow"]==d), seg, f"    opex-wk {DOW[d]}")))
print("\n-- opex Friday itself (monthly) and quarterly --")
for seg in ["am1_0930_1030","rth_full","pm_1400_1600"]:
    print(fmt(summ(df, df["opex_friday"], seg,  f"  opexFri {seg}")))
    print(fmt(summ(df, df["quarter_opex"], seg, f"  qtrOpexFri {seg}")))

# ---------- H4 MONTH-END / MONTH-START (drift, distinct from direction) ----------
block("H4 MONTH-END / MONTH-START drift windows. (subset of H2 but focus close/open windows)")
for seg in ["lasthr_1500_1600","pre30_1500_1530","on_sess_1800_0930","gap","am1_0930_1030"]:
    print(f"\n-- segment {seg} --")
    print(fmt(summ(df, mid, seg,       "  (control) mid-month")))
    print(fmt(summ(df, tom_last, seg,  "  month-end (last td)")))
    print(fmt(summ(df, tom_first, seg, "  month-start (first td)")))

# ---------- H5 FOMC / MACRO PROXY ----------
block("H5 FOMC PROXY: top-8/yr Wednesdays by 14:00 vol-spike ratio. control=other Wednesdays")
df["spike1400"] = (df["vol1400_5m"]/5.0) / df["rth_avg1m_vol"]
df["spike0830"] = (df["vol0830_5m"]/5.0) / df["rth_avg1m_vol"]
wed = df["dow"]==2
# per-year top-8 wednesdays by spike1400
fomc = pd.Series(False, index=df.index)
for y,g in df[wed].groupby("year"):
    top = g["spike1400"].nlargest(8).index
    fomc.loc[top] = True
df["fomc_proxy"] = fomc
print(f"fomc_proxy days={int(fomc.sum())}  by year: {df[fomc].groupby('year').size().to_dict()}")
ctrl_wed = wed & ~fomc
for seg in ["fomc30_1400_1430","fomc60_1400_1500","pm_1400_1600","rth_full","lasthr_1500_1600","am1_0930_1030"]:
    print(f"\n-- segment {seg} --")
    print(fmt(summ(df, ctrl_wed, seg, "  (control) other Weds")))
    print(fmt(summ(df, fomc, seg,     "  FOMC-proxy days")))
# 08:30 release proxy: top-quartile 0830 spike days
block("H5b 08:30-RELEASE PROXY: top-decile days by 08:30 vol-spike. control=bottom-half")
thr_hi = df["spike0830"].quantile(0.90)
rel = df["spike0830"]>=thr_hi
ctrl_rel = df["spike0830"]<=df["spike0830"].median()
print(f"rel(top-decile 0830) days={int(rel.sum())} by year {df[rel].groupby('year').size().to_dict()}")
for seg in ["rel830_0830_0930","gap","am1_0930_1030","rth_full"]:
    print(f"\n-- segment {seg} --")
    print(fmt(summ(df, ctrl_rel, seg, "  (control) low-0830-vol")))
    print(fmt(summ(df, rel, seg,      "  high-0830-vol days")))

# ---------- H6 HOLIDAY-ADJACENT / HALF DAYS ----------
block("H6 HOLIDAY-ADJACENT / HALF DAYS. control=normal full days")
normal = ~df["pre_holiday"] & ~df["post_holiday"] & ~df["half_day"]
print(f"pre_holiday={int(df.pre_holiday.sum())} post_holiday={int(df.post_holiday.sum())} half_day={int(df.half_day.sum())}")
# half day RTH ends 13:00 -> use am windows / rth_full will be miscomputed (1600 anchor absent). use am1 and a 0930->1300 proxy via mid start
df["seg_half_0930_1300"] = np.where(
    df["s_930"].notna() & df["s_1300"].notna() & (df["s_930"]==df["s_1300"]),
    df["c_1300"]-df["c_930"], np.nan)
df["segatr_half_0930_1300"] = df["seg_half_0930_1300"]/df["atr14_prior"]
SEGMENTS["half_0930_1300"]=(930,1300)
for seg in ["rth_full","am1_0930_1030","pm_1400_1600","on_sess_1800_0930","gap"]:
    print(f"\n-- segment {seg} --")
    print(fmt(summ(df, normal, seg,           "  (control) normal days")))
    print(fmt(summ(df, df["pre_holiday"], seg,"  pre-holiday")))
    print(fmt(summ(df, df["post_holiday"], seg,"  post-holiday")))
print("\n-- half-day session (09:30->13:00) --")
print(fmt(summ(df, normal, "half_0930_1300", "  (control) normal")))
print(fmt(summ(df, df["half_day"], "half_0930_1300", "  half days")))

# save enriched panel for ES cross-check & reuse
keep = ["trade_date","year","dow","month","tdom","tdom_rev","atr14_prior",
        "opex_week","opex_friday","quarter_opex","half_day","pre_holiday","post_holiday",
        "fomc_proxy","spike1400","spike0830"] + [f"seg_{k}" for k in SEGMENTS] + ["seg_gap"]
df[keep].to_csv("R7-nq-panel.csv", index=False)
print("\nwrote R7-nq-panel.csv")
