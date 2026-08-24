import pickle, glob, os, numpy as np
LV=[5.,10.,15.,20.,30.]
days={}
for p in sorted(glob.glob('/tmp/claude-1000/fp2/*.pkl')):
    days[os.path.basename(p)[:8]]=pickle.load(open(p,'rb'))
dk=sorted(days); print(f"{len(dk)} days, {sum(len(days[d]) for d in dk):,} detections\n")
rng=np.random.default_rng(3)
def stat(dl,li,side=None):
    u=d_=0
    for day in dl:
        for s,sz,tu,td in days[day]:
            if side and s!=side: continue
            a,b=tu[li],td[li]
            if a<b: u+=1
            elif b<a: d_+=1
    return u,d_
print(f"{'barrier':>8} {'n':>7} {'none%':>6} {'P(up)':>7} {'95% CI (day-clustered)':>24}   {'P(up|BID)':>10} {'P(up|ASK)':>10} {'tilt':>7} {'CI':>16}")
for li,L in enumerate(LV):
    u,d_=stat(dk,li); n=u+d_
    tot=sum(1 for day in dk for r in days[day])
    ub,db=stat(dk,li,'B'); ua,da=stat(dk,li,'A')
    pb=ub/(ub+db); pa=ua/(ua+da); tilt=pb-pa
    bs=[];bt=[]
    for _ in range(2000):
        sm=list(rng.choice(dk,len(dk),replace=True))
        u2,d2=stat(sm,li); bs.append(u2/(u2+d2))
        ub2,db2=stat(sm,li,'B'); ua2,da2=stat(sm,li,'A')
        bt.append(ub2/(ub2+db2)-ua2/(ua2+da2))
    lo,hi=np.percentile(bs,[2.5,97.5]); tl,th=np.percentile(bt,[2.5,97.5])
    print(f"{'+/-'+str(int(L)):>8} {n:>7,} {100*(1-n/tot):>5.1f}% {100*u/n:>6.2f}% [{100*lo:>6.2f}%, {100*hi:>6.2f}%]   "
          f"{100*pb:>9.2f}% {100*pa:>9.2f}% {100*tilt:>+6.2f}pp [{100*tl:>+5.2f},{100*th:>+5.2f}]")
print("\nP(up)=unconditional (absorbs sample drift). tilt=P(up|bid order)-P(up|ask order), drift-neutral.")
