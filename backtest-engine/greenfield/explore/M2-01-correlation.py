#!/usr/bin/env python3
"""
M2-01 Track A: diversification profile (SESSION-ALIGNED).
Uses M2-returns-aligned.csv (futures shifted +1 business day to the true session date,
so futures-vs-ETF joins are on the same market session). Book PnL is on the equity
session calendar and joins directly.
(A) gc & cl daily returns vs equity-book daily PnL and vs nq/spy.
(B) gc-vs-cl and each vs macro (rates/dollar/vix).
(C) per-year + stress-window correlation stability.
"""
import pandas as pd, numpy as np
EXPL="/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
rets=pd.read_csv(f"{EXPL}/M2-returns-aligned.csv",parse_dates=["date"])
book=pd.read_csv(f"{EXPL}/M2-book.csv",parse_dates=["date"])

def c(a,b,sub):
    d=sub[[a,b]].dropna()
    return (d[a].corr(d[b]), len(d)) if len(d)>=20 else (np.nan,len(d))

print("="*70); print("TRACK A  Part B/context: return-return corr (full aligned history)"); print("="*70)
for p in [("gc","cl"),("gc","nq"),("gc","spy"),("cl","nq"),("cl","spy"),
          ("gc","tlt"),("gc","ief"),("gc","dxy"),("gc","uup"),("gc","vix"),("gc","gld"),("gc","si"),
          ("cl","dxy"),("cl","hg"),("cl","vix"),("cl","tlt"),("cl","iwm")]:
    r,n=c(*p,rets); print(f"  corr({p[0]:>3},{p[1]:>3}) = {r:+.3f}  n={n}")

print("\n"+"="*70); print("TRACK A  Part A: gc/cl vs EQUITY BOOK daily PnL (2021-2026)"); print("="*70)
bmin,bmax=book.date.min(),book.date.max()
cal=rets[(rets.date>=bmin)&(rets.date<=bmax)][["date","gc","cl","nq","spy"]].copy()
bk=book.set_index("date")
for col in ["pnl_combined","pnl_pcc","pnl_monday","pnl_gapfade"]:
    cal[col]=cal.date.map(bk[col])
print("\n-- (i) co-traded days only (book traded that session) --")
for pnlc in ["pnl_combined","pnl_pcc","pnl_monday","pnl_gapfade"]:
    row=f"  {pnlc:13}:"
    for comm in ["gc","cl","nq","spy"]:
        d=cal[[comm,pnlc]].dropna(); r=d[comm].corr(d[pnlc]) if len(d)>=20 else np.nan
        row+=f"  {comm}={r:+.3f}(n{len(d)})"
    print(row)
print("\n-- (ii) zero-filled over equity calendar (portfolio level) --")
calz=cal.copy()
for col in ["pnl_combined","pnl_pcc","pnl_monday","pnl_gapfade"]:
    calz[col]=calz[col].fillna(0.0)
for pnlc in ["pnl_combined","pnl_pcc","pnl_monday","pnl_gapfade"]:
    row=f"  {pnlc:13}:"
    for comm in ["gc","cl"]:
        d=calz[[comm,pnlc]].dropna(); row+=f"  {comm}={d[comm].corr(d[pnlc]):+.3f}"
    print(row)

print("\n"+"="*70); print("TRACK A  Part C: per-year stability"); print("="*70)
rets["yr"]=rets.date.dt.year
print(f"{'yr':>5} {'gc-nq':>7} {'gc-spy':>7} {'cl-nq':>7} {'cl-spy':>7} {'gc-cl':>7} {'gc-dxy':>7} {'gc-tlt':>7} {'cl-dxy':>7} {'cl-hg':>7}")
for yr in range(2005,2027):
    s=rets[rets.yr==yr]
    if len(s)<50: continue
    def cc(a,b):
        d=s[[a,b]].dropna(); return d[a].corr(d[b]) if len(d)>=30 else np.nan
    print(f"{yr:>5} {cc('gc','nq'):>+7.3f} {cc('gc','spy'):>+7.3f} {cc('cl','nq'):>+7.3f} {cc('cl','spy'):>+7.3f} {cc('gc','cl'):>+7.3f} {cc('gc','dxy'):>+7.3f} {cc('gc','tlt'):>+7.3f} {cc('cl','dxy'):>+7.3f} {cc('cl','hg'):>+7.3f}")

print("\n-- stress windows: gc/cl vs spy (decouple or converge?) --")
for label,lo,hi in [("2008 GFC","2008-01-01","2009-06-30"),("2014-16 oil","2014-07-01","2016-03-31"),
                    ("2020 COVID","2020-02-01","2020-06-30"),("2022 stress","2022-01-01","2022-12-31"),
                    ("2021-26 book","2021-01-01","2026-07-22")]:
    s=rets[(rets.date>=lo)&(rets.date<=hi)]
    def cc(a,b):
        d=s[[a,b]].dropna(); return d[a].corr(d[b]) if len(d)>=20 else np.nan
    print(f"  {label:13}: gc-spy={cc('gc','spy'):+.3f} cl-spy={cc('cl','spy'):+.3f} gc-cl={cc('gc','cl'):+.3f} gc-tlt={cc('gc','tlt'):+.3f} n={len(s)}")
