#!/usr/bin/env python3
"""
V1-03-b4a.py — independent re-implementation of B4a pre-close continuation.

Spec (restated from B4-preclose-expiry.md):
  day_move = close of last 1s bar before 15:00:00 ET minus open of first 1s bar
  >= 09:30:00 ET (primary contract). At 15:00:01 place aligned market order
  (long if day_move>0), fill = next 1s bar open +0.25 adverse; exit market at
  15:30:00 = flat bar open -0.25 adverse; $5 RT, $20/pt.
  Frozen filter: |day_move| > 0.30 * ATR14 (knowable at 09:30, prior-day).
  Eligibility: full RTH session (bars >= 15:45), no intraday roll of the
  per-hour primary (hours 9..15), ATR14 + trailing-250d tercile knowable
  (>= 60 strictly-prior ATR obs), signal bar within 120s of 15:00, day_move != 0.

Runs: dev 2021-2024 and validation 2025-2026, frozen + unfiltered baseline,
slip 1x (0.25/side) and 2x (0.5/side), for each ATR variant.
"""
import sys
sys.path.insert(0, "/home/drew/projects/slingshot-services/backtest-engine/greenfield/verify")
from V1_lib import (load_slim, load_daily, day_context, first_bar_at_or_after,
                    last_bar_before, metrics, fmt, S_0930, S_1500, S_1530, S_1545)

MOVE_MULT = 0.30
COVER_S = 120


def run(days, daily, d0, d1, atr_col, fmove, slip, exit_t=S_1530, exit_win="ex1530", verbose=False):
    skips = {"not_full": 0, "roll": 0, "atr": 0, "cover": 0, "zero": 0, "no_bars": 0}
    trades, eligible = [], 0
    for dstr in sorted(days):
        if not (d0 <= dstr <= d1):
            continue
        rec = days[dstr]
        prim, roll, day_sym = day_context(rec)
        if day_sym is None:
            continue
        if day_sym not in rec["late"]:
            skips["not_full"] += 1
            continue
        if roll:
            skips["roll"] += 1
            continue
        drow = daily.get(dstr)
        atr = None
        if drow and drow.get(atr_col):
            try:
                atr = float(drow[atr_col])
            except ValueError:
                atr = None
        n_obs = int(drow["n_atr_obs_prior"]) if drow else 0
        if atr is None or n_obs < 60:
            skips["atr"] += 1
            continue
        ob = first_bar_at_or_after(rec["bars"]["open0930"], day_sym, S_0930)
        sb = last_bar_before(rec["bars"]["dec1500"], day_sym, S_1500)
        if ob is None or sb is None:
            skips["no_bars"] += 1
            continue
        if sb[0] < S_1500 - COVER_S:
            skips["cover"] += 1
            continue
        day_move = sb[5] - ob[2]  # close of signal bar - open of first bar
        if day_move == 0.0:
            skips["zero"] += 1
            continue
        eligible += 1
        if fmove is not None and abs(day_move) <= fmove * atr:
            continue
        direction = 1 if day_move > 0 else -1
        eb = first_bar_at_or_after(rec["bars"]["dec1500"], day_sym, S_1500 + 1)
        xb = first_bar_at_or_after(rec["bars"][exit_win], day_sym, exit_t)
        if eb is None or xb is None:
            skips["no_bars"] += 1
            continue
        entry = eb[2] + direction * slip
        exit_ = xb[2] - direction * slip
        net = direction * (exit_ - entry) * 20.0 - 5.0
        gross = direction * (xb[2] - eb[2])
        trades.append((dstr, net, gross))
    return trades, eligible, skips


def main():
    days = load_slim()
    daily = load_daily()
    windows = [("dev 2021-2024", "2021-01-01", "2024-12-31"),
               ("val 2025-2026", "2025-01-01", "2026-12-31")]
    for atr_col in ["atr_tr", "atr_hl", "atr_trr", "atr_tr_wilder"]:
        print(f"\n################ ATR variant: {atr_col} ################")
        for wname, d0, d1 in windows:
            print(f"\n=== {wname} ===")
            for fmove, flabel in [(None, "unfiltered"), (MOVE_MULT, f"mv>{MOVE_MULT}")]:
                for slip in [0.25, 0.5]:
                    trades, elig, skips = run(days, daily, d0, d1, atr_col, fmove, slip)
                    m = metrics(trades, f"{flabel} ex15:30 slip{slip}")
                    if slip == 0.25:
                        print(f"  eligible={elig} skips={skips}")
                    print("  " + fmt(m))

if __name__ == "__main__":
    main()
