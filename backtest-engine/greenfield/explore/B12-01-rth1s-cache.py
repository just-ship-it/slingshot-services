#!/usr/bin/env python3
"""
B12-01: build the slim RTH 1s cache (09:28-16:00 ET inclusive, primary symbol only).

Uses NQ_ohlcv_1s.index.json (minute-epoch-ms -> byte offset/length) to seek only RTH
minutes instead of streaming all 7.6GB. Per day, keeps ONLY rows whose symbol equals
that trade date's RTH primary symbol (sym_rth_first from B12-days.csv, which comes
from the trusted primary-contract 1m cache). Calendar spreads ('-' in symbol) and
other contract months are dropped.

Output cache_nq_rth_1s.csv columns: ts (epoch seconds UTC), o, h, l, c, v
plus sidecar cache_nq_rth_1s.days.json: trade_date -> [row_start, row_end) for fast
per-day slicing (rows are contiguous & chronological per day).

Usage: python3 B12-01-rth1s-cache.py [start_date end_date]
"""
import json
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
SRC = f"{BASE}/data/ohlcv/nq/NQ_ohlcv_1s.csv"
IDX = f"{BASE}/data/ohlcv/nq/NQ_ohlcv_1s.index.json"
OUT = f"{BASE}/greenfield/explore/cache_nq_rth_1s.csv"
OUTD = f"{BASE}/greenfield/explore/cache_nq_rth_1s.days.json"
ET = ZoneInfo("America/New_York")
UTC = ZoneInfo("UTC")

start = sys.argv[1] if len(sys.argv) > 2 else "2021-01-01"
end = sys.argv[2] if len(sys.argv) > 2 else "2026-12-31"

days = pd.read_csv(f"{BASE}/greenfield/explore/B12-days.csv", parse_dates=["trade_date"])
days = days[(days.trade_date >= start) & (days.trade_date <= end)]

print("loading index...", flush=True)
with open(IDX) as f:
    index = json.load(f)["minutes"]
print(f"index minutes: {len(index)}", flush=True)

def fnum(s):
    x = float(s)
    return "%.10g" % x

n_rows = 0
day_index = {}
with open(SRC, "rb") as src, open(OUT, "w") as out:
    out.write("ts,o,h,l,c,v\n")
    for _, d in days.iterrows():
        td = d.trade_date
        sym = d.sym_rth_first
        if not isinstance(sym, str):
            continue
        symb = sym.encode()
        row_start = n_rows
        base_et = datetime(td.year, td.month, td.day, 9, 28, tzinfo=ET)
        for k in range(393):  # 09:28 .. 16:00 inclusive
            t_et = base_et + timedelta(minutes=k)
            min_epoch = int(t_et.astimezone(UTC).timestamp())
            key = str(min_epoch * 1000)
            ent = index.get(key)
            if ent is None:
                continue
            src.seek(ent["offset"])
            blob = src.read(ent["length"])
            for line in blob.split(b"\n"):
                if not line:
                    continue
                parts = line.split(b",")
                if len(parts) < 10 or parts[9] != symb:
                    continue
                # all rows in this block share the minute; only seconds vary (chars 17:19)
                ts = min_epoch + int(parts[0][17:19])
                out.write("%d,%s,%s,%s,%s,%s\n" % (
                    ts, fnum(parts[4]), fnum(parts[5]), fnum(parts[6]),
                    fnum(parts[7]), parts[8].decode()))
                n_rows += 1
        if n_rows > row_start:
            day_index[td.strftime("%Y-%m-%d")] = [row_start, n_rows]
        if len(day_index) % 100 == 0 and n_rows > row_start:
            print(f"  {td.date()} rows={n_rows}", flush=True)

with open(OUTD, "w") as f:
    json.dump(day_index, f)
print(f"DONE days={len(day_index)} rows={n_rows}", flush=True)
