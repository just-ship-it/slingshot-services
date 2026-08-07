#!/usr/bin/env python3
"""
M2-03 Track B family 2: SEASONALITY / CALENDAR.
Mechanism: oil has seasonal demand (driving/heating) + roll-timing flows; gold has
month/quarter and turn-of-month rebalancing + rate-event clustering. All causal:
the calendar is known in advance, so these are lookahead-free by construction.
Tests: day-of-week, turn-of-month, month-of-year. Matched-control = unconditional day.
"""
import pandas as pd, numpy as np
import M2_lib as L

def next_day_ret_dollar(df, sym):
    """PnL($) of long from open[D+1] to close[D+1] (1-day hold), per row D. cost applied."""
    pv=L.SPEC[sym]["pt_value"]; cost=L.SPEC[sym]["cost_pts"]
    o=df["open"].values; c=df["close"].values
    fwd=np.full(len(df),np.nan)
    fwd[:-1]=(c[1:]-o[1:])  # long next-day open->close, points
    return (fwd-cost)*pv  # cost+$ for a long; symmetric handled by sign later

def dow(sym):
    df=L.load(sym)
    df["dow"]=df["date"].dt.dayofweek
    # forward = the day whose return we capture (enter that day's open, exit its close)
    pv=L.SPEC[sym]["pt_value"]; cost=L.SPEC[sym]["cost_pts"]
    df["fwd_pts"]=(df["close"]-df["open"])  # same-day open->close (known which weekday it is in advance)
    df["fwd_usd_long"]=(df["fwd_pts"]-cost)*pv
    print(f"\n{'='*60}\n  {sym.upper()} DAY-OF-WEEK (long open->close that day, net cost)\n{'='*60}")
    names=["Mon","Tue","Wed","Thu","Fri"]
    allmean=df["fwd_usd_long"].mean()
    for d in range(5):
        s=df[df.dow==d]["fwd_usd_long"]
        wr=(s>0).mean()
        print(f"  {names[d]}: n={len(s):>4} mean$={s.mean():>7.1f} med$={s.median():>7.1f} WR={wr*100:4.1f}%  (all-day mean ${allmean:.1f})")

def turn_of_month(sym):
    df=L.load(sym).reset_index(drop=True)
    df["ym"]=df["date"].dt.to_period("M")
    # rank trading day within month (1=first) and from end (-1=last)
    df["tdom"]=df.groupby("ym").cumcount()+1
    df["tdom_end"]=df.groupby("ym").cumcount(ascending=False)+1
    pv=L.SPEC[sym]["pt_value"]; cost=L.SPEC[sym]["cost_pts"]
    df["fwd_usd"]=(df["close"]-df["open"]-cost)*pv  # long same-day
    print(f"\n{'='*60}\n  {sym.upper()} TURN-OF-MONTH (mean$ long each same-day, by day-of-month position)\n{'='*60}")
    allm=df["fwd_usd"].mean()
    print(f"  all-day baseline mean$={allm:.1f}")
    print("  first days:", end="")
    for k in range(1,7):
        s=df[df.tdom==k]["fwd_usd"]; print(f"  d{k}:{s.mean():+.0f}(n{len(s)})",end="")
    print("\n  last days :", end="")
    for k in range(1,7):
        s=df[df.tdom_end==k]["fwd_usd"]; print(f"  -{k}:{s.mean():+.0f}(n{len(s)})",end="")
    print()
    # candidate TOM window trade: enter open of last-2 day, hold to first-3 (a ~5-day window)
    # build explicit trades: signal at close of tdom_end==3 -> enter next open, hold 5
    sig=(df["tdom_end"]==3)
    for hold in [3,5,7]:
        tr=L.simulate(df,sig,1,hold,sym,min_gap=1)
        s=L.stats(tr,sym)
        base=L.baseline_forward(df,hold,sym,1)
        print(f"  TOM trade (enter ~last-2 close, hold {hold}): {L.fmt_stats(s)} | base mean$={base['mean_usd']:.0f}")
        if hold==5:
            pos=sum(1 for y,ss in L.per_year(tr,sym) if ss.get('mean_usd',0)>0); t=len(L.per_year(tr,sym))
            print(f"      per-year: {pos}/{t} positive")
            for name,ss in L.per_regime(tr,sym): print(f"      {name:18}: {L.fmt_stats(ss)}")
            pm,_=L.placebo(df,s['n'],1,hold,sym,iters=300); print(f"      placebo p={(pm>=s['mean_usd']).mean():.3f} (plc ${pm.mean():.0f}+/-{pm.std():.0f})")

def month_of_year(sym):
    df=L.load(sym)
    df["mo"]=df["date"].dt.month; df["yr"]=df["date"].dt.year
    pv=L.SPEC[sym]["pt_value"]; cost=L.SPEC[sym]["cost_pts"]
    # monthly return: close last day of month vs close last day prior month
    m=df.groupby(df["date"].dt.to_period("M")).agg(close=("close","last"),mo=("mo","first"),yr=("yr","first")).reset_index(drop=True)
    m["mret_pts"]=m["close"].diff()
    print(f"\n{'='*60}\n  {sym.upper()} MONTH-OF-YEAR (mean monthly pt move, long)\n{'='*60}")
    names="Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
    allm=m["mret_pts"].mean()
    for mo in range(1,13):
        s=m[m.mo==mo]["mret_pts"].dropna()
        wr=(s>0).mean()
        print(f"  {names[mo-1]}: n={len(s):>3} mean_pts={s.mean():>8.1f} (${s.mean()*pv:>8.0f}) WR={wr*100:4.1f}%  [all-mo ${allm*pv:.0f}]")

if __name__=="__main__":
    for sym in ["gc","cl"]:
        dow(sym); turn_of_month(sym); month_of_year(sym)
