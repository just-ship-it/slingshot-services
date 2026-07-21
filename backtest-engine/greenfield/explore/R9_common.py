#!/usr/bin/env python3
"""R9 common: load midday caches as per-day open/high/low arrays + stats helpers.

Census helpers report the per-DAY mean (each clock-locked window fires once/day,
so pooled == day-weighted here; noted per GREENFIELD honesty rule #8). All returns
are instant-to-instant on bar OPEN in POINTS; ATR-normalized variants divide by the
day's atr14_prior (NQ) or a rolling RTH-range ATR proxy (ES).
"""
import pandas as pd, numpy as np
from collections import defaultdict

ROOT="/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
LO,HI=540,965
NMIN=HI-LO+1

ANCH=dict(o930=570,o1000=600,o1030=630,o1100=660,o1125=685,o1130=690,o1145=705,
          o1200=720,o1230=750,o1300=780,o1330=810,o1400=840,o1430=870,o1500=900,
          o1530=930,o1600=960)

def load(inst):
    """inst in {'nq','es'}. Returns dict: date-> (open,high,low arrays len NMIN),
    and meta dict date->(year,dow,atr)."""
    df=pd.read_csv(f"{ROOT}/R9-{inst}-mid.csv")
    O=defaultdict(lambda: np.full(NMIN,np.nan))
    Hh=defaultdict(lambda: np.full(NMIN,np.nan))
    Ll=defaultdict(lambda: np.full(NMIN,np.nan))
    for d,etm,op,hi,lo in df[['date','etm','open','high','low']].itertuples(index=False):
        i=etm-LO
        if 0<=i<NMIN:
            O[d][i]=op; Hh[d][i]=hi; Ll[d][i]=lo
    O=dict(O); Hh=dict(Hh); Ll=dict(Ll)
    # meta
    meta={}
    if inst=='nq':
        m=pd.read_csv(f"{ROOT}/R9-nq-meta.csv")
        for d,y,dow,atr in m[['date','year','dow','atr14_prior']].itertuples(index=False):
            meta[d]=(int(y),int(dow),float(atr) if pd.notna(atr) else np.nan)
    else:
        # ES: year/dow from date; ATR proxy = 14d rolling mean of RTH(09:30-16:00) high-low
        dates=sorted(O.keys())
        rng={}
        for d in dates:
            hi=Hh[d][570-LO:960-LO]; lo=Ll[d][570-LO:960-LO]
            hi=hi[np.isfinite(hi)]; lo=lo[np.isfinite(lo)]
            rng[d]=(np.nanmax(hi)-np.nanmin(lo)) if len(hi) and len(lo) else np.nan
        rs=pd.Series(rng).sort_index()
        atr=rs.rolling(14,min_periods=7).mean().shift(1)  # prior-day knowable
        for d in dates:
            dt=pd.Timestamp(d)
            meta[d]=(dt.year,dt.dayofweek,float(atr.get(d,np.nan)))
    return O,Hh,Ll,meta

def op(O,d,anchor):
    i=ANCH[anchor]-LO
    v=O[d][i]
    if np.isfinite(v): return v
    # fallback: nearest known within +/-3 min (missing bar)
    for k in range(1,4):
        for j in (i-k,i+k):
            if 0<=j<NMIN and np.isfinite(O[d][j]): return O[d][j]
    return np.nan

def win_hilo(Hh,Ll,d,a0,a1):
    i0,i1=ANCH[a0]-LO,ANCH[a1]-LO
    h=Hh[d][i0:i1]; l=Ll[d][i0:i1]
    h=h[np.isfinite(h)]; l=l[np.isfinite(l)]
    if not len(h) or not len(l): return np.nan,np.nan
    return float(np.nanmax(h)),float(np.nanmin(l))

def tstat(x):
    x=np.asarray([v for v in x if np.isfinite(v)],float)
    n=len(x)
    if n<2: return 0.0,0.0,n
    m=x.mean(); s=x.std(ddof=1)
    return m, (m/(s/np.sqrt(n)) if s>0 else 0.0), n

def summary(vals, label=""):
    """vals: list of signed pt returns (one per day). returns dict."""
    m,t,n=tstat(vals)
    x=np.asarray([v for v in vals if np.isfinite(v)],float)
    wr=float((x>0).mean()) if n else 0.0
    return dict(label=label,n=n,mean=m,t=t,wr=wr,total=float(x.sum()))

def per_year(pairs):
    """pairs: list of (year, value). returns {year: (mean,t,n)}."""
    by=defaultdict(list)
    for y,v in pairs:
        if np.isfinite(v): by[y].append(v)
    out={}
    for y in sorted(by):
        m,t,n=tstat(by[y]); out[y]=(m,t,n)
    return out

def fmt_year(py):
    return "  ".join(f"{y}:{m:+.1f}(t{t:+.1f},n{n})" for y,(m,t,n) in py.items())
