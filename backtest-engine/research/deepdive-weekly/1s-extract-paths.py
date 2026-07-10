#!/usr/bin/env python3
"""Extract 1s path primitives per composite signal (entry-sweep support).

Per signal, walking 1s bars of the signal's contract from signal time:
  entry_open : first 1s bar open after signal (baseline market fill basis)
  T1, S1     : seconds-from-signal of first target / stop touch (None if not
               within horizon). Walk stops at min(T1,S1) resolution or horizon.
  stair      : pullback staircase up to resolution — list of [sec, extreme]
               where extreme = new running LOW (long) / HIGH (short). A limit
               at E fills at the first stair step reaching E (fill time = that
               step's sec). Same-second ties resolved conservatively later.
Output: results/signal_paths.json (one record per composite signal, incl. the
signals that the busy-filter would skip — sequencing is applied in the sweep).
"""

import bisect
import csv
import glob
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
DATA = Path("/home/drew/projects/slingshot-services/backtest-engine/data")
ET = ZoneInfo("America/New_York")
CONFL_PCT = 0.15
TIMEOUT_H = 72
FADE_MINUTES = 120

# ---- signals (identical regeneration to 1s-validate-composite.py) ----
snaps = []
for fp in sorted(glob.glob(str(DATA / "gex/nq/nq_gex_*.json"))):
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

signals = []
for r in csv.DictReader(open(HERE / "races/races_NQ.csv")):
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
        side = "long"
    elif not sup_between and res_between:
        side = "short"
    else:
        continue
    signals.append(dict(t_utc=t, t_et=r["t_et"], side=side, up=up, dn=dn,
                        spot=spot, symbol=r["symbol"]))
signals.sort(key=lambda x: x["t_utc"])
print(f"signals: {len(signals)}")

# ---- 1s access ----
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


records = []
for k, sig in enumerate(signals):
    sym, side = sig["symbol"], sig["side"]
    tgt, stp = (sig["up"], sig["dn"]) if side == "long" else (sig["dn"], sig["up"])
    start_ms = int(sig["t_utc"] // 60) * 60000
    deadline = sig["t_utc"] + TIMEOUT_H * 3600
    entry_open = None
    t1 = s1 = None
    stair = []
    ext = None  # running low (long) / high (short)
    fade = 0
    j = bisect.bisect_left(minute_keys, start_ms)
    while j < len(minute_keys):
        mkey = minute_keys[j]
        j += 1
        if mkey / 1000 > deadline:
            break
        rows = read_minute(mkey)
        srows = [x for x in rows if x[5] == sym]
        if not srows:
            if rows and entry_open is not None:
                fade += 1
                if fade >= FADE_MINUTES:
                    break
            continue
        fade = 0
        done = False
        for ts_str, o, h, l, c, _ in srows:
            tsec = datetime.fromisoformat(ts_str[:19] + "+00:00").timestamp()
            if tsec <= sig["t_utc"]:
                continue
            off = round(tsec - sig["t_utc"])
            if entry_open is None:
                entry_open = o
            hit_t = h >= tgt if side == "long" else l <= tgt
            hit_s = l <= stp if side == "long" else h >= stp
            new_ext = l if side == "long" else h
            if ext is None or (new_ext < ext if side == "long" else new_ext > ext):
                ext = new_ext
                stair.append([off, new_ext])
            if hit_t and t1 is None:
                t1 = off
            if hit_s and s1 is None:
                s1 = off
            if t1 is not None or s1 is not None:
                done = True
                break
        if done:
            break
        if entry_open is None and mkey / 1000 > sig["t_utc"] + 1800:
            break
    if entry_open is None:
        continue
    records.append(dict(t_et=sig["t_et"], t_utc=sig["t_utc"], side=side,
                        symbol=sym, spot=sig["spot"], up=sig["up"], dn=sig["dn"],
                        entry_open=entry_open, T1=t1, S1=s1, stair=stair))
    if k % 200 == 0:
        print(f"  {k}/{len(signals)}")

json.dump(records, open(HERE / "results/signal_paths.json", "w"))
print(f"wrote {len(records)} path records -> results/signal_paths.json")
