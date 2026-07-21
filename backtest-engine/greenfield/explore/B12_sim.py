#!/usr/bin/env python3
"""
Shared 1s-honest simulation kernel for studies B1 (gap fill) and B2 (compressed-ON fade).

Simulation contract (non-negotiable, from study brief):
  - Fills and exits walk 1s bars chronologically from the fill instant.
  - Limit entry: first 1s bar at/after placement instant with low<=limit (buy) /
    high>=limit (sell); fills AT limit exactly. Limit targets identical.
  - Market entries: 1s bar open +0.25pt adverse. Stop exits: stop -/+0.5pt slippage.
    Market/time exits: next 1s bar open -/+0.25pt.
  - Never uses a 1s tick before fill_ts. On the entry-fill bar itself the STOP may
    trigger (conservative) but the target may NOT. Same-bar stop+target => STOP.
  - Costs: $5 RT/contract commission, $20/pt, 1 contract.
Placement instants: any decision derived from a 1s bar stamped T (covering [T,T+1))
is knowable at T+1; orders are placed at T+1 and may fill from bars ts >= T+1.
"""
import json
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
ET = ZoneInfo("America/New_York")
UTC = ZoneInfo("UTC")

POINT = 20.0
COMM_RT = 5.0
SLIP_STOP = 0.5
SLIP_MKT = 0.25


def load_1s():
    df = pd.read_csv(f"{BASE}/cache_nq_rth_1s.csv",
                     dtype={"ts": np.int64, "o": np.float64, "h": np.float64,
                            "l": np.float64, "c": np.float64, "v": np.int64})
    with open(f"{BASE}/cache_nq_rth_1s.days.json") as f:
        dayidx = json.load(f)
    return (df["ts"].to_numpy(), df["o"].to_numpy(), df["h"].to_numpy(),
            df["l"].to_numpy(), df["c"].to_numpy()), dayidx


def load_days():
    return pd.read_csv(f"{BASE}/B12-days.csv", parse_dates=["trade_date", "prior_td"])


def et_epoch(td, hh, mm, ss=0):
    """Epoch seconds of an ET wall time on trade date td."""
    return int(datetime(td.year, td.month, td.day, hh, mm, ss, tzinfo=ET).timestamp())


def first_idx(cond, start=0):
    """First index >= start where boolean array cond is True, else -1."""
    c = cond[start:]
    if not c.any():
        return -1
    return start + int(np.argmax(c))


def fill_limit(ts, h, l, side, limit, place_idx, cancel_idx):
    """First bar idx in [place_idx, cancel_idx) filling a limit order; -1 if none.
    side +1 buy (fills when l<=limit), -1 sell (fills when h>=limit)."""
    hi = cancel_idx if cancel_idx >= 0 else len(ts)
    if place_idx >= hi:
        return -1
    cond = (l[place_idx:hi] <= limit) if side > 0 else (h[place_idx:hi] >= limit)
    if not cond.any():
        return -1
    return place_idx + int(np.argmax(cond))


def walk_exit(ts, o, h, l, side, entry_idx, entry_px, stop, target, flat_ts):
    """Walk from entry bar. side=+1 long / -1 short. Returns (exit_idx, exit_px, reason).
    Stop-priority on ties; target ineligible on the entry bar itself; forced flat at
    the first bar ts >= flat_ts at that bar's open -/+ market slip."""
    n = len(ts)
    end = first_idx(ts >= flat_ts, entry_idx)
    scan_hi = end if end >= 0 else n
    if side > 0:
        s_cond = l[entry_idx:scan_hi] <= stop
        t_cond = h[entry_idx:scan_hi] >= target
    else:
        s_cond = h[entry_idx:scan_hi] >= stop
        t_cond = l[entry_idx:scan_hi] <= target
    s_idx = entry_idx + int(np.argmax(s_cond)) if s_cond.any() else -1
    t_idx = -1
    if t_cond.any():
        # target not eligible on the entry-fill bar
        t_cond[0] = False
        if t_cond.any():
            t_idx = entry_idx + int(np.argmax(t_cond))
    if s_idx >= 0 and (t_idx < 0 or s_idx <= t_idx):
        return s_idx, stop - side * SLIP_STOP, "stop"
    if t_idx >= 0:
        return t_idx, target, "target"
    if end >= 0:
        return end, o[end] - side * SLIP_MKT, "time"
    # day ran out (shouldn't happen with 15:45 flat inside 16:00 cache)
    return n - 1, o[n - 1] - side * SLIP_MKT, "eod"


def trade_pnl(side, entry_px, exit_px, slip_mult=1.0, extra_slip_pts=0.0):
    pts = side * (exit_px - entry_px) - extra_slip_pts
    return pts * POINT - COMM_RT


def metrics(trades, period_days, label=""):
    """trades: DataFrame [trade_date, pnl, hold_s]. period_days: all calendar trade
    dates (pd Series) in the period -> daily Sharpe incl. zero-trade days."""
    if len(trades) == 0:
        return {"label": label, "n": 0}
    t = trades
    wins = t.pnl[t.pnl > 0].sum()
    losses = -t.pnl[t.pnl <= 0].sum()
    daily = t.groupby("trade_date")["pnl"].sum()
    cal = pd.Series(0.0, index=pd.DatetimeIndex(sorted(period_days.unique())))
    cal.loc[daily.index] = daily.values
    sharpe = cal.mean() / cal.std() * np.sqrt(252) if cal.std() > 0 else np.nan
    eq = cal.cumsum()
    dd = (eq - eq.cummax()).min()
    per_year = t.groupby(t.trade_date.dt.year)["pnl"].agg(["sum", "count"])
    py = {int(y): (round(r["sum"]), int(r["count"])) for y, r in per_year.iterrows()}
    return {"label": label, "n": len(t), "wr": round((t.pnl > 0).mean() * 100, 1),
            "pf": round(wins / losses, 3) if losses > 0 else np.inf,
            "pnl": round(t.pnl.sum()), "avg": round(t.pnl.mean(), 1),
            "sharpe": round(sharpe, 2), "maxdd": round(dd),
            "hold_avg_m": round(t.hold_s.mean() / 60, 1),
            "hold_med_m": round(t.hold_s.median() / 60, 1),
            "years_pos": sum(1 for v, _ in py.values() if v > 0),
            "years_n": len(py), "per_year": py}


def fmt_row(m):
    if m.get("n", 0) == 0:
        return f"{m.get('label','')}: NO TRADES"
    yy = " ".join(f"{y}:{v:+d}/{n}" for y, (v, n) in sorted(m["per_year"].items()))
    return (f"{m['label']:<42} n={m['n']:<4} WR={m['wr']:<5} PF={m['pf']:<6} "
            f"PnL=${m['pnl']:<8} Sh={m['sharpe']:<5} DD=${m['maxdd']:<7} "
            f"hold(m) avg={m['hold_avg_m']}/med={m['hold_med_m']} "
            f"yrs+={m['years_pos']}/{m['years_n']} [{yy}]")
