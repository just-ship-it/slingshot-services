#!/usr/bin/env python3
"""Dealer-reaction analysis — MFE-based, penetration-sliced, placebo-controlled.

Success = P(MFE>=20 before stop) and realized BE-trail expectancy, NOT mean forward return.
Key question (Drew): does the FADE light up when the confirming candle closed 20-30 pts PAST the level (pen)?
Everything compared to placebo (round + random levels through identical machinery).
"""
import glob
import os
import numpy as np
import pandas as pd

BASE = "/home/drew/projects/slingshot-services/backtest-engine/research/dealer-reaction"


def load():
    frames = []
    for fp in glob.glob(f"{BASE}/events_*.csv"):
        fam = os.path.basename(fp)[len("events_"):-4]
        d = pd.read_csv(fp)
        d["family"] = fam
        frames.append(d)
    return pd.concat(frames, ignore_index=True)


def grp_stats(d):
    n = len(d)
    if n == 0:
        return dict(n=0)
    real = d["realized"].values
    wins, losses = real[real > 0].sum(), -real[real < 0].sum()
    pf = wins / losses if losses > 0 else np.inf
    return dict(n=n, p_hit20_s10=d["hit20_s10"].mean(), p_hit20_s15=d["hit20_s15"].mean(),
                mfe_med=d["mfe"].median(), mfe_p75=d["mfe"].quantile(.75),
                real_mean=real.mean(), real_pf=pf, real_wr=(real > 0).mean())


def line(tag, d):
    s = grp_stats(d)
    if s["n"] == 0:
        print(f"  {tag:34s} n=0"); return
    print(f"  {tag:34s} n={s['n']:4d} | P(MFE>=20 b/f stop10)={s['p_hit20_s10']*100:4.1f}% "
          f"(s15={s['p_hit20_s15']*100:4.1f}%) | MFE med={s['mfe_med']:5.1f} p75={s['mfe_p75']:5.1f} "
          f"| realized mean={s['real_mean']:+5.2f} pf={s['real_pf']:.2f} wr={s['real_wr']*100:4.1f}%")


def main():
    df = load()
    print(f"loaded {len(df)} events; families: {sorted(df.family.unique())}")
    df["pen_bkt"] = pd.cut(df["pen"], [-1e9, -10, 0, 10, 20, 30, 1e9],
                           labels=["<-10", "-10..0", "0..10", "10..20", "20..30", ">30"])

    fams = ["gex", "lt", "priorday"]
    plac = ["placebo_round", "placebo_rand"]

    print(f"\n{'='*104}\nHEADLINE: family x arm (both tf pooled) — real levels vs placebo\n{'='*104}")
    for arm in ("fade", "breakout"):
        print(f"\n[{arm.upper()}]")
        for fam in fams + plac:
            line(f"{fam}", df[(df.family == fam) & (df.arm == arm)])

    print(f"\n{'='*104}\nFADE by PENETRATION bucket (does the fade work when it closed 20-30 PAST? Drew's claim)\n{'='*104}")
    for fam in ["gex", "placebo_round", "placebo_rand"]:
        print(f"\n[{fam}] FADE, by pen bucket:")
        for b in ["<-10", "-10..0", "0..10", "10..20", "20..30", ">30"]:
            line(f"  pen {b}", df[(df.family == fam) & (df.arm == "fade") & (df.pen_bkt == b)])

    print(f"\n{'='*104}\nGEX FADE by kind x tf (which levels / which timeframe)\n{'='*104}")
    for kind in sorted(df[df.family == "gex"]["kind"].unique()):
        for tf in ("3m", "5m"):
            line(f"{kind} {tf}", df[(df.family == "gex") & (df.arm == "fade") & (df["kind"] == kind) & (df.tf == tf)])

    print(f"\n{'='*104}\nBEST-CELL per-quarter stability: GEX fade, pen>=10, 5m (if it survives placebo)\n{'='*104}")
    best = df[(df.family == "gex") & (df.arm == "fade") & (df.pen >= 10) & (df.tf == "5m")]
    plref = df[(df.family.isin(plac)) & (df.arm == "fade") & (df.pen >= 10) & (df.tf == "5m")]
    line("GEX fade pen>=10 5m", best)
    line("PLACEBO fade pen>=10 5m", plref)
    for q in sorted(best["quarter"].unique()):
        line(f"  {q}", best[best.quarter == q])


if __name__ == "__main__":
    main()
