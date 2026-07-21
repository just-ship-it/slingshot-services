#!/usr/bin/env python3
"""
V1-01-extract-1s.py — independent slim extraction from raw NQ 1s OHLCV.

Streams data/ohlcv/nq/NQ_ohlcv_1s.csv (8.3GB, UTC ns ISO timestamps) once and
writes a per-ET-day slim structure to greenfield/verify/v1_slim_1s.pkl:

  day -> {
    'vol':   {sym: {et_hour: volume}}        # RTH-only (09:30-16:00 ET), hours 9..15
    'bars':  {win_name: [(et_sec, sym, o, h, l, c), ...]}   # capture windows below
    'late':  set(sym)                        # syms with any bar >= 15:45:00 ET
  }

Capture windows (ET seconds-of-day, [start, end)):
  open0930 : 09:29:50 - 09:35:00   (day open bar; B4b short entry fill >= 09:30:01)
  ex1030   : 10:29:50 - 10:31:00   (B4b exit  >= 10:30:00)
  dec1500  : 14:57:50 - 15:01:00   (B4a decision close < 15:00:00; entry fill >= 15:00:01)
  ex1530   : 15:29:50 - 15:31:00   (B4a exit  >= 15:30:00)
  ex1545   : 15:44:50 - 15:46:00   (15:45 exit variant cross-check)

Independence: built only from the raw CSV. Calendar-spread rows (symbol contains
'-') are dropped. No files from greenfield/explore/ are read.
"""
import sys, pickle, time
from zoneinfo import ZoneInfo
from datetime import datetime, timezone

SRC = "/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1s.csv"
OUT = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/verify/v1_slim_1s.pkl"
ET = ZoneInfo("America/New_York")

WINDOWS = [
    ("open0930", 9*3600+29*60+50, 9*3600+35*60),
    ("ex1030",  10*3600+29*60+50, 10*3600+31*60),
    ("dec1500", 14*3600+57*60+50, 15*3600+1*60),
    ("ex1530",  15*3600+29*60+50, 15*3600+31*60),
    ("ex1545",  15*3600+44*60+50, 15*3600+46*60),
]
RTH_START = 9*3600+30*60
RTH_END   = 16*3600
LATE      = 15*3600+45*60

def et_offset_seconds(date_utc_str):
    """UTC->ET offset (seconds, negative) valid for the RTH block of this UTC date.
    Computed at 17:00 UTC; DST transitions occur 06:00-07:00 UTC, never inside RTH."""
    y, m, d = int(date_utc_str[:4]), int(date_utc_str[5:7]), int(date_utc_str[8:10])
    dt = datetime(y, m, d, 17, 0, tzinfo=timezone.utc)
    return int(dt.astimezone(ET).utcoffset().total_seconds())

def main(limit=None):
    days = {}
    cur_date = None
    off = None
    # UTC hours that can contain ET 09:30-16:00 under either EST(-5) or EDT(-4): 13..21
    hour_ok = {"13","14","15","16","17","18","19","20","21"}
    t0 = time.time()
    nline = 0
    with open(SRC, "r", buffering=1024*1024*8) as f:
        f.readline()  # header
        for line in f:
            nline += 1
            if limit and nline > limit:
                break
            if line[11:13] not in hour_ok:
                continue
            dstr = line[:10]
            if dstr != cur_date:
                cur_date = dstr
                off = et_offset_seconds(dstr)
            utc_sec = int(line[11:13])*3600 + int(line[14:16])*60 + int(line[17:19])
            et_sec = utc_sec + off
            if et_sec < RTH_START or et_sec >= RTH_END:
                continue
            # RTH row. Cheap tail split for volume+symbol.
            head, vol_s, sym = line.rsplit(",", 2)
            sym = sym.strip()
            if "-" in sym:
                continue
            rec = days.get(dstr)
            if rec is None:
                rec = days[dstr] = {"vol": {}, "bars": {w[0]: [] for w in WINDOWS}, "late": set()}
            sv = rec["vol"].setdefault(sym, {})
            h = et_sec // 3600
            sv[h] = sv.get(h, 0) + int(vol_s)
            if et_sec >= LATE:
                rec["late"].add(sym)
            for wname, ws, we in WINDOWS:
                if ws <= et_sec < we:
                    p = line.split(",")
                    rec["bars"][wname].append(
                        (et_sec, sym, float(p[4]), float(p[5]), float(p[6]), float(p[7])))
                    break
            if nline % 20_000_000 == 0:
                print(f"  {nline/1e6:.0f}M lines, {len(days)} days, {time.time()-t0:.0f}s", flush=True)
    for rec in days.values():
        for w in rec["bars"]:
            rec["bars"][w].sort()
    with open(OUT, "wb") as f:
        pickle.dump(days, f, protocol=4)
    print(f"done: {len(days)} ET days, {nline} lines, {time.time()-t0:.0f}s -> {OUT}")

if __name__ == "__main__":
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    main(limit)
