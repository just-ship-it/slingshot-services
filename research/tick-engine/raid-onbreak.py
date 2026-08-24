#!/usr/bin/env python3
"""Chase the hit: wide-overnight-range → RTH breakout of the ON extreme.
   Is it drift? Is it stable per year? What's the best threshold and exit?"""
import pandas as pd, numpy as np, json, warnings
warnings.filterwarnings('ignore')
meta=json.load(open('cache/NQ/meta.json')); symcol=np.fromfile('cache/NQ/sym.u8',dtype=np.uint8)
multi={td for td,(a,b) in meta['days'].items() if len(np.unique(symcol[a:b]))>1}
d=pd.read_csv("mech_NQ.csv"); sym=d.sym.values
dirty=np.array(d.tradeDate.isin(multi))|np.array([sym[i+1]!=sym[i] if i+1<len(sym) else False for i in range(len(d))])|np.array([sym[i]!=sym[i-1] if i>0 else False for i in range(len(d))])
d=d[~dirty].dropna(subset=['onRange','atr20']).reset_index(drop=True)
d['dev']=d.tradeDate<='2024-12-31'; d['year']=d.tradeDate.str[:4]
PT=20.0; COST=15.0
d['onRangeAtr']=d.onRange/d.atr20
def trades(g):
    rows=[]
    for _,r in g.iterrows():
        if r.firstBreak==0 or np.isnan(r.onHigh) or np.isnan(r.onLow): continue
        side=int(r.firstBreak)
        entry=r.onHigh if side>0 else r.onLow
        stop=r.onLow if side>0 else r.onHigh
        tb=r.onHiBreakMin if side>0 else r.onLoBreakMin
        to=r.onLoBreakMin if side>0 else r.onHiBreakMin
        stopped=(not np.isnan(to)) and to>tb
        pnl=((stop-entry)*side if stopped else (r.rthClose-entry)*side)*PT-COST
        rows.append({'date':r.tradeDate,'year':r.year,'dev':r.dev,'side':side,'pnl':pnl,
                     'onAtr':r.onRangeAtr,'stopped':stopped,'risk':abs(entry-stop)*PT,'entryMin':tb})
    return pd.DataFrame(rows)
T=trades(d)
print(f"all breakout trades: {len(T)}\n")
print("1) THRESHOLD SWEEP on overnight range (ATR units), dev then val")
print(f"   {'onRange ≥':>10} {'nDev':>5} {'devEV$':>8} {'devWR':>6} {'nVal':>5} {'valEV$':>8} {'valWR':>6}")
for q in [0.50,0.60,0.67,0.75,0.85,0.90]:
    thr=T[T.dev].onAtr.quantile(q)
    sd=T[(T.onAtr>=thr)&T.dev]; sv=T[(T.onAtr>=thr)&~T.dev]
    if len(sd)<40: continue
    print(f"   {thr:>10.2f} {len(sd):>5} {sd.pnl.mean():>+8.0f} {(sd.pnl>0).mean()*100:>5.0f}% {len(sv):>5} {sv.pnl.mean():>+8.0f} {(sv.pnl>0).mean()*100:>5.0f}%")
thr=T[T.dev].onAtr.quantile(0.67)
S=T[T.onAtr>=thr]
print(f"\n2) IS IT DRIFT? (threshold {thr:.2f}) — split by side")
for side,lab in [(1,'long breakouts'),(-1,'short breakouts')]:
    sd=S[(S.side==side)&S.dev]; sv=S[(S.side==side)&~S.dev]
    print(f"   {lab:>16}: dev n={len(sd):>4} ${sd.pnl.mean():>+7.0f} median ${sd.pnl.median():>+7.0f} | val n={len(sv):>4} ${sv.pnl.mean():>+7.0f} median ${sv.pnl.median():>+7.0f}")
print(f"\n3) PER YEAR (threshold {thr:.2f}, both sides)")
for y,g in S.groupby('year'):
    print(f"   {y}  n={len(g):>4}  mean ${g.pnl.mean():>+7.0f}  median ${g.pnl.median():>+7.0f}  WR {(g.pnl>0).mean()*100:>3.0f}%  total ${g.pnl.sum():>+9,.0f}")
print(f"\n4) OUTLIER DEPENDENCE (dev): mean ${S[S.dev].pnl.mean():+.0f}, "
      f"trimmed10% ${S[S.dev].pnl.sort_values().iloc[int(len(S[S.dev])*.1):int(len(S[S.dev])*.9)].mean():+.0f}, "
      f"median ${S[S.dev].pnl.median():+.0f}")
print(f"   whipsaw (stopped) rate: dev {S[S.dev].stopped.mean()*100:.1f}%  val {S[~S.dev].stopped.mean()*100:.1f}%")
print(f"   mean risk per trade (ON range): ${S.risk.mean():,.0f}   median entry time: {S.entryMin.median():.0f} min after 09:30")
print(f"\n5) ANNUALISED at 1 NQ: dev ${S[S.dev].pnl.sum()/4:,.0f}/yr ({len(S[S.dev])/4:.0f} trades/yr) | "
      f"val ${S[~S.dev].pnl.sum()/1.45:,.0f}/yr ({len(S[~S.dev])/1.45:.0f} trades/yr)")
