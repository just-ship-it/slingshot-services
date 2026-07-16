#!/usr/bin/env python3
"""PILOTFISH M2 — multi-TF LS state matrix redux (PLAN.md Phase 3b).

Knowability-shifted states (3m/5m/15m/1h) sampled on a 5-min grid, 2021+.
Forward 30/60m drift, long-signed. Pre-registered: full alignment carries
drift; the 2025-26 long-side pattern replicates in 2021-23.
Splits: 2021-23 discovery / 2024 validation / 2025-26 final.
"""
import statistics
import sys
from datetime import datetime
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, LsSeries, stat_line

series = {tf: LsSeries(tf) for tf in ('3m', '5m', '15m', '1h')}
rows = load_minutes()
samples = []
for i in range(0, len(rows) - 70, 5):
    r = rows[i]
    if rows[i + 60]['sym'] != r['sym']:
        continue
    ms = int(datetime.fromisoformat(r['ts'] + ':00+00:00').timestamp() * 1000)
    st = tuple(series[tf].state_at(ms) for tf in ('3m', '5m', '15m', '1h'))
    if None in st:
        continue
    samples.append((r['date'], st,
                    rows[i + 30]['c'] - r['c'],
                    rows[i + 60]['c'] - r['c']))

print(f'{len(samples)} samples\n')
SPLITS = (('DISCOVERY 2021-23', lambda d: d < '2024-01-01'),
          ('VALIDATION 2024', lambda d: '2024-01-01' <= d < '2025-01-01'),
          ('FINAL 2025-26', lambda d: d >= '2025-01-01'))
for label, sel in SPLITS:
    evs = [s for s in samples if sel(s[0])]
    print(f'========== {label} ({len(evs)}) ==========')
    align1 = [s for s in evs if s[1] == (1, 1, 1, 1)]
    align0 = [s for s in evs if s[1] == (0, 0, 0, 0)]
    stat_line('  ALL-ALIGNED bull (1111) long 60m', [s[3] for s in align1])
    stat_line('  ALL-ALIGNED bear (0000) short 60m', [-s[3] for s in align0])
    # fast-vs-slow conflict: 3m+5m against 15m+1h
    conf_up = [s for s in evs if s[1][:2] == (0, 0) and s[1][2:] == (1, 1)]
    conf_dn = [s for s in evs if s[1][:2] == (1, 1) and s[1][2:] == (0, 0)]
    stat_line('  conflict fast-bear/slow-bull: LONG 60m (pullback)', [s[3] for s in conf_up])
    stat_line('  conflict fast-bull/slow-bear: SHORT 60m (pullback)', [-s[3] for s in conf_dn])
    stat_line('  baseline all samples long 60m', [s[3] for s in evs])
    print()
