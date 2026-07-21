#!/usr/bin/env python3
"""
R1-08: Deeper hunt beyond pooled univariate AUC (R1-05).

 a) SHARPENED classes: strong rejections (rej50=1) vs clean breaks
    (max_rev < 10 before the break) — remove label dilution.
 b) Direction-conditioned AUCs (upper-only / lower-only) — sign-cancel check.
 c) Decile lift: P(rejected) in top/bottom decile of each feature vs base rate
    (catches tail-only, non-monotone-in-the-middle effects).
 d) GEX-incremental: same contrasts inside gex_within25==0 and ==1 slices.
 e) Time-of-day: morning (<12:00 ET) vs afternoon touches.
All per-year where samples allow.

Usage: R1-08-hunt.py [features_csv]
"""
import csv, sys
from collections import defaultdict

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
FEATS = sys.argv[1] if len(sys.argv) > 1 else f"{BASE}/greenfield/explore/R1-features.csv"
rows = list(csv.DictReader(open(FEATS)))

FEATLIST = ["dist_to_strike", "oi_tot", "oi_put", "oi_call", "oi_0dte", "oi_wk",
            "prevvol", "oi_pcr", "oi_dir", "oi_pctile", "vol_pctile", "oi0_pctile",
            "dist_maxoi", "oi_conc5", "oi_0dte_share", "dist_maxpain",
            "gex_min_dist", "gex_within25", "gex_cw_dist", "gex_pw_dist"]
FEATLIST = [f for f in FEATLIST if f in rows[0]]

def num(r, f):
    v = r.get(f, "")
    try:
        return float(v)
    except (ValueError, TypeError):
        return None

def auc(a, b):
    allv = sorted([(v, 0) for v in a] + [(v, 1) for v in b])
    n = len(allv); i = 0; ra = 0.0
    while i < n:
        j = i
        while j < n and allv[j][0] == allv[i][0]:
            j += 1
        avg = (i + j + 1) / 2.0
        for k in range(i, j):
            if allv[k][1] == 0:
                ra += avg
        i = j
    na, nb = len(a), len(b)
    if na < 30 or nb < 30:
        return None
    return (ra - na * (na + 1) / 2.0) / (na * nb)

def is_sharp_rej(r):
    return r["cls"] == "rejected" and r.get("rej50") == "1"

def is_clean_brk(r):
    if r["cls"] != "broken":
        return False
    try:
        return float(r["max_rev"]) < 10
    except ValueError:
        return False

years = sorted({r["date"][:4] for r in rows})

def contrast(tag, selA, selB, cond=lambda r: True):
    print(f"\n== {tag} ==")
    A = [r for r in rows if selA(r) and cond(r)]
    B = [r for r in rows if selB(r) and cond(r)]
    print(f"   nA={len(A)} nB={len(B)}")
    hdr = f"{'feature':<18}" + "".join(f"{y:>9}" for y in years) + f"{'pooled':>9}"
    print(hdr)
    for f in FEATLIST:
        cells = []
        for y in years + [None]:
            a = [num(r, f) for r in A if (y is None or r["date"][:4] == y)]
            b = [num(r, f) for r in B if (y is None or r["date"][:4] == y)]
            a = [x for x in a if x is not None]; b = [x for x in b if x is not None]
            v = auc(a, b)
            cells.append(f"{v:.3f}" if v is not None else "    -")
        print(f"{f:<18}" + "".join(f"{c:>9}" for c in cells))

# a) sharpened
contrast("SHARP: rej50 vs clean-break (max_rev<10)", is_sharp_rej, is_clean_brk)
# b) direction-conditioned (standard classes)
for d in ("upper", "lower"):
    contrast(f"DIR={d}: rejected vs broken",
             lambda r: r["cls"] == "rejected", lambda r: r["cls"] == "broken",
             cond=lambda r, d=d: r["direction"] == d)
# e) time of day
for lo, hi, tag in (("09:30", "11:59", "morning"), ("12:00", "15:00", "afternoon")):
    contrast(f"TOD={tag}: rejected vs broken",
             lambda r: r["cls"] == "rejected", lambda r: r["cls"] == "broken",
             cond=lambda r, lo=lo, hi=hi: lo <= r["first_touch_et"] <= hi)
# d) GEX slices
for gv in ("0", "1"):
    contrast(f"GEXwithin25={gv}: rejected vs broken",
             lambda r: r["cls"] == "rejected", lambda r: r["cls"] == "broken",
             cond=lambda r, gv=gv: r.get("gex_within25") == gv)

# c) decile lift (pooled, rejected vs broken universe)
print("\n== decile lift: P(rejected) in bottom/top decile vs base (rej+brk universe) ==")
uni = [r for r in rows if r["cls"] in ("rejected", "broken")]
base = sum(r["cls"] == "rejected" for r in uni) / len(uni)
print(f"base P(rejected) = {base:.3f}   n={len(uni)}")
print(f"{'feature':<18}{'P(rej|bot10%)':>14}{'P(rej|top10%)':>14}{'n_dec':>7}")
for f in FEATLIST:
    vals = [(num(r, f), r["cls"]) for r in uni]
    vals = [(v, c) for v, c in vals if v is not None]
    if len(vals) < 300:
        continue
    vals.sort(key=lambda x: x[0])
    nd = len(vals) // 10
    bot = vals[:nd]; top = vals[-nd:]
    pb = sum(c == "rejected" for _, c in bot) / nd
    pt = sum(c == "rejected" for _, c in top) / nd
    print(f"{f:<18}{pb:>14.3f}{pt:>14.3f}{nd:>7}")

# f) day-matched contrast: mean(feature|rejected) - mean(feature|broken) per day,
#    sign test across days (kills day-regime confounds: trend days breed brokens)
print("\n== day-matched: share of days where mean(rej) > mean(brk), days with both ==")
bydate = defaultdict(lambda: defaultdict(list))
for r in uni:
    for f in FEATLIST:
        v = num(r, f)
        if v is not None:
            bydate[r["date"]][(f, r["cls"])].append(v)
for f in FEATLIST:
    wins = tot = 0
    for d, tbl in bydate.items():
        a = tbl.get((f, "rejected")); b = tbl.get((f, "broken"))
        if a and b:
            ma = sum(a) / len(a); mb = sum(b) / len(b)
            if ma != mb:
                tot += 1
                wins += ma > mb
    if tot >= 100:
        print(f"{f:<18} share={wins / tot:.3f}  days={tot}")

# c2) per-year sign check of decile lift for any feature with |lift|>0.05
print("\n== per-year top-decile lift for features with pooled |lift|>0.04 ==")
for f in FEATLIST:
    vals = [(num(r, f), r["cls"], r["date"][:4]) for r in uni]
    vals = [x for x in vals if x[0] is not None]
    if len(vals) < 300:
        continue
    vals.sort(key=lambda x: x[0])
    nd = len(vals) // 10
    pt = sum(c == "rejected" for _, c, _ in vals[-nd:]) / nd
    if abs(pt - base) <= 0.04:
        continue
    cells = []
    for y in years:
        vy = [x for x in vals if x[2] == y]
        if len(vy) < 200:
            cells.append(f"{y}:-")
            continue
        vy.sort(key=lambda x: x[0])
        ndy = len(vy) // 10
        by = sum(c == "rejected" for _, c, _ in vy) / len(vy)
        pty = sum(c == "rejected" for _, c, _ in vy[-ndy:]) / ndy
        cells.append(f"{y}:{pty - by:+.3f}")
    print(f"{f:<18} pooled_top_lift={pt - base:+.3f}  " + " ".join(cells))
