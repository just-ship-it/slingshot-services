#!/usr/bin/env python3
"""
B7 — honest 1s viability sims of two day-of-week drift candidates.

Candidate A (monday):  LONG at 09:30:01 ET on Mondays, exit end of RTH.
Candidate B (tuesday): SHORT at 09:30:01 ET on Tuesdays, exit 10:30 ET.

Reuses B4_common.sim_market_hold (market-in / optional-stop / market-out on 1s).
Sim contract per KNOWABILITY.md / brief:
  - market entry = next 1s bar open +/- SLIP_MKT adverse (x slip_mult)
  - time exit    = flat-bar open -/+ SLIP_MKT adverse (x slip_mult)
  - stop exit    = stop -/+ SLIP_STOP (0.5pt) adverse (x slip_mult); same-1s stop+target => STOP
  - $5 RT comm, NQ $20/pt, 1 contract
  - eligibility: dow match, full_rth, rth_same_sym (exclude roll-in-window days)
  - stop configs additionally require atr14_prior known

Design/sweep on 2021-2024 ONLY. 2025-2026 is LOCKED (run once, frozen config).

Usage:
  python3 B7_dow.py <candidate:monday|tuesday> <start_year> <end_year> [--book <path>] [--frozen "<desc>"]
"""
import sys
import numpy as np
import pandas as pd
from B4_common import (load_1s_npz, load_days_features, sim_market_hold,
                       ET, POINT, COMM_RT, SLIP_MKT, SLIP_STOP)
from B12_sim import metrics, fmt_row, et_epoch

DOW = {"monday": 0, "tuesday": 1}


def gross_pts(tr, slip_mult):
    """Raw price move entry-ref -> exit-ref in points (adds slippage back)."""
    side = tr["_side"]
    slip_exit = SLIP_STOP if tr["reason"] == "stop" else SLIP_MKT
    return side * (tr["exit_px"] - tr["entry_px"]) + (SLIP_MKT + slip_exit) * slip_mult


def run_config(ts, o, h, l, c, dayidx, days, dow, side, entry_hms, flat_hms,
               stop_atr_mult, slip_mult, label, collect=False):
    hh_e, mm_e, ss_e = entry_hms
    hh_f, mm_f, ss_f = flat_hms
    rows, book = [], []
    for _, r in days.iterrows():
        if r["dow"] != dow:
            continue
        if not (r["full_rth"] and r["rth_same_sym"]):
            continue
        td = r["trade_date"]
        key = td.strftime("%Y-%m-%d")
        if key not in dayidx:
            continue
        stop_pts = None
        if stop_atr_mult is not None:
            atr = r["atr14_prior"]
            if not np.isfinite(atr):
                continue  # stop config requires knowable ATR
            stop_pts = stop_atr_mult * atr
        a, b = dayidx[key]
        place_ts = et_epoch(td, hh_e, mm_e, ss_e)
        flat_ts = et_epoch(td, hh_f, mm_f, ss_f)
        tr = sim_market_hold(ts, o, h, l, c, a, b, side, place_ts, flat_ts,
                             stop_pts=stop_pts, slip_mult=slip_mult)
        if tr is None:
            continue
        tr["_side"] = side
        g = gross_pts(tr, slip_mult)
        rows.append(dict(trade_date=td, pnl=tr["pnl"],
                         hold_s=tr["exit_ts"] - tr["entry_ts"], gross=g))
        if collect:
            book.append((key, round(tr["pnl"], 2)))
    universe = days[(days.dow == dow) & days.full_rth & days.rth_same_sym]["trade_date"]
    t = pd.DataFrame(rows)
    m = metrics(t[["trade_date", "pnl", "hold_s"]] if len(t) else t, universe, label)
    if len(t):
        m["gross_avg"] = round(t["gross"].mean(), 2)
    return m, (book if collect else None)


def main():
    cand = sys.argv[1]
    y0, y1 = int(sys.argv[2]), int(sys.argv[3])
    book_path = None
    frozen = None
    if "--book" in sys.argv:
        book_path = sys.argv[sys.argv.index("--book") + 1]
    if "--frozen" in sys.argv:
        frozen = sys.argv[sys.argv.index("--frozen") + 1]

    ts, o, h, l, c, dayidx = load_1s_npz()
    days = load_days_features()
    days = days[(days.year >= y0) & (days.year <= y1)].reset_index(drop=True)
    dow = DOW[cand]

    print(f"\n==== Candidate {cand.upper()} | years {y0}-{y1} "
          f"({'LOCKED OOS' if y0 >= 2025 else 'DEV'}) ====")
    if frozen:
        print(f"FROZEN CONFIG: {frozen}\n")

    if cand == "monday":
        side = +1
        entry = (9, 30, 1)
        # grid: exit {15:45, 16:00} x stop {none, 0.6xATR}
        grid = []
        for flat, fl in [((15, 45, 0), "15:45"), ((16, 0, 0), "16:00")]:
            for sm, sl in [(None, "nostop"), (0.6, "0.6ATR")]:
                grid.append((flat, fl, sm, sl))
    else:
        side = -1
        entry = (9, 30, 1)
        flat = (10, 30, 0)
        grid = [(flat, "10:30", None, "nostop"), (flat, "10:30", 0.4, "0.4ATR")]

    # slip is specified in POINTS/side for the market leg; kernel base SLIP_MKT=0.25
    # -> slip_mult = pts / 0.25. (stop leg base 0.5pt scales with the same mult.)
    def mult(pts):
        return pts / SLIP_MKT

    results = {}
    for flat, fl, sm, sl in grid:
        for slip in [0.5]:  # main line = 0.5pt/side
            lab = f"{cand[:3]} exit={fl} stop={sl} slip={slip}pt"
            m, _ = run_config(ts, o, h, l, c, dayidx, days, dow, side, entry,
                              flat, sm, mult(slip), lab)
            results[(fl, sl, slip)] = m
            ga = m.get("gross_avg", "NA")
            print(fmt_row(m) + f" grossPts={ga}")

    # cost-sensitivity lines (0.25 / 0.50 / 1.00 pt/side) for each config
    print("\n-- cost sensitivity (slip 0.25 / 0.50 / 1.00 pt/side) --")
    for flat, fl, sm, sl in grid:
        for slip in [0.25, 0.5, 1.0]:
            lab = f"{cand[:3]} exit={fl} stop={sl} slip={slip}pt"
            m, _ = run_config(ts, o, h, l, c, dayidx, days, dow, side, entry,
                              flat, sm, mult(slip), lab)
            ga = m.get("gross_avg", "NA")
            print(fmt_row(m) + f" grossPts={ga}")

    # book write for a frozen config (locked run only)
    if book_path and frozen:
        # frozen encoded as "exit=..,stop=..": parse
        fl = frozen.split("exit=")[1].split()[0]
        sl = frozen.split("stop=")[1].split()[0]
        # rebuild grid entry
        for flat, gfl, sm, gsl in grid:
            if gfl == fl and gsl == sl:
                m, book = run_config(ts, o, h, l, c, dayidx, days, dow, side, entry,
                                     flat, sm, 0.5 / SLIP_MKT, "FROZEN", collect=True)
                with open(book_path, "w") as f:
                    f.write("date,pnl\n")
                    for d, p in book:
                        f.write(f"{d},{p}\n")
                print(f"\n[book written] {book_path}  ({len(book)} trades)")
                print(fmt_row(m) + f" grossPts={m.get('gross_avg')}")
                break


if __name__ == "__main__":
    main()
