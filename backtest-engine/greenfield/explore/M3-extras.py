"""M3 extras — close out remaining hypotheses:
 (2) crude API Tue ~16:30 ET reaction
 (3b) gold COMEX settlement ~13:30 ET drift
 (1c) EIA magnitude-conditioned continuation (big reaction only)
"""
import sys
sys.path.insert(0, ".")
import m3lib as L
from collections import defaultdict
STEP = 900

def load(sym): return L.load(f"../../backtest-engine/data/macro/{sym}_15m.csv")

def simple_long(bars, et_min, nbars, sym, label, dowset=None):
    BY = L.index_by_ts(bars)
    def at(ts):
        i = BY.get(ts); return bars[i] if i is not None else None
    PVv = L.PV[sym]; cost = 2*L.TICK[sym]
    ent = {b["date"]: b for b in bars if b["et_min"] == et_min and b["dow"] != 6
           and (dowset is None or b["dow"] in dowset)}
    rets = []; byyr = defaultdict(list)
    for d, b in ent.items():
        ex = at(b["ts"]+STEP*(nbars-1))
        if ex is None: continue
        r = ex["c"]-b["o"]-cost
        rets.append(r); byyr[d.year].append(r)
    s = L.summ(rets)
    if s.get("n",0)==0:
        print(f" {label}: n=0 (data gap in hold window — e.g. 17:00-18:00 ET CME break)"); return
    yl = " ".join(f"{y}:${sum(v)/len(v)*PVv:+.0f}(n{len(v)})" for y,v in sorted(byyr.items()))
    print(f" {label}: n{s['n']} mean${s['mean']*PVv:+.0f}/full med${s['med']*PVv:+.0f} wr{s['wr']:.0%} t{s['tstat']:+.2f} [{yl}]")

CL = load("cl"); GC = load("gc")

print("=== (2) CRUDE API Tue ~16:30 ET reaction (enter 16:30, hold 1h/2h) ===")
for n,lab in [(2,"16:30 +30m"),(4,"16:30 +1h")]:
    simple_long(CL, 16*60+30, n, "cl", "CL Tue "+lab+" LONG", dowset={1})
# also fade/continuation on the 16:00 bar move before API not meaningful; skip

print("\n=== (3b) GOLD COMEX settlement ~13:30 ET (enter 13:30, hold 30m/1h) ===")
for n,lab in [(2,"+30m"),(4,"+1h")]:
    simple_long(GC, 13*60+30, n, "gc", "GC 13:30 "+lab+" LONG (all days)")
# just Wed FOMC-ish? skip event-date proxy

print("\n=== (1c) CRUDE EIA magnitude-conditioned continuation (Wed 10:30) ===")
# signal r0 = 10:30 bar move; only trade when |r0| in top tercile; enter 10:45, hold 4 bars
BY = L.index_by_ts(CL)
def at(ts):
    i = BY.get(ts); return CL[i] if i is not None else None
tt = {b["date"]: b for b in CL if b["et_min"]==630 and b["dow"]==2}
r0s = sorted(abs(b["c"]-b["o"]) for b in tt.values())
thr = L.pct(r0s, 0.66)
PVv = L.PV["cl"]; cost=2*L.TICK["cl"]
for mode in ("CONT","FADE"):
    rets=[]; byyr=defaultdict(list)
    for d,b in tt.items():
        r0=b["c"]-b["o"]
        if abs(r0) < thr: continue
        e=at(b["ts"]+STEP)
        if e is None: continue
        ex=at(e["ts"]+STEP*3)
        if ex is None: continue
        dirn=(1 if r0>0 else -1)*(1 if mode=="CONT" else -1)
        r=dirn*(ex["c"]-e["o"])-cost
        rets.append(r); byyr[d.year].append(r)
    s=L.summ(rets)
    yl=" ".join(f"{y}:${sum(v)/len(v)*PVv:+.0f}" for y,v in sorted(byyr.items()))
    print(f" EIA big-move(|r0|>{thr:.2f}) {mode} hold1h: n{s['n']} mean${s['mean']*PVv:+.0f} wr{s['wr']:.0%} t{s['tstat']:+.2f} [{yl}]")
