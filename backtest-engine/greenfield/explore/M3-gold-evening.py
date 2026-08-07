"""M3 survivor — GOLD evening (Asian-session) LONG drift.
Mechanism: gold gets bid through the Asia/China session; the US-day (RTH)
demeaned drift is flat/negative while the evening is positive — a clock-locked
rotation, not just trend. Concrete trade: LONG at ENTER_ET close (enter that
bar's open is knowable since prior bar closed), exit at EXIT_ET.
Full char: $ dist (full GC + micro MGC), per-year, MAE, equity DD, placebo.
"""
import sys, random
sys.path.insert(0, ".")
import m3lib as L
from collections import defaultdict

STEP = 900
SYM = "gc"; PVv = L.PV[SYM]; MPV = L.MICRO_PV[SYM]
COSTP = 2*L.TICK[SYM]                # 2 ticks round trip
BARS = L.load("../../backtest-engine/data/macro/gc_15m.csv")
BY = L.index_by_ts(BARS)
def at(ts):
    i = BY.get(ts); return BARS[i] if i is not None else None

ENTER_ET = 18*60      # 18:00 ET
EXIT_H = 3            # hold 3h -> 12 bars
NBARS = EXIT_H*4

entries = {b["date"]: b for b in BARS if b["et_min"] == ENTER_ET and b["dow"] != 6}

def trade_from(entry):
    ex = at(entry["ts"] + STEP*(NBARS-1))
    if ex is None: return None
    # MAE: worst low between entry.open and exit (walk contiguous bars)
    mae = 0.0
    for k in range(NBARS):
        bb = at(entry["ts"] + STEP*k)
        if bb is None: return None      # gap -> skip trade
        mae = min(mae, bb["l"] - entry["o"])
    ret = ex["c"] - entry["o"] - COSTP  # LONG net points
    return ret, mae

def characterize(label, entry_map):
    rets, maes = [], []; byyr = defaultdict(list); eq = []
    dates = sorted(entry_map)
    for d in dates:
        r = trade_from(entry_map[d])
        if r is None: continue
        ret, mae = r
        rets.append(ret); maes.append(mae); byyr[d.year].append(ret)
        eq.append((eq[-1] if eq else 0)+ret)
    s = L.summ(rets)
    # max drawdown of equity (points)
    peak = 0; mdd = 0
    for x in eq:
        peak = max(peak, x); mdd = min(mdd, x-peak)
    print(f"\n=== {label} : LONG {ENTER_ET//60}:00 ET, hold {EXIT_H}h, net cost ===")
    print(f"  n={s['n']}  mean {s['mean']:+.3f}pt = ${s['mean']*PVv:+.0f}/GC ${s['mean']*MPV:+.1f}/MGC")
    print(f"  median {s['med']:+.3f}pt  wr {s['wr']:.1%}  t {s['tstat']:+.2f}  sd ${s['sd']*PVv:.0f}")
    print(f"  p10 ${s['p10']*PVv:+.0f}  p25 ${s['p25']*PVv:+.0f}  p75 ${s['p75']*PVv:+.0f}  p90 ${s['p90']*PVv:+.0f}")
    print(f"  worst trade ${s['minv']*PVv:+.0f}  best ${s['maxv']*PVv:+.0f}")
    print(f"  mean MAE ${sum(maes)/len(maes)*PVv:+.0f}/GC  median MAE ${L.pct(maes,.5)*PVv:+.0f}  p10 MAE ${L.pct(maes,.10)*PVv:+.0f}")
    print(f"  total ${sum(rets)*PVv:+.0f}/GC (${sum(rets)*MPV:+.0f}/MGC)  maxDD ${mdd*PVv:+.0f}/GC")
    print("  per-year: " + "  ".join(
        f"{y}: n{len(v)} ${sum(v)/len(v)*PVv:+.0f}/tr wr{sum(1 for x in v if x>0)/len(v):.0%} tot${sum(v)*PVv:+.0f}"
        for y, v in sorted(byyr.items())))
    return rets

rets = characterize("GOLD EVENING", entries)

# ---- Placebo A: same trade but random ET entry hour (per day), 200 shuffles ----
print("\n=== PLACEBO A: random ET entry-hour (does the 18:00 window specifically carry it?) ===")
all_hours_bars = defaultdict(dict)   # date -> et_min -> bar
for b in BARS:
    if b["dow"] != 6: all_hours_bars[b["date"]][b["et_min"]] = b
cand_slots = list(range(0, 24*60, 60))   # top of each hour
random.seed(1)
means = []
for _ in range(200):
    tot = []
    for d in sorted(entries):
        slot = random.choice(cand_slots)
        eb = all_hours_bars[d].get(slot)
        if eb is None: continue
        r = trade_from(eb)
        if r: tot.append(r[0])
    if tot: means.append(sum(tot)/len(tot))
means.sort()
actual = sum(rets)/len(rets)
above = sum(1 for m in means if m >= actual)/len(means)
print(f"  actual mean ${actual*PVv:+.0f}/GC ; placebo mean-hour dist: "
      f"p50 ${L.pct(means,.5)*PVv:+.0f} p90 ${L.pct(means,.9)*PVv:+.0f} p99 ${L.pct(means,.99)*PVv:+.0f}")
print(f"  fraction of random-hour placebos >= actual: {above:.3f}  (low = evening window is special)")

# ---- Control: US RTH gold same-length hold (10:00 ET) demeaned comparison ----
print("\n=== CONTROL: same 3h LONG at 10:00 ET (US day) ===")
rth = {b["date"]: b for b in BARS if b["et_min"] == 10*60 and b["dow"] != 6}
_ = characterize("GOLD US-DAY 10:00", rth)
