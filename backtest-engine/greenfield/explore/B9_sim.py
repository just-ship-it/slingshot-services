#!/usr/bin/env python3
"""
B9 — large-gap-up morning fade (SHORT). 1s-honest sim kernel.

HEDGE candidate: short the open on large gap-up days, cover late morning. Expected
to lose in melt-up years (2021) and pay in down/vol years (2022, 2025). Evaluated
as a diversifier for a long-only book, not just standalone.

Signal (all knowable at 09:30 ET):
  gap = rth_open - prior_rth_close ; eligible if gap >= K * atr14_prior
  AND full_rth AND rth_same_sym AND same_sym_prev_rth (gap is a REAL price move,
  not a contract-roll spread) AND NOT roll_in_day.

Sim contract (from brief + KNOWABILITY.md), faithful to B4_common.sim_market_hold
logic (short slippage verified) but with slippage set to the brief's spec:
  - SHORT market entry placed 09:30:01 ET -> fills at first 1s bar ts>=place_ts,
    at that bar's OPEN - slip (a short sells LOWER than open = adverse).
  - Cover: market at flat_ts (11:00 or 12:00 ET) at flat bar OPEN + slip (buys
    HIGHER = adverse). Both legs cost slippage.
  - Optional protective stop above entry (gap-up short has upside tail risk):
    stop = entry_px + stop_pts. Triggers when a 1s HIGH >= stop over [entry_bar, flat_bar).
    The stop MAY trigger on the entry bar itself (against the trade). Same-1s-bar
    stop+cover ambiguity resolves to the STOP (against the trade). Cover at stop + slip.
  - Costs: $5 RT commission, NQ $20/pt, 1 contract.
  - slip applied identically to entry, cover, and stop legs. base=0.5pt/side; the
    1.0pt/side line is a slippage-stress sensitivity.
"""
import sys
import numpy as np
import pandas as pd

BASE = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
sys.path.insert(0, BASE)
from B4_common import load_1s_npz          # noqa: E402
from B12_sim import metrics, fmt_row, et_epoch, load_days  # noqa: E402

POINT = 20.0
COMM_RT = 5.0


def sim_short(ts, o, h, l, c, a, b, place_ts, flat_ts, stop_pts=None, slip=0.5):
    """One SHORT market-in / (optional stop) / market-cover-at-flat_ts on day slice [a,b).
    Returns dict or None. side is fixed -1 (short)."""
    side = -1
    dts, do, dh, dl = ts[a:b], o[a:b], h[a:b], l[a:b]
    e = int(np.searchsorted(dts, place_ts, "left"))
    if e >= len(dts) or dts[e] >= flat_ts:
        return None
    entry_px = do[e] - slip                       # short sells lower (adverse)
    entry_ts = int(dts[e])
    entry_ref = do[e]                             # gross (no-slip) entry level
    fb = int(np.searchsorted(dts, flat_ts, "left"))  # flat bar = first bar >= flat_ts
    # protective stop scan over [e, fb) (stop may trigger on entry bar; against trade)
    if stop_pts is not None:
        stop = entry_px + stop_pts               # above entry for a short
        seg_h = dh[e:fb]
        cond = seg_h >= stop
        if cond.any():
            k = e + int(np.argmax(cond))
            exit_px = stop + slip                # cover higher (adverse)
            gross = side * (stop - entry_ref)    # gross pts, no slip
            return dict(entry_ts=entry_ts, exit_ts=int(dts[k]), reason="stop",
                        pnl=(side * (exit_px - entry_px)) * POINT - COMM_RT,
                        gross_pts=gross, hold_s=int(dts[k]) - entry_ts)
    if fb < len(dts):
        exit_ref = do[fb]
        exit_px = exit_ref + slip                # cover buys higher (adverse)
        exit_ts = int(dts[fb])
    else:  # guard: day slice ended before flat_ts (shouldn't occur for <=12:00 exits)
        exit_ref = c[a:b][-1]
        exit_px = exit_ref + slip
        exit_ts = int(dts[-1])
    return dict(entry_ts=entry_ts, exit_ts=exit_ts, reason="time",
                pnl=(side * (exit_px - entry_px)) * POINT - COMM_RT,
                gross_pts=side * (exit_ref - entry_ref), hold_s=exit_ts - entry_ts)


def eligible_days(days):
    """Base tradeable universe (roll-gap safe). Returns filtered DataFrame with tds col."""
    d = days.copy()
    d["tds"] = d.trade_date.dt.strftime("%Y-%m-%d")
    m = (d.full_rth & d.rth_same_sym & d.same_sym_prev_rth & ~d.roll_in_day
         & d.atr14_prior.notna() & d.gap.notna())
    return d[m].copy()


def run_config(ts, o, h, l, c, dayidx, base, K, exit_hh, exit_mm, stop_atr_mult,
               slip, years=None, label=""):
    """Run one config. base: eligible-days DataFrame. stop_atr_mult: None or e.g. 0.5.
    years: iterable of ints to include (None=all). Returns metrics dict + rows."""
    sel = base[base.gap >= K * base.atr14_prior].copy()
    if years is not None:
        sel = sel[sel.trade_date.dt.year.isin(years)]
    rows = []
    universe = []
    for _, r in sel.iterrows():
        tds = r.tds
        if tds not in dayidx:
            continue
        universe.append(tds)
        a, b = dayidx[tds]
        td = r.trade_date
        place_ts = et_epoch(td, 9, 30, 1)
        flat_ts = et_epoch(td, exit_hh, exit_mm, 0)
        stop_pts = (stop_atr_mult * r.atr14_prior) if stop_atr_mult is not None else None
        res = sim_short(ts, o, h, l, c, a, b, place_ts, flat_ts, stop_pts=stop_pts, slip=slip)
        if res is None:
            continue
        rows.append(dict(trade_date=td, pnl=res["pnl"], hold_s=res["hold_s"],
                         gross_pts=res["gross_pts"], reason=res["reason"]))
    t = pd.DataFrame(rows)
    period = pd.Series(pd.to_datetime(sorted(set(universe))))
    m = metrics(t[["trade_date", "pnl", "hold_s"]] if len(t) else t, period, label)
    if len(t):
        m["gross_pts_avg"] = round(t.gross_pts.mean(), 2)
        m["stop_rate"] = round((t.reason == "stop").mean() * 100, 1)
    m["_rows"] = t
    return m
