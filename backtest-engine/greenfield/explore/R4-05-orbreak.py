#!/usr/bin/env python3
"""
H5 OPENING-DRIVE / OR-BREAK CONTINUATION. First break of the 09:30-09:45 range after
09:45: does price CONTINUE in the break direction? cont = brk_dir*(P_mark - break_edge)/atr.
break_edge = OR high (up-break) or OR low (down-break); at the break instant price==edge,
so a fixed later mark measures post-break drift. Restrict to breaks by 10:30 so the
outcome mark is forward. Conditioners: gap alignment, ON compression, arr5.
Mechanism: opening rotation completes and momentum/hedging carries price past the OR edge.
One break/day => pooled == day-weighted.
"""
import numpy as np, pandas as pd, r4_common as R
m=pd.read_csv("R4-marks.csv",parse_dates=["trade_date"])
atr=m["atr14_prior"].to_numpy()
bd=m["or15_break_dir"].to_numpy(); bm=m["or15_break_mod"].to_numpy()
edge=np.where(bd>0,m["oc_high"].to_numpy(),np.where(bd<0,m["oc_low"].to_numpy(),np.nan))
print(f"=== H5 OR(09:30-09:45)-break, {len(m)} days ===")
print(f"  broke UP: {(bd>0).mean():.3f}  DOWN: {(bd<0).mean():.3f}  no break by 12:00: {(bd==0).mean():.3f}")
print(f"  median break time: mod {np.nanmedian(bm[bd!=0]):.0f} ({int(np.nanmedian(bm[bd!=0])//60):02d}:{int(np.nanmedian(bm[bd!=0])%60):02d})")

early = (bd!=0)&(bm<=630)   # broke by 10:30
def cont(mask,name,marks=("p1030","p1100","p1200")):
    g=m[mask].copy(); d_=g["or15_break_dir"].to_numpy()
    e=np.where(d_>0,g["oc_high"].to_numpy(),g["oc_low"].to_numpy())
    if len(g)<40: print(f"  {name:<40s} n={len(g)} skip"); return
    print(f"  [{name}] n={len(g)}")
    for mk in marks:
        c=d_*(g[mk].to_numpy()-e)/g["atr14_prior"].to_numpy()
        cp=d_*(g[mk].to_numpy()-e)
        g["_c"]=c; d=R.desc(cp,mk); out,verd=R.per_year(g,"_c")
        print(f"     ->{mk[1:]}: cont pts={d['mean']:+.3f} t={d['t']:+.2f} /atr={c.mean():+.4f}  [{verd}]")

cont(early,"all early breaks (by 10:30)")
gap=m["gap_atr"].to_numpy()
cont(early&(np.sign(gap)==bd),"break aligned with gap")
cont(early&(np.sign(gap)==-bd),"break against gap")
onr=m["on_range_atr"].to_numpy()
cont(early&(onr<=np.nanquantile(onr,0.33)),"break + compressed ON")
cont(early&(onr>=np.nanquantile(onr,0.67)),"break + wide ON")
a5=m["arr5"].to_numpy()
cont(early&(np.sign(m["oc_dir"].to_numpy())==bd)&(a5>=np.nanquantile(a5,0.67)),
     "break same dir as opening candle + fast arr5")
cont(early&(np.sign(m["oc_dir"].to_numpy())==bd)&(a5<=np.nanquantile(a5,0.33)),
     "break same dir as opening candle + slow arr5")

print("\n--- CONTROL: unconditional drift to same marks from 09:45 (no break condition) ---")
g=m.copy()
for mk in ["p1030","p1100","p1200"]:
    r=(g[mk].to_numpy()-g["p0945"].to_numpy()); g["_r"]=r/atr
    d=R.desc(r,mk); out,verd=R.per_year(g,"_r")
    print(f"  uncond 09:45->{mk[1:]}: pts={d['mean']:+.3f} t={d['t']:+.2f} [{verd}]")
