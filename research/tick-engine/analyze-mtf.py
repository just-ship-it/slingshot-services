#!/usr/bin/env python3
"""Do the 3m candles predict which side of the previous 15m candle breaks first —
   beyond the mechanical 'price is already near that side' effect? And is it worth money?"""
import pandas as pd, numpy as np, warnings, sys
warnings.filterwarnings('ignore')
f = sys.argv[1] if len(sys.argv)>1 else "mtf/NQ_15m_3m_mtf.csv"
d = pd.read_csv(f, low_memory=False)
d = d[(d.firstBreak!=0)&(d.firstBreak!=2)].copy()          # resolved cases only
d['dev'] = d.tradeDate <= '2024-12-31'
d['hiFirst'] = (d.firstBreak==1).astype(int)
# realistic costs in TICKS: entry slip 1 + commission 1 on every trade; stop exit slips 2 more
WIN_COST, LOSE_COST = 2, 4
d['evLong']  = d.winTicks - WIN_COST                        # if high breaks first
d['evLongL'] = d.loseTicks + LOSE_COST                      # if low breaks first (loss magnitude)
print(f"{len(d):,} resolved decision points | high-first {d.hiFirst.mean()*100:.1f}%\n")

print("1) MECHANICAL BASELINE — P(high first) by where price sits in the HTF range")
d['pb'] = pd.cut(d.posInRange,[-9,.1,.25,.4,.6,.75,.9,9],labels=['<10%','10-25','25-40','40-60','60-75','75-90','>90'])
t = d.groupby('pb',observed=True).agg(n=('hiFirst','size'), pHi=('hiFirst','mean'),
                                      win=('winTicks','mean'), lose=('loseTicks','mean'))
t['evLong_ticks'] = t.pHi*(t.win-WIN_COST) - (1-t.pHi)*(t.lose+LOSE_COST)
t['evShort_ticks'] = (1-t.pHi)*(t.lose-WIN_COST) - t.pHi*(t.win+LOSE_COST)
print(t.round(3).to_string())
print("   → P(high first) rises with position, but so does the loss leg. EV is what matters.\n")

print("2) DO THE 3m FEATURES ADD ANYTHING? P(high first) by feature quintile, WITHIN position buckets")
feats = ['lUpVolPct','lDnVolPct','lClv','lDir','lUpInt','lDnInt','lVolZ','cumMoveTicks','lUpCentroidV','lDnCentroidV']
print(f"   {'feature':>14} {'dev ΔP(hi)':>11} {'val ΔP(hi)':>11}   (top-quintile minus bottom, averaged within position buckets)")
keep=[]
for ft in feats:
    out=[]
    for isdev in [True,False]:
        s = d[d.dev==isdev].dropna(subset=[ft])
        if len(s)<3000: out.append(np.nan); continue
        s = s.copy()
        s['fq'] = s.groupby('pb',observed=True)[ft].transform(lambda x: pd.qcut(x,5,labels=False,duplicates='drop'))
        g = s.groupby(['pb','fq'],observed=True).hiFirst.mean().unstack()
        sp = np.nanmean([r.iloc[-1]-r.iloc[0] for _,r in g.iterrows() if r.notna().sum()>=2])
        out.append(sp)
    star = '★' if (not np.isnan(out[1])) and np.sign(out[0])==np.sign(out[1]) and abs(out[1])>0.02 else ''
    print(f"   {ft:>14} {out[0]:+11.4f} {out[1]:+11.4f}   {star}")
    if star: keep.append(ft)
print(f"\n   features carrying incremental signal on BOTH sets: {keep or 'none'}")
