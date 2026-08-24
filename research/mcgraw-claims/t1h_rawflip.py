"""Re-test the 'price vs gamma flip' proxy using RAW contract prices (GEX levels are raw)."""
import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd
DATA='/home/drew/projects/slingshot-services/backtest-engine/data/'
def raw_bars(sym):
    f=f'{DATA}ohlcv/{sym}/{sym.upper()}_ohlcv_1m.csv'
    d=pd.read_csv(f,usecols=['ts_event','open','high','low','close','volume','symbol'])
    d=d[~d.symbol.str.contains('-',na=False)]                 # drop calendar spreads
    d['dt']=pd.to_datetime(d.ts_event,utc=True).dt.tz_convert('America/New_York')
    d['day']=d.dt.dt.date; d['m']=d.dt.dt.hour*60+d.dt.dt.minute
    d['hr']=d.dt.dt.floor('h')
    # filterPrimaryContract: highest-volume contract per hour
    top=d.groupby(['hr','symbol']).volume.sum().reset_index()
    top=top.sort_values('volume').groupby('hr').tail(1)[['hr','symbol']]
    top.columns=['hr','primary']
    d=d.merge(top,on='hr'); d=d[d.symbol==d.primary]
    return d.sort_values('dt')
COST={'es':16.50,'nq':9.00}; PV={'es':50.0,'nq':20.0}
for prod in ('nq','es'):
    rb=raw_bars(prod); g=lib.gex(prod)
    S=lib.sessions(rb,{'o':570,'m1530':930,'m1545':945}); G=lib.daily_gex_sign(g,929)
    M=S.merge(G,on='day',how='inner').dropna(subset=['tot','flip']).sort_values('day').reset_index(drop=True)
    M['pos']=(M.tot>0).astype(int); M['r_day']=100*(M.m1530/M.o-1)
    M['dow']=pd.to_datetime(M.day).dt.dayofweek
    M['above']=(M.m1530>M.flip).astype(int)
    gap=(M.m1530-M.spot).abs()
    print(f"\n{'='*88}\n{prod.upper()}  RAW price space, n={len(M)}")
    print(f"  sanity: |raw 15:30 price - GEX snapshot spot| median {gap.median():.1f} pt, p90 {gap.quantile(.9):.1f} pt")
    print(f"  (large values => still a price-space mismatch)")
    print(f"  price>flip agreement with sign(total_gex): {100*(M.above==M.pos).mean():.1f}%")
    span=(pd.to_datetime(M.day.max())-pd.to_datetime(M.day.min())).days/365.25
    big=M[(M.r_day.abs()>=M.r_day.abs().quantile(.5))&(M.dow!=0)].copy()
    pv=PV[prod]; c=COST[prod]
    for nm,sg in (('TRUE gex sign',big.pos),('proxy: raw price > flip',big.above)):
        dirn=np.where(sg>0,-np.sign(big.r_day),np.sign(big.r_day))
        lib.rep(nm,(dirn*(big.m1545-big.m1530)*pv-c).values,pv,len(big),years=span)
