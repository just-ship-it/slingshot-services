#!/usr/bin/env python3
"""
R1-05: Feature contrasts — rejected vs broken (HONEST control: both are local
extremes; one held, one didn't) and rejected vs placebo/round (weak control:
separates "is a local extreme" as much as "is a rejection").

For each numeric feature: per-year AUC (Mann-Whitney) for rejected-vs-broken and
rejected-vs-placebo, plus medians. AUC > 0.5 means feature is HIGHER for rejected.
A feature whose rej-vs-brk AUC crosses 0.5 across years is dead.

Usage: R1-05-contrast.py [features_csv] (default R1-features.csv)
"""
import csv, sys
from collections import defaultdict

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
FEATS = sys.argv[1] if len(sys.argv) > 1 else f"{BASE}/greenfield/explore/R1-features.csv"

rows = list(csv.DictReader(open(FEATS)))
SKIP = {"date", "cls", "direction", "price", "first_touch_utc", "first_touch_et",
        "n_touches", "max_rev", "rej30", "rej50", "symbol", "overlap", "ratio",
        "qqq_spot", "mapped_price", "K", "gex_regime"}
feats = [c for c in rows[0].keys() if c not in SKIP]

def auc(a, b):
    """P(a > b) + .5 P(=), rank-based, no scipy."""
    allv = sorted([(v, 0) for v in a] + [(v, 1) for v in b])
    n = len(allv)
    # assign average ranks
    ranks = {}
    i = 0
    ra = 0.0
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
    if na == 0 or nb == 0:
        return None
    u = ra - na * (na + 1) / 2.0
    return u / (na * nb)

def med(v):
    if not v:
        return None
    s = sorted(v); n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2

def getvals(cls_set, feat, year=None, direction=None):
    out = []
    for r in rows:
        if r["cls"] not in cls_set:
            continue
        if year and r["date"][:4] != year:
            continue
        if direction and r["direction"] != direction:
            continue
        v = r.get(feat, "")
        if v not in ("", None):
            try:
                out.append(float(v))
            except ValueError:
                pass
    return out

years = sorted({r["date"][:4] for r in rows})
REJ = {"rejected"}
BRK = {"broken"}
PLC = {"placebo"}
RND = {"round"}

print(f"rows: {len(rows)}; years {years}")
print(f"{'feature':<20} {'ctrl':<8} " + " ".join(f"{y:>12}" for y in years) + f" {'pooled':>12}")
print("-" * (30 + 13 * (len(years) + 1)))
for feat in feats:
    for ctrl, cset in (("broken", BRK), ("placebo", PLC)):
        cells = []
        for y in years + [None]:
            a = getvals(REJ, feat, y)
            b = getvals(cset, feat, y)
            if len(a) >= 30 and len(b) >= 30:
                v = auc(a, b)
                cells.append(f"{v:.3f}(n{len(a)//100})" if v is not None else "")
            else:
                cells.append("-")
        print(f"{feat:<20} {ctrl:<8} " + " ".join(f"{c:>12}" for c in cells))
print()
print("medians (pooled): feature: rejected | broken | placebo | round")
for feat in feats:
    m = [med(getvals(s, feat)) for s in (REJ, BRK, PLC, RND)]
    fmt = lambda x: f"{x:.3f}" if x is not None else "-"
    print(f"  {feat:<20} " + " | ".join(fmt(x) for x in m))
