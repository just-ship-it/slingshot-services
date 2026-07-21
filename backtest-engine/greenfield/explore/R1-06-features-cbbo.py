#!/usr/bin/env python3
"""
R1-06: Quote-based features from cbbo-1m (2025-01 -> 2026-06), 0DTE contracts at
strikes near each level's mapped strike.

Knowability: cbbo ts_recv is snapped to interval END (verified in KNOWABILITY.md);
a row is used only when ts_recv <= touch ts. Features use snapshots in
[T-30m, T]. All quote features are in principle live-sourceable via broker chains
(coarser refresh) — flagged "partial" in the findings doc.

Per event & 0DTE at strike K (and neighbors K+-1..3):
  spread_put/call        abs spread at last snap <= T   (rel = /mid)
  imb_put/call           (bid_sz-ask_sz)/(bid_sz+ask_sz)
  depth_put/call         bid_sz+ask_sz, and ratio vs neighbor avg
  intens                 quote-row count at K in [T-30,T] vs neighbor avg
  dspread                spread(T) - spread(T-30) (same side)
  iv_put/iv_call         BS implied vol from mid (spot = QQQ close of bar T-1)
  iv_gap                 iv_put - iv_call at K
  iv_kink                iv(K) - mean(iv(K-1), iv(K+1)) on the OTM side

Usage: R1-06-features-cbbo.py [YYYY-MM-DD_START YYYY-MM-DD_END]
Appends per-day results to R1-cbbo-features.csv (header written if absent).
"""
import csv, glob, math, os, subprocess, sys
from collections import defaultdict
from datetime import datetime, timedelta

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
CBBO = f"{BASE}/data/cbbo-1m/qqq"
LEVELS = f"{BASE}/greenfield/explore/R1-levels-mapped.csv"
QQQ = f"{BASE}/data/ohlcv/qqq/QQQ_ohlcv_1m.csv"
OUT = sys.argv[3] if len(sys.argv) > 3 else f"{BASE}/greenfield/explore/R1-cbbo-features.csv"

def ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))

def bs(cp, S, K, tau, sig):
    if tau <= 0 or sig <= 0:
        return max(0.0, (S - K) if cp == "C" else (K - S))
    d1 = (math.log(S / K) + 0.5 * sig * sig * tau) / (sig * math.sqrt(tau))
    d2 = d1 - sig * math.sqrt(tau)
    if cp == "C":
        return S * ncdf(d1) - K * ncdf(d2)
    return K * ncdf(-d2) - S * ncdf(-d1)

def impvol(cp, S, K, tau, price):
    if tau <= 0 or price <= 0:
        return None
    intr = max(0.0, (S - K) if cp == "C" else (K - S))
    if price <= intr + 1e-6:
        return None
    lo, hi = 1e-3, 5.0
    if bs(cp, S, K, tau, hi) < price:
        return None
    for _ in range(48):
        mid = 0.5 * (lo + hi)
        if bs(cp, S, K, tau, mid) < price:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)

# ---- events grouped by date (2025+) ----
events = defaultdict(list)
for r in csv.DictReader(open(LEVELS)):
    if r["date"] >= "2025-01-01":
        events[r["date"]].append(r)

# ---- QQQ minute closes for needed days ----
need = set(events)
qqq_close = {}
with open(QQQ) as f:
    rr = csv.reader(f); next(rr)
    for row in rr:
        if len(row) < 10 or not row[7]:
            continue
        if row[0][:10] in need:
            qqq_close[row[0][:16]] = float(row[7])

lo = sys.argv[1] if len(sys.argv) > 2 else "0000-00-00"
hi = sys.argv[2] if len(sys.argv) > 2 else "9999-99-99"
dates = sorted(d for d in events if lo <= d <= hi)

write_header = not os.path.exists(OUT)
fo = open(OUT, "a", newline="")
COLS = ["date", "cls", "direction", "price", "first_touch_utc", "K",
        "spread_put", "spread_call", "rspread_put", "rspread_call",
        "imb_put", "imb_call", "depth_put", "depth_call", "depth_ratio",
        "intens", "intens_ratio", "dspread_otm",
        "iv_put", "iv_call", "iv_gap", "iv_kink"]
w = csv.writer(fo)
if write_header:
    w.writerow(COLS)

for d in dates:
    ymd = d.replace("-", "")
    fp = f"{CBBO}/opra-pillar-{ymd}.cbbo-1m.0000.csv"
    if not os.path.exists(fp):
        fp = f"{CBBO}/opra-pillar-{ymd}.cbbo-1m.csv"   # later 2026 files lack .0000
    if not os.path.exists(fp):
        continue
    evs = [e for e in events[d]]
    Ks = [round(float(e["mapped_price"])) for e in evs]
    kmin, kmax = min(Ks) - 4, max(Ks) + 4
    yy = ymd[2:]
    awk = (r'BEGIN{FS=","} {s=$16;L=length(s);'
           r'if (substr(s,L-14,6)=="%s") {k=substr(s,L-7,8)/1000;'
           r'if (k>=%d && k<=%d) print substr($1,1,16)","substr(s,L-8,1)","k","$10","$11","$12","$13}}'
           % (yy, kmin, kmax))
    p = subprocess.Popen(["awk", awk, fp], stdout=subprocess.PIPE, text=True)
    # snaps[(strike,cp)] = list of (ts16, bid, ask, bsz, asz) time-ordered
    snaps = defaultdict(list)
    for line in p.stdout:
        ts, cp, k, bp, ap, bs_, as_ = line.rstrip("\n").split(",")
        try:
            snaps[(float(k), cp)].append((ts, float(bp), float(ap), int(bs_), int(as_)))
        except ValueError:
            continue
    p.wait()
    for s in snaps.values():
        s.sort(key=lambda x: x[0])

    import bisect as bi
    def last_at(k, cp, ts16, maxstale=6):
        s = snaps.get((k, cp))
        if not s:
            return None
        i = bi.bisect_right([x[0] for x in s], ts16) - 1
        if i < 0:
            return None
        row = s[i]
        t0 = datetime.fromisoformat(row[0]); t1 = datetime.fromisoformat(ts16)
        if (t1 - t0).total_seconds() > maxstale * 60:
            return None
        return row

    def count_win(k, cp, t0, t1):
        s = snaps.get((k, cp))
        if not s:
            return 0
        keys = [x[0] for x in s]
        return bi.bisect_right(keys, t1) - bi.bisect_left(keys, t0)

    for e, K in zip(evs, Ks):
        T = e["first_touch_utc"][:16]
        Tm30 = (datetime.fromisoformat(T) - timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M")
        Tm1 = (datetime.fromisoformat(T) - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M")
        spot = qqq_close.get(Tm1)
        out = dict(date=d, cls=e["cls"], direction=e["direction"], price=e["price"],
                   first_touch_utc=e["first_touch_utc"], K=K)
        pr = last_at(K, "P", T); cr = last_at(K, "C", T)
        for tag, rowq in (("put", pr), ("call", cr)):
            if rowq:
                _, b, a, bsz, asz = rowq
                if a > 0 and a >= b:
                    out[f"spread_{tag}"] = round(a - b, 4)
                    m = 0.5 * (a + b)
                    out[f"rspread_{tag}"] = round((a - b) / m, 4) if m > 0.005 else ""
                if bsz + asz > 0:
                    out[f"imb_{tag}"] = round((bsz - asz) / (bsz + asz), 4)
                    out[f"depth_{tag}"] = bsz + asz
        # neighbor-relative depth & intensity
        nb = [K - 3, K - 2, K + 2, K + 3]
        nbd = []
        for k2 in nb:
            for cp in ("P", "C"):
                rq = last_at(k2, cp, T)
                if rq and rq[3] + rq[4] > 0:
                    nbd.append(rq[3] + rq[4])
        own_depth = (out.get("depth_put") or 0) + (out.get("depth_call") or 0)
        if nbd and own_depth:
            out["depth_ratio"] = round(own_depth / (sum(nbd) / len(nbd) * 2), 3)
        own_int = count_win(K, "P", Tm30, T) + count_win(K, "C", Tm30, T)
        nbi = [count_win(k2, cp, Tm30, T) for k2 in nb for cp in ("P", "C")]
        out["intens"] = own_int
        if nbi and sum(nbi) > 0:
            out["intens_ratio"] = round(own_int / (sum(nbi) / len(nbi) * 2), 3)
        # OTM side = the side that is out of the money at the level
        otm = None
        if spot:
            otm = "C" if K >= spot else "P"
            r_now = last_at(K, otm, T); r_old = last_at(K, otm, Tm30)
            if r_now and r_old and r_now[2] >= r_now[1] and r_old[2] >= r_old[1]:
                out["dspread_otm"] = round((r_now[2] - r_now[1]) - (r_old[2] - r_old[1]), 4)
        # IV features (tau to 20:00/21:00 UTC = 16:00 ET; use 20:00 UTC in DST,
        # approximate via month: Mar-Oct -> 20:00 else 21:00)
        if spot:
            mo = int(d[5:7])
            exp_hh = 20 if 3 < mo < 11 else 21  # coarse DST; +-1h on edge weeks
            texp = datetime.fromisoformat(f"{d}T{exp_hh:02d}:00")
            tau = (texp - datetime.fromisoformat(T)).total_seconds() / (365.0 * 86400)
            ivs = {}
            for k2 in (K - 1, K, K + 1):
                for cp in ("P", "C"):
                    rq = last_at(k2, cp, T)
                    if rq and rq[2] >= rq[1] and rq[2] > 0:
                        mid = 0.5 * (rq[1] + rq[2])
                        ivs[(k2, cp)] = impvol(cp, spot, k2, tau, mid)
            if ivs.get((K, "P")):
                out["iv_put"] = round(ivs[(K, "P")], 4)
            if ivs.get((K, "C")):
                out["iv_call"] = round(ivs[(K, "C")], 4)
            if out.get("iv_put") and out.get("iv_call"):
                out["iv_gap"] = round(out["iv_put"] - out["iv_call"], 4)
            if otm:
                a_, b_, c_ = ivs.get((K - 1, otm)), ivs.get((K, otm)), ivs.get((K + 1, otm))
                if a_ and b_ and c_:
                    out["iv_kink"] = round(b_ - 0.5 * (a_ + c_), 4)
        w.writerow([out.get(c, "") for c in COLS])
    fo.flush()
    print(f"{d}: {len(evs)} events, {len(snaps)} contract series", flush=True)
fo.close()
