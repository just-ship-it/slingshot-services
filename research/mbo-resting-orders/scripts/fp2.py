import sys, os, numpy as np, collections, pickle
path=sys.argv[1]; day=os.path.basename(path)[10:18]
FRONT='NQH6'; MINSZ=10; NEAR=5.0; CAPSEC=3600
LV=[5.,10.,15.,20.,30.]
tp=[]; tsec=[]; det=[]; last=None; symct=collections.Counter(); prev=None; off=0.0
with open(path) as f:
    f.readline()
    for line in f:
        p=line.split(',')
        if len(p)<15: continue
        act=p[5]; sym=p[14].rstrip('\n'); symct[sym]+=1
        if sym!=FRONT: continue
        if act=='T':
            try: pr=float(p[7])
            except: continue
            t=p[1]; s=int(t[11:13])*3600+int(t[14:16])*60+float(t[17:26])
            if prev is not None and s<prev-1000: off+=86400.0
            prev=s
            tp.append(pr); tsec.append(s+off); last=pr
        elif act=='A' and last is not None:
            try: sz=int(p[8]); pr=float(p[7])
            except: continue
            if sz>=MINSZ and abs(pr-last)<=NEAR:
                det.append((len(tp)-1,last,p[6],sz))
assert symct.most_common(1)[0][0]==FRONT
tp=np.array(tp); ts=np.array(tsec)
rows=[]
for idx,spot,side,sz in det:
    e=np.searchsorted(ts,ts[idx]+CAPSEC)
    seg=tp[idx+1:e]
    if len(seg)<2: continue
    cmax=np.maximum.accumulate(seg); cmin=np.minimum.accumulate(seg)
    tu=[]; td=[]
    for L in LV:
        i=np.searchsorted(cmax,spot+L,side='left')
        tu.append(ts[idx+1+i]-ts[idx] if i<len(seg) else np.inf)
        j=np.searchsorted(-cmin,-(spot-L),side='left')
        td.append(ts[idx+1+j]-ts[idx] if j<len(seg) else np.inf)
    rows.append((side,sz,tu,td))
os.makedirs('/tmp/claude-1000/fp2',exist_ok=True)
pickle.dump(rows,open(f'/tmp/claude-1000/fp2/{day}.pkl','wb'))
b=sum(1 for r in rows if r[0]=='B')
print(f"{day} det={len(rows):,} bid={b} ask={len(rows)-b}")
