#!/usr/bin/env python3
"""R6-05: definitive joint NQ+ES grid scan.
For a grid of overnight windows (start x width), require:
  - NQ same sign all 6 years AND ES same sign all 6 years AND signs agree
Report those, plus the top NQ windows by |t| with their ES agreement, so we can
see if ANYTHING survives the joint-stability + cost filter.
"""
import numpy as np, pandas as pd
from R6lib import load_panel, window_return
from collections import defaultdict

NQ=load_panel('cache_nq_et_panel.csv.gz'); ES=load_panel('cache_es_et_panel.csv.gz')
YEARS=list(range(2021,2027))

def win_series(panel,a,b):
    yv=defaultdict(list)
    for sd,s in panel.items():
        x=window_return(s,a,b,max_gap=6)
        if x: yv[s['year']].append(x[0])
    return yv

def stats_win(panel,a,b):
    yv=win_series(panel,a,b)
    allv=[v for y in YEARS for v in yv.get(y,[])]
    if len(allv)<200: return None
    allv=np.array(allv); mean=allv.mean(); t=mean/(allv.std(ddof=1)/len(allv)**0.5)
    ym=[np.mean(yv[y]) if yv.get(y) else np.nan for y in YEARS]
    pos=all(v>0 for v in ym if v==v); neg=all(v<0 for v in ym if v==v)
    return mean,t,ym,pos,neg,len(allv)

def sm_to_et(m):
    hh=(m//60+18)%24; mm=m%60; return f'{hh:02d}:{mm:02d}'

survivors=[]; allrows=[]
for width in (15,30,60,90,150):
    for a in range(0,900-width,5):
        b=a+width
        nq=stats_win(NQ,a,b)
        if nq is None: continue
        nmean,nt,nym,npos,nneg,nn=nq
        es=stats_win(ES,a,b)
        if es is None: continue
        emean,et_,eym,epos,eneg,en=es
        agree = (npos and epos) or (nneg and eneg)
        allrows.append((a,b,width,nmean,nt,npos,nneg,emean,epos,eneg,agree))
        if agree and abs(nmean)>=1.5:   # clears ~1pt round-trip cost with margin
            survivors.append((a,b,width,nmean,nt,emean,nym,eym))

print(f"Scanned {len(allrows)} windows.")
print(f"\n=== JOINT SURVIVORS: NQ 6/6 AND ES 6/6 same-sign AND |NQ mean|>=1.5pt ===")
if not survivors:
    print("  NONE.")
for a,b,w,nm,nt,em,nym,eym in sorted(survivors,key=lambda r:-abs(r[3])):
    print(f"  {sm_to_et(a)}->{sm_to_et(b)} ({w}m) NQ mean={nm:+.2f} t={nt:+.2f} ES mean={em:+.2f}")
    print(f"      NQ yr:{[round(x,1) for x in nym]}")
    print(f"      ES yr:{[round(x,1) for x in eym]}")

# How many windows are NQ-6/6 at all, and of those how many ES-agree?
nq6=[r for r in allrows if r[5] or r[6]]
nq6_esagree=[r for r in nq6 if r[10]]
print(f"\nWindows NQ same-sign 6/6: {len(nq6)}  of which ES also 6/6-agree: {len(nq6_esagree)}")
print(f"  (of {len(nq6_esagree)} joint-6/6, those with |NQ mean|>=1.5pt: {len(survivors)})")

print("\n=== Top 15 NQ windows by |t| (any width) w/ ES agreement flag ===")
for a,b,w,nm,nt,npos,nneg,em,epos,eneg,agree in sorted(allrows,key=lambda r:-abs(r[4]))[:15]:
    print(f"  {sm_to_et(a)}->{sm_to_et(b)} ({w:3d}m) NQ mean={nm:+6.2f} t={nt:+5.2f} "
          f"NQ6/6={'Y' if (npos or nneg) else 'n'} ES mean={em:+6.2f} ES6/6={'Y' if (epos or eneg) else 'n'} agree={'Y' if agree else 'n'}")
