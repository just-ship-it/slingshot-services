import numpy as np, pandas as pd, glob, os, json, datetime as dt
EPOCH_OFF=dt.date(1970,1,1).toordinal()*86400.0
S=pd.read_pickle('/tmp/claude-1000/S.pkl')
S['isdet']=(S.kind=='det').astype(int)
LVc=['level_1','level_2','level_3','level_4','level_5']
# LT series (causal)
L=pd.read_csv('/home/drew/projects/slingshot-services/backtest-engine/data/liquidity/nq/NQ_liquidity_levels.csv')
L['avail']=L.unix_timestamp/1000.0+900.0+EPOCH_OFF
L=L.sort_values('avail').reset_index(drop=True)
L['sent']=np.where(L.sentiment=='BULLISH',1,-1)
L['isflip']=(L.sent!=L.sent.shift()).astype(int)
L['mv1']=L[LVc].diff().abs().sum(axis=1)
spike_thr=L.mv1.quantile(.90)
L['isspike']=(L.mv1>=spike_thr).astype(int)
flip_ts=L.avail[L.isflip==1].values
spike_ts=L.avail[L.isspike==1].values
# T series (5m bars -> knowable at label+5m)
T=pd.read_csv('/home/drew/projects/slingshot-services/research/tv-export/triggers_NQ_mtf.csv')
T['avail']=pd.to_datetime(T.dt,utc=True).astype('int64')/1e9+300.0+EPOCH_OFF
T=T.sort_values('avail')
xup_ts=T.avail[T.x_up==True].values; xdn_ts=T.avail[T.x_dn==True].values
xany_ts=np.sort(np.concatenate([xup_ts,xdn_ts]))
print(f"LT flips={len(flip_ts)} LT spikes(top10%)={len(spike_ts)}  T x_up={len(xup_ts)} x_dn={len(xdn_ts)}")
def since(ev,ts):
    i=np.searchsorted(ev,ts,side='right')-1
    out=np.full(len(ts),np.inf)
    ok=i>=0
    out[ok]=ts[ok]-ev[i[ok]]
    return out
ts=S.ts.values
S['since_ltflip']=since(np.sort(flip_ts),ts)
S['since_ltspike']=since(np.sort(spike_ts),ts)
S['since_Tx']=since(xany_ts,ts)
S['since_Txup']=since(np.sort(xup_ts),ts)
S['since_Txdn']=since(np.sort(xdn_ts),ts)
# price-path crossings per day
cross_lt={}; cross_gf={}; pxspike={}
for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
    day=os.path.basename(p)[:8]; z=np.load(p); px,tsx=z['px'],z['ts']
    cross_lt[day]=(px,tsx)
def path_events(row_ts,row_px,day,levels,win):
    px,tsx=cross_lt[day]
    j=np.searchsorted(tsx,row_ts-win); i=np.searchsorted(tsx,row_ts)
    if i-j<2: return 0
    seg=px[j:i]; lo,hi=seg.min(),seg.max()
    for L_ in levels:
        if np.isfinite(L_) and lo<=L_<=hi: return 1
    return 0
res={}
for win,nm in ((300,'5m'),(900,'15m'),(1800,'30m')):
    v=[]
    for _,r in S.iterrows():
        lv=[r[c] for c in LVc]
        v.append(path_events(r.ts,r.px,r.day,lv,win) if r.day in cross_lt else 0)
    S[f'ltcross_{nm}']=v
v=[]
for _,r in S.iterrows():
    v.append(path_events(r.ts,r.px,r.day,[r.gflip],900) if r.day in cross_lt else 0)
S['gfcross_15m']=v
base=S.isdet.mean()
print(f"\nbaseline detection share = {100*base:.1f}%\n")
print(f"{'event':>34} {'n_with':>7} {'rate':>7} {'lift':>7}")
def show(nm,mask):
    m=mask.astype(bool)
    if m.sum()<80: print(f"{nm:>34} {m.sum():>7} (too few)"); return
    r=S.isdet[m].mean()
    se=np.sqrt(r*(1-r)/m.sum())
    z=(r-base)/se
    fl='  <<<' if abs(z)>3 else ''
    print(f"{nm:>34} {m.sum():>7} {100*r:>6.1f}% {100*(r-base):>+6.1f}pp z={z:>+5.2f}{fl}")
for w,nm in ((900,'15m'),(1800,'30m'),(3600,'60m')):
    show(f"LT sentiment FLIP within {nm}",S.since_ltflip<=w)
    show(f"LT level SPIKE (top10%) within {nm}",S.since_ltspike<=w)
    show(f"T5xTH crossover (any) within {nm}",S.since_Tx<=w)
    show(f"T5xTH cross UP within {nm}",S.since_Txup<=w)
    show(f"T5xTH cross DN within {nm}",S.since_Txdn<=w)
for nm in ('5m','15m','30m'):
    show(f"price crossed an LT level in {nm}",S[f'ltcross_{nm}'])
show("price crossed gamma_flip in 15m",S.gfcross_15m)
S.to_pickle('/tmp/claude-1000/S2.pkl')
