#!/usr/bin/env python3
"""Fresh 1s confirmation pass for the ES-15m confluence gate (Phase 3, step 5).

Signals kept ONLY when the ES 15m clear-path composite state at signal time
(latest ES race sample within 2h, ES GEX snapshot <=45min old at that sample)
agrees with the NQ signal side. Slot re-sequencing honest (gate applied
pre-sim). v1 execution: limit entry 10% pullback, target/stop = LT levels,
ts_8h time-stop, stop -0.5 slip, comm 0.2, same-second stop-before-target.
"""

import bisect
import csv
import glob
import json
import math
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
DATA = Path("/home/drew/projects/slingshot-services/backtest-engine/data")
ET = ZoneInfo("America/New_York")
STOP_SLIP, COMM = 0.5, 0.2
PULL_F = 0.1
TS_H = 8
CONFL_PCT = 0.15

# ---------- ES 15m composite timeline ----------
print("loading ES GEX snapshots...")
snaps = []
for fp in sorted(glob.glob(str(DATA / "gex/es/es_gex_*.json"))):
    try:
        d = json.load(open(fp))
    except Exception:
        continue
    for s in d.get("data", []):
        try:
            ts = datetime.fromisoformat(s["timestamp"].replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        snaps.append((ts, s))
snaps.sort(key=lambda x: x[0])
snap_ts = [x[0] for x in snaps]

es15 = []
for r in csv.DictReader(open(HERE / "races/races_ES15.csv")):
    t = datetime.strptime(r["t_et"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=ET).timestamp()
    i = bisect.bisect_right(snap_ts, t) - 1
    if i < 0 or t - snap_ts[i] > 2700:
        continue
    s = snaps[i][1]
    spot, up, dn = float(r["spot"]), float(r["up"]), float(r["dn"])
    res = [x for x in (s.get("resistance") or []) if x]
    sup = [x for x in (s.get("support") or []) if x]
    eps = spot * CONFL_PCT / 100
    res_between = any(spot < x < up - eps for x in res)
    sup_between = any(dn + eps < x < spot for x in sup)
    if not res_between and sup_between:
        st = "long"
    elif not sup_between and res_between:
        st = "short"
    else:
        st = "none"
    es15.append((t, st))
es15.sort()
es15_ts = [x[0] for x in es15]


def es_state(t):
    i = bisect.bisect_right(es15_ts, t) - 1
    if i < 0 or t - es15[i][0] > 7200:
        return None
    return es15[i][1]


# ---------- gate signals ----------
paths = json.load(open(HERE / "results/signal_paths.json"))
paths.sort(key=lambda p: p["t_utc"])
kept = [p for p in paths if es_state(p["t_utc"]) == p["side"]]
print(f"signals: {len(paths)} total, {len(kept)} kept (es15 agree)")
paths = kept

# ---------- 1s sim ----------
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


trades = []
busy = 0.0

for p in paths:
    if p["T1"] is None and p["S1"] is None:
        continue
    if p["t_utc"] < busy:
        continue
    side, spot = p["side"], p["spot"]
    sgn = 1 if side == "long" else -1
    tgt, stp = (p["up"], p["dn"]) if side == "long" else (p["dn"], p["up"])
    rng = abs(spot - stp)
    E = spot - sgn * PULL_F * rng
    st = None
    start_ms = int(p["t_utc"] // 60) * 60000
    j = bisect.bisect_left(minute_keys, start_ms)
    t_end = p["t_utc"] + 73 * 3600
    done = False
    while j < len(minute_keys) and not done:
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
            if st is None:
                if hit_tgt and not hit_E:
                    busy = tsec; done = True; break  # missed
                elif hit_E:
                    st = dict(t0=tsec)
                    if hit_tgt:
                        busy = tsec; done = True; break
                continue
            if tsec - st["t0"] >= TS_H * 3600:
                trades.append(dict(t=p["t_et"], pts=sgn * (c - E) - COMM, x="ts"))
                busy = tsec; done = True; break
            hit_stop = (l <= stp) if side == "long" else (h >= stp)
            if hit_stop:
                exit_px = stp - sgn * STOP_SLIP
                trades.append(dict(t=p["t_et"], pts=sgn * (exit_px - E) - COMM, x="stop"))
                busy = tsec; done = True; break
            if hit_tgt:
                trades.append(dict(t=p["t_et"], pts=sgn * (tgt - E) - COMM, x="tgt"))
                busy = tsec; done = True; break

json.dump(trades, open(HERE / "results/es15_gate_trades.json", "w"))


def line(lab, tr):
    n = len(tr)
    if n < 5:
        print(f"{lab:8s} n={n}")
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
    print(f"{lab:8s} n={n:4d} WR={len(wins)/n*100:5.1f} PF={pos/max(neg,.01):6.2f} "
          f"avg={m:+6.1f} tot={cum:+8.0f} maxDD={dd:5.0f} tShp={m/sd*math.sqrt(n):5.1f} exits={xc}")


line("ALL", trades)
for y in ("2023", "2024", "2025", "2026"):
    line(y, [t for t in trades if t["t"].startswith(y)])
