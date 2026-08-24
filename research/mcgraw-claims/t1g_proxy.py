"""Can FREE data (TV pipeline: VIX/VIX9D/VVIX/realized vol/price-vs-flip) substitute for
the ONE BIT the strategy needs -- sign(total_gex)? If yes, the Schwab dependency vanishes."""
import sys; sys.path.insert(0,'.')
import lib, numpy as np, pandas as pd
DATA='/home/drew/projects/slingshot-services/backtest-engine/data/'
def vs(f,n):
    x=pd.read_csv(DATA+'macro/'+f); c=[k for k in x.columns if k.lower() in ('datetime','date','time','ts_event')][0]
    v=[k for k in x.columns if k.lower()=='close'][0]
    x=x[[c,v]].copy(); x.columns=['day',n]; x['day']=pd.to_datetime(x.day,utc=True,errors='coerce').dt.date
    return x.dropna()
vix=vs('vix_1d.csv','vix'); v9=vs('vix9d_1d.csv','vix9d'); vv=vs('vvix_1d.csv','vvix'); v3=vs('vix3m_1d.csv','vix3m')
COST={'es':16.50,'nq':9.00}; PV={'es':50.0,'nq':20.0}
for prod in ('nq','es'):
    d=lib.bars(prod); g=lib.gex(prod)
    S=lib.sessions(d,{'o':570,'m1530':930,'m1545':945}); G=lib.daily_gex_sign(g,929)
    M=S.merge(G,on='day',how='inner').dropna(subset=['tot'])
    M=M.merge(vix,on='day').merge(v9,on='day').merge(vv,on='day').merge(v3,on='day').sort_values('day').reset_index(drop=True)
    M['pos']=(M.tot>0).astype(int)
    M['r_day']=100*(M.m1530/M.o-1); M['dow']=pd.to_datetime(M.day).dt.dayofweek
    # causal features (prior close / intraday-known)
    M['ts']=M.vix9d/M.vix; M['ts3']=M.vix/M.vix3m; M['vvr']=M.vvix/M.vix
    M['rv']=(M.hi-M.lo)/M.o*100
    M['above_flip']=(M.m1530>M.flip).astype(int)
    print(f"\n{'='*88}\n{prod.upper()}  predicting sign(total_gex) from FREE data  (n={len(M)}, base rate {100*M.pos.mean():.1f}% positive)\n{'='*88}")
    for nm,pred in (('VIX < 20',(M.vix<20).astype(int)),
                    ('VIX < 18',(M.vix<18).astype(int)),
                    ('VIX9D/VIX < 1.0',(M.ts<1.0).astype(int)),
                    ('VIX/VIX3M < 1.0 (contango)',(M.ts3<1.0).astype(int)),
                    ('VVIX/VIX < 5.5',(M.vvr<5.5).astype(int)),
                    ('day range < 1.0%',(M.rv<1.0).astype(int)),
                    ('price ABOVE gamma flip',M.above_flip)):
        acc=(pred==M.pos).mean()
        print(f"  {nm:<28} agreement with true sign: {100*acc:>5.1f}%")
    # best free proxy traded end-to-end
    span=(pd.to_datetime(M.day.max())-pd.to_datetime(M.day.min())).days/365.25
    big=M[(M.r_day.abs()>=M.r_day.abs().quantile(.5))&(M.dow!=0)].copy()
    pv=PV[prod]; c=COST[prod]
    print()
    for nm,sg in (('TRUE gex sign',big.pos),
                  ('proxy: VIX<20',(big.vix<20).astype(int)),
                  ('proxy: price>flip',big.above_flip),
                  ('proxy: VIX/VIX3M<1',(big.ts3<1.0).astype(int))):
        dirn=np.where(sg>0,-np.sign(big.r_day),np.sign(big.r_day))
        p=dirn*(big.m1545-big.m1530)*pv-c
        lib.rep(nm,p.values,pv,len(big),years=span)
