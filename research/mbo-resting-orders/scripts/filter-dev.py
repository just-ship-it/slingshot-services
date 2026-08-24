#!/usr/bin/env python3
"""Filter development — IN-SAMPLE ONLY (Dec 2025 - Jan 2026, derived/ext).
Never reads derived/ext_oos or April. Candidates chosen here get LOCKED, then tested."""
import glob, os, sys, collections, numpy as np
PV=20.0; COMM=4.0; CAP=3600.0; T=S=30.0; LAT=1.0; SLIP=0.25; LO,HI=3.0,5.0
def trades(srcdir, front_filter=None, keep=None):
    """keep(feat)->bool decides whether a detection is taken. Returns per-trade rows."""
    out=[]
    for p in sorted(glob.glob(os.path.join(srcdir,'*.npz'))):
        day=os.path.basename(p)[:8]
        if day=='20260730': continue
        z=np.load(p); px,ts,det=z['px'],z['ts'],z['det']
        if len(det)==0: continue
        free=-1.0; prev_ts=None
        for dts,spot,opx,dirn,sz,idx in det:
            dd=abs(opx-spot)
            if dd<LO or dd>HI: continue
            i0=int(idx)
            gap = (dts-prev_ts) if prev_ts is not None else 1e9
            prev_ts=dts
            if dts<free: continue
            i=np.searchsorted(ts,dts+LAT)
            if i>=len(px) or i<600: continue
            # causal features known AT detection
            hh=int(((dts%86400)/3600+20)%24)      # UTC hour -> ET-ish (UTC-4)
            r60 = px[i]-px[i-60]; r300=px[i]-px[max(0,i-300)]
            seg=px[max(0,i-600):i+1]; rng=seg.max()-seg.min()
            pos=(px[i]-seg.min())/rng if rng>0 else .5
            vol=np.mean(np.abs(np.diff(px[max(0,i-300):i+1]))) if i>300 else 0.0
            f=dict(size=sz,dist=dd,dirn=int(dirn),hour=hh,r60=r60,r300=r300,
                   pos=pos,vol=vol,rng=rng,gap=gap)
            if keep is not None and not keep(f): continue
            d=int(dirn)
            ep=px[i]+d*SLIP; tgt=ep+d*T; stp=ep-d*S
            e=np.searchsorted(ts,ts[i]+CAP); sg=px[i+1:e]
            if len(sg)==0: continue
            if d>0: ht=np.flatnonzero(sg>=tgt); hs=np.flatnonzero(sg<=stp)
            else:   ht=np.flatnonzero(sg<=tgt); hs=np.flatnonzero(sg>=stp)
            it=ht[0] if len(ht) else 10**9; isx=hs[0] if len(hs) else 10**9
            if it<isx: xp=tgt; xi=it
            elif isx<it: xp=sg[isx]-d*SLIP; xi=isx
            else: xp=sg[-1]-d*SLIP; xi=len(sg)-1
            f['pnl']=d*(xp-ep)*PV-COMM; f['day']=day
            out.append(f); free=ts[i+1+xi]
    return out
def stat(rows,tag=''):
    if len(rows)<30: return None
    a=np.array([r['pnl'] for r in rows]); w=a[a>0]; l=a[a<=0]
    pf=w.sum()/abs(l.sum()) if len(l) and l.sum()!=0 else 9.99
    eq=np.cumsum(a); dd=(np.maximum.accumulate(eq)-eq).max()
    by=collections.defaultdict(float)
    for r in rows: by[r['day']]+=r['pnl']
    v=np.array(list(by.values()))
    return dict(tag=tag,n=len(a),pf=pf,net=a.sum(),dd=dd,wr=100*len(w)/len(a),
                per=a.mean(),dpos=f"{(v>0).sum()}/{len(v)}")
def show(s):
    if s is None: print("   (too few)"); return
    print(f"  {s['tag']:<34} n={s['n']:>4} WR={s['wr']:>5.1f}% PF={s['pf']:>4.2f} "
          f"net=${s['net']:>+8,.0f} $/trade={s['per']:>+6.1f} maxDD=${s['dd']:>7,.0f} days+={s['dpos']}")
if __name__=='__main__':
    base=trades('derived/ext')
    print("=== IN-SAMPLE baseline (Dec 2025 - Jan 2026) ===")
    show(stat(base,'ALL (no filter)'))
    print("\n=== single-feature splits — where does the money actually come from? ===")
    for nm,fn in (('size>=15',lambda f:f['size']>=15),('size>=25',lambda f:f['size']>=25),
                  ('dist>=4.0',lambda f:f['dist']>=4.0),('dist<4.0',lambda f:f['dist']<4.0),
                  ('LONG only',lambda f:f['dirn']>0),('SHORT only',lambda f:f['dirn']<0),
                  ('gap>=60s',lambda f:f['gap']>=60),('gap>=300s',lambda f:f['gap']>=300),
                  ('pos<0.5',lambda f:f['pos']<0.5),('pos>=0.5',lambda f:f['pos']>=0.5),
                  ('with r60',lambda f:(f['r60']>0)==(f['dirn']>0)),
                  ('against r60',lambda f:(f['r60']>0)!=(f['dirn']>0)),
                  ('RTH 13-20utc',lambda f:9<=f['hour']<=16),
                  ('vol high',lambda f:f['vol']>=0.30),('vol low',lambda f:f['vol']<0.30)):
        show(stat([r for r in base if fn(r)],nm))
