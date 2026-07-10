#!/usr/bin/env python3
"""Precompute intraday structure levels from NQ raw 1m (primary contract).

Per ET trade date (session = 18:00 prev ET -> 17:00 ET):
  rth_open   09:30 ET first bar open
  on_high/low overnight 18:00prev-09:30 high/low
  pd_high/low/close prior day's RTH (09:30-16:00) high/low/close
Per hour (ET): h_high/h_low of the completed hour (for rolling hourly S/R).

Outputs structure/NQ_session_levels.csv and structure/NQ_hourly_hl.csv.
All prices raw-contract; symbol column carries the primary contract; rows
where the primary contract changed mid-session are flagged (roll=1).
"""

import csv
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

DATA = Path("/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m.csv")
OUT = Path(__file__).parent / "structure"
OUT.mkdir(exist_ok=True)
ET = ZoneInfo("America/New_York")
UTC = ZoneInfo("UTC")

# pass 1: hourly primary
hourly = defaultdict(lambda: defaultdict(float))
with open(DATA) as f:
    r = csv.reader(f)
    header = next(r)
    ci = {c: i for i, c in enumerate(header)}
    nc = len(header)
    for row in r:
        if len(row) < nc or "-" in row[ci["symbol"]]:
            continue
        if row[ci["ts_event"]] < "2023-01":
            continue
        hourly[row[ci["ts_event"]][:13]][row[ci["symbol"]]] += float(row[ci["volume"]])
primary = {h: max(v, key=v.get) for h, v in hourly.items()}

sessions = {}   # trade_date -> dict
hours = {}      # (date,hour) -> [hi,lo]
with open(DATA) as f:
    r = csv.reader(f)
    header = next(r)
    ci = {c: i for i, c in enumerate(header)}
    nc = len(header)
    for row in r:
        if len(row) < nc:
            continue
        ts = row[ci["ts_event"]]
        if ts < "2023-01":
            continue
        sym = row[ci["symbol"]]
        if "-" in sym or primary.get(ts[:13]) != sym:
            continue
        t_et = datetime.fromisoformat(ts[:19]).replace(tzinfo=UTC).astimezone(ET)
        o, h, l, c = (float(row[ci[k]]) for k in ("open", "high", "low", "close"))
        # ET trade date: bars >=18:00 belong to next trade date
        td = t_et.date() + timedelta(days=1) if t_et.hour >= 18 else t_et.date()
        s = sessions.setdefault(td, dict(on_high=None, on_low=None, rth_open=None,
                                         rth_high=None, rth_low=None, rth_close=None,
                                         syms=set()))
        s["syms"].add(sym)
        hm = t_et.hour * 60 + t_et.minute
        if hm >= 18 * 60 or hm < 9 * 60 + 30:   # overnight
            s["on_high"] = h if s["on_high"] is None else max(s["on_high"], h)
            s["on_low"] = l if s["on_low"] is None else min(s["on_low"], l)
        elif 9 * 60 + 30 <= hm < 16 * 60:        # RTH
            if s["rth_open"] is None:
                s["rth_open"] = o
            s["rth_high"] = h if s["rth_high"] is None else max(s["rth_high"], h)
            s["rth_low"] = l if s["rth_low"] is None else min(s["rth_low"], l)
            s["rth_close"] = c
        hk = (t_et.date().isoformat(), t_et.hour)
        if hk not in hours:
            hours[hk] = [h, l, sym]
        else:
            hours[hk][0] = max(hours[hk][0], h)
            hours[hk][1] = min(hours[hk][1], l)

dates = sorted(sessions)
with open(OUT / "NQ_session_levels.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["trade_date", "rth_open", "on_high", "on_low",
                "pd_high", "pd_low", "pd_close", "roll", "symbol"])
    prev = None
    for d in dates:
        s = sessions[d]
        pd_ = sessions.get(prev) if prev else None
        w.writerow([d.isoformat(),
                    s["rth_open"], s["on_high"], s["on_low"],
                    pd_["rth_high"] if pd_ else None,
                    pd_["rth_low"] if pd_ else None,
                    pd_["rth_close"] if pd_ else None,
                    int(len(s["syms"]) > 1),
                    sorted(s["syms"])[0] if s["syms"] else ""])
        prev = d
with open(OUT / "NQ_hourly_hl.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["date_et", "hour_et", "high", "low", "symbol"])
    for (d, hh) in sorted(hours):
        hi, lo, sym = hours[(d, hh)]
        w.writerow([d, hh, hi, lo, sym])
print(f"sessions: {len(dates)}  hourly rows: {len(hours)}")
