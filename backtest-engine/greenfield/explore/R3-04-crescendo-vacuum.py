#!/usr/bin/env python3
"""
R3-04: CRESCENDO / DECRESCENDO + VACUUM MOVES + DRY-UPS (families 3+4).

Mechanism: a directional run fed by RISING volume = participation building
(continuation?); a run on FADING volume = exhaustion (snap-back?). A fast
move on LOW volume (vacuum) is liquidity-withdrawal, not initiative — classic
microstructure says it retraces; a move on HEAVY volume is real initiative.

Event: minute m with |net3| >= 2 x netb3 (trailing-3m move vs causal baseline),
dir = sign(net3), knowable at minute close. 5-minute per-day cooldown.
Splits (thresholds from printed marginals, fixed before outcomes):
  vslope = vm1(m) - vm1(m-2)   (per-minute volume multiple change)
  vm3    = trailing-3m volume multiple
Dry-up: vm3 <= 0.4 for >=3 consecutive minutes, 10:00-15:30 -> forward
absolute move vs time-matched control (vol forecast, no direction).
"""
import numpy as np
import pandas as pd
from R3_common import (BASE, N_MIN, load_dense, load_baselines, fwd_ret,
                       fmt_yearly, day_clustered, minute_label)

z = load_dense()
v, c = z["v"], z["c"]
days = np.array(z["days"])
D = len(days)
b = load_baselines()
use = b["elig"] & b["base_ok"]
year = b["year"].astype(int)
used_days = np.where(use)[0]

Vmin, volb = b["Vmin"], b["volb"]
net3, netb3 = b["net3"], b["netb3"]
vm1 = Vmin / volb
V3 = np.full((D, N_MIN), np.nan, np.float32)
B3 = np.full((D, N_MIN), np.nan, np.float32)
V3[:, 2:] = Vmin[:, 2:] + Vmin[:, 1:-1] + Vmin[:, :-2]
B3[:, 2:] = volb[:, 2:] + volb[:, 1:-1] + volb[:, :-2]
vm3 = V3 / B3
vslope = np.full((D, N_MIN), np.nan, np.float32)
vslope[:, 2:] = vm1[:, 2:] - vm1[:, :-2]

# ---- directional runs, 5m cooldown ----
runmask = np.abs(net3) >= 2 * netb3
runmask[:, :5] = False
runmask[:, 392:] = False
rows = []
for d in used_days:
    ms = np.where(runmask[d])[0]
    last = -10
    for m in ms:
        if m - last >= 5:
            rows.append((d, m))
            last = m
d_arr = np.array([r[0] for r in rows], int)
m_arr = np.array([r[1] for r in rows], int)
dr = np.sign(net3[d_arr, m_arr])
vs = vslope[d_arr, m_arr]
v3 = vm3[d_arr, m_arr]
s_arr = (m_arr + 1) * 60 - 1                     # minute-m close second
fw = {f"+{h//60}m": dr * fwd_ret(c, d_arr, s_arr, h) for h in [300, 900, 3600]}
print(f"directional runs (|net3|>=2x base, 5m cooldown): n={len(d_arr)} "
      f"({len(d_arr)/use.sum():.1f}/day)")
print("vslope marginals among runs: " +
      " ".join(f"p{q}={np.nanpercentile(vs, q):+.2f}" for q in [10, 25, 50, 75, 90]))
print("vm3 marginals among runs:    " +
      " ".join(f"p{q}={np.nanpercentile(v3, q):.2f}" for q in [10, 25, 50, 75, 90]))

fmt_yearly(fw, d_arr, year, "ALL directional runs (aligned fwd = continuation+)")

print("\n-- CRESCENDO vs DECRESCENDO (vslope split) --")
for lab, msk in [("crescendo(vs>=+0.5)", vs >= 0.5),
                 ("flat(-0.5..+0.5)", (vs > -0.5) & (vs < 0.5)),
                 ("decrescendo(vs<=-0.5)", vs <= -0.5)]:
    r = {k: day_clustered(val[msk], d_arr[msk]) for k, val in fw.items()}
    print(f"  {lab:>22}: n={r['+5m']['n']:5d}  " +
          "  ".join(f"{k} {st['mean_dayw']:+6.2f}(t{st['t']:+5.1f})"
                    for k, st in r.items()))
print("  vslope quintile monotonicity (det+15m aligned):")
qs = np.nanpercentile(vs, [20, 40, 60, 80])
bins = np.digitize(vs, qs)
for q in range(5):
    msk = bins == q
    st = day_clustered(fw["+15m"][msk], d_arr[msk])
    print(f"    Q{q+1} (vslope~{np.nanmean(vs[msk]):+5.2f}): n={st['n']:5d} "
          f"+15m {st['mean_dayw']:+6.2f} (t{st['t']:+5.1f})")

print("\n-- VACUUM vs HEAVY (vm3 split of the same runs) --")
for lab, msk in [("vacuum(vm3<=0.7)", v3 <= 0.7),
                 ("mid(0.7-1.5)", (v3 > 0.7) & (v3 < 1.5)),
                 ("heavy(vm3>=1.5)", v3 >= 1.5)]:
    r = {k: day_clustered(val[msk], d_arr[msk]) for k, val in fw.items()}
    print(f"  {lab:>18}: n={r['+5m']['n']:5d}  " +
          "  ".join(f"{k} {st['mean_dayw']:+6.2f}(t{st['t']:+5.1f})"
                    for k, st in r.items()))

print("\n-- per-year: vacuum runs vs heavy runs, +15m aligned --")
for lab, msk in [("vacuum", v3 <= 0.7), ("heavy", v3 >= 1.5)]:
    sub = {"+15m": fw["+15m"][msk]}
    fmt_yearly(sub, d_arr[msk], year, f"{lab} runs")

# ---- dry-ups: sustained low volume, mid-session ----
print("\n" + "=" * 70)
M_A, M_B = 32, 362                                # 10:00 .. 15:30
dry = (vm3 <= 0.4)
dry[:, :M_A] = False
dry[:, M_B:] = False
rows = []
for d in used_days:
    x = np.where(np.isnan(vm3[d]), False, dry[d])
    dif = np.diff(x.astype(np.int8), prepend=0, append=0)
    st, en = np.where(dif == 1)[0], np.where(dif == -1)[0]
    for m0, m1x in zip(st, en):
        if m1x - m0 >= 3:
            rows.append((d, m0 + 2))              # detection: end of 3rd minute
dd = np.array([r[0] for r in rows], int)
dm = np.array([r[1] for r in rows], int)
ds = (dm + 1) * 60 - 1
print(f"DRY-UPS (vm3<=0.4 for >=3m, 10:00-15:30): n={len(dd)} "
      f"({len(dd)/use.sum():.2f}/day)")
absf = {f"|+{h//60}m|": np.abs(fwd_ret(c, dd, ds, h)) for h in [900, 3600]}
# time-matched control: same minute-of-day on other used days with normal vm3
rng = np.random.default_rng(11)
pool_ok = (vm3 >= 0.8) & (vm3 <= 1.3)
cd, cm = [], []
for m0 in dm:
    cand = used_days[pool_ok[used_days, m0]]
    if len(cand):
        cd += rng.choice(cand, size=min(2, len(cand)), replace=False).tolist()
        cm += [m0] * min(2, len(cand))
cd = np.array(cd, int)
cs = (np.array(cm, int) + 1) * 60 - 1
absc = {f"|+{h//60}m|": np.abs(fwd_ret(c, cd, cs, h)) for h in [900, 3600]}
for k in absf:
    a = day_clustered(absf[k], dd)
    ct = day_clustered(absc[k], cd)
    print(f"  {k}: dry-up {a['mean_dayw']:6.2f} pts (n={a['n']})   "
          f"matched-normal {ct['mean_dayw']:6.2f} pts (n={ct['n']})   "
          f"ratio={a['mean_dayw']/ct['mean_dayw']:.2f}")
# and does the dry-up resolve directionally? sign = trailing 15m move
r15 = c[dd, ds] - c[dd, np.maximum(ds - 900, 0)]
drd = np.sign(r15)
ok = drd != 0
al = {f"+{h//60}m": drd[ok] * fwd_ret(c, dd[ok], ds[ok], h) for h in [900, 3600]}
fmt_yearly(al, dd[ok], year, "dry-up aligned with trailing-15m direction")
