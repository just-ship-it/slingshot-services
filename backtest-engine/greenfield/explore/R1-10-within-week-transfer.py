#!/usr/bin/env python3
"""
R1-10: Within-WEEK transfer baseline (price memory across days, no options
features): does a level that REJECTED on day D get respected when touched on a
LATER day of the same ISO week, more than a distance-matched placebo?

Placebo: signed distance d = level - spotW (spotW = day-W 09:30 ET close,
knowable before any touch that day); sample 3 signed distances from OTHER weeks'
(rejected-level, evaluation-day) pairs with same sign, |d'| within +-25%.
Identical touch/outcome machinery. Respect = >=20 (and >=35) pt reversal before
8pt penetration within 60m; break = >20pt penetration first.
"""
import csv, random
from collections import defaultdict
from datetime import datetime, date
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
CACHE = f"{BASE}/greenfield/explore/cache_nq_primary_1m.csv"
LEVELS = f"{BASE}/greenfield/explore/R1-labels-levels.csv"
ET = ZoneInfo("America/New_York")
random.seed(20260717)

_off = {}
def to_et(ts):
    d = ts[:10]
    off = _off.get(d)
    if off is None:
        dt = datetime.fromisoformat(ts).replace(tzinfo=ZoneInfo("UTC"))
        off = dt.astimezone(ET).utcoffset()
        _off[d] = off
    return datetime(int(d[:4]), int(d[5:7]), int(d[8:10]), int(ts[11:13]), int(ts[14:16])) + off

days = defaultdict(list)
with open(CACHE) as f:
    r = csv.reader(f); next(r)
    for row in r:
        dt = to_et(row[0])
        if (dt.hour, dt.minute) >= (9, 30) and dt.hour < 16:
            days[str(dt.date())].append((dt, float(row[1]), float(row[2]), float(row[3]), float(row[4]), row[6]))
for d in days:
    days[d].sort(key=lambda b: b[0])
    sc = defaultdict(int)
    for b in days[d]:
        sc[b[5]] += 1
    dom = max(sc, key=sc.get)
    days[d] = [b for b in days[d] if b[5] == dom]

def spot930(d):
    bs = days.get(d)
    return bs[0][4] if bs else None

rej = defaultdict(list)
for r in csv.DictReader(open(LEVELS)):
    if r["cls"] == "rejected":
        rej[r["date"]].append(float(r["price"]))

trading_days = sorted(days)
def week_of(dstr):
    return date(int(dstr[:4]), int(dstr[5:7]), int(dstr[8:10])).isocalendar()[:2]

# pairs: (source day D, eval day W same week, level)
pairs = []
for d, lv in rej.items():
    wk = week_of(d)
    for w in trading_days:
        if w > d and week_of(w) == wk:
            for L in lv:
                pairs.append((d, w, L))

# distance pool: signed (L - spotW) per pair, keyed by week for exclusion
pool = []
for d, w, L in pairs:
    s = spot930(w)
    if s:
        pool.append((week_of(w), L - s))

def eval_day(w, L):
    bars = days[w]
    idx = [i for i, b in enumerate(bars) if (9, 31) <= (b[0].hour, b[0].minute) <= (14, 30)]
    for i in idx:
        b = bars[i]
        if b[3] <= L <= b[2]:
            prev_close = bars[i - 1][4] if i > 0 else b[1]
            side = "above" if prev_close >= L else "below"
            rev20 = rev35 = brk = False
            pen_ok = True
            for k in range(i + 1, min(i + 61, len(bars))):
                hb, lb = bars[k][2], bars[k][3]
                pen = (L - lb) if side == "above" else (hb - L)
                rev = (hb - L) if side == "above" else (L - lb)
                if pen > 20 and not rev20:
                    brk = True; break
                if pen > 8 and not (rev20 or rev35):
                    pen_ok = False
                if rev >= 20 and pen_ok and not brk:
                    rev20 = True
                if rev >= 35 and pen_ok and not brk:
                    rev35 = True; break
            return (rev20, rev35, brk)
    return None

res = defaultdict(lambda: defaultdict(lambda: [0, 0, 0, 0]))
for d, w, L in pairs:
    s = spot930(w)
    if not s:
        continue
    y = w[:4]
    out = eval_day(w, L)
    if out is not None:
        c = res[y]["real"]
        c[0] += 1; c[1] += out[0]; c[2] += out[1]; c[3] += out[2]
    dd = L - s
    cand = [x for x in pool if x[0] != week_of(w) and x[1] * dd > 0
            and 0.75 * abs(dd) <= abs(x[1]) <= 1.25 * abs(dd)]
    if len(cand) >= 3:
        for _, d2 in random.sample(cand, 3):
            o2 = eval_day(w, s + d2)
            if o2 is not None:
                c = res[y]["plc"]
                c[0] += 1; c[1] += o2[0]; c[2] += o2[1]; c[3] += o2[2]

print("Within-week transfer: day-D rejected levels touched on later same-week days")
print(f"{'year':<6}{'kind':<6}{'touched':>8}{'resp20':>8}{'resp35':>8}{'broken':>8}")
tot = defaultdict(lambda: [0, 0, 0, 0])
for y in sorted(res):
    for kind in ("real", "plc"):
        c = res[y][kind]
        if c[0]:
            print(f"{y:<6}{kind:<6}{c[0]:>8}{c[1]/c[0]:>8.3f}{c[2]/c[0]:>8.3f}{c[3]/c[0]:>8.3f}")
            for i in range(4):
                tot[kind][i] += c[i]
for kind in ("real", "plc"):
    c = tot[kind]
    if c[0]:
        print(f"{'ALL':<6}{kind:<6}{c[0]:>8}{c[1]/c[0]:>8.3f}{c[2]/c[0]:>8.3f}{c[3]/c[0]:>8.3f}")
