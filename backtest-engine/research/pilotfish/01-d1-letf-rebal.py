#!/usr/bin/env python3
"""PILOTFISH D1 — LETF rebalance window (15:30-16:00 ET).

Pre-registered (PLAN.md): leveraged ETF daily rebalance flow ≈ (λ²−λ)·AUM·r
executes into the equity close, SAME sign as the day's return. Tests:

  T1 (clock prior): on days with |r through 15:30| >= threshold, the
     15:30→16:00 drift continues in the SAME direction, scaling with |r|.
     r = prior-day 16:00 ET close → today 15:30 ET close (NAV-return proxy).
  T2 (beat the clock): tape confirmation from 15:30-15:39 signed pressure
     (svol_co sum / volume sum, sign must match predicted flow) must make the
     REMAINING 15:40→16:00 drift better than unconfirmed same-threshold days.
     Confirm window strictly precedes the trade window — no lookahead.

Trade framings reported per threshold:
  CLOCK:   enter 15:30 close, exit 16:00 close, direction = sign(r).
  CONFIRM: enter 15:40 close only if tape aligned, exit 16:00 close.
Costs for $ lines: market in/out = 2.0 pts total slip + $4 RT, $20/pt.

Rollover guard: if the 15:30 symbol differs from the prior-close symbol the
day is skipped (contract jump would fake a huge r).
"""
import csv
import statistics
from collections import defaultdict

F = '/home/drew/projects/slingshot-services/backtest-engine/data/features/pilotfish_minute_features.csv'
PT, SLIP, COMM = 20.0, 2.0, 4.0

# minute rows we need, keyed by ET date
need = {'15:30', '15:40', '16:00'}
days = defaultdict(dict)          # et_date -> hhmm -> (close, symbol)
press = defaultdict(lambda: [0, 0])  # et_date -> [svol_sum, vol_sum] 15:30-15:39

with open(F) as f:
    r = csv.DictReader(f)
    for row in r:
        hh = row['et_hhmm']
        d = row['et_date']
        if hh in need:
            days[d][hh] = (float(row['close']), row['symbol'])
        if '15:30' <= hh <= '15:39':
            p = press[d]
            p[0] += int(row['svol_co'])
            p[1] += int(row['volume'])

dates = sorted(days)
events = []
prev_close = None  # (date, close, symbol)
for d in dates:
    m = days[d]
    if '16:00' in m:
        pc = (d, *m['16:00'])
    else:
        pc = None
    if '15:30' in m and '16:00' in m and '15:40' in m and prev_close:
        c1530, sym = m['15:30']
        _, pclose, psym = prev_close
        if sym == psym:
            rpct = 100 * (c1530 - pclose) / pclose
            drift_full = m['16:00'][0] - c1530                  # 15:30->16:00
            drift_late = m['16:00'][0] - m['15:40'][0]          # 15:40->16:00
            sv, vv = press[d]
            tape = sv / vv if vv else 0.0
            events.append((d, rpct, drift_full, drift_late, tape))
    if pc:
        prev_close = pc

print(f'{len(events)} day-events ({dates[0]} -> {dates[-1]})\n')


def stat(label, evs, use_late=False, need_align=None):
    """direction = sign(rpct); pnl in points, signed by direction."""
    picks = []
    for d, rpct, df, dl, tape in evs:
        if need_align is not None:
            aligned = (tape > 0) == (rpct > 0) and tape != 0
            if aligned != need_align:
                continue
        drift = dl if use_late else df
        picks.append(drift if rpct > 0 else -drift)
    if len(picks) < 8:
        print(f'{label:52s} n={len(picks):4d}  (too few)')
        return
    gross = statistics.mean(picks)
    wr = 100 * sum(1 for p in picks if p > 0) / len(picks)
    net = gross * PT - SLIP * PT - COMM
    tot = net * len(picks)
    print(f'{label:52s} n={len(picks):4d} avg={gross:+6.2f}pt WR={wr:4.1f}% '
          f'net/tr=${net:+7.0f} total=${tot:+10,.0f}')


print('=== T1 clock prior: same-sign continuation 15:30->16:00 by |r| ===')
for th in (0.0, 0.5, 1.0, 1.5, 2.0):
    stat(f'|r|>={th}%  CLOCK (enter 15:30)', [e for e in events if abs(e[1]) >= th])

print('\n=== scaling check: drift (signed by day direction) by |r| bucket ===')
buckets = [(0, 0.5), (0.5, 1.0), (1.0, 1.5), (1.5, 2.0), (2.0, 99)]
for lo, hi in buckets:
    stat(f'|r| in [{lo},{hi})', [e for e in events if lo <= abs(e[1]) < hi])

print('\n=== T2 beat-the-clock: 15:40->16:00 after tape confirm vs not ===')
for th in (0.5, 1.0, 1.5):
    sub = [e for e in events if abs(e[1]) >= th]
    stat(f'|r|>={th}%  clock-only late window (all)', sub, use_late=True)
    stat(f'|r|>={th}%  tape ALIGNED  (traded)', sub, use_late=True, need_align=True)
    stat(f'|r|>={th}%  tape OPPOSED  (stand down)', sub, use_late=True, need_align=False)
    print()

print('=== yearly stability, |r|>=1.0% clock ===')
for yr in ('2023', '2024', '2025', '2026'):
    stat(f'  {yr} |r|>=1.0% CLOCK', [e for e in events if e[0].startswith(yr) and abs(e[1]) >= 1.0])
