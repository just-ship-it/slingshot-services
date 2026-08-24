import pandas as pd, numpy as np, glob, os
B=['s1','s2_4','s5_9','s10_14','s15_19','s20_49','s50p']
fl=[]
for p in sorted(glob.glob('/tmp/claude-1000/absorb/*.csv')):
    d=pd.read_csv(p); fl.append(d)
F=pd.concat(fl,ignore_index=True)
F['dt']=pd.to_datetime(F.minute,utc=True); F=F.sort_values('dt')
o=pd.read_csv('/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m.csv',
              usecols=['ts_event','open','high','low','close','symbol','volume'])
o=o[o.symbol=='NQH6'].copy()
o['dt']=pd.to_datetime(o.ts_event,utc=True); o=o.sort_values('dt')
m=pd.merge(o[['dt','open','high','low','close','volume']],F.drop(columns=['minute']),on='dt',how='inner')
m['day']=m.dt.dt.strftime('%Y%m%d')
print(f"merged minutes: {len(m):,}  days: {m.day.nunique()}")
# ATR14 on 1m for normalization
tr=np.maximum(m.high-m.low,np.maximum((m.high-m.close.shift()).abs(),(m.low-m.close.shift()).abs()))
m['atr']=tr.ewm(alpha=1/14,adjust=False).mean()
W,H=15,30
m['ret_prior']=(m.close-m.close.shift(W))/m.atr
m['fwd']=(m.close.shift(-H)-m.close)/m.atr
# day-boundary safety: null out rows whose window crosses days
m.loc[m.day!=m.day.shift(W),'ret_prior']=np.nan
m.loc[m.day!=m.day.shift(-H),'fwd']=np.nan
print(f"\n{'bucket':>8} {'n':>6} {'corr(imb,fwd)':>14} {'partial|prior':>14} {'corr(imb,prior)':>16}")
res={}
for b in B:
    bv=m[b+'_bvol'].rolling(W).sum(); av=m[b+'_avol'].rolling(W).sum()
    tot=bv+av
    m['imb']=np.where(tot>0,(bv-av)/tot,np.nan)
    s=m.dropna(subset=['imb','fwd','ret_prior']).iloc[::H]      # stride for independence
    if len(s)<50: print(f"{b:>8} {len(s):>6}  (too few)"); continue
    c=np.corrcoef(s.imb,s.fwd)[0,1]
    cp=np.corrcoef(s.imb,s.ret_prior)[0,1]
    # partial corr of imb with fwd controlling ret_prior
    rx=s.imb-np.poly1d(np.polyfit(s.ret_prior,s.imb,1))(s.ret_prior)
    ry=s.fwd -np.poly1d(np.polyfit(s.ret_prior,s.fwd ,1))(s.ret_prior)
    pc=np.corrcoef(rx,ry)[0,1]
    res[b]=(len(s),c,pc,cp)
    print(f"{b:>8} {len(s):>6} {c:>+14.4f} {pc:>+14.4f} {cp:>+16.4f}")
import pickle; pickle.dump(res,open('/tmp/claude-1000/res1.pkl','wb'))
