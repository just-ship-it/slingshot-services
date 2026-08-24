import pandas as pd, numpy as np, glob, warnings
warnings.filterwarnings('ignore')
F=pd.concat([pd.read_csv(p) for p in sorted(glob.glob('/tmp/claude-1000/absorb/*.csv'))],ignore_index=True)
F['dt']=pd.to_datetime(F.minute,utc=True)
o=pd.read_csv('/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m.csv',
              usecols=['ts_event','open','high','low','close','symbol'])
o=o[o.symbol=='NQH6'].copy(); o['dt']=pd.to_datetime(o.ts_event,utc=True)
m=pd.merge(o[['dt','open','high','low','close']],F.drop(columns=['minute']),on='dt',how='inner').sort_values('dt').reset_index(drop=True)
m['day']=m.dt.dt.strftime('%Y%m%d')
m['et']=m.dt.dt.tz_convert('America/New_York')
tr=np.maximum(m.high-m.low,np.maximum((m.high-m.close.shift()).abs(),(m.low-m.close.shift()).abs()))
m['atr']=tr.ewm(alpha=1/14,adjust=False).mean()
# round-number touch: any multiple of 50 inside the bar
def touched(lo,hi):
    return np.floor(hi/50)>=np.ceil(lo/50)
m['touch']=touched(m.low.values,m.high.values)
m['lvl']=np.ceil(m.low/50)*50
m['approach']=np.sign(m.close.shift(1)-m.lvl)      # +1 = coming down from above, -1 = up from below
W=10
for b in ['s5_9','s10_14','s20_49']:
    bv=m[b+'_bvol'].rolling(W).sum(); av=m[b+'_avol'].rolling(W).sum(); tot=bv+av
    m[b+'_imb']=np.where(tot>=20,(bv-av)/tot,np.nan)
    m.loc[m.day!=m.day.shift(W),b+'_imb']=np.nan
hrs=(m.et.dt.hour>=10)&(m.et.dt.hour<12)
print(f"round-50 touches total={m.touch.sum():,}  in 10-12 ET={(m.touch&hrs).sum():,}")
rng=np.random.default_rng(11)
for H in (10,30):
    m['fwd']=(m.close.shift(-H)-m.close)/m.atr
    m.loc[m.day!=m.day.shift(-H),'fwd']=np.nan
    for lbl,msk in (('all-hours',m.touch),('10-12 ET',m.touch&hrs)):
        for b in ['s5_9','s10_14','s20_49']:
            for ap,apn in ((1,'from above'),(-1,'from below')):
                s=m[msk&(m.approach==ap)].dropna(subset=[b+'_imb','fwd'])
                s=s.iloc[::max(1,H//5)]
                if len(s)<60: continue
                hi=s[b+'_imb'].quantile(.75); lo=s[b+'_imb'].quantile(.25)
                t_=s[s[b+'_imb']>=hi].fwd; b_=s[s[b+'_imb']<=lo].fwd
                if len(t_)<15 or len(b_)<15: continue
                sp=t_.mean()-b_.mean()
                se=np.sqrt(t_.var()/len(t_)+b_.var()/len(b_)); tt=sp/se if se>0 else 0
                nl=[]
                for _ in range(300):
                    sh=s.copy(); sh[b+'_imb']=rng.permutation(sh[b+'_imb'].values)
                    h2=sh[b+'_imb'].quantile(.75); l2=sh[b+'_imb'].quantile(.25)
                    nl.append(sh[sh[b+'_imb']>=h2].fwd.mean()-sh[sh[b+'_imb']<=l2].fwd.mean())
                p95=np.nanpercentile(np.abs(nl),95)
                fl='  <<<' if abs(sp)>p95 else ''
                print(f"H={H:<3}{lbl:>10} {b:>8} {apn:>11} n={len(s):>4} spread={sp:>+7.3f} t={tt:>+5.2f} null95={p95:>6.3f}{fl}")
