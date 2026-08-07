#!/usr/bin/env python3
"""G1 STEP 2 — robustness: N x H PF surface, dev/OOS split, cost sensitivity."""
import numpy as np, pandas as pd
from G1_donchian import load, backtest, stats

def subset(trades, y0=None, y1=None):
    out=[]
    for t in trades:
        y=t["exit_date"].year
        if y0 and y<y0: continue
        if y1 and y>y1: continue
        out.append(t)
    return out

if __name__ == "__main__":
    df = load()
    Ns=[50,75,100,125,150]; Hs=[21,42,63]
    print("=== PF surface (fixed-hold, full history 1994-2026, MGC net) ===")
    print("        " + "".join(f"H={h:<12d}" for h in Hs))
    pf_surf={}
    for N in Ns:
        row=f"N={N:<5d}"
        for H in Hs:
            tr=backtest(df,N,H,"fixed"); s=stats(tr); pf_surf[(N,H)]=s
            row+=f" PF{s['pf']:.2f}/n{s['n']}/${s['total']/1000:.0f}k".ljust(14)
        print(row)

    print("\n=== opposite-channel exit (N sweep, full history) ===")
    for N in Ns:
        tr=backtest(df,N,None,"opposite"); s=stats(tr)
        print(f"  N={N:3d}: PF={s['pf']:.2f} n={s['n']} total=${s['total']:,.0f} maxDD=${s['maxdd']:,.0f} WR={s['wr']:.0f}%")

    print("\n=== DEV (exit<=2017) vs OOS (exit>=2018) — fixed hold ===")
    print(f"{'N/H':>8s} {'devPF':>7s} {'devN':>5s} {'devTot':>9s} | {'oosPF':>7s} {'oosN':>5s} {'oosTot':>9s}")
    for N in Ns:
        for H in Hs:
            tr=backtest(df,N,H,"fixed")
            dev=subset(tr,y1=2017); oos=subset(tr,y0=2018)
            ds=stats(dev); os_=stats(oos)
            dpf=ds.get('pf',0); opf=os_.get('pf',0)
            print(f"{N:3d}/{H:<3d} {dpf:7.2f} {ds.get('n',0):5d} ${ds.get('total',0):>8,.0f} | "
                  f"{opf:7.2f} {os_.get('n',0):5d} ${os_.get('total',0):>8,.0f}")

    print("\n=== Cost sensitivity (N=100 H=42, vary RT cost) ===")
    import G1_donchian as G
    for cost in [0.0, 3.5, 7.0, 14.0]:
        G.RT_COST=cost
        tr=backtest(df,100,42,"fixed"); s=stats(tr)
        print(f"  RT=${cost:5.1f}: PF={s['pf']:.2f} total=${s['total']:,.0f} mean=${s['mean']:.0f}")
    G.RT_COST=3.5
