"""M3 #3 — clock-locked signed time-of-day DRIFT census.
For each ET 15m slot, enter at that bar's OPEN (knowable: prior bar closed),
hold N bars, measure SIGNED forward return. Look for slots with a stable
per-year signed drift that beats commodity costs. Includes settlement windows
(gold ~13:30 ET, crude ~14:30 ET) and session opens.
Baseline = the unconditional distribution across all slots (ambient).
"""
import sys
sys.path.insert(0, ".")
import m3lib as L

STEP = 900
COSTP = {"cl": 2*L.TICK["cl"], "gc": 2*L.TICK["gc"]}

def run(sym, path, N):
    BARS = L.load(path); BY = L.index_by_ts(BARS)
    def at(ts):
        i = BY.get(ts); return BARS[i] if i is not None else None
    PVv = L.PV[sym]; cost = COSTP[sym]
    from collections import defaultdict
    slot = defaultdict(list)          # et_min -> list of (year, signed_fwd)
    for b in BARS:
        if b["dow"] == 6: continue    # skip Sun session-open oddity for census
        ex = at(b["ts"] + STEP*(N-1))
        if ex is None: continue
        fwd = ex["c"] - b["o"]        # LONG forward return (points)
        slot[b["et_min"]].append((b["dt"].year, fwd))
    rows = []
    for m, lst in slot.items():
        vals = [f for _, f in lst]
        s = L.summ(vals)
        if s["n"] < 60: continue
        # per-year mean sign consistency (long drift)
        yr = defaultdict(list)
        for y, f in lst: yr[y].append(f)
        ymeans = {y: sum(v)/len(v) for y, v in yr.items() if len(v) >= 15}
        if len(ymeans) < 2: continue
        signs = [1 if v > 0 else -1 for v in ymeans.values()]
        consistent = all(x == signs[0] for x in signs)
        # net edge in the drift direction (sign of overall mean), after cost
        dirn = 1 if s["mean"] > 0 else -1
        net = dirn*s["mean"] - cost
        rows.append((m, s, ymeans, consistent, net, dirn))
    # rank by |net| among per-year-consistent slots
    rows.sort(key=lambda r: -(r[4] if r[3] else -9))
    hh = lambda m: f"{m//60:02d}:{m%60:02d}"
    print(f"\n##### {sym.upper()} 15m drift census, hold {N} bars ({N*15}min) — top per-year-consistent slots #####")
    print(" ETtime  n   longMean  net$dir/full  wr   per-year means($/full)")
    shown=0
    for m, s, ymeans, cons, net, dirn in rows:
        if not cons: continue
        yl = " ".join(f"{y}:{v*PVv:+.0f}" for y,v in sorted(ymeans.items()))
        dl = "LONG" if dirn>0 else "SHORT"
        print(f" {hh(m)} {s['n']:4d} {s['mean']*PVv:+7.0f}$ {dl} net{net*PVv:+6.0f}$ wr{s['wr']:.0%}  [{yl}]")
        shown+=1
        if shown>=12: break
    if shown==0: print(" (no per-year-consistent slots)")

for sym, path in [("cl","../../backtest-engine/data/macro/cl_15m.csv"),
                  ("gc","../../backtest-engine/data/macro/gc_15m.csv")]:
    for N in (2, 4, 8):
        run(sym, path, N)
