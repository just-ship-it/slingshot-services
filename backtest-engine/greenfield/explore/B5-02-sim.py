#!/usr/bin/env python3
"""
B5-02: honest 1s thrust-fade simulator.

Consumes B5-events.csv (causal thrust signals) + the raw 1s RTH cache.
Fade = COUNTER to thrust direction. All fills/exits walk 1s bars from the fill
instant. Rules (from brief, non-negotiable):
  - market entry = first 1s bar ts>=place_ts, open + side*0.25 (adverse).
  - limit entry (fade-from-deeper) = limit at det_close + dir*lim_off, placed in
    the THRUST direction; fills exactly at limit on first bar within lim_win_s
    that reaches it (short: high>=lim; long: low<=lim). No fill -> no trade.
  - target = limit exact (entry + side*targ_pts). stop = entry - side*stop_pts,
    fills at stop - side*0.5 (adverse). time/flat exit = bar open - side*0.25.
  - stop priority on same-1s-bar tie; target ineligible on the entry bar.
  - deadline = min(entry_ts + hold*60, 15:45 ET). No entries after 15:15 ET.
  - $5 RT commission, $20/pt, 1 contract. Exclude roll days (roll_ok=False).
  - cooldown 5 min per day on threshold-passing thrusts BEFORE vm3/atr subset
    (mirrors census).
Reports per config: n, WR, PF, Sharpe(daily), maxDD, avg$/trade, avg gross
pts/trade, median hold, per-year. Also a 2x-slippage line for the frozen config.

usage: python3 B5-02-sim.py [dev|lock|validate]
  dev      : run the disclosed dev grid on 2021-2024
  descstat : gross +15m aligned-drift replication (no costs) on 2021-2024
  lock     : run the single frozen config on 2025-2026 (locked set)
"""
import json, sys
import numpy as np
import pandas as pd
from datetime import datetime
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
ET = ZoneInfo("America/New_York")
POINT, COMM_RT, SLIP_STOP, SLIP_MKT = 20.0, 5.0, 0.5, 0.25

MODE = sys.argv[1] if len(sys.argv) > 1 else "dev"

# ---------- load 1s cache ----------
print("loading 1s cache...", file=sys.stderr)
df = pd.read_csv(f"{BASE}/cache_nq_rth_1s.csv",
                 dtype={"ts": np.int64, "o": np.float64, "h": np.float64,
                        "l": np.float64, "c": np.float64, "v": np.int64})
TS = df["ts"].to_numpy(); O = df["o"].to_numpy(); H = df["h"].to_numpy()
L = df["l"].to_numpy(); C = df["c"].to_numpy()
with open(f"{BASE}/cache_nq_rth_1s.days.json") as f:
    DAYIDX = json.load(f)
print("rows:", len(TS), file=sys.stderr)

def et_ep(dstr, hh, mm):
    y, m, d = map(int, dstr.split("-"))
    return int(datetime(y, m, d, hh, mm, tzinfo=ET).timestamp())

# ---------- events ----------
EV = pd.read_csv(f"{BASE}/B5-events.csv")
EV["year"] = EV.date.str[:4].astype(int)

# calendar of trading days (for daily Sharpe incl zero-trade days)
META = pd.read_csv(f"{BASE}/B12-days.csv", parse_dates=["trade_date"])
META["ds"] = META.trade_date.dt.strftime("%Y-%m-%d")
FULL_DAYS = set(META.loc[META.full_rth == True, "ds"])

# ---------- per-trade sim ----------
def sim_trade(dstr, place_ts, dr, det_close, atr14, cfg):
    """Return (gross_pts, pnl_dollars, hold_s, reason) or None if no fill."""
    lo, hi = DAYIDX[dstr]
    ts = TS[lo:hi]
    n = hi - lo
    p0 = np.searchsorted(ts, place_ts, "left")
    if p0 >= n:
        return None
    side = -dr                               # fade
    slip_stop = SLIP_STOP * cfg["slipx"]; slip_mkt = SLIP_MKT * cfg["slipx"]
    flat_ts = et_ep(dstr, 15, 45)
    # ---- entry ----
    if cfg["entry"] == "mkt":
        ei = lo + p0
        entry_px = O[ei] + side * slip_mkt
        entry_ts = ts[p0]
    else:                                    # limit fade-from-deeper
        lim = det_close + dr * cfg["lim_off"]
        win_hi = np.searchsorted(ts, place_ts + cfg["lim_win_s"], "right")
        seg = slice(lo + p0, lo + win_hi)
        if dr > 0:                           # up-thrust -> short, sell lim above
            cond = H[seg] >= lim
        else:                                # down-thrust -> long, buy lim below
            cond = L[seg] <= lim
        if not cond.any():
            return None
        rel = int(np.argmax(cond))
        ei = lo + p0 + rel
        entry_px = lim
        entry_ts = ts[p0 + rel]
    targ = entry_px + side * cfg["targ_c"] * atr14
    stop = entry_px - side * cfg["stop_c"] * atr14
    deadline = min(entry_ts + cfg["hold_m"] * 60, flat_ts)
    # ---- exit walk from entry bar ----
    ridx = ei - lo                           # relative index of entry bar
    dend = np.searchsorted(ts, deadline, "left")  # first bar ts>=deadline
    scan_hi = dend if dend > ridx else n
    hh = H[lo + ridx:lo + scan_hi]; ll = L[lo + ridx:lo + scan_hi]
    if side > 0:                             # long
        s_cond = ll <= stop; t_cond = hh >= targ
    else:                                    # short
        s_cond = hh >= stop; t_cond = ll <= targ
    s_rel = int(np.argmax(s_cond)) if s_cond.any() else -1
    t_rel = -1
    if t_cond.any():
        t_cond[0] = False                    # target ineligible on entry bar
        if t_cond.any():
            t_rel = int(np.argmax(t_cond))
    if s_rel >= 0 and (t_rel < 0 or s_rel <= t_rel):
        exit_px = stop - side * slip_stop; reason = "stop"
        exit_ts = ts[ridx + s_rel]
    elif t_rel >= 0:
        exit_px = targ; reason = "target"; exit_ts = ts[ridx + t_rel]
    else:
        # time/flat exit at first bar >= deadline (or last bar)
        xi = dend if (dend > ridx and dend < n) else n - 1
        exit_px = O[lo + xi] - side * slip_mkt; reason = "time"
        exit_ts = ts[xi]
    gross_pts = side * (exit_px - entry_px)
    pnl = gross_pts * POINT - COMM_RT
    return gross_pts, pnl, int(exit_ts - entry_ts), reason

# ---------- config runner ----------
def run_config(cfg, years):
    sub = EV[(EV.mult >= cfg["k"]) & (EV.roll_ok == True) & EV.year.isin(years)].copy()
    if cfg["atr"] == "top":
        sub = sub[(sub.atr_top == True) & (sub.atr_known == True)]
    # no entries after 15:15 ET
    keep = []
    for dstr, g in sub.groupby("date"):
        cut = et_ep(dstr, 15, 15)
        g = g[g.place_ts <= cut].sort_values("m")
        # 5-min cooldown on threshold-passing thrusts
        last = -100
        for _, r in g.iterrows():
            if r.m - last >= 5:
                keep.append(r)
                last = r.m
    if not keep:
        return None, None
    kdf = pd.DataFrame(keep)
    kdf = kdf[kdf.vm3 >= cfg["vm3"]]         # vm3 gate AFTER cooldown (census order)
    recs = []
    for _, r in kdf.iterrows():
        out = sim_trade(r.date, int(r.place_ts), int(r.dir), float(r.det_close),
                        float(r.atr14), cfg)
        if out is None:
            continue
        g, pnl, hold, reason = out
        recs.append((r.date, r.year, g, pnl, hold, reason))
    if not recs:
        return None, None
    t = pd.DataFrame(recs, columns=["date", "year", "gross", "pnl", "hold_s", "reason"])
    return t, metrics(t, years)

def metrics(t, years):
    wins = t.pnl[t.pnl > 0].sum(); losses = -t.pnl[t.pnl <= 0].sum()
    cal_days = sorted(d for d in FULL_DAYS if int(d[:4]) in years)
    daily = t.groupby("date")["pnl"].sum()
    cal = pd.Series(0.0, index=cal_days)
    cal.loc[daily.index] = daily.values
    sharpe = cal.mean() / cal.std() * np.sqrt(252) if cal.std() > 0 else np.nan
    eq = cal.cumsum(); dd = (eq - eq.cummax()).min()
    py = {}
    for y, gg in t.groupby("year"):
        w = gg.pnl[gg.pnl > 0].sum(); l = -gg.pnl[gg.pnl <= 0].sum()
        py[int(y)] = (round(gg.pnl.sum()), len(gg),
                      round(w / l, 2) if l > 0 else np.inf)
    return {"n": len(t), "wr": round((t.pnl > 0).mean() * 100, 1),
            "pf": round(wins / losses, 3) if losses > 0 else np.inf,
            "pnl": round(t.pnl.sum()), "avg": round(t.pnl.mean(), 1),
            "gpts": round(t.gross.mean(), 2), "sharpe": round(sharpe, 2),
            "maxdd": round(dd), "hold_med_m": round(t.hold_s.median() / 60, 1),
            "yrs_pos": sum(1 for v, _, _ in py.values() if v > 0),
            "yrs_n": len(py), "per_year": py,
            "reasons": t.reason.value_counts().to_dict()}

def fmt(label, m):
    if m is None:
        return f"{label:<46} NO TRADES"
    yy = " ".join(f"{y}:${v}/n{n}/pf{p}" for y, (v, n, p) in sorted(m["per_year"].items()))
    return (f"{label:<46} n={m['n']:<5} WR={m['wr']:<5} PF={m['pf']:<6} "
            f"avg=${m['avg']:<6} gpts={m['gpts']:<6} Sh={m['sharpe']:<6} "
            f"DD=${m['maxdd']:<8} hMed={m['hold_med_m']}m "
            f"y+={m['yrs_pos']}/{m['yrs_n']}\n      [{yy}]  {m['reasons']}")

# base config template
def CFG(**kw):
    d = dict(k=2.0, vm3=1.5, atr="all", targ_c=0.15, stop_c=0.30, hold_m=15,
             entry="mkt", lim_off=8.0, lim_win_s=180, slipx=1.0)
    d.update(kw); return d

DEV_YEARS = [2021, 2022, 2023, 2024]
LOCK_YEARS = [2025, 2026]

if MODE == "descstat":
    # gross +15m aligned drift (no costs), causal-signal replication of census
    print("== GROSS +15m aligned drift (dir*fwd), no costs, 2021-2024 ==")
    sub = EV[(EV.mult >= 2.0) & (EV.roll_ok == True) & EV.year.isin(DEV_YEARS)]
    for lab, msk in [("vacuum vm3<=0.7", sub.vm3 <= 0.7),
                     ("mid 0.7-1.5", (sub.vm3 > 0.7) & (sub.vm3 < 1.5)),
                     ("heavy vm3>=1.5", sub.vm3 >= 1.5),
                     ("HEAVY vm3>=2.5", sub.vm3 >= 2.5)]:
        s = sub[msk]; drifts = []
        for _, r in s.iterrows():
            lo, hi = DAYIDX[r.date]; ts = TS[lo:hi]
            i0 = np.searchsorted(ts, r.det_ts, "left")
            i1 = np.searchsorted(ts, r.det_ts + 900, "left")
            if i1 >= hi - lo:
                continue
            drifts.append(r.dir * (C[lo + i1] - C[lo + i0]))
        drifts = np.array(drifts)
        print(f"  {lab:<18} n={len(drifts):<6} mean aligned +15m = "
              f"{drifts.mean():+.3f} pts  (fade gross = {-drifts.mean():+.3f})")
    sys.exit(0)

if MODE == "lock":
    import importlib.util
    # frozen config is declared in B5-frozen.json (written before this runs)
    with open(f"{BASE}/B5-frozen.json") as f:
        frozen = json.load(f)
    cfg = CFG(**frozen)
    print("FROZEN CONFIG:", json.dumps(frozen))
    t, m = run_config(cfg, LOCK_YEARS)
    print(fmt("LOCKED 2025-2026", m))
    cfg2 = dict(cfg); cfg2["slipx"] = 2.0
    t2, m2 = run_config(cfg2, LOCK_YEARS)
    print(fmt("LOCKED 2025-2026 (2x slip)", m2))
    sys.exit(0)

# ---------- DEV GRID ----------
print("=" * 100)
print("DEV GRID 2021-2024 (all configs disclosed)")
print("=" * 100)
# Stage A: signal scan, fixed exit (targ .15/stop .30/hold15/mkt)
print("\n-- Stage A: signal scan (exit fixed: targ0.15 stop0.30 hold15 mkt) --")
gridA = []
for k in [1.5, 2.0]:
    for vm3 in [1.5, 2.5]:
        for atr in ["all", "top"]:
            gridA.append(("A", CFG(k=k, vm3=vm3, atr=atr)))
results = {}
for tag, cfg in gridA:
    lbl = f"k{cfg['k']} vm3>={cfg['vm3']} atr={cfg['atr']}"
    t, m = run_config(cfg, DEV_YEARS)
    results[lbl] = m
    print(fmt(lbl, m))

# Stage B: exit sweep on heavy+top signal cell (census a-priori best)
print("\n-- Stage B: exit sweep on k2.0 vm3>=2.5 atr=top --")
for targ in [0.10, 0.20]:
    for hold in [15, 30]:
        for entry in ["mkt", "lim"]:
            cfg = CFG(k=2.0, vm3=2.5, atr="top", targ_c=targ, stop_c=0.30,
                    hold_m=hold, entry=entry)
            lbl = f"targ{targ} stop0.30 hold{hold} {entry}"
            t, m = run_config(cfg, DEV_YEARS)
            print(fmt(lbl, m))
