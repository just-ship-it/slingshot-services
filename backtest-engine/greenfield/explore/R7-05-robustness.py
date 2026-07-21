#!/usr/bin/env python3
"""R7-05: sharpen the two core candidates (Monday-strength, Tuesday-AM-weakness):
window concentration + first-half/second-half stability + holiday confound check."""
import numpy as np, pandas as pd
from R7lib import load, summ, fmt, SEGMENTS
df = load("R7-nq-anchors.csv")
segs = ["open15","am1_0930_1030","am2_0930_1100","mid_1100_1400","pm_1400_1600","lasthr_1500_1600","rth_full"]

print("="*90,"\nMONDAY across windows (concentration)\n","="*90)
for s in segs: print(fmt(summ(df, df.dow==0, s, "  Mon")))
print("\nTUESDAY across windows\n","-"*40)
for s in segs: print(fmt(summ(df, df.dow==1, s, "  Tue")))

print("\n"+"="*90,"\nSAMPLE-HALF stability (H1<=2023-06 vs H2>2023-06)\n","="*90)
h1 = df.dt <= "2023-06-30"; h2 = df.dt > "2023-06-30"
for lbl,seg,mask in [("Mon rth_full","rth_full",df.dow==0),
                     ("Tue am1(short)","am1_0930_1030",df.dow==1),
                     ("Mon am1","am1_0930_1030",df.dow==0),
                     ("Mon pm","pm_1400_1600",df.dow==0)]:
    print(fmt(summ(df, mask&h1, seg, f"  {lbl} H1")))
    print(fmt(summ(df, mask&h2, seg, f"  {lbl} H2")))

print("\n"+"="*90,"\nHOLIDAY confound: Monday drift excluding post-holiday & half days\n","="*90)
clean = ~df.post_holiday & ~df.pre_holiday & ~df.half_day
print(fmt(summ(df, (df.dow==0), "rth_full", "  Mon all")))
print(fmt(summ(df, (df.dow==0)&clean, "rth_full", "  Mon clean")))
print(fmt(summ(df, (df.dow==1), "am1_0930_1030", "  Tue all")))
print(fmt(summ(df, (df.dow==1)&clean, "am1_0930_1030", "  Tue clean")))
