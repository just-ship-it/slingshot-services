#!/usr/bin/env python3
"""R9-00: build midday-window 1m caches for NQ and ES (ET-localized).

Output long format per instrument: date,etm,o,h,l,c,v for ET minutes 540..965
(09:00..16:05), restricted to CLEAN days (full_rth & rth_same_sym in B12 for NQ;
ES uses its own roll==0 flag + single-symbol-per-rth check).

Census only (descriptive) -> 1m bars are admissible (GREENFIELD honesty rule #2).
Forward returns computed instant-to-instant on bar OPEN at each anchor minute.
"""
import pandas as pd, numpy as np

ROOT="/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
LO,HI=540,965   # ET minutes 09:00 .. 16:05

# ---- clean-day universe from B12 (NQ) ----
b12=pd.read_csv(f"{ROOT}/B12-days.csv")
clean_nq=set(b12.loc[(b12.full_rth==True)&(b12.rth_same_sym==True),"trade_date"])
print(f"B12 clean NQ days: {len(clean_nq)}")

# ---- NQ ----
print("loading NQ...")
nq=pd.read_csv(f"{ROOT}/cache_nq_primary_1m.csv")
t=pd.to_datetime(nq['ts']).dt.tz_localize('UTC').dt.tz_convert('America/New_York')
nq['etd']=t.dt.strftime('%Y-%m-%d'); nq['etm']=(t.dt.hour*60+t.dt.minute).astype(int)
nq=nq[(nq.etm>=LO)&(nq.etm<=HI)]
nq=nq[nq.etd.isin(clean_nq)]
# within a (date) there should be exactly one symbol across RTH for clean days; keep as-is
out=nq[['etd','etm','open','high','low','close','volume']].rename(columns={'etd':'date'})
out=out.sort_values(['date','etm'])
out.to_csv(f"{ROOT}/R9-nq-mid.csv",index=False)
print(f"NQ rows={len(out)} days={out.date.nunique()} span={out.date.min()}..{out.date.max()}")

# ---- ES ----
print("loading ES...")
es=pd.read_csv(f"{ROOT}/cache/ES_1m_primary.csv")
es['etm']=(es['et_hhmm']//100)*60+(es['et_hhmm']%100)
es=es[(es.etm>=LO)&(es.etm<=HI)]
# clean ES days: roll flag 0 for all rows in the day AND single symbol across the window
g=es.groupby('et_date')
nsym=g['symbol'].nunique()
rollmax=g['roll'].max()
clean_es=set(nsym[(nsym==1)].index) & set(rollmax[(rollmax==0)].index)
es=es[es.et_date.isin(clean_es)]
eout=es[['et_date','etm','o','h','l','c','v']].rename(
    columns={'et_date':'date','o':'open','h':'high','l':'low','c':'close','v':'volume'})
eout=eout.sort_values(['date','etm'])
eout.to_csv(f"{ROOT}/R9-es-mid.csv",index=False)
print(f"ES rows={len(eout)} days={eout.date.nunique()} span={eout.date.min()}..{eout.date.max()}")

# ---- day meta (year, dow, atr) for both ----
meta=b12[['trade_date','year','dow','atr14_prior','on_compressed']].rename(columns={'trade_date':'date'})
meta.to_csv(f"{ROOT}/R9-nq-meta.csv",index=False)
print("wrote R9-nq-meta.csv")
print("done")
