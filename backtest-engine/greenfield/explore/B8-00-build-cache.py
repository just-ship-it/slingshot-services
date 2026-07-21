#!/usr/bin/env python3
"""B8 cache builder: overnight 03:00-04:30 ET 1s slice, primary contract only.

Uses NQ_ohlcv_1s.index.json (minute-epoch-ms -> {offset,length}) to seek directly
into the 7.6GB raw 1s file. Primary contract per UTC-minute from cache_nq_primary_1m.csv.

Output: cache_nq_euopen_1s.csv  columns: date,ts,o,h,l,c,v
  date = ET trade date (YYYY-MM-DD)
  ts   = UTC epoch seconds (int)
Also writes B8-eligibility.csv: date,eligible,reason,n_sec,n_min,primary_sym
"""
import json, sys, os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ROOT = "/home/drew/projects/slingshot-services/backtest-engine"
RAW1S = f"{ROOT}/data/ohlcv/nq/NQ_ohlcv_1s.csv"
INDEX = f"{ROOT}/data/ohlcv/nq/NQ_ohlcv_1s.index.json"
PRIM1M = f"{ROOT}/greenfield/explore/cache_nq_primary_1m.csv"
OUT = f"{ROOT}/greenfield/explore/cache_nq_euopen_1s.csv"
ELIG = f"{ROOT}/greenfield/explore/B8-eligibility.csv"

ET = ZoneInfo("America/New_York")
UTC = timezone.utc

# Window: 03:00:00 -> 04:30:00 ET (inclusive of both minute boundaries)
WIN_START_H, WIN_START_M = 3, 0
WIN_END_H, WIN_END_M = 4, 30

def load_primary_1m():
    """UTC minute string 'YYYY-MM-DDTHH:MM' -> symbol"""
    d = {}
    with open(PRIM1M) as f:
        f.readline()
        for line in f:
            i = line.find(',')
            ts = line[:i]
            sym = line[line.rfind(',')+1:].strip()
            d[ts] = sym
    return d

def load_index():
    with open(INDEX) as f:
        idx = json.load(f)
    return idx["minutes"]  # str(epoch_ms) -> {offset,length}

def main():
    # optional date filter for prototyping: argv[1]=start argv[2]=end (ET dates)
    date_lo = sys.argv[1] if len(sys.argv) > 1 else "2020-01-01"
    date_hi = sys.argv[2] if len(sys.argv) > 2 else "2030-01-01"

    prim = load_primary_1m()
    minutes = load_index()

    # Distinct ET trade dates come from primary_1m coverage
    dates = set()
    for ts in prim.keys():
        # ts is UTC; convert to ET date at that instant is complex; instead
        # enumerate candidate ET dates from the UTC date range and test window presence.
        pass
    # Simpler: enumerate ET dates from 2021-01-01 to 2026-06-15
    d0 = datetime(2021,1,1, tzinfo=ET).date()
    d1 = datetime(2026,6,16, tzinfo=ET).date()

    fout = open(OUT, "w")
    fout.write("date,ts,o,h,l,c,v\n")
    felig = open(ELIG, "w")
    felig.write("date,eligible,reason,n_sec,n_min,primary_sym\n")

    raw = open(RAW1S, "rb")

    cur = d0
    n_days = 0
    while cur <= d1:
        ds = cur.isoformat()
        if not (date_lo <= ds <= date_hi):
            cur += timedelta(days=1); continue

        # build list of UTC minute epochs for the window on this ET date
        start_et = datetime(cur.year,cur.month,cur.day,WIN_START_H,WIN_START_M,tzinfo=ET)
        end_et   = datetime(cur.year,cur.month,cur.day,WIN_END_H,WIN_END_M,tzinfo=ET)
        # inclusive of end minute
        n_min_expected = int((end_et - start_et).total_seconds()//60) + 1
        win_mins = []
        t = start_et
        while t <= end_et:
            tu = t.astimezone(UTC)
            utc_min_str = tu.strftime("%Y-%m-%dT%H:%M")
            epoch_ms = int(tu.timestamp()*1000)
            win_mins.append((utc_min_str, epoch_ms))
            t += timedelta(minutes=1)

        # primary symbol per minute
        syms = []
        missing_prim = 0
        for (ms_str, _) in win_mins:
            s = prim.get(ms_str)
            if s is None:
                missing_prim += 1
            else:
                syms.append(s)
        distinct = set(syms)
        if len(distinct) == 0:
            felig.write(f"{ds},False,no_primary_data,0,0,\n"); cur += timedelta(days=1); continue
        if len(distinct) > 1:
            felig.write(f"{ds},False,symbol_change,{0},{0},{'|'.join(sorted(distinct))}\n")
            cur += timedelta(days=1); continue
        primary_sym = next(iter(distinct))

        # read 1s rows for each minute, keep primary_sym; aggregate per second
        rows = {}  # epoch_sec -> [o,h,l,c,v]
        n_min_present = 0
        min_missing = 0
        for (ms_str, epoch_ms) in win_mins:
            rec = minutes.get(str(epoch_ms))
            if rec is None:
                min_missing += 1
                continue
            raw.seek(rec["offset"])
            blob = raw.read(rec["length"]).decode("ascii", "replace")
            got_any = False
            for line in blob.split("\n"):
                if not line: continue
                p = line.split(",")
                # ts_event,rtype,pub,instr,open,high,low,close,volume,symbol
                if len(p) < 10: continue
                if p[9] != primary_sym: continue
                # parse ts_event -> epoch sec
                tse = p[0]  # 2021-01-17T23:00:01.000000000Z
                # seconds resolution
                sec_key = tse[:19]  # YYYY-MM-DDTHH:MM:SS
                dt = datetime(int(sec_key[0:4]),int(sec_key[5:7]),int(sec_key[8:10]),
                              int(sec_key[11:13]),int(sec_key[14:16]),int(sec_key[17:19]),tzinfo=UTC)
                es = int(dt.timestamp())
                o=float(p[4]); h=float(p[5]); l=float(p[6]); c=float(p[7]); v=float(p[8])
                if es in rows:
                    r = rows[es]
                    if h>r[1]: r[1]=h
                    if l<r[2]: r[2]=l
                    r[3]=c; r[4]+=v
                else:
                    rows[es]=[o,h,l,c,v]
                got_any=True
            if got_any:
                n_min_present += 1

        n_sec = len(rows)
        # eligibility: no symbol change (already), and no missing minute in window
        if min_missing > 0 or missing_prim > 0:
            felig.write(f"{ds},False,gap_missing_min({min_missing}p{missing_prim}),{n_sec},{n_min_present},{primary_sym}\n")
            # still write rows we have? no - skip ineligible to keep cache clean but keep data for audit
            for es in sorted(rows):
                r=rows[es]
                fout.write(f"{ds},{es},{r[0]:.2f},{r[1]:.2f},{r[2]:.2f},{r[3]:.2f},{int(r[4])}\n")
            cur += timedelta(days=1); continue

        felig.write(f"{ds},True,ok,{n_sec},{n_min_present},{primary_sym}\n")
        for es in sorted(rows):
            r=rows[es]
            fout.write(f"{ds},{es},{r[0]:.2f},{r[1]:.2f},{r[2]:.2f},{r[3]:.2f},{int(r[4])}\n")
        n_days += 1
        cur += timedelta(days=1)

    fout.close(); felig.close(); raw.close()
    print(f"done. eligible-ok days written path={OUT}")

if __name__ == "__main__":
    main()
