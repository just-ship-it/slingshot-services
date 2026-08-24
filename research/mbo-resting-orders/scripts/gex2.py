import json,glob,numpy as np,pandas as pd,datetime as dt
EPOCH_OFF=dt.date(1970,1,1).toordinal()*86400.0
fs=sorted(glob.glob('/home/drew/projects/slingshot-services/backtest-engine/data/gex/nq/*2026-01*')
         +glob.glob('/home/drew/projects/slingshot-services/backtest-engine/data/gex/nq/*2025-12*'))
rows=[]
for f in fs:
    for s in json.load(open(f))['data']:
        try: ts=pd.to_datetime(s['timestamp'],utc=True)
        except: continue
        rows.append(dict(avail=ts.timestamp()+900.0+EPOCH_OFF,nq=s.get('nq_spot'),
            flip=s.get('gamma_flip'),gimb=s.get('gamma_imbalance'),tot=s.get('total_gex'),
            sup=s.get('support'),res=s.get('resistance'),regime=s.get('regime')))
G=pd.DataFrame(rows).sort_values('avail')
print(f"snapshots={len(G)} nq_spot non-null={G.nq.notna().sum()} flip={G.flip.notna().sum()} gimb={G.gimb.notna().sum()}")
print(f"regime values: {G.regime.value_counts().to_dict()}")
rr=[]
for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
    for dts,spot,opx,dirn,sz,idx in np.load(p)['det']:
        if 3.0<=abs(opx-spot)<=5.0: rr.append((dts,dirn,spot))
D=pd.DataFrame(rr,columns=['ts','dir','px']).sort_values('ts')
M=pd.merge_asof(D,G,left_on='ts',right_on='avail',direction='backward')
print(f"joined={len(M)}\n=== agreement with MBO detection direction (50% = no info) ===")
def ag(name,pred,mask=None):
    m=pred.notna() if mask is None else (pred.notna()&mask)
    if m.sum()<100: print(f"  {name:<38} (n={m.sum()} too few)"); return
    a=(pred[m]==M['dir'][m]).mean()
    z=(a-.5)/np.sqrt(.25/m.sum())
    print(f"  {name:<38} {100*a:>5.1f}%   n={m.sum():>4}  z={z:+.2f}")
ag("above gamma_flip -> long",  np.where(M.px>M.flip,1,-1)*pd.Series(M.flip.notna()).map({True:1,False:np.nan}))
ag("above gamma_flip -> short", np.where(M.px>M.flip,-1,1)*pd.Series(M.flip.notna()).map({True:1,False:np.nan}))
ag("gamma_imbalance>0 -> long", np.where(M.gimb>0,1,-1)*pd.Series(M.gimb.notna()).map({True:1,False:np.nan}))
ag("total_gex>0 -> long",       np.where(M.tot>0,1,-1)*pd.Series(M.tot.notna()).map({True:1,False:np.nan}))
ag("nearer support -> long",    np.where((M.px-M.sup).abs()<(M.px-M.res).abs(),1,-1)*pd.Series((M.sup.notna()&M.res.notna())).map({True:1,False:np.nan}))
