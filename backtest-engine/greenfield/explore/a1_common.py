#!/usr/bin/env python3
"""
Shared loaders for the A1 price-structure census.

Conventions:
  - trade_date: Globex convention. ET bars >= 18:00 belong to the NEXT calendar
    day's session. Sunday 18:00 opens Monday's trade_date.
  - Sessions (ET): overnight (ON) = 18:00 prev day -> 09:29 bar; RTH = 09:30 -> 15:59 bar.
    16:00-16:59 = settlement tail (excluded from ON/RTH); 17:00-17:59 = halt (no bars).
  - Returns are NEVER computed across a symbol change (roll). Bar-level: `valid_ret`
    column. Day-level: builders exclude pairs whose symbols differ.
  - Knowability: a 1m bar stamped T covers [T, T+60s) and is knowable at T+60s.
    All conditioning in downstream scripts uses only bars whose CLOSE precedes the
    outcome window start.
"""
import numpy as np
import pandas as pd

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
CACHE = f"{BASE}/greenfield/explore/cache"

RTH_START = 930   # hhmm int, first RTH bar
RTH_END   = 1559  # last RTH bar (bar covering 15:59-16:00)
FULL_RTH_MIN_BARS = 300  # fewer -> half day / data hole, excluded from session studies


def load_cache(prod="NQ"):
    df = pd.read_csv(
        f"{CACHE}/{prod}_1m_primary.csv",
        dtype={"et_date": str, "et_hhmm": int, "dow": int, "o": float, "h": float,
               "l": float, "c": float, "v": np.int64, "symbol": str, "roll": np.int8},
        parse_dates=["ts_utc"],
    )
    hh = df["et_hhmm"] // 100
    mm = df["et_hhmm"] % 100
    df["mod"] = hh * 60 + mm                      # minute of ET day
    # trade date: bars at/after 18:00 ET belong to next calendar day
    d = pd.to_datetime(df["et_date"])
    df["trade_date"] = np.where(df["et_hhmm"] >= 1800, d + pd.Timedelta(days=1), d)
    df["trade_date"] = pd.to_datetime(df["trade_date"])
    df["year"] = df["trade_date"].dt.year
    sess = np.full(len(df), "on", dtype=object)
    sess[(df["et_hhmm"] >= RTH_START) & (df["et_hhmm"] <= RTH_END)] = "rth"
    sess[(df["et_hhmm"] >= 1600) & (df["et_hhmm"] < 1800)] = "tail"
    df["session"] = sess
    # bar-to-bar validity: same symbol as previous bar
    df["valid_ret"] = df["symbol"].eq(df["symbol"].shift(1))
    df.iloc[0, df.columns.get_loc("valid_ret")] = False
    return df


def build_daily(df):
    """Per-trade-date session aggregates. Only days with both ON and full RTH."""
    rows = []
    for td, g in df.groupby("trade_date", sort=True):
        on = g[g["session"] == "on"]
        rth = g[g["session"] == "rth"]
        if len(on) < 100 or len(rth) < 30:
            continue
        r = {"trade_date": td, "year": td.year, "dow": td.weekday(),
             "n_on": len(on), "n_rth": len(rth),
             "full_rth": len(rth) >= FULL_RTH_MIN_BARS,
             "sym_on_first": on["symbol"].iloc[0], "sym_on_last": on["symbol"].iloc[-1],
             "sym_rth_first": rth["symbol"].iloc[0], "sym_rth_last": rth["symbol"].iloc[-1],
             "roll_in_day": bool(g["roll"].any()),
             "on_open": on["o"].iloc[0], "on_close": on["c"].iloc[-1],
             "on_high": on["h"].max(), "on_low": on["l"].min(),
             "rth_open": rth["o"].iloc[0], "rth_close": rth["c"].iloc[-1],
             "rth_high": rth["h"].max(), "rth_low": rth["l"].min(),
             "rth_vol": rth["v"].sum(), "on_vol": on["v"].sum()}
        hi_idx = rth["h"].idxmax(); lo_idx = rth["l"].idxmin()
        r["rth_high_mod"] = rth.loc[hi_idx, "mod"]; r["rth_low_mod"] = rth.loc[lo_idx, "mod"]
        rows.append(r)
    dd = pd.DataFrame(rows).sort_values("trade_date").reset_index(drop=True)
    dd["on_range"] = dd["on_high"] - dd["on_low"]
    dd["rth_range"] = dd["rth_high"] - dd["rth_low"]
    dd["day_range"] = np.maximum(dd["on_high"], dd["rth_high"]) - np.minimum(dd["on_low"], dd["rth_low"])
    # ATR14 of prior 14 FULL days' day_range, shifted -> knowable before today's session
    dr = dd["day_range"].where(dd["full_rth"])
    dd["atr14_prior"] = dr.rolling(14, min_periods=10).mean().shift(1)
    # same-symbol flags for cross-day comparisons
    dd["same_sym_prev_rth"] = dd["sym_rth_first"].eq(dd["sym_rth_last"].shift(1))
    dd["on_same_sym"] = dd["sym_on_first"].eq(dd["sym_on_last"])
    dd["rth_same_sym"] = dd["sym_rth_first"].eq(dd["sym_rth_last"])
    dd["on_to_rth_same_sym"] = dd["sym_on_last"].eq(dd["sym_rth_first"])
    return dd


def yearly_table(s: pd.Series, years: pd.Series, fn="mean"):
    """Return per-year aggregate + n for a series."""
    g = s.groupby(years)
    out = pd.DataFrame({"val": g.agg(fn), "n": g.count()})
    return out


def sign_stability(per_year_vals):
    """Verdict string: STABLE if all same sign (ignoring |t|<tiny), else MIXED."""
    v = [x for x in per_year_vals if x == x]
    if not v:
        return "NO DATA"
    pos = sum(1 for x in v if x > 0); neg = sum(1 for x in v if x < 0)
    if pos == len(v): return "STABLE(+)"
    if neg == len(v): return "STABLE(-)"
    return f"MIXED({pos}+/{neg}-)"
