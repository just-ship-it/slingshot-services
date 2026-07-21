#!/usr/bin/env python3
"""C2-20: TREND / SLOPE PERSISTENCE census (the honest core question).

Question: does an established channel's trailing SLOPE predict the NEXT-bars'
return, beyond (a) NQ's unconditional up-drift and (b) known-weak autocorr?

For every frozen channel (registry row) with freeze_end te and slope s:
  p0 = last known 1m close at te (bar tmin te-1)
  fwd(H) = close(te-1+H) - p0     (H in minutes; RTH-only, te-1+H < RTH_C)
  fwd_atr = fwd / atr14
Predictor = trailing slope. Sign convention: slope>0 => up-channel.

DRIFT CONTROL (side-matched, mandatory): NQ drifts up, so E[fwd|up] alone is
confounded. We report the SPREAD = E[fwd_atr | slope>0] - E[fwd_atr | slope<0].
Drift lifts both terms equally, so the spread isolates the slope effect. An
honest "trend continues" claim needs spread>0 with per-year sign stability.

PLACEBO TWINS:
  shuffle  : permute slope values across freeze rows WITHIN (year,tf,K) ->
             destroys the time-alignment; spread must collapse to ~0.
  randsign : keep |slope| but randomize its sign -> spread must collapse.
If real spread is inside the placebo band, slope carries no forward info.

CONDITIONING (the tradable claim = tight, young, HTF-aligned continue): repeat
the spread within buckets of r2 (loose/tight), n_before (young/mature),
|slope_norm| (weak/strong), and multi-window sign ALIGNMENT.

Usage: python3 C2-20-persistence.py [registry.csv]
"""
import sys, time
import numpy as np
import pandas as pd
import C2_common as C2

pd.set_option("display.width", 220)
pd.set_option("display.max_columns", 40)
REG = sys.argv[1] if len(sys.argv) > 1 else f"{C2.HERE}/C2-registry-NQ.csv"
HZ = C2.CP["horizons"]


def load_close_by_tmin(dm, tds):
    """td -> np array length TD_END of 1m close indexed by tmin (NaN elsewhere)."""
    out = {}
    for td in tds:
        d = dm[td]
        arr = np.full(C2.TD_END + 120, np.nan)
        arr[d["tmin"]] = d["c"]
        out[td] = arr
    return out


def attach_forward(reg, cbt):
    """Add fwd{H}_atr columns using only bars strictly after freeze."""
    for H in HZ:
        reg[f"fwd{H}"] = np.nan
    grp = reg.groupby("td")
    for td, idx in grp.groups.items():
        if td not in cbt:
            continue
        arr = cbt[td]
        sub = reg.loc[idx]
        te = sub["freeze_end"].values.astype(int)   # channel evaluable at > te
        p0i = te - 1                                  # last known close index
        p0 = arr[p0i]
        for H in HZ:
            pj = te - 1 + H
            valid = pj < C2.RTH_C
            fv = np.full(len(sub), np.nan)
            pjv = np.where(valid, pj, 0)
            ph = arr[pjv]
            fwd = np.where(valid, ph - p0, np.nan)
            reg.loc[idx, f"fwd{H}"] = fwd / sub["atr14"].values
    return reg


def spread(df, H):
    """E[fwd|up] - E[fwd|down], plus components and drift baseline."""
    f = df[f"fwd{H}"].values
    s = df["slope_pm"].values
    up = f[(s > 0) & np.isfinite(f)]
    dn = f[(s < 0) & np.isfinite(f)]
    if len(up) < 20 or len(dn) < 20:
        return None
    return dict(n_up=len(up), n_dn=len(dn), e_up=up.mean(), e_dn=dn.mean(),
                spread=up.mean() - dn.mean(), drift=np.nanmean(f))


def placebo_spreads(df, H, nperm=20, seed=0):
    """shuffle + randsign null distribution of the spread."""
    f = df[f"fwd{H}"].values
    s = df["slope_pm"].values
    m = np.isfinite(f) & np.isfinite(s) & (s != 0)
    f, s = f[m], s[m]
    rng = np.random.default_rng(seed)
    sh, rs = [], []
    for _ in range(nperm):
        sp = rng.permutation(s)
        up = f[sp > 0]; dn = f[sp < 0]
        if len(up) > 10 and len(dn) > 10:
            sh.append(up.mean() - dn.mean())
        sg = np.abs(s) * rng.choice([-1.0, 1.0], size=len(s))
        up = f[sg > 0]; dn = f[sg < 0]
        if len(up) > 10 and len(dn) > 10:
            rs.append(up.mean() - dn.mean())
    return np.array(sh), np.array(rs)


def per_year_table(reg, tf, K, H):
    sub = reg[(reg["tf"] == tf) & (reg["K"] == K)].copy()
    rows = []
    for yr, g in sub.groupby("year"):
        r = spread(g, H)
        if r is None:
            continue
        sh, rs = placebo_spreads(g, H, nperm=30, seed=yr)
        band = (np.nanpercentile(np.r_[sh, rs], 2.5), np.nanpercentile(np.r_[sh, rs], 97.5))
        beats = r["spread"] > band[1] or r["spread"] < band[0]
        rows.append(dict(year=yr, n_up=r["n_up"], n_dn=r["n_dn"],
                         spread=r["spread"], drift=r["drift"],
                         plac_lo=band[0], plac_hi=band[1], beats_plac=beats))
    return pd.DataFrame(rows)


def cond_spread(reg, tf, K, H, colname, thresh_fn):
    """Spread within low/high buckets of a conditioning variable, per year."""
    sub = reg[(reg["tf"] == tf) & (reg["K"] == K)].copy()
    out = []
    for yr, g in sub.groupby("year"):
        lo, hi = thresh_fn(g)
        for tag, gg in (("lo", g[lo]), ("hi", g[hi])):
            r = spread(gg, H)
            if r:
                out.append(dict(year=yr, bucket=tag, n=r["n_up"] + r["n_dn"],
                                spread=r["spread"], drift=r["drift"]))
    return pd.DataFrame(out)


def align_col(reg):
    """Multi-window sign alignment at each freeze_end (per td,tf): do the K in
    KGRID all share the trailing slope sign?  Adds 'aligned' (bool) by joining
    the shortest-K row to whether all K agree at same freeze_end."""
    reg["aligned"] = np.nan
    for (td, tf), g in reg.groupby(["td", "tf"]):
        Ks = sorted(g["K"].unique())
        piv = g.pivot_table(index="freeze_end", columns="K", values="slope_pm")
        sign = np.sign(piv)
        agree = (sign.eq(sign.iloc[:, 0], axis=0)).all(axis=1) & sign.notna().all(axis=1)
        # map to ALL rows of this (td,tf) by their freeze_end
        mask = (reg["td"] == td) & (reg["tf"] == tf)
        reg.loc[mask, "aligned"] = reg.loc[mask, "freeze_end"].map(agree.to_dict()).values
    return reg


def main():
    t0 = time.time()
    reg = pd.read_csv(REG)
    days, dm, use = C2.load_nq()
    cbt = load_close_by_tmin(dm, set(reg["td"]))
    reg = attach_forward(reg, cbt)
    print(f"loaded registry {len(reg)} rows, forward attached ({time.time()-t0:.0f}s)\n")

    for tf, K in [(5, 12), (5, 24), (15, 8)]:
        print("=" * 90)
        print(f"### PERSISTENCE  tf={tf}m K={K}  (spread = E[fwd|up]-E[fwd|down], ATR units)")
        for H in HZ:
            tbl = per_year_table(reg, tf, K, H)
            if len(tbl) == 0:
                continue
            pooled = spread(reg[(reg.tf == tf) & (reg.K == K)], H)
            signs = np.sign(tbl["spread"].values)
            stable = (np.all(signs > 0) or np.all(signs < 0))
            print(f"\n H={H}m  pooled spread={pooled['spread']:+.4f}  drift={pooled['drift']:+.4f}  "
                  f"per-year sign-stable={stable}  beats-placebo yrs={int(tbl['beats_plac'].sum())}/{len(tbl)}")
            print(tbl.round(4).to_string(index=False))

    # ---- conditioning at the primary config ----
    tf, K, H = 5, 12, 30
    print("\n" + "=" * 90)
    print(f"### CONDITIONING  tf={tf}m K={K} H={H}m  (does tight/young/strong/aligned raise the spread?)")
    reg = align_col(reg)
    conds = {
        "r2(loose<.5 | tight>=.7)": lambda g: (g["r2"] < 0.5, g["r2"] >= 0.7),
        "age(young n_before<=K+3 | mature>2K)": lambda g: (g["n_before"] <= g["K"] + 3, g["n_before"] > 2 * g["K"]),
        "|slope_norm|(weak<.2 | strong>.5)": lambda g: (g["slope_norm"].abs() < 0.2, g["slope_norm"].abs() > 0.5),
    }
    for name, fn in conds.items():
        c = cond_spread(reg, tf, K, H, name, fn)
        if len(c) == 0:
            continue
        piv = c.pivot_table(index="year", columns="bucket", values="spread")
        piv["hi-lo"] = piv.get("hi") - piv.get("lo")
        print(f"\n {name}:  (spread by bucket, per year)")
        print(piv.round(4).to_string())

    # alignment
    a = reg[(reg.tf == tf) & (reg.K == K)]
    print(f"\n ALIGNMENT (all K agree sign)  tf={tf} K={K} H={H}:")
    ar = []
    for yr, g in a.groupby("year"):
        for tag, gg in (("aligned", g[g.aligned == True]), ("mixed", g[g.aligned == False])):
            r = spread(gg, H)
            if r:
                ar.append(dict(year=yr, bucket=tag, n=r["n_up"] + r["n_dn"], spread=r["spread"]))
    ap = pd.DataFrame(ar).pivot_table(index="year", columns="bucket", values="spread")
    if "aligned" in ap and "mixed" in ap:
        ap["algn-mixed"] = ap["aligned"] - ap["mixed"]
    print(ap.round(4).to_string())
    print(f"\ndone ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
