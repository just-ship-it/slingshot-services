"""Search MBP-1-only (=$199 Standard) features for the deep-order edge.
Detection uses ONLY L1; forward walk uses MBO prints as honest ground truth."""
import numpy as np, glob, os
PV=20.0; COMM=4.0; CAP=3600.0
def feats(l1):
    ts=l1[:,0]; bpx=l1[:,1]; bsz=l1[:,2]; bct=np.maximum(l1[:,3],1)
    apx=l1[:,4]; asz=l1[:,5]; act=np.maximum(l1[:,6],1); last=l1[:,7]
    return dict(ts=ts,bpx=bpx,bsz=bsz,bct=bct,apx=apx,asz=asz,act=act,last=last,
                avgb=bsz/bct, avga=asz/act,
                imb=(bsz-asz)/np.maximum(bsz+asz,1),
                ctimb=(bct-act)/np.maximum(bct+act,1),
                spread=apx-bpx)
def run(rule,T,S,lat,slip,**kw):
    tr=[]
    for p in sorted(glob.glob('/tmp/claude-1000/l1/*.npz')):
        day=os.path.basename(p)[:8]
        ep_=f'/tmp/claude-1000/ext/{day}.npz'
        if not os.path.exists(ep_): continue
        l1=np.load(p)['l1']
        if len(l1)<100: continue
        z=np.load(ep_); px,ts=z['px'],z['ts']
        F=feats(l1); sig=rule(F,**kw)          # +1 long, -1 short, 0 none
        free=-1.0
        idx=np.flatnonzero(sig!=0)
        for j in idx:
            dts=F['ts'][j]
            if dts<free: continue
            d=int(sig[j]); i=np.searchsorted(ts,dts+lat)
            if i>=len(px) or i==0: continue
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
    if len(tr)<25: print(f"{tag:>34} n={len(tr):>4} (too few)"); return
    a=np.array([t[0] for t in tr]); w=a[a>0]; l=a[a<=0]
    pf=w.sum()/abs(l.sum()) if len(l) and l.sum()!=0 else 9.99
    eq=np.cumsum(a); dd=(np.maximum.accumulate(eq)-eq).max(); d=np.array([t[1] for t in tr])
    print(f"{tag:>34} n={len(a):>4} WR={100*len(w)/len(a):>5.1f}% PF={pf:>4.2f} net=${a.sum():>+9,.0f} maxDD=${dd:>7,.0f} L/S={(d>0).sum()}/{(d<0).sum()}")
# --- rules ---
def r_avgsize(F,A=5):
    s=np.zeros(len(F['ts']),dtype=int)
    s[F['avgb']>=A]=1; s[F['avga']>=A]=-1
    s[(F['avgb']>=A)&(F['avga']>=A)]=0
    return s
def r_szimb(F,t=0.5):
    s=np.zeros(len(F['ts']),dtype=int)
    s[F['imb']>=t]=1; s[F['imb']<=-t]=-1
    return s
def r_ctimb(F,t=0.5):
    s=np.zeros(len(F['ts']),dtype=int)
    s[F['ctimb']>=t]=1; s[F['ctimb']<=-t]=-1
    return s
def r_bigsz(F,A=20):
    s=np.zeros(len(F['ts']),dtype=int)
    s[F['bsz']>=A]=1; s[F['asz']>=A]=-1
    s[(F['bsz']>=A)&(F['asz']>=A)]=0
    return s
if __name__=='__main__':
    print("=== MBP-1-ONLY rules, +/-30 bracket, lat=1s slip=0.25pt, 23 days ===")
    for A in (3,5,10):   rep(f"avg order size at touch >={A}", run(r_avgsize,30,30,1.0,.25,A=A))
    for A in (10,20,40): rep(f"raw size at touch >={A}",       run(r_bigsz,30,30,1.0,.25,A=A))
    for t in (.3,.5,.7): rep(f"size imbalance >={t}",          run(r_szimb,30,30,1.0,.25,t=t))
    for t in (.3,.5,.7): rep(f"count imbalance >={t}",         run(r_ctimb,30,30,1.0,.25,t=t))
