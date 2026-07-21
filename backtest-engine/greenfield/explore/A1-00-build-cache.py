#!/usr/bin/env python3
"""
A1-00: Build a primary-contract-filtered 1m cache from raw multi-contract OHLCV.

Rules (per GREENFIELD.md / CLAUDE.md data mechanics):
  - Drop calendar-spread rows (symbol contains '-').
  - Per UTC clock-hour, keep ONLY the symbol with the highest total volume in
    that hour (primary contract selection).
  - Emit a `roll` flag on the first bar after the primary symbol changes so
    downstream code never computes returns across a symbol change.

Output: greenfield/explore/cache/{PROD}_1m_primary.csv
  ts_utc (ISO, minute), et_date, et_hhmm, dow (0=Mon, ET date), o,h,l,c,v,symbol,roll

Usage: python3 A1-00-build-cache.py [NQ|ES]
"""
import csv, os, sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

PROD = (sys.argv[1] if len(sys.argv) > 1 else "NQ").upper()
BASE = "/home/drew/projects/slingshot-services/backtest-engine"
SRC = f"{BASE}/data/ohlcv/{PROD.lower()}/{PROD}_ohlcv_1m.csv"
OUTDIR = f"{BASE}/greenfield/explore/cache"
OUT = f"{OUTDIR}/{PROD}_1m_primary.csv"
os.makedirs(OUTDIR, exist_ok=True)

ET = ZoneInfo("America/New_York")

def merge_fragments(rows):
    """Some source files carry multiple partial bars for the same (ts,symbol)
    (fragmented minutes). Merge in file order: o=first, h=max, l=min, c=last, v=sum."""
    out = {}
    for ts, o, h, l, c, v in rows:
        if ts in out:
            po, ph, pl, pc, pv = out[ts]
            out[ts] = (po, max(ph, h), min(pl, l), c, pv + v)
        else:
            out[ts] = (o, h, l, c, v)
    return [(ts, *vals) for ts, vals in sorted(out.items())]

def flush_hour(rows_by_sym, vol_by_sym, writer, state):
    if not rows_by_sym:
        return
    primary = max(vol_by_sym, key=vol_by_sym.get)
    rows = merge_fragments(rows_by_sym[primary])
    for ts, o, h, l, c, v in rows:
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        et = dt.astimezone(ET)
        roll = 1 if (state["last_sym"] is not None and primary != state["last_sym"]) else 0
        state["last_sym"] = primary
        writer.writerow([
            dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            et.strftime("%Y-%m-%d"), et.strftime("%H%M"), et.weekday(),
            f"{o:g}", f"{h:g}", f"{l:g}", f"{c:g}", v, primary, roll,
        ])
        state["n_out"] += 1

def parse_ts(s):
    # 2020-12-27T23:00:00.000000000Z -> epoch seconds
    return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()

def main():
    state = {"last_sym": None, "n_out": 0}
    n_in = 0
    cur_hour = None
    rows_by_sym, vol_by_sym = {}, {}
    with open(SRC, newline="") as f, open(OUT, "w", newline="") as fo:
        rdr = csv.reader(f)
        header = next(rdr)
        idx = {k: i for i, k in enumerate(header)}
        iT, iO, iH, iL, iC, iV, iS = (idx[k] for k in
            ("ts_event", "open", "high", "low", "close", "volume", "symbol"))
        w = csv.writer(fo)
        w.writerow(["ts_utc", "et_date", "et_hhmm", "dow", "o", "h", "l", "c", "v", "symbol", "roll"])
        for row in rdr:
            n_in += 1
            if len(row) < 10:  # skip malformed/blank rows
                continue
            sym = row[iS]
            if "-" in sym:
                continue
            ts = parse_ts(row[iT])
            hour = int(ts // 3600)
            if hour != cur_hour:
                flush_hour(rows_by_sym, vol_by_sym, w, state)
                rows_by_sym, vol_by_sym = {}, {}
                cur_hour = hour
            v = int(row[iV])
            rows_by_sym.setdefault(sym, []).append(
                (ts, float(row[iO]), float(row[iH]), float(row[iL]), float(row[iC]), v))
            vol_by_sym[sym] = vol_by_sym.get(sym, 0) + v
        flush_hour(rows_by_sym, vol_by_sym, w, state)
    print(f"{PROD}: read {n_in} rows -> {state['n_out']} primary-contract bars -> {OUT}")

if __name__ == "__main__":
    main()
