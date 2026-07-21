#!/usr/bin/env python3
"""
R3-05: SPEED x VOLUME GRID (family 5).

Location-free 2-D map: non-overlapping 5-minute windows classified by
  velocity multiple  velm = |net5| / netb5   (move vs causal ToD baseline)
  volume multiple    vm5  = V5 / volb5
Cell statistics: n, aligned forward drift (+5/+15/+60m, dir = sign(net5)),
forward 15m absolute move (vol expansion). Per-year sign stability for the
interesting cells. Windows end at minutes 09:35,09:40,...,15:55.
"""
import numpy as np
import pandas as pd
from R3_common import (N_MIN, load_dense, load_baselines, fwd_ret,
                       day_clustered, fmt_yearly)

z = load_dense()
c = z["c"]
days = np.array(z["days"])
D = len(days)
b = load_baselines()
use = b["elig"] & b["base_ok"]
year = b["year"].astype(int)
used_days = np.where(use)[0]

Vmin, volb = b["Vmin"], b["volb"]
net5, netb5 = b["net5"], b["netb5"]
V5 = np.full((D, N_MIN), np.nan, np.float32)
B5 = np.full((D, N_MIN), np.nan, np.float32)
for k in range(5):
    V5[:, 5:] = np.nan_to_num(V5[:, 5:], nan=0) + Vmin[:, 5 - k:N_MIN - k] * 0
V5[:, 5:] = sum(Vmin[:, 5 - k:N_MIN - k] for k in range(5))
B5[:, 5:] = sum(volb[:, 5 - k:N_MIN - k] for k in range(5))
vm5 = V5 / B5

ends = np.arange(7, 388, 5)                    # minute indices 09:35..15:55
dg, mg = np.meshgrid(used_days, ends, indexing="ij")
dg, mg = dg.ravel(), mg.ravel()
velm = (np.abs(net5) / np.maximum(netb5, .25))[dg, mg]
vmm = vm5[dg, mg]
dr = np.sign(net5[dg, mg])
ok = ~np.isnan(velm) & ~np.isnan(vmm) & (dr != 0)
dg, mg, velm, vmm, dr = dg[ok], mg[ok], velm[ok], vmm[ok], dr[ok]
sg = (mg + 1) * 60 - 1
fw5 = dr * fwd_ret(c, dg, sg, 300)
fw15 = dr * fwd_ret(c, dg, sg, 900)
fw60 = dr * fwd_ret(c, dg, sg, 3600)
ab15 = np.abs(fwd_ret(c, dg, sg, 900))

VEL_E = [0, 0.5, 1, 2, 4, 99]
VOL_E = [0, 0.6, 0.9, 1.3, 2, 99]
VEL_L = ["<0.5", "0.5-1", "1-2", "2-4", ">=4"]
VOL_L = ["<0.6", "0.6-0.9", "0.9-1.3", "1.3-2", ">=2"]
vi = np.digitize(velm, VEL_E) - 1
oi = np.digitize(vmm, VOL_E) - 1

print(f"windows n={len(dg)}  ({len(dg)/use.sum():.0f}/day)")
for name, val in [("aligned +5m", fw5), ("aligned +15m", fw15),
                  ("aligned +60m", fw60), ("|+15m| (fwd vol)", ab15)]:
    print(f"\n== {name}: rows=velocity, cols=volume multiple (dayw mean / day-t) ==")
    print(f"{'':>8}" + "".join(f"{s:>16}" for s in VOL_L))
    for i, vl in enumerate(VEL_L):
        cells = []
        for j in range(5):
            msk = (vi == i) & (oi == j)
            st = day_clustered(val[msk], dg[msk])
            cells.append(f"{st['mean_dayw']:+7.2f}/{st['t']:+5.1f}"
                         if st["n"] > 50 else f"{'(n<50)':>13}")
        print(f"{vl:>8}" + "".join(f"{s:>16}" for s in cells))
    print(f"{'n':>8}" + "".join(f"{((vi==i)&(oi==j)).sum():>16d}"
                                for j in range(5) for i in [4])
          + "   (n row shown for vel>=4 only)")

print("\ncell counts:")
print(f"{'':>8}" + "".join(f"{s:>10}" for s in VOL_L))
for i, vl in enumerate(VEL_L):
    print(f"{vl:>8}" + "".join(f"{((vi==i)&(oi==j)).sum():>10d}" for j in range(5)))

print("\n-- per-year stability of the corner cells (+15m aligned) --")
for i, j, lab in [(3, 4, "vel 2-4 & vol>=2"), (4, 4, "vel>=4 & vol>=2"),
                  (3, 0, "vel 2-4 & vol<0.6"), (4, 0, "vel>=4 & vol<0.6"),
                  (0, 4, "vel<0.5 & vol>=2")]:
    msk = (vi == i) & (oi == j)
    fmt_yearly({"+15m": fw15[msk], "+60m": fw60[msk]}, dg[msk], year, lab)
