#!/usr/bin/env python3
"""
B10 — Stand-down fade: on days a confirmed pre-close continuation strat (PCC) STANDS
DOWN (|day_move| <= 0.30*ATR14), does FADING the small day move pay in 15:00->15:30 ET?

PCC construction (reused exactly):
  at 15:00:00, day_move = (last 1s close < 15:00) - (first 1s open >= 09:30);
  ATR14 = atr14_prior. STAND-DOWN = full-RTH, no-roll, ATR-known days with
  |day_move| <= 0.30*ATR14.

Fade primary: enter market at 15:00:01 OPPOSITE of day_move (short if day up, long if
down), exit 15:30:00, no stop. Sub-bands |day_move|/ATR14 {0-.10,.10-.20,.20-.30}.
Controls on same days: CONTINUATION (with move), fixed-LONG, fixed-SHORT.
Optional 15:45 exit variant.

Sim: 1s from fill instant, market in = next 1s open +/-0.25pt adverse, time exit =
1s open -/+0.25pt, $5 RT comm, NQ $20/pt, 1 contract, no stop. Roll days excluded.

Usage: B10-standdown-fade.py <year_lo> <year_hi> [--writebook]
  dev:    2021 2024   |   locked: 2025 2026
"""
import sys
import numpy as np
import pandas as pd
from B4_common import (load_1s_npz, sim_market_hold, ET, POINT, COMM_RT, SLIP_MKT)
from B12_sim import metrics, fmt_row, et_epoch

BASE = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
THRESH = 0.30          # PCC stand-down: |day_move| <= 0.30*ATR14
BANDS = [(0.00, 0.10), (0.10, 0.20), (0.20, 0.30)]


def build_universe(days, ts, o, h, l, c, dayidx, y_lo, y_hi):
    """Return list of dicts per stand-down day: date, day_move, ratio, band, a, b."""
    rows = []
    for _, r in days.iterrows():
        td = r["trade_date"]
        if not (y_lo <= td.year <= y_hi):
            continue
        if not (bool(r["full_rth"]) and bool(r["rth_same_sym"]) and not pd.isna(r["atr14_prior"])):
            continue
        key = td.strftime("%Y-%m-%d")
        if key not in dayidx:
            continue
        a, b = dayidx[key]
        atr = float(r["atr14_prior"])
        if atr <= 0:
            continue
        t0930 = et_epoch(td, 9, 30, 0)
        t1500 = et_epoch(td, 15, 0, 0)
        dts = ts[a:b]
        oi = int(np.searchsorted(dts, t0930, "left"))
        # last 1s bar strictly before 15:00 (its close is knowable at 15:00:00)
        pj = int(np.searchsorted(dts, t1500, "left")) - 1
        if oi >= len(dts) or pj < oi:
            continue
        day_open = o[a:b][oi]
        pre_close = c[a:b][pj]
        day_move = pre_close - day_open
        ratio = abs(day_move) / atr
        if ratio > THRESH:
            continue
        band = next((i for i, (lo, hi) in enumerate(BANDS) if lo <= ratio < hi), 2)
        rows.append(dict(date=td, day_move=day_move, ratio=ratio, band=band,
                         a=a, b=b, sign=int(np.sign(day_move))))
    return rows


def run_config(univ, ts, o, h, l, c, side_fn, flat_hh, flat_mm, slip_mult=1.0):
    """side_fn(row)->+1/-1/0. Returns (rows_for_metrics, per_trade list)."""
    trows, book = [], []
    for u in univ:
        side = side_fn(u)
        if side == 0:
            continue
        td = u["date"]
        place_ts = et_epoch(td, 15, 0, 1)
        flat_ts = et_epoch(td, flat_hh, flat_mm, 0)
        res = sim_market_hold(ts, o, h, l, c, u["a"], u["b"], side,
                              place_ts, flat_ts, stop_pts=None, slip_mult=slip_mult)
        if res is None:
            continue
        hold_s = res["exit_ts"] - res["entry_ts"]
        trows.append(dict(trade_date=td, pnl=res["pnl"], hold_s=hold_s))
        book.append(dict(date=td, pnl=res["pnl"], gross_pts=res["gross_pts"]))
    return trows, book


def report(univ, ts, o, h, l, c, y_lo, y_hi, writebook=False):
    dates = pd.Series([u["date"] for u in univ])
    print(f"\n{'='*118}\nSTAND-DOWN UNIVERSE {y_lo}-{y_hi}: {len(univ)} days "
          f"(full-RTH, no-roll, ATR-known, |move|<=0.30*ATR14)")
    for bi, (lo, hi) in enumerate(BANDS):
        nb = sum(1 for u in univ if u["band"] == bi)
        print(f"  band {lo:.2f}-{hi:.2f}: {nb} days")
    print("="*118)

    def fade(u):   return -u["sign"] if u["sign"] != 0 else 0
    def cont(u):   return u["sign"] if u["sign"] != 0 else 0
    def flong(u):  return 1
    def fshort(u): return -1

    configs = [
        ("FADE  15:30  ALL<=0.30", fade, 15, 30, None),
        ("FADE  15:30  band 0.00-0.10", fade, 15, 30, 0),
        ("FADE  15:30  band 0.10-0.20", fade, 15, 30, 1),
        ("FADE  15:30  band 0.20-0.30", fade, 15, 30, 2),
        ("CONT  15:30  ALL<=0.30", cont, 15, 30, None),
        ("LONG  15:30  ALL<=0.30", flong, 15, 30, None),
        ("SHORT 15:30  ALL<=0.30", fshort, 15, 30, None),
        ("FADE  15:45  ALL<=0.30", fade, 15, 45, None),
        ("FADE  15:45  band 0.20-0.30", fade, 15, 45, 2),
    ]
    results = {}
    for label, sfn, fh, fm, band in configs:
        sub = [u for u in univ if (band is None or u["band"] == band)]
        subdates = pd.Series([u["date"] for u in sub])
        trows, book = run_config(sub, ts, o, h, l, c, sfn, fh, fm, slip_mult=1.0)
        m = metrics(pd.DataFrame(trows, columns=["trade_date", "pnl", "hold_s"]),
                    subdates, label)
        # gross pts/trade + net avg
        gp = np.mean([bk["gross_pts"] for bk in book]) if book else np.nan
        print(fmt_row(m) + (f"  gross_pts/tr={gp:+.2f}" if book else ""))
        # 2x slippage sensitivity
        t2, _ = run_config(sub, ts, o, h, l, c, sfn, fh, fm, slip_mult=2.0)
        m2 = metrics(pd.DataFrame(t2, columns=["trade_date", "pnl", "hold_s"]),
                     subdates, label + " [2x slip]")
        if m2.get("n", 0):
            print(f"    2x-slip: PF={m2['pf']} PnL=${m2['pnl']} avg=${m2['avg']} "
                  f"yrs+={m2['years_pos']}/{m2['years_n']}")
        results[label] = (m, book)
    return results


def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    y_lo, y_hi = int(sys.argv[1]), int(sys.argv[2])
    writebook = "--writebook" in sys.argv
    ts, o, h, l, c, dayidx = load_1s_npz()
    days = pd.read_csv(f"{BASE}/B12-days.csv", parse_dates=["trade_date", "prior_td"])
    univ = build_universe(days, ts, o, h, l, c, dayidx, y_lo, y_hi)
    results = report(univ, ts, o, h, l, c, y_lo, y_hi, writebook)

    if writebook:
        # frozen config declared in the .md before this runs; write its daily PnL
        label = FROZEN_LABEL
        band = FROZEN_BAND
        sub = [u for u in univ if (band is None or u["band"] == band)]

        def fade(u): return -u["sign"] if u["sign"] != 0 else 0
        trows, book = run_config(sub, ts, o, h, l, c, fade, FROZEN_FH, FROZEN_FM, slip_mult=1.0)
        bdf = pd.DataFrame([(bk["date"].strftime("%Y-%m-%d"), round(bk["pnl"], 2))
                            for bk in book], columns=["date", "pnl"])
        bdf.to_csv(f"{BASE}/book-standdownfade-daily.csv", index=False)
        print(f"\nwrote book-standdownfade-daily.csv ({len(bdf)} rows) for {label}")


# Frozen config placeholders (only used with --writebook, set after dev decision)
FROZEN_LABEL = "FADE 15:30 band 0.20-0.30"
FROZEN_BAND = 2
FROZEN_FH, FROZEN_FM = 15, 30

if __name__ == "__main__":
    main()
