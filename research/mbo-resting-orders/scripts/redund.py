"""Is the 3-5pt deep-order signal redundant with plain price action?
If detection DIRECTION is predictable from recent returns, we need no book data at all."""
import numpy as np, glob, os
PV=20.0; COMM=4.0; CAP=3600.0
def gather():
    R=[]
    for p in sorted(glob.glob('/tmp/claude-1000/ext/*.npz')):
        z=np.load(p); px,ts,det=z['px'],z['ts'],z['det']
        if len(det)==0: continue
        for dts,spot,opx,dirn,sz,idx in det:
            dd=abs(opx-spot)
            if dd<3.0 or dd>5.0: continue
            i=int(idx)
            if i<600: continue
            r60 =px[i]-px[max(0,i-60)]
            r300=px[i]-px[max(0,i-300)]
            lo=px[max(0,i-600):i+1].min(); hi=px[max(0,i-600):i+1].max()
            pos=(px[i]-lo)/(hi-lo) if hi>lo else .5
            R.append((dts,dirn,px[i],r60,r300,pos,i,p))
    return R
R=gather()
d=np.array([r[1] for r in R]); r60=np.array([r[3] for r in R]); r300=np.array([r[4] for r in R]); pos=np.array([r[5] for r in R])
print(f"3-5pt band detections: {len(R)}  ({(d>0).sum()} long / {(d<0).sum()} short)\n")
print("Is detection DIRECTION explainable by recent price action?")
for nm,v in (('ret 60 prints',r60),('ret 300 prints',r300),('pos in 600-print range',pos)):
    ml=v[d>0].mean(); ms=v[d<0].mean()
    sd=v.std()
    print(f"  {nm:>24}: long-mean={ml:>+8.3f}  short-mean={ms:>+8.3f}  gap={ (ml-ms)/sd:>+6.3f} sd")
# can a price-only rule reproduce direction?
pred=np.where(r60>0,1,-1)
print(f"\n  momentum rule (r60>0 -> long) agrees with detection direction: {100*(pred==d).mean():.1f}%  (50% = no info)")
pred2=np.where(pos<0.5,1,-1)
print(f"  range-position rule (low half -> long) agrees:                  {100*(pred2==d).mean():.1f}%")
