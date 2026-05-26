#!/usr/bin/env python3
"""
Precompute the account-projection JSON consumed by the monitoring-service
account-tracker endpoint + dashboard panel.

Outputs:
  - per-week cumulative-balance percentile bands (p10/p25/p50/p75/p90)
    derived from 10k-iteration bootstrap of daily PnLs through the scaling
    ladder
  - per-strategy MAE distribution percentiles (p50/p90/p95/p99/max)
  - scaling ladder definition (mirrors account-sim-scaled.py)
  - per-strategy expected weekly trade count + WR (from the historical
    scaled-FCFS replay)

Writes to: monitoring-service/data/account-projection.json
Regenerate after any backtest-engine update that changes gold standards.
"""

import json
import random
from collections import defaultdict
from datetime import datetime
from pathlib import Path

random.seed(42)  # reproducible bootstrap

ROOT = Path(__file__).resolve().parent.parent.parent
# Lives in monitoring-service/projection/ (not data/, which is gitignored).
OUT_PATH = ROOT.parent / 'monitoring-service' / 'projection' / 'account-projection.json'

START_BALANCE = 2000.0
COMMISSION    = 5.0
MNQ_PT_VALUE  = 2.0
NQ_PT_VALUE   = 20.0
WEEKS         = 26
BOOTSTRAP_N   = 10000
DAYS_PER_WEEK = 5

LADDER = [
    (2000,   1, 0), (3500,  2, 0), (6000,  3, 0), (9000,  5, 0), (14000, 8, 0),
    (25000,  0, 1), (45000, 0, 2), (70000, 0, 3), (100000, 0, 4), (140000, 0, 5),
    (200000, 0, 7), (300000, 0, 10),
]

def contracts_for_balance(bal):
    for thresh, mnq, nq in reversed(LADDER):
        if bal >= thresh: return mnq, nq
    return 1, 0

STRATEGIES = [
    ('ls-flip-trigger-bar', 'data/gold-standard/ls-flip-trigger-bar-v3.json'),
    ('gex-lt-3m-crossover', 'data/gold-standard/gex-lt-3m-crossover-v3.json'),
    ('gex-flip-ivpct',      'data/gold-standard/gex-flip-ivpct-v2.json'),
    ('gex-level-fade',      'data/gold-standard/gex-level-fade-v2.json'),
]

# ── Load all trades + per-strategy MAE pools ──────────────────────────────
all_trades = []
mae_pool = {k: {'long': [], 'short': [], 'all': []} for k, _ in STRATEGIES}
strat_meta = {}

for key, path in STRATEGIES:
    j = json.load(open(ROOT / path))
    for t in j['trades']:
        if t.get('status') != 'completed': continue
        if t.get('entryTime') is None or t.get('exitTime') is None: continue
        et, xt = t['entryTime'], t['exitTime']
        if xt <= et: xt = et + 1
        mae = t.get('maePoints', 0) or 0
        side = str(t.get('side', '')).lower()
        side_norm = 'long' if side in ('long', 'buy') else 'short' if side in ('short', 'sell') else None
        all_trades.append({
            'strategy': key, 'entry_ts': et, 'exit_ts': xt,
            'side': side_norm, 'pts': t.get('pointsPnL', 0) or 0,
            'mae_pts': mae, 'mfe_pts': t.get('mfePoints', 0) or 0,
        })
        if side_norm:
            mae_pool[key][side_norm].append(mae)
        mae_pool[key]['all'].append(mae)

all_trades.sort(key=lambda x: (x['entry_ts'], x['exit_ts']))
print(f'Loaded {len(all_trades)} trades')

# ── Scaled FCFS replay — capture per-day kernel for bootstrap ─────────────
balance = START_BALANCE
slot_busy_until = 0
per_day = defaultdict(lambda: {'trades': [], 'gross_pts': 0.0, 'n_trades': 0, 'net_per_contract': 0.0})
strat_taken = defaultdict(lambda: {'n': 0, 'wins': 0, 'pnl_per_contract': 0.0})

for t in all_trades:
    if t['entry_ts'] < slot_busy_until: continue
    n_mnq, n_nq = contracts_for_balance(balance)
    # Use exit-day to bucket PnL (matches Sevalla daily aggregation)
    day = datetime.utcfromtimestamp(t['exit_ts'] / 1000).strftime('%Y-%m-%d')
    # Per-contract net for accumulation (we'll scale by contract count later)
    gross = t['pts'] * (MNQ_PT_VALUE * n_mnq + NQ_PT_VALUE * n_nq)
    pnl = gross - COMMISSION * (n_mnq + n_nq)
    balance += pnl
    slot_busy_until = t['exit_ts']

    per_day[day]['trades'].append(t)
    per_day[day]['gross_pts'] += t['pts']
    per_day[day]['n_trades'] += 1

    strat_taken[t['strategy']]['n'] += 1
    if pnl > 0: strat_taken[t['strategy']]['wins'] += 1
    strat_taken[t['strategy']]['pnl_per_contract'] += pnl / max(1, n_mnq + n_nq * 10)  # rough normalize

# Build bootstrap kernel: each day = {gross_pts, n_trades}
# Per-N-contract daily PnL = N_mnq*(gross_pts*$2 - $5*n_trades) for MNQ, or N_nq*(gross_pts*$20 - $5*n_trades) for NQ
kernel = []
for day, d in sorted(per_day.items()):
    kernel.append({'date': day, 'gross_pts': d['gross_pts'], 'n_trades': d['n_trades']})
print(f'Bootstrap kernel: {len(kernel)} trading days')

# Days per ISO week — used for the strategy weekly expectations
weeks_in_backtest = len({datetime.strptime(d['date'], '%Y-%m-%d').isocalendar()[:2] for d in kernel})
print(f'ISO weeks in backtest: {weeks_in_backtest}')

# ── Bootstrap projection ──────────────────────────────────────────────────
# For each of BOOTSTRAP_N simulations, draw 26*5=130 days with replacement,
# compound through the scaling ladder, record cumulative balance after each
# week. Then compute percentiles per-week across simulations.
def simulate_path():
    bal = START_BALANCE
    weekly_end_balances = []
    for w in range(WEEKS):
        for _ in range(DAYS_PER_WEEK):
            day_kernel = random.choice(kernel)
            n_mnq, n_nq = contracts_for_balance(bal)
            gross = day_kernel['gross_pts'] * (MNQ_PT_VALUE * n_mnq + NQ_PT_VALUE * n_nq)
            comm = COMMISSION * day_kernel['n_trades'] * (n_mnq + n_nq)
            bal += gross - comm
            if bal < 100: bal = 100  # margin floor (won't happen in practice)
        weekly_end_balances.append(bal)
    return weekly_end_balances

print(f'Running {BOOTSTRAP_N} bootstrap simulations...')
all_paths = [simulate_path() for _ in range(BOOTSTRAP_N)]
print('Done.')

def percentile(sorted_vals, p):
    if not sorted_vals: return 0
    k = (len(sorted_vals) - 1) * (p / 100)
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    if f == c: return sorted_vals[f]
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)

weekly_bands = []
for w in range(WEEKS):
    vals = sorted(p[w] for p in all_paths)
    weekly_bands.append({
        'week': w + 1,
        'p10': round(percentile(vals, 10), 2),
        'p25': round(percentile(vals, 25), 2),
        'p50': round(percentile(vals, 50), 2),
        'p75': round(percentile(vals, 75), 2),
        'p90': round(percentile(vals, 90), 2),
    })

# ── Per-strategy MAE distributions ────────────────────────────────────────
mae_dist = {}
for key, _ in STRATEGIES:
    pool = sorted(mae_pool[key]['all'])
    long_pool = sorted(mae_pool[key]['long'])
    short_pool = sorted(mae_pool[key]['short'])
    mae_dist[key] = {
        'n': len(pool),
        'all':   {'p50': round(percentile(pool, 50), 2), 'p90': round(percentile(pool, 90), 2),
                  'p95': round(percentile(pool, 95), 2), 'p99': round(percentile(pool, 99), 2),
                  'max': round(max(pool) if pool else 0, 2)},
        'long':  {'p50': round(percentile(long_pool, 50), 2),  'p95': round(percentile(long_pool, 95), 2),
                  'p99': round(percentile(long_pool, 99), 2), 'n': len(long_pool)},
        'short': {'p50': round(percentile(short_pool, 50), 2), 'p95': round(percentile(short_pool, 95), 2),
                  'p99': round(percentile(short_pool, 99), 2), 'n': len(short_pool)},
    }

# Per-strategy expected weekly trade count (from scaled-FCFS replay)
per_strat_weekly = {}
for key, s in strat_taken.items():
    per_strat_weekly[key] = {
        'trades_per_week': round(s['n'] / weeks_in_backtest, 1),
        'wr_pct': round(s['wins'] / s['n'] * 100, 1) if s['n'] else 0,
    }

# ── Write output ──────────────────────────────────────────────────────────
out = {
    'version':            datetime.utcnow().strftime('%Y-%m-%d'),
    'methodology':        'bootstrap of daily PnL kernel through scaling ladder',
    'bootstrap_n':        BOOTSTRAP_N,
    'weeks':              WEEKS,
    'start_balance':      START_BALANCE,
    'scaling_ladder':     [{'min_balance': t, 'n_mnq': m, 'n_nq': n} for t, m, n in LADDER],
    'weekly_bands':       weekly_bands,           # default $2k bands (precomputed)
    'mae_distribution':   mae_dist,
    'per_strategy_weekly': per_strat_weekly,
    'backtest_summary': {
        'total_trades': sum(strat_taken[k]['n'] for k in strat_taken),
        'total_days':   len(kernel),
        'total_weeks':  weeks_in_backtest,
    },
    # ── Kernel: raw per-day data used to recompute bands on the fly for ──
    # arbitrary startBalance values in the monitoring-service endpoint.
    # Each entry: gross signed-pts PnL for that day across all FCFS trades +
    # the number of trades that day (drives per-contract commission).
    'daily_pnl_kernel': [
        {'gross_pts': round(d['gross_pts'], 4), 'n_trades': d['n_trades']}
        for d in kernel
    ],
    'commission':         COMMISSION,
    'mnq_pt_value':       MNQ_PT_VALUE,
    'nq_pt_value':        NQ_PT_VALUE,
    'days_per_week':      DAYS_PER_WEEK,
}

OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
with open(OUT_PATH, 'w') as f:
    json.dump(out, f, indent=2)
print(f'Wrote {OUT_PATH}')
print()
print('Weekly bands preview:')
print(f'  {"Wk":>3}  {"p10":>10}  {"p25":>10}  {"p50":>10}  {"p75":>10}  {"p90":>10}')
for b in weekly_bands[:5] + weekly_bands[12::4]:
    print(f'  {b["week"]:>3}  ${b["p10"]:>9,.0f}  ${b["p25"]:>9,.0f}  ${b["p50"]:>9,.0f}  ${b["p75"]:>9,.0f}  ${b["p90"]:>9,.0f}')
print()
print('Per-strategy MAE p50/p95/p99/max:')
for k, m in mae_dist.items():
    print(f'  {k:<22}  n={m["n"]:>5}  p50={m["all"]["p50"]:>5}pt  p95={m["all"]["p95"]:>5}pt  p99={m["all"]["p99"]:>5}pt  max={m["all"]["max"]:>5}pt')
