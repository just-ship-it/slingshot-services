#!/usr/bin/env python3
"""PILOTFISH Phase 5B — level-set geometry (PLAN.md).

Per-minute measurements on the knowable 15m LT level set (5-min sample grid):
  B2/B3: signed forward drift (60/120m, points) TOWARD the nearest level and
         toward the level centroid, by distance decile. Symmetric measurement,
         no directional prior. +ve = price moved toward the reference.
  B1/B4: cluster tightness (span of 5 levels, trailing-252d causal pctile):
         forward |drift| by tightness quartile, and 1m touch fade-payoff for
         clustered (neighbor within 0.15%) vs isolated levels.
Eras 2021-22 / 2023-24 / 2025-26.
"""
import csv
import statistics
import sys
from datetime import datetime
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, TF_MS

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
rows = load_minutes(include_2021=True)
N = len(rows)
row_ms = [int(datetime.fromisoformat(r['ts'] + ':00+00:00').timestamp() * 1000) for r in rows]

lts, lsets = [], []
for r in csv.DictReader(open(f'{BASE}/research/lt-extraction/output/nq_lt_15m_full_2021-2026.csv')):
    try:
        lv = sorted(float(r[f'level_{i}']) for i in range(1, 6))
    except ValueError:
        continue
    if any(x != x for x in lv):
        continue
    lts.append(int(r['unix_ms']) + TF_MS['15m'])
    lsets.append(lv)

ERAS = (('21-22', lambda d: d < '2023-01-01'),
        ('23-24', lambda d: '2023-01-01' <= d < '2025-01-01'),
        ('25-26', lambda d: d >= '2025-01-01'))

# span history for causal percentile
samples = []
li = 0
span_hist = []
for i in range(0, N - 130, 5):
    ms = row_ms[i]
    while li + 1 < len(lts) and lts[li + 1] <= ms:
        li += 1
    if lts[li] > ms or rows[i + 120]['sym'] != rows[i]['sym']:
        continue
    lv = lsets[li]
    c = rows[i]['c']
    span = lv[-1] - lv[0]
    if len(span_hist) >= 500:
        spct = sum(1 for s in span_hist[-20000:] if s <= span) / min(len(span_hist), 20000)
    else:
        spct = None
    span_hist.append(span)
    near = min(lv, key=lambda x: abs(x - c))
    cent = statistics.mean(lv)
    f60 = rows[i + 60]['c'] - c
    f120 = rows[i + 120]['c'] - c
    toward_near = (1 if near > c else -1)
    toward_cent = (1 if cent > c else -1)
    pos = 'above' if c > lv[-1] else 'below' if c < lv[0] else 'inside'
    samples.append((rows[i]['date'], abs(near - c), toward_near * f60,
                    toward_near * f120, toward_cent * f120, spct,
                    abs(f120), pos))

print(f'{len(samples)} samples\n=== B3 magnet-vs-repellent: drift TOWARD nearest level (pts, 120m) by distance decile ===')
for elab, sel in ERAS:
    evs = [s for s in samples if sel(s[0])]
    dists = sorted(s[1] for s in evs)
    cuts = [dists[int(q * len(dists))] for q in (0.1, 0.3, 0.5, 0.7, 0.9)]
    line = []
    for lo, hi, ql in ((0, cuts[0], 'D1'), (cuts[0], cuts[1], 'D2-3'), (cuts[1], cuts[2], 'D4-5'),
                       (cuts[2], cuts[3], 'D6-7'), (cuts[3], cuts[4], 'D8-9'), (cuts[4], 1e9, 'D10')):
        p = [s[3] for s in evs if lo <= s[1] < hi]
        line.append(f'{ql}:{statistics.mean(p):+.1f}({len(p)})' if len(p) > 100 else f'{ql}:--')
    print(f'  {elab}: ' + '  '.join(line))

print('\n=== B3b toward CENTROID (pts, 120m) + by price position ===')
for elab, sel in ERAS:
    evs = [s for s in samples if sel(s[0])]
    t = statistics.mean(s[4] for s in evs)
    parts = []
    for pos in ('above', 'below', 'inside'):
        p = [s[4] for s in evs if s[7] == pos]
        parts.append(f'{pos}:{statistics.mean(p):+.1f}({len(p)})' if len(p) > 100 else f'{pos}:--')
    print(f'  {elab}: all={t:+.1f}  ' + '  '.join(parts))

print('\n=== B1 tightness quartile vs forward |drift| (pts, 120m) ===')
for elab, sel in ERAS:
    evs = [s for s in samples if sel(s[0]) and s[5] is not None]
    line = []
    for lo, hi, ql in ((0, .25, 'tightest'), (.25, .5, 'Q2'), (.5, .75, 'Q3'), (.75, 1.01, 'widest')):
        p = [s[6] for s in evs if lo <= s[5] < hi]
        line.append(f'{ql}:{statistics.mean(p):.1f}({len(p)})' if len(p) > 100 else f'{ql}:--')
    print(f'  {elab}: ' + '  '.join(line))

# B4: 1m touches, clustered vs isolated
print('\n=== B4 touch fade-payoff (pts, 60m): clustered (neighbor<0.15%) vs isolated ===')
events = []
cooldown = {}
li = 0
for i in range(1, N - 70):
    ms = row_ms[i]
    while li + 1 < len(lts) and lts[li + 1] <= ms:
        li += 1
    if lts[li] > ms:
        continue
    r = rows[i]
    prevc = rows[i - 1]['c']
    if rows[i - 1]['sym'] != r['sym'] or rows[i + 60]['sym'] != r['sym']:
        continue
    lv = lsets[li]
    for L in lv:
        zone = L * 0.05 / 100
        key = round(L)
        if cooldown.get(key, -1) > i:
            continue
        if abs(prevc - L) > zone and r['l'] <= L + zone and r['h'] >= L - zone:
            cooldown[key] = i + 30
            sgn = -1 if prevc < L else 1
            neigh = min((abs(x - L) for x in lv if x != L), default=1e9)
            clustered = neigh <= L * 0.15 / 100
            events.append((r['date'], clustered, sgn * (rows[i + 60]['c'] - r['c'])))
for elab, sel in ERAS:
    evs = [e for e in events if sel(e[0])]
    cl = [e[2] for e in evs if e[1]]
    iso = [e[2] for e in evs if not e[1]]
    fmt = lambda v: f'{statistics.mean(v):+.1f}pt(n={len(v)})' if len(v) > 50 else f'--(n={len(v)})'
    print(f'  {elab}: clustered {fmt(cl)}   isolated {fmt(iso)}')
