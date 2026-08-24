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
sz=collections.Counter()
with open(f) as fh:
    fh.readline()
    for l in fh:
        p=l.split(',')
        if p[14].strip()!=SYM or p[5]!='A': continue
        try: sz[int(p[8])]+=1
        except: pass
tot=sum(sz.values())
day=f.split('-')[-1][:8]
out=[f"{day}"]
for s in (2,3,4,5,6,7,8,9,10,15,20,25,30,50):
    out.append(f"{s}:{10000*sz[s]/tot:.1f}")
print(" ".join(out))
