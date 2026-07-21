#!/usr/bin/env python3
"""
H2 10:00-10:30 TURN (owner obs b). Two questions:
 (A) Does a MORNING extreme cluster in 10:00-10:30 (vs uniform / vs early-anchoring)?
 (B) When a FRESH extreme is set in [10:00,10:30], does price REVERSE off it after
     10:30 (out-of-sample outcome window [10:30,12:00])?  = tradable turn vs chop.
Mechanism: opening-rotation completion / 10:00 macro re-hedge sets a morning
turning point that dealers then fade back toward VWAP.
One signal/day => pooled == day-weighted.
"""
import numpy as np, pandas as pd, r4_common as R
m = pd.read_csv("R4-marks.csv", parse_dates=["trade_date"])
atr = m["atr14_prior"].to_numpy()
N = len(m)

print(f"=== H2A morning extreme timing (window 09:30-12:00, {N} days) ===")
bins = [(570,585,"09:30-09:45"),(585,600,"09:45-10:00"),(600,615,"10:00-10:15"),
        (615,630,"10:15-10:30"),(630,645,"10:30-10:45"),(645,660,"10:45-11:00"),
        (660,690,"11:00-11:30"),(690,720,"11:30-12:00")]
hi = m["morn_high_mod"].to_numpy(); lo = m["morn_low_mod"].to_numpy()
span = 720-570
for a,b,lab in bins:
    ph = ((hi>=a)&(hi<b)).mean(); pl = ((lo>=a)&(lo<b)).mean()
    base = (b-a)/span
    print(f"  {lab:<12s} P(high)={ph:.3f} P(low)={pl:.3f}  P(either)={ph+pl:.3f}  uniform={base:.3f}")
# combined 10:00-10:30
h1030 = ((hi>=600)&(hi<630)); l1030=((lo>=600)&(lo<630))
print(f"  -> morning HIGH in 10:00-10:30: {h1030.mean():.3f}  LOW: {l1030.mean():.3f}  "
      f"EITHER extreme: {(h1030|l1030).mean():.3f} (uniform 0.200)")
# early anchoring cross-check: full RTH extreme in first 30/60 min
rh=m["rth_high_mod"].to_numpy(); rl=m["rth_low_mod"].to_numpy()
first30 = ((rh<600)|(rl<600)); first60=((rh<630)|(rl<630))
print(f"  RTH session extreme in first 30min: {first30.mean():.3f}  first 60min: {first60.mean():.3f}")

print(f"\n=== H2B CAUSAL fresh-extreme reversal ===")
print("  Extreme over CLOSED past window [a,anchor); fresh if it occurred in the last")
print("  30min AND is in 10:00-10:30; outcome window strictly AFTER anchor. side=+1 if")
print("  fresh extreme is a HIGH (expect down). +revert => turn/fade, - => continue.\n")
def fresh_reversal(himod_col, lomod_col, fresh_lo, fresh_hi, anchor_mk, out_mks, name):
    hm = m[himod_col].to_numpy(); lm = m[lomod_col].to_numpy()
    # which extreme is fresher (later) and lies in [fresh_lo,fresh_hi)
    hi_fresh = (hm>=fresh_lo)&(hm<fresh_hi); lo_fresh=(lm>=fresh_lo)&(lm<fresh_hi)
    side = np.zeros(N)
    hi_wins = hi_fresh & (~lo_fresh | (hm>lm))   # high is the fresh/most-recent extreme
    lo_wins = lo_fresh & (~hi_fresh | (lm>hm))
    side[hi_wins]=+1; side[lo_wins]=-1
    mm=m.copy(); mm["_s"]=side; sg=mm[mm["_s"]!=0].copy(); s=sg["_s"].to_numpy(); a2=sg["atr14_prior"].to_numpy()
    print(f"  [{name}] n={len(sg)}")
    for lab,mk in out_mks.items():
        rev=-s*(sg[mk].to_numpy()-sg[anchor_mk].to_numpy()); sg["_r"]=rev/a2
        d=R.desc(rev,lab); out,verd=R.per_year(sg,"_r")
        print(f"     {lab:<10s} n={d['n']:<4d} revert pts={d['mean']:+.3f} t={d['t']:+.2f} /atr={rev.mean()/a2.mean():+.4f}  [{verd}]")

# REAL: fresh extreme in 10:00-10:30 (window [09:30,10:30)), outcome after 10:30
fresh_reversal("fhw1030_hi_mod","fhw1030_lo_mod",600,630,"p1030",
               {"to10:45":"p1045","to11:00":"p1100","to12:00":"p1200"},"fresh 10:00-10:30 turn")
# PLACEBO A: fresh extreme in 09:45-10:15 (window [09:30,10:15)), outcome after 10:15
fresh_reversal("fhw1015_hi_mod","fhw1015_lo_mod",585,615,"p1015",
               {"to10:45":"p1045","to11:00":"p1100","to12:00":"p1200"},"placebo fresh 09:45-10:15")
# PLACEBO B: fresh extreme in 10:30-11:00 (window [10:00,11:00)), outcome after 11:00
fresh_reversal("fhw1100_hi_mod","fhw1100_lo_mod",630,660,"p1100",
               {"to11:30(via1200 half)":"p1200"},"placebo fresh 10:30-11:00")
# PLACEBO C: fresh extreme in 11:00-11:30 (window [10:30,11:30)), outcome after 11:30
fresh_reversal("fhw1130_hi_mod","fhw1130_lo_mod",660,690,"p1100",  # note anchor approx
               {"to12:00":"p1200"},"placebo fresh 11:00-11:30")
