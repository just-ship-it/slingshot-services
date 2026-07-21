#!/usr/bin/env python3
"""R7-04: (A) redo 08:30-release + FOMC proxies with CAUSAL classifiers (baseline vol
knowable strictly before the entry window). (B) ES cross-check of the cleanly-computable
dow / turn-of-month / opex candidates (points + per-year sign agreement)."""
import numpy as np, pandas as pd
from R7lib import load, summ, fmt, SEGMENTS

df = load("R7-nq-anchors.csv")
DOW = {0:"Mon",1:"Tue",2:"Wed",3:"Thu",4:"Fri"}

print("="*100); print("A. CAUSAL 08:30-RELEASE PROXY (baseline = PRIOR-day RTH avg 1m vol; knowable at 09:30)"); print("="*100)
# prior-day rth_avg1m_vol (shift by 1 row = prior trading day)
df["rth_avg_prev"] = df["rth_avg1m_vol"].shift(1)
df["spike0830_causal"] = df["vol0830_5m"]/5.0 / df["rth_avg_prev"]
# also a fully-self-contained causal metric: raw 08:30 5m vol vs its own trailing-20d median
df["v0830_med20"] = df["vol0830_5m"].rolling(20, min_periods=10).median().shift(1)
df["spike0830_selfcausal"] = df["vol0830_5m"] / df["v0830_med20"]

for metric, name in [("spike0830_causal","prior-day-RTH-norm"),("spike0830_selfcausal","trail20d-self-norm")]:
    hi = df[metric] >= df[metric].quantile(0.90)
    lo = df[metric] <= df[metric].median()
    print(f"\n--- classifier={name}  hi-days={int(hi.sum())} by yr {df[hi].groupby('year').size().to_dict()}")
    for seg in ["am1_0930_1030","rel830_0830_0930","rth_full"]:
        print(fmt(summ(df, lo, seg, f"  (ctrl) low-{name[:8]}")))
        print(fmt(summ(df, hi, seg, f"  HI-{name[:8]}")))

print("\n"+"="*100); print("A2. FOMC proxy note: real FOMC dates are SCHEDULED (knowable). proxy=top-8/yr Wed by 14:00 vol."); print("="*100)
df["spike1400c"] = df["vol1400_5m"]/5.0 / df["rth_avg_prev"]   # causal-ish (prior day norm)
wed = df["dow"]==2
fomc = pd.Series(False, index=df.index)
for y,g in df[wed].groupby("year"):
    fomc.loc[g["spike1400c"].nlargest(8).index] = True
ctrl_wed = wed & ~fomc
for seg in ["fomc60_1400_1500","fomc30_1400_1430","pm_1400_1600"]:
    print(fmt(summ(df, ctrl_wed, seg, "  (ctrl) other Weds")))
    print(fmt(summ(df, fomc, seg,     "  FOMC-proxy")))

# ============ ES CROSS-CHECK ============
print("\n"+"="*100); print("B. ES CROSS-CHECK (points + per-year signs; sign agreement w/ NQ = generalization)"); print("="*100)
es = pd.read_csv("R7-es-anchors.csv")
es["dt"] = pd.to_datetime(es["trade_date"])
es = es.sort_values("dt").reset_index(drop=True)
es["dow"] = es["dt"].dt.weekday
es["year"] = es["dt"].dt.year
es["ym"] = es["dt"].dt.strftime("%Y-%m")
es["atr14_prior"] = 1.0  # ES reported in points only (no atr-norm needed for sign check)
es["tdom"] = es.groupby("ym").cumcount()+1
es["tdom_rev"] = -(es.groupby("ym")["tdom"].transform("max") - es["tdom"] + 1)
# opex week
from R7lib import _third_fridays, _opex_week_flag
# _third_fridays uses dow col (0=Mon..4=Fri) and 'trade_date'/'ym' -> ok
opd = _third_fridays(es.assign(dow=es["dow"]))
es["opex_week"] = _opex_week_flag(es, opd)
for name,(s,e) in SEGMENTS.items():
    ss,se_,cs,ce=f"s_{s}",f"s_{e}",f"c_{s}",f"c_{e}"
    if cs in es and ce in es:
        same = es[ss].notna()&es[se_].notna()&(es[ss]==es[se_])
        es[f"seg_{name}"]=np.where(same, es[ce]-es[cs], np.nan)
        es[f"segatr_{name}"]=es[f"seg_{name}"]  # points

allm=pd.Series(True,index=es.index)
print("\n-- ES dow x rth_full --")
for d in range(5): print(fmt(summ(es, es["dow"]==d, "rth_full", f"  ES {DOW[d]}")))
print("\n-- ES dow x am1_0930_1030 (Tue AM weakness?) --")
for d in range(5): print(fmt(summ(es, es["dow"]==d, "am1_0930_1030", f"  ES {DOW[d]}")))
print("\n-- ES dow x pm_1400_1600 --")
for d in range(5): print(fmt(summ(es, es["dow"]==d, "pm_1400_1600", f"  ES {DOW[d]}")))
print("\n-- ES turn-of-month (pm_1400_1600 & rth_full) --")
mid=(es["tdom"]>=8)&(es["tdom_rev"]<=-8)
tom_last=es["tdom_rev"]==-1; tom_f3=es["tdom"].isin([1,2,3]); tom_w=tom_last|tom_f3
print(fmt(summ(es, mid, "pm_1400_1600","  ES mid(ctrl)")))
print(fmt(summ(es, tom_last, "pm_1400_1600","  ES last-td pm")))
print(fmt(summ(es, tom_w, "pm_1400_1600","  ES ToM-window pm")))
print(fmt(summ(es, tom_w, "rth_full","  ES ToM-window rth")))
print("\n-- ES opex-week Thu afternoon --")
print(fmt(summ(es, ~es["opex_week"], "pm_1400_1600","  ES non-opex pm")))
print(fmt(summ(es, es["opex_week"]&(es["dow"]==3), "pm_1400_1600","  ES opexThu pm")))
print(fmt(summ(es, es["opex_week"]&(es["dow"]==3), "rth_full","  ES opexThu rth")))
