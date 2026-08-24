import sys, collections
f=sys.argv[1]
cnt=collections.Counter()
with open(f) as fh:
    fh.readline()
    for i,l in enumerate(fh):
        if i>1_500_000: break
        s=l.rsplit(',',1)[-1].strip()
        if '-' not in s: cnt[s]+=1
SYM=cnt.most_common(1)[0][0]
info={}
add=collections.defaultdict(collections.Counter); fil=collections.defaultdict(collections.Counter)
with open(f) as fh:
    fh.readline()
    for l in fh:
        p=l.split(',')
        if p[14].strip()!=SYM: continue
        a,side,sz,oid=p[5],p[6],p[8],p[10]
        try: s=int(sz)
        except: continue
        if a=='A':
            add[s][side]+=1; info[oid]=(s,side)
        elif a=='F':
            v=info.pop(oid,None)
            if v: fil[v[0]][v[1]]+=1
        elif a=='C':
            info.pop(oid,None)
day=f.split('-')[-1][:8]
for s in sorted(add):
    tb,ta=add[s]['B'],add[s]['A']
    if tb+ta<200: continue
    fb,fa=fil[s]['B'],fil[s]['A']
    print(f"{day} size={s:<4} adds={tb+ta:<8} bid%={100*tb/(tb+ta):5.1f} fills={fb+fa:<7} fillbid%={100*fb/max(fb+fa,1):5.1f}")
