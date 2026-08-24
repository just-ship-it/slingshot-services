#!/usr/bin/env python3
"""The coin-flip zone: price mid-range of the HTF candle, payoffs symmetric. Can 3m structure move
   P(high first) off 50/50 enough to pay? Plus feature combinations and a k-fold sanity check."""
import pandas as pd, numpy as np, warnings, sys
warnings.filterwarnings('ignore')
d = pd.read_csv(sys.argv[1] if len(sys.argv)>1 else "mtf/NQ_15m_3m_mtf.csv", low_memory=False)
d = d[(d.firstBreak!=0)&(d.firstBreak!=2)].copy()
d['dev'] = d.tradeDate<='2024-12-31'; d['hiFirst']=(d.firstBreak==1).astype(int)
WC, LC = 2, 4
mid = d[(d.posInRange>=0.35)&(d.posInRange<=0.65)].copy()
print(f"MID-RANGE ZONE (35–65% of HTF range): {len(mid):,} points, P(high first) = {mid.hiFirst.mean():.4f}")
print(f"   mean win {mid.winTicks.mean():.1f} ticks, mean lose {mid.loseTicks.mean():.1f} → payoffs ~symmetric\n")
def ev(p, w, l): return p*(w-WC) - (1-p)*(l+LC)
print("1) single features, mid-range only — P(high first) by quintile")
print(f"   {'feature':>14} {'devQ0':>7} {'devQ4':>7} {'devΔ':>7} | {'valQ0':>7} {'valQ4':>7} {'valΔ':>7} {'':>3}")
good=[]
for ft in ['lUpVolPct','lDnVolPct','lClv','lVolZ','lUpInt','lDnInt','cumMoveTicks','lUpTouches','lDnTouches','lRangeTicks','lUpCentroidV']:
    r=[]
    for isdev in [True,False]:
        s=mid[mid.dev==isdev].dropna(subset=[ft])
        if len(s)<2000: r+=[np.nan]*3; continue
        q=pd.qcut(s[ft],5,labels=False,duplicates='drop'); g=s.groupby(q,observed=True).hiFirst.mean()
        r+=[g.iloc[0],g.iloc[-1],g.iloc[-1]-g.iloc[0]]
    star='★' if not np.isnan(r[5]) and np.sign(r[2])==np.sign(r[5]) and abs(r[5])>0.02 else ''
    print(f"   {ft:>14} {r[0]:7.4f} {r[1]:7.4f} {r[2]:+7.4f} | {r[3]:7.4f} {r[4]:7.4f} {r[5]:+7.4f} {star:>3}")
    if star: good.append(ft)
print(f"\n   consistent: {good or 'none'}")
if good:
    print("\n2) EV of actually trading the extreme quintiles of the best feature (mid-range, in ticks & $)")
    for ft in good:
        for isdev,lab in [(True,'dev'),(False,'val')]:
            s=mid[mid.dev==isdev].dropna(subset=[ft]).copy()
            q=pd.qcut(s[ft],5,labels=False,duplicates='drop'); s['q']=q
            for qq,side in [(4,'long'),(0,'short')]:
                x=s[s.q==qq]
                if len(x)<300: continue
                if side=='long': e=ev(x.hiFirst.mean(), x.winTicks.mean(), x.loseTicks.mean())
                else:            e=ev(1-x.hiFirst.mean(), x.loseTicks.mean(), x.winTicks.mean())
                print(f"   {ft:>12} {lab} Q{qq} {side:>5}: n={len(x):5,} P={x.hiFirst.mean() if side=='long' else 1-x.hiFirst.mean():.4f} "
                      f"EV={e:+6.2f} ticks = ${e*5:+7.2f}/trade")
