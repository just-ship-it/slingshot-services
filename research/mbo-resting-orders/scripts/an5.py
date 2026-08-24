import pandas as pd, numpy as np, glob, warnings
warnings.filterwarnings('ignore')
F=pd.concat([pd.read_csv(p) for p in sorted(glob.glob('/tmp/claude-1000/absorb/*.csv'))],ignore_index=True)
F['dt']=pd.to_datetime(F.minute,utc=True)
o=pd.read_csv('/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m.csv',
              usecols=['ts_event','open','high','low','close','symbol'])
o=o[o.symbol=='NQH6'].copy(); o['dt']=pd.to_datetime(o.ts_event,utc=True)
m=pd.merge(o[['dt','open','high','low','close']],F.drop(columns=['minute']),on='dt',how='inner').sort_values('dt').reset_index(drop=True)
m['day']=m.dt.dt.strftime('%Y%m%d')
tr=np.maximum(m.high-m.low,np.maximum((m.high-m.close.shift()).abs(),(m.low-m.close.shift()).abs()))
m['atr']=tr.ewm(alpha=1/14,adjust=False).mean()
m['touch']=np.floor(m.high/50)>=np.ceil(m.low/50)
m['lvl']=np.ceil(m.low/50)*50
m['approach']=np.sign(m.close.shift(1)-m.lvl)
rows=[]
for b in ('s5_9','s10_14','s20_49'):
    for W in (5,10,20):
        bv=m[b+'_bvol'].rolling(W).sum(); av=m[b+'_avol'].rolling(W).sum(); tot=bv+av
        m['imb']=np.where(tot>=20,(bv-av)/tot,np.nan)
        m.loc[m.day!=m.day.shift(W),'imb']=np.nan
        m['prior']=(m.close-m.close.shift(W))/m.atr
        for H in (15,30,45):
            m['fwd']=(m.close.shift(-H)-m.close)/m.atr
            m.loc[m.day!=m.day.shift(-H),'fwd']=np.nan
            for lv,lvn in ((m.touch,'round50'),(pd.Series(True,index=m.index),'no-level')):
                for ap,apn in ((1,'above'),(-1,'below')):
                    s=m[lv&(m.approach==ap)].dropna(subset=['imb','fwd','prior']).iloc[::6]
                    if len(s)<80: continue
                    hi=s.imb.quantile(.75); lo=s.imb.quantile(.25)
                    cf=np.polyfit(s.prior,s.fwd,1); s['fr']=s.fwd-np.poly1d(cf)(s.prior)
                    t_=s[s.imb>=hi].fr; b_=s[s.imb<=lo].fr
                    if len(t_)<20 or len(b_)<20: continue
                    sp=t_.mean()-b_.mean(); se=np.sqrt(t_.var()/len(t_)+b_.var()/len(b_))
                    rows.append(dict(b=b,W=W,H=H,lvl=lvn,ap=apn,n=len(s),sp=sp,t=sp/se if se>0 else 0))
R=pd.DataFrame(rows)
print(f"robustness grid: {len(R)} cells (prior-return controlled, all trading hours)\n")
print(f"  negative spread: {(R.sp<0).sum()}/{len(R)} ({100*(R.sp<0).mean():.0f}%)   mean t={R.t.mean():+.2f}   |t|>2: {(R.t.abs()>2).sum()}")
print("\nby bucket:"); print(R.groupby('b').agg(cells=('t','size'),negfrac=('sp',lambda x:(x<0).mean()),meant=('t','mean')).round(2).to_string())
print("\nby level condition:"); print(R.groupby('lvl').agg(cells=('t','size'),negfrac=('sp',lambda x:(x<0).mean()),meant=('t','mean')).round(2).to_string())
print("\nstrongest cells:"); print(R.reindex(R.t.abs().sort_values(ascending=False).index).head(8).round(3).to_string(index=False))
