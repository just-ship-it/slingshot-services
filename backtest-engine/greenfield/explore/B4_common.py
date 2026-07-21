#!/usr/bin/env python3
"""
B4 shared helpers — pre-close continuation (B4a) + monthly-expiry morning weakness (B4b).

Simulation contract (per study brief / KNOWABILITY.md):
  - All fills/exits walk 1s bars from the fill instant. Market orders fill at the
    NEXT 1s bar open +/- 0.25pt adverse slippage (x slip_mult for sensitivity).
  - Stops fill at stop -/+ 0.5pt (x slip_mult). Same-1s-bar ambiguity resolves
    against the trade (stop priority; stop may trigger on the entry bar itself).
  - Time exits fill at the flat bar's open -/+ 0.25pt (x slip_mult).
  - $5 round-trip commission per contract, NQ $20/pt, 1 contract.
  - A decision made "at" wall time T uses only 1s bars whose interval has CLOSED
    by T (bar stamped ts covers [ts, ts+1) -> knowable at ts+1).
Metrics reused from B12_sim (metrics/fmt_row).
"""
import json
import sys
import numpy as np
import pandas as pd
from datetime import datetime
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
sys.path.insert(0, BASE)
from B12_sim import metrics, fmt_row, et_epoch  # noqa: E402

ET = ZoneInfo("America/New_York")
POINT = 20.0
COMM_RT = 5.0
SLIP_MKT = 0.25
SLIP_STOP = 0.5


def load_1s_npz():
    z = np.load(f"{BASE}/cache_nq_rth_1s.npz")
    with open(f"{BASE}/cache_nq_rth_1s.days.json") as f:
        dayidx = json.load(f)
    return z["ts"], z["o"], z["h"], z["l"], z["c"], dayidx


def load_days_features():
    """B12-days.csv + trailing-250d ATR14 tercile flag (strictly-prior window,
    min 60 obs -> knowable at 09:30 of the day)."""
    days = pd.read_csv(f"{BASE}/B12-days.csv", parse_dates=["trade_date", "prior_td"])
    days = days.sort_values("trade_date").reset_index(drop=True)
    atr = days["atr14_prior"].to_numpy()
    n = len(days)
    top = np.zeros(n, dtype=bool)
    known = np.zeros(n, dtype=bool)
    for i in range(n):
        lo = max(0, i - 250)
        w = atr[lo:i]
        w = w[~np.isnan(w)]
        if len(w) >= 60 and not np.isnan(atr[i]):
            known[i] = True
            top[i] = atr[i] >= np.quantile(w, 2.0 / 3.0)
    days["atr_terc_known"] = known
    days["atr_top_terc"] = top
    return days


def sim_market_hold(ts, o, h, l, c, a, b, side, place_ts, flat_ts,
                    stop_pts=None, slip_mult=1.0):
    """One market-in / (optional stop) / market-out-at-flat_ts trade on the day
    slice [a,b). Returns dict or None if no fill possible.
    side: +1 long / -1 short. place_ts: epoch sec; fill at first bar ts>=place_ts.
    """
    dts, do, dh, dl = ts[a:b], o[a:b], h[a:b], l[a:b]
    e = int(np.searchsorted(dts, place_ts, "left"))
    if e >= len(dts) or dts[e] >= flat_ts:
        return None
    entry_px = do[e] + side * SLIP_MKT * slip_mult
    entry_ts = int(dts[e])
    fb = int(np.searchsorted(dts, flat_ts, "left"))  # flat bar (first bar >= flat_ts)
    # stop scan over [e, fb): stop may trigger on the entry bar (against the trade)
    if stop_pts is not None:
        stop = entry_px - side * stop_pts
        seg_l, seg_h = dl[e:fb], dh[e:fb]
        cond = (seg_l <= stop) if side > 0 else (seg_h >= stop)
        if cond.any():
            k = e + int(np.argmax(cond))
            exit_px = stop - side * SLIP_STOP * slip_mult
            return dict(entry_ts=entry_ts, entry_px=entry_px, exit_ts=int(dts[k]),
                        exit_px=exit_px, reason="stop",
                        pnl=(side * (exit_px - entry_px)) * POINT - COMM_RT,
                        gross_pts=None)
    if fb < len(dts):
        exit_px = do[fb] - side * SLIP_MKT * slip_mult
        exit_ts, gross_ref = int(dts[fb]), do[fb]
    else:  # day slice ended before flat_ts (guard; shouldn't occur for <=15:45 exits)
        exit_px = c[a:b][-1] - side * SLIP_MKT * slip_mult
        exit_ts, gross_ref = int(dts[-1]), c[a:b][-1]
    return dict(entry_ts=entry_ts, entry_px=entry_px, exit_ts=exit_ts,
                exit_px=exit_px, reason="time",
                pnl=(side * (exit_px - entry_px)) * POINT - COMM_RT,
                gross_pts=side * (gross_ref - do[e]))


def run_metrics(rows, universe_dates, label):
    """rows: list of dicts with trade_date, pnl, hold_s."""
    t = pd.DataFrame(rows, columns=["trade_date", "pnl", "hold_s"])
    if len(t):
        t["trade_date"] = pd.to_datetime(t["trade_date"])
    return metrics(t, pd.Series(pd.to_datetime(sorted(universe_dates))), label)
