"""1s-HONEST validation of the LETF x gamma close sleeve.
Entry: first 1s bar at/after 15:30:00 ET, fill at that bar's OPEN + adverse slippage.
Exit : first 1s bar at/after 15:45:00 ET, fill at that bar's OPEN - adverse slippage.
Uses the byte-offset minute index to seek instead of streaming the whole file."""
import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd, json, datetime as dt
OH='/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/'
CFG={'nq':dict(f=OH+'nq/NQ_ohlcv_1s_continuous.csv',ix=OH+'nq/NQ_ohlcv_1s_continuous.index.json',pv=20.0,comm=4.0,tick=0.25),
     'es':dict(f=OH+'es/ES_ohlcv_1s_continuous.csv',ix=OH+'es/ES_ohlcv_1s_continuous.index.json',pv=50.0,comm=4.0,tick=0.25)}
def load_1s_window(cfg, days, start_et, end_et):
    """Return {day: DataFrame(ts,open)} for the ET window, seeking via the index."""
    ix=json.load(open(cfg['ix']))['minutes']
    keys={int(k):v for k,v in ix.items()}
    out={}
    fh=open(cfg['f'],'rb')
    for day in days:
        rows=[]
        base=pd.Timestamp(day).tz_localize('America/New_York')
        for mm in range(start_et, end_et+1):
            t=(base+pd.Timedelta(minutes=mm)).tz_convert('UTC')
            k=int(t.timestamp()*1000)
            e=keys.get(k)
            if not e: continue
            fh.seek(e['offset']); buf=fh.read(e['length']).decode('utf-8','ignore')
            for line in buf.split('\n'):
                if not line: continue
                p=line.split(',')
                if len(p)<8: continue
                try:
                    ts=p[0].replace(' ','T')          # NQ uses space, ES uses 'T'
                    rows.append((ts, float(p[1])))    # p[1] = OPEN (was wrongly using close)
                except: pass
        if rows: out[day]=rows
    fh.close(); return out
for prod in ('nq','es'):
    cfg=CFG[prod]; pv=cfg['pv']
    d=lib.bars(prod); g=lib.gex(prod)
    S=lib.sessions(d,{'o':570,'m1530':930,'m1545':945}); G=lib.daily_gex_sign(g,929)
    M=S.merge(G,on='day',how='inner').dropna(subset=['tot']).sort_values('day').reset_index(drop=True)
    M['r_day']=100*(M.m1530/M.o-1); M['gpos']=M.tot>0
    M['dow']=pd.to_datetime(M.day).dt.dayofweek
    big=M[(M.r_day.abs()>=M.r_day.abs().quantile(.5))&(M.dow!=0)].copy()
    big['dirn']=np.where(big.gpos,-np.sign(big.r_day),np.sign(big.r_day))
    days=list(big.day)
    print(f"\n{prod.upper()}: seeking 1s bars for {len(days)} sessions ...",flush=True)
    W=load_1s_window(cfg,days,929,947)
    span=(pd.to_datetime(big.day.max())-pd.to_datetime(big.day.min())).days/365.25
    for slip_ticks in (0.0,1.0,2.0):
        slip=slip_ticks*cfg['tick']; pnl=[]; miss=0
        for _,r in big.iterrows():
            rows=W.get(r.day)
            if not rows: miss+=1; continue
            base=pd.Timestamp(r.day).tz_localize('America/New_York')
            t_in =(base+pd.Timedelta(minutes=930)).tz_convert('UTC').strftime('%Y-%m-%dT%H:%M:%S')
            t_out=(base+pd.Timedelta(minutes=945)).tz_convert('UTC').strftime('%Y-%m-%dT%H:%M:%S')
            ein=next((px for ts,px in rows if ts>=t_in),None)
            eout=next((px for ts,px in rows if ts>=t_out),None)
            if ein is None or eout is None:
                pass
            if ein is None or eout is None: miss+=1; continue
            dirn=r.dirn
            fill_in = ein + dirn*slip
            fill_out= eout - dirn*slip
            pnl.append(dirn*(fill_out-fill_in)*pv - cfg['comm'])
        lib.rep(f'1s-honest, {slip_ticks:.0f} tick slip/side',pnl,pv,len(pnl),years=span)
    print(f"    (sessions with no 1s data: {miss})")
