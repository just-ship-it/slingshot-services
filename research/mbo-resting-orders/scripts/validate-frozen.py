#!/usr/bin/env python3
"""Sanity-check FROZEN-OOS-EVAL's trade logic against the saved IN-SAMPLE derived data.
Must reproduce ~PF 1.19 / +$43k over the 27 known days, else the frozen script is broken.
Does NOT touch the frozen constants."""
import sys, os, glob, collections, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
spec=importlib.util.spec_from_file_location("frozen", os.path.join(os.path.dirname(os.path.abspath(__file__)),"FROZEN-OOS-EVAL.py"))
F=importlib.util.module_from_spec(spec); spec.loader.exec_module(F)
days=[]
for p in sorted(glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','derived','ext','*.npz'))):
    z=np.load(p); det=z['det']
    # derived det = (ts, spot, opx, dir, size, idx) -> frozen expects (ts, spot, opx, dir, idx)
    dd=[(r[0],r[1],r[2],int(r[3]),int(r[5])) for r in det]
    days.append((z['px'],z['ts'],dd,os.path.basename(p)[:8]))
print(f"in-sample days loaded: {len(days)}")
tr=F.run(days); fl=F.run(days,flip=True)
a=np.array([t[0] for t in tr]); d=np.array([t[1] for t in tr]); af=np.array([t[0] for t in fl])
w,l=a[a>0],a[a<=0]; pf=w.sum()/abs(l.sum())
eq=np.cumsum(a); mdd=(np.maximum.accumulate(eq)-eq).max()
byday=collections.defaultdict(float)
for t in tr: byday[t[2]]+=t[0]
v=np.array(list(byday.values()))
print(f"  n={len(a)}  WR={100*len(w)/len(a):.1f}%  PF={pf:.2f}  net=${a.sum():+,.0f}  maxDD=${mdd:,.0f}")
print(f"  long=${a[d>0].sum():+,.0f}  short=${a[d<0].sum():+,.0f}  flipped=${af.sum():+,.0f}")
print(f"  best day = {100*v.max()/a.sum():.0f}% of net; {(v>0).sum()}/{len(v)} days positive")
print(f"\n  expected from FINDINGS.md (lat=1s, slip=.25): n~922, PF~1.19, net~+$43,357, maxDD~$7,911")
ok = abs(pf-1.19)<0.10 and abs(a.sum()-43357)<6000
print(f"  {'REPRODUCES — frozen script is sound' if ok else 'MISMATCH — investigate before trusting'}")
