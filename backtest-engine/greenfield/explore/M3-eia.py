"""M3 #1 — CRUDE EIA inventory reaction (Wed 10:30 ET proxy).
Signal = 10:30 ET bar move (close-open), knowable at 10:45 close.
Enter next bar (10:45 open), test CONTINUATION vs FADE over horizons.
Baseline = same-time move on non-Wed days. Placebo included.
"""
import sys, statistics
sys.path.insert(0, ".")
import m3lib as L

STEP = 900  # 15m in seconds
SYM = "cl"
BARS = L.load("../../backtest-engine/data/macro/cl_15m.csv")
BY = L.index_by_ts(BARS)
PVv = L.PV[SYM]; MPV = L.MICRO_PV[SYM]
# cost: 1 tick/side slippage (entry+exit=2 ticks) + ~$4 commission RT per full contract
COST_PTS = 2 * L.TICK[SYM]              # points of slippage round trip
COST_USD_FULL = COST_PTS * PVv + 4.0   # ~ $24 per CL round trip
COST_USD_MICRO = COST_PTS * MPV + 1.5  # ~ $3.5 per MCL round trip

def bar_at(ts):
    i = BY.get(ts)
    return BARS[i] if i is not None else None

def signal_bar(day_dt):
    """the 10:30 ET bar for the date of day_dt."""
    return None

# Build a map: date -> 10:30 bar
tenthirty = {b["date"]: b for b in BARS if b["et_min"] == 630}
ninethirty = {b["date"]: b for b in BARS if b["et_min"] == 570}  # 09:30 for pre-drift

def forward_ret(entry_bar, nbars):
    """signed forward move: exit at close of entry+nbars-1 (contiguous)."""
    ts = entry_bar["ts"]
    exit_ts = ts + STEP * (nbars - 1)
    ex = bar_at(exit_ts)
    if ex is None: return None
    return ex["c"] - entry_bar["o"]

def study(day_filter, label, horizons=(2, 4, 6)):
    """day_filter(dow)->bool. Returns continuation & fade stats per horizon."""
    res = {}
    for N in horizons:
        cont, fade, raw_r0 = [], [], []
        by_year_cont = {}
        for date, b0 in tenthirty.items():
            if not day_filter(b0["dow"]): continue
            r0 = b0["c"] - b0["o"]           # signal move (knowable at 10:45)
            if r0 == 0: continue
            entry = bar_at(b0["ts"] + STEP)  # 10:45 bar
            if entry is None: continue
            fwd = forward_ret(entry, N)
            if fwd is None: continue
            d = 1 if r0 > 0 else -1
            c_ret = d * fwd - COST_PTS       # continuation, net cost (points)
            f_ret = -d * fwd - COST_PTS      # fade, net cost
            cont.append(c_ret); fade.append(f_ret); raw_r0.append(r0)
            by_year_cont.setdefault(date.year, []).append(c_ret)
        res[N] = dict(cont=L.summ(cont), fade=L.summ(fade),
                      r0=L.summ([abs(x) for x in raw_r0]),
                      by_year={y: L.summ(v) for y, v in sorted(by_year_cont.items())})
    return label, res

def print_study(label, res):
    print(f"\n=== {label} ===")
    for N, r in res.items():
        mins = N * 15
        print(f" horizon {mins}min ({N} bars):  |r0| " + L.fmt(r["r0"]))
        cs = r["cont"]
        print(f"   CONTINUATION net: " + L.fmt(cs) +
              f"  ${cs['mean']*PVv:+.0f}/CL ${cs['mean']*MPV:+.1f}/MCL")
        print(f"   FADE         net: " + L.fmt(r["fade"]))
        # per year continuation
        yline = "   cont by year: " + "  ".join(
            f"{y}:{s['mean']*PVv:+.0f}$(n{s['n']},wr{s['wr']:.0%})"
            for y, s in r["by_year"].items())
        print(yline)

# EIA = Wednesday (dow==2)
_, eia = study(lambda d: d == 2, "CRUDE Wed-10:30 (EIA proxy)")
print_study("CRUDE Wed-10:30 (EIA proxy)", eia)

# control: non-Wed weekdays same time
_, ctrl = study(lambda d: d in (0, 1, 3, 4), "CRUDE non-Wed weekday 10:30 (control)")
print_study("CRUDE non-Wed weekday 10:30 (control)", ctrl)

# per-day-of-week breakdown at 10:30 for continuation (horizon 4 = 60min)
print("\n=== per-DOW 10:30 continuation, 60min horizon ===")
for d, name in [(0,"Mon"),(1,"Tue"),(2,"Wed"),(3,"Thu"),(4,"Fri")]:
    _, r = study(lambda x, dd=d: x == dd, name, horizons=(4,))
    s = r[4]["cont"]
    print(f" {name}: " + L.fmt(s) + f"  ${s['mean']*PVv:+.0f}/CL")

# pre-report drift: 09:30 -> 10:30 close, Wed vs control
print("\n=== pre-report drift 09:30open -> 10:30close (Wed vs ctrl) ===")
for lab, filt in [("Wed", lambda d: d == 2), ("ctrl", lambda d: d in (0,1,3,4))]:
    vals = []
    for date, b930 in ninethirty.items():
        if not filt(b930["dow"]): continue
        b1030 = tenthirty.get(date)
        if b1030 is None: continue
        vals.append(b1030["c"] - b930["o"])
    print(f" {lab}: " + L.fmt(L.summ(vals)))
