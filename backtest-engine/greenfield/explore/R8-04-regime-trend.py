#!/usr/bin/env python3
"""
R8-04: BEAR-REGIME conditioner (live-computable trend filter).

Question the census must answer: is downside only tradable in bear regimes, and
can the regime be flagged LIVE at decision time (0930)?

Regime flag (knowable at 0930): today's rth_open vs trailing N-day SMA of prior
RTH closes (causal, excludes today). Below SMA = "downtrend". Also a slope flag.

For each regime bucket report forward returns per year:
  - RTH (open->close)   [intraday short-from-open in a downtrend]
  - afternoon 1300->1600 and 1500->1600
  - overnight gap (next-day) -- momentum of regime overnight
Plus: gap-up-fade CONDITIONED on downtrend (does the fade concentrate in bear regime?).

If forward returns are reliably NEGATIVE only in the below-SMA bucket and that
bucket clusters in specific years -> downside is a bear-regime overlay, not an
all-regime edge. If below-SMA is negative EVERY year it appears -> a deployable
regime-gated short.
"""
import sys
sys.path.insert(0,"/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore")
from R8lib import load, mean, tstat
from collections import defaultdict

def sma_flags(rows, N):
    closes=[]
    for r in rows:
        if len(closes)>=N:
            sma=sum(closes[-N:])/N
            r[f"below{N}"]= (r["rth_open"] < sma) if r["rth_open"] is not None else None
            # slope: sma now vs sma N/2 ago
            if len(closes)>=N+N//2:
                sma_prev=sum(closes[-N-N//2:-N//2])/N
                r[f"dn{N}"]= (sma < sma_prev)
            else:
                r[f"dn{N}"]=None
        else:
            r[f"below{N}"]=None; r[f"dn{N}"]=None
        closes.append(r["rth_close"])

def peryr(sub, fwd):
    dd=defaultdict(list)
    for r in sub:
        v=fwd(r)
        if v is None: continue
        dd[r["year"]].append(v)
    cells=[]; negs=0; tot=0
    for y in sorted(dd):
        mu=mean(dd[y]); cells.append(f"{y}:{mu:+.1f}(n{len(dd[y])})"); tot+=1; negs+= (mu<0)
    return "  ".join(cells), negs, tot

def summ(rows, flagkey, fwd, label):
    below=[r for r in rows if r.get(flagkey) is True and fwd(r) is not None]
    above=[r for r in rows if r.get(flagkey) is False and fwd(r) is not None]
    for name,sub in (("BELOW/down",below),("ABOVE/up",above)):
        xs=[fwd(r) for r in sub]
        cells,negs,tot=peryr(sub,fwd)
        print(f"  [{name}] {label}: n={len(xs)} mean={mean(xs):+.2f}pt t={tstat(xs):+.2f}  yrNEG {negs}/{tot}")
        print(f"      {cells}")

def main():
    for prod in ("NQ","ES"):
        rows=load(prod)
        for N in (50,100,200):
            sma_flags(rows,N)
        print(f"\n================ {prod} regime trend ================")
        rthret=lambda r: r["rth_ret"]
        aft=lambda r: (r["p1600"]-r["p1300"]) if (r["p1600"] is not None and r["p1300"] is not None) else None
        lateaft=lambda r: (r["p1600"]-r["p1500"]) if (r["p1600"] is not None and r["p1500"] is not None) else None
        gap=lambda r: r["gap"]
        for N in (50,100,200):
            print(f"\n-- SMA{N} regime (open vs SMA{N}) --")
            summ(rows,f"below{N}",rthret,"RTH ret")
            summ(rows,f"below{N}",aft,"aft 1300->1600")
            summ(rows,f"below{N}",gap,"overnight gap (same-day, regime drift)")
        # gap-up fade concentrated in downtrend? extreme up-gap AND below SMA100
        print("\n-- gap-up fade x regime (SMA100): big up-gap (>0.5 ATR) split by regime --")
        biggap=[r for r in rows if r["gap"] is not None and r["atr14_prior"] and r["gap"]/r["atr14_prior"]>0.5]
        fwd=lambda r: (r["p1600"]-r["p0930"]) if (r["p1600"] is not None and r["p0930"] is not None) else None
        summ(biggap,"below100",fwd,"big-up-gap -> RTH ret")

if __name__=="__main__":
    main()
