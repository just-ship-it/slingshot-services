#!/usr/bin/env python3
"""E2 revision: original thresholds (abs>=5x AND vol>=2x) fired 11x/3.5yr —
self-contradictory design (directional moves have high travel => low
absorption). Protocol-honest fix: threshold grid on DISCOVERY 2023-24 ONLY;
best cell (net/tr, n>=100) gets ONE holdout shot. Logged in PLAN.md.
"""
import sys
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, causal_baseline, stat_line

rows = load_minutes()
vbase = causal_baseline(rows, 'v')
abase = causal_baseline(rows, 'absn')

samples = []   # (date, asurp, vsurp, movepct, rev15, rev30)
for i in range(15, len(rows) - 40):
    r = rows[i]
    if not ('09:30' <= r['hhmm'] <= '15:30'):
        continue
    p15 = rows[i - 15]
    if p15['sym'] != r['sym'] or rows[i + 30]['sym'] != r['sym']:
        continue
    move = r['c'] - p15['c']
    mp = abs(move) / r['c'] * 100
    if mp < 0.10 or r['v'] < 500 or r['travel'] < 1.0:
        continue
    vb = vbase.get((r['date'], r['hhmm']))
    ab = abase.get((r['date'], r['hhmm']))
    if not vb or not ab:
        continue
    ms = 1 if move > 0 else -1
    samples.append((r['date'], r['absn'] / ab, r['v'] / vb, mp,
                    -ms * (rows[i + 15]['c'] - r['c']),
                    -ms * (rows[i + 30]['c'] - r['c'])))

disc = [s for s in samples if s[0] < '2025-01-01']
hold = [s for s in samples if s[0] >= '2025-01-01']
print(f'{len(disc)} discovery / {len(hold)} holdout qualifying move-minutes\n')

print('=== DISCOVERY grid (reversal 30m payoff) ===')
best = None
for ath in (1.0, 1.5, 2.0, 3.0):
    for vth in (1.0, 1.5, 2.0):
        for mth in (0.10, 0.20):
            p = [s[5] for s in disc if s[1] >= ath and s[2] >= vth and s[3] >= mth]
            r = stat_line(f'abs>={ath}x vol>={vth}x move>={mth}%', p)
            if r and r[0] >= 100 and (best is None or r[3] > best[1][3]):
                best = ((ath, vth, mth), r)

if best:
    (ath, vth, mth), (n, g, wr, net) = best
    print(f'\nbest discovery cell: abs>={ath}x vol>={vth}x move>={mth}% '
          f'(n={n}, net/tr=${net:+.0f})')
    print('=== SINGLE HOLDOUT SHOT ===')
    p15 = [s[4] for s in hold if s[1] >= ath and s[2] >= vth and s[3] >= mth]
    p30 = [s[5] for s in hold if s[1] >= ath and s[2] >= vth and s[3] >= mth]
    stat_line('holdout reversal 15m', p15)
    stat_line('holdout reversal 30m', p30)
else:
    print('no discovery cell with n>=100 and positive net')
