#!/usr/bin/env python3
"""BE / time-stop sweep on 1s bars, entry = pull_0.1 limit (winner of entry sweep).

All variants evaluated in ONE 1s pass, each with independent slot sequencing:
  be_a_b   : after price moves +a pts favorable from entry, stop -> entry+b
             (b may be negative = reduced risk, 0 = true BE, +pts = lock)
  ts_H     : flat time-stop at H hours (exit market at first bar past H)
  none     : uncapped LT stop (control; must match sweep-entries pull_0.1)
Fills: limit entry exact at E, target limit exact, stops -0.5 slip, comm 0.2.
Same-second conservatism: stop checked before target on every bar.
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

VARIANTS = (["none"] +
            [f"be_{a}_{b}" for a in (40, 60, 80, 100) for b in (0, 10)] +
            [f"ts_{h}" for h in (2, 4, 8)])

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


trades = {v: [] for v in VARIANTS}
busy = {v: 0.0 for v in VARIANTS}

for p in paths:
    if p["T1"] is None and p["S1"] is None:
        continue
    side, spot = p["side"], p["spot"]
    sgn = 1 if side == "long" else -1
    tgt, stp = (p["up"], p["dn"]) if side == "long" else (p["dn"], p["up"])
    rng = abs(spot - stp)
    E = spot - sgn * PULL_F * rng
    active = [v for v in VARIANTS if p["t_utc"] >= busy[v]]
    if not active:
        continue
    # states: None=waiting fill; dict=open; 'done'
    st = {v: None for v in active}
    open_ct = 0
    filled = False
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
            fav = h - E if side == "long" else E - l
            hit_tgt = (h >= tgt) if side == "long" else (l <= tgt)
            hit_E = (l <= E) if side == "long" else (h >= E)
            for v in list(active):
                s = st[v]
                if s is None:
                    if hit_tgt and not hit_E:
                        st[v] = "done"; busy[v] = tsec; active.remove(v)  # missed
                    elif hit_E:
                        st[v] = dict(stop=stp, be=False, t0=tsec)
                        if hit_tgt:  # fill+target same second -> missed (consv.)
                            st[v] = "done"; busy[v] = tsec; active.remove(v)
                    continue
                if s == "done":
                    continue
                # open trade
                if v.startswith("ts_"):
                    if tsec - s["t0"] >= int(v[3:]) * 3600:
                        pts = sgn * (c - E) - COMM
                        trades[v].append(dict(t=p["t_et"], pts=pts))
                        st[v] = "done"; busy[v] = tsec; active.remove(v)
                        continue
                if v.startswith("be_") and not s["be"]:
                    a, b = (int(x) for x in v[3:].split("_"))
                    if fav >= a:
                        s["stop"] = E + sgn * b
                        s["be"] = True
                stop_px = s["stop"]
                hit_stop = (l <= stop_px) if side == "long" else (h >= stop_px)
                if hit_stop:  # conservative: stop before target
                    exit_px = stop_px - sgn * STOP_SLIP
                    trades[v].append(dict(t=p["t_et"], pts=sgn * (exit_px - E) - COMM))
                    st[v] = "done"; busy[v] = tsec; active.remove(v)
                elif hit_tgt:
                    trades[v].append(dict(t=p["t_et"], pts=sgn * (tgt - E) - COMM))
                    st[v] = "done"; busy[v] = tsec; active.remove(v)
            if not active:
                break

json.dump(trades, open(HERE / "results/be_ts_trades.json", "w"))

print(f"{'variant':10s} {'n':>4} {'WR%':>5} {'PF':>5} {'avg':>6} {'tot':>7} {'maxDD':>6} {'RR':>5} {'tShp':>5}")
for v in VARIANTS:
    tr = trades[v]
    if not tr:
        continue
    n = len(tr)
    wins = [t for t in tr if t["pts"] > 0]
    pos = sum(t["pts"] for t in wins)
    neg = -sum(t["pts"] for t in tr if t["pts"] <= 0)
    cum = peak = dd = 0.0
    for t in tr:
        cum += t["pts"]; peak = max(peak, cum); dd = max(dd, peak - cum)
    m = cum / n
    sd = math.sqrt(sum((t["pts"] - m) ** 2 for t in tr) / (n - 1))
    aw = pos / max(len(wins), 1); al = neg / max(n - len(wins), 1)
    print(f"{v:10s} {n:4d} {len(wins)/n*100:5.1f} {pos/max(neg,.01):5.2f} {m:+6.1f} "
          f"{cum:+7.0f} {dd:6.0f} {aw/max(al,.01):5.2f} {m/sd*math.sqrt(n):5.1f}")
