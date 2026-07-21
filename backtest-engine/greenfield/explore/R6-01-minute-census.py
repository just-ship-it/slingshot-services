#!/usr/bin/env python3
"""R6-01: per-session-minute 1m signed-drift & volatility census (NQ overnight).
Drift attributed to the bar ending at session_minute m (consecutive same-symbol
minutes only). Reports pooled mean, std, mean|ret|, n, per-year mean.
Outputs R6-01-minute-census.csv and prints cumulative-drift windows.
"""
import numpy as np, pandas as pd
from collections import defaultdict
from R6lib import load_panel

sessions = load_panel('cache_nq_et_panel.csv.gz')
years = list(range(2021,2027))

# accumulators keyed by sm
sum_r = defaultdict(float); sum_r2 = defaultdict(float); sum_abs = defaultdict(float); n = defaultdict(int)
sum_r_y = {y: defaultdict(float) for y in years}
n_y     = {y: defaultdict(int)   for y in years}

for sd, s in sessions.items():
    y = s['year']
    if y not in sum_r_y: continue
    sm = s['sm']; c = s['c']; sym = s['sym']
    dr = c[1:] - c[:-1]
    gap = sm[1:] - sm[:-1]
    same = sym[1:] == sym[:-1]
    end_sm = sm[1:]
    good = (gap == 1) & same
    for m, r in zip(end_sm[good], dr[good]):
        m = int(m)
        sum_r[m]+=r; sum_r2[m]+=r*r; sum_abs[m]+=abs(r); n[m]+=1
        sum_r_y[y][m]+=r; n_y[y][m]+=1

rows=[]
for m in sorted(n):
    cnt=n[m]
    mean=sum_r[m]/cnt
    var=sum_r2[m]/cnt-mean*mean
    std=var**0.5 if var>0 else 0
    d={'sm':m,'n':cnt,'mean_r':mean,'std_r':std,'mabs_r':sum_abs[m]/cnt,
       'tstat': mean/(std/cnt**0.5) if std>0 else 0}
    for y in years:
        d[f'mean_{y}']= sum_r_y[y][m]/n_y[y][m] if n_y[y][m] else float('nan')
    # ET clock label
    hh=(m//60+18)%24; mm=m%60
    d['et']=f'{hh:02d}:{mm:02d}'
    rows.append(d)
df=pd.DataFrame(rows)
df.to_csv('R6-01-minute-census.csv',index=False)
print(f'wrote R6-01-minute-census.csv ({len(df)} minutes)')

# --- cumulative drift across overnight to eyeball windows ---
ov = df[df['sm']<=929].copy().sort_values('sm')
ov['cum']=ov['mean_r'].cumsum()
print('\n=== Cumulative signed drift across overnight (18:00->09:29), every 30min ===')
for _,r in ov[ov['sm']%30==0].iterrows():
    print(f"  {r['et']}  sm={int(r['sm']):4d}  cum_drift={r['cum']:+7.2f}pt")

# --- strongest per-minute signed means (|tstat|) in overnight ---
print('\n=== Top 25 overnight minutes by |tstat| (per-minute drift) ===')
top=ov.reindex(ov['tstat'].abs().sort_values(ascending=False).index).head(25)
for _,r in top.iterrows():
    yy=[r[f'mean_{y}'] for y in years]
    signs=''.join('+' if v>0 else '-' for v in yy)
    print(f"  {r['et']} n={int(r['n']):4d} mean={r['mean_r']:+.4f} t={r['tstat']:+.2f} yr[{signs}]")
