#!/usr/bin/env python3
"""THE question: do multi-candle 3m signatures predict which side of the previous 15m candle breaks?
   Sequence features joined to the HTF-break target, controlled for position in the HTF range,
   and priced with the R/R that falls out of the geometry."""
import pandas as pd, numpy as np, warnings
warnings.filterwarnings('ignore')
m = pd.read_csv("mtf/NQ_15m_3m_mtf.csv", low_memory=False)
r = pd.read_csv("reversal/NQ_3m_rev.csv", low_memory=False)
m = m[(m.firstBreak==1)|(m.firstBreak==-1)]
seq = ['rej3','rej5','rej10','hl3','hl5','shallow5','comp5','dnVol5','upVol5','volTrend5',
       'lowDist5','lowDist10','netMove5','netMove10','dnWickSum5','upWickSum5','closePos5']
d = m.merge(r[['tradeDate','ts']+seq], left_on=['tradeDate','ltfTs'], right_on=['tradeDate','ts'], how='inner')
d['dev']=d.tradeDate<='2024-12-31'; d['hiFirst']=(d.firstBreak==1).astype(int)
d['pb']=pd.cut(d.posInRange,[-9,.2,.35,.5,.65,.8,9],labels=['<20','20-35','35-50','50-65','65-80','>80'])
WC,LC=2,4
print(f"joined {len(d):,} decision points (dev {d.dev.sum():,} / val {(~d.dev).sum():,})")
print(f"overall P(HTF high breaks first) = {d.hiFirst.mean():.4f}\n")
print("SEQUENCE features → P(high first), top-minus-bottom quintile, AVERAGED WITHIN position buckets")
print(f"   {'feature':>13} {'dev Δ':>8} {'val Δ':>8}   {'':>4}")
keep=[]
for f in seq:
    o=[]
    for isdev in [True,False]:
        s=d[d.dev==isdev].dropna(subset=[f]).copy()
        if len(s)<3000: o.append(np.nan); continue
        s['fq']=s.groupby('pb',observed=True)[f].transform(lambda x: pd.qcut(x,5,labels=False,duplicates='drop'))
        g=s.groupby(['pb','fq'],observed=True).hiFirst.mean().unstack()
        o.append(np.nanmean([q.iloc[-1]-q.iloc[0] for _,q in g.iterrows() if q.notna().sum()>=2]))
    st='★' if not np.isnan(o[1]) and np.sign(o[0])==np.sign(o[1]) and abs(o[1])>0.02 else ''
    print(f"   {f:>13} {o[0]:+8.4f} {o[1]:+8.4f}   {st:>4}")
    if st: keep.append(f)
print(f"\n   consistent on both sets: {keep or 'none'}")
if keep:
    print("\nEV of trading the extreme quintiles (R/R from geometry, costs in ticks: win−2 / lose+4)")
    print(f"   {'feature':>13} {'set':>4} {'side':>6} {'n':>6} {'P':>7} {'winTk':>7} {'loseTk':>7} {'EV tk':>7} {'EV $':>8}")
    for f in keep:
        for isdev,lab in [(True,'dev'),(False,'val')]:
            s=d[d.dev==isdev].dropna(subset=[f]).copy()
            s['fq']=pd.qcut(s[f],5,labels=False,duplicates='drop')
            for q,side in [(4,'long'),(0,'short')]:
                x=s[s.fq==q]
                if len(x)<400: continue
                if side=='long': p,w,l = x.hiFirst.mean(), x.winTicks.mean(), x.loseTicks.mean()
                else:            p,w,l = 1-x.hiFirst.mean(), x.loseTicks.mean(), x.winTicks.mean()
                ev = p*(w-WC)-(1-p)*(l+LC)
                print(f"   {f:>13} {lab:>4} {side:>6} {len(x):>6,} {p:>7.4f} {w:>7.1f} {l:>7.1f} {ev:>+7.2f} {ev*5:>+8.1f}")
