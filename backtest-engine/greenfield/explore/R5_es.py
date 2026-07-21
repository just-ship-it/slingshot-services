#!/usr/bin/env python3
"""R5 ES cross-check. ES cache has et_date=Globex trade_date, et_hhmm. Compute ON range
and ATR14 from the cache itself, then replicate NQ regime + prediction-vs-baseline test."""
import csv, statistics
from collections import defaultdict
from datetime import date

PROG_ONEWAY=0.60; PROG_CHOP=0.25; LOC_UP=0.70; LOC_DN=0.30
def mean(xs): return sum(xs)/len(xs) if xs else float('nan')
def tstat(xs):
    if len(xs)<2: return float('nan')
    m=mean(xs); s=statistics.stdev(xs)
    return m/(s/len(xs)**0.5) if s>0 else float('nan')

# group ES bars by et_date
days=defaultdict(lambda: {"on":[], "fh":[], "rod":[], "pm":[]})
with open("cache/ES_1m_primary.csv") as f:
    for r in csv.DictReader(f):
        d=r["et_date"]; hhmm=int(r["et_hhmm"])
        o=float(r["o"]);h=float(r["h"]);l=float(r["l"]);c=float(r["c"])
        D=days[d]
        # overnight: 1800-2359 or 0000-0929
        if hhmm>=1800 or hhmm<930: D["on"].append((o,c,h,l))
        hm=(hhmm//100)*60+(hhmm%100)
        if 570<=hm<630: D["fh"].append((o,c,h,l))
        if 630<=hm<960: D["rod"].append((o,c,h,l))
        if 780<=hm<960: D["pm"].append((o,c,h,l))

def label(fho,fhc,fhh,fhl,onh,onl):
    rng=fhh-fhl
    if rng<=0: return "CHOP"
    net=fhc-fho; prog=abs(net)/rng; loc=(fhc-fhl)/rng
    if fhh>onh and fhc<onh and net<0: return "SWEEP_REVERT_BEAR"
    if fhl<onl and fhc>onl and net>0: return "SWEEP_REVERT_BULL"
    if prog>=PROG_ONEWAY:
        if net>0 and loc>=LOC_UP: return "ONEWAY_UP"
        if net<0 and loc<=LOC_DN: return "ONEWAY_DOWN"
    if prog<PROG_CHOP: return "CHOP"
    return "BTD" if net>0 else "STR"
def pm_family(o,c,hi,lo):
    rng=hi-lo
    if rng<=0: return "CHOP"
    net=c-o; prog=abs(net)/rng
    if prog<PROG_CHOP: return "CHOP"
    return "UP" if net>0 else "DOWN"

recs=[]
sd=sorted(days.keys())
# ATR14 from prior RTH true ranges
rth_hl={}
for d in sd:
    D=days[d]
    if len(D["rod"])<300 or len(D["fh"])<55: continue
    allrth=D["fh"]+D["rod"]
    rth_hl[d]=(max(x[2] for x in allrth),min(x[3] for x in allrth),allrth[-1][1])
def atr14(d):
    idx=sd.index(d)
    trs=[]
    prevc=None
    for dd in sd[max(0,idx-25):idx]:
        if dd not in rth_hl: continue
        h,l,c=rth_hl[dd]
        tr=h-l if prevc is None else max(h-l,abs(h-prevc),abs(l-prevc))
        trs.append(tr); prevc=c
    return mean(trs[-14:]) if len(trs)>=14 else None

for d in sd:
    D=days[d]
    if len(D["fh"])<55 or len(D["rod"])<300 or len(D["on"])<60: continue
    fho=D["fh"][0][0]; fhc=D["fh"][-1][1]
    fhh=max(x[2] for x in D["fh"]); fhl=min(x[3] for x in D["fh"])
    onh=max(x[2] for x in D["on"]); onl=min(x[3] for x in D["on"])
    atr=atr14(d)
    if not atr: continue
    reg=label(fho,fhc,fhh,fhl,onh,onl)
    rodc=D["rod"][-1][1]
    rod_atr=(rodc-fhc)/atr
    fh_dir=1 if fhc-fho>0 else -1
    y=int(d[:4])
    pm_fam=None
    if len(D["pm"])>=120:
        pmo=D["pm"][0][0];pmc=D["pm"][-1][1]
        pmh=max(x[2] for x in D["pm"]);pml=min(x[3] for x in D["pm"])
        pm_fam=pm_family(pmo,pmc,pmh,pml)
    recs.append({"d":d,"y":y,"reg":reg,"rod_atr":rod_atr,"fh_dir":fh_dir,
                 "fhrng_atr":(fhh-fhl)/atr,"pm":pm_fam})
print(f"ES clean days: {len(recs)}  {recs[0]['d']}..{recs[-1]['d']}")
years=sorted(set(r["y"] for r in recs))
REG=["ONEWAY_UP","ONEWAY_DOWN","BTD","STR","CHOP","SWEEP_REVERT_BULL","SWEEP_REVERT_BEAR"]

# vol terciles per year
terc={}
for y in years:
    vals=sorted(r["fhrng_atr"] for r in recs if r["y"]==y)
    terc[y]=(vals[len(vals)//3],vals[2*len(vals)//3]) if len(vals)>=3 else (0,0)
def vt(r):
    lo,hi=terc[r["y"]]; return 0 if r["fhrng_atr"]<=lo else (2 if r["fhrng_atr"]>hi else 1)
for r in recs: r["vt"]=vt(r)
basecell=defaultdict(list)
for r in recs: basecell[(r["fh_dir"],r["vt"])].append(r["rod_atr"])

print("\nES raw per-regime rest-of-day drift (ATR-norm) + per-year:")
print(f"  {'regime':20s} {'n':>4} {'mean':>7} {'t':>6}  per-year")
for reg in REG:
    sub=[r for r in recs if r["reg"]==reg]
    if not sub: continue
    yv=[f"{mean([r['rod_atr'] for r in sub if r['y']==y]):+.2f}" if any(r['y']==y for r in sub) else "  -  " for y in years]
    print(f"  {reg:20s} {len(sub):4d} {mean([r['rod_atr'] for r in sub]):+7.3f} {tstat([r['rod_atr'] for r in sub]):+6.2f}  "+" ".join(yv))

print("\nES regime EXCESS over (fh_dir x vol tercile) unconditional baseline:")
print(f"  {'regime':20s} {'n':>4} {'excess':>7} {'t_exc':>6}")
for reg in REG:
    sub=[r for r in recs if r["reg"]==reg]
    if not sub: continue
    exc=[r["rod_atr"]-mean(basecell[(r["fh_dir"],r["vt"])]) for r in sub]
    print(f"  {reg:20s} {len(sub):4d} {mean(exc):+7.3f} {tstat(exc):+6.2f}")

print("\nES persistence (10:30 regime -> 13:00-16:00 family), lift over base:")
exp={"ONEWAY_UP":"UP","ONEWAY_DOWN":"DOWN","BTD":"UP","STR":"DOWN","CHOP":"CHOP",
     "SWEEP_REVERT_BULL":"UP","SWEEP_REVERT_BEAR":"DOWN"}
pmr=[r for r in recs if r["pm"]]
from collections import Counter
base=Counter(r["pm"] for r in pmr); bt=sum(base.values())
for reg in REG:
    sub=[r for r in pmr if r["reg"]==reg]
    if not sub: continue
    want=exp[reg]; m=sum(1 for r in sub if r["pm"]==want)/len(sub); br=base[want]/bt
    print(f"  {reg:20s} n={len(sub):4d} match={100*m:5.1f}% base={100*br:5.1f}% lift={m/br if br else 0:.2f}")
