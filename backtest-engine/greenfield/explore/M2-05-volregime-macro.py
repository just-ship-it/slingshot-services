#!/usr/bin/env python3
"""
M2-05 Track B families 4 & 5: VOLATILITY REGIME + CROSS-COMMODITY/MACRO conditioning.
Fam4 mechanism: commodity trend/reversion payoff is vol-state dependent — breakouts pay
in expanding vol, fades pay after vol spikes overshoot. Fam5 mechanism: gold is the
inverse-dollar / real-rate asset (long gold when USD weak); oil tracks the growth/dollar
complex (long oil when copper strong / USD weak). Used as STATE FILTERS.
All conditioners use only data known at day-D close; enter D+1 open.
"""
import pandas as pd, numpy as np
import M2_lib as L

MACRO="/home/drew/projects/slingshot-services/backtest-engine/data/macro"

def load_close(sym):
    d=pd.read_csv(f"{MACRO}/{sym}_1d.csv",parse_dates=["date"]).sort_values("date")
    return d.set_index("date")["close"]

def volregime(sym):
    df=L.load(sym)
    rv=df["logret"].rolling(20).std()*np.sqrt(252)
    rank=rv.rolling(252).apply(lambda x: (x[-1]>x).mean(), raw=True).shift(1)  # pctile of latest vs past yr, known at close
    print(f"\n{'='*72}\n  {sym.upper()} — VOL REGIME: forward 10d LONG return by 20d-realized-vol quintile\n{'='*72}")
    hold=10
    for q,(lo,hi) in enumerate([(0,.2),(.2,.4),(.4,.6),(.6,.8),(.8,1.01)]):
        mask=(rank>=lo)&(rank<hi)
        tr=L.simulate(df,mask.fillna(False),1,hold,sym,min_gap=0)
        s=L.stats(tr,sym)
        print(f"  volQ{q+1} [{lo:.1f}-{hi:.1f}): {L.fmt_stats(s)}")
    # Does fade work better in high vol? test CL short-fade / GC long-fade conditioned on high vol
    r5=df["close"].pct_change(5); mu=r5.rolling(252).mean().shift(1); sd=r5.rolling(252).std().shift(1); z=(r5-mu)/sd
    if sym=="cl": base_mask=(z>=1.5); d=-1; nm="short-fade(z>=1.5)"
    else: base_mask=(z<=-2.0); d=1; nm="long-fade(z<=-2)"
    print(f"  --- {nm} conditioned on vol regime (hold5) ---")
    for lbl,vm in [("hi-vol(rank>=.6)",rank>=.6),("lo-vol(rank<.6)",rank<.6)]:
        m=(base_mask & vm).fillna(False)
        tr=L.simulate(df,m,d,5,sym,min_gap=1); s=L.stats(tr,sym)
        print(f"    {lbl:18}: {L.fmt_stats(s)}")

def macro_cond(sym):
    df=L.load(sym).set_index("date")
    print(f"\n{'='*72}\n  {sym.upper()} — MACRO STATE FILTER (hold 10d long, non-overlap)\n{'='*72}")
    if sym=="gc":
        dxy=load_close("dxy"); dxy_ma=dxy.rolling(50).mean()
        dxy_down=(dxy<dxy_ma)  # dollar in downtrend -> gold tailwind (known at close)
        cond=df.index.map(lambda d: dxy_down.get(d,np.nan))
        df["cond"]=np.array(cond,dtype=float)
        tag="DXY<50dMA (weak USD)"
    else:
        hg=load_close("hg"); hg_ma=hg.rolling(50).mean(); hg_up=(hg>hg_ma)
        cond=df.index.map(lambda d: hg_up.get(d,np.nan))
        df["cond"]=np.array(cond,dtype=float)
        tag="copper>50dMA (growth)"
    df=df.reset_index()
    for lbl,val in [(f"{tag}=TRUE",1.0),(f"{tag}=FALSE",0.0)]:
        m=(df["cond"]==val)
        tr=L.simulate(df,m,1,10,sym,min_gap=1); s=L.stats(tr,sym)
        base=L.baseline_forward(df,10,sym,1)
        print(f"  {lbl:26}: {L.fmt_stats(s)}")
    print(f"  (unconditional long hold10 baseline mean$={L.baseline_forward(df,10,sym,1)['mean_usd']:.0f})")
    # combine macro filter with momentum: long only when trend up AND macro tailwind
    trail=df["close"]/df["close"].shift(63)-1
    for lbl,cc in [("mom>0 & macroTRUE",(trail>0)&(df['cond']==1.0)),
                   ("mom>0 only",(trail>0)),
                   ("mom>0 & macroFALSE",(trail>0)&(df['cond']==0.0))]:
        tr=L.simulate(df,cc.fillna(False),1,10,sym,min_gap=1); s=L.stats(tr,sym)
        print(f"  {lbl:26}: {L.fmt_stats(s)}")

if __name__=="__main__":
    for sym in ["gc","cl"]:
        volregime(sym); macro_cond(sym)
