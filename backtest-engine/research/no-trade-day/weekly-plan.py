#!/usr/bin/env python3
"""
6-month live deployment plan generator.

Replays the 4-strategy FCFS backtest with the scaling ladder and reports
WEEKLY checkpoints — expected end-of-week balance, trade count, WR, exit-
reason mix, contract size, and per-strategy contribution.

These checkpoints are the reference you compare live results against each
week. Substantial divergence = investigate before next week.
"""

import json
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parent.parent.parent

START_BALANCE = 2000.0
MIN_MARGIN    = 100.0
COMMISSION    = 5.0
MNQ_PT_VALUE  = 2.0
NQ_PT_VALUE   = 20.0
WEEKS_PLAN    = 26  # 6 months

LADDER = [
    (2000,   1,  0), (3500,  2, 0), (6000,  3, 0), (9000,  5, 0), (14000, 8, 0),
    (25000,  0,  1), (45000, 0, 2), (70000, 0, 3), (100000, 0, 4), (140000, 0, 5),
    (200000, 0,  7), (300000, 0, 10),
]
def contracts_for_balance(bal):
    for thresh, mnq, nq in reversed(LADDER):
        if bal >= thresh: return mnq, nq
    return 1, 0

STRATEGIES = [
    ('lstb',           'data/gold-standard/ls-flip-trigger-bar-v3.json'),
    ('gex-lt-3m',      'data/gold-standard/gex-lt-3m-crossover-v3.json'),
    ('gex-flip-ivpct', 'data/gold-standard/gex-flip-ivpct-v2.json'),
    ('gex-level-fade', 'data/gold-standard/gex-level-fade-v2.json'),
]

# Load trades
all_trades = []
for key, path in STRATEGIES:
    j = json.load(open(ROOT / path))
    for t in j['trades']:
        if t.get('status') != 'completed': continue
        if t.get('entryTime') is None or t.get('exitTime') is None: continue
        et, xt = t['entryTime'], t['exitTime']
        if xt <= et: xt = et + 1
        all_trades.append({
            'strategy': key, 'entry_ts': et, 'exit_ts': xt,
            'side': t['side'], 'pts': t.get('pointsPnL', 0) or 0,
            'mae_pts': t.get('maePoints', 0) or 0,
            'exit_reason': t.get('exitReason', ''),
        })
all_trades.sort(key=lambda x: (x['entry_ts'], x['exit_ts']))

# Replay FCFS with scaling, bucket trades by ISO week
balance = START_BALANCE
slot_busy_until = 0
weekly = {}  # week_key → { 'trades': [], 'mnq': N, 'nq': N, 'start_bal': X, 'end_bal': X }
prev_mnq, prev_nq = 1, 0

def week_key(ts):
    dt = datetime.utcfromtimestamp(ts / 1000)
    iso = dt.isocalendar()
    return f'{iso[0]}-W{iso[1]:02d}'

def week_start_str(ts):
    dt = datetime.utcfromtimestamp(ts / 1000)
    iso = dt.isocalendar()
    # Monday of that ISO week
    monday = datetime.fromisocalendar(iso[0], iso[1], 1)
    return monday.strftime('%Y-%m-%d')

for t in all_trades:
    if t['entry_ts'] < slot_busy_until: continue
    n_mnq, n_nq = contracts_for_balance(balance)
    mae_d = t['mae_pts'] * (MNQ_PT_VALUE * n_mnq + NQ_PT_VALUE * n_nq)
    if balance - mae_d < MIN_MARGIN: break  # margin call (didn't happen historically)
    gross = t['pts'] * (MNQ_PT_VALUE * n_mnq + NQ_PT_VALUE * n_nq)
    pnl = gross - COMMISSION * (n_mnq + n_nq)
    wk = week_key(t['exit_ts'])
    if wk not in weekly:
        weekly[wk] = {
            'start_bal': balance, 'trades': [], 'end_bal': balance,
            'monday': week_start_str(t['exit_ts']),
        }
    weekly[wk]['trades'].append({**t, 'pnl': pnl, 'n_mnq': n_mnq, 'n_nq': n_nq})
    balance += pnl
    weekly[wk]['end_bal'] = balance
    weekly[wk]['size'] = (n_mnq, n_nq)
    slot_busy_until = t['exit_ts']
    prev_mnq, prev_nq = n_mnq, n_nq

# Take first WEEKS_PLAN weeks
sorted_weeks = sorted(weekly.keys())[:WEEKS_PLAN]

# ── Print plan ────────────────────────────────────────────────────────────
print('═' * 100)
print('  6-MONTH LIVE DEPLOYMENT PLAN — Weekly Checkpoints')
print('═' * 100)
print()
print('Calibrated from the 16-month FCFS backtest with scaling ladder.')
print('Use each week\'s expected end-balance, trade count, WR, and exit-reason mix')
print('as your reference for "is live matching backtest?".')
print()
print(f'{"Wk":>3}  {"Mon":<10}  {"Size":<10}  {"Trades":>6}  {"WR":>5}  {"Wins":>5}  {"Losses":>6}  {"PnL":>9}  {"End balance":>11}  {"Top exit reasons (% of trades)"}')
print('-' * 100)

cum_balance = START_BALANCE
cum_pnl = 0
for i, wk in enumerate(sorted_weeks, 1):
    w = weekly[wk]
    n = len(w['trades'])
    wins = len([t for t in w['trades'] if t['pnl'] > 0])
    losses = n - wins
    wr = (wins / n * 100) if n else 0
    week_pnl = sum(t['pnl'] for t in w['trades'])
    cum_pnl += week_pnl
    n_mnq, n_nq = w['size']
    size_str = f'{n_mnq}×MNQ' if n_mnq else f'{n_nq}×NQ'
    if n_mnq and n_nq: size_str = f'{n_mnq}MNQ+{n_nq}NQ'
    # Exit reason mix
    reasons = defaultdict(int)
    for t in w['trades']: reasons[t['exit_reason']] += 1
    top_reasons = sorted(reasons.items(), key=lambda x: -x[1])[:3]
    reason_str = '  '.join(f'{r}:{c/n*100:.0f}%' for r, c in top_reasons)
    print(f'{i:>3}  {w["monday"]:<10}  {size_str:<10}  {n:>6}  {wr:>4.0f}%  {wins:>5}  {losses:>6}  ${week_pnl:>+8,.0f}  ${w["end_bal"]:>10,.0f}  {reason_str}')

print()
print('SCALING MILESTONES (when expected balance first reaches a tier):')
print('-' * 100)
seen_tiers = set()
for wk in sorted_weeks:
    w = weekly[wk]
    if w['size'] not in seen_tiers:
        seen_tiers.add(w['size'])
        n_mnq, n_nq = w['size']
        size_str = f'{n_mnq}×MNQ' if n_mnq else f'{n_nq}×NQ'
        print(f'  Week of {w["monday"]}  →  ${w["end_bal"]:>10,.0f}  →  scale to {size_str}')
print()

# Per-strategy contribution table
print('PER-STRATEGY EXPECTED CONTRIBUTION (cumulative over 26 weeks):')
print('-' * 100)
strat_totals = defaultdict(lambda: {'n': 0, 'pnl': 0, 'wins': 0})
for wk in sorted_weeks:
    for t in weekly[wk]['trades']:
        strat_totals[t['strategy']]['n'] += 1
        strat_totals[t['strategy']]['pnl'] += t['pnl']
        if t['pnl'] > 0: strat_totals[t['strategy']]['wins'] += 1
total_n = sum(s['n'] for s in strat_totals.values())
total_pnl = sum(s['pnl'] for s in strat_totals.values())
for k, s in sorted(strat_totals.items(), key=lambda x: -x[1]['pnl']):
    wr = s['wins'] / s['n'] * 100 if s['n'] else 0
    print(f'  {k:<22}  trades={s["n"]:>5}  ({s["n"]/total_n*100:>4.1f}% of all)  WR {wr:>4.0f}%  PnL ${s["pnl"]:>+10,.0f} ({s["pnl"]/total_pnl*100:>5.1f}% of total)')
print()
print(f'  Expected 26-week total PnL: ${total_pnl:,.0f}')
print(f'  Expected 26-week end balance: ${START_BALANCE + total_pnl:,.0f}')
print()
