#!/usr/bin/env python3
"""
R8-03: H3 FAILED-BREAKOUT / UPSIDE-SWEEP REVERSAL (the classic bull-trap short).

Mechanism: price makes a NEW high above a knowable prior level (prior-day RTH high
PDH, or overnight high ONH), then reclaims back BELOW that level within M minutes.
A failed upside breakout should, if real, drift DOWN afterward -- vs a HELD breakout
(broke and stayed above) and vs the unconditional drift.

Streams the 1m primary cache, RTH bars only (0930-1600 ET). Prior-day RTH high and
overnight (18:00 prev -> 09:30) high are computed live-causally (known at 0930).
Rollover days (RTH symbol != prior RTH symbol) are skipped for PDH (level is a
different contract).

For each day classify PDH interaction:
  A no-touch : rth_high < PDH (never broke)
  B held     : broke above PDH (high>=PDH) and rth_close >= PDH
  C trap     : broke above PDH then rth_close < PDH  (bull trap by close)
  C' reclaim : broke above PDH then price prints back below PDH within M min intraday
Forward metrics from the RECLAIM minute (C'): reclaim_close -> 1600 close, and -> +60m.
Contrast: held group's (first-break minute -> 1600). Report per-year signs.

Also runs the same on overnight-high (ONH) as the swept level.
"""
import csv, sys
from collections import defaultdict

BASE="/home/drew/projects/slingshot-services/backtest-engine"
SRC=f"{BASE}/greenfield/explore/cache/NQ_1m_primary.csv"
M=30  # reclaim window minutes

def hh(s): return int(s)
def is_rth(h): return 930<=int(h)<=1600

def load_prior_levels():
    """From R8_NQ_daily: date-> (PDH valid?, PDH). PDH = prior RTH high, same contract."""
    import importlib.util
    rows=[]
    with open(f"{BASE}/greenfield/explore/R8_NQ_daily.csv",newline="") as f:
        for r in csv.DictReader(f): rows.append(r)
    pdh={}
    for i,r in enumerate(rows):
        if i==0: continue
        prev=rows[i-1]
        if int(r["roll_day"])==1: continue
        pdh[r["trade_date"]]=float(prev["rth_high"])
    return pdh

def main():
    pdh=load_prior_levels()
    # stream 1m; per day collect ordered RTH bars + overnight high
    # We also need ONH: max high from prev 18:00 ET to today 0930. Build by scanning
    # all bars grouped by et_date but ON belongs to the "session" starting prev 18:00.
    # Simpler causal ONH: for each et_date, the overnight = bars of that et_date with
    # hhmm<0930 PLUS prev date's hhmm>=1800. We'll accumulate per-date pre-open high.
    pre_open_high=defaultdict(lambda:-1e18)   # et_date -> max high of that date's bars before 0930
    eve_high=defaultdict(lambda:-1e18)        # et_date -> max high of that date's bars >=1800
    day_bars=defaultdict(list)                 # et_date -> [(hhmm,o,h,l,c)] RTH only
    dates_order=[]
    seen=set()
    with open(SRC,newline="") as f:
        rdr=csv.reader(f); header=next(rdr)
        idx={k:i for i,k in enumerate(header)}
        iD,iM,iO,iH,iL,iC=(idx[k] for k in("et_date","et_hhmm","o","h","l","c"))
        for row in rdr:
            d=row[iD]; m=row[iM]; hi=float(row[iH]); h=int(m)
            if h<930:
                if hi>pre_open_high[d]: pre_open_high[d]=hi
            elif h>=1800:
                if hi>eve_high[d]: eve_high[d]=hi
            if is_rth(m):
                if d not in seen: seen.add(d); dates_order.append(d)
                day_bars[d].append((m,float(row[iO]),hi,float(row[iL]),float(row[iC])))
    # ONH per date: max(eve_high[prev_date], pre_open_high[date])
    onh={}
    for i,d in enumerate(dates_order):
        prev=dates_order[i-1] if i>0 else None
        vals=[pre_open_high[d]]
        if prev is not None and eve_high[prev]>-1e17: vals.append(eve_high[prev])
        vals=[v for v in vals if v>-1e17]
        if vals: onh[d]=max(vals)

    def run(level_map, name):
        groups={"A":[], "B":[], "C":[]}    # forward-to-close lists
        recl_fwd=[]   # (year, reclaim->close, reclaim->+60)
        recl_rows=[]
        held_fwd=[]   # held: firstbreak->close
        for d in dates_order:
            if d not in level_map: continue
            L=level_map[d]
            bars=day_bars[d]
            if len(bars)<300: continue
            close_1600=bars[-1][4]
            year=int(d[:4])
            broke=False; bo_i=None
            for i,(m,o,h,l,c) in enumerate(bars):
                if not broke and h>=L:
                    broke=True; bo_i=i
                    break
            if not broke:
                groups["A"].append(close_1600-bars[0][4]); continue
            # after breakout: look for reclaim (close back below L) within M bars
            recl_i=None
            for j in range(bo_i, min(bo_i+M+1,len(bars))):
                if bars[j][4] < L:
                    recl_i=j; break
            held = close_1600 >= L
            if held:
                groups["B"].append(close_1600-bars[bo_i][4])
                held_fwd.append((year, close_1600-bars[bo_i][4]))
            else:
                groups["C"].append(close_1600-bars[bo_i][4])
            if recl_i is not None:
                rc=bars[recl_i][4]
                f_close=close_1600-rc
                nxt=bars[min(recl_i+60,len(bars)-1)][4]
                f60=nxt-rc
                recl_fwd.append((year,f_close,f60))
                recl_rows.append((d,year,rc,f_close,f60))
        def stats(xs):
            xs=[x for x in xs if x is not None]
            n=len(xs); mu=sum(xs)/n if n else float('nan')
            return n,mu
        def peryr(pairs, k=1):
            dd=defaultdict(list)
            for t in pairs: dd[t[0]].append(t[k])
            out=[]; signs=[]
            for y in sorted(dd):
                mu=sum(dd[y])/len(dd[y]); out.append(f"{y}:{mu:+.1f}(n{len(dd[y])})"); signs.append(mu<0)
            neg=sum(signs)
            return "  ".join(out), neg, len(signs)
        print(f"\n#### Level = {name}")
        for g in ("A","B","C"):
            n,mu=stats(groups[g])
            lbl={"A":"no-touch fwd(open->close)","B":"HELD break fwd(break->close)","C":"TRAP(close<L) fwd(break->close)"}[g]
            print(f"  {g} {lbl}: n={n} mean={mu:+.2f}pt")
        n,mu=stats([t[1] for t in recl_fwd])
        cells,neg,tot=peryr(recl_fwd,1)
        print(f"  RECLAIM->close: n={n} mean={mu:+.2f}pt  (short wants NEGATIVE)")
        print(f"    per-year: {cells}")
        print(f"    year-signs NEG: {neg}/{tot}")
        n2,mu2=stats([t[2] for t in recl_fwd])
        cells2,neg2,tot2=peryr(recl_fwd,2)
        print(f"  RECLAIM->+60m: n={n2} mean={mu2:+.2f}pt")
        print(f"    per-year: {cells2}   NEG {neg2}/{tot2}")
        hn,hmu=stats([t[1] for t in held_fwd])
        print(f"  (contrast) HELD break->close: n={hn} mean={hmu:+.2f}pt")

    print("================ NQ H3 failed-breakout ================")
    run(pdh,"prior-day RTH high (PDH)")
    run(onh,"overnight high (ONH)")

if __name__=="__main__":
    main()
