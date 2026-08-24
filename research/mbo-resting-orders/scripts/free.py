"""Can we get the edge with NO book data? Two variants:
 A) same 3-5pt detection TIMES but direction from momentum (needs MBO for timing only)
 B) pure momentum on a fixed schedule (needs NOTHING but price)"""
import numpy as np, glob, os
PV=20.0; COMM=4.0; CAP=3600.0
def walk(px,ts,i,d,T,S,slip):
    ep=px[i]+d*slip; tgt=ep+d*T; stp=ep-d*S
    e=np.searchsorted(ts,ts[i]+CAP); seg=px[i+1:e]
    if len(seg)==0: return None
    if d>0: ht=np.flatnonzero(seg>=tgt); hs=np.flatnonzero(seg<=stp)
    else:   ht=np.flatnonzero(seg<=tgt); hs=np.flatnonzero(seg>=stp)
    it=ht[0] if len(ht) else 10**9; isx=hs[0] if len(hs) else 10**9
    if it<isx: xp=tgt; xi=it
    elif isx<it: xp=seg[isx]-d*slip; xi=isx
    else: xp=seg[-1]-d*slip; xi=len(seg)-1
    return d*(xp-ep)*PV-COMM, ts[i+1+xi], d
def variantA(T,S,lat,slip,mode):
    tr=[]
    for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
        z=np.load(p); px,ts,det=z['px'],z['ts'],z['det']
        if len(det)==0: continue
        free=-1.0
        for dts,spot,opx,dirn,sz,idx in det:
            dd=abs(opx-spot)
            if dts<free or dd<3.0 or dd>5.0: continue
            i=np.searchsorted(ts,dts+lat)
            if i>=len(px) or i<600: continue
            if mode=='book': d=int(dirn)
            elif mode=='mom': d=1 if px[i]-px[i-60]>0 else -1
            elif mode=='book_and_mom':
                m=1 if px[i]-px[i-60]>0 else -1
                if m!=int(dirn): continue
                d=int(dirn)
            elif mode=='book_not_mom':
                m=1 if px[i]-px[i-60]>0 else -1
                if m==int(dirn): continue
                d=int(dirn)
            r=walk(px,ts,i,d,T,S,slip)
            if r: tr.append((r[0],r[2])); free=r[1]
    return tr
def variantB(T,S,slip,every):
    tr=[]
    for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
        z=np.load(p); px,ts=z['px'],z['ts']
        if len(px)<1000: continue
        free=-1.0; t=ts[600]
        while t<ts[-1]:
            i=np.searchsorted(ts,t)
            if i>=len(px)-1 or i<600: break
            if t>=free:
                d=1 if px[i]-px[i-60]>0 else -1
                r=walk(px,ts,i,d,T,S,slip)
                if r: tr.append((r[0],r[2])); free=r[1]
            t+=every
    return tr
def rep(tag,tr):
    if len(tr)<25: print(f"{tag:>32} n={len(tr)} (too few)"); return
    a=np.array([t[0] for t in tr]); w=a[a>0]; l=a[a<=0]
    pf=w.sum()/abs(l.sum()) if len(l) and l.sum()!=0 else 9.99
    eq=np.cumsum(a); dd=(np.maximum.accumulate(eq)-eq).max(); d=np.array([t[1] for t in tr])
    print(f"{tag:>32} n={len(a):>4} WR={100*len(w)/len(a):>5.1f}% PF={pf:>4.2f} net=${a.sum():>+9,.0f} maxDD=${dd:>7,.0f} L/S={(d>0).sum()}/{(d<0).sum()}")
print("=== A) 3-5pt detection TIMES, different direction sources (lat=1s slip=0.25) ===")
for m in ('book','mom','book_and_mom','book_not_mom'):
    rep(f"dir={m}", variantA(30,30,1.0,.25,m))
print("\n=== B) NO book data at all: pure momentum on a timer ===")
for ev in (300,600,1200):
    rep(f"pure momentum every {ev}s", variantB(30,30,.25,ev))
