#!/usr/bin/env python3
"""
B6 — COMPRESSED-OVERNIGHT MORNING CONTINUATION, 1s-honest viability sim.

Hypothesis (from sibling census, TEST not truth): on compressed-ON days (ON range
in bottom trailing tercile, knowable 09:30), the first-hour direction continues into
midday. Trade: at decision D in {10:00,10:30} ET, direction = sign(price(D)-rth_open),
enter MARKET in that direction, exit on a noon time-stop / vol-scaled target, with/
without a vol-scaled stop; hard flat 15:45 ET.

Two mandatory controls:
  (1) compression load-bearing: same rule on NON-compressed days.
  (2) direction load-bearing: compressed unconditional-long (day-type main effect).

Simulation contract (KNOWABILITY.md / study brief):
  - fills/exits walk 1s bars from the fill instant.
  - decision at wall time D uses only bars CLOSED by D (bar stamped ts covers
    [ts,ts+1) -> knowable at ts+1). We read dec price = close of last bar with ts<D.
  - market entry at first bar ts>=D, open +/- 0.25pt adverse (x slip_mult).
  - stop exit stop -/+ 0.5pt (x slip_mult); eligible on the entry bar (against trade).
  - target = limit exact (no slip); NOT eligible on the entry bar.
  - same-1s-bar stop+target => STOP.
  - time/flat exit at flat bar open -/+ 0.25pt (x slip_mult).
  - $5 RT commission, NQ $20/pt, 1 contract. gross pts = frictionless (no slip/comm).
  - roll days excluded via rth_same_sym (symbol constant across RTH; window is inside RTH).

Design/sweep on 2021-2024 ONLY. 2025-2026 LOCKED (run once on frozen config, elsewhere).
"""
import json
import sys
import numpy as np
import pandas as pd
from datetime import datetime
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
sys.path.insert(0, BASE)
from B12_sim import metrics, fmt_row  # noqa: E402

ET = ZoneInfo("America/New_York")
POINT = 20.0
COMM_RT = 5.0
SLIP_MKT = 0.25
SLIP_STOP = 0.5


def et_epoch(td, hh, mm, ss=0):
    return int(datetime(td.year, td.month, td.day, hh, mm, ss, tzinfo=ET).timestamp())


def load():
    z = np.load(f"{BASE}/cache_nq_rth_1s.npz")
    with open(f"{BASE}/cache_nq_rth_1s.days.json") as f:
        dayidx = json.load(f)
    days = pd.read_csv(f"{BASE}/B12-days.csv", parse_dates=["trade_date", "prior_td"])
    return z["ts"], z["o"], z["h"], z["l"], z["c"], dayidx, days


def sim_trade(dts, do, dh, dl, dc, side, place_ts, flat_ts,
              stop_pts=None, target_pts=None, slip_mult=1.0):
    """One trade on a day's 1s slice (already offset arrays). Returns dict or None."""
    e = int(np.searchsorted(dts, place_ts, "left"))
    if e >= len(dts) or dts[e] >= flat_ts:
        return None
    entry_ref = do[e]
    entry_px = entry_ref + side * SLIP_MKT * slip_mult
    entry_ts = int(dts[e])
    fb = int(np.searchsorted(dts, flat_ts, "left"))   # first bar >= flat_ts
    hi = fb                                            # scan [e, fb)
    if hi <= e:
        return None
    # stop (eligible on entry bar)
    s_idx = -1
    stop = None
    if stop_pts is not None:
        stop = entry_px - side * stop_pts
        s_cond = (dl[e:hi] <= stop) if side > 0 else (dh[e:hi] >= stop)
        if s_cond.any():
            s_idx = e + int(np.argmax(s_cond))
    # target (NOT eligible on entry bar)
    t_idx = -1
    target = None
    if target_pts is not None:
        target = entry_px + side * target_pts
        t_cond = (dh[e:hi] >= target) if side > 0 else (dl[e:hi] <= target)
        if len(t_cond):
            t_cond[0] = False
        if t_cond.any():
            t_idx = e + int(np.argmax(t_cond))
    # resolve (stop priority on tie)
    if s_idx >= 0 and (t_idx < 0 or s_idx <= t_idx):
        exit_ref = stop
        exit_px = stop - side * SLIP_STOP * slip_mult
        exit_ts = int(dts[s_idx]); reason = "stop"
    elif t_idx >= 0:
        exit_ref = target
        exit_px = target                                # limit exact
        exit_ts = int(dts[t_idx]); reason = "target"
    else:
        if fb < len(dts):
            exit_ref = do[fb]
            exit_px = do[fb] - side * SLIP_MKT * slip_mult
            exit_ts = int(dts[fb]); reason = "time"
        else:
            exit_ref = dc[-1]
            exit_px = dc[-1] - side * SLIP_MKT * slip_mult
            exit_ts = int(dts[-1]); reason = "eod"
    pnl = side * (exit_px - entry_px) * POINT - COMM_RT
    gross_pts = side * (exit_ref - entry_ref)
    return dict(entry_ts=entry_ts, exit_ts=exit_ts, reason=reason, pnl=pnl,
                gross_pts=gross_pts, hold_s=exit_ts - entry_ts)


def eligible_mask(days, dayidx):
    incache = days["trade_date"].dt.strftime("%Y-%m-%d").isin(dayidx.keys())
    base = (days["full_rth"] & days["rth_same_sym"]
            & days["atr14_prior"].notna() & incache)
    comp = base & days["on_compressed"]
    noncomp = base & (~days["on_compressed"]) & days["on_ok"]
    return comp, noncomp


def build_rows(days_sub, dayidx, ts, o, h, l, c, D_hh, D_mm, filt_atr,
               exit_kind, stop_atr, slip_mult=1.0, force_side=None):
    """exit_kind: ('time',12,0) or ('target', mult). Returns list of trade rows."""
    rows = []
    for _, r in days_sub.iterrows():
        td = r["trade_date"]
        key = td.strftime("%Y-%m-%d")
        a, b = dayidx[key]
        dts, do, dh, dl, dc = ts[a:b], o[a:b], h[a:b], l[a:b], c[a:b]
        atr = r["atr14_prior"]
        rth_open = r["rth_open"]
        D = et_epoch(td, D_hh, D_mm)
        e = int(np.searchsorted(dts, D, "left"))
        if e <= 0 or e >= len(dts):
            continue
        dec_price = dc[e - 1]                       # last bar closed by D
        fh_move = dec_price - rth_open
        if force_side is not None:
            side = force_side
        else:
            if fh_move > 0:
                side = 1
            elif fh_move < 0:
                side = -1
            else:
                continue
            if filt_atr is not None and abs(fh_move) <= filt_atr * atr:
                continue
        # exit spec
        if exit_kind[0] == "time":
            flat_ts = et_epoch(td, exit_kind[1], exit_kind[2])
            target_pts = None
        else:  # target
            flat_ts = et_epoch(td, 15, 45)
            target_pts = exit_kind[1] * atr
        stop_pts = stop_atr * atr if stop_atr is not None else None
        tr = sim_trade(dts, do, dh, dl, dc, side, D, flat_ts,
                       stop_pts=stop_pts, target_pts=target_pts, slip_mult=slip_mult)
        if tr is None:
            continue
        tr["trade_date"] = td
        rows.append(tr)
    return rows


def cfg_label(D, filt, exit_kind, stop_atr):
    dstr = f"{D[0]:02d}:{D[1]:02d}"
    fstr = "f>.10A" if filt is not None else "f-none"
    if exit_kind[0] == "time":
        estr = f"T{exit_kind[1]:02d}:{exit_kind[2]:02d}"
    else:
        estr = f"tgt{exit_kind[1]}A"
    sstr = f"s{stop_atr}A" if stop_atr is not None else "s-none"
    return f"{dstr}|{fstr}|{estr}|{sstr}"


# ---- config grid (<=16) ----
DECISIONS = [(10, 0), (10, 30)]
FILTERS = [None, 0.10]
# exit x stop combos (4)
EXIT_STOP = [
    (("time", 12, 0), None),      # E1 noon time, no stop  (primary)
    (("time", 12, 0), 0.4),       # E2 noon time, 0.4A stop
    (("target", 0.3), None),      # E3 tgt 0.3A, no stop, flat 15:45
    (("target", 0.5), 0.4),       # E4 tgt 0.5A, 0.4A stop, flat 15:45
]

GRID = []
for D in DECISIONS:
    for filt in FILTERS:
        for exit_kind, stop_atr in EXIT_STOP:
            GRID.append((D, filt, exit_kind, stop_atr))


def summarize(rows, universe_dates, label, yr_lo=None, yr_hi=None):
    t = pd.DataFrame(rows)
    if yr_lo is not None:
        t = t[(t["trade_date"].dt.year >= yr_lo) & (t["trade_date"].dt.year <= yr_hi)]
        universe_dates = universe_dates[(universe_dates.dt.year >= yr_lo)
                                        & (universe_dates.dt.year <= yr_hi)]
    if len(t) == 0:
        return {"label": label, "n": 0}, 0.0
    m = metrics(t[["trade_date", "pnl", "hold_s"]], universe_dates, label)
    m["avg_gross"] = round(t["gross_pts"].mean(), 2)
    m["avg_net_pts"] = round(t["pnl"].mean() / POINT, 2)
    return m, t["gross_pts"].mean()


if __name__ == "__main__":
    ts, o, h, l, c, dayidx, days = load()
    comp_mask, noncomp_mask = eligible_mask(days, dayidx)
    comp = days[comp_mask].copy()
    noncomp = days[noncomp_mask].copy()
    comp_dates = pd.to_datetime(comp["trade_date"])
    print(f"# eligible compressed days (in cache): {len(comp)}  "
          f"non-compressed control days: {len(noncomp)}")
    print(f"# compressed by year: "
          + " ".join(f"{y}:{n}" for y, n in comp["year"].value_counts().sort_index().items()))
    print()
    print("=" * 140)
    print("DEV SWEEP 2021-2024 (compressed x aligned-direction)")
    print("=" * 140)
    dev_dates = comp_dates[(comp_dates.dt.year >= 2021) & (comp_dates.dt.year <= 2024)]
    results = []
    for (D, filt, exit_kind, stop_atr) in GRID:
        rows = build_rows(comp, dayidx, ts, o, h, l, c, D[0], D[1], filt,
                          exit_kind, stop_atr)
        m, _ = summarize(rows, comp_dates, cfg_label(D, filt, exit_kind, stop_atr),
                         2021, 2024)
        results.append((m, (D, filt, exit_kind, stop_atr), rows))
        line = fmt_row(m)
        if m.get("n", 0):
            line += f" grossPt={m['avg_gross']} netPt={m['avg_net_pts']}"
        print(line)

    print()
    print("Survival screen (dev 2021-2024): PF>=1.3, all 4 years +, n>=100")
    cand = []
    for m, cfg, rows in results:
        if m.get("n", 0) < 100:
            continue
        if m["pf"] == np.inf or m["pf"] < 1.3:
            continue
        if m["years_pos"] < m["years_n"] or m["years_n"] < 4:
            continue
        cand.append((m, cfg, rows))
    cand.sort(key=lambda x: -x[0]["pf"])
    for m, cfg, rows in cand:
        print("  PASS ", fmt_row(m))
    if not cand:
        print("  (no dev config passes the survival screen)")

    # export dev results for the doc
    out = []
    for m, cfg, rows in results:
        out.append({k: (v if not isinstance(v, dict) else v)
                    for k, v in m.items() if k != "per_year"} | {"per_year": m.get("per_year", {})})
    with open(f"{BASE}/B6-dev-results.json", "w") as f:
        json.dump({"grid": [cfg_label(*c[1]) for c in results],
                   "results": out}, f, indent=1, default=str)
    print("\n# wrote B6-dev-results.json")
