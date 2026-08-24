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
W,H,b=10,30,'s10_14'
bv=m[b+'_bvol'].rolling(W).sum(); av=m[b+'_avol'].rolling(W).sum(); tot=bv+av
m['imb']=np.where(tot>=20,(bv-av)/tot,np.nan)
m.loc[m.day!=m.day.shift(W),'imb']=np.nan
m['prior']=(m.close-m.close.shift(W))/m.atr
m.loc[m.day!=m.day.shift(W),'prior']=np.nan
m['fwd']=(m.close.shift(-H)-m.close)/m.atr
m.loc[m.day!=m.day.shift(-H),'fwd']=np.nan
m['touch']=np.floor(m.high/50)>=np.ceil(m.low/50)
m['lvl']=np.ceil(m.low/50)*50
m['approach']=np.sign(m.close.shift(1)-m.lvl)
s=m[m.touch&(m.approach==1)].dropna(subset=['imb','fwd','prior']).iloc[::6]
print(f"the flagged cell: n={len(s)}")
hi=s.imb.quantile(.75); lo=s.imb.quantile(.25)
t_=s[s.imb>=hi]; b_=s[s.imb<=lo]
print(f"  raw spread            {t_.fwd.mean()-b_.fwd.mean():+.3f}")
print(f"  prior ret in each grp  top={t_.prior.mean():+.3f}  bot={b_.prior.mean():+.3f}   <-- if these differ, it's momentum")
# residualize fwd on prior, then re-test
cf=np.polyfit(s.prior,s.fwd,1); s['fwd_r']=s.fwd-np.poly1d(cf)(s.prior)
t2=s[s.imb>=hi].fwd_r; b2=s[s.imb<=lo].fwd_r
sp2=t2.mean()-b2.mean(); se2=np.sqrt(t2.var()/len(t2)+b2.var()/len(b2))
print(f"\n  AFTER controlling prior return: spread={sp2:+.3f}  t={sp2/se2:+.2f}")
print(f"  corr(imb, prior) = {np.corrcoef(s.imb,s.prior)[0,1]:+.3f}")
# does prior return alone produce the same effect (no book data at all)?
ph=s.prior.quantile(.75); pl=s.prior.quantile(.25)
print(f"\n  prior-return-only spread (NO book data): {s[s.prior<=pl].fwd.mean()-s[s.prior>=ph].fwd.mean():+.3f}")
