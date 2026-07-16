#!/usr/bin/env python3
"""PILOTFISH Phase 7 — Price Trigger study PT1/PT2/PT3 (PLAN.md)."""
import bisect
import csv
import statistics
import sys
from datetime import datetime
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, stat_line, LsSeries

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
rows = load_minutes(include_2021=True)
N = len(rows)
row_ms = [int(datetime.fromisoformat(r['ts'] + ':00+00:00').timestamp() * 1000) for r in rows]

pt_ts, pt = [], {k: [] for k in ('p5', 'ph', 'pd', 'pw', 'pm')}
for r in csv.DictReader(open(f'{BASE}/research/lt-extraction/output/nq_pt_15m_raw.csv')):
    pt_ts.append(int(r['unix_ms']) + 15 * 60000)   # knowable-from
    for k in pt:
        v = r[k]
        pt[k].append(float(v) if v != 'NaN' else None)

ERAS = (('21-22', lambda d: d < '2023-01-01'),
        ('23-24', lambda d: '2023-01-01' <= d < '2025-01-01'),
        ('25-26', lambda d: d >= '2025-01-01'))


def pt_at(i_row):
    j = bisect.bisect_right(pt_ts, row_ms[i_row]) - 1
    return j


# ---------- PT1: touch/rejection ----------
def touch_study(key, shift):
    events = []
    cooldown = 0
    j = -1
    lastL = None
    for i in range(1, N - 130):
        while j + 1 < len(pt_ts) and pt_ts[j + 1] <= row_ms[i]:
            j += 1
        if j < 0:
            continue
        L0 = pt[key][j]
        if L0 is None:
            continue
        L = L0 + shift
        r = rows[i]
        prevc = rows[i - 1]['c']
        if rows[i - 1]['sym'] != r['sym'] or rows[i + 120]['sym'] != r['sym']:
            continue
        zone = L * 0.05 / 100
        if lastL is not None and abs(L - lastL) > zone:
            cooldown = 0        # level moved -> fresh episode allowed
        lastL = L
        if i < cooldown:
            continue
        if abs(prevc - L) > zone and r['l'] <= L + zone and r['h'] >= L - zone:
            cooldown = i + 30
            side = 1 if prevc > L else -1   # 1 = support touch, -1 = resistance
            sgn = side                       # fade payoff: back toward approach side
            events.append((r['date'], side,
                           sgn * (rows[i + 60]['c'] - r['c']),
                           sgn * (rows[i + 120]['c'] - r['c'])))
    return events


print('########## PT1 touch/rejection (fade payoff, points) ##########')
for key in ('pd', 'pw', 'pm'):
    real = touch_study(key, 0.0)
    plac = touch_study(key, 37.0)
    print(f'--- {key.upper()} ({len(real)} touches, {len(plac)} placebo) ---')
    for elab, sel in ERAS:
        re = [e for e in real if sel(e[0])]
        pe = [e[3] for e in plac if sel(e[0])]
        pm_ = statistics.mean(pe) if len(pe) >= 25 else float('nan')
        sup = [e[3] for e in re if e[1] == 1]
        res = [e[3] for e in re if e[1] == -1]
        f = lambda v: f'{statistics.mean(v):+.1f}({len(v)})' if len(v) >= 25 else f'--({len(v)})'
        print(f'  {elab}: support {f(sup)}  resistance {f(res)}  placebo {pm_:+.1f}')

# ---------- PT2: crossover rule ----------
print('\n########## PT2 crossovers (continuation 120m, points) ##########')
ls1h = LsSeries('1h')
ls1d = LsSeries('1d')
for lo_k, hi_k, ls in (('ph', 'pd', ls1h), ('pd', 'pw', ls1d)):
    events = []
    j = -1
    state = 0
    for i in range(1, N - 130):
        while j + 1 < len(pt_ts) and pt_ts[j + 1] <= row_ms[i]:
            j += 1
        if j < 0:
            continue
        lo_v, hi_v = pt[lo_k][j], pt[hi_k][j]
        if lo_v is None or hi_v is None:
            continue
        if rows[i + 120]['sym'] != rows[i]['sym']:
            continue
        band = hi_v * 0.0003
        ns = 1 if lo_v > hi_v + band else -1 if lo_v < hi_v - band else 0
        if ns != 0 and state != 0 and ns != state:
            st = ls.state_at(row_ms[i])
            gate = st is not None and ((st == 1) == (ns == 1))
            c0 = rows[i]['c']
            events.append((rows[i]['date'], ns, gate,
                           ns * (rows[i + 120]['c'] - c0)))
        if ns != 0:
            state = ns
    print(f'--- {lo_k.upper()} x {hi_k.upper()} ({len(events)} crossings) ---')
    for elab, sel in ERAS:
        evs = [e for e in events if sel(e[0])]
        gated = [e[3] for e in evs if e[2]]
        allv = [e[3] for e in evs]
        f = lambda v: f'{statistics.mean(v):+.1f}({len(v)})' if len(v) >= 15 else f'--({len(v)})'
        print(f'  {elab}: LS-gated {f(gated)}  ungated {f(allv)}')

# ---------- PT3: squeeze ----------
print('\n########## PT3 |PH−PD| squeeze ##########')
samples = []
hist = []
j = -1
for i in range(0, N - 130, 5):
    while j + 1 < len(pt_ts) and pt_ts[j + 1] <= row_ms[i]:
        j += 1
    if j < 0:
        continue
    ph_, pd_ = pt['ph'][j], pt['pd'][j]
    if ph_ is None or pd_ is None or rows[i + 120]['sym'] != rows[i]['sym']:
        continue
    w = abs(ph_ - pd_) / rows[i]['c'] * 100
    pct = (sum(1 for x in hist[-10000:] if x <= w) / min(len(hist), 10000)
           if len(hist) >= 500 else None)
    hist.append(w)
    if pct is None:
        continue
    samples.append((rows[i]['date'], pct, abs(rows[i + 120]['c'] - rows[i]['c']),
                    (1 if rows[i]['c'] > pd_ else -1) * (rows[i + 120]['c'] - rows[i]['c'])))
for elab, sel in ERAS:
    evs = [s for s in samples if sel(s[0])]
    tight = [s[2] for s in evs if s[1] <= 0.25]
    wide = [s[2] for s in evs if s[1] >= 0.75]
    # squeeze-release direction: tight squeeze + price side of PD -> continuation
    rel = [s[3] for s in evs if s[1] <= 0.10]
    f = lambda v: f'{statistics.mean(v):.1f}({len(v)})' if len(v) >= 50 else f'--({len(v)})'
    g = lambda v: f'{statistics.mean(v):+.1f}({len(v)})' if len(v) >= 50 else f'--({len(v)})'
    print(f'  {elab}: |drift120| tight {f(tight)} vs wide {f(wide)}  |  squeeze<10pct side-of-PD continuation {g(rel)}')
