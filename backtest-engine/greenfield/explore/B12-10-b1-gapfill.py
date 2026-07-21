#!/usr/bin/env python3
"""
B1 — opening gap-fill viability, 1s-honest.

Universe: full-RTH days, same-symbol gap (prior RTH close symbol == today's RTH
symbol), no roll in day, valid ON session (so ON-extreme stops are always defined
and the universe is identical across stop types), atr14_prior known,
band_lo <= |gap|/ATR <= band_hi.  Direction: toward prior RTH close.
gap is computed from the ACTUAL first 1s bar open at/after 09:30:00 (knowable at
that instant), not the 1m cache.

Entry styles (orders placed at 09:30:01, i.e. one second after the open print):
  mkt    market at 09:30:01 -> fill at that 1s open +0.25 adverse
  limA   limit at open +/- A pts ADVERSE (A in {3,6}); cancelled if the market
         touches the target before our fill (thesis consumed) or at flat time
  del5   at 09:35:00, market entry only if target untouched during 09:30-09:35
Stops:  on5   = beyond ON extreme on adverse side +5pt buffer
        fix40 = entry -/+ 40pt
        a15 / a30 = entry -/+ 0.15/0.30 * atr14_prior
Target: prior RTH close, limit, exact touch. Time exit: flat at 09:30+T (T in
{60,120}m), hard flat 15:45 ET (never binds for these T). Same-1s-bar stop+target
= STOP; target ineligible on the entry-fill bar.

DEV PERIOD ONLY: 2021-01-01 .. 2024-12-31. Grid is fully enumerated below; every
config run is reported (no silent cherry-picking).
Usage: python3 B12-10-b1-gapfill.py [--validate]   (--validate runs the single
pre-registered config on 2025-01-01..2026-06-30 — run ONCE.)
"""
import sys
import numpy as np
import pandas as pd
from B12_sim import (load_1s, load_days, et_epoch, first_idx, fill_limit,
                     walk_exit, metrics, fmt_row, SLIP_MKT, POINT, COMM_RT)

VALIDATE = "--validate" in sys.argv

(ts, o, h, l, c), dayidx = load_1s()
days = load_days()

if VALIDATE:
    P0, P1 = "2025-01-01", "2026-06-30"
else:
    P0, P1 = "2021-01-01", "2024-12-31"

days = days[(days.trade_date >= P0) & (days.trade_date <= P1)].copy()
uni = days[days.full_rth & days.gap_ok & days.on_ok & ~days.roll_in_day
           & days.rth_same_sym & days.atr14_prior.notna()].copy()
period_days = days[days.full_rth].trade_date

BANDS = [(0.03, 0.25), (0.03, 0.12), (0.12, 0.25)]
ENTRIES = ["mkt", "lim3", "lim6", "del5"]
STOPS = ["on5", "fix40", "a15", "a30"]
TEXITS = [60, 120]

if VALIDATE:
    # PRE-REGISTERED 2026-07-17 after dev grid, before any 2025+ look:
    # band [0.03,0.12] | lim6 | on5 | T120. Rationale: among the 8 dev survivors
    # (4/4 years positive, n>=100) it has the most trades (161), Sharpe 0.99,
    # DD -$4,445, median hold 3.8m, and a structural vol-adaptive stop (ON
    # extreme+5) instead of a fixed-point stop whose character drifts with price
    # level. del5|fix40 had higher PF (1.61) but half the trades and a
    # price-level-dependent stop.
    BANDS = [(0.03, 0.12)]
    ENTRIES = ["lim6"]
    STOPS = ["on5"]
    TEXITS = [120]

# ---- precompute per-day quantities independent of config ----
prep = []
for _, d in uni.iterrows():
    td = d.trade_date
    key = td.strftime("%Y-%m-%d")
    if key not in dayidx:
        continue
    a, b = dayidx[key]
    t930 = et_epoch(td, 9, 30)
    i0 = first_idx(ts[a:b] >= t930)
    if i0 < 0 or ts[a + i0] > t930 + 5:
        continue
    i0 += a
    open_px = o[i0]
    gap = open_px - d.prior_rth_close
    if d.atr14_prior <= 0 or abs(gap) < 1e-9:
        continue
    prep.append(dict(td=td, a=a, b=b, i0=i0, open_px=open_px, gap=gap,
                     gatr=abs(gap) / d.atr14_prior, side=-1 if gap > 0 else 1,
                     target=d.prior_rth_close, on_high=d.on_high, on_low=d.on_low,
                     atr=d.atr14_prior, t930=t930))
print(f"prepared days: {len(prep)} (universe rows {len(uni)})", flush=True)

rows = []
all_trades = {}
for blo, bhi in BANDS:
    duni = [p for p in prep if blo <= p["gatr"] <= bhi]
    for ent in ENTRIES:
        for stp in STOPS:
            for T in TEXITS:
                label = f"b[{blo},{bhi}]|{ent}|{stp}|T{T}"
                recs = []
                attempted = 0
                for p in duni:
                    a, b, i0, side = p["a"], p["b"], p["i0"], p["side"]
                    tgt = p["target"]
                    flat_ts = min(p["t930"] + T * 60,
                                  et_epoch(p["td"], 15, 45))
                    attempted += 1
                    tsd, od, hd, ld = ts[a:b], o[a:b], h[a:b], l[a:b]
                    j0 = i0 - a
                    e_idx = -1
                    entry_px = np.nan
                    e_slip = 0.0
                    p_idx = first_idx(tsd >= p["t930"] + 1, j0)
                    if p_idx < 0:
                        continue
                    if ent == "mkt":
                        e_idx = p_idx
                        entry_px = od[e_idx] + side * SLIP_MKT
                        e_slip = SLIP_MKT
                    elif ent.startswith("lim"):
                        A = float(ent[3:])
                        limit = p["open_px"] - side * A
                        end_i = first_idx(tsd >= flat_ts, p_idx)
                        hi = end_i if end_i >= 0 else len(tsd)
                        # market touches target before our fill -> cancel
                        tt = (hd[p_idx:hi] >= tgt) if side > 0 else (ld[p_idx:hi] <= tgt)
                        t_touch = p_idx + int(np.argmax(tt)) if tt.any() else -1
                        f_idx = fill_limit(tsd, hd, ld, side, limit, p_idx, hi)
                        if f_idx >= 0 and (t_touch < 0 or f_idx < t_touch):
                            e_idx = f_idx
                            entry_px = limit
                    elif ent == "del5":
                        t935 = p["t930"] + 300
                        w_end = first_idx(tsd >= t935, j0)
                        if w_end < 0:
                            continue
                        w_tt = (hd[p_idx:w_end] >= tgt) if side > 0 else \
                               (ld[p_idx:w_end] <= tgt)
                        if w_tt.any():
                            continue  # gap already filled without us
                        e_idx = w_end
                        entry_px = od[e_idx] + side * SLIP_MKT
                        e_slip = SLIP_MKT
                    if e_idx < 0:
                        continue
                    if stp == "on5":
                        stop = p["on_high"] + 5 if side < 0 else p["on_low"] - 5
                        # entry beyond the ON extreme -> undefined protective stop; skip
                        if (side < 0 and entry_px >= stop) or (side > 0 and entry_px <= stop):
                            continue
                    elif stp == "fix40":
                        stop = entry_px - side * 40
                    elif stp == "a15":
                        stop = entry_px - side * 0.15 * p["atr"]
                    else:
                        stop = entry_px - side * 0.30 * p["atr"]
                    x_idx, x_px, reason = walk_exit(tsd, od, hd, ld, side, e_idx,
                                                    entry_px, stop, tgt, flat_ts)
                    x_slip = 0.5 if reason == "stop" else (0.25 if reason in ("time", "eod") else 0.0)
                    pnl = side * (x_px - entry_px) * POINT - COMM_RT
                    recs.append(dict(trade_date=p["td"], pnl=pnl,
                                     hold_s=tsd[x_idx] - tsd[e_idx],
                                     reason=reason, slip_pts=e_slip + x_slip))
                tr = pd.DataFrame(recs)
                m = metrics(tr, period_days, label)
                m["attempted"] = attempted
                if len(tr):
                    m["fill_rate"] = round(len(tr) / attempted * 100, 1)
                    m["pnl_2xslip"] = round((tr.pnl - tr.slip_pts * POINT).sum())
                    w2 = (tr.pnl - tr.slip_pts * POINT)
                    m["pf_2xslip"] = round(w2[w2 > 0].sum() / max(1e-9, -w2[w2 <= 0].sum()), 3)
                    m["stop%"] = round((tr.reason == "stop").mean() * 100, 1)
                    m["tgt%"] = round((tr.reason == "target").mean() * 100, 1)
                rows.append(m)
                all_trades[label] = tr
                print(fmt_row(m), flush=True)

out = pd.DataFrame(rows)
suffix = "validate" if VALIDATE else "dev"
out.to_csv(f"B12-10-b1-configs-{suffix}.csv", index=False)
print(f"\nwrote B12-10-b1-configs-{suffix}.csv ({len(out)} configs)")
if VALIDATE:
    for lbl, tr in all_trades.items():
        if len(tr):
            print(f"\n{lbl} 2x-slip PnL: {round((tr.pnl - tr.slip_pts*POINT).sum())}")
            print(tr.groupby(tr.trade_date.dt.year)["pnl"].agg(["sum", "count", "mean"]))
