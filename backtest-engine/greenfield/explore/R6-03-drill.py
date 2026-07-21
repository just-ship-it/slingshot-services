#!/usr/bin/env python3
"""R6-03: (a) decompose the 23:00 one-minute spike into gap vs intrabar;
(b) per-year detail + time-of-day placebo controls for the Europe drive and
    other candidate windows.
"""
import numpy as np, pandas as pd
from R6lib import load_panel, clock_to_sm, window_return, at_or_before

NQ = load_panel('cache_nq_et_panel.csv.gz')
ES = load_panel('cache_es_et_panel.csv.gz')
b12 = pd.read_csv('B12-days.csv'); atr = dict(zip(b12['trade_date'], b12['atr14_prior']))
YEARS=list(range(2021,2027))

# ---------- (a) 23:00 decomposition ----------
def decomp_2300(panel,label):
    gap=[]; intr=[]; full=[]
    for sd,s in panel.items():
        sm=s['sm']
        i_prev = at_or_before(s, 299)  # 22:59 bar
        i_now  = at_or_before(s, 300)  # 23:00 bar
        if i_prev is None or i_now is None: continue
        if sm[i_prev]!=299 or sm[i_now]!=300: continue
        if s['sym'][i_prev]!=s['sym'][i_now]: continue
        g = s['o'][i_now]-s['c'][i_prev]      # 22:59 close -> 23:00 open (gap)
        it= s['c'][i_now]-s['o'][i_now]       # 23:00 open -> 23:00 close (intrabar)
        gap.append(g); intr.append(it); full.append(g+it)
    gap=np.array(gap); intr=np.array(intr); full=np.array(full)
    def st(x):
        return f"mean={x.mean():+.4f} t={x.mean()/(x.std(ddof=1)/len(x)**0.5):+.2f}"
    print(f"[{label}] 23:00 bar  n={len(full)}")
    print(f"   gap (22:59c->23:00o):  {st(gap)}")
    print(f"   intrabar(23:00o->c):   {st(intr)}")
    print(f"   full(22:59c->23:00c):  {st(full)}")

print("=== (a) 23:00 one-minute decomposition ===")
decomp_2300(NQ,'NQ'); decomp_2300(ES,'ES')

# ---------- (b) window per-year + placebo ----------
def series(panel, a, b):
    recs=[]
    for sd,s in panel.items():
        wr=window_return(s,a,b,max_gap=6)
        if wr is None: continue
        av=atr.get(sd,np.nan)
        recs.append((s['year'],wr[0], wr[0]/av if av==av and av>0 else np.nan))
    return pd.DataFrame(recs,columns=['year','ret','ret_atr'])

def report(panel,name,sh,sm_,eh,em):
    a=clock_to_sm(sh,sm_); b=clock_to_sm(eh,em)
    df=series(panel,a,b); r=df['ret'].to_numpy()
    n=len(r); mean=r.mean(); t=mean/(r.std(ddof=1)/n**0.5)
    py=[df[df['year']==y]['ret'].mean() for y in YEARS]
    ny=[ (df['year']==y).sum() for y in YEARS]
    print(f"\n{name}: n={n} mean={mean:+.2f} t={t:+.2f} vnorm={df['ret_atr'].mean():+.4f}")
    print("   per-year: "+"  ".join(f"{y}:{m:+.2f}(n{c})" for y,m,c in zip(YEARS,py,ny)))
    return a,b,mean

def placebo(panel, width, anchor_a, real_mean, label):
    """Distribution of same-width close-to-close window means across all overnight
    start minutes (18:10..09:00). Where does the real window rank?"""
    means=[]
    starts=range(10, 900-width, 5)  # sm start grid over overnight
    for a in starts:
        b=a+width
        df=series(panel,a,b)
        if len(df)<200: continue
        means.append((a,df['ret'].mean()))
    ms=np.array([m for _,m in means])
    pct = (ms < real_mean).mean()*100
    print(f"   placebo[{label}] real_mean={real_mean:+.2f} is {pct:.0f}th pctile of {len(ms)} "
          f"same-width({width}m) overnight windows; placebo mean={ms.mean():+.2f} sd={ms.std():+.2f}")

print("\n=== (b) Europe drive 02:00->04:30 ===")
a,b,m=report(NQ,'NQ 02:00->04:30',2,0,4,30); placebo(NQ,b-a,a,m,'NQ')
report(ES,'ES 02:00->04:30',2,0,4,30)

print("\n=== (b) reopen 18:00->19:00 ===")
a,b,m=report(NQ,'NQ 18:00->19:00',18,0,19,0); placebo(NQ,b-a,a,m,'NQ')
report(ES,'ES 18:00->19:00',18,0,19,0)

print("\n=== (b) whole overnight 18:00->09:29 ===")
report(NQ,'NQ 18:00->09:29',18,0,9,29)
report(ES,'ES 18:00->09:29',18,0,9,29)
