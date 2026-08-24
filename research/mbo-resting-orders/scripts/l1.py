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
DT=0.25
sym=collections.Counter()
with open(path) as fh:
    fh.readline()
    for i,line in enumerate(fh):
        if i>2_000_000: break
        p=line.rstrip('\n').split(',')
        if len(p)>=20: sym[p[19]]+=1
front=sym.most_common(1)[0][0]
out=[]; last=None; prev=None; off=0.0; nxt=None
with open(path) as fh:
    fh.readline()
    for line in fh:
        p=line.rstrip('\n').split(',')
        if len(p)<20 or p[19]!=front: continue
        t=p[1]
        try: ts=_abs(t)
        except: continue
        if p[5]=='T':
            try: last=float(p[8])
            except: pass
        if last is None: continue
        if nxt is None: nxt=ts
        if ts>=nxt:
            try:
                out.append((ts,float(p[13]),int(p[15]),int(p[17]),
                               float(p[14]),int(p[16]),int(p[18]),last))
            except: pass
            nxt=ts+DT
a=np.array(out,dtype=np.float64)
os.makedirs('/tmp/claude-1000/l1',exist_ok=True)
np.savez_compressed(f'/tmp/claude-1000/l1/{day}.npz',l1=a)
if len(a):
    ab=a[:,2]/np.maximum(a[:,3],1); aa=a[:,5]/np.maximum(a[:,6],1)
    print(f"{day} front={front} n={len(a):,} avgBidSz p99={np.percentile(ab,99):.1f} frac>=5: {100*(ab>=5).mean():.2f}%")
