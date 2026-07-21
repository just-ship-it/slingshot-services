#!/usr/bin/env python3
"""
R8-01: Unconditional drift census (the load-bearing control) + H4 late-day window hunt.

For NQ and ES, per year:
  - overnight drift (prior_rth_close -> rth_open, = gap), excl roll days
  - full RTH drift (0930 -> 1600)
  - each consecutive clock-window signed return (mark[i] -> mark[i+1])
  - key afternoon windows: 1500->1530, 1500->1600, 1300->1600, 1400->1600, 1530->1600

Goal: locate any clock window whose UNCONDITIONAL signed drift is reliably
NEGATIVE across most years (an all-regime short window), separate from the
known up-drift. Everything else in R8 is measured vs these controls.
"""
import sys
sys.path.insert(0,"/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore")
from R8lib import load, MARKS, fmt_year_table, mean, tstat, year_table

def win(a,b):
    return lambda r: (r[f"p{b}"]-r[f"p{a}"]) if (r[f"p{a}"] is not None and r[f"p{b}"] is not None) else None

def main():
    for prod in ("NQ","ES"):
        rows=load(prod)
        print(f"\n================ {prod}  ({len(rows)} days) ================")
        print("-- Overnight (prior close -> open), roll days excluded --")
        on=lambda r: r["gap"]
        print(fmt_year_table([r for r in rows if r["gap"] is not None], on, "ON gap"))
        print("-- Full RTH (0930->1600) --")
        print(fmt_year_table(rows, win("0930","1600"), "RTH"))
        print("-- Consecutive 30m windows --")
        for i in range(len(MARKS)-1):
            a,b=MARKS[i],MARKS[i+1]
            print(fmt_year_table(rows, win(a,b), f"{a}->{b}"))
        print("-- Key afternoon aggregates --")
        for a,b in [("1500","1530"),("1500","1600"),("1530","1600"),
                    ("1400","1600"),("1300","1600"),("1200","1600"),
                    ("1000","1600")]:
            print(fmt_year_table(rows, win(a,b), f"{a}->{b}"))

if __name__=="__main__":
    main()
