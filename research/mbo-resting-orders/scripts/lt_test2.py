import numpy as np, pandas as pd, glob, os, datetime as dt
EPOCH_OFF=dt.date(1970,1,1).toordinal()*86400.0
PV=20.0; COMM=4.0; CAP=3600.0
L=pd.read_csv('/home/drew/projects/slingshot-services/backtest-engine/data/liquidity/nq/NQ_liquidity_levels.csv')
L['avail']=L.unix_timestamp/1000.0+900.0+EPOCH_OFF
L=L.sort_values('avail').reset_index(drop=True)
L['sent']=np.where(L.sentiment=='BULLISH',1,-1)
L['lvlmove']=L[['level_1','level_2','level_3','level_4','level_5']].diff().abs().sum(axis=1)
# --- per-15min-window: detection count, LT lvlmove, and REALIZED RANGE (volatility control) ---
recs=[]
for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
    z=np.load(p); px,ts,det=z['px'],z['ts'],z['det']
    if len(px)<100: continue
    dts=np.array([r[0] for r in det]) if len(det) else np.array([])
    dd =np.array([abs(r[2]-r[1]) for r in det]) if len(det) else np.array([])
    band=dts[(dd>=3.0)&(dd<=5.0)] if len(det) else np.array([])
    lo,hi=ts[0],ts[-1]
    sub=L[(L.avail>=lo)&(L.avail<=hi)]
    for _,r in sub.iterrows():
        a=r.avail; b=a+900
        i0=np.searchsorted(ts,a); i1=np.searchsorted(ts,b)
        if i1-i0<10: continue
        seg=px[i0:i1]
        recs.append(dict(avail=a,lvlmove=r.lvlmove,sent=r.sent,
                         rng=seg.max()-seg.min(),ntrade=i1-i0,
                         ndet=int(((band>=a)&(band<b)).sum())))
W=pd.DataFrame(recs).dropna()
print(f"15-min windows: {len(W)}   mean detections/window={W.ndet.mean():.2f}")
print(f"\ncorr(lvlmove, ndet)  = {W.lvlmove.corr(W.ndet):+.3f}")
print(f"corr(range,   ndet)  = {W.rng.corr(W.ndet):+.3f}   <-- pure volatility")
print(f"corr(ntrades, ndet)  = {W.ntrade.corr(W.ndet):+.3f}   <-- pure activity")
print(f"corr(lvlmove, range) = {W.lvlmove.corr(W.rng):+.3f}   <-- LT level move IS volatility?")
# partial: does lvlmove add anything beyond range+ntrade?
import numpy.linalg as la
X=np.column_stack([np.ones(len(W)),W.rng,W.ntrade])
beta=la.lstsq(X,W.ndet,rcond=None)[0]; res_n=W.ndet-X@beta
b2=la.lstsq(X,W.lvlmove,rcond=None)[0]; res_l=W.lvlmove-X@b2
pc=np.corrcoef(res_l,res_n)[0,1]
print(f"\nPARTIAL corr(lvlmove, ndet | range, ntrades) = {pc:+.3f}   <-- the honest number")
# --- bottom line: LT-only strategy PnL ---
print("\n=== LT-ONLY strategies (free data), +/-30 bracket, lat=1s slip=0.25 ===")
def sim(rule,thr=None):
    tr=[]
    for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
        z=np.load(p); px,ts=z['px'],z['ts']
        if len(px)<100: continue
        sub=L[(L.avail>=ts[0])&(L.avail<=ts[-1])]
        free=-1.0
        for _,r in sub.iterrows():
            if r.avail<free: continue
            if rule=='sent': d=int(r.sent)
            elif rule=='sent_bigmove':
                if r.lvlmove<thr: continue
                d=int(r.sent)
            elif rule=='flip':
                d=int(r.sent)
            i=np.searchsorted(ts,r.avail+1.0)
            if i>=len(px) or i<10: continue
            ep=px[i]+d*.25; tgt=ep+d*30; stp=ep-d*30
            e=np.searchsorted(ts,ts[i]+CAP); seg=px[i+1:e]
            if len(seg)==0: continue
            if d>0: ht=np.flatnonzero(seg>=tgt); hs=np.flatnonzero(seg<=stp)
            else:   ht=np.flatnonzero(seg<=tgt); hs=np.flatnonzero(seg>=stp)
            it=ht[0] if len(ht) else 10**9; isx=hs[0] if len(hs) else 10**9
            if it<isx: xp=tgt; xi=it
            elif isx<it: xp=seg[isx]-d*.25; xi=isx
            else: xp=seg[-1]-d*.25; xi=len(seg)-1
            tr.append(d*(xp-ep)*PV-COMM); free=ts[i+1+xi]
    return np.array(tr)
for tag,rule,thr in (('LT sentiment','sent',None),
                     ('LT sent + top-25% lvlmove','sent_bigmove',L.lvlmove.quantile(.75)),
                     ('LT sent + top-10% lvlmove','sent_bigmove',L.lvlmove.quantile(.90))):
    a=sim(rule,thr)
    if len(a)<25: print(f"{tag:>28} n={len(a)} (too few)"); continue
    w=a[a>0]; l=a[a<=0]; pf=w.sum()/abs(l.sum()) if len(l) and l.sum()!=0 else 9.99
    print(f"{tag:>28} n={len(a):>4} WR={100*len(w)/len(a):>5.1f}% PF={pf:>4.2f} net=${a.sum():>+9,.0f}")
