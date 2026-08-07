"""M3 — 1h DEMEANED drift census on LONGER history (crude 2019+, gold 2022+).
Per-year-demeaned (subtract each year's ambient hourly drift), hold N hours.
Out-of-sample extension of the 15m finding across more calendar years.
"""
import sys
sys.path.insert(0, ".")
import m3lib as L
from collections import defaultdict

STEP = 3600
COSTP = {"cl": 2*L.TICK["cl"], "gc": 2*L.TICK["gc"]}

def census(sym, path, N):
    BARS = L.load(path); BY = L.index_by_ts(BARS)
    def at(ts):
        i = BY.get(ts); return BARS[i] if i is not None else None
    PVv = L.PV[sym]; cost = COSTP[sym]
    obs = []; yr_all = defaultdict(list)
    for b in BARS:
        if b["dow"] == 6: continue
        ex = at(b["ts"] + STEP*(N-1))
        if ex is None: continue
        fwd = ex["c"] - b["o"]
        obs.append((b["dt"].year, b["et_min"], fwd)); yr_all[b["dt"].year].append(fwd)
    ybar = {y: sum(v)/len(v) for y, v in yr_all.items()}
    slot = defaultdict(lambda: defaultdict(list))
    for y, m, f in obs: slot[m][y].append(f - ybar[y])
    rows = []
    for m, yd in slot.items():
        allv = [x for v in yd.values() for x in v]
        if len(allv) < 100: continue
        ymeans = {y: sum(v)/len(v) for y, v in yd.items() if len(v) >= 25}
        if len(ymeans) < 3: continue
        signs = [1 if v > 0 else -1 for v in ymeans.values()]
        cons = all(x == signs[0] for x in signs)
        s = L.summ(allv); dirn = 1 if s["mean"] > 0 else -1
        net = dirn*s["mean"] - cost
        rows.append((m, s, ymeans, cons, net, dirn, len(allv)))
    rows.sort(key=lambda r: -(r[4] if r[3] else -9))
    hh = lambda m: f"{m//60:02d}:{m%60:02d}"
    nyr = len(ybar)
    print(f"\n##### {sym.upper()} 1h DEMEANED, hold {N}h. years={sorted(ybar)} #####")
    shown = 0
    for m, s, ym, cons, net, dirn, n in rows:
        if not cons: continue
        yl = " ".join(f"{y}:{v*PVv:+.0f}" for y, v in sorted(ym.items()))
        dl = "LONG " if dirn > 0 else "SHORT"
        print(f" {hh(m)} n{n:4d} {dl} demean{s['mean']*PVv:+6.0f}$ net{net*PVv:+6.0f}$ "
              f"wr{s['wr']:.0%} t{s['tstat']:+.1f}  [{yl}]")
        shown += 1
        if shown >= 12: break
    if shown == 0: print("  (no all-year-consistent slots)")

for sym, path in [("cl","../../backtest-engine/data/macro/cl_1h.csv"),
                  ("gc","../../backtest-engine/data/macro/gc_1h.csv")]:
    for N in (1, 2, 3):
        census(sym, path, N)
