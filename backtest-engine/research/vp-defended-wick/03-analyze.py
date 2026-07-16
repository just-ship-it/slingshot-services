#!/usr/bin/env python3
"""VP-DEFENDED-WICK Phase 3 — event-study analysis.

Reads output/events.csv and prints:
  1. Arm x ltype base rates + point expectancy per T/S combo (house cost model)
  2. Absorption (abs10/abs30) quartile conditioning within arm
  3. Hour-of-day / direction / approach structure for the strongest cells
  4. Yearly stability + train(2021-23)/test(2024-26) split

Cost model per trade (limit entry at level L, resting-limit convention):
  win  -> +T                (target limit fill, no slip)
  loss -> -(S + 1.5)        (stop-market slips 1.5pt, house standard)
  t/o  -> drift1800 - 1.0   (market-out slips 1.0pt)
  all  -> -0.2pt commission (~$4/RT on NQ)
"""
import pandas as pd
import numpy as np

BASE = '/home/drew/projects/slingshot-services/backtest-engine/research/vp-defended-wick'
ev = pd.read_csv(f'{BASE}/output/events.csv')
ev['year'] = ev['date'].str[:4]

TGT = [6, 10, 15]
STP = [6, 9, 12]
COMBOS = [(t, s) for t in TGT for s in STP]

def expectancy(df, t, s):
    o = df[f'o_t{t}s{s}']
    win = (o == 1)
    loss = (o == -1)
    to = (o == 0)
    pnl = win * t - loss * (s + 1.5) + to * (df['drift1800'] - 1.0) - 0.2
    return pnl.mean(), win.mean(), loss.mean(), to.mean(), pnl

print(f'total events: {len(ev)}   dates {ev.date.min()} -> {ev.date.max()}')
print(f'\n=== 1. arm x ltype base table (all hours, all events) ===')
print(f'{"arm":5} {"ltype":6} {"n":>7}  ' + '  '.join(f'T{t}/S{s}' for t, s in COMBOS))
for (arm, lt), g in ev.groupby(['arm', 'ltype']):
    cells = []
    for t, s in COMBOS:
        e, w, l, x, _ = expectancy(g, t, s)
        cells.append(f'{e:+.2f}')
    print(f'{arm:5} {lt:6} {len(g):>7}  ' + '  '.join(f'{c:>7}' for c in cells))

print(f'\n=== 2. absorption conditioning (abs10 quartiles within arm), combo T10/S9 ===')
for arm, g in ev.groupby('arm'):
    qs = g['abs10'].quantile([0.25, 0.5, 0.75]).values
    labels = ['Q1', 'Q2', 'Q3', 'Q4']
    bins = [-np.inf, *qs, np.inf]
    g = g.copy()
    g['aq'] = pd.cut(g['abs10'], bins=bins, labels=labels)
    row = []
    for lab in labels:
        sub = g[g['aq'] == lab]
        e, w, l, x, _ = expectancy(sub, 10, 9)
        row.append(f'{lab}:{e:+.2f}(n={len(sub)},wr={w:.0%})')
    print(f'{arm:5} q-cuts={np.round(qs,0)}  ' + '  '.join(row))

print(f'\n=== 3. hour-of-day (ET), vp arm only, T10/S9 ===')
g = ev[ev.arm == 'vp']
for h, sub in g.groupby('hour_et'):
    if len(sub) < 30:
        continue
    e, w, l, x, _ = expectancy(sub, 10, 9)
    print(f'  h{h:02d}  n={len(sub):>5}  exp={e:+.2f}  wr={w:.0%}  to={x:.0%}')

print(f'\n=== 4. direction split (vp arm, T10/S9) ===')
for d, sub in g.groupby('dir'):
    e, w, l, x, _ = expectancy(sub, 10, 9)
    print(f'  dir={d:+d}  n={len(sub):>6}  exp={e:+.2f}  wr={w:.0%}')

print(f'\n=== 5. yearly stability, per arm, T10/S9 ===')
for arm, g in ev.groupby('arm'):
    row = []
    for y, sub in g.groupby('year'):
        e, w, l, x, _ = expectancy(sub, 10, 9)
        row.append(f'{y}:{e:+.2f}')
    print(f'{arm:5} ' + '  '.join(row))

print(f'\n=== 6. train(2021-23) / test(2024-26), arm x ltype, T10/S9 ===')
tr = ev[ev.year <= '2023']
te = ev[ev.year >= '2024']
for (arm, lt), g in ev.groupby(['arm', 'ltype']):
    a = g[g.year <= '2023']
    b = g[g.year >= '2024']
    if len(a) < 50 or len(b) < 50:
        continue
    ea, *_ = expectancy(a, 10, 9)
    eb, *_ = expectancy(b, 10, 9)
    print(f'{arm:5} {lt:6}  train {ea:+.2f} (n={len(a)})   test {eb:+.2f} (n={len(b)})')
