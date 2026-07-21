#!/usr/bin/env python3
"""R9-02: localization + robustness for the two survivors from R9-01.

(A) H1 European-close continuation: is sign(morning 0930->1130)*ret LOCALIZED to
    the 11:25-11:45 window, or does morning momentum persist uniformly across all
    midday windows? (If uniform -> it's generic momentum, not a Euro-close event.)
(B) 13:30-14:00 long drift: net-after-cost sensitivity + is it distinct from the
    all-RTH upward drift (compare to same-length windows across the whole session)?
Run: python3 R9-02-focus.py
"""
import numpy as np
import R9_common as R

def momentum_localization(inst):
    O,Hh,Ll,meta=R.load(inst)
    print(f"\n### {inst.upper()} — morning-momentum persistence by window (side=sign(0930->1130)) ###")
    print("    (positive = morning move continues in that window)")
    wins=[("1130-1145","o1130","o1145"),("1145-1200? via1145","o1145","o1200"),
          ("1125-1145 EUCLOSE","o1125","o1145"),
          ("1200-1230","o1200","o1230"),("1230-1300","o1230","o1300"),
          ("1300-1330","o1300","o1330"),("1330-1400","o1330","o1400")]
    for nm,a0,a1 in wins:
        vals=[]; py=[]
        for d in O:
            mor=R.op(O,d,"o1130")-R.op(O,d,"o930")
            ret=R.op(O,d,a1)-R.op(O,d,a0)
            if not (np.isfinite(mor) and np.isfinite(ret) and mor!=0): continue
            v=np.sign(mor)*ret; vals.append(v); py.append((meta[d][0],v))
        s=R.summary(vals)
        yrs=R.per_year(py); pos=sum(1 for y in yrs.values() if y[0]>0)
        print(f"  {nm:20s}: mean={s['mean']:+.2f}pt t={s['t']:+.2f} n={s['n']} yrs+{pos}/-{len(yrs)-pos}")

def afternoon_drift_context(inst):
    O,Hh,Ll,meta=R.load(inst)
    print(f"\n### {inst.upper()} — 30-min unconditional drift, ALL session windows (context for 1330-1400) ###")
    anchors=["o930","o1000","o1030","o1100","o1130","o1200","o1230","o1300","o1330","o1400","o1430","o1500","o1530","o1600"]
    for i in range(len(anchors)-1):
        a0,a1=anchors[i],anchors[i+1]
        vals=[R.op(O,d,a1)-R.op(O,d,a0) for d in O]
        vals=[v for v in vals if np.isfinite(v)]
        m=np.mean(vals); t=m/(np.std(vals,ddof=1)/np.sqrt(len(vals)))
        print(f"  {a0[1:]}-{a1[1:]}: mean={m:+.2f}pt t={t:+.2f}")
    # net-after-cost for the 1330-1400 long (round trip market in/out)
    print(f"\n  {inst.upper()} 1330-1400 LONG net-after-cost (gross - 2*slip - comm):")
    vals=[R.op(O,d,"o1400")-R.op(O,d,"o1330") for d in O]; vals=[v for v in vals if np.isfinite(v)]
    g=np.mean(vals); mult=20.0 if inst=='nq' else 50.0
    for slip in (0.25,0.5,1.0):
        net_pts=g-2*slip
        print(f"    slip {slip}pt/side: gross={g:+.2f}pt net={net_pts:+.2f}pt  ${net_pts*mult-5:+.2f}/day/contract")

for inst in ('nq','es'):
    momentum_localization(inst)
for inst in ('nq','es'):
    afternoon_drift_context(inst)
