#!/usr/bin/env python3
"""
R8-05: FORWARD overnight/next-day short conditioned on trend regime (clean, causal).

Regime flag at day t is knowable at 16:00 ET t:
    below_N[t] = rth_close[t] < SMA_N(rth_close through t)     (SMA excludes future)
Forward targets (t+1 must not be a roll day; levels/prices same contract):
    ON  = open[t+1] - close[t]          (overnight only)  -- tradeable: hold short o/n
    C2C = close[t+1] - close[t]         (overnight + next RTH) -- swing short to next close
    RTH1= close[t+1] - open[t+1]        (next-day RTH only)
No shared price between flag(close[t]) and ON/C2C beyond close[t] anchoring both the
level test and the return start -- a low close does not mechanically bias fwd move.

Reports per-year mean + sign for BELOW vs ABOVE regime, NQ and ES. A short edge
wants BELOW to be reliably NEGATIVE across years; the ABOVE bucket is the drift
control (should be >=0). Also reports the BELOW-minus-unconditional spread.
"""
import sys
sys.path.insert(0,"/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore")
from R8lib import load, mean, tstat
from collections import defaultdict

def add_flags(rows, Ns):
    closes=[]
    for r in rows:
        for N in Ns:
            if len(closes)>=N:
                sma=sum(closes[-N:])/N
                r[f"below{N}"]= r["rth_close"] < sma
            else:
                r[f"below{N}"]=None
        closes.append(r["rth_close"])
    # link next
    for i in range(len(rows)-1): rows[i]["_next"]=rows[i+1]
    rows[-1]["_next"]=None

def fwd_on(r):
    nx=r.get("_next")
    if nx is None or nx["roll_day"]==1 or nx["rth_open"] is None: return None
    return nx["rth_open"]-r["rth_close"]
def fwd_c2c(r):
    nx=r.get("_next")
    if nx is None or nx["roll_day"]==1 or nx["rth_close"] is None: return None
    return nx["rth_close"]-r["rth_close"]
def fwd_rth1(r):
    nx=r.get("_next")
    if nx is None or nx["roll_day"]==1 or nx["rth_open"] is None or nx["rth_close"] is None: return None
    return nx["rth_close"]-nx["rth_open"]

def peryr(sub, fwd):
    dd=defaultdict(list)
    for r in sub:
        v=fwd(r)
        if v is None: continue
        dd[r["year"]].append(v)
    cells=[]; negs=0; tot=0
    for y in sorted(dd):
        mu=mean(dd[y]); cells.append(f"{y}:{mu:+.1f}(n{len(dd[y])})"); tot+=1; negs+=(mu<0)
    return "  ".join(cells), negs, tot

def block(rows, flag, fwd, name):
    below=[r for r in rows if r.get(flag) is True and fwd(r) is not None]
    above=[r for r in rows if r.get(flag) is False and fwd(r) is not None]
    allx=[fwd(r) for r in rows if fwd(r) is not None]
    unc=mean(allx)
    for tag,sub in (("BELOW",below),("ABOVE",above)):
        xs=[fwd(r) for r in sub]; cells,negs,tot=peryr(sub,fwd)
        print(f"    [{tag}] {name}: n={len(xs)} mean={mean(xs):+.2f}pt t={tstat(xs):+.2f}  (unc={unc:+.2f}) yrNEG {negs}/{tot}")
        print(f"        {cells}")

def main():
    for prod in ("NQ","ES"):
        rows=load(prod)
        add_flags(rows,(50,100,200))
        print(f"\n================ {prod}  forward overnight/next-day by regime ================")
        for N in (50,100,200):
            print(f"\n-- regime = close vs SMA{N} (flag known 16:00 t) --")
            block(rows,f"below{N}",fwd_on,"ON (o/n only)")
            block(rows,f"below{N}",fwd_c2c,"C2C (o/n+next RTH)")
            block(rows,f"below{N}",fwd_rth1,"RTH t+1 only")

if __name__=="__main__":
    main()
