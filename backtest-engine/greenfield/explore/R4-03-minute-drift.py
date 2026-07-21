#!/usr/bin/env python3
"""
H3 TIME-LOCKED MINUTE DRIFT. For each minute-of-day mod 570..719, the signed 1m
close-to-close return (DRIFT = mean) separated from event-vol (STD). One return per
day per minute => pooled == day-weighted automatically. Per-year sign stability.
Multiple-testing aware: 150 minutes tested, ~7 expected |t|>2 by chance.
Confirm/kill the ~09:49 fade hint (mod 589). Compare first-hour to a midday control band.
Mechanism: a clock-locked re-hedge would leave a stable signed drift at a specific minute.
"""
import numpy as np, pandas as pd, r4_common as R
mr_all = pd.read_csv("R4-minute-returns.csv")
mr = mr_all[mr_all["mod"]<720]     # first-hour+ band 09:30-11:59
rows=[]
for mm,g in mr.groupby("mod"):
    mu,sd,n,t = R.tstat(g["ret_atr"].to_numpy())
    mup = g["ret_pts"].mean()
    out,verd = R.per_year(g,"ret_atr")
    signs=[np.sign(x[2]) for x in out if x[1]>=20 and np.isfinite(x[2])]
    stable = (len(signs)>0) and (abs(sum(signs))==len(signs))
    hh=mm//60; mn=mm%60
    rows.append(dict(mod=mm,hhmm=f"{hh:02d}:{mn:02d}",n=n,drift_pts=mup,drift_atr=mu,
                     t=t,vol_atr=sd,verdict=verd,stable=stable))
d=pd.DataFrame(rows)
print(f"=== H3 minute drift, mods 570..719  ({len(d)} minutes) ===")
print(f"minutes with |t|>2: {(d.t.abs()>2).sum()} (chance~7)   |t|>2 AND per-year sign-stable: {((d.t.abs()>2)&d.stable).sum()}")
print("\nTop 12 by |t| (drift = signed re-hedge; vol = event magnitude):")
top=d.reindex(d.t.abs().sort_values(ascending=False).index).head(12)
for _,r in top.iterrows():
    print(f"  {r.hhmm}  drift={r.drift_pts:+.3f}pt ({r.drift_atr:+.4f}/atr) t={r.t:+.2f} vol={r.vol_atr:.4f} {'STABLE' if r.stable else '     '} [{r.verdict}]")
print("\n09:49 fade hint (mod 589) and neighbours:")
for mm in [587,588,589,590,591]:
    r=d[d["mod"]==mm].iloc[0]
    print(f"  {r.hhmm}  drift={r.drift_pts:+.3f}pt t={r.t:+.2f} {'STABLE' if r.stable else ''} [{r.verdict}]")
print("\nHighest-vol minutes (event windows, magnitude not direction):")
for _,r in d.reindex(d.vol_atr.sort_values(ascending=False).index).head(6).iterrows():
    print(f"  {r.hhmm}  vol={r.vol_atr:.4f}/atr  drift={r.drift_pts:+.3f}pt t={r.t:+.2f}")

# cumulative signed drift across the first hour (is there a net clock drift 09:30->10:45?)
print("\nCumulative mean drift (pts) at marks vs 09:30 open (sanity, unsigned):")
cum = d.sort_values("mod"); cum["cumpt"]=cum["drift_pts"].cumsum()
for mm in [585,600,615,630,645]:
    r=cum[cum["mod"]==mm]
    if len(r): print(f"  by {r.iloc[0].hhmm}: cum drift {r.iloc[0].cumpt:+.2f} pt")

# CONTROL: midday band 12:00-14:00 (mod 720..839) - identical machinery, expect chance-like
ctrl = mr_all[(mr_all["mod"]>=720)&(mr_all["mod"]<840)]
crows=[]
for mm,g in ctrl.groupby("mod"):
    mu,sd,n,t=R.tstat(g["ret_atr"].to_numpy())
    out,verd=R.per_year(g,"ret_atr")
    signs=[np.sign(x[2]) for x in out if x[1]>=20 and np.isfinite(x[2])]
    crows.append((mm,t,(len(signs)>0 and abs(sum(signs))==len(signs))))
cd=pd.DataFrame(crows,columns=["mod","t","stable"])
fh = d  # first hour 570..719 already
print(f"\nCONTROL midday 12:00-14:00 ({len(cd)} min): |t|>2 = {(cd.t.abs()>2).sum()}  |t|>2 & stable = {((cd.t.abs()>2)&cd.stable).sum()}")
print(f"first-hour+ band 09:30-11:59 ({len(fh)} min):  |t|>2 = {(fh.t.abs()>2).sum()}  |t|>2 & stable = {((fh.t.abs()>2)&fh.stable).sum()}")
d.to_csv("R4-minute-drift-summary.csv",index=False)
print("\nsaved R4-minute-drift-summary.csv")
