#!/usr/bin/env python3
"""
H4 10:00 ET MACRO-RELEASE REACTION. Separate the KNOWN vol spike at 10:00 from any
tradable SIGNED drift. Release-day proxy = top-tercile realized 5m range at 10:00
(vol_1000_5m_atr). Limits: proxy catches ISM/UMich/JOLTS-class 10:00 prints but also
non-scheduled vol; no economic calendar in clean data, so this is a vol-conditioned
census, not an event study.
Tests: (a) drift 10:00->10:15/10:30 conditional on the 09:45->10:00 pre-move sign
(continuation vs fade of the release impulse); (b) unconditional signed drift on
high-vol-10:00 days. One event/day => pooled == day-weighted.
"""
import numpy as np, pandas as pd, r4_common as R
m = pd.read_csv("R4-marks.csv", parse_dates=["trade_date"])
atr=m["atr14_prior"].to_numpy()
v=m["vol_1000_5m_atr"].to_numpy()
hi_thr=np.nanquantile(v,0.67); lo_thr=np.nanquantile(v,0.33)
print(f"=== H4 10:00 vol: median 5m range/atr @10:00 = {np.nanmedian(v):.4f} vs @11:00 = {np.nanmedian(m['vol_1100_5m_atr']):.4f} ===")
print(f"    release-proxy (top-tercile 10:00 vol) threshold /atr = {hi_thr:.4f}  n_days={len(m)}")

premove = np.sign(m["p1000"].to_numpy()-m["p0945"].to_numpy())   # 09:45->10:00 impulse sign
def drift(mask,name,anchor="p1000",outs=("p1015","p1030")):
    g=m[mask]
    if len(g)<40: print(f"  {name:<44s} n={len(g)} (skip)"); return
    print(f"  [{name}] n={len(g)}")
    for o in outs:
        r=(g[o].to_numpy()-g[anchor].to_numpy())
        gg=g.copy(); gg["_r"]=r/gg["atr14_prior"].to_numpy()
        d=R.desc(r,o); out,verd=R.per_year(gg,"_r")
        print(f"     {anchor}->{o}: pts={d['mean']:+.3f} t={d['t']:+.2f} /atr={r.mean()/g['atr14_prior'].mean():+.4f}  [{verd}]")

hivol = v>=hi_thr
print("\n-- (b) unconditional signed drift on HIGH-vol-10:00 (release-proxy) days --")
drift(hivol,"high-vol 10:00 (all)")
print("\n-- (a) CONTINUATION of the 09:45->10:00 impulse (side*fwd) --")
# build side*fwd on high-vol days
for tag,mask in [("high-vol 10:00",hivol),("low-vol 10:00",v<=lo_thr)]:
    g=m[mask].copy(); s=np.sign(g["p1000"].to_numpy()-g["p0945"].to_numpy())
    for o in ["p1015","p1030"]:
        cont=s*(g[o].to_numpy()-g["p1000"].to_numpy()); g["_c"]=cont/g["atr14_prior"].to_numpy()
        d=R.desc(cont,f"{tag} cont->{o}"); out,verd=R.per_year(g,"_c")
        print(f"  {tag:<16s} impulse-cont 10:00->{o[1:]}: pts={d['mean']:+.3f} t={d['t']:+.2f} n={d['n']} [{verd}]")

print("\n-- (a-CAUSAL) gate on IMPULSE MAGNITUDE known AT 10:00; enter 10:00, continuation --")
imp = np.abs(m["p1000"].to_numpy()-m["p0945"].to_numpy())/atr
big = imp>=np.nanquantile(imp,0.67)
g=m[big].copy(); s=np.sign(g["p1000"].to_numpy()-g["p0945"].to_numpy())
for o in ["p1015","p1030"]:
    cont=s*(g[o].to_numpy()-g["p1000"].to_numpy()); g["_c"]=cont/g["atr14_prior"].to_numpy()
    d=R.desc(cont,o); out,verd=R.per_year(g,"_c")
    print(f"  big-impulse(known@10:00) cont 10:00->{o[1:]}: pts={d['mean']:+.3f} t={d['t']:+.2f} n={d['n']} [{verd}]")

print("\n-- (a-CAUSAL2) vol gate known at 10:05; enter 10:05, continuation to 10:15/10:30 --")
g=m[hivol].copy(); s=np.sign(g["p1000"].to_numpy()-g["p0945"].to_numpy())
for o in ["p1015","p1030"]:
    cont=s*(g[o].to_numpy()-g["p1005"].to_numpy()); g["_c"]=cont/g["atr14_prior"].to_numpy()
    d=R.desc(cont,o); out,verd=R.per_year(g,"_c")
    print(f"  hivol-gate@10:05 enter10:05 cont ->{o[1:]}: pts={d['mean']:+.3f} t={d['t']:+.2f} n={d['n']} [{verd}]")

print("\n-- FADE framing: -impulse*fwd on high-vol days (does the 10:00 spike revert?) --")
g=m[hivol].copy(); s=np.sign(g["p1000"].to_numpy()-g["p0945"].to_numpy())
for o in ["p1015","p1030","p1045"]:
    fade=-s*(g[o].to_numpy()-g["p1000"].to_numpy()); g["_f"]=fade/g["atr14_prior"].to_numpy()
    d=R.desc(fade,f"fade->{o}"); out,verd=R.per_year(g,"_f")
    print(f"  high-vol fade 10:00->{o[1:]}: pts={d['mean']:+.3f} t={d['t']:+.2f} n={d['n']} [{verd}]")
