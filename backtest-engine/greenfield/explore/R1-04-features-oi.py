#!/usr/bin/env python3
"""
R1-04: Join mapped levels/controls with OI features (from R1-oi-cache.csv) and
the GEX baseline (data/gex/nq daily JSON, as-of join at-or-before touch time).

Knowability of every feature:
  - OI / prevvol features: from statistics received 05:30-06:30 ET same day
    (prior-session values) -> knowable before RTH open, all day.  LIVE-SOURCEABLE
    (broker chains provide OI + prior volume).
  - dist_to_strike: pure arithmetic on the morning ratio -> knowable at touch.
  - GEX baseline: as-of snapshot with ts <= touch ts (causal gex/nq dir).

Output: R1-features.csv (one row per level/control with feature columns).
"""
import csv, json, os, bisect, sys
from collections import defaultdict

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
LEVELS = f"{BASE}/greenfield/explore/R1-levels-mapped.csv"
OICACHE = sys.argv[1] if len(sys.argv) > 1 else f"{BASE}/greenfield/explore/R1-oi-cache.csv"
GEXDIR = f"{BASE}/data/gex/nq"
OUT = sys.argv[2] if len(sys.argv) > 2 else f"{BASE}/greenfield/explore/R1-features.csv"

# ---- load OI cache ----
# per date: strike -> {tot,put,call,dte0,wk,vol} ; plus expiry list
oi = defaultdict(lambda: defaultdict(lambda: [0.0] * 6))  # date -> strike -> [tot,put,call,dte0,wk,vol]
expiries = defaultdict(set)
oi_by_exp = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))  # (date,expiry) -> strike -> [putoi, calloi]
with open(OICACHE) as f:
    r = csv.reader(f); next(r)
    for d, exp, cp, k, o, v in r:
        k = float(k); o = int(o); v = int(v)
        row = oi[d][k]
        row[0] += o
        row[1 if cp == "P" else 2] += o
        dte = (int(exp[:4]) * 372 + int(exp[5:7]) * 31 + int(exp[8:10])) - \
              (int(d[:4]) * 372 + int(d[5:7]) * 31 + int(d[8:10]))
        if exp == d:
            row[3] += o
        if 0 <= dte <= 7:
            row[4] += o
        row[5] += v
        expiries[d].add(exp)
        e = oi_by_exp[(d, exp)][k]
        e[0 if cp == "P" else 1] += o

def max_pain(d, exp):
    tbl = oi_by_exp.get((d, exp))
    if not tbl:
        return None
    ks = sorted(tbl)
    best, bestv = None, None
    for s in ks:
        pay = 0.0
        for k2, (po, co) in tbl.items():
            pay += co * max(0.0, s - k2) + po * max(0.0, k2 - s)
        if bestv is None or pay < bestv:
            best, bestv = s, pay
    return best

mp_cache = {}

# ---- GEX snapshots ----
gex_cache = {}
def gex_day(d):
    if d in gex_cache:
        return gex_cache[d]
    fp = f"{GEXDIR}/nq_gex_{d}.json"
    snaps = []
    if os.path.exists(fp):
        data = json.load(open(fp)).get("data", [])
        for s in data:
            ts = s["timestamp"][:16]  # "2025-01-02T09:15" UTC
            snaps.append((ts, s))
        snaps.sort(key=lambda x: x[0])
    gex_cache[d] = snaps
    return snaps

def gex_features(d, ts16, price):
    snaps = gex_day(d)
    if not snaps:
        return {}
    keys = [s[0] for s in snaps]
    i = bisect.bisect_right(keys, ts16) - 1
    if i < 0:
        return {}
    s = snaps[i][1]
    lv = [x for x in (s.get("resistance") or []) if x] + [x for x in (s.get("support") or []) if x]
    for w in ("call_wall", "put_wall", "gamma_flip"):
        if s.get(w):
            lv.append(s[w])
    out = {}
    if lv:
        out["gex_min_dist"] = round(min(abs(price - x) for x in lv), 2)
        out["gex_within25"] = int(out["gex_min_dist"] <= 25)
    out["gex_total"] = s.get("total_gex")
    out["gex_regime"] = s.get("regime", "")
    if s.get("call_wall"):
        out["gex_cw_dist"] = round(abs(price - s["call_wall"]), 2)
    if s.get("put_wall"):
        out["gex_pw_dist"] = round(abs(price - s["put_wall"]), 2)
    return out

# ---- per-level features ----
rows = list(csv.DictReader(open(LEVELS)))
out = []
for r in rows:
    d = r["date"]
    if d not in oi:
        continue
    m = float(r["mapped_price"])
    qs = float(r["qqq_spot"])
    ratio = float(r["ratio"])
    tbl = oi[d]
    ks = sorted(tbl)
    K = min(ks, key=lambda k: abs(k - m)) if ks else None
    if K is None or abs(K - m) > 1.5:
        continue
    f = dict(r)
    f["K"] = K
    f["dist_to_strike"] = round(abs(m - round(m)), 4)          # frac of $1
    f["dist_to_strike_nq"] = round(abs(m - round(m)) * ratio, 2)
    row = tbl[K]
    f["oi_tot"] = row[0]; f["oi_put"] = row[1]; f["oi_call"] = row[2]
    f["oi_0dte"] = row[3]; f["oi_wk"] = row[4]; f["prevvol"] = row[5]
    f["oi_pcr"] = round(row[1] / row[2], 3) if row[2] > 0 else ""
    # directional OI: puts defend lower levels, calls cap upper levels
    if r["direction"] == "lower":
        f["oi_dir"] = row[1]
    elif r["direction"] == "upper":
        f["oi_dir"] = row[2]
    else:
        f["oi_dir"] = ""
    # neighborhood: strikes within +-3% of spot
    nb = [k for k in ks if abs(k - qs) <= qs * 0.03]
    if len(nb) >= 10:
        tots = sorted(tbl[k][0] for k in nb)
        f["oi_pctile"] = round(bisect.bisect_left(tots, row[0]) / len(tots), 3)
        vols = sorted(tbl[k][5] for k in nb)
        f["vol_pctile"] = round(bisect.bisect_left(vols, row[5]) / len(vols), 3)
        d0 = sorted(tbl[k][3] for k in nb)
        f["oi0_pctile"] = round(bisect.bisect_left(d0, row[3]) / len(d0), 3)
        kmax = max(nb, key=lambda k: tbl[k][0])
        f["dist_maxoi"] = round(abs(K - kmax), 1)
        f["dist_maxoi_nq"] = round(abs(K - kmax) * ratio, 1)
    # concentration in +-5$ window
    win = [k for k in ks if abs(k - K) <= 5]
    s5 = sum(tbl[k][0] for k in win)
    f["oi_conc5"] = round(row[0] / s5, 4) if s5 > 0 else ""
    # 0dte composition
    f["oi_0dte_share"] = round(row[3] / row[0], 4) if row[0] > 0 else ""
    # max pain (nearest expiry)
    exps = sorted(expiries[d])
    if exps:
        e0 = exps[0]
        mp = mp_cache.get((d, e0))
        if mp is None:
            mp = max_pain(d, e0); mp_cache[(d, e0)] = mp
        if mp is not None:
            f["dist_maxpain"] = round(abs(K - mp), 1)
            f["dist_maxpain_nq"] = round(abs(K - mp) * ratio, 1)
    # GEX baseline
    f.update(gex_features(d, r["first_touch_utc"][:16], float(r["price"])))
    out.append(f)

cols = []
for f in out:
    for k in f:
        if k not in cols:
            cols.append(k)
with open(OUT, "w", newline="") as fo:
    w = csv.DictWriter(fo, fieldnames=cols)
    w.writeheader(); w.writerows(out)
print(f"wrote {len(out)} feature rows -> {OUT}")
from collections import Counter
print(Counter((f['date'][:4], f['cls']) for f in out))
