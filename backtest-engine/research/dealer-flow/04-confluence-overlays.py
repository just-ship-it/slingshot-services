#!/usr/bin/env python3
"""P1.2 — Confluence overlays on the qualifying episode subset
(dealer-LONG-gamma walls, below-approach = the placebo-beating class).

One condition family at a time (wide-net-then-filter discipline). For each
cut: n, rejection %, acceptance %, mean r30/r60 (log-ret % from zone entry —
for a fade-short at the wall, NEGATIVE r30/r60 is the money), split 2025 vs
2026-Jan where n allows.

Families: ET session, DoW, 0DTE share, LT confluence, nth visit, approach
velocity terciles, LS-15m state, dwell behavior (early signal).
"""
import bisect
import csv
import json
import statistics
from collections import defaultdict
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')

eps = json.load(open(HERE / 'episodes.json'))
Q = [e for e in eps if e.get('dg_sign') == 1 and e['side'] == 'below']
BASELINE = [e for e in eps if e['cls'].startswith('placebo') and e['side'] == 'below']
print(f'qualifying episodes: {len(Q)}; placebo-below baseline: {len(BASELINE)}')

# LS-15m state (point-in-time)
flips = []
with open(BASE / 'research/lt-extraction/output/nq_ls_15m_raw.csv') as f:
    for r in csv.DictReader(f):
        flips.append((int(r['unix_ms']), r['state']))
flips.sort()
fms = [x[0] for x in flips]


def ls15_at(e):
    # zone-entry timestamp is not stored; approximate via day + hour (entry
    # minute lost in v1 — use day 12:00 fallback only if needed). We stored
    # 'day' and 'hour_et'; reconstruct hour-precision UTC.
    from zoneinfo import ZoneInfo
    t = datetime.fromisoformat(f"{e['day']}T{e['hour_et']:02d}:30:00").replace(
        tzinfo=ZoneInfo('America/New_York'))
    ms = int(t.timestamp() * 1000)
    i = bisect.bisect_right(fms, ms) - 1
    return None if i < 0 else ('BULL' if flips[i][1] == '1' else 'BEAR')


def row(label, ev):
    if len(ev) < 40:
        return
    rej = 100 * sum(e['resolution'] == 'rejected' for e in ev) / len(ev)
    acc = 100 * sum(e['resolution'] == 'accepted' for e in ev) / len(ev)
    r30 = [e['r30'] for e in ev if 'r30' in e]
    r60 = [e['r60'] for e in ev if 'r60' in e]
    m30 = statistics.mean(r30) if r30 else float('nan')
    m60 = statistics.mean(r60) if r60 else float('nan')
    print(f'{label:40s} n={len(ev):5d} rej={rej:5.1f} acc={acc:5.1f} '
          f'r30={m30:+.4f} r60={m60:+.4f}')


def family(title, key_fn, rows=Q):
    agg = defaultdict(list)
    for e in rows:
        agg[key_fn(e)].append(e)
    print(f'\n--- {title} ---')
    for g in sorted(agg, key=str):
        row(str(g), agg[g])


row('ALL qualifying (dg=+1, below)', Q)
row('placebo-below baseline', BASELINE)

family('ET session', lambda e: ('overnight' if e['hour_et'] < 9 else
                                'rth_am' if e['hour_et'] < 12 else
                                'rth_pm' if e['hour_et'] < 16 else 'evening'))
family('day of week', lambda e: e['dow'])
family('0DTE share', lambda e: ('0dte<10%' if e.get('dte0_share', 0) < 0.10 else
                                '10-25%' if e.get('dte0_share', 0) < 0.25 else '>25%'))
family('LT confluence', lambda e: e['lt_confl'])
family('nth visit today', lambda e: min(e['nth'], 3))
family('approach 30m velocity', lambda e: ('fast>+0.3%' if e['approach_30m'] > 0.3 else
                                           'slow0-0.3%' if e['approach_30m'] > 0 else 'negative'))
family('LS-15m state', ls15_at)
family('dwell (first-15m proxy: dwell>=8)', lambda e: e['dwell'] >= 8)
family('year', lambda e: e['year'])
