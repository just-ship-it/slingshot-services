#!/usr/bin/env python3
"""
V1-04-b4b.py — independent re-implementation of B4b monthly-expiry morning short.

Spec (restated from B4-preclose-expiry.md):
  On monthly-class (non-quarterly) 3rd-Friday expirations (holiday-shifted to
  Thursday, e.g. Good Friday collisions 2022-04-14, 2025-04-17):
  SHORT market placed 09:30:01 ET -> fill = next 1s bar open - 0.25 (adverse);
  exit (buy back) market 10:30:00 -> flat bar open + 0.25; $5 RT, $20/pt.
  No stop, no filter (frozen config = plain / no stop).

Runs dev 2021-2024 (claimed n=31) and validation 2025-2026 (claimed n=12),
slip 1x/2x, plus the two descriptive controls (quarterly 3rd Fridays; weekly
non-expiry Fridays), all shorts on the same clock.
"""
import sys
from datetime import date
sys.path.insert(0, "/home/drew/projects/slingshot-services/backtest-engine/greenfield/verify")
from V1_lib import (load_slim, day_context, first_bar_at_or_after, metrics, fmt,
                    expiry_calendar, S_0930, S_1030)


def sim_day(rec, slip):
    prim, roll, day_sym = day_context(rec)
    if day_sym is None or roll:
        return None
    eb = first_bar_at_or_after(rec["bars"]["open0930"], day_sym, S_0930 + 1)
    xb = first_bar_at_or_after(rec["bars"]["ex1030"], day_sym, S_1030)
    if eb is None or xb is None:
        return None
    entry = eb[2] - slip          # short entry
    exit_ = xb[2] + slip          # buy back
    net = (entry - exit_) * 20.0 - 5.0
    gross = eb[2] - xb[2]
    return net, gross


def run_set(days, dates, slip, label):
    trades, missing = [], []
    for d in dates:
        dstr = d.isoformat()
        rec = days.get(dstr)
        if rec is None:
            missing.append(dstr)
            continue
        r = sim_day(rec, slip)
        if r is None:
            missing.append(dstr + "(bars/roll)")
            continue
        trades.append((dstr, r[0], r[1]))
    m = metrics(trades, label)
    return m, missing, trades


def main():
    days = load_slim()
    cal = expiry_calendar(2021, 2026)
    monthly = [d for d, cls in cal if cls == "monthly"]
    quarterly = [d for d, cls in cal if cls == "quarterly"]
    expiry_set = set(monthly) | set(quarterly)
    all_fridays = []
    for dstr in sorted(days):
        d = date.fromisoformat(dstr)
        if d.weekday() == 4 and d not in expiry_set:
            all_fridays.append(d)
    # holiday-shifted Thursdays are already in monthly/quarterly lists

    for wname, d0, d1 in [("dev 2021-2024", date(2021,1,1), date(2024,12,31)),
                          ("val 2025-2026", date(2025,1,1), date(2026,12,31))]:
        print(f"\n=== {wname} ===")
        mon = [d for d in monthly if d0 <= d <= d1]
        qtr = [d for d in quarterly if d0 <= d <= d1]
        fri = [d for d in all_fridays if d0 <= d <= d1]
        for slip in [0.25, 0.5]:
            m, missing, trades = run_set(days, mon, slip, f"monthly short slip{slip}")
            print(fmt(m))
            if slip == 0.25:
                print(f"  monthly calendar days in window: {len(mon)}, traded {m.get('n',0)}, missing/skipped: {missing}")
                print(f"  traded dates: {[t[0] for t in trades]}")
        m, missing, _ = run_set(days, qtr, 0.25, "CONTROL quarterly short slip1x")
        print(fmt(m))
        m, missing, _ = run_set(days, fri, 0.25, "CONTROL weekly-Friday short slip1x")
        print(fmt(m))

if __name__ == "__main__":
    main()
