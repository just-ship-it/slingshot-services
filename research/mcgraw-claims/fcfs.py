"""FCFS composite: ONE NQ slot, first-come-first-served, honest slot contention.
Windows (ET):  gapfade 09:30-11:00 | monday 09:30-15:45 | pcc 15:00-15:30 | letf 15:30-15:45
'gold' is a different instrument -> its own slot, excluded from NQ contention."""
import pandas as pd, numpy as np, collections
B='/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore/'
SL={'gapfade':(570,660),'monday':(570,945),'pcc':(900,930),'letf':(930,945)}
d={}
for k in SL:
    x=pd.read_csv(B+f'book-{k}-daily.csv'); x['date']=pd.to_datetime(x.date).dt.date
    d[k]=dict(zip(x.date,x.pnl))
days=sorted(set().union(*[set(v) for v in d.values()]))
def run(priority):
    kept=collections.defaultdict(list); blocked=collections.Counter()
    for day in days:
        free=0; cands=[(SL[k][0],priority.index(k),k) for k in SL if day in d[k]]
        for st,_,k in sorted(cands):
            if st>=free:
                kept[k].append((day,d[k][day])); free=SL[k][1]
            else: blocked[k]+=1
    return kept,blocked
def metrics(kept):
    alld=collections.defaultdict(float)
    for k,v in kept.items():
        for day,p in v: alld[day]+=p
    s=pd.Series(alld).sort_index()
    a=s.values; w=a[a>0]; l=a[a<=0]
    pf=w.sum()/abs(l.sum()); eq=np.cumsum(a); dd=(np.maximum.accumulate(eq)-eq).max()
    sh=a.mean()/a.std()*np.sqrt(252)
    return pf,a.sum(),dd,sh,len(a)
print("Single NQ FCFS slot. 'gold' excluded (separate instrument).\n")
for pri in (['monday','gapfade','pcc','letf'],['gapfade','monday','pcc','letf']):
    kept,blk=run(pri)
    print(f"priority order: {' > '.join(pri)}")
    for k in SL:
        tot=sum(p for _,p in kept[k]); n=len(kept[k])
        print(f"    {k:<9} fired {n:>4}  blocked {blk[k]:>3}  net ${tot:>+9,.0f}")
    pf,net,dd,sh,n=metrics(kept)
    print(f"    BOOK  n={n} days  PF={pf:.2f}  net=${net:+,.0f}  maxDD=${dd:,.0f}  Sharpe={sh:.2f}\n")
# what does adding letf actually contribute, FCFS-honest?
print("="*74); print("MARGINAL VALUE OF ADDING LETF (priority monday>gapfade>pcc>letf)"); print("="*74)
def run2(priority, slots):
    kept=collections.defaultdict(list); blocked=collections.Counter()
    for day in days:
        free=0; cands=[(slots[k][0],priority.index(k),k) for k in slots if day in d[k]]
        for st,_,k in sorted(cands):
            if st>=free:
                kept[k].append((day,d[k][day])); free=slots[k][1]
            else: blocked[k]+=1
    return kept
for withletf in (False,True):
    pri=['monday','gapfade','pcc']+(['letf'] if withletf else [])
    sl={k:v for k,v in SL.items() if withletf or k!='letf'}
    kept=run2(pri,sl); pf,net,dd,sh,n=metrics(kept)
    print(f"  {'WITH letf ' if withletf else 'WITHOUT   '}  PF={pf:.2f}  net=${net:+,.0f}  maxDD=${dd:,.0f}  Sharpe={sh:.2f}  days={n}")
