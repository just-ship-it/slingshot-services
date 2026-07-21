#!/usr/bin/env python3
"""C2-60: ES generalization of the headline C2 tests.

Runs, on the ES registry (built by C2-10-fit.py ES):
  (1) slope-persistence side-matched spread per year (5m K=12, 15m K=8),
  (2) rail-boundary reversion real vs sloped vs flat-band placebo.
If NQ's nulls reproduce on ES, the conclusion is instrument-robust.

Usage: python3 C2-60-es.py
"""
import time
import numpy as np
import pandas as pd
import C2_common as C2

pd.set_option("display.width", 220)
HZ = C2.CP["horizons"]
REG = f"{C2.HERE}/C2-registry-ES.csv"


def attach_fwd(reg, dm):
    cbt = {}
    for td in set(reg.td):
        d = dm[td]; a = np.full(C2.TD_END + 120, np.nan); a[d["tmin"]] = d["c"]; cbt[td] = a
    for H in HZ:
        reg[f"fwd{H}"] = np.nan
    for td, idx in reg.groupby("td").groups.items():
        if td not in cbt:
            continue
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
    reg = pd.read_csv(REG)
    dm, meta, use = C2.load_es()
    reg = reg[reg.td.isin(set(use))].copy()
    reg = attach_fwd(reg, dm)
    print(f"ES registry {len(reg)} rows ({time.time()-t0:.0f}s)")

    for tf, K in [(5, 12), (15, 8)]:
        print("\n" + "=" * 80)
        print(f"### ES PERSISTENCE tf={tf}m K={K} (spread=E[fwd|up]-E[fwd|dn], ATR):")
        sub = reg[(reg.tf == tf) & (reg.K == K)]
        for H in HZ:
            rows = []
            for yr, g in sub.groupby("year"):
                r = spread(g, H)
                if r:
                    rows.append((yr, r["spread"]))
            if not rows:
                continue
            signs = np.sign([s for _, s in rows])
            stable = np.all(signs > 0) or np.all(signs < 0)
            p = spread(sub, H)
            print(f"  H={H:2d}m pooled={p['spread']:+.4f} sign-stable={stable} | "
                  + "  ".join(f"{y}:{s:+.4f}" for y, s in rows))

    # boundary
    cm = C2.close_map(dm, set(reg.td))
    for tf, K in [(5, 12), (15, 8)]:
        pool = reg[(reg.tf == tf) & (reg.K == K)].slope_pm.abs().values
        pool = pool[pool > 1e-6]
        print("\n" + "=" * 80)
        print(f"### ES BOUNDARY tf={tf}m K={K} rail reversion H=15m, real vs placebo:")
        sub = reg[(reg.tf == tf) & (reg.K == K)].sort_values(["td", "freeze_end"])
        for mode in ("real", "sloped", "flatband"):
            vals = []
            last_by_td = {}
            for r in sub.itertuples():
                # tile non-overlapping
                if r.freeze_end - last_by_td.get(r.td, -10**9) < K * tf:
                    continue
                last_by_td[r.td] = r.freeze_end
                if mode == "real":
                    sl = r.slope_pm
                elif mode == "sloped":
                    sl = C2.placebo_slope(f"{r.td}:{r.freeze_end}", 5, pool)
                else:
                    sl = 0.0
                tou, _ = C2.eval_channel(cm, r.td, int(r.freeze_end), r.price_end, sl,
                                         r.w2s, r.atr14, tf, K)
                for t in tou:
                    vals.append(t["rev15"])
            v = np.array([x for x in vals if np.isfinite(x)])
            print(f"  {mode:9s}: mean_rev={v.mean():+.4f}  n={len(v)}  pBreakout={(v<0).mean():.2f}")
    print(f"\ndone ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
