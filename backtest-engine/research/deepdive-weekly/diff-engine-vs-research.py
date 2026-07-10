#!/usr/bin/env python3
"""Diff engine lgpr trades vs research v1 (ts_8) trades for a given year.

Joins by signal hour (research signal t_et is on the hour; engine SignalTime
is the 1m candle in that hour). Buckets:
  both        - trade in both, compare exit type + pts
  research-only / engine-only - signal traded on one side only
Usage: diff-engine-vs-research.py <engine_trades.csv> <year>
"""

import csv
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
ET = ZoneInfo("America/New_York")

eng_csv = sys.argv[1]
year = sys.argv[2] if len(sys.argv) > 2 else ""  # "" = all years

# research trades (v1 = plain ts_8, has exit type x)
res = [t for t in json.load(open(HERE / "results/target_reject_trades.json"))["v1"]
       if t["t"].startswith(year)]
res_by_hour = {t["t"][:13]: t for t in res}

eng = []
for r in csv.DictReader(open(eng_csv)):
    raw = r["SignalTime"]
    if raw.isdigit():
        dt = datetime.fromtimestamp(int(raw) / 1000, tz=ET)
    else:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(ET)
    key = dt.strftime("%Y-%m-%d %H")
    if not key.startswith(year):
        continue
    eng.append(dict(key=key, side=r["Side"], pts=float(r["PointsPnL"]),
                    exit=r["ExitReason"], entry=float(r["EntryPrice"]),
                    stop=float(r["StopLoss"] or 0), tgt=float(r["TakeProfit"] or 0)))
eng_by_hour = {t["key"]: t for t in eng}

both = [(res_by_hour[k], eng_by_hour[k]) for k in res_by_hour if k in eng_by_hour]
r_only = [res_by_hour[k] for k in res_by_hour if k not in eng_by_hour]
e_only = [eng_by_hour[k] for k in eng_by_hour if k not in res_by_hour]

print(f"research n={len(res)}  engine n={len(eng)}  both={len(both)}  "
      f"research-only={len(r_only)}  engine-only={len(e_only)}")

XMAP = {"take_profit": "tgt", "stop_loss": "stop", "max_hold_time": "ts"}
same_x = sum(1 for r, e in both if XMAP.get(e["exit"], e["exit"]) == r["x"])
print(f"\nshared trades: exit type matches {same_x}/{len(both)}")
print("exit-type transitions (research -> engine):")
print("  ", Counter((r["x"], XMAP.get(e["exit"], e["exit"])) for r, e in both))
dpts = [e["pts"] - r["pts"] for r, e in both]
print(f"pts delta on shared: mean {sum(dpts)/max(len(dpts),1):+.2f}, "
      f"sum {sum(dpts):+.0f}")
big = sorted(zip(dpts, [r for r, e in both], [e for r, e in both]),
             key=lambda z: abs(z[0]), reverse=True)[:8]
for d, r, e in big:
    print(f"  {r['t']}  res {r['x']:4s} {r['pts']:+8.1f} | eng {e['exit']:13s} "
          f"{e['pts']:+8.1f}  d={d:+7.1f}")

print(f"\nresearch-only ({len(r_only)}): sum pts {sum(t['pts'] for t in r_only):+.0f}, "
      f"exits {Counter(t['x'] for t in r_only)}")
for t in sorted(r_only, key=lambda t: t["pts"])[:5]:
    print(f"  {t['t']} {t['x']:4s} {t['pts']:+8.1f}")
print(f"engine-only ({len(e_only)}): sum pts {sum(t['pts'] for t in e_only):+.0f}, "
      f"exits {Counter(t['exit'] for t in e_only)}")
