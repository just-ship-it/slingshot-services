#!/usr/bin/env python3
"""
R8-06: GAP-UP FADE tail study (the last standing short-tilted candidate).

For gap-up days above thresholds K*ATR (0.3/0.5/0.75/1.0), forward RTH returns at
horizons open->1100, open->1300, open->1600. Per year + pooled, NQ & ES. Sign of
a real exhaustion short: forward reliably NEGATIVE and mostly across years. If the
negative years are only 2022/2025 (bear/vol) -> label bear-regime-only.
Control: the unconditional forward (all days) at each horizon.
Roll days excluded (gap invalid across contract change).
"""
import sys
sys.path.insert(0,"/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore")
from R8lib import load, mean, tstat
from collections import defaultdict

def peryr(sub, fwd):
    dd=defaultdict(list)
    for r in sub:
        v=fwd(r)
        if v is None: continue
        dd[r["year"]].append(v)
    cells=[]; negs=0; tot=0
    for y in sorted(dd):
        mu=mean(dd[y]); cells.append(f"{y}:{mu:+.1f}"); tot+=1; negs+=(mu<0)
    return "  ".join(cells), negs, tot

def main():
    for prod in ("NQ","ES"):
        rows=load(prod)
        base=[r for r in rows if r["gap"] is not None and r["atr14_prior"]]
        horizons={"open->1100":lambda r:(r["p1100"]-r["p0930"]) if r["p1100"] is not None else None,
                  "open->1300":lambda r:(r["p1300"]-r["p0930"]) if r["p1300"] is not None else None,
                  "open->1600":lambda r:(r["p1600"]-r["p0930"]) if r["p1600"] is not None else None}
        print(f"\n================ {prod} gap-up fade tail ================")
        for hn,hf in horizons.items():
            allx=[hf(r) for r in base if hf(r) is not None]
            print(f"\n-- horizon {hn}  (unconditional mean={mean(allx):+.2f}pt over n={len(allx)}) --")
            for K in (0.3,0.5,0.75,1.0):
                sub=[r for r in base if r["gap"]/r["atr14_prior"]>=K]
                xs=[hf(r) for r in sub if hf(r) is not None]
                if len(xs)<20:
                    print(f"   gap>= {K}ATR: n={len(xs)} (too few)"); continue
                cells,negs,tot=peryr(sub,hf)
                print(f"   gap>= {K}ATR: n={len(xs)} mean={mean(xs):+.2f}pt t={tstat(xs):+.2f}  yrNEG {negs}/{tot}")
                print(f"       {cells}")

if __name__=="__main__":
    main()
