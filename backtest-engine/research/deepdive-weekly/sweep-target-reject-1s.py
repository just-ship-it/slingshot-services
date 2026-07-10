#!/usr/bin/env python3
"""Near-target rejection exit overlay on v1 (Phase 3, step 4).

Failure mode being targeted (market-aware-exits idea): trade runs 70-90% of
the way to the target LT level, gets rejected there, and round-trips to the
full (wide) stop or stales into the 8h time-stop.

Overlay: arm when favorable progress reaches F of the entry->target distance;
a rejection = retreat of R x dist from the post-arm peak; on the Nth
rejection exit at market (bar close). Re-arm requires reaching F again.

Variants rej_F_N with F in {0.7,0.8,0.9}, N in {1,2}, R=0.3 fixed; all on
top of the full v1 config (limit entry 10% pullback, target/stop = LT levels,
ts_8h time-stop). Control = plain v1. Fresh 1s pass, independent slot
sequencing per variant, same fill conventions as sweep-be-1s.py.
"""

import bisect
import json
import math
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
DATA = Path("/home/drew/projects/slingshot-services/backtest-engine/data")
STOP_SLIP, COMM = 0.5, 0.2
PULL_F = 0.1
TS_H = 8
REJ_R = 0.3

VARIANTS = ["v1"] + [f"rej_{f}_{n}" for f in (0.7, 0.8, 0.9) for n in (1, 2)]

paths = json.load(open(HERE / "results/signal_paths.json"))
paths.sort(key=lambda p: p["t_utc"])

idx = json.load(open(DATA / "ohlcv/nq/NQ_ohlcv_1s.index.json"))
minutes = idx["minutes"]
minute_keys = sorted(int(k) for k in minutes)
f1s = open(DATA / "ohlcv/nq/NQ_ohlcv_1s.csv", "rb")


def read_minute(mkey):
    m = minutes.get(str(mkey))
    if not m:
        return []
    f1s.seek(m["offset"])
    blob = f1s.read(m["length"]).decode("utf-8", errors="replace")
    out = []
    for line in blob.split("\n"):
        p = line.split(",")
        if len(p) < 10 or "-" in p[9]:
            continue
        out.append((p[0], float(p[4]), float(p[5]), float(p[6]), float(p[7]), p[9].strip()))
    return out


def parse_variant(v):
    _, f, n = v.split("_")
    return float(f), int(n)


trades = {v: [] for v in VARIANTS}
busy = {v: 0.0 for v in VARIANTS}

for p in paths:
    if p["T1"] is None and p["S1"] is None:
        continue
    side, spot = p["side"], p["spot"]
    sgn = 1 if side == "long" else -1
    tgt, stp = (p["up"], p["dn"]) if side == "long" else (p["dn"], p["up"])
    rng = abs(spot - stp)
    dist = abs(tgt - spot) + PULL_F * rng  # entry->target distance
    E = spot - sgn * PULL_F * rng
    active = [v for v in VARIANTS if p["t_utc"] >= busy[v]]
    if not active:
        continue
    st = {v: None for v in active}
    start_ms = int(p["t_utc"] // 60) * 60000
    j = bisect.bisect_left(minute_keys, start_ms)
    t_end = p["t_utc"] + 73 * 3600
    while j < len(minute_keys) and active:
        mkey = minute_keys[j]
        j += 1
        if mkey / 1000 > t_end:
            break
        for ts_str, o, h, l, c, sym in read_minute(mkey):
            if sym != p["symbol"]:
                continue
            tsec = datetime.fromisoformat(ts_str[:19] + "+00:00").timestamp()
            if tsec <= p["t_utc"]:
                continue
            hit_tgt = (h >= tgt) if side == "long" else (l <= tgt)
            hit_E = (l <= E) if side == "long" else (h >= E)
            fav_px = h if side == "long" else l       # best favorable this bar
            adv_px = l if side == "long" else h       # worst adverse this bar
            for v in list(active):
                s = st[v]
                if s is None:
                    if hit_tgt and not hit_E:
                        st[v] = "done"; busy[v] = tsec; active.remove(v)
                    elif hit_E:
                        st[v] = dict(t0=tsec, peak=E, armed=False, rej=0)
                        if hit_tgt:
                            st[v] = "done"; busy[v] = tsec; active.remove(v)
                    continue
                if s == "done":
                    continue
                if tsec - s["t0"] >= TS_H * 3600:
                    trades[v].append(dict(t=p["t_et"], pts=sgn * (c - E) - COMM, x="ts"))
                    st[v] = "done"; busy[v] = tsec; active.remove(v)
                    continue
                hit_stop = (l <= stp) if side == "long" else (h >= stp)
                if hit_stop:
                    exit_px = stp - sgn * STOP_SLIP
                    trades[v].append(dict(t=p["t_et"], pts=sgn * (exit_px - E) - COMM, x="stop"))
                    st[v] = "done"; busy[v] = tsec; active.remove(v)
                    continue
                if hit_tgt:
                    trades[v].append(dict(t=p["t_et"], pts=sgn * (tgt - E) - COMM, x="tgt"))
                    st[v] = "done"; busy[v] = tsec; active.remove(v)
                    continue
                if v == "v1":
                    continue
                F, N = parse_variant(v)
                if sgn * (fav_px - s["peak"]) > 0:
                    s["peak"] = fav_px
                if not s["armed"]:
                    if sgn * (s["peak"] - E) >= F * dist:
                        s["armed"] = True
                elif sgn * (s["peak"] - adv_px) >= REJ_R * dist:
                    s["rej"] += 1
                    if s["rej"] >= N:
                        trades[v].append(dict(t=p["t_et"], pts=sgn * (c - E) - COMM, x="rej"))
                        st[v] = "done"; busy[v] = tsec; active.remove(v)
                        continue
                    s["armed"] = False
                    s["peak"] = adv_px  # reset; must reach F again to re-arm
            if not active:
                break

json.dump(trades, open(HERE / "results/target_reject_trades.json", "w"))


def line(lab, tr):
    n = len(tr)
    if n < 5:
        print(f"{lab:12s} n={n}")
        return
    wins = [t for t in tr if t["pts"] > 0]
    pos = sum(t["pts"] for t in wins)
    neg = -sum(t["pts"] for t in tr if t["pts"] <= 0)
    cum = peak = dd = 0.0
    for t in tr:
        cum += t["pts"]; peak = max(peak, cum); dd = max(dd, peak - cum)
    m = cum / n
    sd = math.sqrt(sum((t["pts"] - m) ** 2 for t in tr) / (n - 1))
    xc = {}
    for t in tr:
        xc[t["x"]] = xc.get(t["x"], 0) + 1
    print(f"{lab:12s} n={n:4d} WR={len(wins)/n*100:5.1f} PF={pos/max(neg,.01):5.2f} "
          f"avg={m:+6.1f} tot={cum:+8.0f} maxDD={dd:5.0f} tShp={m/sd*math.sqrt(n):5.1f}  "
          f"exits={xc}")


for v in VARIANTS:
    line(v, trades[v])
print("\nby year:")
for v in VARIANTS:
    for y in ("2023", "2024", "2025", "2026"):
        tr = [t for t in trades[v] if t["t"].startswith(y)]
        if len(tr) < 5:
            continue
        pos = sum(t["pts"] for t in tr if t["pts"] > 0)
        neg = -sum(t["pts"] for t in tr if t["pts"] <= 0)
        print(f"  {v:12s} {y}: n={len(tr):4d} PF={pos/max(neg,.01):5.2f} "
              f"tot={sum(t['pts'] for t in tr):+7.0f}")
