import sys, os, numpy as np, collections
import datetime as _dt
_DC={}
def _abs(t):
    d=t[:10]
    o=_DC.get(d)
    if o is None:
        o=_dt.date.fromisoformat(d).toordinal(); _DC[d]=o
    return o*86400.0+int(t[11:13])*3600+int(t[14:16])*60+float(t[17:26])

path=sys.argv[1]; day=os.path.basename(path)[10:18]
FRONT='NQH6'; MINSZ=10; NEAR=5.0
tp=[]; tsec=[]; det=[]; last=None; sc=collections.Counter(); prev=None; off=0.0
with open(path) as f:
    f.readline()
    for line in f:
        p=line.split(',')
        if len(p)<15: continue
        act=p[5]; sym=p[14].rstrip('\n'); sc[sym]+=1
        if sym!=FRONT: continue
        if act=='T':
            try: pr=float(p[7])
            except: continue
            tp.append(pr); tsec.append(_abs(p[1])); last=pr
        elif act=='A' and last is not None:
            try: sz=int(p[8]); pr=float(p[7])
            except: continue
            if sz>=MINSZ and abs(pr-last)<=NEAR:
                det.append((_abs(p[1]),last,pr,1.0 if p[6]=='B' else -1.0,float(sz),float(len(tp)-1)))
assert sc.most_common(1)[0][0]==FRONT
os.makedirs('/tmp/claude-1000/ext',exist_ok=True)
np.savez_compressed(f'/tmp/claude-1000/ext/{day}.npz',
    px=np.array(tp),ts=np.array(tsec),det=np.array(det,dtype=np.float64))
print(f"{day} trades={len(tp):,} det={len(det):,}")
