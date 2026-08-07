#!/usr/bin/env python3
"""
RG2e — mechanism decomposition of the gap-continuation edge (NQ+ES pooled, full sample).

RG2d showed: unconfirmed up-gaps FADE (lose), but up-gaps whose open HOLDS as the low through the first
15 min CONTINUE (win, PF~1.2). So the real variable is EARLY-DRIVE PERSISTENCE, with the gap as context.

Decompose the 2x2 on EVERY day (entry 9:45, exit 15:45):
    gap sign  x  early-drive (open held as low = up-drive / open held as high = down-drive)
Buckets:
  (1) up-gap  & up-drive (open held low)   -> confirmed continuation LONG   [current strategy]
  (2) up-gap  & broke below open           -> gap FAILED  -> fade SHORT?
  (3) dn-gap  & dn-drive (open held high)   -> confirmed continuation SHORT
  (4) dn-gap  & broke above open            -> gap FAILED  -> fade LONG?
Also the gap-agnostic persistence legs:
  (5) any up-drive  -> LONG   (does early strength predict continuation regardless of gap?)
  (6) any dn-drive  -> SHORT
Direction is measured on the SIGNED forward move (open->... ) so we can see if the SIGN is load-bearing
(first-hour program warned: continuation there was just unconditional long drift, direction not load-bearing).
All returns in xRange (pnl/prev_range) so NQ and ES pool. tol = 0.015*prev_range (tight), gap = 0.05*prev_range.
"""
import os
import numpy as np
import pandas as pd

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
W = 15
TOLF = 0.015
GAPF = 0.05


def load(instr):
    return pd.read_csv(f"{BASE}/greenfield/explore/RG2d-{instr}-rich.csv")


def stats(p):
    p = p[np.isfinite(p)]
    if len(p) == 0:
        return dict(n=0, mean=np.nan, wr=np.nan, pf=np.nan, sh=np.nan)
    wins, losses = p[p > 0].sum(), -p[p < 0].sum()
    pf = wins / losses if losses > 0 else np.inf
    sh = p.mean() / p.std(ddof=1) * np.sqrt(len(p)) if len(p) > 1 and p.std() > 0 else np.nan
    return dict(n=len(p), mean=p.mean(), wr=(p > 0).mean(), pf=pf, sh=sh)


def line(tag, xr):
    s = stats(xr)
    print(f"  {tag:38s} n={s['n']:4d} mean_xR={s['mean']:+.4f} wr={s['wr']*100:4.1f}% "
          f"pf={s['pf']:.2f} sh={s['sh']:+.2f}")


def build():
    frames = []
    for instr in ("nq", "es"):
        D = load(instr)
        gap = (D["day_open"] - D["prev_close"]).values
        pr = D["prev_range"].values
        tol = TOLF * pr
        gthr = GAPF * pr
        entry = D["entry15"].values
        exitp = D["exit1545"].values
        fwd_long = (exitp - entry)              # points, long 9:45->15:45
        xr_long = np.where(pr > 0, fwd_long / pr, np.nan)   # signed: + = went up
        up_drive = D["clow15"].values >= D["day_open"].values - tol    # open held as low
        dn_drive = D["chigh15"].values <= D["day_open"].values + tol   # open held as high
        f = pd.DataFrame(dict(instr=instr, year=D["year"].values, gap=gap, gthr=gthr,
                              xr_long=xr_long, up_drive=up_drive, dn_drive=dn_drive))
        frames.append(f)
    return pd.concat(frames, ignore_index=True)


def main():
    df = build()
    up = df["gap"] > df["gthr"]
    dn = df["gap"] < -df["gthr"]
    ud = df["up_drive"].values
    dd = df["dn_drive"].values
    xl = df["xr_long"].values         # signed forward (long convention)

    print(f"pooled NQ+ES, {len(df)} days. entry 9:45, exit 15:45. xR = signed forward / prev_range.\n")
    print("=== 2x2: gap direction x early-drive persistence ===")
    line("(1) up-gap & open held low  -> LONG",  xl[(up.values & ud)])
    line("(2) up-gap & broke below open -> SHORT", -xl[(up.values & ~ud)])
    line("(2b) up-gap & broke below open [long]",  xl[(up.values & ~ud)])
    line("(3) dn-gap & open held high -> SHORT", -xl[(dn.values & dd)])
    line("(4) dn-gap & broke above open -> LONG",  xl[(dn.values & ~dd)])

    print("\n=== gap-agnostic early-drive persistence (full sample) ===")
    line("(5) any open-held-low  -> LONG",  xl[ud])
    line("(6) any open-held-high -> SHORT", -xl[dd])
    line("    control: NO strong drive -> LONG", xl[~ud & ~dd])
    line("    baseline: every day -> LONG", xl)

    print("\n=== is the SIGN load-bearing? (up-drive LONG vs up-drive SHORT) ===")
    line("up-drive LONG",  xl[ud])
    line("up-drive SHORT", -xl[ud])
    line("dn-drive LONG",  xl[dd])
    line("dn-drive SHORT", -xl[dd])

    print("\n=== per-year: the two continuation legs (pooled) ===")
    for tag, mask, sgn in [("up-gap held-low LONG", (up.values & ud), +1),
                           ("dn-gap held-high SHORT", (dn.values & dd), -1)]:
        print(f"  [{tag}]")
        for y in sorted(df["year"].unique()):
            m = mask & (df["year"].values == y)
            v = sgn * xl[m]
            v = v[np.isfinite(v)]
            if len(v) == 0:
                continue
            print(f"    {y}: n={len(v):2d} mean_xR={v.mean():+.4f} wr={(v>0).mean()*100:4.0f}% tot={v.sum():+.2f}")

    print("\n=== combined book: LONG(up-gap held-low) + SHORT(dn-gap held-high), pooled per-year ===")
    leg1 = np.where(up.values & ud, xl, np.nan)
    leg2 = np.where(dn.values & dd, -xl, np.nan)
    combo = np.where(np.isfinite(leg1), leg1, leg2)
    s = stats(combo)
    print(f"  overall n={s['n']} mean_xR={s['mean']:+.4f} wr={s['wr']*100:.1f}% pf={s['pf']:.2f} sh={s['sh']:+.2f}")
    for y in sorted(df["year"].unique()):
        m = (df["year"].values == y)
        v = combo[m]; v = v[np.isfinite(v)]
        if len(v) == 0:
            continue
        print(f"    {y}: n={len(v):2d} mean_xR={v.mean():+.4f} wr={(v>0).mean()*100:4.0f}% tot={v.sum():+.2f}")


if __name__ == "__main__":
    main()
