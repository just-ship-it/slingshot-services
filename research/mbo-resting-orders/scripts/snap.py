import numpy as np, pandas as pd, glob, os, json, datetime as dt
EPOCH_OFF=dt.date(1970,1,1).toordinal()*86400.0
rng=np.random.default_rng(17)
# ---- LT (causal: 15m bar labelled T knowable at T+15m) ----
L=pd.read_csv('/home/drew/projects/slingshot-services/backtest-engine/data/liquidity/nq/NQ_liquidity_levels.csv')
L['avail']=L.unix_timestamp/1000.0+900.0+EPOCH_OFF
L=L.sort_values('avail').reset_index(drop=True)
LV=['level_1','level_2','level_3','level_4','level_5']
L['sent']=np.where(L.sentiment=='BULLISH',1,-1)
L['flip']=(L.sent!=L.sent.shift()).astype(int)
L['since_flip']=L.avail-L.avail.where(L.flip==1).ffill()
L['mv1']=L[LV].diff().abs().sum(axis=1)
L['mv4']=L[LV].diff(4).abs().sum(axis=1)
L['spread']=L[LV].max(axis=1)-L[LV].min(axis=1)
L['spread_chg']=L['spread'].diff(4)
# ---- GEX (causal) ----
gr=[]
for f in sorted(glob.glob('/home/drew/projects/slingshot-services/backtest-engine/data/gex/nq/*2026-01*')
               +glob.glob('/home/drew/projects/slingshot-services/backtest-engine/data/gex/nq/*2025-12*')):
    for s in json.load(open(f))['data']:
        try: ts=pd.to_datetime(s['timestamp'],utc=True)
        except: continue
        gr.append(dict(avail=ts.timestamp()+900.0+EPOCH_OFF,gflip=s.get('gamma_flip'),
                       gtot=s.get('total_gex'),gimb=s.get('gamma_imbalance'),
                       gvex=s.get('total_vex'),gcex=s.get('total_cex')))
G=pd.DataFrame(gr).sort_values('avail').reset_index(drop=True)
def price_feats(px,ts,i):
    def back(sec):
        j=np.searchsorted(ts,ts[i]-sec)
        return max(j,0)
    j1,j5,j15,j30=back(60),back(300),back(900),back(1800)
    seg15=px[j15:i+1]; seg5=px[j5:i+1]; seg30=px[j30:i+1]
    rng30=seg30.max()-seg30.min()
    atr=np.mean(np.abs(np.diff(seg15))) if len(seg15)>2 else np.nan
    return dict(ret1=px[i]-px[j1],ret5=px[i]-px[j5],ret15=px[i]-px[j15],ret30=px[i]-px[j30],
                rng5=seg5.max()-seg5.min(),rng15=seg15.max()-seg15.min(),rng30=rng30,
                ntr1=i-j1,ntr5=i-j5,ntr15=i-j15,
                pos30=(px[i]-seg30.min())/rng30 if rng30>0 else .5,
                tickvol=atr,
                accel=(i-j1)/max((i-j5)/5.0,1e-9))     # 1m trade rate vs 5m avg
rows=[]
for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
    z=np.load(p); px,ts,det=z['px'],z['ts'],z['det']
    if len(px)<2000: continue
    day=os.path.basename(p)[:8]
    ev=[(dts,dirn,int(idx)) for dts,spot,opx,dirn,sz,idx in det if 3.0<=abs(opx-spot)<=5.0]
    # controls: random instants on the SAME day
    ctrl=rng.choice(np.arange(2000,len(px)-100),size=min(len(ev)*2,len(px)-2200),replace=False)
    for kind,items in (('det',[(e[0],e[2],e[1]) for e in ev]),
                       ('ctl',[(ts[i],i,0) for i in ctrl])):
        for tstamp,i,dirn in items:
            if i<2000 or i>=len(px)-10: continue
            f=price_feats(px,ts,i); f['kind']=kind; f['dir']=dirn; f['ts']=tstamp; f['day']=day; f['px']=px[i]
            rows.append(f)
S=pd.DataFrame(rows).sort_values('ts').reset_index(drop=True)
S=pd.merge_asof(S,L[['avail','sent','since_flip','mv1','mv4','spread','spread_chg']+LV],
                left_on='ts',right_on='avail',direction='backward')
S=pd.merge_asof(S.sort_values('ts'),G,left_on='ts',right_on='avail',direction='backward',suffixes=('','_g'))
lv=S[LV].values
S['lt_dist']=np.nanmin(np.abs(lv-S.px.values[:,None]),axis=1)
S['lt_above']=(S.px.values>np.nanmedian(lv,axis=1)).astype(float)
S['gflip_dist']=(S.px-S.gflip).abs()
S['et_hour']=pd.to_datetime((S.ts-EPOCH_OFF),unit='s',utc=True).dt.tz_convert('America/New_York').dt.hour
S.to_pickle('/tmp/claude-1000/S.pkl')
print(f"snapshots: {(S.kind=='det').sum():,} detections vs {(S.kind=='ctl').sum():,} same-day controls")
FE=['ret1','ret5','ret15','ret30','rng5','rng15','rng30','ntr1','ntr5','ntr15','pos30','tickvol','accel',
    'since_flip','mv1','mv4','spread','spread_chg','lt_dist','gtot','gimb','gvex','gcex','gflip_dist','et_hour']
d=S[S.kind=='det']; c=S[S.kind=='ctl']
out=[]
for f in FE:
    a=pd.to_numeric(d[f],errors='coerce'); b=pd.to_numeric(c[f],errors='coerce')
    a=a[np.isfinite(a)]; b=b[np.isfinite(b)]
    if len(a)<100 or len(b)<100: continue
    sd=np.sqrt((a.var()+b.var())/2)
    if sd==0: continue
    out.append((f,a.mean(),b.mean(),(a.mean()-b.mean())/sd))
out.sort(key=lambda x:-abs(x[3]))
print(f"\n{'feature':>12} {'detection':>12} {'control':>12} {'std diff':>9}")
for f,m1,m2,g in out:
    star='  <<<' if abs(g)>0.2 else ''
    print(f"{f:>12} {m1:>12.3f} {m2:>12.3f} {g:>+9.3f}{star}")
