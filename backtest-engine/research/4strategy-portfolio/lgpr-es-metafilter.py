#!/usr/bin/env python3
"""v1-ES-grade clear-path state as a higher-order directional filter on the book.

Joint state = NQ clear-path composite signal (signal_paths.json) where the
ES-15m composite agrees (es15_clearpath_states.csv), active for a lookback
window (default 8h). Each gold-standard book trade is bucketed
aligned/opposed/none by side vs the active state at its entryTime.

Run from backtest-engine/. Findings 2026-07-08 (8h lookback, all overlap 2025):
  gex-lt-3m      aligned n=40 PF 3.30 +$29.6k | opposed n=22 PF 0.79 -$3.3k
  gex-level-fade aligned n=41 PF 2.96 +$23.2k | opposed n=42 PF 0.92 -$1.3k
  lstb           aligned 2.14 vs none 1.58 (mild) | gfi n too small
Candidate veto/size-up for the portfolio-filter line; single-year, small
opposed-n, ~15% time coverage — needs the standard verification discipline.
"""
import bisect, csv, json, sys
from collections import defaultdict
from datetime import datetime, timezone

LOOKBACK_H = float(sys.argv[1]) if len(sys.argv) > 1 else 8

paths = json.load(open('research/deepdive-weekly/results/signal_paths.json'))
es = []
for r in csv.reader(open('data/features/es15_clearpath_states.csv')):
    if r[0] == 'unix_ms': continue
    es.append((int(r[0]), r[2]))
es.sort(); es_ts = [x[0] for x in es]

def es_state(ms):
    i = bisect.bisect_right(es_ts, ms) - 1
    return es[i][1] if i >= 0 and ms - es[i][0] <= 7200_000 else None

joint = sorted((int(p['t_utc']*1000), p['side']) for p in paths
               if es_state(int(p['t_utc']*1000)) == p['side'])
joint_ts = [x[0] for x in joint]
print(f"joint (v1-ES-grade) signals: {len(joint)}, lookback {LOOKBACK_H}h")

def joint_state(ms):
    i = bisect.bisect_right(joint_ts, ms) - 1
    return joint[i][1] if i >= 0 and ms - joint[i][0] <= LOOKBACK_H*3600_000 else None

BOOK = [('lstb','data/gold-standard/ls-flip-trigger-bar-v3.json'),
        ('gex-lt-3m','data/gold-standard/gex-lt-3m-crossover-v3.json'),
        ('gex-flip-ivpct','data/gold-standard/gex-flip-ivpct-v2.json'),
        ('gex-level-fade','data/gold-standard/gex-level-fade-v2.json')]

def norm(s):
    s = str(s).lower()
    return 'long' if s in ('long','buy') else 'short'

for key, f in BOOK:
    raw = json.load(open(f))
    buckets = defaultdict(list)
    for t in raw['trades']:
        if t.get('status') != 'completed' or t.get('entryTime') is None: continue
        st = joint_state(t['entryTime'])
        b = 'none' if st is None else ('aligned' if st == norm(t.get('side')) else 'opposed')
        buckets[b].append(t['netPnL'])
    print(f"  {key}")
    for b in ('aligned','opposed','none'):
        pnl = buckets[b]
        if not pnl:
            print(f"    {b:8s} n=0"); continue
        pos = sum(p for p in pnl if p>0); neg = -sum(p for p in pnl if p<=0)
        wr = sum(1 for p in pnl if p>0)/len(pnl)*100
        print(f"    {b:8s} n={len(pnl):5d} WR={wr:5.1f} PF={pos/max(neg,1):5.2f} "
              f"tot=${sum(pnl):+10,.0f} avg=${sum(pnl)/len(pnl):+7.0f}")
