#!/usr/bin/env python3
"""PILOTFISH M8 — everything × GEX-level crossovers (Drew's request,
registered pre-outcome 2026-07-14).

Subjects: LT-15m median, LT-1h median, EMA300, EMA1200, VWAPsess, VWAPweek,
raw close. GEX lines (causal stats dir, knowable at snapshot ts): gamma_flip,
call_wall, put_wall, support[0], resistance[0]. Event: subject crosses line
(0.03% deadband, hysteresis). Payoff: continuation 60/120m in cross
direction. Control: GEX lines +37pt. Eras: 2023 / 2024 / 2025-26.
"""
import csv
import glob
import json
import statistics
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, TF_MS

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
ET = ZoneInfo('America/New_York')
rows = load_minutes()
N = len(rows)
row_ms = [int(datetime.fromisoformat(r['ts'] + ':00+00:00').timestamp() * 1000) for r in rows]
closes = [r['c'] for r in rows]

# ---------- subjects ----------
SUBJ = {'close': closes}
for span in (300, 1200):
    k = 2 / (span + 1)
    out = [closes[0]]
    for c in closes[1:]:
        out.append(out[-1] + k * (c - out[-1]))
    SUBJ[f'EMA{span}'] = out
for name, anchor in (('VWAPsess', 'day'), ('VWAPweek', 'week')):
    out = []
    pv = vv = 0.0
    cur = None
    for r in rows:
        et = datetime.fromisoformat(r['ts'] + ':00+00:00').astimezone(ET)
        sess = (et - timedelta(hours=18)).date()
        key = sess if anchor == 'day' else sess - timedelta(days=sess.weekday())
        if key != cur:
            cur = key
            pv = vv = 0.0
        px = (r['h'] + r['l'] + r['c']) / 3
        pv += px * r['v']
        vv += r['v']
        out.append(pv / vv if vv else px)
    SUBJ[name] = out


def lt_median_per_minute(tf):
    fn = (f'{BASE}/research/lt-extraction/output/nq_lt_15m_full_2021-2026.csv'
          if tf == '15m' else f'{BASE}/research/lt-extraction/output/nq_lt_{tf}_raw.csv')
    ts, med = [], []
    for r in csv.DictReader(open(fn)):
        try:
            lv = sorted(float(r[f'level_{i}']) for i in range(1, 6))
        except ValueError:
            continue
        if any(x != x for x in lv):
            continue
        ts.append(int(r['unix_ms']) + TF_MS[tf])
        med.append(lv[2])
    out = [None] * N
    j = -1
    for i in range(N):
        while j + 1 < len(ts) and ts[j + 1] <= row_ms[i]:
            j += 1
        out[i] = med[j] if j >= 0 else None
    return out


SUBJ['LT15med'] = lt_median_per_minute('15m')
SUBJ['LT1hmed'] = lt_median_per_minute('1h')

# ---------- GEX lines per minute ----------
snaps = []   # (knowable_ms, flip, cw, pw, s0, r0)
for fp in sorted(glob.glob(f'{BASE}/data/gex/nq/nq_gex_*.json')):
    d = json.load(open(fp))
    for s in d.get('data', []):
        try:
            ms = int(datetime.fromisoformat(s['timestamp']).timestamp() * 1000) + 60000
            snaps.append((ms, s.get('gamma_flip'), s.get('call_wall'),
                          s.get('put_wall'),
                          (s.get('support') or [None])[0],
                          (s.get('resistance') or [None])[0]))
        except (ValueError, TypeError, KeyError):
            continue
snaps.sort()
print(f'{len(snaps)} GEX snapshots loaded')

GEXLINE = {k: [None] * N for k in ('flip', 'callwall', 'putwall', 'sup0', 'res0')}
j = -1
for i in range(N):
    while j + 1 < len(snaps) and snaps[j + 1][0] <= row_ms[i]:
        j += 1
    if j >= 0 and row_ms[i] - snaps[j][0] < 26 * 3600000:   # stale >26h -> None
        _, f, cw, pw, s0, r0 = snaps[j]
        GEXLINE['flip'][i] = f
        GEXLINE['callwall'][i] = cw
        GEXLINE['putwall'][i] = pw
        GEXLINE['sup0'][i] = s0
        GEXLINE['res0'][i] = r0

# ---------- sweep ----------
def sweep(shift):
    pairs = [(sn, gn) for sn in SUBJ for gn in GEXLINE]
    state = {p: 0 for p in pairs}
    events = {p: [] for p in pairs}
    for i in range(1, N - 130):
        if rows[i + 120]['sym'] != rows[i]['sym']:
            continue
        d120 = rows[i + 120]['c']
        d60 = rows[i + 60]['c']
        c0 = closes[i]
        date = rows[i]['date']
        for sn, subj in SUBJ.items():
            v = subj[i]
            if v is None:
                continue
            for gn, gl in GEXLINE.items():
                g = gl[i]
                if g is None:
                    continue
                g = g + shift
                band = g * 0.0003
                diff = v - g
                ns = 1 if diff > band else -1 if diff < -band else 0
                p = (sn, gn)
                if ns != 0:
                    if state[p] != 0 and ns != state[p]:
                        events[p].append((date, ns * (d60 - c0), ns * (d120 - c0)))
                    state[p] = ns
    return events


ERAS = (('2023', lambda x: x < '2024-01-01'),
        ('2024', lambda x: '2024-01-01' <= x < '2025-01-01'),
        ('25-26', lambda x: x >= '2025-01-01'))

for label, shift in (('REAL', 0.0), ('shift37 CONTROL', 37.0)):
    ev = sweep(shift)
    print(f'\n########## {label} — continuation 120m ##########')
    for (sn, gn), evs in sorted(ev.items()):
        cells = []
        for el, sel in ERAS:
            e = [x for x in evs if sel(x[0])]
            if len(e) < 15:
                cells.append(f'{el}: n={len(e)} --')
                continue
            a = statistics.mean(x[2] for x in e)
            wr = 100 * sum(1 for x in e if x[2] > 0) / len(e)
            cells.append(f'{el}: n={len(e)} {a:+.1f}pt {wr:.0f}%')
        print(f'  {sn:9s} x {gn:8s} | ' + ' | '.join(cells))
