#!/usr/bin/env python3
"""Analyze LT magnet races: calibration vs fair-walk baseline + feature conditioning.

For each race, fair-walk P(up first) = d_dn/(d_up+d_dn). We test:
  1. Calibration: actual up-rate vs fair P, bucketed (are levels magnets at all,
     or does price just diffuse?)
  2. Conditioning: LT sentiment, hour of day, level rank, distance asymmetry —
     which features shift the outcome away from fair odds (candidate edge).
Edge readout is in EXCESS probability (actual - fair) and in expected points per
race if you'd target the predicted level with a stop at the opposite level.

NOTE: samples overlap (hourly samples racing to slow-moving levels), so nominal
p-values overstate significance. Median bars_to_touch tells the overlap factor;
treat n_eff ~ n / overlap. Signals are ranked by robustness across years.
Usage: analyze-races.py races/races_NQ.csv [more...]
"""

import csv
import math
import sys
from collections import defaultdict


def load(path):
    rows = []
    for r in csv.DictReader(open(path)):
        if r["winner"] not in ("up", "down"):
            continue
        r["p_fair"] = float(r["p_up_fair"])
        r["up_win"] = 1 if r["winner"] == "up" else 0
        r["d_up"] = float(r["d_up_pct"])
        r["d_dn"] = float(r["d_dn_pct"])
        r["tt"] = int(r["bars_to_touch"])
        r["year"] = r["t_et"][:4]
        rows.append(r)
    return rows


def excess(rows):
    n = len(rows)
    if n == 0:
        return None
    act = sum(r["up_win"] for r in rows) / n
    exp = sum(r["p_fair"] for r in rows) / n
    var = sum(r["p_fair"] * (1 - r["p_fair"]) for r in rows)
    z = (sum(r["up_win"] for r in rows) - sum(r["p_fair"] for r in rows)) / math.sqrt(var) if var else 0
    return act, exp, z, n


def show(label, rows, indent="  "):
    e = excess(rows)
    if not e:
        return
    act, exp, z, n = e
    print(f"{indent}{label:24s} n={n:6d}  up={act*100:5.1f}%  fair={exp*100:5.1f}%  "
          f"excess={100*(act-exp):+5.1f}pt  z={z:+.1f}")


def points_edge(rows, pick):
    """expected points per race if entering at spot targeting pick(r) in {'up','down'},
    exit at whichever level hits first (win: +d_target, loss: -d_other), in % of spot"""
    tot = 0.0
    for r in rows:
        if pick(r) == "up":
            tot += r["d_up"] if r["up_win"] else -r["d_dn"]
        else:
            tot += r["d_dn"] if not r["up_win"] else -r["d_up"]
    return tot / len(rows) if rows else 0.0


for path in sys.argv[1:]:
    rows = load(path)
    name = path.split("races_")[-1].replace(".csv", "")
    tts = sorted(r["tt"] for r in rows)
    print(f"\n{'='*70}\n{name}: {len(rows)} resolved races | median bars_to_touch="
          f"{tts[len(tts)//2]}  p90={tts[int(len(tts)*0.9)]}")

    print("\n-- calibration: fair-walk P(up) bucket vs actual up-rate --")
    for lo_b, hi_b in ((0, .3), (.3, .45), (.45, .55), (.55, .7), (.7, 1.01)):
        show(f"fairP {lo_b:.2f}-{hi_b:.2f}", [r for r in rows if lo_b <= r["p_fair"] < hi_b])

    print("\n-- LT sentiment --")
    for s in ("BULLISH", "BEARISH"):
        sel = [r for r in rows if r["sentiment"] == s]
        show(s, sel)
        if sel:
            pe_with = points_edge(sel, lambda r: "up" if s == "BULLISH" else "down")
            print(f"      -> trade WITH sentiment: {pe_with:+.3f}%/race")
    print("   by year (excess pt, WITH-sentiment %/race):")
    for yr in sorted({r['year'] for r in rows}):
        ysel = [r for r in rows if r["year"] == yr]
        parts = []
        for s in ("BULLISH", "BEARISH"):
            sel = [r for r in ysel if r["sentiment"] == s]
            e = excess(sel)
            if e:
                sign = 1 if s == "BULLISH" else -1
                parts.append(f"{s[:4]} n={e[3]} exc={100*(e[0]-e[1])*sign:+.1f} "
                             f"pe={points_edge(sel, lambda r: 'up' if s=='BULLISH' else 'down'):+.2f}%")
        print(f"     {yr}: " + " | ".join(parts))

    print("\n-- hour of day (ET) --")
    for h0, h1, lbl in ((0, 4, "00-03 overnight"), (4, 9, "04-08 premkt"),
                        (9, 12, "09-11 am-rth"), (12, 16, "12-15 pm-rth"),
                        (16, 24, "16-23 evening")):
        show(lbl, [r for r in rows if h0 <= int(r["hour_et"]) < h1])

    print("\n-- nearest-level rank (up_rank when fair<0.5 i.e. up is the FAR level) --")
    for rk in "12345":
        show(f"up_rank={rk}", [r for r in rows if r["up_rank"] == rk])
    for rk in "12345":
        show(f"dn_rank={rk}", [r for r in rows if r["dn_rank"] == rk])

    print("\n-- sentiment x fair-odds (does sentiment add beyond distance?) --")
    for s in ("BULLISH", "BEARISH"):
        for lo_b, hi_b in ((0, .45), (.45, .55), (.55, 1.01)):
            show(f"{s[:4]} fairP {lo_b:.2f}-{hi_b:.2f}",
                 [r for r in rows if r["sentiment"] == s and lo_b <= r["p_fair"] < hi_b])
