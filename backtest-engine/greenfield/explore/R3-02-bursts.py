#!/usr/bin/env python3
"""
R3-02: BURST TAXONOMY (family 1).

Mechanism hypothesis: forced/mechanical participants (stop cascades, dealer
hedge slices, large sweeps) concentrate volume into single seconds or short
blocks; organic flow does not. If the burst carries information, forward drift
should align with its direction proxy beyond what a normal tick at that time
of day carries.

Events (thresholds fixed from R3-01 marginals BEFORE outcomes were examined):
  A) Monster seconds: v >= thr x per-second baseline (thr in 25/50/100),
     absolute floor v>=100, 120s per-day cooldown, 09:30-15:59.
  B) Burst blocks: >=3 consecutive seconds each >= 5x baseline and v>=50.
Direction proxy = sign(1s close change) (fallback: trailing-10s tick-rule flow).
Outcomes: aligned forward drift +1/+5/+15/+60m (points), day-clustered t.
Control: time-of-day-matched "normal" seconds (0.5-2x baseline), same proxy.
Writes R3-burst-events.csv (monsters + blocks) for reuse (R3-06 EOD control).
"""
import numpy as np
import pandas as pd
from R3_common import (BASE, N_SEC, S_0930, load_dense, load_baselines,
                       fwd_ret, fmt_yearly, day_clustered)

rngseed = np.random.default_rng(7)
z = load_dense()
v, c = z["v"], z["c"]
days = np.array(z["days"])
D = len(days)
b = load_baselines()
use = b["elig"] & b["base_ok"]
year = b["year"].astype(int)

dc = np.diff(c, axis=1, prepend=c[:, :1])
sgn = np.sign(dc).astype(np.float32)
sv = sgn * v
csv_cum = np.concatenate([np.zeros((D, 1), np.float32), np.cumsum(sv, 1)], 1)

secb = np.repeat(b["volb"] / 60, 60, axis=1)          # causal per-sec vol base
pathb_s = np.repeat(b["pathb"] / 60, 60, axis=1)      # causal per-sec path base
mult = np.where(secb > 0.05, v / np.maximum(secb, 0.05), 0).astype(np.float32)
mult[~use] = 0
mult[:, :S_0930] = 0
mult[:, 23520:] = 0                                    # exclude 16:00 minute

HOR = [60, 300, 900, 3600]

def dir_proxy(d, s):
    dr = np.sign(dc[d, s])
    z0 = dr == 0
    if z0.any():
        flow10 = csv_cum[d[z0], s[z0] + 1] - csv_cum[d[z0], np.maximum(s[z0] - 9, 0)]
        dr[z0] = np.sign(flow10)
    return dr

def extract_monsters(thr):
    rows = []
    mask = (mult >= thr) & (v >= 100)
    for d in np.where(use)[0]:
        ss = np.where(mask[d])[0]
        if len(ss) == 0:
            continue
        keep, last = [], -10 ** 9
        for s in ss:                                   # 120s cooldown, keep first
            if s - last >= 120:
                keep.append(s)
                last = s
        rows += [(d, s) for s in keep]
    d_arr = np.array([r[0] for r in rows], int)
    s_arr = np.array([r[1] for r in rows], int)
    return d_arr, s_arr

# ---------- A) monster seconds ----------
print("=" * 70)
print("A) MONSTER SECONDS (single 1s bar >= thr x causal per-sec baseline)")
all_events = []
for thr in [25, 50, 100]:
    d_arr, s_arr = extract_monsters(thr)
    dr = dir_proxy(d_arr, s_arr)
    ok = dr != 0
    d_arr, s_arr, dr = d_arr[ok], s_arr[ok], dr[ok]
    fw = {f"fwd{h//60}m": dr * fwd_ret(c, d_arr, s_arr, h) for h in HOR}
    fmt_yearly(fw, d_arr, year,
               f"monster >= {thr}x  (aligned drift pts; n={len(d_arr)})")
    if thr == 25:
        m_i = s_arr // 60
        imp = np.abs(dc[d_arr, s_arr]) / np.maximum(pathb_s[d_arr, s_arr], .01)
        r5 = c[np.maximum(0, d_arr), s_arr] - c[d_arr, np.maximum(s_arr - 300, 0)]
        rel5 = np.abs(r5) / np.maximum(b["netb5"][d_arr, m_i], .25)
        ev = pd.DataFrame({"kind": "monster", "date": days[d_arr], "d": d_arr,
                           "s": s_arr, "dur": 1, "vol": v[d_arr, s_arr],
                           "mult": mult[d_arr, s_arr], "dir": dr, "imp": imp,
                           "rel5": rel5, "r5sign": np.sign(r5), **fw})
        all_events.append(ev)
        # taxonomy splits on the 25x set
        print("\n-- taxonomy of 25x monsters (aligned fwd, pooled + splits) --")
        print(f"impact ratio imp=|1s dc|/per-sec path base: "
              f"p25={np.percentile(imp,25):.1f} p50={np.percentile(imp,50):.1f} "
              f"p75={np.percentile(imp,75):.1f}")
        splits = {
            "absorbed(imp<=1)": imp <= 1,
            "normal(1-4)": (imp > 1) & (imp < 4),
            "drive(imp>=4)": imp >= 4,
            "with_run": (rel5 >= 1.5) & (np.sign(r5) == dr),
            "against_run": (rel5 >= 1.5) & (np.sign(r5) == -dr),
            "no_run": rel5 < 1.5,
        }
        for lab, msk in splits.items():
            st5 = day_clustered(fw["fwd5m"][msk], d_arr[msk])
            st15 = day_clustered(fw["fwd15m"][msk], d_arr[msk])
            print(f"  {lab:>18}: n={msk.sum():6d}  "
                  f"+5m {st5['mean_dayw']:+6.2f} (t{st5['t']:+5.1f})  "
                  f"+15m {st15['mean_dayw']:+6.2f} (t{st15['t']:+5.1f})")

# ---------- control: time-matched normal seconds ----------
print("\n" + "=" * 70)
print("CONTROL: time-of-day-matched NORMAL seconds (0.5-2x base, tick != 0)")
pool = (mult >= 0.5) & (mult <= 2) & (dc != 0) & (v >= 5)
used_days = np.where(use)[0]
ctrl_d, ctrl_s = [], []
ev25 = all_events[0]
for s_e in ev25["s"].to_numpy():
    cand = used_days[pool[used_days, s_e]]
    if len(cand):
        ctrl_d += rngseed.choice(cand, size=min(3, len(cand)), replace=False).tolist()
        ctrl_s += [s_e] * min(3, len(cand))
ctrl_d = np.array(ctrl_d, int)
ctrl_s = np.array(ctrl_s, int)
cdr = np.sign(dc[ctrl_d, ctrl_s])
fwc = {f"fwd{h//60}m": cdr * fwd_ret(c, ctrl_d, ctrl_s, h) for h in HOR}
fmt_yearly(fwc, ctrl_d, year, f"matched normal-second control (n={len(ctrl_d)})")

# ---------- B) burst blocks ----------
print("\n" + "=" * 70)
print("B) BURST BLOCKS (>=3 consecutive seconds each >=5x base & v>=50)")
mask5 = (mult >= 5) & (v >= 50)
rows = []
for d in used_days:
    m = mask5[d]
    dif = np.diff(m.astype(np.int8), prepend=0, append=0)
    starts = np.where(dif == 1)[0]
    ends = np.where(dif == -1)[0]           # exclusive
    for s0, s1 in zip(starts, ends):
        if s1 - s0 < 3 or s0 < S_0930:
            continue
        vol_tot = v[d, s0:s1].sum()
        sflow = sv[d, s0:s1].sum()
        net = c[d, s1 - 1] - c[d, max(s0 - 1, 0)]
        dr = np.sign(sflow) or np.sign(net)
        if dr == 0:
            continue
        half = (s1 - s0) // 2
        front = v[d, s0:s0 + half].sum() / vol_tot if vol_tot else np.nan
        onesided = abs(sflow) / vol_tot if vol_tot else np.nan
        pb = pathb_s[d, s0:s1].sum()
        rows.append((d, s0, s1 - s0, vol_tot, sflow, net, dr, front, onesided,
                     abs(net) / max(pb, .01)))
bl = pd.DataFrame(rows, columns=["d", "s", "dur", "vol", "sflow", "net", "dir",
                                 "front", "onesided", "disp"])
bl["kind"] = "block"
bl["date"] = days[bl["d"]]
d_arr = bl["d"].to_numpy()
s_end = (bl["s"] + bl["dur"]).to_numpy()    # first second after block
dr = bl["dir"].to_numpy()
fwb = {f"fwd{h//60}m": dr * fwd_ret(c, d_arr, s_end, h) for h in HOR}
for k, val in fwb.items():
    bl[k] = val
print(f"blocks={len(bl)}  dur p50={bl['dur'].median():.0f}s "
      f"p90={bl['dur'].quantile(.9):.0f}s  vol p50={bl['vol'].median():.0f}")
fmt_yearly(fwb, d_arr, year, "burst blocks (aligned drift from block end)")

print("\n-- block anatomy splits (pooled aligned fwd) --")
an = {
    "front-loaded(>60%)": bl["front"] > 0.60,
    "back-loaded(<40%)": bl["front"] < 0.40,
    "one-sided(>=0.7)": bl["onesided"] >= 0.7,
    "two-sided(<0.3)": bl["onesided"] < 0.3,
    "stall(disp<=0.5)": bl["disp"] <= 0.5,
    "drive(disp>=2)": bl["disp"] >= 2,
}
for lab, msk in an.items():
    msk = msk.to_numpy()
    st5 = day_clustered(fwb["fwd5m"][msk], d_arr[msk])
    st15 = day_clustered(fwb["fwd15m"][msk], d_arr[msk])
    st60 = day_clustered(fwb["fwd60m"][msk], d_arr[msk])
    print(f"  {lab:>20}: n={msk.sum():5d}  +5m {st5['mean_dayw']:+6.2f}(t{st5['t']:+5.1f}) "
          f"+15m {st15['mean_dayw']:+6.2f}(t{st15['t']:+5.1f}) "
          f"+60m {st60['mean_dayw']:+6.2f}(t{st60['t']:+5.1f})")

ev_out = pd.concat([all_events[0],
                    bl[["kind", "date", "d", "s", "dur", "vol", "dir",
                        "front", "onesided", "disp"] + list(fwb)]],
                   ignore_index=True)
ev_out.to_csv(f"{BASE}/R3-burst-events.csv", index=False, float_format="%.4g")
print(f"\nwrote R3-burst-events.csv rows={len(ev_out)}")
