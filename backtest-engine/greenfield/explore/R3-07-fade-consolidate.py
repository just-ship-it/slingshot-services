#!/usr/bin/env python3
"""
R3-07: consolidate the one recurring directional signature the census found —
ELEVATED-VOLUME DIRECTIONAL THRUST FADES — across its independent detectors,
with a matched control and ATR normalization, so the doc has one clean table.

Headline event: minute m, directional thrust = |net3| >= 2x causal baseline,
dir = sign(net3), knowable at minute close, 5m cooldown. Condition on the
trailing-3m volume multiple vm3. Report aligned forward drift +5/+15m in points
AND in units of that day's prior ATR14 (from B12-days). Matched control: same
thrust magnitude bucket, RANDOM sign — should show ~0 (isolates that the fade
is about the thrust direction, not a time-of-day drift).
"""
import numpy as np
import pandas as pd
from R3_common import (BASE, N_MIN, load_dense, load_baselines, load_days_meta,
                       fwd_ret, day_clustered)

z = load_dense()
c = z["c"]
days = np.array(z["days"])
D = len(days)
b = load_baselines()
use = b["elig"] & b["base_ok"]
year = b["year"].astype(int)
meta = load_days_meta(days)
atr = meta["atr14_prior"].to_numpy()
used_days = np.where(use)[0]

Vmin, volb = b["Vmin"], b["volb"]
net3, netb3 = b["net3"], b["netb3"]
V3 = np.full((D, N_MIN), np.nan, np.float32)
B3 = np.full((D, N_MIN), np.nan, np.float32)
V3[:, 2:] = Vmin[:, 2:] + Vmin[:, 1:-1] + Vmin[:, :-2]
B3[:, 2:] = volb[:, 2:] + volb[:, 1:-1] + volb[:, :-2]
vm3 = V3 / B3

runmask = np.abs(net3) >= 2 * netb3
runmask[:, :5] = False
runmask[:, 392:] = False
rows = []
for d in used_days:
    last = -10
    for m in np.where(runmask[d])[0]:
        if m - last >= 5:
            rows.append((d, m))
            last = m
d_arr = np.array([r[0] for r in rows], int)
m_arr = np.array([r[1] for r in rows], int)
dr = np.sign(net3[d_arr, m_arr])
v3 = vm3[d_arr, m_arr]
s_arr = (m_arr + 1) * 60 - 1
a = atr[d_arr]
f5 = dr * fwd_ret(c, d_arr, s_arr, 300)
f15 = dr * fwd_ret(c, d_arr, s_arr, 900)
f5a = f5 / a
f15a = f15 / a

print("HEADLINE: elevated-volume directional thrust fades (aligned fwd, "
      "negative = reversion)")
print(f"{'vm3 bucket':>14} {'n':>6} {'+5m pts':>10} {'+5m/ATR':>10} "
      f"{'+15m pts':>10} {'+15m/ATR':>10} {'day-t15':>8}")
edges = [(0, 0.7, "vacuum<=0.7"), (0.7, 1.0, "0.7-1.0"), (1.0, 1.5, "1.0-1.5"),
         (1.5, 2.5, "1.5-2.5"), (2.5, 99, "heavy>=2.5")]
for lo, hi, lab in edges:
    msk = (v3 >= lo) & (v3 < hi)
    s5, s15 = day_clustered(f5[msk], d_arr[msk]), day_clustered(f15[msk], d_arr[msk])
    s5a, s15a = day_clustered(f5a[msk], d_arr[msk]), day_clustered(f15a[msk], d_arr[msk])
    print(f"{lab:>14} {s5['n']:6d} {s5['mean_dayw']:+10.2f} {s5a['mean_dayw']:+10.3f} "
          f"{s15['mean_dayw']:+10.2f} {s15a['mean_dayw']:+10.3f} {s15['t']:+8.1f}")

print("\nMATCHED CONTROL (same thrust events, RANDOM sign): should be ~0")
rng = np.random.default_rng(3)
rs = rng.choice([-1, 1], size=len(d_arr))
cf5 = rs * fwd_ret(c, d_arr, s_arr, 300)
cf15 = rs * fwd_ret(c, d_arr, s_arr, 900)
for lo, hi, lab in edges:
    msk = (v3 >= lo) & (v3 < hi)
    s5, s15 = day_clustered(cf5[msk], d_arr[msk]), day_clustered(cf15[msk], d_arr[msk])
    print(f"{lab:>14} {s5['n']:6d} {s5['mean_dayw']:+10.2f} {'':>10} "
          f"{s15['mean_dayw']:+10.2f} {'':>10} {s15['t']:+8.1f}")

print("\nHEAVY thrust (vm3>=1.5) fade, PER YEAR (+15m aligned pts / ATR units):")
heavy = v3 >= 1.5
for y in range(2021, 2027):
    ym = heavy & (year[d_arr] == y)
    sp, sa = day_clustered(f15[ym], d_arr[ym]), day_clustered(f15a[ym], d_arr[ym])
    print(f"  {y}: n={sp['n']:5d}  {sp['mean_dayw']:+6.2f} pts  "
          f"{sa['mean_dayw']:+6.3f} ATR  (t{sp['t']:+.1f})")

# ATR-regime split (does the fade survive in both calm and volatile regimes?)
print("\nHEAVY thrust fade by day ATR-tercile regime (causal), +15m aligned pts:")
top = meta["atr_top"].to_numpy()[d_arr]
bot = meta["atr_bot"].to_numpy()[d_arr]
kn = meta["atr_known"].to_numpy()[d_arr]
for lab, rm in [("low-ATR days", heavy & bot & kn),
                ("high-ATR days", heavy & top & kn)]:
    s = day_clustered(f15[rm], d_arr[rm])
    sa = day_clustered(f15a[rm], d_arr[rm])
    print(f"  {lab:>14}: n={s['n']:5d}  {s['mean_dayw']:+6.2f} pts  "
          f"{sa['mean_dayw']:+6.3f} ATR  (t{s['t']:+.1f})")

pd.DataFrame({"date": days[d_arr], "d": d_arr, "m": m_arr, "dir": dr,
              "vm3": v3, "atr": a, "f5": f5, "f15": f15}).to_csv(
    f"{BASE}/R3-thrust-events.csv", index=False, float_format="%.4g")
print(f"\nwrote R3-thrust-events.csv n={len(d_arr)}")
