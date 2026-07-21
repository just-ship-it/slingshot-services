#!/usr/bin/env python3
"""
B4a — PRE-CLOSE CONTINUATION, honest 1s sim.

Hypothesis under test (from sibling census; treated as hypothesis only):
15:00->15:30 ET NQ return continues the 09:30->15:00 move (gross ~+5.2pts aligned).

Design (pre-registered, dev = 2021-2024 only):
  Signal at 15:00:00 ET: day_move = close of last 1s bar with ts < 15:00:00
  minus open of first 1s bar with ts >= 09:30:00 (both knowable at 15:00:00).
  Enter aligned (long if day_move>0, short if <0; skip if 0) MARKET placed at
  15:00:01 -> fills next 1s bar open + adverse slip.
  Grid (24 configs, all disclosed):
    |move| filter  in {none, >0.15*ATR14, >0.30*ATR14}   (ATR14 = prior-day 14d ATR)
    vol gate       in {none, top trailing-250d ATR14 tercile (strictly-prior window)}
    exit           in {15:30:00 market, 15:45:00 market}
    stop           in {none, 25pt fixed}
Eligibility: day in 1s cache, full RTH session, no intraday contract roll
(rth_same_sym), ATR14 + tercile knowable, 1s signal bar within 120s of 15:00.
Usage:
  python3 B4-01-preclose.py dev         # full grid, 2021-2024
  python3 B4-01-preclose.py frozen      # FROZEN config only, 2025-2026 (run ONCE)
"""
import sys
import numpy as np
from B4_common import (load_1s_npz, load_days_features, sim_market_hold,
                       run_metrics, fmt_row, et_epoch)

MODE = sys.argv[1] if len(sys.argv) > 1 else "dev"
YEARS = {"dev": (2021, 2024), "frozen": (2025, 2026)}[MODE]

# FROZEN CONFIG (declared in B4-preclose-expiry.md BEFORE the frozen run):
FROZEN = dict(fmove=0.30, vgate=False, exit_hm=(15, 30), stop=None)

ts, o, h, l, c, dayidx = load_1s_npz()
days = load_days_features()
days = days.set_index(days.trade_date.dt.strftime("%Y-%m-%d"))

# ---- per-day signal precompute -------------------------------------------------
sig = {}  # date -> dict
skipped = {"not_in_days": 0, "not_full": 0, "roll": 0, "atr": 0, "cover": 0, "zero": 0}
for d, (a, b) in dayidx.items():
    y = int(d[:4])
    if not (YEARS[0] <= y <= YEARS[1]):
        continue
    if d not in days.index:
        skipped["not_in_days"] += 1
        continue
    r = days.loc[d]
    if not r.full_rth:
        skipped["not_full"] += 1
        continue
    if not r.rth_same_sym:
        skipped["roll"] += 1
        continue
    if not r.atr_terc_known:
        skipped["atr"] += 1
        continue
    td = r.trade_date
    t0930 = et_epoch(td, 9, 30)
    t1500 = et_epoch(td, 15, 0)
    dts = ts[a:b]
    i0 = int(np.searchsorted(dts, t0930, "left"))
    j = int(np.searchsorted(dts, t1500, "left"))
    if i0 >= len(dts) or dts[i0] > t0930 + 30 or j == 0 or dts[j - 1] < t1500 - 120:
        skipped["cover"] += 1
        continue
    open0930 = o[a:b][i0]
    sig_px = c[a:b][j - 1]
    move = sig_px - open0930
    if move == 0:
        skipped["zero"] += 1
        continue
    sig[d] = dict(a=a, b=b, td=td, side=1 if move > 0 else -1, move=move,
                  atr=r.atr14_prior, top=bool(r.atr_top_terc),
                  t1500=t1500)
print(f"[B4a {MODE}] eligible days: {len(sig)}  skipped: {skipped}")

universe = [s["td"] for s in sig.values()]


def run_config(fmove, vgate, exit_hm, stop, slip_mult=1.0):
    rows, gross = [], []
    for d, s in sig.items():
        if fmove is not None and abs(s["move"]) <= fmove * s["atr"]:
            continue
        if vgate and not s["top"]:
            continue
        flat_ts = et_epoch(s["td"], *exit_hm)
        tr = sim_market_hold(ts, o, h, l, c, s["a"], s["b"], s["side"],
                             s["t1500"] + 1, flat_ts, stop_pts=stop,
                             slip_mult=slip_mult)
        if tr is None:
            continue
        rows.append(dict(trade_date=s["td"], pnl=tr["pnl"],
                         hold_s=tr["exit_ts"] - tr["entry_ts"]))
        if tr["gross_pts"] is not None:
            gross.append(tr["gross_pts"])
    lab = (f"mv>{fmove if fmove is not None else '-'} "
           f"{'topATR' if vgate else 'allvol'} ex{exit_hm[0]:02d}{exit_hm[1]:02d} "
           f"st{stop if stop else '-'}" + (" 2xslip" if slip_mult > 1 else ""))
    m = run_metrics(rows, universe, lab)
    m["gross_pts_mean"] = round(float(np.mean(gross)), 2) if gross else None
    return m


configs = ([FROZEN] if MODE == "frozen" else
           [dict(fmove=f, vgate=v, exit_hm=e, stop=st)
            for f in (None, 0.15, 0.30) for v in (False, True)
            for e in ((15, 30), (15, 45)) for st in (None, 25)])

print(f"\n=== B4a {MODE} {YEARS[0]}-{YEARS[1]} | slip 1x ===")
for cfg in configs:
    m = run_config(**cfg)
    print(fmt_row(m), f"grossPts={m.get('gross_pts_mean')}")
print(f"\n=== B4a {MODE} {YEARS[0]}-{YEARS[1]} | slip 2x (sensitivity) ===")
for cfg in configs:
    m = run_config(**cfg, slip_mult=2.0)
    print(fmt_row(m))
