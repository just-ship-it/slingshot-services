#!/usr/bin/env python3
"""
R1-03: Build per-day strike-level OI cache from OPRA statistics files.

Knowability: stat_type 9 (open interest) and 6 (cleared volume) rows in the file
dated D are received 05:30-06:30 ET on day D (verified) and describe the PRIOR
session. They are knowable before RTH open on D and all day.

For each day: dedupe (symbol,stat) across publishers (max), parse OSI symbol ->
(expiry, C/P, strike), keep strikes within +/-12% of QQQ prior close and expiry
within 35 calendar days. Output one combined CSV:
  date,expiry,cp,strike,oi,prevvol

Usage: R1-03-oi-cache.py [YYYYMMDD_START YYYYMMDD_END]  (default: all files)
"""
import csv, glob, os, subprocess, sys
from collections import defaultdict
from datetime import date

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
STATS = f"{BASE}/data/statistics/qqq"
QQQ = f"{BASE}/data/ohlcv/qqq/QQQ_ohlcv_1m.csv"
OUT = f"{BASE}/greenfield/explore/R1-oi-cache.csv"

AWK = r'''BEGIN{FS=","} $11==9||$11==6 {s=$15;L=length(s);print $11","substr(s,L-14,6)","substr(s,L-8,1)","substr(s,L-7,8)","$8}'''

def qqq_daily_close():
    closes = {}
    with open(QQQ) as f:
        r = csv.reader(f); next(r)
        for row in r:
            if len(row) < 10 or not row[7]:
                continue
            d = row[0][:10]; hm = row[0][11:16]
            if hm <= "21:00":
                closes[d] = float(row[7])
    return closes  # d -> last close at/before 21:00 UTC that date

def main():
    lo = sys.argv[1] if len(sys.argv) > 2 else "00000000"
    hi = sys.argv[2] if len(sys.argv) > 2 else "99999999"
    files = sorted(glob.glob(f"{STATS}/opra-pillar-*.statistics.csv"))
    files = [f for f in files if lo <= os.path.basename(f)[12:20] <= hi]
    closes = qqq_daily_close()
    close_days = sorted(closes)
    print(f"{len(files)} files", flush=True)
    mode = "a" if (len(sys.argv) > 3 and sys.argv[3] == "--append") else "w"
    with open(OUT, mode, newline="") as fo:
        w = csv.writer(fo)
        if mode == "w":
            w.writerow(["date", "expiry", "cp", "strike", "oi", "prevvol"])
        for fp in files:
            ymd = os.path.basename(fp)[12:20]
            d = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}"
            # prior close: last close day strictly before d
            import bisect
            i = bisect.bisect_left(close_days, d) - 1
            if i < 0:
                continue
            spot = closes[close_days[i]]
            lo_k, hi_k = spot * 0.88, spot * 1.12
            dnum = date(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:8])).toordinal()
            agg = {}  # (expiry, cp, strike) -> [oi, vol]
            p = subprocess.Popen(["awk", AWK, fp], stdout=subprocess.PIPE, text=True)
            for line in p.stdout:
                st, yymmdd, cp, k8, qty = line.rstrip("\n").split(",")
                strike = int(k8) / 1000.0
                if not (lo_k <= strike <= hi_k):
                    continue
                exp = f"20{yymmdd[:2]}-{yymmdd[2:4]}-{yymmdd[4:6]}"
                ednum = date(2000 + int(yymmdd[:2]), int(yymmdd[2:4]), int(yymmdd[4:6])).toordinal()
                if ednum < dnum or ednum - dnum > 35:
                    continue
                key = (exp, cp, strike)
                v = agg.get(key)
                if v is None:
                    v = agg[key] = [0, 0]
                q = int(qty) if qty else 0
                if st == "9":
                    v[0] = max(v[0], q)
                else:
                    v[1] = max(v[1], q)
            p.wait()
            for (exp, cp, strike), (oi, vol) in sorted(agg.items()):
                w.writerow([d, exp, cp, strike, oi, vol])
            print(f"{d}: {len(agg)} contracts (spot~{spot:.1f})", flush=True)

if __name__ == "__main__":
    main()
