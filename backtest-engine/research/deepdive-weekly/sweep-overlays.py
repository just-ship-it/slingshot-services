#!/usr/bin/env python3
"""Overlay round (Phase 3, step 3) — condition the v1 trade set on signal-time features.

Trade set: ts_8h variant from results/be_ts_trades.json (LT-GEX path race v1,
632 trades, 1s-honest). Each trade joins back to its signal (t field == t_et).

Features (all point-in-time at signal timestamp; NO outcome leakage):
  races_NQ_gex.csv  : sentiment, gamma regime, flip_dist_pct, gamma_imb,
                      up/dn rank, wall flags, snap_age_min   (full coverage)
  direction_scored  : DDS weekly call (bearish = vol flag)   (2023-05+)
  qqq daily IV      : prior-day dte0 avg IV / skew / term_slope, ivPct
                      (trailing-252 pct), ivChg5             (walls 2026-01-28)
  qqq 1m IV         : intraday IV + put-call skew at signal  (2025-01+)
  LS state          : last state at signal, side alignment   (2025-01+)
  geometry          : target/stop distance pct, defined RR, side, hour, dow

NOTE: filters shown here are subset-conditioning (no slot re-sequencing).
A winning filter must be confirmed with a fresh 1s pass before promotion.
"""

import bisect
import csv
import json
import math
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).parent
DATA = Path("/home/drew/projects/slingshot-services/backtest-engine/data")
LTX = Path("/home/drew/projects/slingshot-services/backtest-engine/research/lt-extraction/output")

VARIANT = "ts_8"

# ---------- load trades + signals ----------
trades = json.load(open(HERE / "results/be_ts_trades.json"))[VARIANT]
paths = {p["t_et"]: p for p in json.load(open(HERE / "results/signal_paths.json"))}
races = {r["t_et"]: r for r in csv.DictReader(open(HERE / "races/races_NQ_gex.csv"))}

# ---------- DDS weekly calls ----------
dds = {}  # monday date -> call
for r in csv.DictReader(open(HERE / "results/direction_scored.csv")):
    dds[r["week"]] = r["call"]

def dds_call(d):  # d = date of trade (ET)
    monday = d - timedelta(days=d.weekday())
    return dds.get(monday.strftime("%Y-%m-%d"))

# ---------- daily IV (point-in-time: prior row strictly before trade date) ----------
div_rows = []
for r in csv.DictReader(open(DATA / "iv/qqq/qqq_short_dte_iv_daily.csv")):
    try:
        div_rows.append((r["timestamp"], float(r["dte0_avg_iv"]), float(r["dte0_skew"]),
                         float(r["term_slope"])))
    except ValueError:
        continue
div_rows.sort()
div_dates = [r[0] for r in div_rows]

def daily_iv(d):
    i = bisect.bisect_left(div_dates, d.strftime("%Y-%m-%d")) - 1
    if i < 20:
        return None
    iv, skew, slope = div_rows[i][1], div_rows[i][2], div_rows[i][3]
    lo = max(0, i - 251)
    window = sorted(r[1] for r in div_rows[lo:i + 1])
    pct = bisect.bisect_left(window, iv) / max(len(window) - 1, 1)
    chg = iv / div_rows[i - 5][1] - 1 if i >= 5 and div_rows[i - 5][1] > 0 else None
    return dict(iv=iv, skew=skew, slope=slope, ivpct=pct, ivchg=chg)

DAILY_IV_WALL = div_dates[-1]  # pass-through after this

# ---------- intraday 1m IV ----------
iv1m = []
for r in csv.DictReader(open(DATA / "iv/qqq/qqq_atm_iv_1m.csv")):
    try:
        ts = datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00")).timestamp()
        iv1m.append((ts, float(r["iv"]), float(r["put_iv"]) - float(r["call_iv"])))
    except (ValueError, KeyError):
        continue
iv1m.sort()
iv1m_ts = [x[0] for x in iv1m]

def intraday_iv(t_utc):
    i = bisect.bisect_right(iv1m_ts, t_utc) - 1
    if i < 0 or t_utc - iv1m[i][0] > 3600:
        return None
    return dict(iv=iv1m[i][1], skew=iv1m[i][2])

# ---------- LS state ----------
ls = []
for fp in ("nq_ls_1m_raw.csv", "nq_ls_1m_new.csv"):
    for r in csv.DictReader(open(LTX / fp)):
        try:
            ls.append((int(r["unix_ms"]) / 1000, int(r["state"])))
        except ValueError:
            continue
ls.sort()
ls_ts = [x[0] for x in ls]

def ls_state(t_utc):
    i = bisect.bisect_right(ls_ts, t_utc) - 1
    if i < 0 or t_utc > ls_ts[-1] + 86400:
        return None
    return ls[i][1]

# ---------- enrich ----------
rows = []
for tr in trades:
    p = paths.get(tr["t"])
    r = races.get(tr["t"])
    if not p or not r:
        continue
    dt = datetime.strptime(tr["t"], "%Y-%m-%d %H:%M:%S")
    side, spot = p["side"], p["spot"]
    tgt, stp = (p["up"], p["dn"]) if side == "long" else (p["dn"], p["up"])
    row = dict(
        t=tr["t"], pts=tr["pts"], side=side, year=dt.year, hour=dt.hour,
        dow=dt.weekday(),
        tgt_pct=abs(tgt - spot) / spot * 100, stp_pct=abs(stp - spot) / spot * 100,
        sentiment=r["sentiment"], regime=r["regime"],
        flip_dist=float(r["flip_dist_pct"]) if r["flip_dist_pct"] else None,
        gamma_imb=float(r["gamma_imb"]) if r["gamma_imb"] else None,
        up_rank=int(r["up_rank"]), dn_rank=int(r["dn_rank"]),
        tgt_is_wall=(r["up_is_wall"] if side == "long" else r["dn_is_wall"]) == "True",
        stp_is_wall=(r["dn_is_wall"] if side == "long" else r["up_is_wall"]) == "True",
        snap_age=float(r["snap_age_min"]) if r["snap_age_min"] else None,
        dds=dds_call(dt.date()),
    )
    row["rr"] = row["tgt_pct"] / row["stp_pct"] if row["stp_pct"] else None
    div = daily_iv(dt.date())
    if div:
        row.update(div_iv=div["iv"], div_skew=div["skew"], div_slope=div["slope"],
                   ivpct=div["ivpct"], ivchg=div["ivchg"])
    ii = intraday_iv(p["t_utc"])
    if ii:
        row.update(iiv=ii["iv"], iskew=ii["skew"])
    st = ls_state(p["t_utc"])
    if st is not None:
        row["ls"] = st
        row["ls_align"] = (st == 1) == (side == "long")
    rows.append(row)

print(f"joined {len(rows)}/{len(trades)} trades\n")

# ---------- stats ----------
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
    sd = math.sqrt(sum((p - m) ** 2 for p in pts) / (n - 1)) if n > 1 else 1
    return dict(n=n, wr=len(wins) / n * 100, pf=pos / max(neg, .01), avg=m,
                tot=cum, dd=dd, shp=m / max(sd, .01) * math.sqrt(n))

def show(label, sub, indent=2):
    s = stats(sub)
    if not s:
        print(f"{' '*indent}{label:34s}   n<5")
        return
    print(f"{' '*indent}{label:34s} n={s['n']:4d} WR={s['wr']:5.1f} PF={s['pf']:5.2f} "
          f"avg={s['avg']:+6.1f} tot={s['tot']:+8.0f} maxDD={s['dd']:5.0f} tShp={s['shp']:5.1f}")

def block(title, sub_all, buckets):
    print(f"--- {title} ---")
    show("[coverage control]", sub_all)
    for lab, pred in buckets:
        show(lab, [x for x in sub_all if pred(x)])
    print()

ALL = rows

block("baseline / side / year", ALL, [
    ("long", lambda x: x["side"] == "long"),
    ("short", lambda x: x["side"] == "short"),
    *[(str(y), lambda x, y=y: x["year"] == y) for y in (2023, 2024, 2025, 2026)],
])

block("LT sentiment", ALL, [
    ("BULLISH", lambda x: x["sentiment"] == "BULLISH"),
    ("BEARISH", lambda x: x["sentiment"] == "BEARISH"),
    ("NEUTRAL", lambda x: x["sentiment"] not in ("BULLISH", "BEARISH")),
    ("sent aligns side", lambda x: (x["sentiment"] == "BULLISH") == (x["side"] == "long")
        and x["sentiment"] in ("BULLISH", "BEARISH")),
])

block("gamma regime / flip distance", ALL, [
    ("positive", lambda x: x["regime"] == "positive"),
    ("negative", lambda x: x["regime"] == "negative"),
    ("neutral", lambda x: x["regime"] == "neutral"),
    ("|flip|<0.5%", lambda x: x["flip_dist"] is not None and abs(x["flip_dist"]) < 0.5),
    ("|flip|>=0.5%", lambda x: x["flip_dist"] is not None and abs(x["flip_dist"]) >= 0.5),
])

block("wall flags / LT ranks", ALL, [
    ("target is wall", lambda x: x["tgt_is_wall"]),
    ("target not wall", lambda x: not x["tgt_is_wall"]),
    ("stop is wall", lambda x: x["stp_is_wall"]),
    ("tgt rank 1-2", lambda x: (x["up_rank"] if x["side"] == "long" else x["dn_rank"]) <= 2),
    ("tgt rank 3+", lambda x: (x["up_rank"] if x["side"] == "long" else x["dn_rank"]) >= 3),
])

block("snapshot age", ALL, [
    ("age<=5m", lambda x: x["snap_age"] is not None and x["snap_age"] <= 5),
    ("age>15m", lambda x: x["snap_age"] is not None and x["snap_age"] > 15),
])

block("geometry (defined RR)", ALL, [
    ("rr<0.25", lambda x: x["rr"] is not None and x["rr"] < 0.25),
    ("rr 0.25-0.6", lambda x: x["rr"] is not None and 0.25 <= x["rr"] < 0.6),
    ("rr>=0.6", lambda x: x["rr"] is not None and x["rr"] >= 0.6),
    ("tgt<0.15%", lambda x: x["tgt_pct"] < 0.15),
    ("tgt>=0.3%", lambda x: x["tgt_pct"] >= 0.3),
    ("stop>0.8%", lambda x: x["stp_pct"] > 0.8),
])

DDS = [x for x in ALL if x["dds"]]
block("DDS weekly call (vol flag)", DDS, [
    ("bullish week", lambda x: x["dds"] == "bullish"),
    ("bearish week", lambda x: x["dds"] == "bearish"),
    ("neutral week", lambda x: x["dds"] not in ("bullish", "bearish")),
])

DIV = [x for x in ALL if "ivpct" in x]
block(f"daily IV (walls {DAILY_IV_WALL})", DIV, [
    ("ivPct<0.33", lambda x: x["ivpct"] < 0.33),
    ("ivPct 0.33-0.67", lambda x: 0.33 <= x["ivpct"] < 0.67),
    ("ivPct>=0.67", lambda x: x["ivpct"] >= 0.67),
    ("ivChg>0 (rising)", lambda x: x.get("ivchg") is not None and x["ivchg"] > 0),
    ("ivChg<=0 (falling)", lambda x: x.get("ivchg") is not None and x["ivchg"] <= 0),
    ("slope<0 (backwd)", lambda x: x["div_slope"] < 0),
    ("slope>=0", lambda x: x["div_slope"] >= 0),
    ("dte0 skew>0 (put-rich)", lambda x: x["div_skew"] > 0),
    ("dte0 skew<=0", lambda x: x["div_skew"] <= 0),
])

IIV = [x for x in ALL if "iskew" in x]
block("intraday 1m IV (2025+)", IIV, [
    ("iv skew>0.02 (put-rich)", lambda x: x["iskew"] > 0.02),
    ("iv skew 0-0.02", lambda x: 0 <= x["iskew"] <= 0.02),
    ("iv skew<0 (call-rich)", lambda x: x["iskew"] < 0),
    ("iiv>=0.25", lambda x: x["iiv"] >= 0.25),
    ("iiv<0.25", lambda x: x["iiv"] < 0.25),
])

LS = [x for x in ALL if "ls" in x]
block("LS state (2025+)", LS, [
    ("LS aligns side", lambda x: x["ls_align"]),
    ("LS opposes side", lambda x: not x["ls_align"]),
    ("LS=1 (bull)", lambda x: x["ls"] == 1),
    ("LS=0 (bear)", lambda x: x["ls"] == 0),
])

json.dump(rows, open(HERE / "results/overlay_enriched.json", "w"))
print(f"enriched rows -> results/overlay_enriched.json")
