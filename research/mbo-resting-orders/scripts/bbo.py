import sys, os, numpy as np, collections
path=sys.argv[1]; day=os.path.basename(path)[10:18]
FRONT='NQH6'
orders={}                      # oid -> [side, tick, size]
bid=collections.defaultdict(int); ask=collections.defaultdict(int)
out=[]; last=None; prev=None; off=0.0
def best(bk,hi):
    if not bk: return None,0
    t=max(bk) if hi else min(bk)
    return t,bk[t]
with open(path) as f:
    f.readline()
    for line in f:
        p=line.split(',')
        if len(p)<15: continue
        if p[14].rstrip('\n')!=FRONT: continue
        act=p[5]; sd=p[6]
        try:
            px=float(p[7]); sz=int(p[8]); oid=p[10]
        except: continue
        t=p[1]; s=int(t[11:13])*3600+int(t[14:16])*60+float(t[17:26])
        if prev is not None and s<prev-1000: off+=86400.0
        prev=s; ts=s+off
        if act=='T':
            last=px; continue
        if act=='R':
            orders.clear(); bid.clear(); ask.clear(); continue
        tk=int(round(px*4))
        bk = bid if sd=='B' else (ask if sd=='A' else None)
        if bk is None: continue
        if act=='A':
            orders[oid]=[sd,tk,sz]; bk[tk]+=sz
        elif act in ('C','F'):
            o=orders.get(oid)
            if o:
                bk2 = bid if o[0]=='B' else ask
                bk2[o[1]]-=sz
                if bk2[o[1]]<=0: bk2.pop(o[1],None)
                o[2]-=sz
                if o[2]<=0: orders.pop(oid,None)
        elif act=='M':
            o=orders.get(oid)
            if o:
                bk2 = bid if o[0]=='B' else ask
                bk2[o[1]]-=o[2]
                if bk2[o[1]]<=0: bk2.pop(o[1],None)
            orders[oid]=[sd,tk,sz]; bk[tk]+=sz
        if last is None: continue
        bt,bs=best(bid,True); at,as_=best(ask,False)
        if bt is None or at is None: continue
        out.append((ts,bt/4.0,bs,at/4.0,as_,last))
a=np.array(out,dtype=np.float64)
os.makedirs('/tmp/claude-1000/bbo',exist_ok=True)
np.savez_compressed(f'/tmp/claude-1000/bbo/{day}.npz',bbo=a)
print(f"{day} bbo_updates={len(a):,} medBidSz={np.median(a[:,2]):.0f} medAskSz={np.median(a[:,4]):.0f} p95={np.percentile(a[:,2],95):.0f}")
