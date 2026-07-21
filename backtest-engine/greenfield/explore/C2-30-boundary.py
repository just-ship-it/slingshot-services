#!/usr/bin/env python3
"""C2-30: RAIL BOUNDARY INTERACTION + CHANNEL BREAK census.

For non-overlapping (tiled) frozen channels, project the two rails forward on
1m bars over the channel's own lifetime (K*tf minutes) and ask, when price
first APPROACHES a rail (within tol, having been >=arm inside):
  (a) mean-reversion within channel  -> price moves back toward mid, or
  (b) breakout / continuation        -> price pushes through the rail.
Measured at +5/15/30/60m as displacement relative to the rail (ATR units;
sign = reversion is + into channel).

Then CHANNEL BREAK: once a 1m close is beyond a rail by >brk, does it CONTINUE
in the break direction or SNAP BACK (failed break) over the next horizons?

Two placebo classes through IDENTICAL machinery:
  sloped   : same freeze anchor + width, RANDOM slope (sign+mag from empirical
             pool). Tests whether the FITTED slope matters vs any sloped line.
  flatband : slope=0, band = price_end +/- W. Tests whether the SLOPE adds
             anything over a horizontal band of the same width.

Non-overlapping channels only (windows tile every K bars) -> independent samples.

Usage: python3 C2-30-boundary.py [registry.csv]
"""
import sys, time
import numpy as np
import pandas as pd
import C2_common as C2
from C2_common import close_map, eval_channel

pd.set_option("display.width", 220)
REG = sys.argv[1] if len(sys.argv) > 1 else f"{C2.HERE}/C2-registry-NQ.csv"
HZ = C2.CP["horizons"]
ARM, TOL, BRK = C2.CP["arm"], 5.0, C2.CP["brk"]


def run(reg, cm, tf, K, mode, slope_pool, seed=1):
    """mode in {real, sloped, flatband}. Returns (touch_df, break_df)."""
    sub = reg[(reg.tf == tf) & (reg.K == K)].copy()
    # tile: keep non-overlapping windows (freeze_end spaced by >= K*tf within day)
    rng = np.random.default_rng(seed)
    trows, brows = [], []
    for td, g in sub.groupby("td"):
        g = g.sort_values("freeze_end")
        last = -10**9
        for r in g.itertuples():
            if r.freeze_end - last < K * tf:
                continue
            last = r.freeze_end
            W = r.w2s
            if mode == "real":
                sl = r.slope_pm
            elif mode == "sloped":
                sl = C2.placebo_slope(f"{td}:{r.freeze_end}", seed, slope_pool)
            else:  # flatband
                sl = 0.0
            tou, brk = eval_channel(cm, td, int(r.freeze_end), r.price_end, sl, W,
                                    r.atr14, tf, K)
            for t in tou:
                trows.append(dict(year=r.year, **t))
            if brk:
                brows.append(dict(year=r.year, **brk))
    return pd.DataFrame(trows), pd.DataFrame(brows)


def summ_touch(df, H):
    if len(df) == 0:
        return None
    v = df[f"rev{H}"].dropna()
    return dict(n=len(v), mean_rev=v.mean(), p_breakout=(v < 0).mean())


def main():
    t0 = time.time()
    reg = pd.read_csv(REG)
    days, dm, use = C2.load_nq()
    cm = close_map(dm, set(reg["td"]))
    print(f"loaded ({time.time()-t0:.0f}s)")

    for tf, K in [(5, 12), (15, 8)]:
        pool = reg[(reg.tf == tf) & (reg.K == K)]["slope_pm"].abs().values
        pool = pool[pool > 1e-6]
        print("\n" + "=" * 90)
        print(f"### BOUNDARY  tf={tf}m K={K}  rail approach -> reversion(+)/breakout")
        res = {}
        for mode in ("real", "sloped", "flatband"):
            tdf, bdf = run(reg, cm, tf, K, mode, pool, seed=7)
            res[mode] = (tdf, bdf)
        # pooled reversion table
        print(f"\n  rail-touch reversion (ATR units, +=reverted into channel):")
        hdr = f"  {'mode':10s}" + "".join([f"  H{H}:mean/n/pBrk" for H in (15, 30, 60)])
        print(hdr)
        for mode in ("real", "sloped", "flatband"):
            tdf, _ = res[mode]
            line = f"  {mode:10s}"
            for H in (15, 30, 60):
                s = summ_touch(tdf, H)
                if s:
                    line += f"   {s['mean_rev']:+.4f}/{s['n']}/{s['p_breakout']:.2f}"
                else:
                    line += "   --"
            print(line)

        # per-year reversion at H=15 real vs placebos
        print(f"\n  per-year mean reversion H=15m (real / sloped / flatband):")
        for yr in sorted(reg.year.unique()):
            vals = []
            for mode in ("real", "sloped", "flatband"):
                tdf, _ = res[mode]
                s = tdf[tdf.year == yr]["rev15"].dropna() if len(tdf) else pd.Series([], dtype=float)
                vals.append(f"{s.mean():+.4f}(n{len(s)})" if len(s) > 20 else "--")
            print(f"    {yr}:  real {vals[0]:18s} sloped {vals[1]:18s} flat {vals[2]}")

        # break continuation
        print(f"\n  CHANNEL BREAK continuation (ATR units, +=continued in break dir):")
        for mode in ("real", "sloped", "flatband"):
            _, bdf = res[mode]
            line = f"  {mode:10s}"
            for H in (15, 30, 60):
                if len(bdf):
                    v = bdf[f"cont{H}"].dropna()
                    line += f"   H{H}:{v.mean():+.4f}/n{len(v)}/pCont{(v>0).mean():.2f}"
                else:
                    line += "   --"
            print(line)
    print(f"\ndone ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
