import sys, collections, os
path=sys.argv[1]; day=os.path.basename(path)[11:19]
BK=[(1,1,'s1'),(2,4,'s2_4'),(5,9,'s5_9'),(10,14,'s10_14'),(15,19,'s15_19'),(20,49,'s20_49'),(50,10**9,'s50p')]
def bk(s):
    for lo,hi,n in BK:
        if lo<=s<=hi: return n
    return 's50p'
acc=collections.defaultdict(lambda: collections.defaultdict(int))
symct=collections.Counter()
with open(path) as f:
    f.readline()
    for line in f:
        p=line.split(',')
        if len(p)<15: continue
        act=p[5]
        if act!='F': continue
        sym=p[14].rstrip('\n')
        symct[sym]+=1
        try: size=int(p[8])
        except: continue
        minute=p[1][:16]          # ISO to the minute
        side=p[6]
        b=bk(size)
        d=acc[(sym,minute)]
        d[b+'_'+('b' if side=='B' else 'a')+'ct']+=1
        d[b+'_'+('b' if side=='B' else 'a')+'vol']+=size
front=symct.most_common(1)[0][0]
cols=[]
for _,_,n in BK:
    for sfx in ('_bct','_act','_bvol','_avol'): cols.append(n+sfx)
out=f"/tmp/claude-1000/absorb/{day}.csv"
os.makedirs('/tmp/claude-1000/absorb',exist_ok=True)
with open(out,'w') as o:
    o.write('minute,'+','.join(cols)+'\n')
    for (sym,minute),d in sorted(acc.items()):
        if sym!=front: continue
        o.write(minute+','+','.join(str(d.get(c,0)) for c in cols)+'\n')
print(f"{day} front={front} minutes={sum(1 for (s,_) in acc if s==front)}")
