#!/usr/bin/env python3
"""
R1-11: Phase-3 style FORWARD test of the one stable Phase-2 separator — the
INVERTED prevvol effect (high prior-day option volume strikes break more).

Recipe frozen from Phase 2, computed at 09:31 ET from information knowable then:
  - spot = first RTH NQ 1m close (09:30 bar, knowable 09:31); ratio = NQ/QQQ
    same-minute closes.
  - candidate strikes: QQQ strikes within +-3% of QQQ spot, from the same-day
    pre-open statistics file (prior-day volume, stat_type 6).
  - FLAGGED  = top-decile prevvol strikes.  CONTROL = 30-60th pctile strikes,
    each matched to a flagged strike by same side & closest |dist from spot|
    (within 30%); unmatched flagged strikes dropped.
Prediction: flagged NQ prices, when touched >=09:35 ET, get PENETRATED (>20pt
before 20pt reversal) MORE than matched controls. Respect/penetration stats only.
"""
import csv, bisect
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
CACHE = f"{BASE}/greenfield/explore/cache_nq_primary_1m.csv"
OICACHE = f"{BASE}/greenfield/explore/R1-oi-cache.csv"
QQQ = f"{BASE}/data/ohlcv/qqq/QQQ_ohlcv_1m.csv"
ET = ZoneInfo("America/New_York")

_off = {}
def to_et(ts):
    d = ts[:10]
    off = _off.get(d)
    if off is None:
        dt = datetime.fromisoformat(ts).replace(tzinfo=ZoneInfo("UTC"))
        off = dt.astimezone(ET).utcoffset()
        _off[d] = off
    return datetime(int(d[:4]), int(d[5:7]), int(d[8:10]), int(ts[11:13]), int(ts[14:16])) + off

# prevvol per (date, strike)
pv = defaultdict(lambda: defaultdict(float))
with open(OICACHE) as f:
    r = csv.reader(f); next(r)
    for d, exp, cp, k, o, v in r:
        pv[d][float(k)] += int(v)

# NQ RTH bars per ET day (dominant symbol)
days = defaultdict(list)
with open(CACHE) as f:
    r = csv.reader(f); next(r)
    for row in r:
        dt = to_et(row[0])
        if (dt.hour, dt.minute) >= (9, 30) and dt.hour < 16:
            days[str(dt.date())].append((dt, row[0], float(row[2]), float(row[3]), float(row[4]), row[6]))
for d in days:
    days[d].sort(key=lambda b: b[0])
    sc = defaultdict(int)
    for b in days[d]:
        sc[b[5]] += 1
    dom = max(sc, key=sc.get)
    days[d] = [b for b in days[d] if b[5] == dom]

# QQQ close at each day's first RTH minute (same UTC minute as NQ 09:30 bar)
need_min = {days[d][0][1][:16]: d for d in days if days[d]}
qqq930 = {}
with open(QQQ) as f:
    r = csv.reader(f); next(r)
    for row in r:
        if len(row) < 10 or not row[7]:
            continue
        m = row[0][:16]
        if m in need_min:
            qqq930[need_min[m]] = float(row[7])

def eval_touch(bars, L):
    """First touch at/after 09:35 ET, walk 60m: respect20 / broken / neither."""
    for i, b in enumerate(bars):
        if (b[0].hour, b[0].minute) < (9, 35) or (b[0].hour, b[0].minute) > (14, 30):
            continue
        if b[3] <= L <= b[2]:
            prev_close = bars[i - 1][4] if i > 0 else b[2]
            side = "above" if prev_close >= L else "below"
            rev20 = brk = False
            pen_ok = True
            for k in range(i + 1, min(i + 61, len(bars))):
                hb, lb = bars[k][2], bars[k][3]
                pen = (L - lb) if side == "above" else (hb - L)
                rev = (hb - L) if side == "above" else (L - lb)
                if pen > 20 and not rev20:
                    brk = True; break
                if pen > 8 and not rev20:
                    pen_ok = False
                if rev >= 20 and pen_ok:
                    rev20 = True; break
            return (rev20, brk)
    return None

res = defaultdict(lambda: defaultdict(lambda: [0, 0, 0]))  # y -> kind -> [touched, resp, brk]
for d in sorted(pv):
    if d not in days or d not in qqq930 or not days[d]:
        continue
    bars = days[d]
    nq930 = bars[0][4]
    ratio = nq930 / qqq930[d]
    qs = qqq930[d]
    strikes = sorted(k for k in pv[d] if abs(k - qs) <= qs * 0.03)
    if len(strikes) < 15:
        continue
    vols = sorted(pv[d][k] for k in strikes)
    n = len(vols)
    top = vols[int(0.9 * n)]
    lo3, hi6 = vols[int(0.3 * n)], vols[int(0.6 * n)]
    flagged = [k for k in strikes if pv[d][k] >= top]
    ctrlpool = [k for k in strikes if lo3 <= pv[d][k] <= hi6]
    used = set()
    for kf in flagged:
        df_ = kf - qs
        cands = [kc for kc in ctrlpool if kc not in used and (kc - qs) * df_ > 0
                 and abs(abs(kc - qs) - abs(df_)) <= 0.3 * max(abs(df_), 1.0)]
        if not cands:
            continue
        kc = min(cands, key=lambda k: abs(abs(k - qs) - abs(df_)))
        used.add(kc)
        y = d[:4]
        for kind, K in (("flag", kf), ("ctrl", kc)):
            out = eval_touch(bars, K * ratio)
            if out is not None:
                c = res[y][kind]
                c[0] += 1; c[1] += out[0]; c[2] += out[1]

print("Forward test: top-decile prior-day-volume strikes (flag) vs matched mid-vol (ctrl)")
print("prediction: flagged break MORE when touched")
print(f"{'year':<6}{'kind':<6}{'touched':>8}{'resp20':>8}{'broken':>8}")
tot = defaultdict(lambda: [0, 0, 0])
for y in sorted(res):
    for kind in ("flag", "ctrl"):
        c = res[y][kind]
        if c[0]:
            print(f"{y:<6}{kind:<6}{c[0]:>8}{c[1]/c[0]:>8.3f}{c[2]/c[0]:>8.3f}")
            for i in range(3):
                tot[kind][i] += c[i]
for kind in ("flag", "ctrl"):
    c = tot[kind]
    if c[0]:
        print(f"{'ALL':<6}{kind:<6}{c[0]:>8}{c[1]/c[0]:>8.3f}{c[2]/c[0]:>8.3f}")
