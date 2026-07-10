#!/usr/bin/env python3
"""1s-honest validation of the LT-GEX clear-path composite rule (Phase 3, step 1).

Signals are regenerated from races_NQ.csv + GEX snapshots WITHOUT any reference
to 1m race outcomes (so same-bar-ambiguous and censored races are back in).
Composite: LONG when no GEX resistance sits between spot and the up-LT target
AND a GEX support sits between spot and the down-LT level; SHORT mirrored.

Execution on 1s bars (via NQ_ohlcv_1s.index.json minute->byte-offset seeks):
  - entry: first 1s bar of the signal's contract with ts > signal ts,
           fill = open + 0.25pt adverse slip (market order)
  - target (LT level): limit, fills EXACT when touched (high>=tgt long / low<=tgt short)
  - stop (opposite LT level): stop-market, fill = stop -/+ 0.5pt slip
  - same 1s bar touches BOTH -> counted as STOP (conservative)
  - timeout 72h -> exit at last close; contract fade-out (symbol absent from
    120 consecutive data-minutes) -> exit at last symbol close (rollover guard)
  - one position at a time (signals during a trade are skipped), commissions 0.2pt RT
Outputs results/onesec_trades.csv + summary, and the 1m-sim comparison gate
(trade count / WR / PF within ~10% per CLAUDE.md).
"""

import bisect
import csv
import glob
import json
import math
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
DATA = Path("/home/drew/projects/slingshot-services/backtest-engine/data")
ET = ZoneInfo("America/New_York")

ENTRY_SLIP = 0.25
STOP_SLIP = 0.5
COMMISSION = 0.2
CONFL_PCT = 0.15
TIMEOUT_H = 72
FADE_MINUTES = 120

# ---------- signals ----------
print("loading GEX snapshots...")
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
print(f"composite signals: {len(signals)} "
      f"({sum(1 for x in signals if x['side']=='long')} long / "
      f"{sum(1 for x in signals if x['side']=='short')} short)")

# ---------- 1s access via index ----------
idx = json.load(open(DATA / "ohlcv/nq/NQ_ohlcv_1s.index.json"))
minutes = idx["minutes"]
minute_keys = sorted(int(k) for k in minutes)
f1s = open(DATA / "ohlcv/nq/NQ_ohlcv_1s.csv", "rb")


def read_minute(mkey):
    """yield (ts_str, o,h,l,c, symbol) rows for a minute (epoch-ms key)"""
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


def minute_iter(start_ms):
    j = bisect.bisect_left(minute_keys, start_ms)
    while j < len(minute_keys):
        yield minute_keys[j]
        j += 1


# ---------- simulate ----------
trades = []
busy_until = 0.0
for sig in signals:
    if sig["t_utc"] < busy_until:
        continue
    sym, side = sig["symbol"], sig["side"]
    tgt, stp = (sig["up"], sig["dn"]) if side == "long" else (sig["dn"], sig["up"])
    start_ms = int(sig["t_utc"] // 60) * 60000
    entry = entry_ts = None
    exit_px = exit_reason = exit_ts = None
    last_px, last_ts = None, None
    fade = 0
    deadline = sig["t_utc"] + TIMEOUT_H * 3600

    for mkey in minute_iter(start_ms):
        if mkey / 1000 > deadline:
            exit_px, exit_reason, exit_ts = last_px, "timeout", last_ts
            break
        rows = read_minute(mkey)
        srows = [x for x in rows if x[5] == sym]
        if not srows:
            if rows and entry is not None:
                fade += 1
                if fade >= FADE_MINUTES:
                    exit_px, exit_reason, exit_ts = last_px, "roll_fade", last_ts
                    break
            continue
        fade = 0
        for ts_str, o, h, l, c, _ in srows:
            tsec = datetime.fromisoformat(ts_str[:19] + "+00:00").timestamp()
            if entry is None:
                if tsec <= sig["t_utc"]:
                    continue
                entry = o + ENTRY_SLIP if side == "long" else o - ENTRY_SLIP
                entry_ts = tsec
            hit_t = h >= tgt if side == "long" else l <= tgt
            hit_s = l <= stp if side == "long" else h >= stp
            if hit_s:  # conservative: stop wins same-second ties
                exit_px = stp - STOP_SLIP if side == "long" else stp + STOP_SLIP
                exit_reason, exit_ts = "stop", tsec
                break
            if hit_t:
                exit_px, exit_reason, exit_ts = tgt, "target", tsec
                break
            last_px, last_ts = c, tsec
        if exit_px is not None:
            break
        if entry is None and mkey / 1000 > sig["t_utc"] + 1800:
            break  # no entry bar within 30 min -> skip signal
    if entry is None:
        continue
    if exit_px is None:
        exit_px, exit_reason, exit_ts = last_px, "data_end", last_ts
    pts = (exit_px - entry if side == "long" else entry - exit_px) - COMMISSION
    trades.append(dict(t_et=sig["t_et"], side=side, symbol=sym,
                       entry=round(entry, 2), exit=round(exit_px, 2),
                       reason=exit_reason, pts=round(pts, 2),
                       hold_min=round((exit_ts - entry_ts) / 60) if exit_ts else None))
    busy_until = exit_ts if exit_ts else sig["t_utc"]

with open(HERE / "results/onesec_trades.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(trades[0].keys()))
    w.writeheader()
    w.writerows(trades)

# ---------- report ----------
def rep(name, sel):
    if not sel:
        return
    n = len(sel)
    wins = sum(1 for t in sel if t["pts"] > 0)
    pos = sum(t["pts"] for t in sel if t["pts"] > 0)
    neg = -sum(t["pts"] for t in sel if t["pts"] < 0)
    cum = peak = dd = 0.0
    for t in sel:
        cum += t["pts"]; peak = max(peak, cum); dd = max(dd, peak - cum)
    print(f"{name}: n={n} WR={wins/n*100:.1f}% PF={pos/max(neg,.01):.2f} "
          f"avg={sum(t['pts'] for t in sel)/n:+.1f}pt tot={cum:+.0f}pt maxDD={dd:.0f}pt")

print("\n=== 1s-HONEST RESULTS (entry slip 0.25, stop slip 0.5, comm 0.2) ===")
rep("ALL  ", trades)
rep("LONG ", [t for t in trades if t["side"] == "long"])
rep("SHORT", [t for t in trades if t["side"] == "short"])
for yr in ("2023", "2024", "2025", "2026"):
    rep(f" {yr}", [t for t in trades if t["t_et"].startswith(yr)])
print("\nexit reasons:", {r: sum(1 for t in trades if t["reason"] == r)
                          for r in set(t["reason"] for t in trades)})
print("\n1m-sim gate: n=799 WR=78.5% PF=1.75 avg=+14.9pt (match within ~10% => validated)")
