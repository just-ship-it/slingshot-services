#!/usr/bin/env python3
"""
Independent 1s re-implementation of the pre-registered B1 config, per charter rule 7
(candidate believed only if an independent implementation reproduces n/WR/PF ~10%).

Config re-implemented from the STUDY DEFINITION (not from B12-10 code):
  band 0.03<=|gap|/ATR<=0.12, entry = limit at 09:30-open +/-6pt adverse placed at
  09:30:01 (cancel on pre-fill target touch or flat time), stop = ON extreme +/-5,
  target = prior RTH close (limit exact), flat at 09:30+120m; stop slips 0.5,
  time exit at next 1s open slips 0.25; same-bar stop+target = stop; target
  ineligible on the entry bar; $5 RT, $20/pt. Dev period 2021-2024.

Deliberately different mechanics: plain dict-of-days + python loop over 1s rows
(no numpy, no shared harness).
"""
import csv
import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"
ET = ZoneInfo("America/New_York")

days = {}
with open(f"{BASE}/B12-days.csv") as f:
    for r in csv.DictReader(f):
        days[r["trade_date"]] = r

with open(f"{BASE}/cache_nq_rth_1s.days.json") as f:
    dayidx = json.load(f)

f1s = open(f"{BASE}/cache_nq_rth_1s.csv")
header = f1s.readline()
# build line offsets lazily: instead just stream whole file once, dispatching by day
trades = []
cur_day = None

# preselect universe
uni = {}
for td, d in days.items():
    if not ("2021-01-01" <= td <= "2024-12-31"):
        continue
    if d["full_rth"] != "True" or d["gap_ok"] != "True" or d["on_ok"] != "True":
        continue
    if d["roll_in_day"] == "True" or d["rth_same_sym"] != "True":
        continue
    if not d["atr14_prior"]:
        continue
    uni[td] = d

def ep(td, hh, mm, ss=0):
    y, m, dd = map(int, td.split("-"))
    return int(datetime(y, m, dd, hh, mm, ss, tzinfo=ET).timestamp())

state = None
for line in f1s:
    p = line.rstrip("\n").split(",")
    ts = int(p[0]); o = float(p[1]); h = float(p[2]); l = float(p[3])
    dt = datetime.fromtimestamp(ts, ET)
    td = dt.strftime("%Y-%m-%d")
    if td not in uni:
        continue
    d = uni[td]
    if state is None or state["td"] != td:
        state = {"td": td, "phase": "wait_open", "t930": ep(td, 9, 30)}
    st = state
    if st["phase"] == "done":
        continue
    if st["phase"] == "wait_open":
        if ts >= st["t930"]:
            if ts > st["t930"] + 5:
                st["phase"] = "done"; continue
            open_px = o
            prc = float(d["prior_rth_close"]); atr = float(d["atr14_prior"])
            gap = open_px - prc
            if atr <= 0 or not (0.03 <= abs(gap) / atr <= 0.12):
                st["phase"] = "done"; continue
            side = -1 if gap > 0 else 1
            st.update(side=side, target=prc,
                      limit=open_px - side * 6.0,
                      stop=(float(d["on_high"]) + 5) if side < 0 else (float(d["on_low"]) - 5),
                      flat=min(st["t930"] + 7200, ep(td, 15, 45)),
                      phase="wait_place")
        continue
    side = st["side"]
    if st["phase"] == "wait_place":
        if ts >= st["t930"] + 1:
            st["phase"] = "pending"
        else:
            continue
    if st["phase"] == "pending":
        if ts >= st["flat"]:
            st["phase"] = "done"; continue
        touched_tgt = (h >= st["target"]) if side > 0 else (l <= st["target"])
        fillable = (l <= st["limit"]) if side > 0 else (h >= st["limit"])
        if touched_tgt:
            # thesis consumed at/before our fill bar -> cancel (conservative)
            st["phase"] = "done"; continue
        if fillable:
            e = st["limit"]
            if (side < 0 and e >= st["stop"]) or (side > 0 and e <= st["stop"]):
                st["phase"] = "done"; continue
            st.update(entry=e, e_ts=ts, phase="open", entry_bar=True)
        else:
            continue
    if st["phase"] == "open":
        if ts >= st["flat"]:
            px = o - side * 0.25
            trades.append((td, side * (px - st["entry"]) * 20 - 5, ts - st["e_ts"]))
            st["phase"] = "done"; continue
        stop_hit = (l <= st["stop"]) if side > 0 else (h >= st["stop"])
        tgt_hit = (h >= st["target"]) if side > 0 else (l <= st["target"])
        if st.pop("entry_bar", False):
            tgt_hit = False
        if stop_hit:
            px = st["stop"] - side * 0.5
            trades.append((td, side * (px - st["entry"]) * 20 - 5, ts - st["e_ts"]))
            st["phase"] = "done"
        elif tgt_hit:
            px = st["target"]
            trades.append((td, side * (px - st["entry"]) * 20 - 5, ts - st["e_ts"]))
            st["phase"] = "done"

n = len(trades)
wins = sum(t[1] for t in trades if t[1] > 0)
losses = -sum(t[1] for t in trades if t[1] <= 0)
print(f"VERIFY n={n} WR={sum(1 for t in trades if t[1]>0)/n*100:.1f}% "
      f"PF={wins/losses:.3f} PnL=${sum(t[1] for t in trades):.0f} "
      f"avg_hold_m={sum(t[2] for t in trades)/n/60:.1f}")
import collections
per_year = collections.Counter()
for td, pnl, _ in trades:
    per_year[td[:4]] += pnl
print("per-year:", {y: round(v) for y, v in sorted(per_year.items())})
