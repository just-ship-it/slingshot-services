#!/usr/bin/env python3
"""
R3-06: EOD POSITIVE CONTROL + ONSET TIMING (family 6).

Known mechanical flow (calibration, independent of this study): 15:00->15:30 ET
continues the day's move, clock-locked, +5-9 pts. This is the ground truth a
volume/speed detector SHOULD light up on if it detects real dealer flow.

Tests:
 (1) Reproduce the clock control itself on our cache: sign(move 09:30->15:00)
     applied to 15:00->15:30 move, per year.
 (2) DETECTOR ALIGNMENT: for program blocks & volume-runs & bursty blocks
     starting 14:00-15:45, is the block's flow DIRECTION aligned with the day's
     move-so-far (09:30->block start)? A real re-hedge detector should show
     alignment >> 50% AND the 15:00-15:30 continuation should be stronger on
     days where a block fired in 14:3x-15:0x.
 (3) ONSET TIMING: does "first qualifying volume-run after 14:00, aligned with
     day move" timestamp the continuation better than the fixed 15:00 clock?
     Compare aligned 15:00->15:30 move conditioned on early-block presence.
"""
import numpy as np
import pandas as pd
from R3_common import (load_dense, load_baselines, sec_of, day_clustered,
                       fmt_yearly, BASE)

z = load_dense()
c = z["c"]
days = np.array(z["days"])
D = len(days)
b = load_baselines()
use = b["elig"] & b["base_ok"]
year = b["year"].astype(int)
cm_end = c[:, 59::60]

s_0930 = sec_of(9, 30)
s_1400 = sec_of(14, 0)
s_1500 = sec_of(15, 0)
s_1530 = sec_of(15, 30)
s_1545 = sec_of(15, 45)

ud = np.where(use)[0]
move_to_1500 = c[ud, s_1500] - c[ud, s_0930]
cont = c[ud, s_1530] - c[ud, s_1500]           # the continuation window
day_dir = np.sign(move_to_1500)
aligned_cont = day_dir * cont                  # +ve = continuation

print("=" * 70)
print("(1) CLOCK CONTROL: 15:00->15:30 aligned with 09:30->15:00 day move")
fmt_yearly({"cont_pts": aligned_cont}, ud, year, "15:00-15:30 aligned continuation")
big = np.abs(move_to_1500) >= 20
print(f"\n  restricted to trend days (|09:30-15:00|>=20pt): n={big.sum()}")
fmt_yearly({"cont_pts": aligned_cont[big]}, ud[big], year, "trend-day continuation")

# ---- detector alignment ----
print("\n" + "=" * 70)
print("(2) DETECTOR ALIGNMENT 14:00-15:45 (does a volume signature point")
print("    the same way as the day's move-so-far?)")
blk = pd.read_csv(f"{BASE}/R3-program-blocks.csv")
blk = blk[(blk.m0 >= (s_1400 // 60)) & (blk.m0 <= (s_1545 // 60))].copy()
# move so far at block start
m0 = blk["m0"].to_numpy()
dd = blk["d"].to_numpy()
move_sofar = cm_end[dd, m0 - 1] - c[dd, s_0930]
blk["aligned"] = (np.sign(blk["dir_full"].to_numpy()) == np.sign(move_sofar)) & (move_sofar != 0)
for tag in ["program", "bursty", "volrun"]:
    sub = blk[blk.tag == tag]
    if not len(sub):
        continue
    al = sub["aligned"].mean()
    # per year
    yrs = year[sub["d"].to_numpy()]
    py = pd.Series(sub["aligned"].to_numpy()).groupby(yrs).mean()
    print(f"  {tag:>8}: n={len(sub):5d}  aligned-with-day-move={al*100:4.1f}%  "
          f"per-yr[" + " ".join(f"{int(y)}:{p*100:.0f}" for y, p in py.items()) + "]")

# ---- does an aligned late block predict a STRONGER continuation? ----
print("\n" + "=" * 70)
print("(3) ONSET: continuation 15:00->15:30 conditioned on a 14:30-15:00")
print("    ALIGNED volume-run having fired (vs no such run)")
vr = blk[(blk.tag == "volrun") & (blk.m0 >= (sec_of(14, 30) // 60)) &
         (blk.m0 <= (s_1500 // 60)) & blk.aligned]
fired_days = set(vr["d"].tolist())
has = np.array([d in fired_days for d in ud])
print(f"  days with an aligned 14:30-15:00 volume-run: {has.sum()} / {len(ud)}")
a1 = day_clustered(aligned_cont[has], ud[has])
a0 = day_clustered(aligned_cont[~has], ud[~has])
print(f"  15:00-15:30 aligned continuation:")
print(f"    fired : {a1['mean_dayw']:+.2f} pts (t{a1['t']:+.1f}, n={a1['n']})")
print(f"    quiet : {a0['mean_dayw']:+.2f} pts (t{a0['t']:+.1f}, n={a0['n']})")
fmt_yearly({"cont": aligned_cont[has]}, ud[has], year, "continuation | aligned late run fired")

# onset timing: does the run's OWN forward 15:30 close beat the 15:00 clock?
print("\n  onset-anchored: from each aligned 14:30-15:00 run detection minute,")
print("  aligned move to 15:30 (dir = day move-so-far):")
dd2 = vr["d"].to_numpy()
det_s = ((vr["m0"] + 3) * 60).to_numpy()
det_dir = np.sign(cm_end[dd2, vr["m0"].to_numpy() - 1] - c[dd2, s_0930])
ok = det_s < s_1530
mv = det_dir[ok] * (c[dd2[ok], s_1530] - c[dd2[ok], det_s[ok]])
st = day_clustered(mv, dd2[ok])
print(f"    n={st['n']}  aligned det->15:30 = {st['mean_dayw']:+.2f} pts (t{st['t']:+.1f})")

print("\n" + "=" * 70)
print("(4) 14:00-15:45 bursts (from R3-02) — aligned continuation to +15m")
be = pd.read_csv(f"{BASE}/R3-burst-events.csv")
be = be[be["kind"] == "block"].copy()
be["mi"] = (be["s"] // 60).astype(int)
be = be[(be.mi >= s_1400 // 60) & (be.mi <= s_1545 // 60)]
dd3 = be["d"].to_numpy()
msofar = cm_end[dd3, be["mi"].to_numpy() - 1] - c[dd3, s_0930]
al = (np.sign(be["dir"].to_numpy()) == np.sign(msofar)) & (msofar != 0)
print(f"  EOD burst blocks aligned with day move: {al.mean()*100:.1f}% (n={len(be)})")
