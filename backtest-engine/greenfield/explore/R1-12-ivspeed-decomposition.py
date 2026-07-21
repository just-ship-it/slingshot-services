#!/usr/bin/env python3
"""
R1-12: Decompose the one surviving Phase-2 effect — elevated 0DTE IV at the
touched strike (rejected vs broken, cbbo panel 2025-01→2026-06) — against pure
price-action arrival speed.

arrival speed = |NQ close(T-1) - close(T-11)| (10m move into the touch bar),
knowable at touch; live-sourceable from the price feed alone.

Outputs:
  - day / day+hour / day+hour+speed-matched sign-test shares for iv_put
  - reverse test (speed within IV quintiles)
  - day+hour z-score top-decile lifts for iv_put, iv_call, speed, per year
"""
import csv, statistics as st, math, bisect
from collections import defaultdict
from datetime import datetime, timedelta

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
CACHE = f"{BASE}/greenfield/explore/cache_nq_primary_1m.csv"
CBBO = f"{BASE}/greenfield/explore/R1-cbbo-all.csv"

nq = {}
with open(CACHE) as f:
    r = csv.reader(f); next(r)
    for row in r:
        if row[0] >= "2025-01-01":
            nq[row[0][:16]] = float(row[4])

rows = list(csv.DictReader(open(CBBO)))
uni = [r for r in rows if r["cls"] in ("rejected", "broken")]

def num(r, f):
    try:
        return float(r[f])
    except (ValueError, KeyError):
        return None

def speed(r, mins=10):
    t = datetime.fromisoformat(r["first_touch_utc"][:16])
    a = nq.get((t - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M"))
    b = nq.get((t - timedelta(minutes=1 + mins)).strftime("%Y-%m-%dT%H:%M"))
    return None if a is None or b is None else abs(a - b)

def sign_share(keyf, valf):
    cell = defaultdict(lambda: defaultdict(list))
    for r in uni:
        v = valf(r)
        k = keyf(r)
        if v is not None and k is not None:
            cell[k][r["cls"]].append(v)
    wins = tot = 0
    for k, t in cell.items():
        a, b = t.get("rejected"), t.get("broken")
        if a and b:
            ma, mb = sum(a) / len(a), sum(b) / len(b)
            if ma != mb:
                tot += 1
                wins += ma > mb
    return wins / tot, tot

def dh_z(valf):
    cells = defaultdict(list)
    for r in uni:
        v = valf(r)
        if v is not None:
            cells[(r["date"], r["first_touch_utc"][11:13])].append(v)
    mu = {k: st.mean(v) for k, v in cells.items() if len(v) >= 4}
    sd = {k: (st.pstdev(v) or 1e-9) for k, v in cells.items() if len(v) >= 4}
    out = []
    for r in uni:
        v = valf(r); k = (r["date"], r["first_touch_utc"][11:13])
        if v is not None and k in mu and sd[k] > 1e-9:
            out.append(((v - mu[k]) / sd[k], r["cls"], r["date"][:4]))
    return out

def lift(name, sc):
    sc.sort(); n = len(sc)
    base = sum(c == "rejected" for _, c, _ in sc) / n
    top = sc[-n // 10:]
    line = f"{name}: n={n} base={base:.3f} top-decile={sum(c=='rejected' for _,c,_ in top)/len(top):.3f}"
    for y in ("2025", "2026"):
        s = sorted(x for x in sc if x[2] == y)
        if len(s) < 500:
            continue
        by = sum(c == "rejected" for _, c, _ in s) / len(s)
        ty = s[-len(s) // 10:]
        line += f"  {y}:{by:.3f}->{sum(c=='rejected' for _,c,_ in ty)/len(ty):.3f}"
    print(line)

ivp = lambda r: num(r, "iv_put")
day = lambda r: r["date"]
dayhour = lambda r: (r["date"], r["first_touch_utc"][11:13])

s, n = sign_share(day, ivp);      print(f"iv_put day-matched:        {s:.3f} ({n})")
s, n = sign_share(dayhour, ivp);  print(f"iv_put day+hour-matched:   {s:.3f} ({n})")

# speed quintiles within day+hour
zsp = dh_z(speed)
zvals = sorted(z for z, _, _ in zsp)
zmap = {}
for r in uni:
    v = speed(r)
    if v is None:
        continue
zq = {}
cells = defaultdict(list)
for r in uni:
    v = speed(r)
    if v is not None:
        cells[dayhour(r)].append(v)
mu = {k: st.mean(v) for k, v in cells.items() if len(v) >= 4}
sd = {k: (st.pstdev(v) or 1e-9) for k, v in cells.items() if len(v) >= 4}
def speed_quint(r):
    v = speed(r); k = dayhour(r)
    if v is None or k not in mu or sd[k] <= 1e-9:
        return None
    z = (v - mu[k]) / sd[k]
    return min(4, bisect.bisect_left(zvals, z) * 5 // len(zvals))
s, n = sign_share(lambda r: (dayhour(r), speed_quint(r)) if speed_quint(r) is not None else None, ivp)
se = math.sqrt(0.25 / n)
print(f"iv_put day+hour+speedQ5:   {s:.3f} ({n}, se~{se:.3f})")

# reverse: speed within iv quintiles
cells_iv = defaultdict(list)
for r in uni:
    v = ivp(r)
    if v is not None:
        cells_iv[dayhour(r)].append(v)
mui = {k: st.mean(v) for k, v in cells_iv.items() if len(v) >= 4}
sdi = {k: (st.pstdev(v) or 1e-9) for k, v in cells_iv.items() if len(v) >= 4}
zi_all = sorted(((ivp(r) - mui[k]) / sdi[k]) for r in uni for k in [dayhour(r)]
                if ivp(r) is not None and k in mui and sdi[k] > 1e-9)
def iv_quint(r):
    v = ivp(r); k = dayhour(r)
    if v is None or k not in mui or sdi[k] <= 1e-9:
        return None
    z = (v - mui[k]) / sdi[k]
    return min(4, bisect.bisect_left(zi_all, z) * 5 // len(zi_all))
s, n = sign_share(lambda r: (dayhour(r), iv_quint(r)) if iv_quint(r) is not None else None, speed)
print(f"speed  day+hour+ivQ5:      {s:.3f} ({n})")

print()
lift("iv_put dh-z ", dh_z(ivp))
lift("iv_call dh-z", dh_z(lambda r: num(r, "iv_call")))
lift("speed dh-z  ", dh_z(speed))
