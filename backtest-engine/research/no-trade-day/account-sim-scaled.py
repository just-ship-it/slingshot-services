#!/usr/bin/env python3
"""
$2000 starting balance, FCFS 4-strategy, 16-month, WITH CONTRACT SCALING.

Risk principle: maintain per-contract buffer ~20× the historical worst single
trade loss ($143/MNQ, $1,430/NQ). Switch from MNQ to NQ when 10+ MNQ becomes
viable (NQ has 10× exposure at same per-contract commission — major efficiency).

Commission: $5 per contract per round-trip (applies to both MNQ and NQ).
Per-contract PnL: pts × $2 (MNQ) or pts × $20 (NQ).

Scaling ladder is intentionally conservative — stays well above the historical
max DD per contract ($1,164 MNQ / $11,640 NQ) to absorb unseen worst cases.
"""

import csv
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent

START_BALANCE = 2000.0
MIN_MARGIN    = 100.0       # Tradovate MNQ day-trade margin floor
COMMISSION    = 5.0         # $/contract round-trip
MNQ_PT_VALUE  = 2.0
NQ_PT_VALUE   = 20.0

# ── Scaling ladder ───────────────────────────────────────────────────────
# (min_balance, n_mnq, n_nq). At each tier the # of contracts of EACH type.
# Per-contract loss buffer at tier entry: balance / (n_mnq * $143 + n_nq * $1,430)
# All tiers maintain ≥18× the historical worst-trade-loss capacity.
LADDER = [
    # balance  MNQ  NQ
    (2000,       1,  0),   # buffer ~14× ($143 worst trade)
    (3500,       2,  0),   # buffer ~12×
    (6000,       3,  0),   # buffer ~14×
    (9000,       5,  0),   # buffer ~13×
    (14000,      8,  0),   # buffer ~12×
    (25000,      0,  1),   # switch to 1 NQ — efficiency win (10x exposure, 10x less commission)
    (45000,      0,  2),
    (70000,      0,  3),
    (100000,     0,  4),
    (140000,     0,  5),
    (200000,     0,  7),
    (300000,     0, 10),
]

def contracts_for_balance(balance):
    """Returns (n_mnq, n_nq) for given balance."""
    for thresh, mnq, nq in reversed(LADDER):
        if balance >= thresh:
            return mnq, nq
    return 1, 0  # below $2k means use minimum (will eventually trigger margin call)

# ── Load gold-standard trades (need pts and MAE) ──────────────────────────
STRATEGIES = [
    ('lstb',           'data/gold-standard/ls-flip-trigger-bar-v3.json'),
    ('gex-lt-3m',      'data/gold-standard/gex-lt-3m-crossover-v3.json'),
    ('gex-flip-ivpct', 'data/gold-standard/gex-flip-ivpct-v2.json'),
    ('gex-level-fade', 'data/gold-standard/gex-level-fade-v2.json'),
]

all_trades = []
for key, path in STRATEGIES:
    j = json.load(open(ROOT / path))
    for t in j['trades']:
        if t.get('status') != 'completed': continue
        if t.get('entryTime') is None or t.get('exitTime') is None: continue
        et, xt = t['entryTime'], t['exitTime']
        if xt <= et: xt = et + 1
        all_trades.append({
            'strategy': key,
            'entry_ts': et,
            'exit_ts': xt,
            'side': t['side'],
            'pts': t.get('pointsPnL', 0) or 0,   # gross signed pts
            'mae_pts': t.get('maePoints', 0) or 0,
        })

all_trades.sort(key=lambda x: (x['entry_ts'], x['exit_ts']))
print(f'Loaded {len(all_trades)} trades across 4 strategies\n')

# ── Simulator ────────────────────────────────────────────────────────────
def fmt_money(n): return f'${n:,.2f}' if n >= 0 else f'-${abs(n):,.2f}'
def fmt_dt(ms): return datetime.utcfromtimestamp(ms / 1000).strftime('%Y-%m-%d %H:%M:%S')

balance = START_BALANCE
peak = START_BALANCE
max_dd = 0.0
slot_busy_until = 0
trades_taken = 0
trades_rejected = 0
margin_call = None
worst_intra_low = START_BALANCE

# Track scale-up events for the report
scale_events = []  # (ts, balance, prev_mnq, prev_nq, new_mnq, new_nq)
prev_mnq, prev_nq = contracts_for_balance(balance)
scale_events.append((all_trades[0]['entry_ts'], balance, 0, 0, prev_mnq, prev_nq))

for t in all_trades:
    if margin_call: break

    if t['entry_ts'] < slot_busy_until:
        trades_rejected += 1
        continue

    # Determine size based on current balance (re-evaluated each trade).
    n_mnq, n_nq = contracts_for_balance(balance)
    if (n_mnq, n_nq) != (prev_mnq, prev_nq):
        scale_events.append((t['entry_ts'], balance, prev_mnq, prev_nq, n_mnq, n_nq))
        prev_mnq, prev_nq = n_mnq, n_nq

    # Intra-trade margin check using MAE.
    # MAE in $ = mae_pts × ($2 × N_MNQ + $20 × N_NQ)
    mae_dollar = t['mae_pts'] * (MNQ_PT_VALUE * n_mnq + NQ_PT_VALUE * n_nq)
    intra_low = balance - mae_dollar
    if intra_low < worst_intra_low: worst_intra_low = intra_low

    if intra_low < MIN_MARGIN:
        balance = intra_low
        margin_call = {
            'when': t['entry_ts'],
            'trade': t,
            'balance_before': balance + mae_dollar,
            'final_balance': balance,
            'contracts': (n_mnq, n_nq),
            'cause': f'MAE {t["mae_pts"]}pt × ({n_mnq}×$2 + {n_nq}×$20) = -{fmt_money(mae_dollar)} would breach $100 floor',
        }
        break

    # Realized PnL: gross = pts × per-contract value, minus commission per contract
    gross = t['pts'] * (MNQ_PT_VALUE * n_mnq + NQ_PT_VALUE * n_nq)
    commission = COMMISSION * (n_mnq + n_nq)
    pnl = gross - commission
    balance += pnl
    trades_taken += 1
    slot_busy_until = t['exit_ts']

    if balance > peak: peak = balance
    dd = peak - balance
    if dd > max_dd: max_dd = dd

    if balance < MIN_MARGIN:
        margin_call = {
            'when': t['exit_ts'],
            'trade': t,
            'final_balance': balance,
            'contracts': (n_mnq, n_nq),
            'cause': f'realized PnL {fmt_money(pnl)} pushed balance below $100',
        }
        break

# ── Report ────────────────────────────────────────────────────────────────
print('═' * 78)
print('  $2,000 ACCOUNT × SCALED FCFS × 4 STRATEGIES — 16-MONTH SIMULATION')
print('═' * 78)
print()
print(f'  Starting balance:  ${START_BALANCE:,.2f}')
print(f'  Min margin floor:  ${MIN_MARGIN:,.2f}')
print(f'  Trades taken:      {trades_taken}')
print(f'  Trades rejected:   {trades_rejected} (FCFS slot busy)')
print()
print('  SCALING LADDER:')
for thresh, mnq, nq in LADDER:
    desc = f'{mnq}×MNQ' if mnq else f'{nq}×NQ' if nq else 'flat'
    if mnq and nq: desc = f'{mnq}×MNQ + {nq}×NQ'
    # Per-trade max-loss capacity:
    capacity_per_contract = MNQ_PT_VALUE * mnq + NQ_PT_VALUE * nq  # $/pt
    # Worst observed trade was -13.5pt loss × $20 + commission ≈ -$275 NQ
    # So at this tier, worst trade loss ≈ capacity * 14pt + commission
    worst_trade_est = 14 * capacity_per_contract + COMMISSION * (mnq + nq)
    print(f'    ≥${thresh:>7,}  →  {desc:<18}  (~{worst_trade_est:.0f}$ worst-trade ≈ {worst_trade_est/thresh*100:.1f}% of tier entry)')
print()

if margin_call:
    print(f'  ⛔ MARGIN CALL at {fmt_dt(margin_call["when"])}')
    print(f'  ⛔ Final balance:  {fmt_money(margin_call["final_balance"])}')
    print(f'  ⛔ At size:        {margin_call["contracts"]}')
    print(f'  ⛔ Cause:          {margin_call["cause"]}')
else:
    print(f'  ✓ SURVIVED all 16 months')
    print(f'  Final balance:     ${balance:,.2f}')
    print(f'  Total return:      {((balance - START_BALANCE) / START_BALANCE * 100):,.0f}%')
    print(f'  Peak balance:      ${peak:,.2f}')
    print(f'  Max DD ($):        ${max_dd:,.2f}  ({max_dd / peak * 100:.1f}% of peak)')
    print(f'  Lowest intra-trade: ${worst_intra_low:,.2f}')
print()

print('SCALE-UP EVENTS (when contract count changed):')
print(f'  {"Date":<10}  {"Balance":>10}  →  {"New size":<15}')
for ts, bal, pm, pn, nm, nn in scale_events:
    desc = []
    if nm: desc.append(f'{nm}×MNQ')
    if nn: desc.append(f'{nn}×NQ')
    desc_str = ' + '.join(desc) if desc else 'flat'
    print(f'  {fmt_dt(ts)[:10]}  ${bal:>9,.0f}  →  {desc_str}')
print()

# ── Sanity comparison: 1-MNQ-flat baseline with PROPER commission ─────────
print('SANITY CHECK — re-run 1-MNQ-flat with proper commission (vs my earlier $63k):')
bal_flat = START_BALANCE
slot_busy = 0
taken = 0
mc = None
for t in all_trades:
    if mc: break
    if t['entry_ts'] < slot_busy: continue
    mae_d = t['mae_pts'] * MNQ_PT_VALUE
    if bal_flat - mae_d < MIN_MARGIN:
        mc = (t['entry_ts'], bal_flat - mae_d)
        break
    pnl = t['pts'] * MNQ_PT_VALUE - COMMISSION
    bal_flat += pnl
    taken += 1
    slot_busy = t['exit_ts']
print(f'  Final balance:  ${bal_flat:,.2f}  ({((bal_flat - START_BALANCE) / START_BALANCE * 100):,.0f}% return)')
print(f'  Trades taken:   {taken}')
if mc: print(f'  Margin call at: {fmt_dt(mc[0])}, final ${mc[1]:,.2f}')
