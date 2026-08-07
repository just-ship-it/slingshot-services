#!/usr/bin/env python3
"""
M2-00b: session-date alignment.
Futures daily bars (gc,cl,si,hg,ng,nq) are stamped at 18:00 ET the calendar day BEFORE
the session (verified: gld-vs-gc returns correlate 0.88 only when gc is shifted +1 row;
futures dow set = {Mon..Thu,Sun}, no Friday). To put every series on the SAME market
session, futures session_date = busday_offset(label_date, +1). ETFs keep their date.
Outputs M2-returns-aligned.csv (date=session, one *_r return col per symbol).
dxy has a mixed calendar -> its true lag is auto-detected vs gld and applied.
"""
import pandas as pd, numpy as np
MACRO="/home/drew/projects/slingshot-services/backtest-engine/data/macro"
EXPL ="/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
FUT={"gc","cl","si","hg","ng","nq"}
ETF={"spy","vix","tlt","ief","hyg","lqd","uup","gld","iwm","btc"}

def load_ret(sym, shift_bd=0):
    df=pd.read_csv(f"{MACRO}/{sym}_1d.csv",parse_dates=["date"]).sort_values("date")
    df["r"]=df["close"].pct_change()
    d=df["date"].values.astype("datetime64[D]")
    if shift_bd:
        # roll='backward' first: Sunday label (=Monday's session) -> Fri -> +1 -> Mon (correct);
        # business-day labels unaffected by roll, +1 gives next session. roll='forward' would
        # push Sunday to Tuesday and drop Monday sessions.
        d=np.busday_offset(d, shift_bd, roll="backward")
    out=pd.DataFrame({"date":pd.to_datetime(d),"r":df["r"].values})
    return out.dropna().groupby("date",as_index=False)["r"].last().rename(columns={"r":sym})

# build
frames=[]
for s in sorted(FUT): frames.append(load_ret(s, shift_bd=1))
for s in sorted(ETF): frames.append(load_ret(s, shift_bd=0))
# dxy: detect lag vs gld
gld=load_ret("gld",0).set_index("date")["gld"]
best=None
for lag in [0,1]:
    dx=load_ret("dxy",lag).set_index("date")["dxy"]
    d=pd.concat([gld,dx],axis=1).dropna()
    c=abs(d["gld"].corr(d["dxy"]))
    if best is None or c>best[1]: best=(lag,c)
dxy_lag=best[0]
print(f"dxy chosen shift_bd={dxy_lag} (|corr gld|={best[1]:.3f})")
frames.append(load_ret("dxy", dxy_lag))

panel=frames[0]
for f in frames[1:]: panel=panel.merge(f,on="date",how="outer")
panel=panel.sort_values("date").reset_index(drop=True)
panel.to_csv(f"{EXPL}/M2-returns-aligned.csv",index=False)
print("aligned returns panel:",panel.shape, panel.date.min().date(),"->",panel.date.max().date())

# sanity: gld vs gc should now be ~0.88 at lag0
d=panel[["gld","gc"]].dropna(); print("sanity gld-gc (lag0):",round(d["gld"].corr(d["gc"]),3))
d=panel[["spy","nq"]].dropna(); print("sanity spy-nq (lag0):",round(d["spy"].corr(d["nq"]),3))
