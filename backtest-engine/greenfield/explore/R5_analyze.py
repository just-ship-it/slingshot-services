#!/usr/bin/env python3
"""R5 analysis: frequency, persistence, prediction vs unconditional baseline + placebo."""
import csv, statistics, random
from collections import defaultdict, Counter

random.seed(42)
rows=[]
with open("R5-days.csv") as f:
    for r in csv.DictReader(f):
        if not r["atr14_prior"]:  # need vol normalizer
            continue
        r["atr"]=float(r["atr14_prior"])
        r["rod_drift"]=float(r["rod_drift"])
        r["fh_net"]=float(r["fh_net"])
        r["fh_rng"]=float(r["fh_rng"])
        r["fh_dir"]=int(r["fh_dir"])
        r["year"]=int(r["year"])
        r["rod_atr"]=r["rod_drift"]/r["atr"] if r["atr"] else 0.0
        rows.append(r)
print(f"days with ATR: {len(rows)}  years {min(x['year'] for x in rows)}-{max(x['year'] for x in rows)}")

REG=["ONEWAY_UP","ONEWAY_DOWN","BTD","STR","CHOP","SWEEP_REVERT_BULL","SWEEP_REVERT_BEAR"]

def mean(xs): return sum(xs)/len(xs) if xs else float('nan')
def sd(xs): return statistics.pstdev(xs) if len(xs)>1 else 0.0
def tstat(xs):
    if len(xs)<2: return float('nan')
    m=mean(xs); s=statistics.stdev(xs)
    return m/(s/len(xs)**0.5) if s>0 else float('nan')

print("\n===== 1. FREQUENCY =====")
c=Counter(x["regime"] for x in rows)
for reg in REG:
    print(f"  {reg:20s} {c[reg]:4d}  {100*c[reg]/len(rows):5.1f}%")
print("\n  per-year counts:")
years=sorted(set(x["year"] for x in rows))
hdr="  "+ "regime".ljust(20)+"".join(f"{y:>6}" for y in years)
print(hdr)
for reg in REG:
    line="  "+reg.ljust(20)
    for y in years:
        n=sum(1 for x in rows if x["year"]==y and x["regime"]==reg)
        tot=sum(1 for x in rows if x["year"]==y)
        line+=f"{100*n/tot:5.0f}%"
    print(line)

print("\n===== 2. PERSISTENCE: 10:30 regime vs realized 13:00-16:00 texture =====")
# map morning regime -> expected afternoon texture family
exp={"ONEWAY_UP":"UP","ONEWAY_DOWN":"DOWN","BTD":"UP","STR":"DOWN",
     "CHOP":"CHOP","SWEEP_REVERT_BULL":"UP","SWEEP_REVERT_BEAR":"DOWN"}
def pm_family(t):
    if t in ("TREND_UP","DRIFT_UP"): return "UP"
    if t in ("TREND_DOWN","DRIFT_DOWN"): return "DOWN"
    if t=="CHOP": return "CHOP"
    return None
pm_rows=[x for x in rows if x["pm_texture"]]
# base rates of afternoon families
base=Counter(pm_family(x["pm_texture"]) for x in pm_rows)
btot=sum(base.values())
print("  afternoon-family base rates:", {k:f'{100*v/btot:.0f}%' for k,v in base.items()})
print(f"  {'morning regime':20s} {'n':>5} {'match%':>7} {'base%':>7} {'lift':>6}")
for reg in REG:
    sub=[x for x in pm_rows if x["regime"]==reg]
    if not sub: continue
    want=exp[reg]
    match=sum(1 for x in sub if pm_family(x["pm_texture"])==want)
    br=base.get(want,0)/btot
    m=match/len(sub)
    print(f"  {reg:20s} {len(sub):5d} {100*m:6.1f}% {100*br:6.1f}% {m/br if br else 0:6.2f}")

print("\n===== 3. PREDICTION: rest-of-day drift (10:30->close), ATR-normalized =====")
print("  regime mean rod_drift/ATR, per year (pooled). sign inversion across years = dead")
def cell(sub,key="rod_atr"):
    xs=[x[key] for x in sub]
    return len(xs),mean(xs),tstat(xs)
print(f"  {'regime':20s} {'n':>5} {'mean':>7} {'t':>6}   per-year means")
for reg in REG:
    sub=[x for x in rows if x["regime"]==reg]
    if not sub: continue
    n,m,t=cell(sub)
    yv=[]
    for y in years:
        ys=[x["rod_atr"] for x in sub if x["year"]==y]
        yv.append(f"{mean(ys):+.2f}" if ys else "  -  ")
    print(f"  {reg:20s} {n:5d} {m:+7.3f} {t:+6.2f}   "+" ".join(f"{v:>6}" for v in yv))

print("\n===== 3b. LOAD-BEARING CONTROL: unconditional same-day-type baseline =====")
# baseline cell = (fh_dir sign) x (vol tercile by fh_rng/ATR, per-year terciled)
# compute per-year fh_rng/ATR terciles
for x in rows:
    x["fhrng_atr"]=x["fh_rng"]/x["atr"] if x["atr"] else 0.0
terc={}
for y in years:
    vals=sorted(x["fhrng_atr"] for x in rows if x["year"]==y)
    if len(vals)<3:
        terc[y]=(0,0); continue
    terc[y]=(vals[len(vals)//3],vals[2*len(vals)//3])
def vt(x):
    lo,hi=terc[x["year"]]
    return 0 if x["fhrng_atr"]<=lo else (2 if x["fhrng_atr"]>hi else 1)
for x in rows: x["vt"]=vt(x)
# unconditional baseline drift per (fh_dir, vt)
basecell=defaultdict(list)
for x in rows:
    basecell[(x["fh_dir"],x["vt"])].append(x["rod_atr"])
print("  unconditional rod_drift/ATR by (fh_dir, vol tercile):")
for d in (1,-1):
    for v in (0,1,2):
        xs=basecell[(d,v)]
        print(f"    fh_dir={d:+d} vt={v}: n={len(xs):4d} mean={mean(xs):+.3f} t={tstat(xs):+.2f}")

print("\n  REGIME EXCESS over its own-cell unconditional baseline (does label ADD signal?):")
print(f"  {'regime':20s} {'n':>5} {'reg_mean':>9} {'base_mean':>9} {'excess':>7} {'t_excess':>8}")
for reg in REG:
    sub=[x for x in rows if x["regime"]==reg]
    if not sub: continue
    excess=[]
    for x in sub:
        bcell=basecell[(x["fh_dir"],x["vt"])]
        bm=mean(bcell)
        excess.append(x["rod_atr"]-bm)
    n=len(sub)
    print(f"  {reg:20s} {n:5d} {mean([x['rod_atr'] for x in sub]):+9.3f} "
          f"{mean([x['rod_atr'] for x in sub])-mean(excess):+9.3f} {mean(excess):+7.3f} {tstat(excess):+8.2f}")

print("\n===== 3c. SHUFFLED-LABEL PLACEBO =====")
# shuffle regime labels within (fh_dir, vt, year) cells; recompute per-regime mean rod_atr
# report how often real |mean| exceeds shuffled distribution
groups=defaultdict(list)
for i,x in enumerate(rows):
    groups[(x["fh_dir"],x["vt"],x["year"])].append(i)
real_mean={reg:mean([x["rod_atr"] for x in rows if x["regime"]==reg]) for reg in REG}
N=1000
exceed={reg:0 for reg in REG}
shuf_labels=[x["regime"] for x in rows]
for _ in range(N):
    perm=list(shuf_labels)
    for idxs in groups.values():
        vals=[perm[i] for i in idxs]
        random.shuffle(vals)
        for j,i in zip(range(len(idxs)),idxs):
            perm[i]=vals[j]
    sm={}
    acc=defaultdict(list)
    for i,x in enumerate(rows):
        acc[perm[i]].append(x["rod_atr"])
    for reg in REG:
        if abs(mean(acc[reg]) if acc[reg] else 0) >= abs(real_mean[reg]):
            exceed[reg]+=1
print("  fraction of shuffles whose |mean drift| >= real (within-cell shuffle, p-value):")
for reg in REG:
    print(f"  {reg:20s} real_mean={real_mean[reg]:+.3f}  p={exceed[reg]/N:.3f}")

print("\n===== 4. SHORT-SIDE / COUNTER-TREND EDGE SCAN =====")
print("  regimes with negative rest-of-day drift that persists per-year:")
for reg in REG:
    sub=[x for x in rows if x["regime"]==reg]
    if not sub: continue
    yv={y:mean([x["rod_atr"] for x in sub if x["year"]==y]) for y in years if any(x["year"]==y for x in sub)}
    allneg=all(v<0 for v in yv.values())
    allpos=all(v>0 for v in yv.values())
    tag=""
    if allneg: tag=" <-- SHORT persists all years"
    elif allpos: tag=" <-- LONG persists all years"
    print(f"  {reg:20s} mean={mean([x['rod_atr'] for x in sub]):+.3f} {tag}")
