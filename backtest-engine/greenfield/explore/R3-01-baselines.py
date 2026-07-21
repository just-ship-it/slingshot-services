#!/usr/bin/env python3
"""
R3-01: per-minute feature matrices + causal time-of-day baselines.

Everything is (D days x 393 minutes) float32. Baseline for day d, minute m =
median over the previous 20 ELIGIBLE days (strictly prior) of that minute's
value. Eligible = full RTH day present in the 1s cache with >=20000 traded
seconds. Analyses restrict to eligible days with baseline_ok (>=15 prior).

Saves R3-baselines.npz:
  Vmin, path_min, net_min, sflow_min, maxv_min, nz_min       raw per-minute
  F180, AC180                                                trailing-180s Fano / lag-1 autocorr at each minute END
  volb, pathb, fanob, netb3, netb5, maxvb                    causal baselines
  net3, net5                                                 |net| over trailing 3/5 minutes (raw)
  elig (D,) bool, base_ok (D,) bool, year (D,) int16,
  atr_top/atr_bot/atr_known (D,) bool
Also dumps a slim per-minute CSV (R3-minute-features.csv.gz) for external reuse
and prints a census -> out-R3-01.txt.
"""
import numpy as np
import pandas as pd
from R3_common import (BASE, N_SEC, N_MIN, load_dense, load_days_meta,
                       rolling_prior_median, minute_label)

z = load_dense()
v, c = z["v"], z["c"]
days = z["days"]
D = len(days)
meta = load_days_meta(days)
year = meta["year"].to_numpy(np.int16)

# --- per-second derived ---
dc = np.diff(c, axis=1, prepend=c[:, :1])          # dc[:,0]=0
sgn = np.sign(dc).astype(np.float32)
adc = np.abs(dc)

# --- per-minute raw features ---
def msum(x):
    return x.reshape(D, N_MIN, 60).sum(2)

Vmin = msum(v)
path_min = msum(adc)
sflow_min = msum(sgn * v)
maxv_min = v.reshape(D, N_MIN, 60).max(2)
nz_min = (v > 0).reshape(D, N_MIN, 60).sum(2).astype(np.float32)
cm_end = c[:, 59::60]                              # close at each minute end
net_min = np.diff(cm_end, axis=1, prepend=cm_end[:, :1])
net3 = np.full((D, N_MIN), np.nan, np.float32)
net5 = np.full((D, N_MIN), np.nan, np.float32)
net3[:, 3:] = cm_end[:, 3:] - cm_end[:, :-3]
net5[:, 5:] = cm_end[:, 5:] - cm_end[:, :-5]

# --- trailing-180s Fano factor & lag-1 autocorr at each minute end ---
S1 = np.concatenate([np.zeros((D, 1)), np.cumsum(v, 1)], 1)
S2 = np.concatenate([np.zeros((D, 1)), np.cumsum(v.astype(np.float64) ** 2, 1)], 1)
xy = v[:, :-1] * v[:, 1:]
SXY = np.concatenate([np.zeros((D, 1)), np.cumsum(xy, 1)], 1)
F180 = np.full((D, N_MIN), np.nan, np.float32)
AC180 = np.full((D, N_MIN), np.nan, np.float32)
W = 180
for m in range(2, N_MIN):
    e = (m + 1) * 60
    a = e - W
    mu = (S1[:, e] - S1[:, a]) / W
    ex2 = (S2[:, e] - S2[:, a]) / W
    var = ex2 - mu ** 2
    ok = mu > 0.5
    F180[ok, m] = (var[ok] / mu[ok]).astype(np.float32)
    exy = (SXY[:, e - 1] - SXY[:, a]) / (W - 1)
    ok2 = ok & (var > 1e-9)
    AC180[ok2, m] = ((exy[ok2] - mu[ok2] ** 2) / var[ok2]).astype(np.float32)

# --- eligibility & causal baselines ---
n_traded = (v > 0).sum(1)
elig = meta["full_rth"].fillna(False).to_numpy(bool) & (n_traded >= 20000)
elig_idx = np.where(elig)[0]
volb = rolling_prior_median(Vmin, elig_idx)
pathb = rolling_prior_median(path_min, elig_idx)
fanob = rolling_prior_median(F180, elig_idx)
maxvb = rolling_prior_median(maxv_min, elig_idx)
netb3 = rolling_prior_median(np.abs(net3), elig_idx)
netb5 = rolling_prior_median(np.abs(net5), elig_idx)
base_ok = ~np.isnan(volb[:, 200])

np.savez(f"{BASE}/R3-baselines.npz", Vmin=Vmin, path_min=path_min,
         net_min=net_min, sflow_min=sflow_min, maxv_min=maxv_min, nz_min=nz_min,
         F180=F180, AC180=AC180, net3=net3, net5=net5,
         volb=volb, pathb=pathb, fanob=fanob, maxvb=maxvb,
         netb3=netb3, netb5=netb5,
         elig=elig, base_ok=base_ok, year=year,
         atr_top=meta["atr_top"].to_numpy(bool),
         atr_bot=meta["atr_bot"].to_numpy(bool),
         atr_known=meta["atr_known"].to_numpy(bool))

# --- slim per-minute CSV for reuse ---
use = elig & base_ok
di, mi = np.where(use[:, None] & np.ones((1, N_MIN), bool))
slim = pd.DataFrame({
    "date": np.array(days)[di], "minute": [minute_label(m) for m in mi],
    "m": mi, "V": Vmin[di, mi], "volb": volb[di, mi],
    "path": path_min[di, mi], "pathb": pathb[di, mi],
    "net": net_min[di, mi], "sflow": sflow_min[di, mi],
    "maxv": maxv_min[di, mi], "nz": nz_min[di, mi],
    "F180": F180[di, mi], "fanob": fanob[di, mi], "AC180": AC180[di, mi],
})
slim.to_csv(f"{BASE}/R3-minute-features.csv.gz", index=False,
            float_format="%.4g", compression="gzip")

# --- census printout ---
print(f"days={D} eligible={elig.sum()} with-baseline={use.sum()}")
print("\nPer-second volume baseline shape (median volb/60 across used days):")
for lab, m in [("09:30", 2), ("09:45", 17), ("10:30", 62), ("12:00", 152),
               ("14:00", 272), ("15:00", 332), ("15:30", 362), ("15:59", 391)]:
    b = volb[use, m] / 60
    print(f"  {lab}: p50={np.nanmedian(b):6.1f} ctr/s  "
          f"p10={np.nanpercentile(b,10):6.1f} p90={np.nanpercentile(b,90):6.1f}")
print("\nVol multiple (Vmin/volb) distribution, 09:30-16:00, used days:")
vm = (Vmin / volb)[use][:, 2:392].ravel()
vm = vm[~np.isnan(vm)]
for q in [1, 10, 25, 50, 75, 90, 99, 99.9]:
    print(f"  p{q:5}: {np.percentile(vm, q):8.2f}")
print("\nSingle-second multiple census (v / (volb/60)), events per day:")
secb = np.repeat(volb / 60, 60, axis=1)
mult = np.where(secb > 0.05, v / np.maximum(secb, 0.05), 0)
mult[~use] = 0
mult[:, :120] = 0
for thr in [10, 25, 50, 100, 200]:
    n = (mult >= thr).sum()
    print(f"  >= {thr:3}x: {n:8d} total  {n / use.sum():7.1f}/day")
print("\nFano factor F180 distribution vs its baseline (rf = F/fanob):")
rf = (F180 / fanob)[use][:, 5:392].ravel()
rf = rf[~np.isnan(rf)]
for q in [1, 5, 10, 25, 50, 75, 90, 99]:
    print(f"  p{q:5}: {np.percentile(rf, q):8.2f}")
print("\nRaw F180 by time of day (median across used days):")
for lab, m in [("09:45", 17), ("11:00", 92), ("13:00", 212), ("15:00", 332),
               ("15:45", 377)]:
    print(f"  {lab}: F180 p50={np.nanmedian(F180[use, m]):8.1f}  "
          f"AC180 p50={np.nanmedian(AC180[use, m]):+6.3f}")
print("\nZero-volume seconds per day (09:30-16:00):")
zz = (v[:, 120:] == 0).sum(1)[use]
print(f"  p10={np.percentile(zz,10):.0f} p50={np.percentile(zz,50):.0f} "
      f"p90={np.percentile(zz,90):.0f} (of {N_SEC-120})")
