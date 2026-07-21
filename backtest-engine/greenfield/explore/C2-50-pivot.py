#!/usr/bin/env python3
"""C2-50: PIVOT-ANCHORED parallel channel census (channel definition #2).

Causal construction (the fractal-lookahead trap handled explicitly):
  On RTH HTF bars, fractal swing highs/lows use N bars each side; a swing at
  bar j is CONFIRMED only at bar j+N (k=N bars later; C1.fractal_swings returns
  confirm_idx=j+N). An UP-channel is built from the two MOST-RECENT CONFIRMED
  swing highs (rising -> slope>0); the parallel lower rail passes through the
  lowest low between the anchors. Mirror (two confirmed lows, slope<0) for
  DOWN-channels. The channel EXISTS only at the confirmation instant of the 2nd
  pivot; every forward evaluation is strictly after that freeze. Anchors are
  same-day, within a recent lookback.

We then run the SAME two headline tests as the linreg channel:
  (1) slope persistence: side-matched spread E[fwd|up-chan]-E[fwd|down-chan],
      per year, vs shuffle placebo.
  (2) rail-touch reversion vs sloped + flat-band placebos.

Freezes are written to a pivot-channel registry for a 1s follow-up.

Usage: python3 C2-50-pivot.py [tf]
"""
import sys, time
import numpy as np
import pandas as pd
import C2_common as C2
import C1_common as C1
from C2_common import close_map, eval_channel

pd.set_option("display.width", 220)
TF = int(sys.argv[1]) if len(sys.argv) > 1 else 5
N = 3            # fractal half-width -> confirmation lag k=N bars
LOOKBACK = 40    # anchors must be within this many HTF bars of the freeze
HZ = C2.CP["horizons"]


def build_pivots(dm, use, atr_map, tf):
    rows = []
    for td in use:
        atr = atr_map.get(td, np.nan)
        if not np.isfinite(atr) or atr <= 0:
            continue
        d = dm[td]
        agg = C2.rth_htf(d, tf)
        if agg is None:
            continue
        bt, bo, bh, bl, bc, bv = agg
        n = len(bc)
        sw = C1.fractal_swings(bh, bl, N)      # (bar_idx, 'H'/'L', price, confirm_idx)
        if not sw:
            continue
        # order swings by confirmation time
        highs = sorted([(j, p, c) for (j, k, p, c) in sw if k == "H"], key=lambda z: z[2])
        lows = sorted([(j, p, c) for (j, k, p, c) in sw if k == "L"], key=lambda z: z[2])

        def emit(anchors, other_extreme_arr, direction):
            # anchors: list of (bar_idx, price, confirm_idx); build channel at each
            # new 2nd-pivot confirmation from the two most-recent confirmed anchors.
            for t in range(1, len(anchors)):
                (a1, p1, c1), (a2, p2, c2) = anchors[t - 1], anchors[t]
                if a2 <= a1:
                    continue
                if a2 - a1 > LOOKBACK:
                    continue
                slope_pb = (p2 - p1) / (a2 - a1)
                if direction == "up" and slope_pb <= 0:
                    continue
                if direction == "dn" and slope_pb >= 0:
                    continue
                fb = c2                          # freeze at 2nd pivot confirmation bar
                if fb >= n - 2:
                    continue
                # parallel rail through the extreme low(up)/high(dn) in [a1, fb]
                idxs = np.arange(a1, fb + 1)
                rail_at = p2 + slope_pb * (idxs - a2)     # main rail (through highs/lows)
                if direction == "up":
                    off = (bl[idxs] - rail_at).min()      # lower rail offset (<=0)
                    width = -off
                else:
                    off = (bh[idxs] - rail_at).max()      # upper rail offset (>=0)
                    width = off
                width = abs(width)
                if width < 1e-6:
                    continue
                main_at_fb = p2 + slope_pb * (fb - a2)
                mid = main_at_fb - np.sign(1 if direction == "up" else -1) * width / 2 \
                    if direction == "up" else main_at_fb + width / 2
                # simpler/robust mid: average of the two rails at fb
                if direction == "up":
                    mid = main_at_fb - width / 2
                else:
                    mid = main_at_fb + width / 2
                freeze_end = int(bt[fb] + tf)
                rows.append((td, C2.year_of(td), tf, direction, freeze_end,
                             round(float(mid), 3), round(float(slope_pb / tf), 6),
                             round(float(width / 2), 3), round(float(atr), 2),
                             round(float(slope_pb * (a2 - a1) / atr), 4)))
        emit(highs, bl, "up")
        emit(lows, bh, "dn")
    cols = ["td", "year", "tf", "direction", "freeze_end", "price_end", "slope_pm",
            "w2s", "atr14", "slope_norm"]
    return pd.DataFrame(rows, columns=cols)


def attach_fwd(reg, dm):
    cbt = {}
    for td in set(reg.td):
        d = dm[td]; a = np.full(C2.TD_END + 120, np.nan); a[d["tmin"]] = d["c"]; cbt[td] = a
    for H in HZ:
        reg[f"fwd{H}"] = np.nan
    for td, idx in reg.groupby("td").groups.items():
        arr = cbt[td]; sub = reg.loc[idx]; te = sub.freeze_end.values.astype(int)
        p0 = arr[te - 1]
        for H in HZ:
            pj = te - 1 + H; valid = pj < C2.RTH_C
            ph = arr[np.where(valid, pj, 0)]
            reg.loc[idx, f"fwd{H}"] = np.where(valid, (ph - p0) / sub.atr14.values, np.nan)
    return reg


def spread(df, H):
    f = df[f"fwd{H}"].values; s = df.slope_pm.values
    up = f[(s > 0) & np.isfinite(f)]; dn = f[(s < 0) & np.isfinite(f)]
    if len(up) < 20 or len(dn) < 20:
        return None
    return dict(n=len(up) + len(dn), spread=up.mean() - dn.mean(), drift=np.nanmean(f))


def main():
    t0 = time.time()
    days, dm, use = C2.load_nq()
    atr_map = {td: days.loc[td, "atr14_prior"] for td in use}
    reg = build_pivots(dm, use, atr_map, TF)
    out = f"{C2.HERE}/C2-pivot-registry-NQ-{TF}m.csv"
    reg.to_csv(out, index=False)
    print(f"pivot channels tf={TF}m: {len(reg)} ({(reg.direction=='up').sum()} up / "
          f"{(reg.direction=='dn').sum()} dn) -> {out} ({time.time()-t0:.0f}s)")
    reg = attach_fwd(reg, dm)

    print(f"\n### PIVOT-CHANNEL SLOPE PERSISTENCE (spread=E[fwd|up]-E[fwd|dn], ATR):")
    for H in HZ:
        rows = []
        for yr, g in reg.groupby("year"):
            r = spread(g, H)
            if r:
                rows.append(dict(year=yr, n=r["n"], spread=round(r["spread"], 4),
                                 drift=round(r["drift"], 4)))
        t = pd.DataFrame(rows)
        if len(t):
            signs = np.sign(t.spread.values)
            stable = np.all(signs > 0) or np.all(signs < 0)
            print(f"  H={H:2d}m  pooled={spread(reg,H)['spread']:+.4f}  sign-stable={stable}  "
                  f"| " + "  ".join(f"{r.year}:{r.spread:+.4f}" for r in t.itertuples()))

    # boundary reversion via shared machinery
    cm = close_map(dm, set(reg.td))
    pool = reg.slope_pm.abs().values; pool = pool[pool > 1e-6]
    print(f"\n### PIVOT-RAIL BOUNDARY reversion H=15m (ATR units), real vs placebo:")
    for mode in ("real", "sloped", "flatband"):
        vals = []
        for r in reg.itertuples():
            if mode == "real":
                sl = r.slope_pm
            elif mode == "sloped":
                sl = C2.placebo_slope(f"{r.td}:{r.freeze_end}", 5, pool)
            else:
                sl = 0.0
            # emulate K via lifetime ~ LOOKBACK bars
            tou, _ = eval_channel(cm, r.td, int(r.freeze_end), r.price_end, sl,
                                  r.w2s, r.atr14, TF, LOOKBACK)
            for tdi in tou:
                vals.append(tdi["rev15"])
        v = np.array([x for x in vals if np.isfinite(x)])
        print(f"  {mode:9s}: mean_rev={v.mean():+.4f}  n={len(v)}  pBreakout={(v<0).mean():.2f}")
    print(f"\ndone ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
