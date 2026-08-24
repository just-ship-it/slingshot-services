import numpy as np, glob, os
PV=20.0; COMM=4.0; CAP=3600.0
def load(day):
    l1=np.load(f'/tmp/claude-1000/l1/{day}.npz')['l1']
    e=np.load(f'/tmp/claude-1000/ext/{day}.npz')
    return l1, e['px'], e['ts']
def detect(l1, mode, A, P):
    """L1-only detections. mode='avg' uses size/count, 'sz' uses raw size.
       Requires the condition to hold continuously for P seconds. Returns (ts, dir, spot)."""
    ts=l1[:,0]; bsz=l1[:,2]; bct=np.maximum(l1[:,3],1); asz=l1[:,5]; act=np.maximum(l1[:,6],1); last=l1[:,7]
    bpx=l1[:,1]; apx=l1[:,4]
    mb = (bsz/bct>=A) if mode=='avg' else (bsz>=A)
    ma = (asz/act>=A) if mode=='avg' else (asz>=A)
    out=[]
    for cond,dirn,px in ((mb,1,bpx),(ma,-1,apx)):
        run_start=None; run_px=None
        for i in range(len(ts)):
            if cond[i] and (run_px is None or px[i]==run_px):
                if run_start is None: run_start=ts[i]; run_px=px[i]
                elif ts[i]-run_start>=P:
                    out.append((ts[i],dirn,last[i])); run_start=None; run_px=None
            else:
                run_start=None; run_px=(px[i] if cond[i] else None)
                if cond[i]: run_start=ts[i]
    out.sort()
    return out
def sim(mode,A,P,T,S,lat,slip):
    tr=[]
    for p in sorted(glob.glob('/tmp/claude-1000/l1/*.npz')):
        day=os.path.basename(p)[:8]
        if not os.path.exists(f'/tmp/claude-1000/ext/{day}.npz'): continue
        l1,px,ts=load(day)
        if len(l1)<10: continue
        det=detect(l1,mode,A,P); free=-1.0
        for dts,d,spot in det:
            if dts<free: continue
            i=np.searchsorted(ts,dts+lat)
            if i>=len(px): continue
            ep=px[i]+d*slip; tgt=ep+d*T; stp=ep-d*S
            e=np.searchsorted(ts,ts[i]+CAP); seg=px[i+1:e]
            if len(seg)==0: continue
            if d>0: ht=np.flatnonzero(seg>=tgt); hs=np.flatnonzero(seg<=stp)
            else:   ht=np.flatnonzero(seg<=tgt); hs=np.flatnonzero(seg>=stp)
            it=ht[0] if len(ht) else 10**9; isx=hs[0] if len(hs) else 10**9
            if it<isx: xp=tgt; xi=it
            elif isx<it: xp=seg[isx]-d*slip; xi=isx
            else: xp=seg[-1]-d*slip; xi=len(seg)-1
            tr.append((d*(xp-ep)*PV-COMM,d)); free=ts[i+1+xi]
    return tr
def rep(tag,tr):
    if len(tr)<10: print(f"{tag:>30} n={len(tr)} (too few)"); return None
    a=np.array([t[0] for t in tr]); w=a[a>0]; l=a[a<=0]
    pf=w.sum()/abs(l.sum()) if len(l) and l.sum()!=0 else 9.99
    eq=np.cumsum(a); dd=(np.maximum.accumulate(eq)-eq).max()
    d=np.array([t[1] for t in tr])
    print(f"{tag:>30} n={len(a):>4} WR={100*len(w)/len(a):>5.1f}% PF={pf:>4.2f} net=${a.sum():>+9,.0f} "
          f"maxDD=${dd:>8,.0f} L/S={(d>0).sum()}/{(d<0).sum()}")
    return a.sum()
if __name__=='__main__':
    print("=== L1-ONLY detection (MBP-1 = $199 Standard plan), +/-30 bracket, lat=1s slip=0.25 ===")
    for mode in ('avg','sz'):
        for A in ((5,10,20) if mode=='avg' else (20,40,80)):
            for P in (0.0,1.0,3.0):
                rep(f"{mode}>={A} persist>={P}s",sim(mode,A,P,30,30,1.0,0.25))
