#!/usr/bin/env python3
"""
H6 OVERNIGHT-UNWIND. Does the first-hour RTH move CONTINUE or MEAN-REVERT the overnight
drift (all knowable at 09:30)? ON drift proxy = gap = rth_open - prior_rth_close.
cont = sign(gap)*(P_mark - P0930).  +mean => first hour continues the overnight move;
-mean => first hour fades it (gap-fill / unwind). Conditioners: gap size, ON range.
Mechanism: overnight-position unwinds at the open either extend the ON move or reverse it.
One obs/day => pooled == day-weighted.
"""
import numpy as np, pandas as pd, r4_common as R
m=pd.read_csv("R4-marks.csv",parse_dates=["trade_date"])
m=m[m["gap_ok"].fillna(False) & np.isfinite(m["gap_atr"])].copy()
atr=m["atr14_prior"].to_numpy(); gsign=np.sign(m["gap_atr"].to_numpy())
print(f"=== H6 overnight-unwind, {len(m)} gap-valid days ===")
print(f"  gap up: {(gsign>0).mean():.3f}  down: {(gsign<0).mean():.3f}  |gap|/atr median {np.nanmedian(np.abs(m['gap_atr'])):.3f}")
def contfade(mask,name,marks=("p0945","p1015","p1030","p1045","p1200")):
    g=m[mask].copy(); s=np.sign(g["gap_atr"].to_numpy())
    if len(g)<40: print(f"  {name:<34s} n={len(g)} skip"); return
    print(f"  [{name}] n={len(g)}  (+ = continue gap, - = fade/gap-fill)")
    for mk in marks:
        c=s*(g[mk].to_numpy()-g["p0930"].to_numpy()); cp=c.copy(); g["_c"]=c/g["atr14_prior"].to_numpy()
        d=R.desc(cp,mk); out,verd=R.per_year(g,"_c")
        print(f"     ->{mk[1:]}: pts={d['mean']:+.3f} t={d['t']:+.2f} /atr={(c/g['atr14_prior'].to_numpy()).mean():+.4f}  [{verd}]")
contfade(np.ones(len(m),bool),"all gap days")
ga=np.abs(m["gap_atr"].to_numpy())
contfade(ga<=np.nanquantile(ga,0.33),"small gap (bot tercile)")
contfade(ga>=np.nanquantile(ga,0.67),"large gap (top tercile)")
onr=m["on_range_atr"].to_numpy()
contfade(onr<=np.nanquantile(onr,0.33),"compressed ON")
contfade(onr>=np.nanquantile(onr,0.67),"wide ON")

print("\n--- correlation: gap/atr vs first-hour move (P1030-P0930)/atr ---")
fh=(m["p1030"].to_numpy()-m["p0930"].to_numpy())/atr
gp=m["gap_atr"].to_numpy()
good=np.isfinite(fh)&np.isfinite(gp)
print(f"  corr(gap, first-hour move) = {np.corrcoef(gp[good],fh[good])[0,1]:+.3f}  (n={good.sum()})")
