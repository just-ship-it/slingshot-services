#!/usr/bin/env python3
"""
A2d — the same local-analogue test, KNOWABILITY-CORRECTED.

A2c reported +7.8 ticks/trade excess, 6/6 positive years, z~4-6. It was
contaminated. `pred` averaged the outcomes of the previous m look-alikes, but
those outcomes resolve AFTER their own bar closes: on the 15m bracket the median
resolution is 5.1 min and p90 is 16.1 min. 27.3% of decisions used at least one
look-alike that had NOT yet resolved — median 4.9 min of look-ahead.

That leaks what price is doing at the decision instant, which is exactly what
predicts the current bar's break. And a permutation null CANNOT catch it: the
permutation preserves the timing structure, so the null stayed clean while the
real number inflated. (Same failure mode as the dealer-reaction FSM: audit
exit-walk t0 against the entry instant BEFORE trusting a placebo.)

Fix: a look-alike is admissible only once `ltfTs + secsToBreak <= now`.

usage: 07-knowable.py [--m 5] [--maxage 120] [--seeds 3]
"""
import os, argparse, importlib.util, io, contextlib
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("m6", os.path.join(HERE, "06-mtf-local.py"))
m6 = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(m6)

LOOKBACK = 60   # prior rows scanned per bucket; p99 resolution is 26 min so this is ample

def build_knowable(d, m, maxage):
    """pred = mean r of the most recent m look-alikes that had RESOLVED by `now`."""
    d = d.sort_values("ltfTs").reset_index(drop=True)
    d["resolvedTs"] = d.ltfTs + d.secsToBreak
    pred = np.full(len(d), np.nan)
    age = np.full(len(d), np.nan)
    for _, g in d.groupby("sig", sort=False):
        idx = g.index.to_numpy()
        ts = g.ltfTs.to_numpy(); rs = g.resolvedTs.to_numpy(); rv = g.r.to_numpy()
        for j in range(len(idx)):
            now = ts[j]
            lo = max(0, j - LOOKBACK)
            cand = np.arange(lo, j)
            if cand.size == 0:
                continue
            ok = cand[rs[cand] <= now]        # strictly knowable at `now`
            if ok.size < m:
                continue
            sel = ok[-m:]                      # most recent m of them
            pred[idx[j]] = rv[sel].mean()
            age[idx[j]] = (now - ts[sel[0]]) / 60.0
    d["pred"] = pred; d["age"] = age
    return d[d.pred.notna() & (d.age <= maxage)]

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--m", type=int, default=5)
    ap.add_argument("--maxage", type=float, default=120)
    ap.add_argument("--seeds", type=int, default=3)
    a = ap.parse_args()

    real = m6.one_per_htf(build_knowable(m6.load(), a.m, a.maxage))
    nulls = [m6.one_per_htf(build_knowable(m6.load(True, 700 + i), a.m, a.maxage))
             for i in range(a.seeds)]
    R = m6.stats(real)
    npp = np.mean([m6.stats(n)["skill"] for n in nulls])
    nev = np.mean([m6.stats(n)["ev"] for n in nulls])
    print(f"A2d KNOWABLE — m={a.m}, age<={a.maxage:.0f}min, one trade per 15m candle")
    print(f"{len(real):,} tradeable rows (A2c contaminated version had 5,633)\n")
    print(f"{'metric':>22} {'real':>9} {'null':>9} {'excess':>9}")
    print(f"{'skill (pp)':>22} {R['skill']:>9.3f} {npp:>9.3f} {R['skill']-npp:>9.3f}")
    print(f"{'EV (ticks/trade)':>22} {R['ev']:>9.2f} {nev:>9.2f} {R['ev']-nev:>9.2f}")
    print(f"{'z on skill excess':>22} {(R['skill']-npp)/R['se']:>9.2f}")
    print(f"{'breakeven needs (pp)':>22} {R['need']:>9.2f}")

    real["yr"] = real.tradeDate.str[:4]
    for n in nulls: n["yr"] = n.tradeDate.str[:4]
    print(f"\n{'year':>6} {'n':>6} {'skillPP':>8} {'nullPP':>7} {'EXC':>7} {'z':>6} {'evEXC':>7}")
    pos = tot = 0
    for y in sorted(real.yr.unique()):
        r = real[real.yr == y]
        S = m6.stats(r)
        if not S: continue
        ns = [m6.stats(n[n.yr == y]) for n in nulls]
        ns = [x for x in ns if x]
        if not ns: continue
        p = np.mean([x["skill"] for x in ns]); e = np.mean([x["ev"] for x in ns])
        exc = S["skill"] - p
        print(f"{y:>6} {S['n']:>6,} {S['skill']:>8.2f} {p:>7.2f} {exc:>7.2f} "
              f"{exc/S['se']:>6.2f} {S['ev']-e:>7.2f}")
        tot += 1; pos += (S["ev"] - e) > 0
    print(f"\nyears with positive EV excess: {pos}/{tot}")
