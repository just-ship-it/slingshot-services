#!/usr/bin/env python3
"""Descriptive picture of wick anatomy. usage: analyze-wicks.py NQ 5m"""
import sys
import pandas as pd, numpy as np
P, TF = (sys.argv[1] if len(sys.argv)>1 else 'NQ'), (sys.argv[2] if len(sys.argv)>2 else '5m')
df = pd.read_csv(f"wicks/{P}_{TF}_wicks.csv")
df = df[df.n1s >= 30]                                   # skip near-empty candles
up = df.c >= df.o
print(f"=== {P} {TF} — {len(df):,} candles ===\n")
print("1) How much of a candle is wick? (mean %)")
print(f"   time  : top {df.upTimePct.mean()*100:5.1f}   body {df.bodyTimePct.mean()*100:5.1f}   bottom {df.dnTimePct.mean()*100:5.1f}")
print(f"   volume: top {df.upVolPct.mean()*100:5.1f}   body {df.bodyVolPct.mean()*100:5.1f}   bottom {df.dnVolPct.mean()*100:5.1f}")
print(f"   price : top {(df.upWickTicks/df.rangeTicks.clip(lower=1)).mean()*100:5.1f}   body {(df.bodyTicks/df.rangeTicks.clip(lower=1)).mean()*100:5.1f}   bottom {(df.dnWickTicks/df.rangeTicks.clip(lower=1)).mean()*100:5.1f}")
print("\n2) Volume INTENSITY — volume share ÷ time share (>1 = trades faster there)")
for z in ['up','body','dn']:
    r = (df[f'{z}VolPct']/df[f'{z}TimePct'].replace(0,np.nan))
    print(f"   {z:5s}: median {r.median():.3f}  mean {r.mean():.3f}")
print("\n3) WHEN is each wick made? volume-centroid, 0=open 1=close")
for z,lab in [('up','top'),('dn','bottom')]:
    s = df[f'{z}CentroidV'].dropna()
    print(f"   {lab:6s}: mean {s.mean():.3f}  p10 {s.quantile(.1):.2f}  p50 {s.median():.2f}  p90 {s.quantile(.9):.2f}  |  early(<0.4) {(s<0.4).mean()*100:4.1f}%  late(>0.6) {(s>0.6).mean()*100:4.1f}%")
print("\n4) Same, split by candle direction (does the wick that gets 'rejected' form late?)")
for name, m in [('UP candles', up), ('DOWN candles', ~up)]:
    d = df[m]
    print(f"   {name:12s}  top centroid {d.upCentroidV.mean():.3f}  bottom centroid {d.dnCentroidV.mean():.3f}  " 
          f"| top vol% {d.upVolPct.mean()*100:4.1f}  bottom vol% {d.dnVolPct.mean()*100:4.1f}")
print("\n5) Big wicks only (wick ≥ 50% of candle range) — the 'rejection' candles")
for z,lab in [('up','top'),('dn','bottom')]:
    big = df[(df[f'{z}WickTicks']/df.rangeTicks.clip(lower=1)) >= 0.5]
    if not len(big): continue
    r = (big[f'{z}VolPct']/big[f'{z}TimePct'].replace(0,np.nan))
    print(f"   {lab:6s} n={len(big):6,}  time {big[f'{z}TimePct'].mean()*100:4.1f}%  vol {big[f'{z}VolPct'].mean()*100:4.1f}%  "
          f"intensity {r.median():.2f}  centroid {big[f'{z}CentroidV'].mean():.3f}  extreme@ {big[f'{z}ExtremePct'].mean():.3f}  touches {big[f'{z}Touches'].mean():.1f}")
print("\n6) Re-probe count (how many separate excursions into the wick zone)")
print(f"   top: {df.upTouches.mean():.2f} mean, {(df.upTouches>=3).mean()*100:.0f}% have ≥3 | bottom: {df.dnTouches.mean():.2f}, {(df.dnTouches>=3).mean()*100:.0f}% have ≥3")
