#!/usr/bin/env python3
"""
H1 OPENING-15m REVERSAL (owner obs a). Does the 09:30-09:45 candle direction lead
to CONTINUATION or FADE over the next 15/30/60m and to 10:30 / 12:00?
Convention: report side*fwd  (side = opening-candle sign). +mean => CONTINUATION,
-mean => reversal/fade. One event per day => pooled == day-weighted.
Mechanism to test: opening auction / overnight-unwind imbalance either exhausts
(fade) or ignites a trend (continuation vs the OR-continuation prior).
"""
import numpy as np, pandas as pd, r4_common as R
m = pd.read_csv("R4-marks.csv", parse_dates=["trade_date"])
m = m[m["oc_dir"] != 0].copy()
side = m["oc_dir"].to_numpy()
atr = m["atr14_prior"].to_numpy()
H = {"r15(->10:00)": "p1000", "r30(->10:15)": "p1015", "r60(->10:45)": "p1045",
     "to10:30": "p1030", "to12:00": "p1200"}
print(f"=== H1 opening-15m: CONTINUATION(+) vs FADE(-), side*fwd from 09:45  (n_days={len(m)}) ===")
for lab, mk in H.items():
    fwd = (m[mk].to_numpy() - m["p0945"].to_numpy())
    cont_pts = side * fwd
    cont_atr = cont_pts / atr
    m["_c"] = cont_atr
    d = R.desc(cont_pts, lab); da = R.desc(cont_atr, lab)
    print(f"  {lab:<14s} pts mean={d['mean']:+.3f} t={d['t']:+.2f} | /atr mean={da['mean']:+.4f} t={da['t']:+.2f} n={d['n']}")
    out, verd = R.per_year(m, "_c"); R.print_year(out, verd)

print("\n--- CONTROL: same construction at a midday anchor (11:00-11:15 candle -> next 15/30/60m) ---")
# side from 11:00-11:15 body sign; fwd from 11:15 to 11:30/11:45/12:15(->p1200 approx to noon+? use p1200 as 12:00)
mc = m.copy()
cside = np.sign(mc["p1100"].to_numpy() - mc["p1045"].to_numpy())  # 10:45->11:00 as a non-open anchor candle proxy
# forward 15/30 from 11:00
for lab, mk in {"ctrl r15": "p1200"}.items():
    pass
# cleaner midday control: 10:45->11:00 candle predicts 11:00->11:30 (=p1200 is 12:00, too far). Use p1100->p1200 (60m).
c_fwd = mc["p1200"].to_numpy() - mc["p1100"].to_numpy()
c_cont = cside * c_fwd
mc["_cc"] = c_cont / atr
d = R.desc(c_cont, "ctrl 10:45->11:00 dir -> 11:00->12:00")
print(f"  {d['label']:<38s} pts mean={d['mean']:+.3f} t={d['t']:+.2f} n={d['n']}")
out, verd = R.per_year(mc, "_cc"); R.print_year(out, verd)

print("\n=== H1 conditional splits on side*fwd to 10:30 (continuation framing) ===")
m["cont_1030"] = side * (m["p1030"].to_numpy() - m["p0945"].to_numpy())
m["cont_1030_atr"] = m["cont_1030"] / atr
def split(mask, name):
    g = m[mask]
    if len(g) < 30: print(f"  {name:<40s} n={len(g)} (skip)"); return
    d = R.desc(g["cont_1030"], name)
    out, verd = R.per_year(g, "cont_1030_atr")
    print(f"  {name:<40s} n={d['n']:<5d} pts={d['mean']:+.3f} t={d['t']:+.2f}  [{verd}]")

gap_atr = m["gap_atr"].to_numpy()
split(np.abs(gap_atr) < 0.1, "small gap (|gap|/atr<0.1)")
split(np.abs(gap_atr) >= 0.3, "large gap (|gap|/atr>=0.3)")
split(np.sign(gap_atr) == side, "gap same dir as opening candle")
split(np.sign(gap_atr) == -side, "gap opposite opening candle")
a5 = m["arr5"].to_numpy()
split(a5 >= np.nanquantile(a5, 0.75), "fast opening drive (arr5 top quartile)")
split(a5 <= np.nanquantile(a5, 0.25), "slow opening drive (arr5 bot quartile)")
onr = m["on_range_atr"].to_numpy()
split(onr <= np.nanquantile(onr, 0.33), "compressed ON (on_range/atr bot tercile)")
split(onr >= np.nanquantile(onr, 0.67), "wide ON (on_range/atr top tercile)")
# opening candle is a "trend bar" closing near its extreme in drive dir
bodyfrac = (m["oc_body"].abs() / m["oc_range"].replace(0, np.nan)).to_numpy()
split(bodyfrac >= 0.7, "opening candle trend-bar (body/range>=0.7)")
split(bodyfrac <= 0.3, "opening candle doji/wick (body/range<=0.3)")
# does opening candle set the eventual RTH extreme?
set_ext = ((side > 0) & m["oc_set_rth_high"]) | ((side < 0) & m["oc_set_rth_low"])
print(f"\n  P(opening candle sets eventual RTH extreme in drive dir) = {set_ext.mean():.3f}  n={len(m)}")
