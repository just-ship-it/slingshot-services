import numpy as np, pandas as pd, glob, os, datetime as dt
EPOCH_OFF = dt.date(1970,1,1).toordinal()*86400.0     # our abs base = ordinal*86400 + tod
PV=20.0; COMM=4.0; CAP=3600.0
# ---- detections (3-5pt band) ----
rows=[]
for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
    z=np.load(p); px,ts,det=z['px'],z['ts'],z['det']
    if len(det)==0: continue
    for dts,spot,opx,dirn,sz,idx in det:
        dd=abs(opx-spot)
        if dd<3.0 or dd>5.0: continue
        rows.append((dts,dirn,spot,int(idx),os.path.basename(p)[:8]))
D=pd.DataFrame(rows,columns=['ts','dir','spot','idx','day']).sort_values('ts').reset_index(drop=True)
print(f"MBO 3-5pt detections: {len(D)}  ({(D.dir>0).sum()} long / {(D.dir<0).sum()} short)")
# ---- LT, CAUSAL: a 15m bar labelled T is knowable at T+15m ----
L=pd.read_csv('/home/drew/projects/slingshot-services/backtest-engine/data/liquidity/nq/NQ_liquidity_levels.csv')
L['avail']=L.unix_timestamp/1000.0 + 900.0 + EPOCH_OFF
L=L.sort_values('avail')
L['sent']=np.where(L.sentiment=='BULLISH',1,-1)
L['flip']=(L.sent!=L.sent.shift()).astype(int)
L['lvlmove']=L[['level_1','level_2','level_3','level_4','level_5']].diff().abs().sum(axis=1)
L['since_flip']=L.avail-L.avail.where(L.flip==1).ffill()
M=pd.merge_asof(D,L[['avail','sent','flip','lvlmove','since_flip','level_1','level_2','level_3','level_4','level_5']],
                left_on='ts',right_on='avail',direction='backward')
M=M.dropna(subset=['sent'])
print(f"joined (causal, avail<=detection_ts): {len(M)}   median staleness={np.median(M.ts-M.avail)/60:.1f}min (expect 0-15)")
print("\n--- A) does LT sentiment agree with the MBO detection direction? ---")
ag=(M.sent==M['dir']).mean()
print(f"  agreement: {100*ag:.1f}%   (50% = no information)")
n=len(M); se=np.sqrt(.25/n); print(f"  z vs 50%: {(ag-0.5)/se:+.2f}")
print("\n--- B) does a recent LT sentiment FLIP coincide with detections? ---")
for w in (900,1800,3600):
    fr=(M.since_flip<=w).mean()
    base=(L.since_flip<=w).mean()
    print(f"  within {w//60:>2}min of a flip: detections {100*fr:>5.1f}%  vs LT baseline {100*base:>5.1f}%  lift={100*(fr-base):+.1f}pp")
print("\n--- C) distance from spot to nearest LT level at detection ---")
lv=M[['level_1','level_2','level_3','level_4','level_5']].values
dist=np.abs(lv-M.spot.values[:,None]).min(axis=1)
print(f"  median={np.median(dist):.1f}pt  p25={np.percentile(dist,25):.1f}  p75={np.percentile(dist,75):.1f}")
sgn=np.sign(M.spot.values-lv[np.arange(len(lv)),np.abs(lv-M.spot.values[:,None]).argmin(axis=1)])
print(f"  spot ABOVE nearest level: {100*(sgn>0).mean():.1f}%   agreement of (above->long) with dir: {100*((sgn>0)==(M['dir']>0)).mean():.1f}%")
print("\n--- D) does LT level MOVEMENT (liquidity shift) mark detections? ---")
for q in (.5,.75,.9):
    thr=L.lvlmove.quantile(q)
    fr=(M.lvlmove>=thr).mean()
    print(f"  detections in top {100*(1-q):>2.0f}% of LT level-move: {100*fr:>5.1f}%  (chance {100*(1-q):>4.1f}%)  lift={100*(fr-(1-q)):+.1f}pp")
M.to_pickle('/tmp/claude-1000/M.pkl')
