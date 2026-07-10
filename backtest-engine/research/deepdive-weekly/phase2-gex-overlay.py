#!/usr/bin/env python3
"""Phase 2: overlay GEX state onto NQ LT-magnet races.

Joins each race (races/races_NQ.csv) to the latest GEX snapshot at or before
race time (as-of semantics; snapshots are lookahead-relabeled). Features:
  - regime (positive/negative), spot-vs-flip distance
  - gamma imbalance, total GEX
  - LT<->GEX confluence: distance from the race's up LT level to the nearest GEX
    resistance (and wall), down LT level to nearest GEX support (and wall)
  - GEX-level-in-the-way: a GEX level between spot and the LT target
Outputs races/races_NQ_gex.csv and prints drift-adjusted conditional excess.
"""

import bisect
import csv
import glob
import json
import math
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
GEXDIR = Path("/home/drew/projects/slingshot-services/backtest-engine/data/gex/nq")
ET = ZoneInfo("America/New_York")

# per-year drift/variance ratio from NQ weekly (see Phase 1)
RATIO = {"2023": 13.6, "2024": 5.1, "2025": 2.2, "2026": 13.3}
CONFL_PCT = 0.15  # LT level within 0.15% of a GEX level = confluent


def p_drift(dup, ddn, r):
    if abs(r) < 1e-9:
        return ddn / (dup + ddn)
    return (1 - math.exp(-2 * r * ddn)) / (1 - math.exp(-2 * r * (dup + ddn)))


# ---- load GEX snapshots ----
snaps = []
for fp in sorted(glob.glob(str(GEXDIR / "nq_gex_*.json"))):
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
print(f"GEX snapshots: {len(snaps)} ({datetime.utcfromtimestamp(snap_ts[0]):%Y-%m-%d} .. "
      f"{datetime.utcfromtimestamp(snap_ts[-1]):%Y-%m-%d})")

# ---- join races ----
races = [r for r in csv.DictReader(open(HERE / "races/races_NQ.csv"))
         if r["winner"] in ("up", "down")]
out_rows, no_gex = [], 0
for r in races:
    t = datetime.strptime(r["t_et"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=ET).timestamp()
    i = bisect.bisect_right(snap_ts, t) - 1
    if i < 0 or t - snap_ts[i] > 2700:  # need a snapshot within 45 min
        no_gex += 1
        continue
    s = snaps[i][1]
    spot = float(r["spot"])
    up, dn = float(r["up"]), float(r["dn"])
    flip = s.get("gamma_flip")
    res = [x for x in (s.get("resistance") or []) if x]
    sup = [x for x in (s.get("support") or []) if x]
    cw, pw = s.get("call_wall"), s.get("put_wall")

    def near_pct(level, cands):
        if not cands:
            return None
        return min(abs(level - c) / spot * 100 for c in cands)

    row = dict(r)
    row["p_adj"] = round(p_drift(float(r["d_up_pct"]) / 100, float(r["d_dn_pct"]) / 100,
                                 RATIO[r["t_et"][:4]]), 4)
    row["regime"] = s.get("regime", "")
    row["flip_dist_pct"] = round((spot - flip) / spot * 100, 3) if flip else None
    row["gamma_imb"] = round(s.get("gamma_imbalance") or 0, 3)
    row["total_gex"] = s.get("total_gex")
    row["up_conf_res"] = near_pct(up, res)
    row["dn_conf_sup"] = near_pct(dn, sup)
    row["up_is_wall"] = (cw is not None and abs(up - cw) / spot * 100 <= CONFL_PCT)
    row["dn_is_wall"] = (pw is not None and abs(dn - pw) / spot * 100 <= CONFL_PCT)
    row["gex_res_between"] = any(spot < x < up - spot * CONFL_PCT / 100 for x in res)
    row["gex_sup_between"] = any(dn + spot * CONFL_PCT / 100 < x < spot for x in sup)
    row["snap_age_min"] = round((t - snaps[i][0]) / 60)
    out_rows.append(row)

print(f"joined {len(out_rows)} races (no GEX snapshot for {no_gex})")
with open(HERE / "races/races_NQ_gex.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(out_rows[0].keys()))
    w.writeheader()
    w.writerows(out_rows)

# ---- analysis ----
def excess(sel):
    n = len(sel)
    if n < 80:
        return None
    act = sum(1 for r in sel if r["winner"] == "up") / n
    exp = sum(float(r["p_adj"]) for r in sel) / n
    var = sum(float(r["p_adj"]) * (1 - float(r["p_adj"])) for r in sel)
    return act, exp, (act * n - exp * n) / math.sqrt(var), n


def pts_edge(sel, side):
    tot = 0.0
    for r in sel:
        du, dd = float(r["d_up_pct"]), float(r["d_dn_pct"])
        win = (r["winner"] == "up") if side == "up" else (r["winner"] == "down")
        tgt, stp = (du, dd) if side == "up" else (dd, du)
        tot += tgt if win else -stp
    return tot / len(sel)


def show(label, sel, side=None):
    e = excess(sel)
    if not e:
        return
    act, exp, z, n = e
    pe = f"  pts={pts_edge(sel, side):+0.3f}%/race" if side else ""
    print(f"  {label:34s} n={n:5d}  up={act*100:5.1f}%  adjP={exp*100:5.1f}%  "
          f"exc={100*(act-exp):+5.1f}  z={z:+4.1f}{pe}")


R = out_rows
def f(r, k):
    v = r.get(k)
    return float(v) if v not in (None, "", "None") else None

print("\n== GEX regime ==")
for reg in ("positive", "negative"):
    show(f"regime={reg}", [r for r in R if r["regime"] == reg])
print("\n== regime x LT sentiment ==")
for reg in ("positive", "negative"):
    for s in ("BULLISH", "BEARISH"):
        sel = [r for r in R if r["regime"] == reg and r["sentiment"] == s]
        show(f"{reg[:3]} + {s}", sel, side="up" if s == "BULLISH" else "down")
print("\n== spot vs gamma flip ==")
for lbl, pred in [("far above flip (>0.5%)", lambda r: (f(r,"flip_dist_pct") or 0) > 0.5),
                  ("near flip (+-0.5%)", lambda r: abs(f(r,"flip_dist_pct") or 9) <= 0.5),
                  ("far below flip (<-0.5%)", lambda r: (f(r,"flip_dist_pct") or 0) < -0.5)]:
    show(lbl, [r for r in R if pred(r)])
print("\n== gamma imbalance ==")
for lbl, pred in [("imb>0.3", lambda r: f(r,"gamma_imb") > 0.3),
                  ("imb -0.3..0.3", lambda r: -0.3 <= f(r,"gamma_imb") <= 0.3),
                  ("imb<-0.3", lambda r: f(r,"gamma_imb") < -0.3)]:
    show(lbl, [r for r in R if pred(r)])
print("\n== LT<->GEX confluence of the target level ==")
for lbl, pred in [("up LT on GEX res (<=0.15%)", lambda r: (f(r,"up_conf_res") or 9) <= CONFL_PCT),
                  ("up LT NOT on GEX res (>0.5%)", lambda r: (f(r,"up_conf_res") or 0) > 0.5),
                  ("dn LT on GEX sup (<=0.15%)", lambda r: (f(r,"dn_conf_sup") or 9) <= CONFL_PCT),
                  ("dn LT NOT on GEX sup (>0.5%)", lambda r: (f(r,"dn_conf_sup") or 0) > 0.5),
                  ("up LT = call wall", lambda r: r["up_is_wall"] in (True, "True")),
                  ("dn LT = put wall", lambda r: r["dn_is_wall"] in (True, "True"))]:
    show(lbl, [r for r in R if pred(r)])
print("\n== GEX level in the way ==")
for lbl, pred in [("GEX res between spot and up LT", lambda r: r["gex_res_between"] in (True, "True")),
                  ("no GEX res in the way", lambda r: r["gex_res_between"] in (False, "False")),
                  ("GEX sup between spot and dn LT", lambda r: r["gex_sup_between"] in (True, "True")),
                  ("no GEX sup in the way", lambda r: r["gex_sup_between"] in (False, "False"))]:
    show(lbl, [r for r in R if pred(r)])
print("\n== best composite candidates (with year stability) ==")
combos = [
    ("BULL + pos regime + imb>0", lambda r: r["sentiment"]=="BULLISH" and r["regime"]=="positive" and f(r,"gamma_imb")>0, "up"),
    ("BULL + up LT on GEX res", lambda r: r["sentiment"]=="BULLISH" and (f(r,"up_conf_res") or 9)<=CONFL_PCT, "up"),
    ("BULL + no GEX res in way", lambda r: r["sentiment"]=="BULLISH" and r["gex_res_between"] in (False,"False"), "up"),
    ("BEAR + neg regime", lambda r: r["sentiment"]=="BEARISH" and r["regime"]=="negative", "down"),
    ("BEAR + neg + imb<0", lambda r: r["sentiment"]=="BEARISH" and r["regime"]=="negative" and f(r,"gamma_imb")<0, "down"),
]
for lbl, pred, side in combos:
    sel = [r for r in R if pred(r)]
    show(lbl, sel, side=side)
    for yr in ("2023", "2024", "2025", "2026"):
        ysel = [r for r in sel if r["t_et"].startswith(yr)]
        e = excess(ysel)
        if e:
            print(f"      {yr}: n={e[3]:4d} exc={100*(e[0]-e[1]):+5.1f} z={e[2]:+4.1f}")
