#!/usr/bin/env python3
"""BATCH B — the two A1 findings that were measured and never traded, priced in dollars."""
import pandas as pd, numpy as np, json, warnings
warnings.filterwarnings('ignore')
meta=json.load(open('cache/NQ/meta.json')); symcol=np.fromfile('cache/NQ/sym.u8',dtype=np.uint8)
multi={td for td,(a,b) in meta['days'].items() if len(np.unique(symcol[a:b]))>1}
d=pd.read_csv("mech_NQ.csv")
sym=d.sym.values
dirty=np.array(d.tradeDate.isin(multi))|np.array([sym[i+1]!=sym[i] if i+1<len(sym) else False for i in range(len(d))])|np.array([sym[i]!=sym[i-1] if i>0 else False for i in range(len(d))])
d=d[~dirty].dropna(subset=['onRange','gap','atr20']).reset_index(drop=True)
d['dev']=d.tradeDate<='2024-12-31'; PT=20.0; COST=15.0
d['onRangeAtr']=d.onRange/d.atr20; d['gapAtr']=d.gap/d.atr20
print(f"{len(d)} clean sessions\n")
print("A1 FINDING #1 — quiet overnight → BOTH ON extremes broken in RTH (whipsaw)?")
d['onT']=pd.qcut(d.onRangeAtr,3,labels=['low','mid','high'])
for t,g in d.groupby('onT',observed=True):
    print(f"   ON range {t:>4}: both broken {g.bothBroke.mean()*100:>5.1f}%   only-one {(1-g.bothBroke.mean())*100:>5.1f}%   n={len(g):,}")
print("\n→ tradable reading: on QUIET nights breakouts whipsaw; on WIDE nights they run.\n")
print("BREAKOUT TRADE: stop-entry at whichever ON extreme breaks first, stop at the other extreme,")
print("exit at RTH close. Priced in $ at 1 NQ with costs.\n")
def bo(g):
    """first ON extreme to break = entry; other extreme = stop; exit RTH close."""
    res=[]
    for _,r in g.iterrows():
        if r.firstBreak==0: continue
        side=r.firstBreak
        entry=r.onHigh if side>0 else r.onLow
        stop=r.onLow if side>0 else r.onHigh
        # did the other extreme break after? then we were stopped
        tb=r.onHiBreakMin if side>0 else r.onLoBreakMin
        to=r.onLoBreakMin if side>0 else r.onHiBreakMin
        stopped = (not np.isnan(to)) and to>tb
        pnl=(stop-entry)*side*PT if stopped else (r.rthClose-entry)*side*PT
        res.append(pnl-COST)
    return np.array(res)
print(f"   {'ON range':>9} {'set':>4} {'n':>5} {'mean $':>9} {'median $':>9} {'WR':>6}")
for t in ['low','mid','high']:
    for nm,mask in [('dev',d.dev),('val',~d.dev)]:
        g=d[(d.onT==t)&mask]; r=bo(g)
        if len(r)<20: continue
        print(f"   {t:>9} {nm:>4} {len(r):>5} {r.mean():>+9.0f} {np.median(r):>+9.0f} {(r>0).mean()*100:>5.0f}%")
print("\nA1 FINDING #2 — gap fill rate by |gap|/ATR, and what to trade at each size")
d['gb']=pd.cut(d.gapAtr.abs(),[0,.1,.2,.35,.5,.75,9],labels=['<.1','.1-.2','.2-.35','.35-.5','.5-.75','>.75'])
print(f"   {'|gap|/ATR':>10} {'n':>5} {'filled%':>8}  |  {'FADE $':>9} {'CONT $':>9}  (dev)")
for b,g in d[d.dev].groupby('gb',observed=True):
    if len(g)<30: continue
    filled=g.gapFillMin.notna().mean()*100
    side=-np.sign(g.gap)                       # fade = trade toward the prior close
    fade=(np.where(g.gapFillMin.notna(),(g.prevRthClose-g.rthOpen)*side*-1*0+abs(g.gap),(g.rthClose-g.rthOpen)*side)*PT-COST)
    fade=np.where(g.gapFillMin.notna(), abs(g.gap)*PT-COST, ((g.rthClose-g.rthOpen)*side*PT-COST))
    cont=((g.rthClose-g.rthOpen)*np.sign(g.gap)*PT-COST)
    print(f"   {str(b):>10} {len(g):>5} {filled:>7.1f}%  |  {fade.mean():>+9.0f} {cont.mean():>+9.0f}")
print("\n   (FADE = enter at RTH open toward prior close, exit at fill or RTH close;")
print("    CONT = enter at RTH open in the gap direction, exit RTH close)")
