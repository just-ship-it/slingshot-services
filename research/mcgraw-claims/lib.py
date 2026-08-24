import pandas as pd, numpy as np, json, glob, os
DATA='/home/drew/projects/slingshot-services/backtest-engine/data/'
def bars(sym):
    f=f'{DATA}ohlcv/{sym}/{sym.upper()}_ohlcv_1m_continuous.csv'
    d=pd.read_csv(f,usecols=['ts_event','open','high','low','close','volume'])
    d['dt']=pd.to_datetime(d.ts_event,utc=True).dt.tz_convert('America/New_York')
    d['day']=d.dt.dt.date; d['m']=d.dt.dt.hour*60+d.dt.dt.minute
    return d.sort_values('dt')
def gex(prod):
    rows=[]
    for f in sorted(glob.glob(f'{DATA}gex/{prod}/*.json')):
        try: j=json.load(open(f))
        except: continue
        for s in j.get('data',[]):
            try: ts=pd.to_datetime(s['timestamp'],utc=True)
            except: continue
            rows.append(dict(ts=ts.tz_convert('America/New_York'),
                             tot=s.get('total_gex'),flip=s.get('gamma_flip'),
                             spot=s.get('nq_spot') or s.get('es_spot'),
                             gimb=s.get('gamma_imbalance'),regime=s.get('regime')))
    g=pd.DataFrame(rows).dropna(subset=['ts']).sort_values('ts')
    g['day']=g.ts.dt.date; g['m']=g.ts.dt.hour*60+g.ts.dt.minute
    return g
def sessions(d, marks):
    """marks: dict name->minute-of-day. Returns per-day close at each mark + OHLC stats."""
    out=[]
    for day,g in d.groupby('day'):
        g=g.sort_values('m'); r={'day':day}
        ok=True
        for k,mm in marks.items():
            s=g[g.m<=mm]
            if len(s)==0: ok=False; break
            r[k]=s.close.iloc[-1]
        if not ok: continue
        rth=g[(g.m>=570)&(g.m<=960)]
        if len(rth)<200: continue
        r['hi']=rth.high.max(); r['lo']=rth.low.min(); r['vol']=rth.volume.sum()
        out.append(r)
    return pd.DataFrame(out)
def daily_gex_sign(g, cutoff_m=929):
    """last causal GEX snapshot at or before cutoff, per day"""
    s=g[g.m<=cutoff_m].sort_values(['day','m']).groupby('day').tail(1)
    return s[['day','tot','flip','spot','gimb','regime']].copy()
def rep(tag,pnl,pv,n_days,years=None):
    """years = CALENDAR span. Passing n_days/252 is only valid for an every-day strategy."""
    a=np.asarray(pnl,dtype=float)
    if len(a)<20: print(f"  {tag:<38} n={len(a)} (too few)"); return None
    w=a[a>0]; l=a[a<=0]
    pf=w.sum()/abs(l.sum()) if len(l) and l.sum()!=0 else 9.99
    eq=np.cumsum(a); dd=(np.maximum.accumulate(eq)-eq).max()
    yrs=years if years else n_days/252
    print(f"  {tag:<38} n={len(a):>4} WR={100*len(w)/len(a):>5.1f}% PF={pf:>4.2f} "
          f"net=${a.sum():>+10,.0f} ${a.sum()/max(yrs,.01):>+9,.0f}/yr maxDD=${dd:>8,.0f}")
    return dict(n=len(a),pf=pf,net=a.sum(),dd=dd)
