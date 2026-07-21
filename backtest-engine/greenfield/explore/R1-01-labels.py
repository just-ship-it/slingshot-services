#!/usr/bin/env python3
"""
R1-01: Extract STRONG REJECTION / BROKEN / PLACEBO level events from NQ primary 1m cache.

Labels are ex-post (they are the target, not features).

Definitions (RTH 09:30-16:00 ET, touch must be <= 15:00 ET so a full 60m forward
window exists):
  Candidate touch: bar whose high (low) is >= (<=) all highs (lows) of the trailing
    30 minutes (using all-session bars for context, touch itself in RTH).
  Walk forward 60 x 1m bars (same ET day, same contract symbol):
    pen  = adverse continuation beyond P (high-P for upper, P-low for lower)
    rev  = reversal away from P (P-low for upper, high-P for lower)
  REJECTED@X (X in 30/35/50): rev >= X occurs strictly before pen ever exceeds 8pt.
  BROKEN: pen > 20 occurs strictly before rev >= 35.
  Same-bar ties at 1m resolution -> ambiguous -> dropped.
Clustering: same day + direction + class, prices within 5 pts -> one level.
Controls:
  placebo: 2 per rejection level, price = level +/- U(40,120), same touch ts.
  round:   multiples of 100 touched (within 2pt) that day in RTH, >=10pt away
           from any real (rejection or broken) level that day.

Output:
  R1-labels-events.csv  - every classified candidate touch event
  R1-labels-levels.csv  - clustered levels + controls (unit of analysis)
"""
import csv, random, sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from collections import defaultdict

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
CACHE = f"{BASE}/greenfield/explore/cache_nq_primary_1m.csv"
OUT_EVENTS = f"{BASE}/greenfield/explore/R1-labels-events.csv"
OUT_LEVELS = f"{BASE}/greenfield/explore/R1-labels-levels.csv"

ET = ZoneInfo("America/New_York")
TRAIL = 30          # minutes trailing window for local-extreme candidacy
FWD = 60            # minutes forward classification window
PEN_REJ = 8.0       # max penetration for a rejection
PEN_BRK = 20.0      # penetration that defines a break
REV_THRESHOLDS = (30.0, 35.0, 50.0)
REV_MAIN = 35.0
CLUSTER_PTS = 5.0
random.seed(20260716)

# ---- load cache, convert to ET once (offset cached per utc date) ----
_off = {}
def et_parts(ts_utc_str):
    # ts like 2021-01-04T14:30  (UTC naive)
    d = ts_utc_str[:10]
    off = _off.get(d)
    if off is None:
        dt = datetime.fromisoformat(ts_utc_str).replace(tzinfo=ZoneInfo("UTC"))
        off = dt.astimezone(ET).utcoffset()
        _off[d] = off
    hh = int(ts_utc_str[11:13]); mm = int(ts_utc_str[14:16])
    dt = datetime(int(d[:4]), int(d[5:7]), int(d[8:10]), hh, mm) + off
    return dt  # naive ET datetime

def main():
    days = defaultdict(list)  # et_date -> list of (et_dt, ts_utc, o,h,l,c,v,sym)
    with open(CACHE) as f:
        r = csv.reader(f); next(r)
        for row in r:
            ts = row[0]
            dt = et_parts(ts)
            days[dt.date()].append((dt, ts, float(row[2]), float(row[3]), row[6]))
            # store only what we need: et_dt, ts_utc, high, low, symbol
    print(f"loaded {sum(len(v) for v in days.values())} bars over {len(days)} ET days", flush=True)

    events = []  # dicts
    for day in sorted(days):
        bars = days[day]
        bars.sort(key=lambda b: b[0])
        # dominant RTH symbol
        rth_idx = [i for i, b in enumerate(bars)
                   if (b[0].hour, b[0].minute) >= (9, 30) and b[0].hour < 16]
        if len(rth_idx) < 120:
            continue
        symcnt = defaultdict(int)
        for i in rth_idx:
            symcnt[bars[i][4]] += 1
        dom = max(symcnt, key=symcnt.get)
        # restrict entire day context to dominant symbol (no cross-contract spans)
        bars = [b for b in bars if b[4] == dom]
        n = len(bars)
        highs = [b[2] for b in bars]; lows = [b[3] for b in bars]
        for i, b in enumerate(bars):
            dt = b[0]
            if not ((dt.hour, dt.minute) >= (9, 30) and (dt.hour, dt.minute) <= (15, 0)):
                continue
            j0 = max(0, i - TRAIL)
            for direction, P, is_cand in (
                ("upper", highs[i], highs[i] >= max(highs[j0:i], default=-1e18)),
                ("lower", lows[i],  lows[i]  <= min(lows[j0:i],  default= 1e18))):
                if not is_cand or i + 1 >= n:
                    continue
                # forward walk (strict ordering; same-bar 1m ties fall out as neither)
                t_rev = {x: None for x in REV_THRESHOLDS}
                t_pen8 = None; t_pen20 = None
                max_rev = 0.0; max_pen = 0.0
                end = min(n, i + 1 + FWD)
                for k in range(i + 1, end):
                    if bars[k][0].date() != day:
                        break
                    if direction == "upper":
                        pen = highs[k] - P; rev = P - lows[k]
                    else:
                        pen = P - lows[k]; rev = highs[k] - P
                    max_pen = max(max_pen, pen)
                    for x in REV_THRESHOLDS:
                        if t_rev[x] is None and rev >= x:
                            t_rev[x] = k - i
                    if t_pen8 is None and pen > PEN_REJ:
                        t_pen8 = k - i
                    if t_pen20 is None and pen > PEN_BRK:
                        t_pen20 = k - i
                    if t_pen8 is None:
                        max_rev = max(max_rev, rev)
                    if t_pen20 is not None and t_rev[REV_MAIN] is not None:
                        break

                def rej_at(x):
                    return int(t_rev[x] is not None and (t_pen8 is None or t_rev[x] < t_pen8))
                rej30, rej35, rej50 = rej_at(30.0), rej_at(35.0), rej_at(50.0)
                r35 = t_rev[REV_MAIN]
                broken = int(t_pen20 is not None and (r35 is None or t_pen20 < r35))
                if rej35:
                    cls = "rejected"
                elif broken:
                    cls = "broken"
                elif rej30:
                    cls = "rejected30only"
                else:
                    continue
                events.append(dict(
                    date=str(day), ts_utc=b[1],
                    et_time=dt.strftime("%H:%M"), direction=direction,
                    price=round(P, 2), cls=cls, rej30=rej30, rej35=rej35,
                    rej50=rej50, t_rev35=r35 if r35 is not None else "",
                    t_pen20=t_pen20 if t_pen20 is not None else "",
                    max_rev=round(max_rev, 2), max_pen=round(max_pen, 2), symbol=dom))
    print(f"classified events: {len(events)}", flush=True)

    with open(OUT_EVENTS, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(events[0].keys()))
        w.writeheader(); w.writerows(events)

    # ---- cluster into levels ----
    levels = []
    byday = defaultdict(list)
    for e in events:
        byday[(e["date"], e["direction"], "rejected" if e["cls"].startswith("rejected") else "broken")].append(e)
    for (date, direction, cls), evs in sorted(byday.items()):
        evs.sort(key=lambda e: e["price"])
        cluster = []
        def flush():
            if not cluster:
                return
            first = min(cluster, key=lambda e: e["ts_utc"])
            # only call it a rejection level at main threshold if any touch rej35
            rej35 = max(e["rej35"] for e in cluster)
            c = cls if cls == "broken" else ("rejected" if rej35 else "rejected30only")
            levels.append(dict(
                date=date, cls=c, direction=direction,
                price=round(sum(e["price"] for e in cluster) / len(cluster), 2),
                first_touch_utc=first["ts_utc"], first_touch_et=first["et_time"],
                n_touches=len(cluster),
                max_rev=max(e["max_rev"] for e in cluster),
                rej30=max(e["rej30"] for e in cluster),
                rej50=max(e["rej50"] for e in cluster), symbol=first["symbol"]))
        for e in evs:
            if cluster and e["price"] - cluster[-1]["price"] > CLUSTER_PTS:
                flush(); cluster = []
            cluster.append(e)
        flush()
    # overlap flag: broken level within 5pts of rejected level same day
    bydate = defaultdict(list)
    for L in levels:
        bydate[L["date"]].append(L)
    for date, Ls in bydate.items():
        for L in Ls:
            L["overlap"] = int(any(o is not L and abs(o["price"] - L["price"]) <= CLUSTER_PTS
                                   and o["cls"] != L["cls"] for o in Ls))
    print(f"clustered levels: {len(levels)}", flush=True)

    # ---- controls ----
    controls = []
    for date, Ls in sorted(bydate.items()):
        real_prices = [L["price"] for L in Ls]
        rej = [L for L in Ls if L["cls"] == "rejected"]
        for L in rej:
            for _ in range(2):
                off = random.uniform(40, 120) * random.choice((-1, 1))
                controls.append(dict(
                    date=date, cls="placebo", direction=L["direction"],
                    price=round(L["price"] + off, 2),
                    first_touch_utc=L["first_touch_utc"], first_touch_et=L["first_touch_et"],
                    n_touches=0, max_rev="", rej30="", rej50="", symbol=L["symbol"], overlap=0))
        # round numbers touched that day (need day range) -> handled below
    # round numbers: need day RTH price paths again
    days2 = defaultdict(list)
    with open(CACHE) as f:
        r = csv.reader(f); next(r)
        for row in r:
            dt = et_parts(row[0])
            if (dt.hour, dt.minute) >= (9, 30) and (dt.hour, dt.minute) <= (15, 0):
                days2[str(dt.date())].append((dt, row[0], float(row[2]), float(row[3]), row[6]))
    for date, Ls in sorted(bydate.items()):
        bars = days2.get(date)
        if not bars:
            continue
        bars.sort()
        dom = Ls[0]["symbol"]
        bars = [b for b in bars if b[4] == dom]
        if not bars:
            continue
        lo = min(b[3] for b in bars); hi = max(b[2] for b in bars)
        real_prices = [L["price"] for L in Ls]
        k = (int(lo) // 100) * 100
        while k <= hi + 100:
            if lo - 2 <= k <= hi + 2 and all(abs(k - p) > 10 for p in real_prices):
                ft = next((b for b in bars if b[3] - 2 <= k <= b[2] + 2), None)
                if ft:
                    controls.append(dict(
                        date=date, cls="round", direction="",
                        price=float(k), first_touch_utc=ft[1],
                        first_touch_et=ft[0].strftime("%H:%M"),
                        n_touches=0, max_rev="", rej30="", rej50="", symbol=dom, overlap=0))
            k += 100

    allrows = levels + controls
    with open(OUT_LEVELS, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(allrows[0].keys()))
        w.writeheader(); w.writerows(allrows)

    # ---- census ----
    from collections import Counter
    print("\n== level counts by year x class ==")
    cnt = Counter((L["date"][:4], L["cls"]) for L in allrows)
    years = sorted({y for y, _ in cnt})
    classes = ["rejected", "rejected30only", "broken", "placebo", "round"]
    print("year " + " ".join(f"{c:>14}" for c in classes))
    for y in years:
        print(y + "  " + " ".join(f"{cnt.get((y, c), 0):>14}" for c in classes))
    print("\n== rejected levels: first-touch ET hour distribution ==")
    hcnt = Counter(L["first_touch_et"][:2] for L in levels if L["cls"] == "rejected")
    for h in sorted(hcnt):
        print(f"  {h}:xx  {hcnt[h]}")

if __name__ == "__main__":
    main()
