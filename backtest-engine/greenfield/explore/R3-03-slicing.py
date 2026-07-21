#!/usr/bin/env python3
"""
R3-03: ALGORITHMIC SLICING DETECTOR (family 2 — centerpiece).

Mechanism: execution algos (TWAP/VWAP slicers) emit abnormally STEADY
per-second volume; organic flow is clustered/bursty.

v1 lesson (kept in findings doc): raw Fano factor (var/mean) scales with
volume level, so "low Fano AND elevated volume" is near-empty (28 blocks in
5.5y) — steadiness must be measured scale-free. v2 uses the coefficient of
variation CV = sd/mean of 1s volumes (trailing 180s) vs its causal
time-of-day baseline (trailing-20-day median). rcv = CV/CVb.

Definitions (thresholds from marginals printed below, chosen for event mass
before outcomes were examined):
  steady   rcv <= 0.70      bursty   rcv >= 1.00
  elevated vm3 >= 1.2 (trailing-3m volume multiple)
  block = >=3 consecutive qualifying minutes; detection = end of 3rd minute.
KNOWABILITY: direction at detection uses ONLY minutes m0..m0+2 (tick-rule
flow, fallback drift); full-block direction is used only for from-END
outcomes (knowable at the break minute close).
Writes R3-program-blocks.csv (program + bursty + plain volume-run blocks).
"""
import numpy as np
import pandas as pd
from R3_common import (BASE, N_MIN, load_dense, load_baselines,
                       rolling_prior_median, fwd_ret, fmt_yearly,
                       day_clustered, minute_label)

z = load_dense()
v, c = z["v"], z["c"]
days = np.array(z["days"])
D = len(days)
b = load_baselines()
use = b["elig"] & b["base_ok"]
year = b["year"].astype(int)
used_days = np.where(use)[0]
elig_idx = np.where(b["elig"])[0]

Vmin, volb = b["Vmin"], b["volb"]
sflow_min = b["sflow_min"]
cm_end = c[:, 59::60]

# ---- scale-free steadiness: CV of 1s volumes, trailing 180s ----
S1 = np.concatenate([np.zeros((D, 1)), np.cumsum(v, 1)], 1)
S2 = np.concatenate([np.zeros((D, 1)), np.cumsum(v.astype(np.float64) ** 2, 1)], 1)
CV = np.full((D, N_MIN), np.nan, np.float32)
W = 180
for m in range(2, N_MIN):
    e = (m + 1) * 60
    mu = (S1[:, e] - S1[:, e - W]) / W
    var = (S2[:, e] - S2[:, e - W]) / W - mu ** 2
    ok = mu > 0.5
    CV[ok, m] = (np.sqrt(np.maximum(var[ok], 0)) / mu[ok]).astype(np.float32)
cvb = rolling_prior_median(CV, elig_idx)
rcv = CV / cvb

V3 = np.full((D, N_MIN), np.nan, np.float32)
B3 = np.full((D, N_MIN), np.nan, np.float32)
V3[:, 2:] = Vmin[:, 2:] + Vmin[:, 1:-1] + Vmin[:, :-2]
B3[:, 2:] = volb[:, 2:] + volb[:, 1:-1] + volb[:, :-2]
vm3 = V3 / B3

x = rcv[use][:, 4:392].ravel()
x = x[~np.isnan(x)]
print("rcv (CV/causal baseline) marginals: " +
      " ".join(f"p{q}={np.percentile(x, q):.2f}" for q in [1, 5, 10, 25, 50, 75, 90]))
j = ((rcv <= 0.70) & (vm3 >= 1.2))[use][:, 4:392]
print(f"joint steady+elevated marginal p={np.nanmean(np.where(np.isnan(rcv[use][:,4:392]), np.nan, j)):.4f}")

M_LO, M_HI = 4, 392

def find_blocks(cond_mat, tag):
    rows = []
    for d in used_days:
        cnd = np.where(np.isnan(rcv[d]), False, cond_mat[d])
        cnd[:2] = False
        dif = np.diff(cnd.astype(np.int8), prepend=0, append=0)
        st, en = np.where(dif == 1)[0], np.where(dif == -1)[0]
        for m0, m1x in zip(st, en):
            dur = m1x - m0
            if dur < 3 or m0 < 2 or m1x > 392:
                continue
            det_m = m0 + 2
            drift_det = cm_end[d, det_m] - cm_end[d, m0 - 1]
            drift_all = cm_end[d, m1x - 1] - cm_end[d, m0 - 1]
            sf_det = sflow_min[d, m0:det_m + 1].sum()
            sf_all = sflow_min[d, m0:m1x].sum()
            dir_det = np.sign(sf_det) or np.sign(drift_det)
            dir_full = np.sign(sf_all) or np.sign(drift_all)
            if dir_det == 0 or dir_full == 0:
                continue
            rows.append((d, m0, m1x - 1, dur, dir_det, dir_full, drift_det,
                         drift_all, np.nanmean(rcv[d, m0:m1x]),
                         np.nanmean(vm3[d, m0:m1x])))
    df = pd.DataFrame(rows, columns=["d", "m0", "m1", "dur", "dir_det",
                                     "dir_full", "drift_det", "drift_all",
                                     "rcv_mean", "vm3_mean"])
    df["tag"] = tag
    df["date"] = days[df["d"]]
    return df

def run_null_excess(cond_mat, label):
    xx = cond_mat[used_days][:, M_LO:M_HI]
    xx = np.where(np.isnan(rcv[used_days][:, M_LO:M_HI]), False, xx)
    p = xx.mean()
    obs = 0
    for r in xx:
        dif = np.diff(r.astype(np.int8), prepend=0, append=0)
        obs += int(((np.where(dif == -1)[0] - np.where(dif == 1)[0]) >= 3).sum())
    exp = xx.size * p ** 3 * (1 - p) ** 2
    print(f"{label}: p={p:.4f}  runs>=3 obs={obs}  indep-null~{exp:.0f}  "
          f"ratio={obs / max(exp, 1e-9):.1f}x")

cond_prog = (rcv <= 0.70) & (vm3 >= 1.2)
cond_burst = (rcv >= 1.00) & (vm3 >= 1.2)
cond_quiet = (rcv <= 0.70) & (vm3 < 1.2)
cond_volrun = vm3 >= 1.5                      # plain sustained elevated volume

print("\nPROGRAM-BLOCK EXISTENCE (clustering beyond independence)")
for cm, lab in [(cond_prog, "steady+elevated (rcv<=.7 & vm3>=1.2)"),
                (cond_burst, "bursty+elevated (rcv>=1 & vm3>=1.2)"),
                (cond_quiet, "steady+quiet"),
                (cond_volrun, "volume-run (vm3>=1.5)")]:
    run_null_excess(cm, lab)

blocks = find_blocks(cond_prog, "program")
bursty = find_blocks(cond_burst, "bursty")
quiet = find_blocks(cond_quiet, "steady_quiet")
volrun = find_blocks(cond_volrun, "volrun")
print(f"\nblocks: program={len(blocks)} bursty={len(bursty)} "
      f"quiet={len(quiet)} volrun={len(volrun)}")
print(f"program dur p50={blocks['dur'].median():.0f}m "
      f"p90={blocks['dur'].quantile(.9):.0f}m  days hit={blocks['d'].nunique()}")

print("\nTime-of-day distribution of block STARTS (count/day per 30min):")
nd = use.sum()
for lo in range(2, 392, 30):
    row = []
    for df, lab in [(blocks, "prog"), (bursty, "burst"), (volrun, "vrun")]:
        n = ((df["m0"] >= lo) & (df["m0"] < lo + 30)).sum()
        row.append(f"{lab} {n / nd:6.3f}")
    print(f"  {minute_label(lo)}-{minute_label(min(lo + 30, 392))}:  " + "   ".join(row))

def outcomes(df, label):
    if not len(df):
        print(f"\n[{label}] no blocks")
        return
    d_arr = df["d"].to_numpy()
    drd = df["dir_det"].to_numpy()
    drf = df["dir_full"].to_numpy()
    s_det = ((df["m0"] + 3) * 60).to_numpy()
    s_end = np.minimum(((df["m1"] + 2) * 60).to_numpy(), 23579)
    fw_det = {f"det+{h//60}m": drd * fwd_ret(c, d_arr, s_det, h)
              for h in [300, 900, 3600]}
    fw_end = {f"end+{h//60}m": drf * fwd_ret(c, d_arr, s_end, h)
              for h in [300, 900, 3600]}
    dd = day_clustered(drf * df["drift_all"].to_numpy(), d_arr)
    print(f"\n[{label}] concurrent full-block drift (NOT tradable): "
          f"{dd['mean_dayw']:+.2f} pts (t{dd['t']:+.1f})")
    fmt_yearly(fw_det, d_arr, year, f"{label}: aligned fwd from DETECTION "
               f"(dir = first-3-min flow only)")
    fmt_yearly(fw_end, d_arr, year, f"{label}: aligned fwd from BLOCK END")

outcomes(blocks, "PROGRAM (steady+elevated)")
outcomes(bursty, "BURSTY+ELEVATED")
outcomes(quiet, "STEADY+QUIET")
outcomes(volrun, "VOLUME-RUN (vm3>=1.5, any texture)")

print("\n-- volume-run: rcv texture split at detection (det+15m aligned) --")
d_arr = volrun["d"].to_numpy()
drd = volrun["dir_det"].to_numpy()
s_det = ((volrun["m0"] + 3) * 60).to_numpy()
f15 = drd * fwd_ret(c, d_arr, s_det, 900)
rcv_det = rcv[d_arr, (volrun["m0"] + 2).to_numpy()]
for lab, msk in [("steadier(rcv<=0.8)", rcv_det <= 0.8),
                 ("mid(0.8-1.2)", (rcv_det > 0.8) & (rcv_det < 1.2)),
                 ("burstier(>=1.2)", rcv_det >= 1.2)]:
    st = day_clustered(f15[msk], d_arr[msk])
    print(f"  {lab:>18}: n={st['n']:5d}  det+15m {st['mean_dayw']:+6.2f} (t{st['t']:+5.1f})")

print("\n-- volume-run: duration-so-far at detection is fixed (3m); "
      "dur split uses full dur (descriptive only) --")
for lab, msk in [("dur=3m", (volrun["dur"] == 3).to_numpy()),
                 ("dur 4-6m", volrun["dur"].between(4, 6).to_numpy()),
                 ("dur>=7m", (volrun["dur"] >= 7).to_numpy())]:
    st = day_clustered(f15[msk], d_arr[msk])
    print(f"  {lab:>9}: n={st['n']:5d}  det+15m {st['mean_dayw']:+6.2f} (t{st['t']:+5.1f})")

pd.concat([blocks, bursty, volrun], ignore_index=True).to_csv(
    f"{BASE}/R3-program-blocks.csv", index=False, float_format="%.4g")
print(f"\nwrote R3-program-blocks.csv rows={len(blocks) + len(bursty) + len(volrun)}")
