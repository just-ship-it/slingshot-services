#!/usr/bin/env python3
"""
$2000 starting balance, 1 MNQ contract per trade, 4-strategy FCFS, full 16mo.
Stop if balance < $100 (MNQ day-trade margin minimum) at any point.

MNQ = 1/10th NQ → divide trade NQ PnL by 10.
Also tracks INTRA-TRADE MAE: if a single trade's drawdown (in MNQ $) would
push the balance below $100 mid-trade, we model a margin call at the MAE
moment (broker auto-liquidates). MAE in NQ pts × $2/pt = MAE in MNQ $.
"""

import csv
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent

START_BALANCE = 2000.0
MIN_MARGIN    = 100.0   # MNQ day-trade margin floor per Tradovate (memory)
MNQ_SCALE     = 0.1     # NQ → MNQ pnl conversion
MNQ_PT_VALUE  = 2.0     # $/pt on MNQ (NQ is $20)

# ── Load gold-standard trades with MAE per strategy ───────────────────────
# We need MAE which isn't in the 4strategy-portfolio CSV. Use the gold JSONs
# directly and replay through FCFS exactly like 4strategy-portfolio does.
import json

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
        # Defensive: lstb sometimes has exit <= entry (timestamp clamp issue);
        # push exit forward 1ms for FCFS ordering (matches 4strategy-portfolio).
        et, xt = t['entryTime'], t['exitTime']
        if xt <= et: xt = et + 1
        all_trades.append({
            'strategy': key,
            'entry_ts': et,
            'exit_ts': xt,
            'side': t['side'],
            'pnl_nq': t['netPnL'],        # NQ-sized
            'mae_pts': t.get('maePoints', 0) or 0,
            'mfe_pts': t.get('mfePoints', 0) or 0,
            'exit_reason': t.get('exitReason', ''),
        })

# Sort chronologically by entry, then by exit for tie-breaking
all_trades.sort(key=lambda x: (x['entry_ts'], x['exit_ts']))
print(f'Loaded {len(all_trades)} trades across 4 strategies')

# ── FCFS replay with single shared slot ───────────────────────────────────
# Mimic 4strategy-portfolio's first-in-wins rule: take first signal when flat,
# reject all signals while in position.
balance = START_BALANCE
peak = START_BALANCE
max_dd = 0.0
slot_busy_until = 0  # exit_ts of current held trade
trades_taken = 0
trades_rejected = 0
margin_call = None
equity_curve = [(0, START_BALANCE, 'start')]
worst_intraday_low = START_BALANCE  # lowest mid-trade balance ever
worst_trade_loss = 0.0              # biggest single-trade realized loss in MNQ
biggest_winner = 0.0                # biggest single-trade winner in MNQ

def fmt_money(n):
    return f'${n:,.2f}' if n >= 0 else f'-${abs(n):,.2f}'

def fmt_dt(ms):
    return datetime.utcfromtimestamp(ms / 1000).strftime('%Y-%m-%d %H:%M:%S')

for t in all_trades:
    if margin_call: break

    # FCFS slot check
    if t['entry_ts'] < slot_busy_until:
        trades_rejected += 1
        continue

    # Intra-trade margin call check using MAE.
    # MAE in pts × $2 = MAE in MNQ $. If balance - MAE_$ < $100, we get
    # liquidated at the MAE moment (worst point of the trade).
    mae_mnq = t['mae_pts'] * MNQ_PT_VALUE
    intra_low = balance - mae_mnq
    if intra_low < worst_intraday_low:
        worst_intraday_low = intra_low

    if intra_low < MIN_MARGIN:
        # Margin call: balance drops to whatever the broker liquidates at.
        # Approximation: balance lands at intra_low (no further loss after liquidation).
        balance = intra_low
        margin_call = {
            'when': t['entry_ts'],  # approximate — actual MAE moment is intra-trade
            'trade': t,
            'final_balance': balance,
            'cause': f'MAE {t["mae_pts"]}pt × ${MNQ_PT_VALUE} = -{fmt_money(mae_mnq)} would breach $100 floor',
        }
        break

    # Apply realized PnL
    pnl_mnq = t['pnl_nq'] * MNQ_SCALE
    if pnl_mnq < worst_trade_loss: worst_trade_loss = pnl_mnq
    if pnl_mnq > biggest_winner:  biggest_winner = pnl_mnq
    balance += pnl_mnq
    trades_taken += 1
    slot_busy_until = t['exit_ts']

    # Track equity curve + DD
    if balance > peak: peak = balance
    dd = peak - balance
    if dd > max_dd: max_dd = dd
    equity_curve.append((t['exit_ts'], balance, f'{t["strategy"]}/{t["exit_reason"]}'))

    if balance < MIN_MARGIN:
        margin_call = {
            'when': t['exit_ts'],
            'trade': t,
            'final_balance': balance,
            'cause': f'realized PnL {fmt_money(pnl_mnq)} pushed balance below $100 floor',
        }
        break

# ── Report ───────────────────────────────────────────────────────────────
print()
print('═' * 78)
print('  $2,000 ACCOUNT × 1 MNQ × FCFS × 4 STRATEGIES — 16-MONTH SIMULATION')
print('═' * 78)
print()
print(f'  Starting balance:  ${START_BALANCE:,.2f}')
print(f'  Min margin floor:  ${MIN_MARGIN:,.2f}')
print(f'  Trades taken:      {trades_taken}')
print(f'  Trades rejected:   {trades_rejected} (FCFS slot busy)')
print()

if margin_call:
    print(f'  ⛔ MARGIN CALL at {fmt_dt(margin_call["when"])}')
    print(f'  ⛔ Final balance:  {fmt_money(margin_call["final_balance"])}')
    print(f'  ⛔ Survived:       {(margin_call["when"] - all_trades[0]["entry_ts"]) / (1000 * 86400):.1f} days')
    print(f'  ⛔ Cause:          {margin_call["cause"]}')
    print(f'  ⛔ Trade detail:')
    t = margin_call['trade']
    print(f'     {t["strategy"]}  {t["side"]}  entry={fmt_dt(t["entry_ts"])}  MAE={t["mae_pts"]}pt  MFE={t["mfe_pts"]}pt  result_pnl={fmt_money(t["pnl_nq"] * 0.1)}MNQ ({t["exit_reason"]})')
else:
    print(f'  ✓ SURVIVED all 16 months')
    print(f'  Final balance:     ${balance:,.2f}')
    print(f'  Total return:      {((balance - START_BALANCE) / START_BALANCE * 100):.1f}%')
    print(f'  Peak balance:      ${peak:,.2f}')
    print(f'  Max DD ($):        ${max_dd:,.2f}  ({max_dd / peak * 100:.1f}% of peak)')
    print(f'  Lowest intra-trade balance: ${worst_intraday_low:,.2f}  (closest brush with the $100 floor)')
    print(f'  Biggest single-trade loss:  ${worst_trade_loss:,.2f}')
    print(f'  Biggest single-trade win:   ${biggest_winner:,.2f}')
print()

# Quick sanity: report what the first month of trading looked like
first_month_end = all_trades[0]['entry_ts'] + 30 * 86400 * 1000
print('FIRST 30 DAYS PROGRESSION:')
bal = START_BALANCE
peak30 = START_BALANCE
mdd30 = 0
n = 0
for t in all_trades:
    if t['entry_ts'] > first_month_end: break
    if margin_call and t['entry_ts'] > margin_call['when']: break
    n += 1
    mae_mnq = t['mae_pts'] * MNQ_PT_VALUE
    if bal - mae_mnq < MIN_MARGIN:
        print(f'  ⛔ Would have margin-called on trade {n} at {fmt_dt(t["entry_ts"])}')
        break
    bal += t['pnl_nq'] * MNQ_SCALE
    if bal > peak30: peak30 = bal
    dd = peak30 - bal
    if dd > mdd30: mdd30 = dd
print(f'  After ~30 days: {n} trades taken, balance ${bal:,.2f}, DD-from-peak ${mdd30:,.2f}')
