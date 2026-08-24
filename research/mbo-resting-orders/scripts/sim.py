import numpy as np, glob, os, sys
PV=20.0; COMM=4.0; CAP=3600.0
def run(T,S,lat,slip,side_filter=None,minsz=10):
    tr=[]
    for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
        z=np.load(p); px,ts,det=z['px'],z['ts'],z['det']
        if len(det)==0: continue
        free=-1.0
        for k in range(len(det)):
            dts,spot,opx,dirn,sz,idx=det[k]
            if dts<free or sz<minsz: continue
            if side_filter is not None and dirn!=side_filter: continue
            d=int(dirn)
            i=np.searchsorted(ts,dts+lat)
            if i>=len(px): continue
            ep=px[i]+d*slip                      # market entry, adverse
            tgt=ep+d*T; stp=ep-d*S
            e=np.searchsorted(ts,ts[i]+CAP)
            seg=px[i+1:e]
            if len(seg)==0: continue
            if d>0:
                ht=np.flatnonzero(seg>=tgt); hs=np.flatnonzero(seg<=stp)
            else:
                ht=np.flatnonzero(seg<=tgt); hs=np.flatnonzero(seg>=stp)
            it=ht[0] if len(ht) else 10**9; isx=hs[0] if len(hs) else 10**9
            if it<isx:  xp=tgt; xi=it; why='tgt'
            elif isx<it: xp=seg[isx]-d*slip; xi=isx; why='stp'
            else:       xp=seg[-1]-d*slip; xi=len(seg)-1; why='cap'
            pnl=d*(xp-ep)*PV-COMM
            tr.append((pnl,why,ts[i+1+xi]-ts[i],d))
            free=ts[i+1+xi]
    return tr
def rep(tag,tr):
    if len(tr)<10: print(f"{tag:>26} n={len(tr)} (too few)"); return
    a=np.array([t[0] for t in tr]); w=a[a>0]; l=a[a<=0]
    pf=w.sum()/abs(l.sum()) if len(l) and l.sum()!=0 else np.inf
    eq=np.cumsum(a); dd=(np.maximum.accumulate(eq)-eq).max()
    sh=a.mean()/a.std()*np.sqrt(252*len(tr)/27) if a.std()>0 else 0
    print(f"{tag:>26} n={len(tr):>4} WR={100*len(w)/len(a):>5.1f}% PF={pf:>5.2f} "
          f"net=${a.sum():>9,.0f} avg=${a.mean():>7.2f} maxDD=${dd:>8,.0f} Sh={sh:>5.2f} "
          f"medHold={np.median([t[2] for t in tr])/60:>5.1f}m")
print("=== symmetric +/-20, sweep latency & slippage (both sides traded) ===")
for lat in (0.0,0.25,1.0):
    for slip in (0.0,0.25,0.5):
        rep(f"lat={lat}s slip={slip}pt",run(20,20,lat,slip))
print("\n=== +/-20, lat=0.25s slip=0.25pt, split by side ===")
rep("LONG only (bid detect)",run(20,20,.25,.25,side_filter=1.0))
rep("SHORT only (ask detect)",run(20,20,.25,.25,side_filter=-1.0))
print("\n=== barrier sweep, lat=0.25s slip=0.25pt, both sides ===")
for B in (5,10,15,20,30):
    rep(f"+/-{B}",run(B,B,.25,.25))

print("\n=== fine latency sweep, +/-20, slip=0.25pt ===")
for lat in (0.0,0.02,0.05,0.10,0.15,0.20,0.30,0.50):
    rep(f"lat={lat*1000:>5.0f}ms",run(20,20,lat,.25))
print("\n=== the one positive cell (+/-30) under scrutiny ===")
rep("+/-30 both sides",run(30,30,.25,.25))
rep("+/-30 LONG only",run(30,30,.25,.25,side_filter=1.0))
rep("+/-30 SHORT only",run(30,30,.25,.25,side_filter=-1.0))
# placebo: same entry times/prices, RANDOM direction -> isolates signal from drift+geometry
import numpy as _np
def runrand(T,S,lat,slip,seed):
    rg=_np.random.default_rng(seed); tr=[]
    for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
        z=np.load(p); px,ts,det=z['px'],z['ts'],z['det']
        if len(det)==0: continue
        free=-1.0
        for k in range(len(det)):
            dts,spot,opx,dirn,sz,idx=det[k]
            if dts<free: continue
            d=1 if rg.random()<0.5 else -1
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
            tr.append((d*(xp-ep)*PV-COMM,'',ts[i+1+xi]-ts[i],d)); free=ts[i+1+xi]
    return tr
print("\n  random-direction placebo at the SAME entry instants:")
nets=[]
for s in range(8):
    t=runrand(30,30,.25,.25,s); a=np.array([x[0] for x in t]); nets.append(a.sum())
    print(f"    seed {s}: n={len(t):>4} net=${a.sum():>9,.0f}")
print(f"  placebo net: mean=${np.mean(nets):,.0f}  sd=${np.std(nets):,.0f}  range=${min(nets):,.0f}..${max(nets):,.0f}")

print("\n=== is +/-30 stable? (a real edge degrades smoothly; noise flips) ===")
for lat in (0.0,0.05,0.1,0.25,0.5,1.0):
    for slip in (0.0,0.25,0.5):
        t=run(30,30,lat,slip); a=np.array([x[0] for x in t])
        w=a[a>0]; l=a[a<=0]; pf=w.sum()/abs(l.sum()) if len(l) and l.sum()!=0 else 9.99
        print(f"    lat={lat:>4}s slip={slip:>4}pt  n={len(t):>4}  PF={pf:>4.2f}  net=${a.sum():>9,.0f}")

print("\n=== DIRECTION TEST: true vs flipped vs random, +/-30 ===")
def runflip(T,S,lat,slip):
    tr=[]
    for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
        z=np.load(p); px,ts,det=z['px'],z['ts'],z['det']
        if len(det)==0: continue
        free=-1.0
        for k in range(len(det)):
            dts,spot,opx,dirn,sz,idx=det[k]
            if dts<free: continue
            d=-int(dirn)                     # FLIPPED
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
            tr.append((d*(xp-ep)*PV-COMM,'',ts[i+1+xi]-ts[i],d)); free=ts[i+1+xi]
    return tr
for lat,slip in ((0.0,0.25),(0.25,0.25),(1.0,0.25)):
    tt=run(30,30,lat,slip); tf=runflip(30,30,lat,slip)
    at=np.array([x[0] for x in tt]); af=np.array([x[0] for x in tf])
    ns=[np.array([x[0] for x in runrand(30,30,lat,slip,s)]).sum() for s in range(10)]
    print(f"\n  lat={lat}s slip={slip}pt")
    print(f"    TRUE     n={len(at):>4} net=${at.sum():>+9,.0f}")
    print(f"    FLIPPED  n={len(af):>4} net=${af.sum():>+9,.0f}   <-- if also positive, direction is NOT the source")
    print(f"    RANDOM   mean=${np.mean(ns):>+9,.0f} sd=${np.std(ns):,.0f}")
    print(f"    TRUE is {(at.sum()-np.mean(ns))/np.std(ns):+.2f} sd above random")

print("\n=== DRIFT CONTROL: is the edge just net-short exposure in a down month? ===")
for lat,slip in ((0.25,0.25),(1.0,0.25)):
    t=run(30,30,lat,slip)
    a=np.array([x[0] for x in t]); d=np.array([x[3] for x in t])
    nl,ns=(d>0).sum(),(d<0).sum()
    print(f"\n  lat={lat}s slip={slip}pt   longs={nl} shorts={ns}  (balance {100*nl/len(d):.1f}% long)")
    print(f"    long  trades: n={nl:>4} net=${a[d>0].sum():>+9,.0f} avg=${a[d>0].mean():>+7.2f}")
    print(f"    short trades: n={ns:>4} net=${a[d<0].sum():>+9,.0f} avg=${a[d<0].mean():>+7.2f}")
    print(f"    --> if BOTH positive, it is not drift. If only shorts, it is the down month.")
    # per-day concentration
    print("    per-day net (is it a few days?):")
    idx=0; dl=[]
    for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
        pass
    eq=np.cumsum(a)
    print(f"    top-3 trades contribute ${np.sort(a)[-3:].sum():,.0f} of ${a.sum():,.0f}")
    print(f"    median trade=${np.median(a):+.2f}  maxDD=${(np.maximum.accumulate(eq)-eq).max():,.0f}")

print("\n=== CAN THIS RUN ON MBP-1 (Standard $199) INSTEAD OF MBO (Plus $1,750)? ===")
print("MBP-1 only shows events that change TOP OF BOOK. How far from last trade are our detections?")
import collections
ds=[]
for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
    d=np.load(p)['det']
    if len(d): ds.append(np.abs(d[:,2]-d[:,1]))
ds=np.concatenate(ds)
for thr in (0.25,0.5,1.0,2.0,5.0):
    print(f"    |order_px - last_trade| <= {thr:>4}pt : {100*(ds<=thr).mean():>5.1f}% of detections")
def run_d(T,S,lat,slip,maxdist):
    tr=[]
    for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
        z=np.load(p); px,ts,det=z['px'],z['ts'],z['det']
        if len(det)==0: continue
        free=-1.0
        for k in range(len(det)):
            dts,spot,opx,dirn,sz,idx=det[k]
            if dts<free or abs(opx-spot)>maxdist: continue
            d=int(dirn); i=np.searchsorted(ts,dts+lat)
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
            tr.append((d*(xp-ep)*PV-COMM,'',ts[i+1+xi]-ts[i],d)); free=ts[i+1+xi]
    return tr
print("\n  +/-30 bracket restricted to near-touch orders (what MBP-1 would see):")
for md in (0.25,0.5,1.0,2.0,5.0):
    for lat in (0.25,1.0):
        rep(f"dist<={md}pt lat={lat}s",run_d(30,30,lat,.25,md))

print("\n=== isolate the band: orders 2-5pt BEHIND the touch (MBO-only visibility) ===")
def run_band(T,S,lat,slip,lo,hi):
    tr=[]
    for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
        z=np.load(p); px,ts,det=z['px'],z['ts'],z['det']
        if len(det)==0: continue
        free=-1.0
        for k in range(len(det)):
            dts,spot,opx,dirn,sz,idx=det[k]
            dd=abs(opx-spot)
            if dts<free or dd<lo or dd>hi: continue
            d=int(dirn); i=np.searchsorted(ts,dts+lat)
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
            tr.append((d*(xp-ep)*PV-COMM,'',ts[i+1+xi]-ts[i],d)); free=ts[i+1+xi]
    return tr
for lo,hi in ((0.0,2.0),(2.0,5.0),(2.0,3.0),(3.0,5.0)):
    for lat in (0.25,1.0):
        rep(f"band {lo}-{hi}pt lat={lat}s",run_band(30,30,lat,.25,lo,hi))

print("\n=== CONTROLS on the 3-5pt band (the post-hoc slice) ===")
def band_dir(T,S,lat,slip,lo,hi,mode,seed=0):
    rg=np.random.default_rng(seed); tr=[]
    for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
        z=np.load(p); px,ts,det=z['px'],z['ts'],z['det']
        if len(det)==0: continue
        free=-1.0
        for k in range(len(det)):
            dts,spot,opx,dirn,sz,idx=det[k]
            dd=abs(opx-spot)
            if dts<free or dd<lo or dd>hi: continue
            d=int(dirn) if mode=='true' else (-int(dirn) if mode=='flip' else (1 if rg.random()<.5 else -1))
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
            tr.append((d*(xp-ep)*PV-COMM,'',ts[i+1+xi]-ts[i],d,p)); free=ts[i+1+xi]
    return tr
t=band_dir(30,30,1.0,.25,3.,5.,'true'); f=band_dir(30,30,1.0,.25,3.,5.,'flip')
at=np.array([x[0] for x in t]); af=np.array([x[0] for x in f])
ns=[np.array([x[0] for x in band_dir(30,30,1.0,.25,3.,5.,'rand',s)]).sum() for s in range(12)]
print(f"  TRUE    net=${at.sum():>+9,.0f}   FLIP net=${af.sum():>+9,.0f}")
print(f"  RANDOM  mean=${np.mean(ns):>+9,.0f} sd=${np.std(ns):,.0f}  -> TRUE is {(at.sum()-np.mean(ns))/np.std(ns):+.2f} sd")
d=np.array([x[3] for x in t]); print(f"  balance: {(d>0).sum()} long / {(d<0).sum()} short   long net=${at[d>0].sum():+,.0f}  short net=${at[d<0].sum():+,.0f}")
byday=collections.defaultdict(float)
for x in t: byday[x[4][-12:-4]]+=x[0]
v=np.array(list(byday.values())); print(f"  per-day: {(v>0).sum()}/{len(v)} days positive, best day ${v.max():+,.0f}, worst ${v.min():+,.0f}, top-3 days = ${np.sort(v)[-3:].sum():,.0f} of ${v.sum():,.0f}")
print("\n  band-boundary stability (a real effect is not knife-edge):")
for lo,hi in ((2.5,5.),(3.,5.),(3.5,5.),(3.,4.),(4.,5.),(3.,6.)):
    tt=band_dir(30,30,1.0,.25,lo,hi,'true'); aa=np.array([x[0] for x in tt])
    w=aa[aa>0]; l=aa[aa<=0]; pf=w.sum()/abs(l.sum()) if len(l) and l.sum()!=0 else 9.99
    print(f"    {lo}-{hi}pt  n={len(aa):>4} PF={pf:>4.2f} net=${aa.sum():>+9,.0f}")
