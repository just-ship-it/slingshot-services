#!/usr/bin/env python3
"""B8 honest 1s sim of the 03:35->04:05 ET European-open LONG drive.

Grid: stop {none, 0.3xATR14} x gate {none, first5min-up} = 4 configs.
Slippage grid: 0.5 / 1.0 / 1.5 pt per fill (entry + time-exit). Stop fixed -0.5pt.
$5 RT commission, NQ $20/pt, 1 contract.

Usage: B8-01-sim.py <date_lo> <date_hi>   (ET dates, inclusive)
Prints per-config x slippage metrics + per-year. Can dump book file.
"""
import sys, csv, math
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from collections import defaultdict

ROOT="/home/drew/projects/slingshot-services/backtest-engine"
CACHE=f"{ROOT}/greenfield/explore/cache_nq_euopen_1s.csv"
ELIG=f"{ROOT}/greenfield/explore/B8-eligibility.csv"
B12=f"{ROOT}/greenfield/explore/B12-days.csv"
ET=ZoneInfo("America/New_York"); UTC=timezone.utc

MULT=20.0; COMM=5.0; STOP_SLIP=0.5
DATE_LO=sys.argv[1] if len(sys.argv)>1 else "2021-01-01"
DATE_HI=sys.argv[2] if len(sys.argv)>2 else "2030-01-01"
BOOK_OUT=sys.argv[3] if len(sys.argv)>3 else None   # optional: config,slip to dump
BOOK_CFG=sys.argv[4] if len(sys.argv)>4 else None    # e.g. "nostop_nogate"
BOOK_SLIP=float(sys.argv[5]) if len(sys.argv)>5 else 1.0

def et_epoch(dstr, h, m, s):
    y,mo,d=int(dstr[:4]),int(dstr[5:7]),int(dstr[8:10])
    return int(datetime(y,mo,d,h,m,s,tzinfo=ET).timestamp())

# load eligibility (only ok days)
ok=set()
for row in csv.DictReader(open(ELIG)):
    if row["eligible"]=="True" and row["reason"]=="ok":
        ok.add(row["date"])

# load atr14_prior + year
atr={}; yr={}
for row in csv.DictReader(open(B12)):
    d=row["trade_date"]; yr[d]=row["year"]
    v=row.get("atr14_prior","")
    atr[d]=float(v) if v not in ("",None) else None

# load cache grouped by date
days=defaultdict(list)  # date -> list[(ts,o,h,l,c)]
with open(CACHE) as f:
    f.readline()
    for line in f:
        p=line.split(",")
        d=p[0]
        if d<DATE_LO or d>DATE_HI: continue
        if d not in ok: continue
        days[d].append((int(p[1]),float(p[2]),float(p[3]),float(p[4]),float(p[5])))

def first_at_or_after(bars, ts):
    # bars sorted by ts; return first bar with bar.ts>=ts
    lo,hi=0,len(bars)
    while lo<hi:
        mid=(lo+hi)//2
        if bars[mid][0]<ts: lo=mid+1
        else: hi=mid
    return bars[lo] if lo<len(bars) else None

def last_at_or_before(bars, ts):
    lo,hi=0,len(bars)
    while lo<hi:
        mid=(lo+hi)//2
        if bars[mid][0]<=ts: lo=mid+1
        else: hi=mid
    return bars[lo-1] if lo>0 else None

# configs: (name, use_stop, use_gate)
CONFIGS=[("nostop_nogate",False,False),
         ("stop_nogate",True,False),
         ("nostop_gate",False,True),
         ("stop_gate",True,True)]
SLIPS=[0.5,1.0,1.5]

# results[cfg][slip] = list of (date, year, gross_pts, net_pnl)
results={c[0]:{s:[] for s in SLIPS} for c in CONFIGS}

for d in sorted(days):
    bars=days[d]
    if len(bars)<10: continue
    entry_ts=et_epoch(d,3,35,1)
    exit_ts =et_epoch(d,4,5,0)
    g0330_ts=et_epoch(d,3,30,0)
    g0335_ts=et_epoch(d,3,35,0)
    eb=first_at_or_after(bars, entry_ts)   # entry bar (open used)
    xb=first_at_or_after(bars, exit_ts)    # time-exit bar (open used)
    if eb is None or xb is None: continue
    if eb[0]>=exit_ts: continue            # entry after exit (shouldn't happen)
    entry_ref=eb[1]  # open
    exit_ref=xb[1]   # open (time exit reference, no slip)
    fill_ts=eb[0]
    # gate: first-5min move up>0
    b0330=first_at_or_after(bars,g0330_ts)
    b0335=last_at_or_before(bars,g0335_ts)
    gate_up = (b0330 is not None and b0335 is not None and b0335[3]>b0330[1])
    # window bars between fill and exit for stop walk
    a=atr.get(d)

    for name,use_stop,use_gate in CONFIGS:
        if use_gate and not gate_up: continue
        if use_stop and (a is None): continue
        for slip in SLIPS:
            entry_fill=entry_ref+slip  # buy adverse
            stop_price=entry_fill-0.3*a if use_stop else None
            # walk 1s bars from fill_ts (inclusive, ambiguity against) to exit_ts (exclusive)
            exit_price=None; exit_kind="time"
            if use_stop:
                for (ts,o,h,l,c) in bars:
                    if ts<fill_ts: continue
                    if ts>=exit_ts: break
                    if l<=stop_price:
                        exit_price=stop_price-STOP_SLIP; exit_kind="stop"; break
            if exit_price is None:
                exit_price=exit_ref-slip   # time exit, sell adverse
            gross_pts=exit_ref-entry_ref   # raw drift, no slip (census-comparable)
            if exit_kind=="stop":
                gross_pts=(stop_price)-entry_ref  # realized raw move to stop (approx)
            net_pnl=(exit_price-entry_fill)*MULT-COMM
            results[name][slip].append((d,yr.get(d,d[:4]),gross_pts,net_pnl,exit_kind))

def metrics(trades):
    n=len(trades)
    if n==0: return None
    net=[t[3] for t in trades]
    wins=[x for x in net if x>0]; losses=[x for x in net if x<=0]
    wr=len(wins)/n
    pf=(sum(wins)/abs(sum(losses))) if losses and sum(losses)!=0 else float('inf')
    mean=sum(net)/n
    sd=math.sqrt(sum((x-mean)**2 for x in net)/n) if n>1 else 0
    sharpe=(mean/sd*math.sqrt(252)) if sd>0 else 0
    # maxDD on cumulative
    cum=0; peak=0; mdd=0
    for x in net:
        cum+=x; peak=max(peak,cum); mdd=min(mdd,cum-peak)
    gross=sum(t[2] for t in trades)/n
    return dict(n=n,wr=wr,pf=pf,mean=mean,sharpe=sharpe,mdd=mdd,gross=gross,total=sum(net))

print(f"=== B8 sim  {DATE_LO}..{DATE_HI}  eligible-ok days ===")
for name,_,_ in CONFIGS:
    print(f"\n### CONFIG {name}")
    for slip in SLIPS:
        m=metrics(results[name][slip])
        if m is None:
            print(f"  slip {slip}: NO TRADES"); continue
        print(f"  slip {slip:.1f}pt: n={m['n']} WR={m['wr']*100:.1f}% PF={m['pf']:.2f} "
              f"Sharpe={m['sharpe']:.2f} maxDD=${m['mdd']:.0f} avgPnL=${m['mean']:.2f} "
              f"grossPts={m['gross']:.2f} total=${m['total']:.0f}")
    # per-year at slip 1.0
    print(f"  per-year @1.0pt slip:")
    by=defaultdict(list)
    for t in results[name][1.0]:
        by[t[1]].append(t)
    for y in sorted(by):
        m=metrics(by[y])
        print(f"    {y}: n={m['n']} WR={m['wr']*100:.1f}% PF={m['pf']:.2f} "
              f"avgPnL=${m['mean']:.2f} grossPts={m['gross']:.2f} total=${m['total']:.0f}")

# optional book dump
if BOOK_OUT and BOOK_CFG:
    trades=results[BOOK_CFG][BOOK_SLIP]
    with open(BOOK_OUT,"w") as f:
        f.write("date,pnl\n")
        for t in sorted(trades):
            f.write(f"{t[0]},{t[3]:.2f}\n")
    print(f"\nBOOK written: {BOOK_OUT} cfg={BOOK_CFG} slip={BOOK_SLIP} n={len(trades)}")
