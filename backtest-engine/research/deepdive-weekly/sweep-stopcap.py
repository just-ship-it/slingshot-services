#!/usr/bin/env python3
"""Stop-cap sweep on top of pullback limit entries (cached 1s paths).

Stop = tighter of (opposite LT level) and (entry - cap pts) for longs.
Cap-hit time = first staircase step reaching the cap price (staircase records
running adverse extremes at 1s resolution; steps beyond the entry price occur
after the fill by construction). Conservative: cap/stop tie with target -> loss.
"""

import json
import math
from pathlib import Path

HERE = Path(__file__).parent
STOP_SLIP, COMM = 0.5, 0.2

paths = json.load(open(HERE / "results/signal_paths.json"))
paths.sort(key=lambda p: p["t_utc"])


def first_reach(stair, px, side):
    for sec, ext in stair:
        if (ext <= px) if side == "long" else (ext >= px):
            return sec
    return None


def run(pull_f, cap):
    trades = []
    busy = 0.0
    for p in paths:
        if p["t_utc"] < busy:
            continue
        if p["T1"] is None and p["S1"] is None:
            continue
        side, spot = p["side"], p["spot"]
        tgt, stp = (p["up"], p["dn"]) if side == "long" else (p["dn"], p["up"])
        rng = abs(spot - stp)
        T1 = p["T1"] if p["T1"] is not None else 10**9

        E = spot - pull_f * rng if side == "long" else spot + pull_f * rng
        F = first_reach(p["stair"], E, side)
        if F is None or T1 <= F:
            busy = p["t_utc"] + min(T1, p["S1"] or 10**9)
            continue
        # effective stop price
        if cap is not None:
            stop_px = max(stp, E - cap) if side == "long" else min(stp, E + cap)
        else:
            stop_px = stp
        Sx = first_reach(p["stair"], stop_px, side)
        Sx = Sx if Sx is not None else 10**9
        if Sx <= T1:
            exit_px = stop_px - STOP_SLIP if side == "long" else stop_px + STOP_SLIP
            pts = (exit_px - E if side == "long" else E - exit_px) - COMM
            end = Sx
        else:
            pts = (tgt - E if side == "long" else E - tgt) - COMM
            end = T1
        trades.append(dict(t=p["t_et"], pts=pts))
        busy = p["t_utc"] + end
    return trades


def stats(tr):
    n = len(tr)
    wins = [t for t in tr if t["pts"] > 0]
    pos = sum(t["pts"] for t in wins)
    neg = -sum(t["pts"] for t in tr if t["pts"] <= 0)
    cum = peak = dd = 0.0
    for t in tr:
        cum += t["pts"]; peak = max(peak, cum); dd = max(dd, peak - cum)
    m = cum / n
    sd = math.sqrt(sum((t["pts"] - m) ** 2 for t in tr) / (n - 1))
    avg_w = pos / max(len(wins), 1)
    avg_l = neg / max(n - len(wins), 1)
    return (f"n={n:4d} WR={len(wins)/n*100:5.1f}% PF={pos/max(neg,.01):5.2f} "
            f"avg={m:+6.1f} tot={cum:+7.0f} maxDD={dd:6.0f} RR={avg_w/max(avg_l,.01):5.2f} "
            f"tSharpe={m/sd*math.sqrt(n):5.1f}")


for f in (0.1, 0.3):
    print(f"\n=== entry pull_{f} ===")
    for cap in (20, 30, 40, 60, 80, 120, None):
        tr = run(f, cap)
        yr = {}
        for t in tr:
            yr.setdefault(t["t"][:4], []).append(t["pts"])
        ys = " ".join(f"{y}:{'+' if sum(v)>0 else ''}{sum(v):.0f}" for y, v in sorted(yr.items()))
        print(f"  cap={str(cap):>4s}  {stats(tr)}  [{ys}]")
