#!/usr/bin/env python3
"""R6-07: robustness of 03:35->04:05 ET drive.
median vs mean, % positive days, DST-season split, day-of-week, distribution tails.
Also quick cost-net summary and the 02:10-02:40 secondary check.
"""
import numpy as np, pandas as pd
from R6lib import load_panel, clock_to_sm, window_return

NQ=load_panel('cache_nq_et_panel.csv.gz'); ES=load_panel('cache_es_et_panel.csv.gz')

def collect(panel,a,b):
    recs=[]
    for sd,s in panel.items():
        x=window_return(s,a,b,max_gap=6)
        if x: recs.append((sd,s['year'],s['dow'],x[0]))
    return pd.DataFrame(recs,columns=['sd','year','dow','r'])

A,B=clock_to_sm(3,35),clock_to_sm(4,5)
for src,panel in (('NQ',NQ),('ES',ES)):
    d=collect(panel,A,B); r=d['r']
    print(f"\n=== {src} 03:35->04:05 robustness (n={len(d)}) ===")
    print(f"  mean={r.mean():+.2f}  median={r.median():+.2f}  %pos={ (r>0).mean()*100:.1f}%  "
          f"std={r.std():.1f}  min={r.min():.0f} max={r.max():.0f}")
    # trimmed mean (drop top/bottom 2.5%)
    lo,hi=r.quantile([.025,.975]); tm=r[(r>=lo)&(r<=hi)].mean()
    print(f"  95% trimmed mean={tm:+.2f}  (robust to tails)")
    # DST season split: winter months (Nov-Feb) vs summer (Apr-Sep) via sd month
    d['mon']=d['sd'].str[5:7].astype(int)
    wint=d[d.mon.isin([11,12,1,2])]['r']; summ=d[d.mon.isin([4,5,6,7,8,9])]['r']
    print(f"  winter(NDJF) mean={wint.mean():+.2f}(n{len(wint)})  summer(AMJJAS) mean={summ.mean():+.2f}(n{len(summ)})")
    # day of week
    print("  by dow: "+"  ".join(f"{['Mo','Tu','We','Th','Fr','Sa','Su'][k]}:{d[d.dow==k]['r'].mean():+.2f}" for k in range(5)))

# secondary 02:10-02:40
print("\n=== secondary 02:10->02:40 ===")
for src,panel in (('NQ',NQ),('ES',ES)):
    d=collect(panel,clock_to_sm(2,10),clock_to_sm(2,40)); r=d['r']
    print(f"  {src} mean={r.mean():+.2f} median={r.median():+.2f} %pos={(r>0).mean()*100:.1f}% "
          f"per-year:{[round(d[d.year==y]['r'].mean(),1) for y in range(2021,2027)]}")

print("""
COST NET (03:35->04:05, market entry + time exit, both slip):
  gross NQ +2.58pt ; @0.5pt/side => -1.0pt RT => net +1.58pt/day
                     @0.6pt/side => -1.2pt RT => net +1.38pt/day
  This hour (post-EU-open ~03:00 ET) is moderately liquid, not the 00-02 ET lull.
""")
