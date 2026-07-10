#!/usr/bin/env python3
"""Score DeepDiveStocks Weekly Chat reports against actual market outcomes.

Inputs:  extracted/batch-*.json (LLM-extracted calls/levels)
         weekly/{QQQ,SPY,NQ,ES}_weekly.csv (from build-weekly-ohlc.py)
Outputs: results/direction_scored.csv, results/levels_scored.csv, stdout summary.

Conventions:
- Target week for a report = its own week if sent Monday, else the next Monday.
- Direction outcome (primary) = target week open -> close return (actionable:
  enter Monday open after reading the Sunday report). Secondary = prior Friday
  close -> target Friday close.
- Level touch = level within [week low, week high] of the mapped series, scored
  over 1-week and 4-week horizons. Skill vs distance-matched base rates is
  computed from the full 2023-04..2026-06 weekly distribution.
"""

import csv
import glob
import json
import math
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).parent
RES = HERE / "results"
RES.mkdir(exist_ok=True)

# ---------- load weekly series ----------
def load_weekly(sym):
    rows = []
    with open(HERE / "weekly" / f"{sym}_weekly.csv") as f:
        for r in csv.DictReader(f):
            rows.append({
                "wk": date.fromisoformat(r["week_monday"]),
                "o": float(r["open"]), "h": float(r["high"]),
                "l": float(r["low"]), "c": float(r["close"]),
                "n": int(r["n_bars"]),
            })
    rows.sort(key=lambda x: x["wk"])
    return rows

SERIES = {s: load_weekly(s) for s in ("QQQ", "SPY", "NQ", "ES")}
IDX = {s: {r["wk"]: i for i, r in enumerate(rows)} for s, rows in SERIES.items()}

# last COMPLETE week per series (>=4000 bars for ETFs, >=5000 futures ~ full week)
def last_complete(sym, min_bars):
    for r in reversed(SERIES[sym]):
        if r["n"] >= min_bars:
            return r["wk"]
LAST_OK = {"QQQ": last_complete("QQQ", 3000), "SPY": last_complete("SPY", 3000),
           "NQ": last_complete("NQ", 5000), "ES": last_complete("ES", 5000)}

# ---------- load extracted reports ----------
reports = []
seen = set()
for fp in sorted(glob.glob(str(HERE / "extracted" / "batch-*.json"))):
    for obj in json.load(open(fp)):
        if obj["file"] in seen:
            continue
        seen.add(obj["file"])
        reports.append(obj)
reports.sort(key=lambda r: r["report_date"])

# drop the duplicate resend (2025-03-02 and 2025-03-03 are identical reports)
dup_dates = {"2025-03-03"}
reports = [r for r in reports if r["report_date"] not in dup_dates]

def target_monday(dstr):
    d = date.fromisoformat(dstr)
    return d if d.weekday() == 0 else d + timedelta(days=7 - d.weekday())

def week_row(sym, wk):
    i = IDX[sym].get(wk)
    return None if i is None else SERIES[sym][i]

def prev_close(sym, wk):
    i = IDX[sym].get(wk)
    if i is None or i == 0:
        return None
    return SERIES[sym][i - 1]["c"]

# ---------- direction scoring ----------
dir_rows = []
for r in reports:
    call = r["direction"]["call"]
    wk = target_monday(r["report_date"])
    row = {
        "report_date": r["report_date"], "week": wk.isoformat(),
        "call": call, "confidence": r["direction"]["confidence"],
        "summary": r["direction"]["summary"],
    }
    for sym in ("QQQ", "SPY"):
        w = week_row(sym, wk)
        pc = prev_close(sym, wk)
        scoreable = w is not None and pc is not None and wk <= LAST_OK[sym]
        if scoreable:
            row[f"{sym}_oc_ret"] = round((w["c"] / w["o"] - 1) * 100, 3)
            row[f"{sym}_ff_ret"] = round((w["c"] / pc - 1) * 100, 3)
        else:
            row[f"{sym}_oc_ret"] = row[f"{sym}_ff_ret"] = None
    dir_rows.append(row)

with open(RES / "direction_scored.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(dir_rows[0].keys()))
    w.writeheader()
    w.writerows(dir_rows)

# ---------- direction summary ----------
def binom_p_two_sided(k, n, p=0.5):
    """two-sided exact-ish binomial p-value via normal approx for n>=30, exact otherwise"""
    if n == 0:
        return 1.0
    if n < 200:
        from math import comb
        pk = [comb(n, i) * p**i * (1 - p)**(n - i) for i in range(n + 1)]
        obs = pk[k]
        return min(1.0, sum(x for x in pk if x <= obs + 1e-15))
    mu, sd = n * p, math.sqrt(n * p * (1 - p))
    z = abs(k - mu) / sd
    return math.erfc(z / math.sqrt(2))

def summarize(rows, ret_key, label, min_abs=0.0):
    out = []
    for subset_name, pred in [
        ("all directional", lambda r: r["call"] in ("bullish", "bearish")),
        ("bullish calls", lambda r: r["call"] == "bullish"),
        ("bearish calls", lambda r: r["call"] == "bearish"),
        ("high conf", lambda r: r["call"] in ("bullish", "bearish") and r["confidence"] == "high"),
        ("med conf", lambda r: r["call"] in ("bullish", "bearish") and r["confidence"] == "medium"),
        ("low conf", lambda r: r["call"] in ("bullish", "bearish") and r["confidence"] == "low"),
    ]:
        sel = [r for r in rows if pred(r) and r[ret_key] is not None
               and abs(r[ret_key]) >= min_abs]
        if not sel:
            continue
        hits = sum(1 for r in sel
                   if (r["call"] == "bullish") == (r[ret_key] > 0) and r[ret_key] != 0)
        n = len(sel)
        up = sum(1 for r in sel if r[ret_key] > 0)
        out.append(f"  {subset_name:16s} n={n:3d}  acc={hits/n*100:5.1f}%  "
                   f"(up-weeks base={up/n*100:4.1f}%)  p_vs_50={binom_p_two_sided(hits,n):.3f}")
        # avg return in called direction
        avg = sum((r[ret_key] if r["call"] == "bullish" else -r[ret_key]) for r in sel) / n
        out[-1] += f"  avg_ret_in_call_dir={avg:+.2f}%"
    print(f"\n=== DIRECTION vs {label} (|ret|>={min_abs}%) ===")
    print("\n".join(out))

for min_abs in (0.0, 0.5):
    summarize(dir_rows, "QQQ_oc_ret", "QQQ open->close", min_abs)
summarize(dir_rows, "QQQ_ff_ret", "QQQ fri->fri", 0.0)
summarize(dir_rows, "SPY_oc_ret", "SPY open->close", 0.0)

# by year
print("\n=== DIRECTION by year (QQQ open->close) ===")
for yr in ("2023", "2024", "2025", "2026"):
    sel = [r for r in dir_rows if r["report_date"].startswith(yr)
           and r["call"] in ("bullish", "bearish") and r["QQQ_oc_ret"] is not None]
    if not sel:
        continue
    hits = sum(1 for r in sel if (r["call"] == "bullish") == (r["QQQ_oc_ret"] > 0))
    up = sum(1 for r in sel if r["QQQ_oc_ret"] > 0)
    bear = sum(1 for r in sel if r["call"] == "bearish")
    print(f"  {yr}: n={len(sel):3d} acc={hits/len(sel)*100:5.1f}% up-base={up/len(sel)*100:4.1f}% bearish_calls={bear}")

# call vs outcome matrix
print("\n=== call vs QQQ outcome matrix (open->close) ===")
for call in ("bullish", "bearish", "neutral", "mixed"):
    sel = [r for r in dir_rows if r["call"] == call and r["QQQ_oc_ret"] is not None]
    if not sel:
        continue
    up = sum(1 for r in sel if r["QQQ_oc_ret"] > 0)
    avg = sum(r["QQQ_oc_ret"] for r in sel) / len(sel)
    print(f"  {call:8s} n={len(sel):3d}  week_up={up/len(sel)*100:5.1f}%  avg_week_ret={avg:+.2f}%")

# ---------- level scoring ----------
def map_series(level, wk):
    """pick series + validate price space; returns (sym, factor) so level/factor is in series space"""
    inst = level["instrument"]
    cands = {"SPY": [("SPY", 1.0)], "QQQ": [("QQQ", 1.0)],
             "SPX_ES": [("ES", 1.0), ("SPY", 10.0)],
             "NDX_NQ": [("NQ", 1.0), ("QQQ", 41.0)],
             "unknown": [("SPY", 1.0), ("QQQ", 1.0), ("ES", 1.0), ("NQ", 1.0)]}
    for sym, factor in cands.get(inst, []):
        pc = prev_close(sym, wk)
        if pc is None:
            continue
        if abs(level["value"] / factor / pc - 1) <= 0.12:
            return sym, factor
    return None, None

lvl_rows = []
for r in reports:
    wk = target_monday(r["report_date"])
    for lv in r.get("levels", []):
        sym, factor = map_series(lv, wk)
        row = {"report_date": r["report_date"], "week": wk.isoformat(),
               "value": lv["value"], "instrument": lv["instrument"],
               "role": lv["role"], "side": lv.get("side"), "series": sym,
               "quote": lv.get("quote", "")[:80]}
        if sym is None:
            row.update(dist_pct=None, hit_1w=None, hit_4w=None, respected=None)
            lvl_rows.append(row)
            continue
        v = lv["value"] / factor
        pc = prev_close(sym, wk)
        dist = (v / pc - 1) * 100
        row["dist_pct"] = round(dist, 2)
        # horizons
        def touched(nweeks):
            i0 = IDX[sym].get(wk)
            if i0 is None:
                return None
            hi = lo = None
            for i in range(i0, min(i0 + nweeks, len(SERIES[sym]))):
                w = SERIES[sym][i]
                if w["wk"] > LAST_OK[sym]:
                    break
                hi = w["h"] if hi is None else max(hi, w["h"])
                lo = w["l"] if lo is None else min(lo, w["l"])
            if hi is None:
                return None
            return lo <= v <= hi or (dist > 0 and hi >= v) or (dist < 0 and lo <= v)
        row["hit_1w"] = touched(1)
        row["hit_4w"] = touched(4)
        # ceiling/floor respected within week: touched near level but weekly close on the near side
        w = week_row(sym, wk)
        respected = None
        if w and wk <= LAST_OK[sym] and lv["role"] in ("ceiling", "resistance", "floor", "support"):
            near = (w["h"] >= v * 0.997) if dist > 0 else (w["l"] <= v * 1.003)
            if near:
                respected = w["c"] < v if dist > 0 else w["c"] > v
        row["respected"] = respected
        lvl_rows.append(row)

with open(RES / "levels_scored.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(lvl_rows[0].keys()) if lvl_rows else ["none"])
    w.writeheader()
    w.writerows(lvl_rows)

# baseline: P(touch) as function of distance, from all weeks of each series
def base_rate(sym, dist_pct, nweeks):
    """empirical P(price reaches dist_pct from prev close within nweeks)"""
    rows = SERIES[sym]
    n = hit = 0
    for i in range(1, len(rows) - nweeks + 1):
        pc = rows[i - 1]["c"]
        target = pc * (1 + dist_pct / 100)
        hi = max(r["h"] for r in rows[i:i + nweeks])
        lo = min(r["l"] for r in rows[i:i + nweeks])
        n += 1
        hit += (hi >= target) if dist_pct > 0 else (lo <= target)
    return hit / n if n else None

print("\n=== LEVELS ===")
valid = [x for x in lvl_rows if x["series"] and x["hit_1w"] is not None]
print(f"levels extracted={len(lvl_rows)}, mapped+scoreable={len(valid)}")
for horizon, key in (("1w", "hit_1w"), ("4w", "hit_4w")):
    sel = [x for x in valid if x[key] is not None]
    if not sel:
        continue
    hits = sum(1 for x in sel if x[key])
    exp = sum(base_rate(x["series"], x["dist_pct"], 1 if horizon == "1w" else 4) for x in sel) / len(sel)
    print(f"  {horizon}: n={len(sel)} hit={hits/len(sel)*100:.1f}%  distance-matched base={exp*100:.1f}%")

# by distance bucket (1w)
print("  --- by |distance| bucket (1w) ---")
for lo_b, hi_b in ((0, 1), (1, 2), (2, 4), (4, 100)):
    sel = [x for x in valid if x["hit_1w"] is not None and lo_b <= abs(x["dist_pct"]) < hi_b]
    if not sel:
        continue
    hits = sum(1 for x in sel if x["hit_1w"])
    exp = sum(base_rate(x["series"], x["dist_pct"], 1) for x in sel) / len(sel)
    print(f"    |d| {lo_b}-{hi_b}%: n={len(sel):3d} hit={hits/len(sel)*100:5.1f}% base={exp*100:5.1f}%")

resp = [x for x in lvl_rows if x["respected"] is not None]
if resp:
    ok = sum(1 for x in resp if x["respected"])
    print(f"  ceilings/floors reached-and-respected: {ok}/{len(resp)} = {ok/len(resp)*100:.0f}%")

print("\nWrote results/direction_scored.csv and results/levels_scored.csv")
