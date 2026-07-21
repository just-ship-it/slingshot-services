#!/usr/bin/env python3
"""R6-02: evaluate named overnight windows on NQ + ES.
Per-day close-to-close window return (same symbol both ends). Reports pooled mean
(=day mean, 1 obs/day), t-stat, per-year sign, ES replication, vol-normalized mean
(ret / atr14_prior), and control windows.
"""
import numpy as np, pandas as pd
from R6lib import load_panel, clock_to_sm, window_return

NQ = load_panel('cache_nq_et_panel.csv.gz')
ES = load_panel('cache_es_et_panel.csv.gz')

# atr14_prior for vol-normalization, keyed by session_date
b12 = pd.read_csv('B12-days.csv')
atr = dict(zip(b12['trade_date'], b12['atr14_prior']))

YEARS = list(range(2021,2027))

def eval_window(panel, sh, sm_, eh, em):
    a = clock_to_sm(sh, sm_); b = clock_to_sm(eh, em)
    recs=[]
    for sd, s in panel.items():
        wr = window_return(s, a, b, max_gap=6)
        if wr is None: continue
        ret = wr[0]
        av = atr.get(sd, np.nan)
        recs.append((sd, s['year'], ret, ret/av if av and av==av and av>0 else np.nan))
    return pd.DataFrame(recs, columns=['sd','year','ret','ret_atr'])

def summarize(df):
    r=df['ret'].to_numpy()
    n=len(r); mean=r.mean(); sd=r.std(ddof=1); t=mean/(sd/n**0.5)
    per_year={}
    for y in YEARS:
        ry=df[df['year']==y]['ret']
        per_year[y]=(len(ry), ry.mean() if len(ry) else float('nan'))
    signs=''.join('+' if per_year[y][1]>0 else ('-' if per_year[y][1]==per_year[y][1] else '?') for y in YEARS)
    vn=df['ret_atr'].dropna()
    return dict(n=n, mean=mean, t=t, signs=signs, vnorm=vn.mean() if len(vn) else float('nan'),
                allpos=all(per_year[y][1]>0 for y in YEARS if per_year[y][1]==per_year[y][1]),
                allneg=all(per_year[y][1]<0 for y in YEARS if per_year[y][1]==per_year[y][1]),
                per_year=per_year)

WINDOWS = [
    ('23:00 single min (22:59->23:00)', 22,59,23,0),
    ('23:00 +/-5m (22:55->23:05)',      22,55,23,5),
    ('23:00 +/-10m (22:50->23:10)',     22,50,23,10),
    ('23:00->23:30',                    23,0,23,30),
    ('22:45->23:15',                    22,45,23,15),
    ('22:00->24:00 (Asia block)',       22,0,0,0),
    ('19:00->02:00 (Asia session)',     19,0,2,0),
    ('18:00->18:30 (reopen drive)',     18,0,18,30),
    ('18:00->19:00 (reopen hr)',        18,0,19,0),
    ('18:15->18:45',                    18,15,18,45),
    ('03:15->03:30 (0325 fade window)', 3,15,3,30),
    ('03:20->03:35',                    3,20,3,35),
    ('02:00->04:30 (Europe drive)',     2,0,4,30),
    ('01:30->05:00',                    1,30,5,0),
    ('02:00->05:00 (Europe/London)',    2,0,5,0),
    ('05:00->09:29 (pre-NY)',           5,0,9,29),
    ('09:15->09:29 (pre-open fade)',    9,15,9,29),
    ('09:20->09:29',                    9,20,9,29),
    ('18:00->09:29 (whole overnight)',  18,0,9,29),
    ('05:25->05:40 (0532 drive)',       5,25,5,40),
    ('04:20->04:35 (0430 drive)',       4,20,4,35),
]

print(f"{'window':38s} {'src':3s} {'n':>4s} {'mean':>7s} {'t':>6s} {'yrsign':7s} {'vnorm':>7s}")
print('-'*90)
for name,sh,sm_,eh,em in WINDOWS:
    for src,panel in (('NQ',NQ),('ES',ES)):
        df=eval_window(panel,sh,sm_,eh,em)
        if len(df)<50:
            print(f"{name:38s} {src:3s}  (n={len(df)} too few)"); continue
        r=summarize(df)
        flag=' *' if (r['allpos'] or r['allneg']) and abs(r['t'])>2.5 else ''
        print(f"{name:38s} {src:3s} {r['n']:4d} {r['mean']:+7.2f} {r['t']:+6.2f} [{r['signs']}] {r['vnorm']:+7.4f}{flag}")
    print()
