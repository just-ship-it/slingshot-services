#!/usr/bin/env python3
"""B9 driver — design grid (2021-2024) and, on demand, the LOCKED run (2025-2026).

Usage:
  python3 B9_run.py design      # 8-config grid x 2 slippage, 2021-2024 only
  python3 B9_run.py full        # full-sample per-year for a chosen config (design aid)
  python3 B9_run.py locked      # frozen config on 2025-2026 (RUN ONCE)
  python3 B9_run.py book        # write book-gapfade-daily.csv for frozen config, full sample
"""
import sys
import numpy as np
import pandas as pd

sys.path.insert(0, "/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore")
from B9_sim import (load_1s_npz, load_days, eligible_days, run_config, fmt_row)  # noqa

DESIGN_YEARS = [2021, 2022, 2023, 2024]
LOCKED_YEARS = [2025, 2026]

# frozen config (declared in B9-gapup-fade.md BEFORE the locked run)
FROZEN = dict(K=0.5, exit_hh=11, exit_mm=0, stop_atr_mult=None)


def grid_configs():
    cfgs = []
    for K in (0.3, 0.5):
        for (eh, em) in ((11, 0), (12, 0)):
            for stop in (None, 0.5):
                cfgs.append(dict(K=K, exit_hh=eh, exit_mm=em, stop_atr_mult=stop))
    return cfgs


def cfg_label(cfg, slip):
    s = "noStop" if cfg["stop_atr_mult"] is None else f"stop{cfg['stop_atr_mult']}ATR"
    return f"K{cfg['K']} {cfg['exit_hh']:02d}:{cfg['exit_mm']:02d} {s} slip{slip}"


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "design"
    ts, o, h, l, c, dayidx = load_1s_npz()
    days = load_days()
    base = eligible_days(days)

    if mode == "design":
        for slip in (0.5, 1.0):
            print(f"\n===== DESIGN GRID  slip={slip}pt/side  years {DESIGN_YEARS} =====")
            for cfg in grid_configs():
                m = run_config(ts, o, h, l, c, dayidx, base, cfg["K"], cfg["exit_hh"],
                               cfg["exit_mm"], cfg["stop_atr_mult"], slip,
                               years=DESIGN_YEARS, label=cfg_label(cfg, slip))
                extra = f" grossPt/tr={m.get('gross_pts_avg')} stop%={m.get('stop_rate')}"
                print(fmt_row(m) + extra)

    elif mode == "full":
        # full-sample per-year for frozen + neighbors (design aid, not the locked decision)
        for slip in (0.5, 1.0):
            print(f"\n===== FULL SAMPLE (all years, design aid)  slip={slip} =====")
            for cfg in grid_configs():
                m = run_config(ts, o, h, l, c, dayidx, base, cfg["K"], cfg["exit_hh"],
                               cfg["exit_mm"], cfg["stop_atr_mult"], slip,
                               years=None, label=cfg_label(cfg, slip))
                extra = f" grossPt/tr={m.get('gross_pts_avg')} stop%={m.get('stop_rate')}"
                print(fmt_row(m) + extra)

    elif mode == "locked":
        print(f"\n===== LOCKED RUN  frozen={FROZEN}  years {LOCKED_YEARS} =====")
        for slip in (0.5, 1.0):
            m = run_config(ts, o, h, l, c, dayidx, base, FROZEN["K"], FROZEN["exit_hh"],
                           FROZEN["exit_mm"], FROZEN["stop_atr_mult"], slip,
                           years=LOCKED_YEARS, label=f"LOCKED slip{slip}")
            print(fmt_row(m) + f" grossPt/tr={m.get('gross_pts_avg')}")
        # also full-sample combined at base slip for the book/verdict
        print("\n----- FROZEN config FULL SAMPLE (all years) -----")
        for slip in (0.5, 1.0):
            m = run_config(ts, o, h, l, c, dayidx, base, FROZEN["K"], FROZEN["exit_hh"],
                           FROZEN["exit_mm"], FROZEN["stop_atr_mult"], slip,
                           years=None, label=f"FROZEN full slip{slip}")
            print(fmt_row(m) + f" grossPt/tr={m.get('gross_pts_avg')}")

    elif mode == "book":
        m = run_config(ts, o, h, l, c, dayidx, base, FROZEN["K"], FROZEN["exit_hh"],
                       FROZEN["exit_mm"], FROZEN["stop_atr_mult"], 0.5,
                       years=None, label="book")
        t = m["_rows"].copy()
        daily = t.groupby(t.trade_date.dt.strftime("%Y-%m-%d"))["pnl"].sum()
        out = daily.reset_index()
        out.columns = ["date", "pnl"]
        out.to_csv("/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore/book-gapfade-daily.csv",
                   index=False)
        print(f"wrote book-gapfade-daily.csv  rows={len(out)}  netPnL=${out.pnl.sum():.0f}")
        print(out.to_string())


if __name__ == "__main__":
    main()
