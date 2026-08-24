#!/usr/bin/env python3
"""BATCH A — every date-anchored raid, tested against a matched control, dev/val split.
   Absolute EV in $ at 1 NQ, costs charged ($5 commission + 1 tick entry + 1 tick exit = $15/trade)."""
import pandas as pd, numpy as np, datetime as dt, warnings, json
warnings.filterwarnings('ignore')
d=pd.read_csv("sessions_NQ.csv")
d['date']=pd.to_datetime(d.tradeDate); d['dow']=d.date.dt.dayofweek; d['dom']=d.date.dt.day
d['dev']=d.tradeDate<='2024-12-31'
COST=15.0; PT=20.0
W=['globexOpen','overnight','euro','preOpen','open60','morning','midday','aft','preclose','last30','postSettle','rth']
for w in W:
    d[w+'_ret']=(d[w+'C']-d[w+'O'])*PT           # $ per 1 NQ, open→close of the window
    d[w+'_rng']=(d[w+'H']-d[w+'L'])*PT
# ---- event tags
nxt=d.tradeDate.shift(-1)
d['monthEnd']=d.date.dt.month!=pd.to_datetime(nxt).dt.month
d['quarterEnd']=d.monthEnd&d.date.dt.month.isin([3,6,9,12])
d['opex']=(d.dow==4)&d.dom.between(15,21)
d['quad']=d.opex&d.date.dt.month.isin([3,6,9,12])
d['monday']=d.dow==0
# roll week: sessions where the front symbol changes within +/-4 sessions
sym=d.sym.values; rollIdx=[i for i in range(1,len(sym)) if sym[i]!=sym[i-1]]
rw=np.zeros(len(d),bool)
for i in rollIdx:
    rw[max(0,i-4):min(len(d),i+2)]=True
d['rollWeek']=rw
# half-day: RTH bar count far below normal
med=d.rthN.median(); d['halfDay']=d.rthN<med*0.6
# post-shock: |prev rth move| in top 5% of dev
prev=d.rth_ret.shift(1); thr=prev[d.dev].abs().quantile(0.95)
d['postShock']=prev.abs()>=thr
EVENTS=['monthEnd','quarterEnd','opex','quad','rollWeek','halfDay','monday','postShock']
print(f"{len(d)} sessions | cost ${COST}/trade\n")
print(f"{'event':>11} {'window':>11} {'dir':>5} {'nDev':>5} {'devEV$':>8} {'devWR':>6} | {'nVal':>4} {'valEV$':>8} {'valWR':>6} {'ctrlEV$':>8}")
hits=[]
for ev in EVENTS:
    for w in W:
        sub=d[d[ev]&d[w+'_ret'].notna()]
        ctl=d[~d[ev]&d[w+'_ret'].notna()]
        if len(sub)<30: continue
        for side in (1,-1):
            sd=sub[sub.dev]; sv=sub[~sub.dev]
            if len(sd)<20 or len(sv)<8: continue
            evd=(sd[w+'_ret']*side-COST).mean(); evv=(sv[w+'_ret']*side-COST).mean()
            ctlev=(ctl[ctl.dev][w+'_ret']*side-COST).mean()
            if evd<=0 or evv<=0: continue
            if evd<=ctlev: continue                      # must beat the matched control
            wrd=(sd[w+'_ret']*side>0).mean(); wrv=(sv[w+'_ret']*side>0).mean()
            hits.append((evd,ev,w,side,len(sd),evd,wrd,len(sv),evv,wrv,ctlev))
hits.sort(reverse=True)
for h in hits[:18]:
    _,ev,w,side,nd,evd,wrd,nv,evv,wrv,ctl=h
    print(f"{ev:>11} {w:>11} {'long' if side>0 else 'short':>5} {nd:>5} {evd:>+8.0f} {wrd*100:>5.0f}% | {nv:>4} {evv:>+8.0f} {wrv*100:>5.0f}% {ctl:>+8.0f}")
print(f"\ncandidates positive on dev AND val AND beating control: {len(hits)}")
