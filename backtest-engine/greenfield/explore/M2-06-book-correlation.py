#!/usr/bin/env python3
"""
M2-06: build DAILY PnL for the surviving gold/oil edge candidates, then correlate each
to the equity book (2021-2026) -- the 'real AND uncorrelated' prize test.
Also reports full-history stats, per-year, per-regime, micro-sizing viability.
Futures PnL is stamped on the futures label date then shifted +1 business day to the
true session (equity/book) calendar before correlating.
"""
import pandas as pd, numpy as np
import M2_lib as L

EXPL="/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
MACRO="/home/drew/projects/slingshot-services/backtest-engine/data/macro"

def daily_pnl_from_trades(df, trades, sym):
    """Distribute each trade's PnL across its holding days (close-to-close MTM),
    first day = close-open, entry+exit cost charged on entry day. Returns Series by df date ($)."""
    pv=L.SPEC[sym]["pt_value"]; cost=L.SPEC[sym]["cost_pts"]
    o=df["open"].values; c=df["close"].values
    date_to_i={d:i for i,d in enumerate(df["date"])}
    pnl=np.zeros(len(df))
    for _,t in trades.iterrows():
        ei=date_to_i[t["entry_date"]]; xi=date_to_i[t["exit_date"]]; d=t["dir"]
        for k in range(ei,xi+1):
            ref = o[k] if k==ei else c[k-1]
            pnl[k]+= d*(c[k]-ref)*pv
        pnl[ei]-= cost*pv   # round-trip cost on entry day
    s=pd.Series(pnl,index=df["date"])
    return s

def to_session(series):
    """Shift futures label date +1 business day (roll backward first) to session calendar."""
    d=series.index.values.astype("datetime64[D]")
    d=np.busday_offset(d,1,roll="backward")
    return pd.Series(series.values,index=pd.to_datetime(d)).groupby(level=0).sum()

# ---- candidate builders ----
def cand_gc_donchian():
    df=L.load("gc")
    chan,hold=100,42
    hh=df["high"].rolling(chan).max().shift(1); ll=df["low"].rolling(chan).min().shift(1)
    up=df["close"]>hh; dn=df["close"]<ll
    dirs=np.where(up,1,np.where(dn,-1,0)); sig=up|dn
    tr=L.simulate(df,sig,dirs,hold,"gc",min_gap=1)
    return "GC-Donchian100-h42","gc",df,tr

def cand_cl_shortfade():
    df=L.load("cl")
    N,zt,hold=5,1.5,5
    r=df["close"].pct_change(N); mu=r.rolling(252).mean().shift(1); sd=r.rolling(252).std().shift(1); z=(r-mu)/sd
    mask=(z>=zt).fillna(False)
    tr=L.simulate(df,mask,-1,hold,"cl",min_gap=1)
    return "CL-shortfade-z1.5-h5","cl",df,tr

def cand_gc_longfade():
    df=L.load("gc")
    N,zt,hold=5,2.0,5
    r=df["close"].pct_change(N); mu=r.rolling(252).mean().shift(1); sd=r.rolling(252).std().shift(1); z=(r-mu)/sd
    mask=(z<=-zt).fillna(False)
    tr=L.simulate(df,mask,1,hold,"gc",min_gap=1)
    return "GC-longfade-z2-h5","gc",df,tr

def cand_cl_tsmom():
    df=L.load("cl")
    R,hold=42,5
    trail=df["close"]/df["close"].shift(R)-1
    dirs=np.sign(trail.fillna(0)).values; mask=~trail.isna()
    tr=L.simulate(df,mask,dirs,hold,"cl",min_gap=1)
    return "CL-TSMOM42-h5","cl",df,tr

def cand_cl_donch63():
    df=L.load("cl")
    chan,hold=100,63
    hh=df["high"].rolling(chan).max().shift(1); ll=df["low"].rolling(chan).min().shift(1)
    up=df["close"]>hh; dn=df["close"]<ll
    dirs=np.where(up,1,np.where(dn,-1,0)); sig=up|dn
    tr=L.simulate(df,sig,dirs,hold,"cl",min_gap=1)
    return "CL-Donchian100-h63","cl",df,tr

book=pd.read_csv(f"{EXPL}/M2-book.csv",parse_dates=["date"]).set_index("date")

print(f"{'candidate':24} {'n':>4} {'WR%':>5} {'mean$':>7} {'PF':>4} {'t':>5} {'yrs+':>6} | corr_to_book(combined,pcc,mon,gap)")
rows=[]
for builder in [cand_gc_donchian,cand_cl_shortfade,cand_gc_longfade,cand_cl_tsmom,cand_cl_donch63]:
    name,sym,df,tr=builder()
    s=L.stats(tr,sym)
    yrs=L.per_year(tr,sym); yp=sum(1 for y,ss in yrs if ss.get('mean_usd',0)>0)
    dpnl=daily_pnl_from_trades(df,tr,sym)
    sess=to_session(dpnl)  # session-calendar daily PnL ($)
    # correlate over book window, zero-filled on equity calendar
    win=sess[(sess.index>=book.index.min())&(sess.index<=book.index.max())]
    corrs=[]
    for col in ["pnl_combined","pnl_pcc","pnl_monday","pnl_gapfade"]:
        b=book[col]
        j=pd.concat([win.rename("c"),b.rename("b")],axis=1)
        # restrict to book-window equity calendar; zero-fill commodity PnL on non-trade days
        j=j[(j.index>=book.index.min())&(j.index<=book.index.max())]
        j["c"]=j["c"].fillna(0.0); j=j.dropna(subset=["b"])
        corrs.append(j["c"].corr(j["b"]) if len(j)>20 else np.nan)
    print(f"{name:24} {s['n']:>4} {s['wr']*100:>5.1f} {s['mean_usd']:>7.0f} {s['pf']:>4.2f} {s['sharpe']:>5.2f} {yp:>2}/{len(yrs):<2} | "
          + " ".join(f"{c:+.3f}" for c in corrs))
    # regime line
    reg=" ".join(f"{nm.split()[0]}:PF{ss.get('pf',0):.2f}" for nm,ss in L.per_regime(tr,sym))
    print(f"    regimes: {reg}")
    rows.append((name,sym,s,yp,len(yrs),corrs,tr,sess))

# Book-window PnL contribution of each candidate (2021-2026), on micro 1-lot
print("\n-- candidate PnL WITHIN book window 2021-01..2026-07 (1 micro lot) --")
for name,sym,s,yp,ny,corrs,tr,sess in rows:
    w=sess[(sess.index>=book.index.min())&(sess.index<=book.index.max())]
    tw=tr[(tr.sig_date>=book.index.min())&(tr.sig_date<=book.index.max())]
    sw=L.stats(tw,sym)
    print(f"  {name:24}: trades={sw.get('n',0):>3} tot=${w.sum():>8.0f} mean/tr=${sw.get('mean_usd',0):>6.0f} PF={sw.get('pf',0):.2f} corr_combined={corrs[0]:+.3f}")
