import pandas as pd, numpy as np, glob, os, warnings
warnings.filterwarnings('ignore')
B=['s1','s2_4','s5_9','s10_14','s15_19','s20_49','s50p']
F=pd.concat([pd.read_csv(p) for p in sorted(glob.glob('/tmp/claude-1000/absorb/*.csv'))],ignore_index=True)
F['dt']=pd.to_datetime(F.minute,utc=True)
o=pd.read_csv('/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m.csv',
              usecols=['ts_event','open','high','low','close','symbol'])
o=o[o.symbol=='NQH6'].copy(); o['dt']=pd.to_datetime(o.ts_event,utc=True)
m=pd.merge(o[['dt','open','high','low','close']],F.drop(columns=['minute']),on='dt',how='inner').sort_values('dt').reset_index(drop=True)
m['day']=m.dt.dt.strftime('%Y%m%d')
tr=np.maximum(m.high-m.low,np.maximum((m.high-m.close.shift()).abs(),(m.low-m.close.shift()).abs()))
m['atr']=tr.ewm(alpha=1/14,adjust=False).mean()
W=15
rng=np.random.default_rng(7)
print(f"{'bucket':>8} {'H':>4} {'n':>5} {'topDec':>8} {'botDec':>8} {'spread':>8} {'t':>6} {'null p95':>9}")
for b in B:
    bv=m[b+'_bvol'].rolling(W).sum(); av=m[b+'_avol'].rolling(W).sum(); tot=bv+av
    m['imb']=np.where(tot>=20,(bv-av)/tot,np.nan)   # require real flow
    m.loc[m.day!=m.day.shift(W),'imb']=np.nan
    for H in (5,10,30,60):
        m['fwd']=(m.close.shift(-H)-m.close)/m.atr
        m.loc[m.day!=m.day.shift(-H),'fwd']=np.nan
        s=m.dropna(subset=['imb','fwd']).iloc[::H]
        if len(s)<120: continue
        hi=s.imb.quantile(.9); lo=s.imb.quantile(.1)
        t_=s[s.imb>=hi].fwd; b_=s[s.imb<=lo].fwd
        if len(t_)<20 or len(b_)<20: continue
        sp=t_.mean()-b_.mean()
        se=np.sqrt(t_.var()/len(t_)+b_.var()/len(b_)); tt=sp/se if se>0 else 0
        # matched null: shuffle imb within day (preserves fwd autocorr + day mix)
        nulls=[]
        for _ in range(200):
            sh=s.copy(); sh['imb']=sh.groupby('day').imb.transform(lambda x: rng.permutation(x.values))
            h2=sh.imb.quantile(.9); l2=sh.imb.quantile(.1)
            nulls.append(sh[sh.imb>=h2].fwd.mean()-sh[sh.imb<=l2].fwd.mean())
        p95=np.nanpercentile(np.abs(nulls),95)
        flag='  <<<' if abs(sp)>p95 else ''
        print(f"{b:>8} {H:>4} {len(s):>5} {t_.mean():>+8.3f} {b_.mean():>+8.3f} {sp:>+8.3f} {tt:>+6.2f} {p95:>9.3f}{flag}")
