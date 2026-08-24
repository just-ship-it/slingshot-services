import json,glob,os,numpy as np,pandas as pd,datetime as dt
EPOCH_OFF=dt.date(1970,1,1).toordinal()*86400.0
fs=sorted(glob.glob('/home/drew/projects/slingshot-services/backtest-engine/data/gex/nq/*2026-01*')
         +glob.glob('/home/drew/projects/slingshot-services/backtest-engine/data/gex/nq/*2025-12*'))
j=json.load(open(fs[0])); d=j['data']
print("data type:",type(d).__name__, "len",len(d))
s0=d[0] if isinstance(d,list) else list(d.values())[0]
print("snapshot keys:",list(s0.keys())[:20])
rows=[]
for f in fs:
    j=json.load(open(f)); dd=j['data']
    it=dd if isinstance(dd,list) else list(dd.values())
    for s in it:
        t=s.get('timestamp') or s.get('time') or s.get('ts')
        if t is None: continue
        try: ts=pd.to_datetime(t,utc=True)
        except: continue
        rows.append(dict(avail=ts.timestamp()+900.0+EPOCH_OFF,
                         spot=s.get('spot') or s.get('underlying_price'),
                         flip=s.get('gamma_flip') or s.get('flip_point') or s.get('zero_gamma'),
                         net=s.get('net_gex') or s.get('total_gex') or s.get('net_gamma')))
G=pd.DataFrame(rows).dropna(subset=['avail']).sort_values('avail')
print(f"\nGEX snapshots: {len(G)}  non-null flip={G.flip.notna().sum()} net={G.net.notna().sum()} spot={G.spot.notna().sum()}")
# detections
rr=[]
for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
    z=np.load(p); det=z['det']
    for dts,spot,opx,dirn,sz,idx in det:
        if 3.0<=abs(opx-spot)<=5.0: rr.append((dts,dirn,spot))
D=pd.DataFrame(rr,columns=['ts','dir','px']).sort_values('ts')
M=pd.merge_asof(D,G,left_on='ts',right_on='avail',direction='backward').dropna(subset=['avail'])
print(f"joined: {len(M)}  median staleness={np.median(M.ts-M.avail)/60:.1f}min")
print("\n=== agreement with MBO detection direction (50% = no info) ===")
if M.net.notna().sum()>100:
    a=((M.net>0).astype(int)*2-1 == M['dir']).mean(); print(f"  GEX regime (net>0 -> long):        {100*a:>5.1f}%")
if M.flip.notna().sum()>100 and M.spot.notna().sum()>100:
    above=(M.px>M.flip)
    a=((above.astype(int)*2-1)==M['dir']).mean(); print(f"  above gamma flip -> long:          {100*a:>5.1f}%")
    a2=((above.astype(int)*-2+1)==M['dir']).mean(); print(f"  above gamma flip -> short:         {100*a2:>5.1f}%")
print("\n  (reference: LT sentiment 48.8%, LT level-position 46.6%, price momentum 59.3%)")
print("  (calibration: momentum at 59.3% agreement still yields only PF 1.01 when traded)")
