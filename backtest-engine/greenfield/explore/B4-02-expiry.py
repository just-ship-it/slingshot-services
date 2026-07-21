#!/usr/bin/env python3
"""
B4b — MONTHLY-EXPIRY MORNING WEAKNESS, honest 1s sim.

Hypothesis under test (from sibling census; hypothesis only): on 3rd-Friday
MONTHLY expirations (non-quarterly; R2-calendar exp_class == 'monthly',
verified against the actual 3rd-Friday calendar), 09:30->10:30 is weak
(census mean -45pts / median -54, 64% negative). n is thin by construction
(~8/yr): verdicts capped at suggestive/not-establishable unless overwhelming.

Design (pre-registered, dev = 2021-2024): SHORT market placed 09:30:01,
exit 10:30:00 market. Grid (4 configs):
  stop in {none, 40pt} x gap-skip in {none, skip if gap-down > 0.3*ATR14
  (gap = RTH open - prior RTH close, both knowable at 09:30)}
Eligibility: monthly-class expiry day present in 1s cache, no intraday roll
(rth_same_sym), ATR14 known, 09:30 bar present within 30s.
Also printed (descriptive only, no sweep): same construction on QUARTERLY
3rd Fridays, and long on weekly Fridays -- context lines, not configs.
Usage:
  python3 B4-02-expiry.py dev      # grid on 2021-2024
  python3 B4-02-expiry.py frozen   # FROZEN config only, 2025-2026 (run ONCE)
"""
import sys
import numpy as np
import pandas as pd
from B4_common import (BASE, load_1s_npz, load_days_features, sim_market_hold,
                       run_metrics, fmt_row, et_epoch)

MODE = sys.argv[1] if len(sys.argv) > 1 else "dev"
YEARS = {"dev": (2021, 2024), "frozen": (2025, 2026)}[MODE]

# FROZEN CONFIG (declared in B4-preclose-expiry.md BEFORE the frozen run):
FROZEN = dict(stop=None, gapskip=False)

ts, o, h, l, c, dayidx = load_1s_npz()
days = load_days_features()
days = days.set_index(days.trade_date.dt.strftime("%Y-%m-%d"))
cal = pd.read_csv(f"{BASE}/R2-calendar.csv", parse_dates=["trade_date"])
cal["d"] = cal.trade_date.dt.strftime("%Y-%m-%d")


def build_universe(exp_classes):
    out = {}
    for d in cal[cal.exp_class.isin(exp_classes)]["d"]:
        y = int(d[:4])
        if not (YEARS[0] <= y <= YEARS[1]) or d not in dayidx or d not in days.index:
            continue
        r = days.loc[d]
        if not r.rth_same_sym or np.isnan(r.atr14_prior):
            continue
        a, b = dayidx[d]
        t0930 = et_epoch(r.trade_date, 9, 30)
        dts = ts[a:b]
        i0 = int(np.searchsorted(dts, t0930, "left"))
        if i0 >= len(dts) or dts[i0] > t0930 + 30:
            continue
        out[d] = dict(a=a, b=b, td=r.trade_date, atr=r.atr14_prior,
                      gap=r.gap, t0930=t0930)
    return out


def run(uni, side, stop, gapskip, slip_mult=1.0, label=""):
    rows, gross = [], []
    for d, s in uni.items():
        if gapskip and not np.isnan(s["gap"]) and s["gap"] < -0.30 * s["atr"]:
            continue
        tr = sim_market_hold(ts, o, h, l, c, s["a"], s["b"], side,
                             s["t0930"] + 1, et_epoch(s["td"], 10, 30),
                             stop_pts=stop, slip_mult=slip_mult)
        if tr is None:
            continue
        rows.append(dict(trade_date=s["td"], pnl=tr["pnl"],
                         hold_s=tr["exit_ts"] - tr["entry_ts"]))
        if tr["gross_pts"] is not None:
            gross.append(tr["gross_pts"])
    m = run_metrics(rows, [s["td"] for s in uni.values()], label)
    m["gross_pts_mean"] = round(float(np.mean(gross)), 2) if gross else None
    m["gross_pts_med"] = round(float(np.median(gross)), 2) if gross else None
    return m


uni_m = build_universe(["monthly"])
print(f"[B4b {MODE}] monthly-expiry eligible days: {len(uni_m)} "
      f"({sorted(uni_m)[:3]}...{sorted(uni_m)[-1:]})")

configs = ([FROZEN] if MODE == "frozen" else
           [dict(stop=st, gapskip=g) for st in (None, 40) for g in (False, True)])

print(f"\n=== B4b {MODE} {YEARS[0]}-{YEARS[1]} SHORT 09:30:01->10:30 | slip 1x ===")
for cfg in configs:
    lab = f"short st{cfg['stop'] or '-'} {'skipgapdn' if cfg['gapskip'] else 'plain'}"
    m = run(uni_m, -1, cfg["stop"], cfg["gapskip"], label=lab)
    print(fmt_row(m), f"grossPts mean={m.get('gross_pts_mean')} med={m.get('gross_pts_med')}")
print(f"\n=== B4b {MODE} | slip 2x (sensitivity) ===")
for cfg in configs:
    lab = f"short st{cfg['stop'] or '-'} {'skipgapdn' if cfg['gapskip'] else 'plain'} 2xslip"
    m = run(uni_m, -1, cfg["stop"], cfg["gapskip"], slip_mult=2.0, label=lab)
    print(fmt_row(m))

if MODE == "dev":
    print("\n--- context lines (descriptive, NOT configs) ---")
    uni_q = build_universe(["quarterly"])
    m = run(uni_q, -1, None, False, label="quarterly 3rdFri short (context)")
    print(fmt_row(m), f"grossPts mean={m.get('gross_pts_mean')} med={m.get('gross_pts_med')}")
    wk = cal[(cal.exp_class == "weekly_fri")]["d"]
    uni_w = {d: s for d, s in build_universe(["weekly_fri"]).items()}
    m = run(uni_w, -1, None, False, label="weekly-Fri short (context)")
    print(fmt_row(m), f"grossPts mean={m.get('gross_pts_mean')} med={m.get('gross_pts_med')}")
