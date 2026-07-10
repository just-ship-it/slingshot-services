#!/usr/bin/env python3
"""Entry-placement sweep over cached 1s path primitives (signal_paths.json).

Entry rules evaluated (longs; shorts mirrored):
  market        : fill at entry_open +/- 0.25 slip (baseline = 1s validation)
  pull_f        : limit at spot -/+ f*(spot-stop_level distance); f in sweep
  struct        : limit at nearest point-in-time structure level between stop
                  zone and spot (pd_low/pd_close/rth_open/on_low/hourly lows
                  for longs; mirrored highs for shorts); skip if none
  struct_mkt    : same but fall back to market when no structure level exists

Fill semantics from the staircase (running adverse extreme before resolution):
  limit fills at first staircase step reaching E (fill time = step sec).
  F == S1 same-second -> filled & stopped = LOSS (conservative)
  F == T1 same-second -> MISSED (conservative)
  T1 <= F (target before fill) -> MISSED, slot freed at T1
  else win at target (exact) / loss at stop (0.5 slip). Commission 0.2pt.
One position/pending order at a time (slot busy signal->exit/cancel).
"""

import csv
import json
import math
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).parent
STOP_SLIP, COMM = 0.5, 0.2

paths = json.load(open(HERE / "results/signal_paths.json"))
paths.sort(key=lambda p: p["t_utc"])

# ---- structure levels (point-in-time) ----
sess = {r["trade_date"]: r for r in csv.DictReader(open(HERE / "structure/NQ_session_levels.csv"))}
hourly = {(r["date_et"], int(r["hour_et"])): (float(r["high"]), float(r["low"]))
          for r in csv.DictReader(open(HERE / "structure/NQ_hourly_hl.csv"))}


def structure_candidates(p):
    """levels known at signal time, below spot for longs / above for shorts"""
    t = datetime.strptime(p["t_et"], "%Y-%m-%d %H:%M:%S")
    td = (t + timedelta(days=1)).date() if t.hour >= 18 else t.date()
    s = sess.get(td.isoformat())
    cands = []
    if s:
        def g(k):
            v = s.get(k)
            return float(v) if v not in (None, "", "None") else None
        for k in ("pd_high", "pd_low", "pd_close"):
            v = g(k)
            if v:
                cands.append(v)
        # same-session RTH open / completed overnight only if signal after 09:30 of its trade date
        if t.date() == td and (t.hour, t.minute) >= (9, 30):
            for k in ("rth_open", "on_high", "on_low"):
                v = g(k)
                if v:
                    cands.append(v)
    for back in (1, 2, 3):  # last 3 completed clock hours
        ht = t - timedelta(hours=back)
        hl = hourly.get((ht.date().isoformat(), ht.hour))
        if hl:
            cands.extend(hl)
    return cands


def fill_time(stair, E, side):
    for sec, ext in stair:
        if (ext <= E) if side == "long" else (ext >= E):
            return sec
    return None


def run(rule, param=None):
    trades, missed, skipped = [], 0, 0
    busy = 0.0
    for p in paths:
        if p["t_utc"] < busy:
            continue
        if p["T1"] is None and p["S1"] is None:
            continue  # 72h timeout paths (2) excluded
        side, spot = p["side"], p["spot"]
        tgt, stp = (p["up"], p["dn"]) if side == "long" else (p["dn"], p["up"])
        rng = abs(spot - stp)
        T1 = p["T1"] if p["T1"] is not None else 10**9
        S1 = p["S1"] if p["S1"] is not None else 10**9

        mkt_px = p["entry_open"] + (0.25 if side == "long" else -0.25)
        if rule == "market":
            E, F = mkt_px, 0
        elif rule == "pull":
            E = spot - param * rng if side == "long" else spot + param * rng
            F = fill_time(p["stair"], E, side)
        else:  # struct / struct_mkt
            if side == "long":
                cands = [c for c in structure_candidates(p)
                         if stp + 0.1 * rng < c < spot - 0.02 * rng]
            else:
                cands = [c for c in structure_candidates(p)
                         if spot + 0.02 * rng < c < stp - 0.1 * rng]
            if cands:
                E = max(cands) if side == "long" else min(cands)
                F = fill_time(p["stair"], E, side)
            elif rule == "struct_mkt":
                E, F = mkt_px, 0
            else:
                skipped += 1
                continue

        if F is None or T1 < F or (T1 == F and F != S1):
            missed += 1
            busy = p["t_utc"] + min(T1, S1)  # slot freed when race resolves
            continue
        if S1 <= T1 and F <= S1:
            exit_px = stp - STOP_SLIP if side == "long" else stp + STOP_SLIP
            pts = (exit_px - E if side == "long" else E - exit_px) - COMM
            end = S1
        else:  # F < T1 <= S1 path -> win
            pts = (tgt - E if side == "long" else E - tgt) - COMM
            end = T1
        trades.append(dict(t=p["t_et"], side=side, pts=pts, hold=end - F))
        busy = p["t_utc"] + end

    return trades, missed, skipped


def stats(trades):
    n = len(trades)
    if not n:
        return {}
    wins = [t for t in trades if t["pts"] > 0]
    pos = sum(t["pts"] for t in wins)
    neg = -sum(t["pts"] for t in trades if t["pts"] <= 0)
    cum = peak = dd = 0.0
    for t in trades:
        cum += t["pts"]; peak = max(peak, cum); dd = max(dd, peak - cum)
    avg_w = pos / max(len(wins), 1)
    avg_l = neg / max(n - len(wins), 1)
    return dict(n=n, wr=len(wins) / n * 100, pf=pos / max(neg, .01),
                avg=cum / n, tot=cum, dd=dd, rr=avg_w / max(avg_l, .01))


variants = [("market", None)] + [(f"pull_{f}", f) for f in (0.1, 0.2, 0.3, 0.4, 0.5)] + \
           [("struct", None), ("struct_mkt", None)]
print(f"{'variant':12s} {'n':>4} {'miss':>5} {'skip':>5} {'WR%':>5} {'PF':>5} "
      f"{'avg':>6} {'tot':>7} {'maxDD':>6} {'RR':>5}")
results = {}
for name, prm in variants:
    tr, miss, skip = run("pull" if name.startswith("pull") else name, prm)
    s = stats(tr)
    results[name] = (tr, s)
    if s:
        print(f"{name:12s} {s['n']:4d} {miss:5d} {skip:5d} {s['wr']:5.1f} {s['pf']:5.2f} "
              f"{s['avg']:+6.1f} {s['tot']:+7.0f} {s['dd']:6.0f} {s['rr']:5.2f}")

print("\nby-year PF for top variants:")
for name in ("market", "pull_0.2", "pull_0.3", "struct", "struct_mkt"):
    tr = results[name][0]
    line = f"  {name:12s}"
    for yr in ("2023", "2024", "2025", "2026"):
        ys = [t for t in tr if t["t"].startswith(yr)]
        if ys:
            p = sum(t["pts"] for t in ys if t["pts"] > 0)
            q = -sum(t["pts"] for t in ys if t["pts"] <= 0)
            line += f"  {yr}:n={len(ys)} PF={p/max(q,.01):.2f}"
    print(line)
