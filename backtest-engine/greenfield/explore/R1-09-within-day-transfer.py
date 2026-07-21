#!/usr/bin/env python3
"""
R1-09a: Within-day transfer BASELINE (price memory, no options features).

Question (owner's premise, purest form): does a level that rejected in the
MORNING (first touch < 12:00 ET) get respected in the AFTERNOON (12:00-15:30 ET)
more than a distance-matched placebo price?

Placebo: for each morning rejection level with signed distance d = level - spot12
(spot12 = 12:00 ET last close, knowable), sample 3 signed distances from OTHER
days' morning-rejection levels with |d'| within +-25% of |d| and same sign, and
plant placebo prices at spot12 + d'. Identical touch/outcome machinery for both.

Touch: afternoon bar (12:00-14:30 ET so 60m fits) with low <= L <= high (first).
Direction of test at touch = from which side price arrives (close of prior bar
vs L). Respect = reversal >= 20 (also 35) pts away from arrival side before
penetration > 8 pts beyond, within 60m; Break = penetration > 20 before 20-pt
reversal. Report respect rates per year, real vs placebo.

NO fills / PF / WR — respect/penetration stats only (per charter).
"""
import csv, random
from collections import defaultdict
from datetime import datetime
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

# ---- load cache grouped by ET day (RTH only), dominant symbol ----
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

# ---- morning rejection levels ----
morning = defaultdict(list)  # date -> [price]
for r in csv.DictReader(open(LEVELS)):
    if r["cls"] == "rejected" and r["first_touch_et"] < "12:00":
        morning[r["date"]].append(float(r["price"]))

# signed-distance pool across days
spot12 = {}
for d, bars in days.items():
    b12 = [b for b in bars if (b[0].hour, b[0].minute) <= (11, 59)]
    if b12:
        spot12[d] = b12[-1][4]
dist_pool = []  # (date, signed_dist)
for d, lv in morning.items():
    s = spot12.get(d)
    if s:
        for L in lv:
            dist_pool.append((d, L - s))

def eval_afternoon(d, L):
    """Return None if not touched; else (respect20, respect35, broken)."""
    bars = days[d]
    idx = [i for i, b in enumerate(bars) if (12, 0) <= (b[0].hour, b[0].minute) <= (14, 30)]
    for i in idx:
        b = bars[i]
        if b[3] <= L <= b[2]:  # touched
            prev_close = bars[i - 1][4] if i > 0 else b[1]
            side = "above" if prev_close >= L else "below"  # price arrives from...
            # walk forward 60 bars
            rev20 = rev35 = brk = False
            pen_cap_ok = True
            for k in range(i + 1, min(i + 61, len(bars))):
                hb, lb = bars[k][2], bars[k][3]
                if side == "above":      # level acts as support; pen = below L
                    pen = L - lb; rev = hb - L
                else:                    # resistance; pen = above L
                    pen = hb - L; rev = L - lb
                if pen > 20 and not rev20:
                    brk = True
                    break
                if pen > 8 and not (rev20 or rev35):
                    pen_cap_ok = False
                if rev >= 20 and pen_cap_ok and not brk:
                    rev20 = True
                if rev >= 35 and pen_cap_ok and not brk:
                    rev35 = True
                    break
            return (rev20, rev35, brk)
    return None

res = defaultdict(lambda: defaultdict(lambda: [0, 0, 0, 0]))  # year -> kind -> [touched, r20, r35, brk]
for d, lv in sorted(morning.items()):
    if d not in days or d not in spot12:
        continue
    y = d[:4]
    s = spot12[d]
    for L in lv:
        out = eval_afternoon(d, L)
        if out is not None:
            c = res[y]["real"]
            c[0] += 1; c[1] += out[0]; c[2] += out[1]; c[3] += out[2]
        # placebos
        dd = L - s
        pool = [x for x in dist_pool if x[0] != d and x[1] * dd > 0
                and 0.75 * abs(dd) <= abs(x[1]) <= 1.25 * abs(dd)]
        if len(pool) >= 3:
            for _, d2 in random.sample(pool, 3):
                out2 = eval_afternoon(d, s + d2)
                if out2 is not None:
                    c = res[y]["plc"]
                    c[0] += 1; c[1] += out2[0]; c[2] += out2[1]; c[3] += out2[2]

print("Within-day transfer: morning rejection levels vs distance-matched placebo")
print("(afternoon touch rate conditioning identical; respect = bounce before 8pt pen)")
print(f"{'year':<6}{'kind':<6}{'touched':>8}{'resp20':>8}{'resp35':>8}{'broken':>8}")
tot = defaultdict(lambda: [0, 0, 0, 0])
for y in sorted(res):
    for kind in ("real", "plc"):
        c = res[y][kind]
        if c[0]:
            print(f"{y:<6}{kind:<6}{c[0]:>8}{c[1]/c[0]:>8.3f}{c[2]/c[0]:>8.3f}{c[3]/c[0]:>8.3f}")
            t = tot[kind]
            for i in range(4):
                t[i] += c[i]
for kind in ("real", "plc"):
    c = tot[kind]
    if c[0]:
        print(f"{'ALL':<6}{kind:<6}{c[0]:>8}{c[1]/c[0]:>8.3f}{c[2]/c[0]:>8.3f}{c[3]/c[0]:>8.3f}")
