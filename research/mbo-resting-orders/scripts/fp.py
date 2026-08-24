import sys, os, numpy as np
path=sys.argv[1]; day=os.path.basename(path)[10:18]
FRONT='NQH6'
MINSZ=10; NEAR=5.0; BARRIER=20.0; CAPSEC=3600
tp=[]; tt=[]; det=[]   # trades(price,ts_ns), detections
last=None
import collections
symct=collections.Counter()
with open(path) as f:
    f.readline()
    for line in f:
        p=line.split(',')
        if len(p)<15: continue
        act=p[5]; sym=p[14].rstrip('\n')
        symct[sym]+=1
        if sym!=FRONT: continue
        if act=='T':
            try: pr=float(p[7])
            except: continue
            tp.append(pr); tt.append(p[1]); last=pr
        elif act=='A' and last is not None:
            try:
                sz=int(p[8]); pr=float(p[7])
            except: continue
            if sz>=MINSZ and abs(pr-last)<=NEAR:
                det.append((len(tp)-1,last,p[6],sz,p[1]))
front=symct.most_common(1)[0][0]
assert front==FRONT, f'front {front} != {FRONT}'
tp=np.array(tp,dtype=np.float64)
tsec=np.array([int(x[11:13])*3600+int(x[14:16])*60+float(x[17:26]) for x in tt])
res=[]
CH=4000
for idx,spot,side,sz,ts in det:
    up=spot+BARRIER; dn=spot-BARRIER
    t0=tsec[idx]; j=idx+1; out=0
    while j<len(tp):
        e=min(j+CH,len(tp))
        seg=tp[j:e]
        hu=np.flatnonzero(seg>=up); hd=np.flatnonzero(seg<=dn)
        iu=hu[0] if len(hu) else 10**9
        id_=hd[0] if len(hd) else 10**9
        if iu<id_: out=1; break
        if id_<iu: out=-1; break
        if tsec[e-1]-t0>CAPSEC or (tsec[e-1]<t0 and tsec[e-1]+86400-t0>CAPSEC): break
        j=e
    res.append((side,sz,out))
import pickle
os.makedirs('/tmp/claude-1000/fp',exist_ok=True)
pickle.dump(res,open(f'/tmp/claude-1000/fp/{day}.pkl','wb'))
n=len(res); u=sum(1 for r in res if r[2]==1); d=sum(1 for r in res if r[2]==-1)
print(f"{day} front={front} trades={len(tp):,} det={n:,} up={u} dn={d} none={n-u-d}")
