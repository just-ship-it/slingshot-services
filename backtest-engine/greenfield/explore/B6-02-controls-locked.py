#!/usr/bin/env python3
"""
B6 controls + locked run. Frozen config declared in B6-compressed-on-continuation.md
BEFORE the locked run:  D=10:30 | filter=none | exit=noon(12:00) time | stop=0.4*ATR14.

Usage:
  python3 B6-02-controls-locked.py controls   # dev 2021-2024 controls + slippage sens
  python3 B6-02-controls-locked.py locked      # 2025-2026 single frozen config, verbatim
"""
import sys
import importlib.util
import pandas as pd

_spec = importlib.util.spec_from_file_location(
    "b6sim", "/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore/B6-01-sim.py")
_b6 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_b6)
load, eligible_mask, build_rows, summarize, cfg_label = (
    _b6.load, _b6.eligible_mask, _b6.build_rows, _b6.summarize, _b6.cfg_label)

# frozen config
FD = (10, 30)
FFILT = None
FEXIT = ("time", 12, 0)
FSTOP = 0.4


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "controls"
    ts, o, h, l, c, dayidx, days = load()
    comp_mask, noncomp_mask = eligible_mask(days, dayidx)
    comp = days[comp_mask].copy()
    noncomp = days[noncomp_mask].copy()
    comp_dates = pd.to_datetime(comp["trade_date"])
    noncomp_dates = pd.to_datetime(noncomp["trade_date"])
    flabel = cfg_label(FD, FFILT, FEXIT, FSTOP)

    if mode == "controls":
        print("=" * 130)
        print(f"FROZEN CONFIG: {flabel}")
        print("CONTROLS + SLIPPAGE SENSITIVITY — DEV 2021-2024 ONLY")
        print("=" * 130)

        # strategy itself (dev) for reference
        rows = build_rows(comp, dayidx, ts, o, h, l, c, FD[0], FD[1], FFILT, FEXIT, FSTOP)
        m, _ = summarize(rows, comp_dates, "STRAT compressed x aligned-dir", 2021, 2024)
        print("STRAT :", fmt(m))

        # 2x slippage sensitivity
        rows2 = build_rows(comp, dayidx, ts, o, h, l, c, FD[0], FD[1], FFILT, FEXIT, FSTOP,
                           slip_mult=2.0)
        m2, _ = summarize(rows2, comp_dates, "STRAT 2x-slippage", 2021, 2024)
        print("2xSLP :", fmt(m2))

        # CONTROL 1: compression load-bearing -> same rule on NON-compressed days
        rc = build_rows(noncomp, dayidx, ts, o, h, l, c, FD[0], FD[1], FFILT, FEXIT, FSTOP)
        mc, _ = summarize(rc, noncomp_dates, "CTRL1 non-compressed same rule", 2021, 2024)
        print("CTRL1 :", fmt(mc))

        # CONTROL 2: direction load-bearing -> compressed UNCONDITIONAL LONG
        rl = build_rows(comp, dayidx, ts, o, h, l, c, FD[0], FD[1], FFILT, FEXIT, FSTOP,
                        force_side=1)
        ml, _ = summarize(rl, comp_dates, "CTRL2 compressed uncond-LONG", 2021, 2024)
        print("CTRL2 :", fmt(ml))
        # also unconditional SHORT for completeness
        rs = build_rows(comp, dayidx, ts, o, h, l, c, FD[0], FD[1], FFILT, FEXIT, FSTOP,
                        force_side=-1)
        ms, _ = summarize(rs, comp_dates, "        compressed uncond-SHORT", 2021, 2024)
        print("      :", fmt(ms))

    elif mode == "locked":
        print("=" * 130)
        print(f"LOCKED RUN 2025-2026 — frozen config {flabel} — verbatim, run ONCE")
        print("=" * 130)
        rows = build_rows(comp, dayidx, ts, o, h, l, c, FD[0], FD[1], FFILT, FEXIT, FSTOP)
        m, _ = summarize(rows, comp_dates, "STRAT locked 2025-2026", 2025, 2026)
        print("STRAT :", fmt(m))
        rows2 = build_rows(comp, dayidx, ts, o, h, l, c, FD[0], FD[1], FFILT, FEXIT, FSTOP,
                           slip_mult=2.0)
        m2, _ = summarize(rows2, comp_dates, "STRAT locked 2x-slippage", 2025, 2026)
        print("2xSLP :", fmt(m2))
        # locked controls too
        rc = build_rows(noncomp, dayidx, ts, o, h, l, c, FD[0], FD[1], FFILT, FEXIT, FSTOP)
        mc, _ = summarize(rc, noncomp_dates, "CTRL1 non-comp locked", 2025, 2026)
        print("CTRL1 :", fmt(mc))
        rl = build_rows(comp, dayidx, ts, o, h, l, c, FD[0], FD[1], FFILT, FEXIT, FSTOP,
                        force_side=1)
        ml, _ = summarize(rl, comp_dates, "CTRL2 compressed uncond-LONG locked", 2025, 2026)
        print("CTRL2 :", fmt(ml))
        # full-sample strategy (2021-2026) for the >=100 trades / overall PF bar
        mf, _ = summarize(rows, comp_dates, "STRAT FULL 2021-2026", 2021, 2026)
        print("FULL  :", fmt(mf))


def fmt(m):
    from B12_sim import fmt_row
    line = fmt_row(m)
    if m.get("n", 0):
        line += f" grossPt={m['avg_gross']} netPt={m['avg_net_pts']}"
    return line


if __name__ == "__main__":
    main()
