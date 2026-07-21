#!/usr/bin/env python3
"""R6-06: nail down the 03:30-04:10 ET European-open drive.
 - fine scan for best window
 - market-executable semantics: enter at OPEN of start bar, exit at OPEN of end bar
 - per-year with n, pooled=day-weighted (1 obs/day), vol-normalized
 - placebo rank vs all same-width overnight windows
 - cost statement
 - check it's not beta: window return in bear-overnight years / conditional on overnight sign
"""
import numpy as np, pandas as pd
from R6lib import load_panel, clock_to_sm, window_return, at_or_before
from collections import defaultdict

NQ=load_panel('cache_nq_et_panel.csv.gz'); ES=load_panel('cache_es_et_panel.csv.gz')
b12=pd.read_csv('B12-days.csv'); atr=dict(zip(b12['trade_date'],b12['atr14_prior']))
YEARS=list(range(2021,2027))

def market_exec_return(s,a,b,max_gap=6):
    """Enter at OPEN of first bar with sm>=a; exit at OPEN of first bar with sm>=b.
    (market entry/time-exit, knowable). Same symbol required."""
    smv=s['sm']
    ia=np.searchsorted(smv,a,side='left'); ib=np.searchsorted(smv,b,side='left')
    if ia>=len(smv) or ib>=len(smv) or ib<=ia: return None
    if smv[ia]-a>max_gap or smv[ib]-b>max_gap: return None
    if s['sym'][ia]!=s['sym'][ib]: return None
    return s['o'][ib]-s['o'][ia], smv[ia], smv[ib]

def eval_win(panel,a,b,exec_mode=False):
    yv=defaultdict(list); vn=[]
    for sd,s in panel.items():
        if exec_mode:
            x=market_exec_return(s,a,b)
            r=x[0] if x else None
        else:
            x=window_return(s,a,b,max_gap=6); r=x[0] if x else None
        if r is None: continue
        yv[s['year']].append(r)
        av=atr.get(sd,np.nan)
        if av==av and av>0: vn.append(r/av)
    allv=np.array([v for y in YEARS for v in yv.get(y,[])])
    mean=allv.mean(); t=mean/(allv.std(ddof=1)/len(allv)**0.5)
    ym=[(len(yv[y]),np.mean(yv[y])) if yv.get(y) else (0,np.nan) for y in YEARS]
    return dict(n=len(allv),mean=mean,t=t,ym=ym,vn=np.mean(vn) if vn else np.nan)

def et(m): hh=(m//60+18)%24; mm=m%60; return f'{hh:02d}:{mm:02d}'

# --- fine scan around 03:15-04:30 for best NQ window (close-to-close) ---
print("=== fine scan (NQ close-to-close), start 03:00-04:00, width 15-60 ===")
best=[]
for a in range(clock_to_sm(3,0),clock_to_sm(4,0),5):
    for w in (15,20,30,45,60):
        r=eval_win(NQ,a,a+w)
        if r['n']<200: continue
        allpos=all(m>0 for _,m in r['ym'] if m==m)
        best.append((r['t'],a,a+w,r['mean'],allpos))
best.sort(reverse=True)
for t,a,b,mean,allpos in best[:8]:
    print(f"  {et(a)}->{et(b)} mean={mean:+.2f} t={t:+.2f} allpos6/6={allpos}")

# --- lock window 03:35->04:05, both semantics, NQ+ES ---
A,B=clock_to_sm(3,35),clock_to_sm(4,5)
print(f"\n=== LOCKED WINDOW 03:35->04:05 ET (30m) ===")
for src,panel in (('NQ',NQ),('ES',ES)):
    for mode,em in (('close2close',False),('mktexec(open2open)',True)):
        r=eval_win(panel,A,B,exec_mode=em)
        print(f"  {src} {mode:20s} n={r['n']} mean={r['mean']:+.2f} t={r['t']:+.2f} vnorm={r['vn']:+.4f}")
        print(f"      per-year: "+"  ".join(f"{y}:{m:+.2f}(n{n})" for y,(n,m) in zip(YEARS,r['ym'])))

# --- placebo: rank of 03:35->04:05 among all same-width overnight windows (NQ) ---
w=B-A; means=[]
for a in range(10,900-w,5):
    r=eval_win(NQ,a,a+w)
    if r['n']>=200: means.append(r['mean'])
ms=np.array(means); real=eval_win(NQ,A,B)['mean']
print(f"\nplacebo: 03:35->04:05 NQ mean={real:+.2f} = {(ms<real).mean()*100:.1f}th pctile of "
      f"{len(ms)} same-width(30m) overnight windows (placebo mean={ms.mean():+.2f}, max={ms.max():+.2f})")

# --- not-beta check: window return conditioned on whole-overnight sign & in bear yrs ---
print("\n=== not-beta check: 03:35->04:05 NQ vs whole-overnight sign ===")
recs=[]
for sd,s in NQ.items():
    win=window_return(s,A,B,max_gap=6)
    ov =window_return(s,clock_to_sm(18,0),clock_to_sm(9,29),max_gap=6)
    pre=window_return(s,clock_to_sm(18,0),A,max_gap=6)  # move before window
    if win and ov and pre:
        recs.append((s['year'],win[0],ov[0],pre[0]))
d=pd.DataFrame(recs,columns=['year','win','ov','pre'])
print(f"  E[win | pre-window move UP]  ={d[d.pre>0].win.mean():+.2f} (n{(d.pre>0).sum()})")
print(f"  E[win | pre-window move DOWN]={d[d.pre<0].win.mean():+.2f} (n{(d.pre<0).sum()})")
print(f"  E[win | whole-ON up]={d[d.ov>0].win.mean():+.2f}  E[win | whole-ON down]={d[d.ov<0].win.mean():+.2f}")
print(f"  corr(win, pre-window move)={d.win.corr(d.pre):+.3f}  (near0 => not just continuation of prior drift)")
