#!/usr/bin/env python3
"""PILOTFISH D3 — overnight-gap × dealer-gamma open re-hedge (09:30-10:00 ET).

Pre-registered (PLAN.md): the overnight move lands on dealer books at the
open. Dealer net-gamma sign (Σ dealer_gamma across strikes, signed-flow
inventory as-of prior close) × gap direction → first-30-min drift:
  short-gamma book + gap  -> continuation (dealers chase the move)
  long-gamma book  + gap  -> fade / gap-fill (dealers sell strength, buy dips)

Universe: days with dealer-strikes inventory (2025-02 -> 2026-01).
gap = prior-day 16:00 ET close -> today 09:30 ET open (same contract only).
Outcome: 09:30 open -> 10:00 close, signed by the PREDICTED direction
(gap sign on short-gamma days, anti-gap on long-gamma days).
Costs: 2.0 pt total slip + $4 RT, $20/pt.
"""
import csv
import glob
import statistics
from collections import defaultdict

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
F = BASE + '/data/features/pilotfish_minute_features.csv'
PT, SLIP, COMM = 20.0, 2.0, 4.0

# --- dealer net gamma per day ---
book = {}
for fp in sorted(glob.glob(BASE + '/data/flow/qqq/dealer-strikes-*.csv')):
    d8 = fp.split('-')[-1].split('.')[0]
    day = f'{d8[:4]}-{d8[4:6]}-{d8[6:8]}'
    tot = 0.0
    for r in csv.DictReader(open(fp)):
        tot += float(r['dealer_gamma'])
    book[day] = tot

# --- minute rows ---
days = defaultdict(dict)
with open(F) as f:
    for row in csv.DictReader(f):
        hh = row['et_hhmm']
        if hh in ('09:30', '10:00', '16:00'):
            days[row['et_date']][hh] = (float(row['open']), float(row['close']),
                                        row['symbol'])

dates = sorted(days)
events = []
prev = None
for d in dates:
    m = days[d]
    if d in book and prev and '09:30' in m and '10:00' in m:
        o930, _, sym = m['09:30']
        _, pclose, psym = prev[1]
        if sym == psym:
            gap = 100 * (o930 - pclose) / pclose
            drift = m['10:00'][1] - o930
            events.append((d, gap, book[d], drift))
    if '16:00' in m:
        prev = (d, m['16:00'])

n_long = sum(1 for e in events if e[2] > 0)
print(f'{len(events)} day-events with inventory ({events[0][0]} -> {events[-1][0]}); '
      f'dealer-long days: {n_long}, dealer-short: {len(events)-n_long}\n')


def stat(label, picks):
    if len(picks) < 8:
        print(f'{label:56s} n={len(picks):3d}  (too few)')
        return
    gross = statistics.mean(picks)
    wr = 100 * sum(1 for p in picks if p > 0) / len(picks)
    net = gross * PT - SLIP * PT - COMM
    print(f'{label:56s} n={len(picks):3d} avg={gross:+6.2f}pt WR={wr:4.1f}% '
          f'net/tr=${net:+7.0f} total=${net*len(picks):+10,.0f}')


print('=== D3 pre-registered: predicted-direction drift by |gap| ===')
for th in (0.1, 0.3, 0.5, 1.0):
    for lab, gsel in (('SHORT-gamma (chase: trade gap dir)', -1),
                      ('LONG-gamma  (fade: trade anti-gap)', +1)):
        picks = []
        for d, gap, g, drift in events:
            if abs(gap) < th or (g > 0) != (gsel > 0):
                continue
            pred = (1 if gap > 0 else -1) * (1 if gsel < 0 else -1)
            picks.append(drift * pred)
        stat(f'|gap|>={th}%  {lab}', picks)
    print()

print('=== raw continuation (no book conditioning) — clock baseline ===')
for th in (0.1, 0.3, 0.5, 1.0):
    picks = [e[3] * (1 if e[1] > 0 else -1) for e in events if abs(e[1]) >= th]
    stat(f'|gap|>={th}%  continuation, all days', picks)
