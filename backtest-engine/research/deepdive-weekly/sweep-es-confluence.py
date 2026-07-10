#!/usr/bin/env python3
"""ES confluence overlay (Phase 3, step 5) — conditioning only.

Computes the SAME clear-path composite on ES (races_ES15 + races_ES1H vs ES
GEX snapshots, identical rule/params to the NQ signal: no GEX barrier between
spot and target-LT, GEX shield between spot and stop-LT, CONFL_PCT=0.15,
snapshot <=45min old) and buckets the NQ v1 trade set by ES state at signal
time (latest ES sample within 2h): agrees / opposes / none / no-data.

Subset conditioning (no slot re-sequencing) — any promising bucket needs a
fresh 1s confirmation pass before adoption.
"""

import bisect
import collections
import csv
import glob
import json
import math
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
DATA = Path("/home/drew/projects/slingshot-services/backtest-engine/data")
ET = ZoneInfo("America/New_York")
CONFL_PCT = 0.15

print("loading ES GEX snapshots...")
snaps = []
for fp in sorted(glob.glob(str(DATA / "gex/es/es_gex_*.json"))):
    try:
        d = json.load(open(fp))
    except Exception:
        continue
    for s in d.get("data", []):
        try:
            ts = datetime.fromisoformat(s["timestamp"].replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        snaps.append((ts, s))
snaps.sort(key=lambda x: x[0])
snap_ts = [x[0] for x in snaps]


def es_states(races_file):
    """t_utc -> 'long'|'short'|'none' for each ES race sample with fresh GEX."""
    out = []
    for r in csv.DictReader(open(HERE / f"races/{races_file}")):
        t = datetime.strptime(r["t_et"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=ET).timestamp()
        i = bisect.bisect_right(snap_ts, t) - 1
        if i < 0 or t - snap_ts[i] > 2700:
            continue
        s = snaps[i][1]
        spot, up, dn = float(r["spot"]), float(r["up"]), float(r["dn"])
        res = [x for x in (s.get("resistance") or []) if x]
        sup = [x for x in (s.get("support") or []) if x]
        eps = spot * CONFL_PCT / 100
        res_between = any(spot < x < up - eps for x in res)
        sup_between = any(dn + eps < x < spot for x in sup)
        if not res_between and sup_between:
            st = "long"
        elif not sup_between and res_between:
            st = "short"
        else:
            st = "none"
        out.append((t, st))
    out.sort()
    return out


es15 = es_states("races_ES15.csv")
es1h = es_states("races_ES1H.csv")
print(f"ES states: 15m n={len(es15)}, 1h n={len(es1h)}")


def state_at(timeline, ts_list, t):
    i = bisect.bisect_right(ts_list, t) - 1
    if i < 0 or t - timeline[i][0] > 7200:
        return None
    return timeline[i][1]


es15_ts = [x[0] for x in es15]
es1h_ts = [x[0] for x in es1h]

rows = json.load(open(HERE / "results/overlay_enriched.json"))
for x in rows:
    t = datetime.strptime(x["t"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=ET).timestamp()
    for name, tl, tsl in (("es15", es15, es15_ts), ("es1h", es1h, es1h_ts)):
        st = state_at(tl, tsl, t)
        if st is None:
            x[name] = "nodata"
        elif st == "none":
            x[name] = "none"
        else:
            x[name] = "agree" if st == x["side"] else "oppose"


def stats(sub):
    n = len(sub)
    if n < 5:
        return None
    pts = [x["pts"] for x in sub]
    wins = [p for p in pts if p > 0]
    pos, neg = sum(wins), -sum(p for p in pts if p <= 0)
    cum = peak = dd = 0.0
    for p in pts:
        cum += p; peak = max(peak, cum); dd = max(dd, peak - cum)
    m = cum / n
    sd = math.sqrt(sum((p - m) ** 2 for p in pts) / (n - 1))
    return n, len(wins) / n * 100, pos / max(neg, .01), m, cum, dd, m / max(sd, .01) * math.sqrt(n)


def show(lab, sub, ind=2):
    s = stats(sub)
    print(f"{' '*ind}{lab:26s}" + ("   n<5" if not s else
          f" n={s[0]:4d} WR={s[1]:5.1f} PF={s[2]:5.2f} avg={s[3]:+6.1f} "
          f"tot={s[4]:+8.0f} DD={s[5]:5.0f} tShp={s[6]:5.1f}"))


for feat in ("es15", "es1h"):
    print(f"--- {feat} composite state at NQ signal ---")
    cov = [x for x in rows if x[feat] != "nodata"]
    show("[coverage control]", cov)
    for b in ("agree", "oppose", "none"):
        show(b, [x for x in cov if x[feat] == b])
    show("agree|none (excl oppose)", [x for x in cov if x[feat] != "oppose"])
    print("  by year (agree vs control):")
    for y in (2023, 2024, 2025):
        show(f"{y} agree", [x for x in cov if x["year"] == y and x[feat] == "agree"], 4)
        show(f"{y} control", [x for x in cov if x["year"] == y], 4)
    print()

# overlap of es15-agree with the wide-geometry sizing tilt + composition
ag = [x for x in rows if x["es15"] == "agree"]
wide = sum(1 for x in ag if x["stp_pct"] > 0.8)
print(f"es15-agree composition: n={len(ag)}, wide-geom(stop>0.8%)={wide}, "
      f"long={sum(1 for x in ag if x['side']=='long')}, "
      f"hours={sorted(collections.Counter(x['hour'] for x in ag).items())}")
show("agree & NOT wide-geom", [x for x in ag if x["stp_pct"] <= 0.8])
show("agree & wide-geom", [x for x in ag if x["stp_pct"] > 0.8])

json.dump(rows, open(HERE / "results/overlay_enriched.json", "w"))
print("es15/es1h tags persisted -> results/overlay_enriched.json")
