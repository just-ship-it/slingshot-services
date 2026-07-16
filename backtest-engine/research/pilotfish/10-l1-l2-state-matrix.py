#!/usr/bin/env python3
"""PILOTFISH L1+L2 — LS multi-timeframe state matrix and flip cascade.

L1: 1m x 3m x 15m LS state combos -> forward 15/30/60m drift (minute closes).
    Pre-registered: alignment (111/000) trends; 1m-vs-15m conflict reverts.
L2: at each 15m flip, lead time since same-direction 1m/3m flips; forward
    drift by cascade completeness. Pre-registered: confirmed flips outperform.
Window: 2025-01 -> 2026-05-07 (shortest file, LT 3m not needed here ->
2026-05-18 LS-3m limit). Discovery 2025-01->09 / holdout 2025-10->2026-05.
"""
import bisect
import csv
import statistics
import sys
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, stat_line

LSDIR = '/home/drew/projects/slingshot-services/backtest-engine/research/lt-extraction/output'


def load_flips(path):
    ts, st = [], []
    with open(path) as f:
        for r in csv.DictReader(f):
            ts.append(int(r['unix_ms']))
            st.append(int(r['state']))
    return ts, st


ls = {tf: load_flips(f'{LSDIR}/nq_ls_{tf}_raw.csv') for tf in ('1m', '3m', '15m')}
END = min(t[-1] for t, _ in ls.values())


def state_at(tf, ms):
    ts, st = ls[tf]
    i = bisect.bisect_right(ts, ms) - 1
    return st[i] if i >= 0 else None


def last_flip_before(tf, ms, direction):
    """most recent flip TO `direction` at/before ms; returns ts or None."""
    ts, st = ls[tf]
    i = bisect.bisect_right(ts, ms) - 1
    while i > 0:
        if st[i] == direction and st[i - 1] != direction:
            return ts[i]
        i -= 1
    return None


rows = load_minutes()
from datetime import datetime, timezone
ms_of = lambda r: int(datetime.fromisoformat(r['ts'] + ':00+00:00').timestamp() * 1000)

# --- L1: state matrix ---
samples = []   # (date, s1, s3, s15, fwd15, fwd30, fwd60)
for i in range(0, len(rows) - 70, 5):   # every 5 minutes to reduce overlap
    r = rows[i]
    if r['date'] < '2025-01-05':
        continue
    ms = ms_of(r)
    if ms > END:
        break
    if rows[i + 60]['sym'] != r['sym']:
        continue
    s1, s3, s15 = state_at('1m', ms), state_at('3m', ms), state_at('15m', ms)
    if None in (s1, s3, s15):
        continue
    samples.append((r['date'], s1, s3, s15,
                    rows[i + 15]['c'] - r['c'],
                    rows[i + 30]['c'] - r['c'],
                    rows[i + 60]['c'] - r['c']))

print(f'L1: {len(samples)} samples (5-min grid)\n')
for label in ('DISCOVERY 2025-01..09', 'HOLDOUT 2025-10..2026-05'):
    evs = [s for s in samples if (s[0] < '2025-10-01') == label.startswith('DISC')]
    print(f'========== {label} ({len(evs)}) ==========')
    print('combo (1m,3m,15m) | n | fwd30 avg pt (LONG-signed) | fwd60')
    for s15 in (1, 0):
        for s3 in (1, 0):
            for s1 in (1, 0):
                sub = [s for s in evs if (s[1], s[2], s[3]) == (s1, s3, s15)]
                if len(sub) < 30:
                    continue
                f30 = statistics.mean(s[5] for s in sub)
                f60 = statistics.mean(s[6] for s in sub)
                print(f'  {s1}{s3}{s15}  n={len(sub):6d}  f30={f30:+7.2f}  f60={f60:+7.2f}')
    # pre-registered cells, cost-adjusted trade framing (long 111, short 000)
    stat_line('  PRE-REG aligned 111 -> LONG 60m',
              [s[6] for s in evs if (s[1], s[2], s[3]) == (1, 1, 1)])
    stat_line('  PRE-REG aligned 000 -> SHORT 60m',
              [-s[6] for s in evs if (s[1], s[2], s[3]) == (0, 0, 0)])
    stat_line('  PRE-REG conflict (1m!=15m) -> fade 1m, 30m',
              [(-s[5] if s[1] else s[5]) for s in evs if s[1] != s[3]])
    print()

# --- L2: 15m flip cascade ---
ts15, st15 = ls['15m']
events = []   # (date, direction, lead1, lead3, fwd30, fwd60, fwd120)
row_ms = [ms_of(r) for r in rows]
for k in range(1, len(ts15)):
    if st15[k] == st15[k - 1]:
        continue
    ms = ts15[k]
    if ms > END:
        break
    d = st15[k]
    i = bisect.bisect_left(row_ms, ms)
    if i + 120 >= len(rows) or abs(row_ms[i] - ms) > 5 * 60000:
        continue
    if rows[i + 120]['sym'] != rows[i]['sym']:
        continue
    f1 = last_flip_before('1m', ms, d)
    f3 = last_flip_before('3m', ms, d)
    lead1 = (ms - f1) / 60000 if f1 else None
    lead3 = (ms - f3) / 60000 if f3 else None
    sgn = 1 if d == 1 else -1
    c0 = rows[i]['c']
    events.append((rows[i]['date'], d, lead1, lead3,
                   sgn * (rows[i + 30]['c'] - c0),
                   sgn * (rows[i + 60]['c'] - c0),
                   sgn * (rows[i + 120]['c'] - c0)))

print(f'\nL2: {len(events)} 15m flips\n')
for label in ('DISCOVERY 2025-01..09', 'HOLDOUT 2025-10..2026-05'):
    evs = [e for e in events if (e[0] < '2025-10-01') == label.startswith('DISC')]
    print(f'========== {label} ({len(evs)} flips) ==========')
    conf = [e for e in evs if e[2] is not None and e[3] is not None
            and e[2] <= 30 and e[3] <= 30]
    unconf = [e for e in evs if e not in conf]
    stat_line('  PRE-REG confirmed (1m&3m flipped <=30m ago), 60m',
              [e[5] for e in conf])
    stat_line('  unconfirmed 15m flips, 60m', [e[5] for e in unconf])
    stat_line('  all 15m flips, trade flip dir 60m', [e[5] for e in evs])
    stat_line('  all 15m flips, 120m', [e[6] for e in evs])
    print()
