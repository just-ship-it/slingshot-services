#!/usr/bin/env python3
"""C2-40: CHANNEL REGIME + time-of-day census.

Descriptive, from the registry only.
  - What fraction of RTH freeze points sit in a "well fit" channel (r2 above
    grid thresholds), per tf/K, per year?
  - Is channel-respect (high r2) time-of-day dependent (the 10:00-11:30 drive
    vs midday chop hypothesis)?
  - Distribution of |slope_norm| and channel width/ATR by time-of-day.

Usage: python3 C2-40-regime.py [registry.csv]
"""
import sys
import numpy as np
import pandas as pd
import C2_common as C2

pd.set_option("display.width", 220)
REG = sys.argv[1] if len(sys.argv) > 1 else f"{C2.HERE}/C2-registry-NQ.csv"


def tod_label(fe):
    # fe = 1m tmin of freeze (930=09:30 .. 1320=16:00)
    if fe < 990:   return "0930-1030"
    if fe < 1050:  return "1030-1130"
    if fe < 1170:  return "1130-1330"
    if fe < 1260:  return "1330-1500"
    return "1500-1600"


def main():
    reg = pd.read_csv(REG)
    reg["tod"] = reg["freeze_end"].map(tod_label)
    reg["wid_atr"] = reg["w2s"] / reg["atr14"]

    for tf, K in [(5, 12), (15, 8)]:
        sub = reg[(reg.tf == tf) & (reg.K == K)]
        print("=" * 80)
        print(f"### REGIME tf={tf}m K={K}  (fraction of freezes with r2 >= threshold)")
        rows = []
        for yr, g in sub.groupby("year"):
            rows.append(dict(year=yr, n=len(g),
                             **{f"r2>={t}": round((g.r2 >= t).mean(), 3) for t in C2.CP["r2_grid"]},
                             med_r2=round(g.r2.median(), 3)))
        print(pd.DataFrame(rows).to_string(index=False))

        print(f"\n  channel respect by time-of-day (frac r2>=0.7, med |slope_norm|, med width/ATR):")
        trows = []
        for tod, g in sub.groupby("tod"):
            trows.append(dict(tod=tod, n=len(g), frac_r2_70=round((g.r2 >= 0.7).mean(), 3),
                              med_absslope_norm=round(g.slope_norm.abs().median(), 3),
                              med_wid_atr=round(g.wid_atr.median(), 3)))
        order = ["0930-1030", "1030-1130", "1130-1330", "1330-1500", "1500-1600"]
        td = pd.DataFrame(trows).set_index("tod").reindex(order)
        print(td.to_string())
        print()


if __name__ == "__main__":
    main()
