#!/usr/bin/env python3
"""
A2b — concentrate the local-analogue edge.

A2 found real but thin structure: +0.47pp excess over a matched null at z=8.5,
using look-alikes from the last ~50-80 minutes. Far too small for the ~7pp cost
bar. This asks whether it CONCENTRATES anywhere useful:

  1. TIME OF DAY — skip the 09:30 open and the 16:00 close, look at the algo-heavy
     mid-morning once the news is out.
  2. ROUND NUMBERS — proximity to 00 / 50 levels, where resting liquidity sits.

Both are pre-registered from Drew's hypotheses, not scanned. Cells are still
multiple comparisons, so every cell carries its own matched null and a z, and the
count of cells tested is reported so the reader can discount accordingly.

usage: 05-focus.py [--tf 3m] [--m 5] [--maxage 120] [--seeds 3]
"""
import os, argparse, importlib.util, io, contextlib
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("a2", os.path.join(HERE, "04-local-analogue.py"))
a2 = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(a2)

def enrich(d):
    et = pd.to_datetime(d.ts, unit="s", utc=True).dt.tz_convert("America/New_York")
    d["hhmm"] = et.dt.hour * 100 + et.dt.minute
    d["ethour"] = et.dt.hour
    # distance from the close to the nearest round level, in POINTS (NQ tick = 0.25)
    for step in (25, 50, 100):
        d[f"d{step}"] = (d.c - (d.c / step).round() * step).abs()
    return d

def cell_stats(d, seeds_cache, label, m, maxage, seeds):
    if len(d) < 400:
        return None
    R = a2.evaluate(d)
    nulls = [a2.evaluate(nd.loc[nd.index.intersection(d.index)])
             for nd in seeds_cache if len(nd.index.intersection(d.index)) >= 200]
    if not nulls:
        return None
    npp = np.mean([x["skill_pp"] for x in nulls])
    exc = R["skill_pp"] - npp
    z = exc / R["skill_se"] if R["skill_se"] else np.nan
    return dict(cell=label, n=R["n"], skill=R["skill_pp"], null=npp,
                excess=exc, z=z, ev=R["ev"])

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--tf", default="3m")
    ap.add_argument("--m", type=int, default=5)
    ap.add_argument("--maxage", type=float, default=120)
    ap.add_argument("--seeds", type=int, default=3)
    a = ap.parse_args()

    real = enrich(a2.build(a2.load(a.tf, False), a.m, a.maxage))
    seeds_cache = [enrich(a2.build(a2.load(a.tf, True, seed=500 + i), a.m, a.maxage))
                   for i in range(a.seeds)]
    print(f"A2b focus — NQ {a.tf}, m={a.m} look-alikes, age<={a.maxage:.0f}min, "
          f"{a.seeds} null seeds")
    print(f"baseline: {len(real):,} candles\n")

    rows = []
    rows.append(cell_stats(real, seeds_cache, "ALL", a.m, a.maxage, a.seeds))
    # 1. time of day
    for lo, hi, name in [(930, 1000, "0930-1000 open"), (1000, 1200, "1000-1200 algo/mid-morn"),
                         (1200, 1400, "1200-1400 midday"), (1400, 1545, "1400-1545"),
                         (1545, 1600, "1545-1600 close"), (0, 930, "overnight")]:
        sub = real[(real.hhmm >= lo) & (real.hhmm < hi)]
        rows.append(cell_stats(sub, seeds_cache, name, a.m, a.maxage, a.seeds))
    # 2. round-number proximity (points from nearest level)
    for step in (25, 50, 100):
        for thr in (2, 5):
            sub = real[real[f"d{step}"] <= thr]
            rows.append(cell_stats(sub, seeds_cache, f"within {thr}pt of {step}-level",
                                   a.m, a.maxage, a.seeds))
    # 3. the combination Drew asked for
    mid = real[(real.hhmm >= 1000) & (real.hhmm < 1200)]
    for step in (50, 100):
        for thr in (2, 5):
            sub = mid[mid[f"d{step}"] <= thr]
            rows.append(cell_stats(sub, seeds_cache, f"1000-1200 AND <={thr}pt of {step}",
                                   a.m, a.maxage, a.seeds))
    rows = [r for r in rows if r]
    df = pd.DataFrame(rows)
    print(f"{'cell':>32} {'n':>8} {'skillPP':>8} {'null':>7} {'EXCESS':>7} {'z':>6} {'ev':>7}")
    for _, r in df.iterrows():
        print(f"{r.cell:>32} {int(r.n):>8,} {r.skill:>8.3f} {r.null:>7.3f} "
              f"{r.excess:>7.3f} {r.z:>6.2f} {r.ev:>7.2f}")
    print(f"\n{len(df)} cells tested — treat any single z near 2 as noise at this width.")
    print("ev is net ticks/trade after costs; ~0.00 is breakeven.")
    df.to_csv(os.path.join(HERE, f"a2b_focus_{a.tf}.csv"), index=False)
