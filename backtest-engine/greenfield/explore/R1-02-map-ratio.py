#!/usr/bin/env python3
"""
R1-02: NQ->QQQ strike-space mapping.

For every level/control row in R1-labels-levels.csv, compute the NQ/QQQ ratio from
the last minute bar fully CLOSED before the touch minute (bars are stamped at open,
knowable at close => use bar stamped T-1 for a touch during bar T). Ratio is
therefore knowable at-or-before the touch instant. Also validates intraday ratio
stability (drift/std per day) on all days so the "same-day ratio" assumption is
documented.

Output: R1-levels-mapped.csv = levels file + ratio, qqq_spot, mapped_price (QQQ $)
        stdout: ratio stability stats.
"""
import csv
from datetime import datetime, timedelta
from collections import defaultdict
import statistics as st

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
QQQ = f"{BASE}/data/ohlcv/qqq/QQQ_ohlcv_1m.csv"
CACHE = f"{BASE}/greenfield/explore/cache_nq_primary_1m.csv"
LEVELS = f"{BASE}/greenfield/explore/R1-labels-levels.csv"
OUT = f"{BASE}/greenfield/explore/R1-levels-mapped.csv"

levels = list(csv.DictReader(open(LEVELS)))
need_days = {r["date"] for r in levels}
# map utc date of touch (ts like 2025-01-24T14:38) -> we need minute-level closes
need_utc_days = {r["first_touch_utc"][:10] for r in levels}

# NQ closes per minute (dominant symbol rows only appear once per minute in cache;
# on hour-boundary symbol switches there can be two rows same ts -> keep by symbol)
nq_close = {}
with open(CACHE) as f:
    r = csv.reader(f); next(r)
    for row in r:
        if row[0][:10] in need_utc_days:
            nq_close[(row[0][:16], row[6])] = float(row[4])
            nq_close.setdefault(row[0][:16], float(row[4]))  # last-writer fallback

qqq_close = {}
with open(QQQ) as f:
    r = csv.reader(f); next(r)
    for row in r:
        if len(row) < 10 or not row[7]:
            continue
        d = row[0][:10]
        if d in need_utc_days:
            qqq_close[row[0][:16]] = float(row[7])

def prev_minute(ts16):
    dt = datetime.fromisoformat(ts16)
    return (dt - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M")

out = []
miss = 0
for r in levels:
    t = r["first_touch_utc"][:16]
    ratio = None
    tm = t
    for _ in range(10):  # walk back up to 10 minutes to find overlapping bars
        tm = prev_minute(tm)
        nc = nq_close.get((tm, r["symbol"])) or nq_close.get(tm)
        qc = qqq_close.get(tm)
        if nc and qc:
            ratio = nc / qc
            break
    if ratio is None:
        miss += 1
        continue
    r2 = dict(r)
    r2["ratio"] = round(ratio, 5)
    r2["qqq_spot"] = round(qc, 3)
    r2["mapped_price"] = round(float(r["price"]) / ratio, 3)
    out.append(r2)

print(f"mapped {len(out)} rows, {miss} missing QQQ overlap")
with open(OUT, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
    w.writeheader(); w.writerows(out)

# ---- intraday stability: per ET day, ratio at 09:35 vs 12:00 vs 15:55 ET ----
# quick proxy using UTC days present: sample the mapped rows' days
drifts = []
stds = []
byday = defaultdict(list)
for ts16, qc in qqq_close.items():
    nc = nq_close.get(ts16)
    if nc:
        byday[ts16[:10]].append((ts16, nc / qc))
for d, rows in byday.items():
    rows.sort()
    # RTH approx 14:30-21:00 UTC (covers both DST regimes coarsely: use 15:00-20:00)
    rth = [x for x in rows if "14:30" <= x[0][11:16] <= "20:59"]
    if len(rth) < 100:
        continue
    vals = [x[1] for x in rth]
    drifts.append((vals[-1] - vals[0]) / vals[0] * 1e4)  # bps
    stds.append(st.pstdev(vals) / st.mean(vals) * 1e4)
print(f"days checked: {len(drifts)}")
print(f"open->close ratio drift bps: mean {st.mean(drifts):.1f} median {st.median(drifts):.1f} p95 {sorted(drifts)[int(.95*len(drifts))]:.1f} p5 {sorted(drifts)[int(.05*len(drifts))]:.1f}")
print(f"intraday ratio rel-std bps:  mean {st.mean(stds):.1f} median {st.median(stds):.1f} max {max(stds):.1f}")
# 1 QQQ strike ($1) in ratio-error terms: how many bps is $1 at typical spot?
qs = [q for q in qqq_close.values()]
print(f"$1 strike at median QQQ spot = {1/st.median(qs)*1e4:.0f} bps -> ratio noise must stay well under this")
