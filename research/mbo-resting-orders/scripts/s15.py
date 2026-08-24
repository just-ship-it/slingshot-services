import sys, collections
f=sys.argv[1]; out=sys.argv[2]
cnt=collections.Counter()
with open(f) as fh:
    fh.readline()
    for i,l in enumerate(fh):
        if i>1_500_000: break
        s=l.rsplit(',',1)[-1].strip()
        if '-' not in s: cnt[s]+=1
SYM=cnt.most_common(1)[0][0]
TGT=15
info={}
agg=collections.defaultdict(lambda: collections.Counter())
with open(f) as fh:
    fh.readline()
    for l in fh:
        p=l.split(',')
        if p[14].strip()!=SYM: continue
        a,side,px,sz,oid,ts=p[5],p[6],p[7],p[8],p[10],p[1]
        m=ts[:16]
        if a=='A':
            try: s=int(sz)
            except: continue
            if s==TGT:
                info[oid]=(side,m,float(px) if px else 0)
                agg[m]['add_'+side]+=1
        elif a in ('C','F'):
            v=info.pop(oid,None)
            if not v: continue
            sd,m0,pr=v
            agg[m][('fill_' if a=='F' else 'cxl_')+sd]+=1
with open(out,'w') as fh:
    fh.write('minute,add_B,add_A,fill_B,fill_A,cxl_B,cxl_A\n')
    for m in sorted(agg):
        c=agg[m]
        fh.write(f"{m},{c['add_B']},{c['add_A']},{c['fill_B']},{c['fill_A']},{c['cxl_B']},{c['cxl_A']}\n")
print(f"{f.split('-')[-1][:8]} s15 minutes={len(agg)} adds={sum(v['add_B']+v['add_A'] for v in agg.values())}")
