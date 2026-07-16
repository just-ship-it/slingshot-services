#!/usr/bin/env python3
"""PILOTFISH Phase 4 step 2 — R2/R3 confirmation harness (registered).

Causal daily signals: R2 = trailing 20d efficiency ratio; R3 = trailing 60d
overnight->intraday beta. Signal value for day D uses days < D only; the
percentile RANK is trailing 252d (causal). Trend-permission = R2 rank >= .75
(and separately R3 rank <= .25).

Outcomes in NQ POINTS:
  A) same-day opening-drive follow-through (drive-signed, 09:45->15:30),
     |drive| >= 0.15% — per year 2023..2026.
  B) 4h LT-level crossover continuation 60m (M6 machinery) conditioned on
     the day's permission state.
"""
import bisect
import csv
import statistics
import sys
from datetime import datetime
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, TF_MS

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
rows = load_minutes()
row_ms = [int(datetime.fromisoformat(r['ts'] + ':00+00:00').timestamp() * 1000) for r in rows]

# ---------- daily table ----------
days = {}
for r in rows:
    d = days.setdefault(r['date'], {})
    hh = r['hhmm']
    if hh == '16:00':
        d['close'], d['csym'] = r['c'], r['sym']
    if hh == '09:30':
        d['o930'], d['osym'] = r['o'], r['sym']
    if hh == '09:45':
        d['c945'] = r['c']
    if hh == '15:30':
        d['c1530'] = r['c']
    if '09:30' <= hh <= '16:00':
        d['travel'] = d.get('travel', 0) + r['travel']

dates = sorted(dt for dt, d in days.items()
               if all(k in d for k in ('close', 'o930', 'c945', 'c1530', 'travel')))
tab = []
prev = None
for dt in dates:
    d = days[dt]
    if prev and days[prev].get('csym') == d.get('osym'):
        pclose = days[prev]['close']
        tab.append({'date': dt,
                    'on': (d['o930'] - pclose) / pclose * 100,
                    'intra': (d['close'] - d['o930']) / d['o930'] * 100,
                    'drivepct': (d['c945'] - d['o930']) / d['o930'] * 100,
                    'followpts': d['c1530'] - d['c945'],
                    'drivesign': 1 if d['c945'] > d['o930'] else -1,
                    'eff': abs(d['close'] - d['o930']) / d['travel'] if d['travel'] else 0})
    prev = dt

for i, row in enumerate(tab):
    t20 = tab[max(0, i - 20):i]
    t60 = tab[max(0, i - 60):i]
    if len(t20) >= 15:
        row['R2'] = statistics.mean(x['eff'] for x in t20)
    if len(t60) >= 40:
        ons = [x['on'] for x in t60]
        ints = [x['intra'] for x in t60]
        mo, mi = statistics.mean(ons), statistics.mean(ints)
        dn = sum((o - mo) ** 2 for o in ons)
        row['R3'] = (sum((ons[j] - mo) * (ints[j] - mi) for j in range(len(ons))) / dn) if dn else 0

# causal trailing 252d percentile ranks
for cand in ('R2', 'R3'):
    hist = []
    for row in tab:
        v = row.get(cand)
        if v is None:
            continue
        if len(hist) >= 60:
            row[cand + 'rank'] = sum(1 for h in hist[-252:] if h <= v) / min(len(hist), 252)
        hist.append(v)

perm = {}   # date -> dict(R2on, R3on, comborank)
for row in tab:
    if 'R2rank' in row and 'R3rank' in row:
        perm[row['date']] = {'R2on': row['R2rank'] >= 0.75,
                             'R2off': row['R2rank'] <= 0.25,
                             'R3on': row['R3rank'] <= 0.25,
                             'R3off': row['R3rank'] >= 0.75,
                             'combo': row['R2rank'] - row['R3rank']}

# ---------- A) drive follow-through in points, by year ----------
print('=== A) opening-drive follow-through (NQ points, drive-signed), |drive|>=0.15% ===')
print(f'{"year":6s} {"n":>4s} {"R2-ON":>8s} {"R2-OFF":>8s} {"R3-ON":>8s} {"R3-OFF":>8s} {"all":>8s}')
for yr in ('2023', '2024', '2025', '2026'):
    evs = [x for x in tab if x['date'].startswith(yr) and abs(x['drivepct']) >= 0.15
           and x['date'] in perm]
    if len(evs) < 30:
        print(f'{yr:6s} n={len(evs)} --')
        continue
    def m(sel):
        p = [x['followpts'] * x['drivesign'] for x in evs if sel(perm[x['date']])]
        return f'{statistics.mean(p):+7.1f}({len(p):3d})' if len(p) >= 12 else '     --'
    allv = statistics.mean(x['followpts'] * x['drivesign'] for x in evs)
    print(f'{yr:6s} {len(evs):4d} {m(lambda p: p["R2on"]):>8s} {m(lambda p: p["R2off"]):>8s} '
          f'{m(lambda p: p["R3on"]):>8s} {m(lambda p: p["R3off"]):>8s} {allv:+8.1f}')

# combo terciles
print('\n=== A2) combo score (R2rank − R3rank) terciles, points, by era ===')
for elab, sel in (('2023-24', lambda d: d < '2025-01-01'), ('2025-26', lambda d: d >= '2025-01-01')):
    evs = [x for x in tab if sel(x['date']) and abs(x['drivepct']) >= 0.15 and x['date'] in perm]
    if len(evs) < 60:
        continue
    scored = sorted(evs, key=lambda x: perm[x['date']]['combo'])
    n = len(scored) // 3
    lo = [x['followpts'] * x['drivesign'] for x in scored[:n]]
    hi = [x['followpts'] * x['drivesign'] for x in scored[-n:]]
    print(f'{elab}: n={len(evs)}  bottom-tercile={statistics.mean(lo):+.1f}pt  '
          f'top-tercile={statistics.mean(hi):+.1f}pt  spread={statistics.mean(hi)-statistics.mean(lo):+.1f}pt')

# ---------- B) 4h LT crossover continuation conditioned ----------
def load_lt(tf):
    ts, lvsets = [], []
    for r in csv.DictReader(open(f'{BASE}/research/lt-extraction/output/nq_lt_{tf}_raw.csv')):
        try:
            lv = [float(r[f'level_{i}']) for i in range(1, 6)]
        except ValueError:
            continue
        if any(x != x for x in lv):
            continue
        ts.append(int(r['unix_ms']) + TF_MS[tf])
        lvsets.append(lv)
    return ts, lvsets

lts, lsets = load_lt('4h')
events = []
cooldown = {}
li = 0
for i in range(1, len(rows) - 70):
    ms = row_ms[i]
    while li + 1 < len(lts) and lts[li + 1] <= ms:
        li += 1
    if lts[li] > ms:
        continue
    r = rows[i]
    prevc = rows[i - 1]['c']
    if rows[i - 1]['sym'] != r['sym'] or rows[i + 60]['sym'] != r['sym']:
        continue
    for L in lsets[li]:
        zone = L * 0.05 / 100
        key = round(L)
        if cooldown.get(key, -1) > i:
            continue
        up = prevc <= L - zone and r['c'] >= L + zone
        dn = prevc >= L + zone and r['c'] <= L - zone
        if not (up or dn):
            continue
        cooldown[key] = i + 30
        sgn = 1 if up else -1
        events.append((r['date'], sgn * (rows[i + 60]['c'] - r['c'])))

print('\n=== B) 4h LT crossover continuation 60m (points) by permission, by era ===')
for elab, sel in (('2023-24', lambda d: d < '2025-01-01'), ('2025-26', lambda d: d >= '2025-01-01')):
    evs = [(d, p) for d, p in events if sel(d) and d in perm]
    on = [p for d, p in evs if perm[d]['R2on'] or perm[d]['R3on']]
    off = [p for d, p in evs if not (perm[d]['R2on'] or perm[d]['R3on'])]
    fmt = lambda v: f'{statistics.mean(v):+.1f}pt(n={len(v)})' if len(v) >= 15 else f'--(n={len(v)})'
    print(f'{elab}: permission-ON {fmt(on)}   permission-OFF {fmt(off)}')
