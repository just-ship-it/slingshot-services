#!/usr/bin/env python3
"""Analyze the FSM output: penetration -> 1m-LS-flip trigger (causal +60s) -> structural-stop fade.
Success = win% (target before stop) + expectancy in R and points. Compare GEX vs placebo vs stall-only (noLS).
Report pooled, per-quarter, and 2025-train / 2026-OOS."""
import glob
import os
import numpy as np
import pandas as pd

BASE = "/home/drew/projects/slingshot-services/backtest-engine/research/dealer-reaction"


def pf(x):
    x = x[np.isfinite(x)]
    w, l = x[x > 0].sum(), -x[x < 0].sum()
    return w / l if l > 0 else np.inf


def stats(d):
    if len(d) == 0:
        return "n=0"
    r = d["R"].values; p = d["pnl"].values
    return (f"n={len(d):4d} win%={100*(d.outcome=='target').mean():4.1f} avgR={r.mean():+.3f} "
            f"PF={pf(p):.2f} exp_pts={p.mean():+5.1f} sumPts={p.sum():+7.0f}")


def main():
    D = {}
    for fp in glob.glob(f"{BASE}/fsm_*.csv"):
        m = os.path.basename(fp)[len("fsm_"):-4]
        D[m] = pd.read_csv(fp)
    print("=== POOLED (2025-01 .. 2026-06) ===")
    for m in ["full", "placebo_round", "placebo_rand", "noLS"]:
        if m in D:
            print(f"  {m:14s} {stats(D[m])}")

    if "full" in D:
        f = D["full"]
        print("\n=== GEX 'full' — subsets ===")
        print(f"  still-beyond-level (dist>0) {stats(f[f.dist_lvl>0])}")
        print(f"  already-back (dist<=0)      {stats(f[f.dist_lvl<=0])}")
        print(f"  risk<=25pt                  {stats(f[f.risk<=25])}")
        print("\n  by kind:")
        for k in sorted(f["kind"].unique()):
            print(f"    {k:12s} {stats(f[f.kind==k])}")
        print("\n  per-quarter (full):")
        for q in sorted(f["quarter"].unique()):
            print(f"    {q}: {stats(f[f.quarter==q])}")
        print("\n=== 2025 TRAIN vs 2026 OOS (full vs placebo) ===")
        for m in ["full", "placebo_round", "placebo_rand"]:
            if m not in D:
                continue
            d = D[m]
            tr = d[d.date < "2026-01-01"]; te = d[d.date >= "2026-01-01"]
            print(f"  {m:14s} 2025: {stats(tr)}")
            print(f"  {' ':14s} 2026: {stats(te)}")


if __name__ == "__main__":
    main()
