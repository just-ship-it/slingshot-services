#!/usr/bin/env python3
"""
R1-07: Options TRADE-TAPE features (2025 only). *** FLAGGED NON-DEPLOYABLE ***
There is NO live options-trades source and none will be purchased; these features
are for EXPLANATION only. Any finding that survives ONLY here cannot deploy.

Per event: same-day option volume executed BEFORE the touch (ts_recv <= T) at
strikes K-1..K+1, split put/call, 0DTE only; neighbor-relative version
(vs strikes K+-2,3). Knowable at touch by construction (only prints <= T used).

Usage: R1-07-features-trades.py [START END]  -> appends R1-trades-features.csv
"""
import csv, os, subprocess, sys
from collections import defaultdict

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
TRADES = f"{BASE}/data/options-trades/qqq"
LEVELS = f"{BASE}/greenfield/explore/R1-levels-mapped.csv"
OUT = f"{BASE}/greenfield/explore/R1-trades-features.csv"

events = defaultdict(list)
for r in csv.DictReader(open(LEVELS)):
    if "2025-01-01" <= r["date"] <= "2025-12-31":
        events[r["date"]].append(r)

lo = sys.argv[1] if len(sys.argv) > 2 else "0000-00-00"
hi = sys.argv[2] if len(sys.argv) > 2 else "9999-99-99"
dates = sorted(d for d in events if lo <= d <= hi)

write_header = not os.path.exists(OUT)
fo = open(OUT, "a", newline="")
w = csv.writer(fo)
COLS = ["date", "cls", "direction", "price", "first_touch_utc", "K",
        "tvol_put", "tvol_call", "tvol_dir", "tvol_ratio_nb", "tprem_put", "tprem_call"]
if write_header:
    w.writerow(COLS)

for d in dates:
    ymd = d.replace("-", "")
    fp = f"{TRADES}/opra-pillar-{ymd}.trades.csv"
    if not os.path.exists(fp):
        continue
    evs = events[d]
    Ks = [round(float(e["mapped_price"])) for e in evs]
    kmin, kmax = min(Ks) - 3, max(Ks) + 3
    yy = ymd[2:]
    awk = (r'BEGIN{FS=","} {s=$14;L=length(s);'
           r'if (substr(s,L-14,6)=="%s") {k=substr(s,L-7,8)/1000;'
           r'if (k>=%d && k<=%d) print substr($1,1,16)","substr(s,L-8,1)","k","$9","$10}}'
           % (yy, kmin, kmax))
    p = subprocess.Popen(["awk", awk, fp], stdout=subprocess.PIPE, text=True)
    # agg per (strike,cp): list of (ts16, size, prem)
    tape = defaultdict(list)
    for line in p.stdout:
        ts, cp, k, px, sz = line.rstrip("\n").split(",")
        try:
            tape[(float(k), cp)].append((ts, int(sz), float(px) * int(sz)))
        except ValueError:
            continue
    p.wait()
    for v in tape.values():
        v.sort(key=lambda x: x[0])
    import bisect as bi
    def vol_before(k, cp, T):
        s = tape.get((k, cp))
        if not s:
            return 0, 0.0
        keys = [x[0] for x in s]
        i = bi.bisect_right(keys, T)
        return sum(x[1] for x in s[:i]), sum(x[2] for x in s[:i])
    for e, K in zip(evs, Ks):
        T = e["first_touch_utc"][:16]
        vp = sum(vol_before(k, "P", T)[0] for k in (K - 1, K, K + 1))
        vc = sum(vol_before(k, "C", T)[0] for k in (K - 1, K, K + 1))
        pp = sum(vol_before(k, "P", T)[1] for k in (K - 1, K, K + 1))
        pc = sum(vol_before(k, "C", T)[1] for k in (K - 1, K, K + 1))
        nb = sum(vol_before(k, cp, T)[0] for k in (K - 3, K - 2, K + 2, K + 3) for cp in "PC")
        own = vp + vc
        ratio = round(own / (nb / 4 * 3), 3) if nb > 0 else ""
        tdir = vp if e["direction"] == "lower" else (vc if e["direction"] == "upper" else "")
        w.writerow([d, e["cls"], e["direction"], e["price"], e["first_touch_utc"], K,
                    vp, vc, tdir, ratio, round(pp, 1), round(pc, 1)])
    fo.flush()
    print(f"{d}: {len(evs)} events", flush=True)
fo.close()
