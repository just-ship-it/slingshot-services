#!/usr/bin/env python3
"""
1s-honest independent verification of T5 (GEX Wall Fade at the open),
promoted config: s_r levels / dist<=50 / stop=30 / tgt=20.

Rules from T5-FINDINGS + MASTER-FINDINGS spec only (execution written fresh,
not copied from the JS sim):

  - At 09:30 ET: closest level in support[] ∪ resistance[] within 50pt of the
    09:30 open (causal GEX snapshot at/most-recent-before 09:30, data/gex/nq).
  - LONG if level below open, SHORT if level above open. LIMIT order at the
    level price: unfilled by 10:30 ET -> cancel.
  - Fill on 1s: first bar (09:30+) whose low<=level (long) / high>=level
    (short); limit fills EXACT, no slip. The fill bar is NOT evaluated for
    exits (pre-fill ticks).
  - Stop 30pt (stop-market, 1.5pt slip), target 20pt (limit, exact),
    hard exit 60min after fill (market, 1.0pt slip).
  - Same-1s-bar stop+target -> STOP (conservative), tallied.

Usage: python3 verify-T5-1s.py [--start 2025-01-13] [--end 2026-04-23]
"""
import json
import os
import csv
import argparse
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
REPO = "/home/drew/projects/slingshot-services/backtest-engine"
OHLCV_1S = f"{REPO}/data/ohlcv/nq/NQ_ohlcv_1s.csv"
ROLL_LOG = f"{REPO}/data/ohlcv/nq/NQ_rollover_log.csv"
GEX_DIR = f"{REPO}/data/gex/nq"

DIST_MAX = 50.0
STOP_PTS = 30.0
TGT_PTS = 20.0
STOP_SLIP = 1.5
TIME_SLIP = 1.0
HOLD_SECS = 3600
PT_VAL = 20.0


def load_roll_schedule():
    rolls = []
    with open(ROLL_LOG) as f:
        rd = csv.DictReader(f)
        for row in rd:
            rolls.append((row["date"][:10], row["to_symbol"].strip()))
    rolls.sort()
    return rolls


def front_symbol(rolls, date_iso):
    sym = None
    for d, s in rolls:
        if d <= date_iso:
            sym = s
        else:
            break
    return sym


def sr_levels_at_930(date_iso):
    """s_r levels from the causal GEX snapshot at/most-recent-before 09:30 ET."""
    p = f"{GEX_DIR}/nq_gex_{date_iso}.json"
    if not os.path.exists(p):
        return None
    snaps = json.load(open(p)).get("data", [])
    t930 = datetime.fromisoformat(f"{date_iso}T09:30:00").replace(tzinfo=ET)
    best, best_ts = None, None
    for s in snaps:
        ts = datetime.fromisoformat(s["timestamp"])
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if ts <= t930 and (best_ts is None or ts > best_ts):
            best, best_ts = s, ts
    if best is None:
        return None
    levels = []
    for arr in ("support", "resistance"):
        v = best.get(arr) or []
        levels.extend(float(x) for x in v if x is not None)
    return levels or None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2025-01-13")
    ap.add_argument("--end", default="2026-04-23")
    args = ap.parse_args()

    rolls = load_roll_schedule()
    trades = []
    ambiguous = 0
    setups = 0

    pending = None   # {date, side, level, cancel HHMM 1030}
    live = None      # {date, side, entry, stop, tgt, deadline_utc, entry_line}
    seen930 = set()

    with open(OHLCV_1S) as f:
        header = f.readline().rstrip("\n").split(",")
        i_ts = header.index("ts_event")
        i_open = header.index("open")
        i_high = header.index("high")
        i_low = header.index("low")
        i_sym = header.index("symbol")

        for line in f:
            ts10 = line[:10]
            if ts10 < args.start:
                continue
            if ts10 > (datetime.fromisoformat(args.end) + timedelta(days=1)).date().isoformat():
                break
            cols = line.rstrip("\n").split(",")
            sym = cols[i_sym]
            if "-" in sym:
                continue
            t_utc = datetime.fromisoformat(cols[i_ts][:19]).replace(tzinfo=timezone.utc)
            t_et = t_utc.astimezone(ET)
            d_et = t_et.date().isoformat()
            if sym != front_symbol(rolls, d_et):
                continue
            hhmm = t_et.hour * 100 + t_et.minute
            if hhmm < 930 or hhmm >= 1200:
                continue
            o = float(cols[i_open]); h = float(cols[i_high]); lo = float(cols[i_low])

            # 09:30 setup
            if d_et not in seen930 and args.start <= d_et <= args.end:
                seen930.add(d_et)
                pending = None
                lv = sr_levels_at_930(d_et)
                if lv:
                    cands = [(abs(x - o), x) for x in lv if abs(x - o) <= DIST_MAX and x != o]
                    if cands:
                        dist, level = min(cands)
                        side = "long" if level < o else "short"
                        pending = {"date": d_et, "side": side, "level": level}
                        setups += 1

            # limit fill 09:30-10:30
            if pending and pending["date"] == d_et:
                if hhmm >= 1030:
                    pending = None
                elif ((pending["side"] == "long" and lo <= pending["level"]) or
                      (pending["side"] == "short" and h >= pending["level"])):
                    e = pending["level"]
                    live = {"date": d_et, "side": pending["side"], "entry": e,
                            "stop": e - STOP_PTS if pending["side"] == "long" else e + STOP_PTS,
                            "tgt": e + TGT_PTS if pending["side"] == "long" else e - TGT_PTS,
                            "deadline": t_utc + timedelta(seconds=HOLD_SECS),
                            "entry_line": True}
                    pending = None

            # exits
            if live and live.pop("entry_line", False):
                pass
            elif live:
                done = None
                if t_utc >= live["deadline"] or d_et != live["date"]:
                    px = o - TIME_SLIP if live["side"] == "long" else o + TIME_SLIP
                    done = ("time", px)
                elif live["side"] == "long":
                    hs, ht = lo <= live["stop"], h >= live["tgt"]
                    if hs and ht:
                        ambiguous += 1
                        done = ("stop*", live["stop"] - STOP_SLIP)
                    elif hs:
                        done = ("stop", live["stop"] - STOP_SLIP)
                    elif ht:
                        done = ("target", live["tgt"])
                else:
                    hs, ht = h >= live["stop"], lo <= live["tgt"]
                    if hs and ht:
                        ambiguous += 1
                        done = ("stop*", live["stop"] + STOP_SLIP)
                    elif hs:
                        done = ("stop", live["stop"] + STOP_SLIP)
                    elif ht:
                        done = ("target", live["tgt"])
                if done:
                    reason, px = done
                    pts = (px - live["entry"]) if live["side"] == "long" else (live["entry"] - px)
                    trades.append({"date": live["date"], "side": live["side"],
                                   "entry": live["entry"], "exit": px,
                                   "reason": reason, "pts": pts})
                    live = None

    n = len(trades)
    wins = [t for t in trades if t["pts"] > 0]
    gp = sum(t["pts"] for t in wins)
    gl = -sum(t["pts"] for t in trades if t["pts"] <= 0)
    pf = (gp / gl) if gl > 0 else float("inf")
    tot = sum(t["pts"] for t in trades)
    print(f"T5 s_r/50/30/20 1s-honest verification {args.start} -> {args.end}")
    print(f"setups={setups} trades={n} WR={100*len(wins)/n if n else 0:.1f}% PF={pf:.2f} "
          f"totalPts={tot:+.1f} (${tot*PT_VAL:+,.0f}/NQ) ambiguous={ambiguous}")
    by = {}
    for t in trades:
        by.setdefault(t["reason"], [0, 0.0])
        by[t["reason"]][0] += 1
        by[t["reason"]][1] += t["pts"]
    for k, (cnt, pts) in sorted(by.items()):
        print(f"  {k:8s} n={cnt:3d} pts={pts:+9.1f}")


if __name__ == "__main__":
    main()
